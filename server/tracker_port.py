"""Faithful port of the "Agent Mission Control" tracker's parsing and pricing logic.

Source: ~/.claude/skills/feature-delivery/scripts/tracker.py (copied, not imported: importing it would
write a __pycache__ under ~/.claude). Every function says which tracker.py function it comes from.

What changed and why:
- read_agent() became AgentState: the same per-line logic, fed incrementally by byte offset so a growing
  transcript only costs its new lines. info() returns exactly what read_agent() returned.
- read_journal() became JournalState, the same rules applied line by line.
- collect() takes the already-parsed states instead of reading files; the rules (done / stopped / finished,
  phases, run id, feed, summary) are unchanged.
- work_files() can't stat the real deliverables (this app only reads ~/.claude/projects), so deliverables
  are rebuilt from the Write/Edit tool inputs inside the transcripts (see Deliverables).
"""
import datetime as dt
import os
import re

# tracker.py: HOME_PREFIX. The path prefix trimmed from tool inputs in the activity feed; override with MC_PATH_PREFIX.
HOME_PREFIX = os.path.expanduser(os.environ.get("MC_PATH_PREFIX", "~/"))


def ts(s):  # tracker.py: ts()
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone()
    except Exception:
        return None


def iso(t):  # tracker.py: iso()
    return t.isoformat() if t else None


def short(s, n=160):  # tracker.py: short()
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def describe_tool(name, inp):  # tracker.py: describe_tool()
    inp = inp or {}
    if inp.get("description"):
        return f"{name}: {inp['description']}"
    for k in ("file_path", "pattern", "command", "query", "path", "id", "prompt"):
        if k in inp:
            v = str(inp[k]).replace(HOME_PREFIX, "")
            return f"{name}: {short(v, 120)}"
    return name


def tool_kind(name):  # tracker.py: tool_kind()
    n = (name or "").lower()
    if n in ("read", "grep", "glob") or "fetch" in n or "search" in n or "get" in n:
        return "read"
    if n in ("write", "edit", "notebookedit"):
        return "write"
    if n == "bash":
        return "shell"
    if n in ("structuredoutput", "subagenthandback"):
        return "result"
    return "tool"


class JournalState:
    """tracker.py: read_journal(), applied one journal line at a time."""

    def __init__(self):
        self.agents, self.order, self.finished, self.exists = {}, [], False, False

    def feed(self, d):
        self.exists = True
        agents = self.agents
        t, aid = d.get("type"), d.get("agentId")
        if t == "started" and aid:
            agents[aid] = {"label": d.get("label", aid), "phase": d.get("phase", ""), "status": "running"}
            self.order.append(aid)
        elif aid and aid in agents and t in ("completed", "result", "finished", "done"):
            agents[aid]["status"] = "done"
        elif aid and aid in agents and t in ("failed", "error", "skipped"):
            agents[aid]["status"] = "failed" if t == "error" else t
        elif t in ("workflow_completed", "completed_workflow", "finished_workflow", "returned"):
            self.finished = True
        if aid and aid in agents and ("result" in d or "output" in d) and t != "started":
            agents[aid]["status"] = "done"

    def snapshot(self):
        return {k: dict(v) for k, v in self.agents.items()}, list(self.order), self.finished


# tracker.py: PRICES (verbatim)
# List API prices, USD per million tokens: input, output, cache write 5m, cache write 1h, cache read.
# Source: the claude-api skill (cached 2026-11-03). Fast mode (usage.speed == "fast") bills 2x.
PRICES = {
    "claude-opus-5-5": (4.00, 20.00, 5.00, 8.00, 0.20),
    "claude-opus-5": (5.00, 25.00, 6.25, 10.00, 0.50),
    "claude-sonnet-5-5": (2.00, 10.00, 2.50, 4.00, 0.10),
    "claude-sonnet-5": (2.00, 10.00, 2.50, 4.00, 0.20),
    "claude-haiku-5-5": (0.10, 0.50, 0.125, 0.20, 0.01),
    "claude-fable-5-2": (8.00, 40.00, 10.00, 16.00, 0.20),
    "claude-fable-5-1": (10.00, 50.00, 12.50, 20.00, 0.25),
}


def price_for(model):  # tracker.py: price_for()
    model = (model or "").lower()
    return next((p for k, p in sorted(PRICES.items(), key=lambda kv: -len(kv[0])) if model.startswith(k)), None)


