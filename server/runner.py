"""Write mode: start a new chat or send a message into one by spawning the local `claude` CLI headless.

Safety (see README, "Write mode"):
- argv list only (no shell); the prompt goes through stdin, so it is never parsed as a flag and never shows in `ps`;
- permission modes limited to default (sent as `manual`), acceptEdits and plan; bypass is refused here too;
- cwd must be an existing directory inside the user's home, outside ~/.claude and other dot-dirs, with symlinks resolved;
- a chat that changed in the last 2 min and is not being written by one of our runs is never resumed in place: only forked;
- one run per session, at most 3 runs at once;
- environment inherited minus MC_* and the variables that bind a process to a parent Claude Code session;
- only metadata is logged (run id, session id, cwd, mode, exit code), never prompts or output.
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time

import tracker_port as tp

HOME = os.path.realpath(os.path.expanduser("~"))
CLAUDE_BIN = os.environ.get("MC_CLAUDE_BIN") or shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
MODES = {"default": "manual", "acceptEdits": "acceptEdits", "plan": "plan"}   # UI name -> CLI value
FORBIDDEN_MODES = {"bypassPermissions", "dontAsk", "auto"}
MODELS = ["", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-5",
          "claude-fable-5-2", "claude-fable-5-1", "haiku", "sonnet", "opus", "fable"]
LIVE_SECS = 120
MAX_RUNS = 3
MAX_PROMPT = 100_000
# variables that tie a process to the Claude Code session that started this server (and its messaging secret)
STRIP_ENV = {"CLAUDECODE", "CLAUDE_PID", "CLAUDE_JOB_DIR", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
             "CLAUDE_CODE_AGENT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT",
             "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_HOST_SHORT_TEMP_DIRS"}
SID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")


class Refused(Exception):
    def __init__(self, code, msg, **extra):
        super().__init__(msg)
        self.code, self.msg, self.extra = code, msg, extra


def log(**kw):
    print("write:", " ".join(f"{k}={v}" for k, v in kw.items()), flush=True)


def check_cwd(path):
    """An existing directory inside home (or home itself), never ~/.claude or another top-level dot-dir."""
    if not isinstance(path, str) or not path.strip():
        raise Refused(400, "Pick a working directory.")
    path = os.path.expanduser(path.strip())
    if not os.path.isabs(path):
        raise Refused(400, "The working directory must be an absolute path.")
    if ".." in path.split(os.sep):
        raise Refused(400, "The working directory may not contain '..'.")
    real = os.path.realpath(path)
    if not (real == HOME or real.startswith(HOME + os.sep)):
        raise Refused(400, "The working directory must be inside your home folder.")
    rel = os.path.relpath(real, HOME)
    top = rel.split(os.sep)[0] if rel != "." else ""
    if top.startswith(".") or top in ("Library",):
        raise Refused(400, f"~/{top} is off limits for new chats.")
    if not os.path.isdir(real):
        raise Refused(400, "That directory does not exist.")
    return real


def check_mode(mode):
    mode = mode or "default"
    if mode in FORBIDDEN_MODES or "dangerously" in str(mode).lower() or mode not in MODES:
        raise Refused(400, f"Permission mode '{mode}' is not allowed. Use default, acceptEdits or plan.")
    return mode


def check_model(model):
    model = (model or "").strip()
    if model not in MODELS:
        raise Refused(400, f"Unknown model '{model}'.")
    return model


def clean_env():
    return {k: v for k, v in os.environ.items() if not k.startswith("MC_") and k not in STRIP_ENV}


class Run:
    def __init__(self, kind, cwd, model, mode, target=None, fork=False):
        self.id = secrets.token_hex(6)
        self.kind, self.cwd, self.model, self.mode, self.target, self.fork = kind, cwd, model, mode, target, fork
        self.session_id = target if (target and not fork) else None
        self.status, self.exit, self.error = "starting", None, ""
        self.started, self.ended = time.time(), None
        self.events, self.partial, self.cost, self.result = [], "", None, None
        self.proc, self.seq = None, 0
        self.lock = threading.Lock()

    def add(self, k, text, **kw):
        self.events.append({"n": len(self.events), "t": time.time(), "k": k, "text": tp.short(text, 600), **kw})
        if len(self.events) > 400:
            del self.events[:100]
        self.seq += 1

    def snap(self, since=0):
        with self.lock:
            return {"id": self.id, "kind": self.kind, "status": self.status, "session_id": self.session_id,
                    "target": self.target, "fork": self.fork, "cwd": self.cwd, "model": self.model, "mode": self.mode,
                    "started": self.started, "ended": self.ended, "exit": self.exit, "error": self.error,
                    "cost": self.cost, "result": self.result, "partial": self.partial, "seq": self.seq,
                    "events": [e for e in self.events if e["n"] >= since]}

    # ---- stream-json parsing (one line of the CLI's stdout) ----
    def feed(self, d):
        t = d.get("type")
        sub = " ↳ " if d.get("parent_tool_use_id") else ""
        with self.lock:
            if t == "system" and d.get("subtype") == "init":
                self.session_id = d.get("session_id") or self.session_id
                self.status = "running"
                self.add("status", f"session {self.session_id} · {d.get('model', '')} · {d.get('permissionMode', '')}")
            elif t == "stream_event":
                ev = d.get("event") or {}
                if ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta" and not sub:
                    self.partial = (self.partial + ev["delta"].get("text", ""))[-4000:]
                    self.seq += 1
                elif ev.get("type") == "message_stop":
                    self.partial = ""
            elif t == "assistant":
                self.partial = ""
                for b in (d.get("message") or {}).get("content") or []:
                    if b.get("type") == "text" and b.get("text", "").strip():
                        self.add("text", sub + b["text"])
                    elif b.get("type") == "tool_use":
                        inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                        self.add("tool", sub + tp.describe_tool(b.get("name"), inp), kind=tp.tool_kind(b.get("name")))
            elif t == "user":
                for b in (d.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                        c = b.get("content")
                        self.add("error", sub + "tool refused or failed: " + (c if isinstance(c, str) else json.dumps(c)[:300]))
            elif t == "result":
                self.cost = d.get("total_cost_usd")
                self.result = {"is_error": bool(d.get("is_error")), "turns": d.get("num_turns"),
                               "duration_ms": d.get("duration_ms"), "subtype": d.get("subtype"),
                               "denials": len(d.get("permission_denials") or [])}
                self.add("result", ("error: " if d.get("is_error") else "done") +
                         (f" · {self.result['turns']} turns" if self.result["turns"] else "") +
                         (f" · ${self.cost:.4f}" if isinstance(self.cost, (int, float)) else "") +
                         (f" · {self.result['denials']} permission denials" if self.result["denials"] else ""))


class Runner:
    def __init__(self, store, notify):
        self.store, self.notify = store, notify
        self.runs = {}
        self.lock = threading.Lock()
        self.last_end = {}   # session id -> when our last run on it ended

    def active(self):
        return [r for r in self.runs.values() if r.status in ("starting", "running")]

    def ours(self, sid):
        """Is this session being written (or was it just written) by one of our runs?"""
        if any(r.session_id == sid or r.target == sid and not r.fork for r in self.active()):
            return True
        return False

    def live_elsewhere(self, sess):
        if not sess:
            return False
        recent = time.time() - sess.mtime < LIVE_SECS
        ended = self.last_end.get(sess.id, 0)
        return recent and not self.ours(sess.id) and not (ended and sess.mtime <= ended + 5)

    def session_cwd(self, sess):
        import store as st
        i = sess.info
        for c in (i.first_cwd, i.cwd):
            if c and st.slugify(c) == sess.project:
                return c
        return i.first_cwd or i.cwd

    def options(self, sess=None):
        cwds, seen = [], set()
        with self.store.lock:
            projs = sorted(self.store.projects.items(), key=lambda kv: -max((s.mtime for s in kv[1].values()), default=0))
            for slug, sessions in projs:
                c = self.store.project_path(slug, sessions)
                if c in seen:
                    continue
                seen.add(c)
                try:
                    check_cwd(c)
                    cwds.append(c)
                except Refused:
                    pass
        out = {"models": MODELS, "modes": list(MODES), "cwds": cwds[:40], "home": HOME,
               "active": len(self.active()), "max": MAX_RUNS, "bin": os.path.exists(CLAUDE_BIN)}
        if sess:
            busy = any((r.session_id == sess.id or r.target == sess.id) and not r.fork for r in self.active())
            out["session"] = {"live_elsewhere": self.live_elsewhere(sess), "busy": busy,
                              "cwd": self.session_cwd(sess), "idle_secs": round(time.time() - sess.mtime)}
        return out

    def start(self, kind, prompt, cwd, model, mode, sess=None, fork=False):
        if not isinstance(prompt, str) or not prompt.strip():
            raise Refused(400, "Write a message first.")
        if len(prompt) > MAX_PROMPT:
            raise Refused(400, "That message is too long.")
        mode, model = check_mode(mode), check_model(model)
        if kind == "send":
            if not sess or not SID_RE.match(sess.id):
                raise Refused(404, "Unknown chat.")
            cwd = check_cwd(self.session_cwd(sess))
            if not fork and self.live_elsewhere(sess):
                raise Refused(409, "This chat is live elsewhere (its transcript changed in the last 2 minutes and "
                                   "Mission Control is not the one writing it). Fork it into a new chat instead.",
                              fork_offered=True)
        else:
            cwd = check_cwd(cwd)
        with self.lock:
            act = self.active()
            if len(act) >= MAX_RUNS:
                raise Refused(429, f"{MAX_RUNS} runs are already in progress. Wait for one to finish.")
            if kind == "send" and not fork and any((r.session_id == sess.id or r.target == sess.id) and not r.fork for r in act):
                raise Refused(409, "A message is already running in this chat. Wait for it, or stop it.", busy=True)
            run = Run(kind, cwd, model, mode, target=sess.id if sess else None, fork=fork)
            argv = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                    "--permission-mode", MODES[mode], "--permission-prompts", "none"]
            if model:
                argv += ["--model", model]
            if kind == "send":
                argv += ["--resume", sess.id] + (["--fork-session"] if fork else [])
            try:
                run.proc = subprocess.Popen(argv, cwd=cwd, env=clean_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, shell=False, start_new_session=True)
            except OSError as e:
                raise Refused(500, f"Could not start claude: {e.strerror}")
            self.runs[run.id] = run
        log(event="start", run=run.id, kind=kind, session=run.session_id or "new", fork=fork, cwd=cwd, mode=mode, model=model or "default")
        threading.Thread(target=self._pump, args=(run, prompt), daemon=True).start()
        self.notify()
        return run

    def _pump(self, run, prompt):
        p = run.proc
        try:
            p.stdin.write(prompt.encode())
            p.stdin.close()
        except OSError:
            pass
        err = bytearray()

        def drain():   # read stderr to EOF, keeping only the last 8 KB (a full pipe would block the child)
            for chunk in iter(lambda: p.stderr.read(4096), b""):
                err.extend(chunk)
                del err[:-8192]
        threading.Thread(target=drain, daemon=True).start()
        last = 0.0
        for raw in p.stdout:
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if isinstance(d, dict):
                run.feed(d)
            if time.time() - last > 0.3:
                last = time.time()
                self.notify()
        code = p.wait()
        with run.lock:
            run.exit, run.ended = code, time.time()
            if run.status != "stopped":
                run.status = "done" if code == 0 and not (run.result or {}).get("is_error") else "error"
            if code != 0 and err:
                run.error = bytes(err).decode(errors="replace")[-1500:]
            if run.session_id:
                self.last_end[run.session_id] = run.ended
        log(event="end", run=run.id, session=run.session_id, status=run.status, exit=code)
        self.notify()

    def stop(self, rid):
        run = self.runs.get(rid)
        if not run:
            raise Refused(404, "Unknown run.")
        if run.proc and run.proc.poll() is None:
            with run.lock:
                run.status = "stopped"
                run.add("status", "stopped by you")
            try:
                os.killpg(run.proc.pid, 15)
            except OSError:
                run.proc.terminate()
            log(event="stop", run=run.id, session=run.session_id)
        return run
