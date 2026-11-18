"""Read-only, incremental index of ~/.claude/projects.

Every file is tailed by byte offset: only complete new lines (up to the last "\\n") are parsed, so a growing
active chat costs only what it appended. A file that shrinks or changes inode is re-read from 0.
Nothing here ever writes, moves or deletes under ~/.claude.
"""
import datetime as dt
import json
import os
import re
import threading
import time

import tracker_port as tp
import status as stx

# MC_ROOT lets a test server read a scratch copy instead (never used to write anything)
ROOT = os.path.realpath(os.environ.get("MC_ROOT") or os.path.expanduser("~/.claude/projects"))
ACTIVE_SECS = 300          # a session is "active" when one of its files changed in the last 5 min
ID_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,200}$")
AID_RE = re.compile(r"^a[0-9a-f]{8,32}$")
SKIP_PREFIXES = (b'{"type":"api-request', b'{"type":"file-history')  # request payloads and backups: never shown


def parse_line(line):
    if not line.strip() or line.startswith(SKIP_PREFIXES):
        return None
    try:
        d = json.loads(line)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def inside_root(path):
    rp = os.path.realpath(path)
    return rp == ROOT or rp.startswith(ROOT + os.sep)


class Tail:
    """Byte-offset tail of one append-only JSONL file."""

    def __init__(self, path):
        self.path, self.off, self.ino, self.sig = path, 0, None, None

    def stat(self):
        try:
            return os.stat(self.path)
        except OSError:
            return None

    def changed(self, st):
        return st is not None and (st.st_ino, st.st_size, st.st_mtime_ns) != self.sig

    def read(self, st):
        """Return (reset, [(offset, raw_line)]) for the complete lines appended since the last read."""
        reset = self.ino is not None and (st.st_ino != self.ino or st.st_size < self.off)
        if reset:
            self.off = 0
        self.ino = st.st_ino
        out = []
        if st.st_size > self.off and inside_root(self.path):
            with open(self.path, "rb") as f:
                f.seek(self.off)
                data = f.read(st.st_size - self.off)
            end = data.rfind(b"\n")
            if end >= 0:
                pos = 0
                for raw in data[: end + 1].split(b"\n")[:-1]:
                    out.append((self.off + pos, raw))
                    pos += len(raw) + 1
                self.off += end + 1
        self.sig = (st.st_ino, st.st_size, st.st_mtime_ns)
        return reset, out


class LinkScan:
    """Agent links seen in one transcript: which tool call started (or messaged) which agent.
    Sources: toolUseResult.agentId on the call's result line, SendMessage's `to`; the call's time and error state."""

    def __init__(self):
        self.calls = {}     # tool_use_id -> {"t": ts, "kind": "Agent"|"SendMessage", "to": agent id or None}
        self.agent_of = {}  # tool_use_id -> agent id (from the result)
        self.errors = set()
        self.mentions = set()  # agent ids named by hand-back notes (<agent-message from="...">)
        self.killed = {}       # task id -> epoch of its <status>killed</status> notification

    def feed(self, d):
        t = d.get("type")
        for tid, stt, at in stx.notifications(d):
            if stt == "killed":
                self.killed[tid] = max(self.killed.get(tid) or 0, at or 0)
        msg = d.get("message") if isinstance(d.get("message"), dict) else {}
        if t == "assistant":
            for b in msg.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task", "SendMessage"):
                    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                    self.calls[b.get("id")] = {"t": d.get("timestamp"), "kind": "SendMessage" if b["name"] == "SendMessage" else "Agent",
                                               "to": inp.get("to") if b["name"] == "SendMessage" else None}
        if t == "user":
            c = msg.get("content")
            text = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
            if "<agent-message" in text:
                self.mentions.update(re.findall(r'<agent-message from="(a[0-9a-f]{8,32})"', text))
        if t == "user" and isinstance(msg.get("content"), list):
            tur = d.get("toolUseResult") if isinstance(d.get("toolUseResult"), dict) else {}
            for b in msg["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") in self.calls:
                    if b.get("is_error"):
                        self.errors.add(b["tool_use_id"])
                    if tur.get("agentId"):
                        self.agent_of[b["tool_use_id"]] = tur["agentId"]