def usage_cost(model, u):  # tracker.py: usage_cost()
    """Return (tokens dict, cost dict in USD) for one deduplicated message usage."""
    cc = u.get("cache_creation") or {}
    w1h = int(cc.get("ephemeral_1h_input_tokens") or 0)
    w_all = int(u.get("cache_creation_input_tokens") or 0)
    w5m = int(cc.get("ephemeral_5m_input_tokens") or max(w_all - w1h, 0))
    t = {"input": int(u.get("input_tokens") or 0), "output": int(u.get("output_tokens") or 0),
         "cache_write": w5m + w1h, "cache_read": int(u.get("cache_read_input_tokens") or 0)}
    p = price_for(model)
    if not p:
        return t, None
    k = 2.0 if u.get("speed") == "fast" else 1.0
    c = {"input": t["input"] * p[0], "output": t["output"] * p[1],
         "cache_write": w5m * p[2] + w1h * p[3], "cache_read": t["cache_read"] * p[4]}
    return t, {key: v * k / 1e6 for key, v in c.items()}


def sum_usage(usages):
    """tracker.py: the token/cost totals at the end of read_agent(), over (model, usage) pairs deduped per message id."""
    tok = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
    cost = {"input": 0.0, "output": 0.0, "cache_write": 0.0, "cache_read": 0.0}
    priced = True
    for model, u in usages:
        t, c = usage_cost(model, u)
        for k in tok:
            tok[k] += t[k]
        if c is None:
            priced = False
        else:
            for k in cost:
                cost[k] += c[k]
    return tok, cost, priced


def md_facts(name, txt):
    """tracker.py: work_files() per-file facts (headings, severity mentions, open questions), from text we already have."""
    heads = [h.strip("# ").strip() for h in re.findall(r"^#{1,3} .+$", txt, re.M)][:14]
    base = os.path.basename(name)
    sev = {k: len(re.findall(rf"\b{k}\b", txt, re.I)) for k in ("blocker", "major", "minor")} \
        if base.startswith(("review_", "20_")) else None
    oq = re.search(r"^#{1,3} .*Open questions.*$([\s\S]*?)(?=^#{1,3} |\Z)", txt, re.M | re.I)
    oq_items = [short(x, 180) for x in re.findall(r"^\s*(?:[-*]|\d+\.)\s+(.+)$", oq.group(1), re.M)][:6] if oq else []
    return {"lines": txt.count("\n"), "heads": heads, "sev": sev, "oq": oq_items}


class AgentState:
    """tracker.py: read_agent(), fed one transcript line at a time (same rules, same output via info())."""

    def __init__(self):
        self.tools = 0
        self.events = []
        self.first = self.last = None
        self.last_text = ""
        self.usage = {}       # message id -> (model, usage): one message is stored once per content block
        self.usage_day = {}   # message id -> local date of its timestamp (for the "today" tile; not in the tracker)
        self.models = set()
        self.written = {}     # path -> {t, writes, edits, facts} (deliverables; replaces work_files() file reads)
        self._anon = 0

    def feed(self, d):
        if d.get("type") != "assistant":
            return
        t = ts(d.get("timestamp", ""))
        if t:
            self.first = self.first or t
            self.last = t
        msg = d.get("message") or {}
        if msg.get("usage"):  # one message is stored once per content block: keep one usage per message id
            mid = msg.get("id")
            if not mid:
                self._anon += 1
                mid = f"anon-{self._anon}"
            self.usage[mid] = (msg.get("model"), msg["usage"])
            if t:
                self.usage_day[mid] = t.date().isoformat()
            if msg.get("model"):
                self.models.add(msg["model"])
        for c in msg.get("content") or []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                self.tools += 1
                name = c.get("name")
                inp = c.get("input") or {}
                if name in ("Write", "Edit", "NotebookEdit") and isinstance(inp, dict) and inp.get("file_path"):
                    self._wrote(os.path.abspath(str(inp["file_path"])), name, inp, t)
                if name == "SubagentHandback":
                    report = (inp if isinstance(inp, dict) else {}).get("message", "")
                    if report:
                        self.last_text = report
                    text = "handed back the final report"
                elif name == "StructuredOutput":
                    text = "returned structured summary"
                else:
                    text = describe_tool(name, inp if isinstance(inp, dict) else {})
                self.events.append({"t": iso(t), "kind": tool_kind(name), "text": text})
            elif c.get("type") == "text" and str(c.get("text", "")).strip():
                self.last_text = c["text"]
                self.events.append({"t": iso(t), "kind": "think", "text": short(c["text"], 220)})

    def _wrote(self, path, name, inp, t):
        w = self.written.setdefault(path, {"t": None, "writes": 0, "edits": 0, "facts": None})
        w["t"] = iso(t) or w["t"]
        if name == "Write" and isinstance(inp.get("content"), str):
            w["writes"] += 1
            w["facts"] = md_facts(path, inp["content"])
        else:
            w["edits"] += 1

    def info(self):
        tok, cost, priced = sum_usage(self.usage.values())
        return {"tools": self.tools, "tokens": tok["output"], "events": self.events, "first": self.first,
                "last": self.last, "last_text": self.last_text, "token_breakdown": tok, "cost": cost,
                "cost_total": round(sum(cost.values()), 4), "priced": priced, "models": sorted(self.models),
                "written": sorted(self.written)}


