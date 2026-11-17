#!/usr/bin/env python3
"""Mission Control backend: a local-only (127.0.0.1) observer of ~/.claude/projects, read-only unless write mode is used.

  python3 -B server/server.py [--port 8765] [--static dist] [--interval 1.5]

Reads are GET/HEAD; writes are POST /api/write/* behind the per-launch token and an Origin check (write mode: send
messages through the claude CLI, and move a chat to the macOS Trash and back, see trash.py).
No CORS headers (same-origin only), and Host is checked against localhost to block DNS rebinding.
A poll thread stats the files every --interval seconds, parses only the appended lines, and pushes a
"change" Server-Sent Event naming the sessions that changed.
"""
import argparse
import hmac
import json
import mimetypes
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import store as st  # noqa: E402
import transcript as tr  # noqa: E402
import runner as rn  # noqa: E402
import diffs as df  # noqa: E402
import trash as tb  # noqa: E402

STORE = st.Store()
TRANSCRIPTS = tr.TranscriptCache()
HUB = {"cond": threading.Condition(), "v": 0, "changed": [], "at": time.time(), "runs_v": 0}
ARGS = None
TOKEN = secrets.token_urlsafe(32)   # per launch, memory only: injected into index.html, required on every write
MAX_BODY = 256 * 1024


def runs_changed():
    with HUB["cond"]:
        HUB["runs_v"] += 1
        HUB["cond"].notify_all()


RUNNER = rn.Runner(STORE, runs_changed)


def publish(changed):
    """Push a "change" SSE naming these (project, session) pairs (the watcher, and a move to or from the Trash)."""
    if changed:
        with HUB["cond"]:
            HUB["v"] += 1
            HUB["changed"] = [{"p": p, "s": s} for p, s in dict.fromkeys(changed)][:200]
            HUB["at"] = time.time()
            HUB["cond"].notify_all()


TRASH = tb.Trash(STORE, RUNNER, TRANSCRIPTS, publish)


def watch(interval):
    while True:
        try:
            changed = STORE.scan()
        except Exception as e:  # never let the watcher die
            print("scan error:", repr(e), flush=True)
            changed = []
        publish(changed)
        time.sleep(interval)