def clean_prompt(s):
    s = re.sub(r"<system-reminder>[\s\S]*?</system-reminder>", "", s or "")
    s = re.sub(r"<[\w-]+>[\s\S]*?</[\w-]+>", "", s) if s.lstrip().startswith("<") else s
    return tp.short(s, 140)


class MainInfo:
    """Sidebar facts for one main chat file (cost/usage via tracker_port.AgentState, the tracker's read_agent rules)."""

    def __init__(self):
        self.agent = tp.AgentState()
        self.ai_title = self.summary = self.first_prompt = self.last_prompt = ""
        self.prompts = 0
        self.msg_ids = set()
        self.cwd = self.first_cwd = self.branch = ""
        self.first_ts = self.last_ts = None
        self.sidechain_assistant = 0
        self.links = LinkScan()
        self.turn = stx.TurnState()

    def feed(self, d):
        t = d.get("type")
        self.turn.feed(d)
        if t in ("assistant", "user", "queue-operation"):
            self.links.feed(d)
        if d.get("timestamp"):
            self.first_ts = self.first_ts or d["timestamp"]
            self.last_ts = d["timestamp"]
        if d.get("cwd"):
            self.first_cwd = self.first_cwd or d["cwd"]
            self.cwd = d["cwd"]
        if d.get("gitBranch"):
            self.branch = d["gitBranch"]
        if t == "ai-title" and d.get("aiTitle"):
            self.ai_title = d["aiTitle"]
        elif t == "summary" and d.get("summary"):
            self.summary = d["summary"]
        elif t == "last-prompt" and d.get("lastPrompt"):
            self.last_prompt = d["lastPrompt"]
        elif t == "user" and not d.get("isMeta") and not d.get("isCompactSummary"):
            c = (d.get("message") or {}).get("content")
            text = c if isinstance(c, str) else " ".join(
                b.get("text", "") for b in (c or []) if isinstance(b, dict) and b.get("type") == "text")
            is_result = isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
            if text.strip() and not is_result and not text.startswith("[Request interrupted"):
                if not text.lstrip().startswith(("<command-", "<local-command", "Another Claude session")):
                    self.prompts += 1
                    if not self.first_prompt:
                        self.first_prompt = clean_prompt(text)
        elif t == "assistant":
            if d.get("isSidechain"):
                self.sidechain_assistant += 1
            mid = (d.get("message") or {}).get("id")
            if mid:
                self.msg_ids.add(mid)
            self.agent.feed(d)

    def title(self):
        return tp.short(self.summary or self.ai_title or self.first_prompt or self.last_prompt or "(untitled chat)", 120)


class AgentFile:
    def __init__(self, aid, path, wf):
        self.aid, self.path, self.wf = aid, path, wf
        self.tail = Tail(path)
        self.state = tp.AgentState()
        self.links = LinkScan()
        self.turn = stx.TurnState()
        self.meta, self.meta_sig = {}, None
        self.mtime = 0.0

    def meta_path(self):
        return self.path[: -len(".jsonl")] + ".meta.json"

    def refresh(self):
        changed = False
        st = self.tail.stat()
        if self.tail.changed(st):
            reset, lines = self.tail.read(st)
            if reset:
                self.state, self.links, self.turn = tp.AgentState(), LinkScan(), stx.TurnState()
            for _off, raw in lines:
                d = parse_line(raw)
                if d:
                    self.state.feed(d)
                    self.turn.feed(d)
                    self.links.feed(d)
            self.mtime = st.st_mtime
            changed = True
        mp = self.meta_path()
        try:
            ms = os.stat(mp)
            sig = (ms.st_size, ms.st_mtime_ns)
            if sig != self.meta_sig and inside_root(mp):
                with open(mp) as f:
                    self.meta = json.load(f)
                self.meta_sig = sig
                self.mtime = max(self.mtime, ms.st_mtime)
                changed = True
        except (OSError, ValueError):
            pass
        return changed