# tracker.py: ICONS (verbatim)
ICONS = [  # first match wins: (keywords, icon)
    (("feasib",), "📐"), (("public api", "endpoint", "openapi", "gateway"), "🔌"),
    (("document", "one-pager", "onepager", "write ", "docs"), "📝"), (("review", "verify", "audit", "critic"), "🧪"),
    (("design", "architect", "guide", "plan"), "🧭"), (("implement", "build", "code", "fix"), "🛠️"),
    (("test", "qa"), "✅"), (("migrat",), "🚚"), (("research", "analys", "understand", "explore", "map "), "🔎"),
]


def pick_icon(text):  # tracker.py: pick_icon()
    t = (text or "").lower()
    return next((icon for keys, icon in ICONS if any(k in t for k in keys)), "🛰️")


def feature_name(work):  # tracker.py: feature_name()
    base = re.sub(r"_work$", "", os.path.basename(work or ""))
    return " ".join(w.upper() if len(w) <= 3 else w.capitalize() for w in base.split("_") if w) or "Agents"


def task_name(rows, phases):  # tracker.py: task_name()
    if len(rows) == 1:
        return rows[0]["label"]
    if phases:
        return " → ".join(p["name"] for p in phases)
    return f"{len(rows)} agents" if rows else "Waiting for agents"


def deliverables(agent_states, cwd):
    """Replaces tracker.py: work_files(). The tracker stats the work dir; this app may only read ~/.claude/projects,
    so a run's deliverables are the files its agents wrote, with facts taken from the last Write's content."""
    merged = {}
    for st in agent_states:
        for p, w in st.written.items():
            m = merged.setdefault(p, {"t": None, "writes": 0, "edits": 0, "facts": None})
            if (w["t"] or "") >= (m["t"] or ""):
                m["t"] = w["t"]
                m["facts"] = w["facts"] or m["facts"]
            m["writes"] += w["writes"]
            m["edits"] += w["edits"]
    out = []
    root = (cwd or "").rstrip("/") + "/"
    for p, m in merged.items():
        name = p[len(root):] if cwd and p.startswith(root) else p.replace(os.path.expanduser("~"), "~")
        f = m["facts"] or {"lines": None, "heads": [], "sev": None, "oq": []}
        out.append({"name": name, "path": p, "mtime": m["t"], "writes": m["writes"], "edits": m["edits"], **f})
    out.sort(key=lambda f: f["mtime"] or "", reverse=True)
    return out