class Handler(BaseHTTPRequestHandler):
    server_version = "MissionControl/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        if ARGS and ARGS.verbose:
            super().log_message(fmt, *a)

    # ---------- guards ----------
    def host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def refuse(self, allow="GET, HEAD"):
        self.send_response(405)
        self.send_header("Allow", allow)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = refuse

    # ---------- write mode: POST only, own Origin + per-launch token ----------
    def allowed_origins(self):
        o = {f"http://127.0.0.1:{ARGS.port}", f"http://localhost:{ARGS.port}"}
        o.update(x.rstrip("/") for x in ARGS.dev_origin)
        return o

    def do_POST(self):
        u = urlparse(self.path)
        if not u.path.startswith("/api/write/"):
            return self.refuse()
        if not self.host_ok():
            return self.send_json({"error": "forbidden host"}, 403)
        if (self.headers.get("Origin") or "") not in self.allowed_origins():
            return self.send_json({"error": "forbidden origin"}, 403)
        if not hmac.compare_digest(self.headers.get("X-MC-Token") or "", TOKEN):
            return self.send_json({"error": "missing or wrong write token"}, 403)
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.send_json({"error": "JSON body required"}, 415)
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            return self.send_json({"error": "body too large"}, 413)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.send_json({"error": "bad JSON"}, 400)
        try:
            return self.write_api(u.path[len("/api/write/"):], body)
        except rn.Refused as e:
            return self.send_json({"error": e.msg, **e.extra}, e.code)
        except tb.Refused as e:
            return self.send_json({"error": e.msg, "why": e.why}, e.code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            print("write error:", u.path, type(e).__name__, flush=True)   # metadata only, never the body
            return self.send_json({"error": "internal error"}, 500)

    def write_api(self, op, b):
        def sess_of():
            with STORE.lock:
                return STORE.get(b.get("p"), b.get("s"))
        if op == "options":
            return self.send_json(RUNNER.options(sess_of() if b.get("s") else None))
        if op == "new":
            run = RUNNER.start("new", b.get("prompt"), b.get("cwd"), b.get("model"), b.get("mode"))
            return self.send_json(self.run_json(run.snap()))
        if op == "send":
            sess = sess_of()
            if not sess:
                raise rn.Refused(404, "Unknown chat.")
            run = RUNNER.start("send", b.get("prompt"), None, b.get("model"), b.get("mode"), sess=sess, fork=bool(b.get("fork")))
            return self.send_json(self.run_json(run.snap()))
        if op == "stop":
            return self.send_json(self.run_json(RUNNER.stop(str(b.get("run") or "")).snap()))
        if op == "trash-info":   # the confirm dialog's facts and dry run: never moves anything
            return self.send_json(TRASH.preview(b.get("p"), b.get("s")))
        if op == "trash":
            return self.send_json(TRASH.trash(b.get("p"), b.get("s")))
        if op == "restore":
            return self.send_json(TRASH.restore(b.get("p"), b.get("entry")))
        if op == "trashed":
            return self.send_json({"items": TRASH.listing()})
        if op == "runs":
            since = b.get("since") if isinstance(b.get("since"), dict) else {}
            now = time.time()
            out = [self.run_json(r.snap(int(since.get(r.id, 0) or 0))) for r in list(RUNNER.runs.values())
                   if r.status in ("starting", "running") or now - (r.ended or now) < 1800]
            return self.send_json({"runs": out, "active": len(RUNNER.active()), "max": rn.MAX_RUNS})
        raise rn.Refused(404, "Unknown write action.")

    def run_json(self, snap):
        sid = snap.get("session_id")
        proj = None
        if sid:
            with STORE.lock:
                proj = next((slug for slug, ss in STORE.projects.items() if sid in ss), None)
        snap["project"] = proj or st.slugify(snap.get("cwd") or "")
        snap["appeared"] = bool(proj)
        return snap

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.host_ok():
            return self.send_json({"error": "forbidden host"}, 403)
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/dev-token":
                return self.dev_token()
            if u.path == "/api/health":
                return self.send_json({"ok": True, "v": STORE.version})
            if u.path == "/api/index":
                return self.send_json(STORE.index())
            if u.path == "/api/events":
                return self.events()
            if u.path == "/api/agents":
                return self.send_json(self.agents_api(q))
            if u.path.startswith("/api/write/"):
                return self.refuse("POST")
            if u.path == "/api/trash-state":   # a tab still showing a chat that is gone: was it moved to the Trash?
                return self.send_json(TRASH.state(q.get("p"), q.get("s")))
            if u.path in ("/api/transcript", "/api/full", "/api/mc", "/api/diff", "/api/agent-resolve"):
                with STORE.lock:
                    sess = STORE.get(q.get("p"), q.get("s"))
                    if not sess:
                        return self.send_json({"error": "unknown session"}, 404)
                    agent = sess.agents.get(q["a"]) if q.get("a") else None
                    if q.get("a") and not agent:
                        return self.send_json({"error": "unknown agent"}, 404)
                if u.path == "/api/mc":
                    return self.mc(sess, q)
                if u.path == "/api/diff":
                    return self.diff(sess, q)
                if u.path == "/api/agent-resolve":
                    return self.agent_resolve(sess, q)
                return self.transcript(sess, agent, q, full=u.path == "/api/full")
            if u.path.startswith("/api/"):
                return self.send_json({"error": "not found"}, 404)
            return self.static(u.path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            print("request error:", self.path, repr(e), flush=True)
            try:
                self.send_json({"error": "internal error"}, 500)
            except Exception:
                pass

    def dev_token(self):
        """Dev mode only (--dev-origin): Vite's server-side plugin fetches the token to inject it into its index.html.
        Browsers always send Origin / Sec-Fetch-Site on fetch, so a web page can never take this path."""
        if not ARGS.dev_origin or self.headers.get("Origin") or self.headers.get("Sec-Fetch-Site") or self.headers.get("Referer"):
            return self.send_json({"error": "not found"}, 404)
        return self.send_json({"token": TOKEN})

    # ---------- API ----------
    def session_head(self, sess, agent):
        i = sess.info
        head = {"project": sess.project, "session": sess.id, "title": i.title(), "cwd": i.cwd, "branch": i.branch,
                "first_cwd": i.first_cwd, "path": STORE.project_path(sess.project, STORE.projects.get(sess.project, {}))}
        if agent:
            head["agent"] = {"id": agent.aid, "wf": agent.wf, "label": agent.meta.get("description") or agent.aid,
                             "type": agent.meta.get("agentType", ""), "phase": agent.meta.get("workflowPhase", ""),
                             "finished": bool(agent.meta.get("finished"))}
        # links from a transcript's Agent / Workflow tool calls to the agent and run they started
        with STORE.lock:
            head["links"] = sess.resolve(locate=STORE.locate)
            refs = set(sess.info.links.mentions) | {v["a"] for v in head["links"].values() if v.get("a")}
            head["elsewhere"] = {aid: loc for aid in refs if aid not in sess.agents for loc in [STORE.locate(aid)] if loc}
            head["agents"] = {a.aid: {"wf": a.wf, "label": a.meta.get("description") or a.aid}
                              for a in sess.agents.values()}
            head["workflows"] = sorted({a.wf for a in sess.agents.values() if a.wf})
        return head

    def transcript(self, sess, agent, q, full):
        path = agent.path if agent else sess.path
        t = TRANSCRIPTS.get(path)
        if full:
            try:
                seq = int(q.get("seq", "-1"))
            except ValueError:
                return self.send_json({"error": "bad seq"}, 400)
            e = t.full(seq)
            return self.send_json(e or {"error": "not found"}, 200 if e else 404)
        try:
            before = int(q["before"]) if q.get("before") else None
            after = int(q["after"]) if q.get("after") else None
            limit = int(q.get("limit") or 150)
        except ValueError:
            return self.send_json({"error": "bad paging"}, 400)
        page = t.page(before=before, after=after, limit=limit)
        page["head"] = self.session_head(sess, agent) if not after or q.get("head") else None
        with STORE.lock:   # agents of this chat still running (the working line's "Waiting for …")
            page["running"] = [{"id": r["id"], "label": r["label"], "first": r["first"]} for run in STORE.session_runs(sess)
                               for r in run["agents"] if r["status"] == "running" and (not agent or r["id"] != agent.aid)] if not agent else []
        return self.send_json(page)

    def mc(self, sess, q):
        with STORE.lock:
            runs = STORE.session_runs(sess)
        hist = [r["summary"] for r in runs]
        live = next((r["run"] for r in runs if r["summary"]["status"] == "running"), runs[0]["run"] if runs else None)
        want = q.get("run") or live
        data = next((r for r in runs if r["run"] == want), None)
        return self.send_json({"history": hist, "live": live, "data": data, "head": self.session_head(sess, None)})

    def agent_resolve(self, sess, q):
        """One agent's chat location, by tool call (tool=) or by agent id (agent=): the same resolver as the links."""
        with STORE.lock:
            if q.get("tool"):
                r = sess.resolve(locate=STORE.locate).get(q["tool"]) or {"missing": "This tool call didn't start an agent."}
            elif q.get("agent"):
                a = sess.agents.get(q["agent"])
                r = {"a": a.aid, "wf": a.wf, "label": a.meta.get("description") or a.aid} if a else (STORE.locate(q["agent"]) or
                    {"a": q["agent"], "missing": "No transcript for this agent (removed by Claude Code's cleanup, or never written)."})
            else:
                return self.send_json({"error": "tool or agent required"}, 400)
        return self.send_json({"project": sess.project, "session": sess.id, **r})

    def diff(self, sess, q):
        """Every change to one file in a run (run=<id>) or in the whole chat, as git-style diffs. Never reads the file."""
        path = q.get("path") or ""
        cwd = sess.info.first_cwd or sess.info.cwd
        if not path or len(path) > 4096:
            return self.send_json({"error": "path required"}, 400)
        target = os.path.abspath(os.path.join(cwd, path) if cwd and not os.path.isabs(path) else path)
        with STORE.lock:
            agents = list(sess.agents.values())
            if q.get("run"):
                run = next((r for r in STORE.session_runs(sess) if r["run"] == q["run"]), None)
                if not run:
                    return self.send_json({"error": "unknown run"}, 404)
                ids = {r["id"] for r in run["agents"]}
                files = [(a.path, a.aid, a.meta.get("description") or a.aid) for a in agents if a.aid in ids]
            else:
                files = [(sess.path, None, "main chat")] + [(a.path, a.aid, a.meta.get("description") or a.aid) for a in agents]
        changes = df.load(sess, target, files)
        root = (cwd or "").rstrip("/") + "/"
        rel = target[len(root):] if cwd and target.startswith(root) else target.lstrip("/")
        out = df.summary(changes, rel, target)
        if q.get("combined") == "1":
            out["diff"] = df.combined(changes, rel)
        elif q.get("change") not in (None, ""):
            try:
                i = int(q["change"])
                if not (0 <= i < len(changes)) or changes[i]["err"]:
                    raise ValueError
            except ValueError:
                return self.send_json({"error": "unknown change"}, 404)
            out["diff"] = df.one(changes, i, rel)
        return self.send_json(out)

    def agents_api(self, q):
        """Home page: every agent across all chats, running now or finished recently, from the cached runs."""
        state = q.get("state") or "running"
        try:
            limit = max(1, min(int(q.get("limit") or 24), 200))
            hours = max(1, min(float(q.get("hours") or 24), 24 * 30))
        except ValueError:
            limit, hours = 24, 24
        now = time.time()
        rows, feed = [], []
        with STORE.lock:
            for slug, sessions in STORE.projects.items():
                path = None
                for s in sessions.values():
                    if not s.agents:
                        continue
                    path = path or STORE.project_path(slug, sessions)
                    for run in STORE.session_runs(s):
                        for a in run["agents"]:
                            running = a["status"] == "running"
                            if (state == "running") != running:
                                continue
                            if not running:
                                last = st.tp.ts(a["last"] or "")
                                if not last or now - last.timestamp() > hours * 3600:
                                    continue
                            ctx = {"p": slug, "s": s.id, "chat": s.info.title(), "project": path, "run": run["run"],
                                   "wf": run["src"].get("wf"), "run_title": run["task"]}
                            rows.append({**a, "ctx": ctx})
                            if running:
                                feed += [{**e, "agent": a["label"], "id": a["id"], "ctx": ctx} for e in a["events"][-20:] if e["t"]]
        rows.sort(key=lambda r: r["last"] or "", reverse=True)
        feed.sort(key=lambda e: e["t"], reverse=True)
        return {"state": state, "total": len(rows), "agents": rows[:limit], "feed": feed[:120]}

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.close_connection = True
        cond = HUB["cond"]
        with cond:
            seen, seen_runs = HUB["v"], HUB["runs_v"]
        try:
            self.wfile.write(f"event: hello\ndata: {json.dumps({'v': seen})}\n\n".encode())
            self.wfile.flush()
            while True:
                with cond:
                    cond.wait_for(lambda: HUB["v"] != seen or HUB["runs_v"] != seen_runs, timeout=5)
                    v, changed, at, rv = HUB["v"], HUB["changed"], HUB["at"], HUB["runs_v"]
                sent = False
                if rv != seen_runs:   # a write-mode run changed: no content here, the UI polls it with its token
                    seen_runs, sent = rv, True
                    self.wfile.write(f"event: runs\ndata: {json.dumps({'rv': rv})}\n\n".encode())
                if v != seen:
                    seen, sent = v, True
                    self.wfile.write(f"event: change\ndata: {json.dumps({'v': v, 'changed': changed, 'at': at})}\n\n".encode())
                if not sent:
                    self.wfile.write(f"event: ping\ndata: {json.dumps({'v': v, 'at': at})}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    # ---------- static bundle ----------
    def static(self, path):
        root = ARGS.static and os.path.realpath(ARGS.static)
        if not root or not os.path.isdir(root):
            body = b"Mission Control API. Run `npm run dev` (Vite on :5173) or `npm start` to build and serve the UI."
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body) if self.command != "HEAD" else None
        rel = os.path.normpath(path.lstrip("/")) if path not in ("", "/") else "index.html"
        fp = os.path.realpath(os.path.join(root, rel))
        if not (fp.startswith(root + os.sep) and os.path.isfile(fp)):
            fp = os.path.join(root, "index.html")   # SPA fallback
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        with open(fp, "rb") as f:
            body = f.read()
        if fp.endswith("index.html"):
            body = body.replace(b"</head>", f'<meta name="mc-token" content="{TOKEN}"></head>'.encode(), 1)
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("javascript") else ""))
        self.send_header("Cache-Control", "no-store" if fp.endswith(".html") else "public, max-age=31536000, immutable")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--static", default="")
    ap.add_argument("--interval", type=float, default=1.5)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--dev-origin", action="append", default=[], help="extra Origin allowed to write (the Vite dev server)")
    ARGS = ap.parse_args()
    t0 = time.time()
    STORE.scan()
    n = sum(len(v) for v in STORE.projects.values())
    print(f"indexed {len(STORE.projects)} projects, {n} chats in {time.time() - t0:.1f}s from {st.ROOT}", flush=True)
    threading.Thread(target=watch, args=(ARGS.interval,), daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    srv.daemon_threads = True
    print(f"Mission Control on http://127.0.0.1:{ARGS.port}  (static: {ARGS.static or 'none'})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