class JournalFile:
    def __init__(self, path):
        self.path = path
        self.tail = Tail(path)
        self.state = tp.JournalState()
        self.mtime = 0.0

    def refresh(self):
        st = self.tail.stat()
        if not self.tail.changed(st):
            return False
        reset, lines = self.tail.read(st)
        if reset:
            self.state = tp.JournalState()
        for _off, raw in lines:
            try:
                d = json.loads(raw)
            except Exception:
                continue
            if isinstance(d, dict):
                self.state.feed(d)
        self.mtime = st.st_mtime
        return True


class Session:
    def __init__(self, project, sid, path):
        self.project, self.id, self.path = project, sid, path
        self.dir = path[: -len(".jsonl")]
        self.tail = Tail(path)
        self.info = MainInfo()
        self.agents = {}      # aid -> AgentFile (plain agents and workflow agents)
        self.journals = {}    # wf name -> JournalFile
        self.mtime = 0.0
        self.version = 0

    def refresh(self):
        changed = False
        st = self.tail.stat()
        if self.tail.changed(st):
            reset, lines = self.tail.read(st)
            if reset:
                self.info = MainInfo()
            for _off, raw in lines:
                d = parse_line(raw)
                if d:
                    self.info.feed(d)
            self.mtime = max(self.mtime, st.st_mtime)
            changed = True
        sub = os.path.join(self.dir, "subagents")
        if os.path.isdir(sub):
            for name in safe_listdir(sub):
                if name.startswith("agent-") and name.endswith(".jsonl"):
                    aid = name[6:-6]
                    if aid not in self.agents and ID_RE.match(aid):
                        self.agents[aid] = AgentFile(aid, os.path.join(sub, name), None)
            wroot = os.path.join(sub, "workflows")
            for wf in safe_listdir(wroot):
                wdir = os.path.join(wroot, wf)
                if not (wf.startswith("wf_") and ID_RE.match(wf) and os.path.isdir(wdir)):
                    continue
                if wf not in self.journals and os.path.exists(os.path.join(wdir, "journal.jsonl")):
                    self.journals[wf] = JournalFile(os.path.join(wdir, "journal.jsonl"))
                for name in safe_listdir(wdir):
                    if name.startswith("agent-") and name.endswith(".jsonl"):
                        aid = name[6:-6]
                        if aid not in self.agents and ID_RE.match(aid):
                            self.agents[aid] = AgentFile(aid, os.path.join(wdir, name), wf)
        for a in self.agents.values():
            if a.refresh():
                changed = True
                self.mtime = max(self.mtime, a.mtime)
        for j in self.journals.values():
            if j.refresh():
                changed = True
                self.mtime = max(self.mtime, j.mtime)
        if changed:
            self.version += 1
        return changed

    # ----- agent resolver: the one mapping every entry point uses -----
    def resolve(self, now=None, locate=None):
        """tool_use_id -> {"a", "wf", "label"} for a call whose agent transcript exists, or {"missing": reason, "a"?}.
        Sources, all merged: meta.json toolUseId, toolUseResult.agentId (main chat and every agent transcript, since agents
        can start agents), and SendMessage `to` (a resumed agent). Nothing is matched by description or prompt."""
        now = now or time.time()
        ag = self.agents
        out = {}
        found = lambda aid: {"a": aid, "wf": ag[aid].wf, "label": ag[aid].meta.get("description") or aid}
        for a in ag.values():
            if a.meta.get("toolUseId"):
                out[a.meta["toolUseId"]] = found(a.aid)
        for scan in [self.info.links] + [a.links for a in ag.values()]:
            for tid, call in scan.calls.items():
                if tid in out:
                    continue
                aid = call["to"] if call["kind"] == "SendMessage" else scan.agent_of.get(tid)
                if aid and aid in ag:
                    out[tid] = found(aid)
                    continue
                loc = locate(aid) if (aid and locate) else None
                if loc:   # the agent's transcript lives under another session (the chat was resumed or forked)
                    out[tid] = loc
                    continue
                if call["kind"] == "SendMessage" and not (aid and AID_RE.match(str(aid))):
                    continue   # a message to another session or a named peer, not a subagent of this chat
                if tid in scan.errors and not aid:
                    out[tid] = {"missing": "The call was rejected or failed, so no agent was started."}
                    continue
                t = tp.ts(call["t"] or "")
                age = now - t.timestamp() if t else 1e9
                if aid:
                    out[tid] = {"a": aid, "missing": "Its transcript isn't written yet." if age < 600 else
                                "Its transcript is not on disk: Claude Code deletes transcripts older than cleanupPeriodDays "
                                "(30 days by default), or it was never written."}
                else:
                    out[tid] = {"missing": "The agent's id isn't known yet: it appears as soon as the agent starts." if age < 600 else
                                "No agent id was recorded for this call."}
        return out

    # ----- Mission Control: every workflow is a run, every plain agent is a run (tracker.py: backfill()) -----
    def runs(self, now=None):
        now = now or dt.datetime.now().astimezone()
        cwd = self.info.first_cwd or self.info.cwd
        cands = []
        for wf in sorted({a.wf for a in self.agents.values() if a.wf} | set(self.journals)):
            j = self.journals.get(wf)
            ag = [(a.aid, a.meta, a.state) for a in sorted(self.agents.values(), key=lambda a: a.path) if a.wf == wf]
            cands.append((wf, j, ag, bool(j and j.state.exists)))
        for a in sorted((a for a in self.agents.values() if not a.wf), key=lambda a: a.path):
            cands.append((f"agent-{a.aid}", None, [(a.aid, a.meta, a.state)], False))
        killed = {}
        for scan in [self.info.links] + [a.links for a in self.agents.values()]:
            for tid, at in scan.killed.items():
                killed[tid] = max(killed.get(tid) or 0, at)
        stops = {a.aid: r for a in self.agents.values() for r in [stx.agent_stop(a.meta, a.turn, killed.get(a.aid))] if r}
        out, seen = [], set()
        for key, j, ag, is_wf in cands:
            d = tp.collect(key, j.state if j else None, ag, past=True, work=cwd, is_workflow=is_wf, now=now, stops=stops)
            ids = {r["id"] for r in d["agents"]}
            if not ids or ids & seen:   # tracker.py: backfill() dedupes runs by agent id
                continue
            seen |= ids
            d["src"] = {"wf": key if is_wf or key.startswith("wf_") else None}
            out.append(d)
        out.sort(key=lambda d: d["summary"]["start"] or "", reverse=True)
        return out

    def main_run(self, now=None):
        """The main conversation as one mission of its own (its tool calls, writes and edits). Shown in Mission Control
        only: runs() stays agents-only, so cost totals never count the main chat twice."""
        i = self.info.agent.info()
        if not i["events"]:
            return None
        now = now or dt.datetime.now().astimezone()
        idle = (now - i["last"]).total_seconds() if i["last"] else 0
        cwd = self.info.first_cwd or self.info.cwd
        meta = {"description": "Main chat", "finished": idle > 120}
        d = tp.collect("main", None, [("main", meta, self.info.agent)], title=self.info.title(), icon="💬",
                       past=True, work=cwd, now=now)
        d["run"] = d["summary"]["id"] = "main"
        d["main"] = d["summary"]["main"] = True
        d["src"] = {"wf": None}
        return d