def collect(run_key, journal, agents, title="", icon="", past=True, work="", is_workflow=False, now=None):
    """tracker.py: collect(). One run's payload.

    journal: JournalState or None (a plain agent has none); agents: [(aid, meta dict, AgentState)] for every
    agent-*.jsonl of the run, in discovery order. The tracker's rules are kept as is:
    - journal agents first, then agents known only from .meta.json (label = description, phase = workflowPhase);
    - meta finished, or a result event (SubagentHandback / StructuredOutput), means done; stoppedByUser means stopped;
    - a run with every agent off and idle > 2 min is finished;
    - past=True: a run silent for 45 min with no finish signal is finished and its running agents are stopped.
      This app has no live loop per run, so it always applies the snapshot (past) rules, like refresh_orphans().
    """
    j_agents, order, finished = journal.snapshot() if journal else ({}, [], False)
    by_id = {aid: (meta, st) for aid, meta, st in agents}
    journal_ids = set(j_agents)
    for aid, meta, _st in agents:
        if aid not in j_agents:
            j_agents[aid] = {"label": meta.get("description", aid), "phase": meta.get("workflowPhase", ""), "status": "running"}
            order.append(aid)
    now = now or dt.datetime.now().astimezone()
    rows, feed, states = [], [], []
    for aid in order:
        a = j_agents[aid]
        meta, st = by_id.get(aid, ({}, None))
        st = st or AgentState()
        states.append(st)
        i = st.info()
        if a["status"] == "running" and (meta.get("finished") or any(e["kind"] == "result" for e in i["events"])):
            a["status"] = "done"
        elif a["status"] == "running" and meta.get("stoppedByUser"):
            a["status"] = "stopped"
        # Extension (not in tracker.py): a plain agent resumed after its hand-back (SendMessage) has activity after
        # its last result event; it is running again until it hands back once more (or goes silent for 45 min).
        if a["status"] == "done" and aid not in journal_ids:
            res = [k for k, e in enumerate(i["events"]) if e["kind"] == "result"]
            if res and res[-1] < len(i["events"]) - 1 and (i["events"][-1]["t"] or "") > (i["events"][res[-1]]["t"] or ""):
                a["status"] = "running"
                a["resumed"] = True
        rows.append({**a, "id": aid, "tools": i["tools"], "tokens": i["tokens"], "first": iso(i["first"]),
                     "token_breakdown": i["token_breakdown"], "cost": i["cost"], "cost_total": i["cost_total"],
                     "priced": i["priced"], "models": i["models"],
                     "last": iso(i["last"]), "last_ev": i["events"][-1]["text"] if i["events"] else "starting…",
                     "last_text": short(i["last_text"], 2500), "events": i["events"][-60:],
                     "n_events": len(i["events"]), "agent_type": meta.get("agentType", "")})
        feed += [{**e, "agent": a["label"], "id": aid} for e in i["events"] if e["t"]]
    feed.sort(key=lambda x: x["t"], reverse=True)
    lasts = [ts(r["last"]) for r in rows if r["last"]]
    idle = (now - max(lasts)).total_seconds() if lasts else 0
    if rows and not finished and all(r["status"] != "running" for r in rows) and idle > 120:
        finished = True  # the journal does not always record a workflow-completed line
    if past and rows and not finished and idle > 2700:
        finished = True  # nothing for 45 min and no finish signal: the run was interrupted
        for r in rows:
            r["status"] = "stopped" if r["status"] == "running" else r["status"]
    phases = []
    for ph in dict.fromkeys(r["phase"] for r in rows if r["phase"]):
        pr = [r for r in rows if r["phase"] == ph]
        phases.append({"name": ph, "total": len(pr), "done": sum(r["status"] == "done" for r in pr),
                       "running": sum(r["status"] == "running" for r in pr),
                       "cost": round(sum(r["cost_total"] for r in pr), 4)})
    task = title or task_name(rows, phases)
    # a workflow is keyed by its dir, a single plain agent by its id: the live loop and the backfill share ids
    rid = f"agent-{rows[0]['id']}" if len(rows) == 1 and not is_workflow else run_key
    d = {"run": rid, "work": os.path.basename(work or ""), "finished": finished,
         "feature": feature_name(work), "task": task,
         "icon": icon or pick_icon(title or (phases[0]["name"] if len(rows) > 1 and phases else task)),
         "generated_at": iso(now), "phases": phases, "agents": rows, "feed": feed[:120],
         "files": deliverables(states, work), "workflow": is_workflow}
    d["summary"] = summary(d)
    return d


def summary(d):  # tracker.py: summary()
    A = d["agents"]
    st = "running" if not d["finished"] else \
        next((s for s in ("failed", "stopped") if any(r["status"] == s for r in A)), "done")
    return {"id": d["run"], "title": d["task"], "icon": d["icon"], "status": st, "agents": len(A),
            "start": min((r["first"] for r in A if r["first"]), default=None),
            "end": max((r["last"] for r in A if r["last"]), default=None),
            "tokens": sum(sum(r["token_breakdown"].values()) for r in A),
            "cost": round(sum(r["cost_total"] for r in A), 4)}