def safe_listdir(p):
    try:
        return sorted(os.listdir(p)) if inside_root(p) else []
    except OSError:
        return []


def slugify(path):
    return re.sub(r"[^A-Za-z0-9]", "-", path or "")


class Store:
    def __init__(self, root=ROOT):
        self.root = root
        self.projects = {}   # slug -> {sid -> Session}
        self.lock = threading.RLock()
        self.version = 0
        self.changed_at = time.time()
        self._runs_cache = {}  # sid -> (version, minute bucket, runs)

    def scan(self):
        """One cheap pass: list dirs, stat files, parse only appended lines. Returns the changed session keys."""
        changed = []
        with self.lock:
            for slug in safe_listdir(self.root):
                pdir = os.path.join(self.root, slug)
                if not (slug.startswith("-") and os.path.isdir(pdir)):
                    continue
                sessions = self.projects.setdefault(slug, {})
                for name in safe_listdir(pdir):
                    if name.endswith(".jsonl") and ID_RE.match(name[:-6]):
                        sid = name[:-6]
                        if sid not in sessions:
                            sessions[sid] = Session(slug, sid, os.path.join(pdir, name))
                for sid, s in list(sessions.items()):
                    if not os.path.exists(s.path):
                        del sessions[sid]
                        changed.append((slug, sid))
                        continue
                    if s.refresh():
                        changed.append((slug, sid))
            if changed:
                self.version += 1
                self.changed_at = time.time()
        return changed

    def get(self, p, s):
        if not (p and s and ID_RE.match(p.lstrip("-") or "x") and ID_RE.match(s)):
            return None
        return self.projects.get(p, {}).get(s)

    def locate(self, aid):
        """Where an agent's transcript lives, in any session: {"a", "p", "s", "wf", "label"} or None."""
        for slug, sessions in self.projects.items():
            for s in sessions.values():
                a = s.agents.get(aid)
                if a:
                    return {"a": aid, "p": slug, "s": s.id, "wf": a.wf, "label": a.meta.get("description") or aid, "other": True}
        return None

    def session_runs(self, sess):
        """Mission Control runs of a session; cached per session version and per 30 s (the time-based rules)."""
        key = (sess.version, int(time.time() // 30))
        c = self._runs_cache.get((sess.project, sess.id))
        if c and c[0] == key:
            return c[1]
        runs = sess.runs()
        self._runs_cache[(sess.project, sess.id)] = (key, runs)
        return runs

    def project_path(self, slug, sessions):
        for s in sorted(sessions.values(), key=lambda s: -s.mtime):
            for c in (s.info.first_cwd, s.info.cwd):
                if c and slugify(c) == slug:
                    return c
        return "/" + slug.lstrip("-").replace("-", "/")  # lossy fallback: the slug writes every non-alnum as "-"

    def index(self):
        now = time.time()
        today = dt.datetime.now().astimezone().date().isoformat()
        out, day_usage = [], {}
        active_chats = running_agents = 0
        with self.lock:
            for slug, sessions in self.projects.items():
                rows = []
                for s in sessions.values():
                    i = s.info.agent.info()
                    agent_cost = agent_tok = 0
                    running = 0
                    for a in s.agents.values():
                        ai = a.state.info()
                        agent_cost += ai["cost_total"]
                        agent_tok += sum(ai["token_breakdown"].values())
                    if s.agents:
                        for run in self.session_runs(s):
                            running += sum(r["status"] == "running" for r in run["agents"])
                    for st in [s.info.agent] + [a.state for a in s.agents.values()]:
                        for mid, day in st.usage_day.items():
                            if day == today:
                                day_usage[mid] = st.usage[mid]   # deduped per message id across every file
                    status = stx.chat_status(s.info.turn, s.mtime, now, ACTIVE_SECS)   # the shared status rule
                    active = (now - s.mtime < ACTIVE_SECS and status != "stopped") or running > 0
                    active_chats += active
                    running_agents += running
                    rows.append({"id": s.id, "title": s.info.title(), "prompt": s.info.first_prompt,
                                 "mtime": s.mtime, "active": active, "status": status, "msgs": s.info.prompts + len(s.info.msg_ids),
                                 "prompts": s.info.prompts, "agents": len(s.agents), "workflows": len(s.journals),
                                 "running": running, "cost": round(i["cost_total"] + agent_cost, 4),
                                 "cost_main": i["cost_total"], "tokens": sum(i["token_breakdown"].values()) + agent_tok,
                                 "models": i["models"], "cwd": s.info.cwd, "branch": s.info.branch,
                                 "first": s.info.first_ts, "last": s.info.last_ts})
                if not rows:
                    continue
                rows.sort(key=lambda r: -r["mtime"])
                out.append({"slug": slug, "path": self.project_path(slug, sessions), "sessions": rows,
                            "mtime": rows[0]["mtime"]})
        out.sort(key=lambda p: -p["mtime"])
        tok, cost, _ = tp.sum_usage(day_usage.values())
        return {"projects": out, "v": self.version, "now": now, "changed_at": self.changed_at,
                "global": {"today_cost": round(sum(cost.values()), 4), "today_tokens": sum(tok.values()),
                           "today_tokens_breakdown": tok, "today_cost_breakdown": cost, "today_messages": len(day_usage),
                           "active_chats": active_chats, "running_agents": running_agents}}
