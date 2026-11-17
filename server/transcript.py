"""Transcript entries for the conversation view, parsed incrementally and paginated from the end.

Each JSONL line becomes zero or more entries (one per content block). Unknown line or block types become a
small "unknown" entry instead of failing. Long texts are truncated here; /api/full re-reads the one line by its
byte offset to return the full block, so big files never travel whole.
"""
import json
import os
import re
import threading
import time
from collections import OrderedDict

import store as st
import tracker_port as tp

TOOL_RESULT_MAX = 4000
INPUT_STR_MAX = 3000
TEXT_MAX = 60000
META_MAX = 3000
SHOWN_SYSTEM = {"compact_boundary", "away_summary", "local_command", "api_error", "informational", "error",
                "warning", "bridge_status"}
HIDDEN_SYSTEM = {"turn_duration", "stop_hook_summary"}


def cut(s, n):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    if n is None or len(s) <= n:
        return s, False, len(s)
    return s[:n], True, len(s)


def result_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        if not isinstance(b, dict):
            parts.append(str(b))
        elif b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif b.get("type") == "image":
            parts.append("[image]")
        elif b.get("type") == "tool_reference":
            parts.append(f"↳ loaded tool {b.get('tool_name', '')}")
        else:
            parts.append(f"[{b.get('type', 'block')}]")
    return "\n".join(parts)


def trim_input(inp, limit):
    if not isinstance(inp, dict):
        v, tr, n = cut(inp, limit)
        return v, ([""] if tr else [])
    out, trunc = {}, []
    for k, v in inp.items():
        if isinstance(v, str) and limit is not None and len(v) > limit:
            out[k] = v[:limit]
            trunc.append(k)
        elif isinstance(v, (dict, list)) and limit is not None:
            s = json.dumps(v, ensure_ascii=False)
            if len(s) > limit:
                out[k] = s[:limit]
                trunc.append(k)
            else:
                out[k] = v
        else:
            out[k] = v
    return out, trunc


def normalize(d, limit=True):
    """Return a list of entry dicts for one parsed line (without seq/off, added by the caller)."""
    L = lambda n: n if limit else None
    t = d.get("type")
    base = {"ts": d.get("timestamp"), "uuid": d.get("uuid")}
    msg = d.get("message") if isinstance(d.get("message"), dict) else {}
    out = []
    if t == "user":
        c = msg.get("content")
        tur = d.get("toolUseResult") if isinstance(d.get("toolUseResult"), dict) else {}
        if isinstance(c, str):
            blocks = [{"type": "text", "text": c}]
        else:
            blocks = c if isinstance(c, list) else []
        for bi, b in enumerate(blocks):
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "tool_result":
                text, tr, n = cut(result_text(b.get("content")), L(TOOL_RESULT_MAX))
                e = {**base, "k": "result", "bi": bi, "id": b.get("tool_use_id"), "text": text, "trunc": tr,
                     "len": n, "err": bool(b.get("is_error"))}
                for key in ("agentId", "runId", "status", "totalDurationMs", "totalTokens", "totalToolUseCount"):
                    if tur.get(key) is not None:
                        e[key] = tur[key]
                out.append(e)
            elif bt == "text":
                text = b.get("text", "")
                if d.get("isCompactSummary"):
                    v, tr, n = cut(text, L(META_MAX))
                    out.append({**base, "k": "compact", "bi": bi, "text": v, "trunc": tr, "len": n})
                elif d.get("isMeta") or text.startswith("Another Claude session sent a message"):
                    v, tr, n = cut(text, L(META_MAX))
                    out.append({**base, "k": "meta", "bi": bi, "text": v, "trunc": tr, "len": n})
                elif text.startswith("[Request interrupted"):
                    out.append({**base, "k": "interrupt", "bi": bi, "text": text})
                elif text.lstrip().startswith("<command-name>") or text.lstrip().startswith("<command-message>"):
                    name = re.search(r"<command-name>([\s\S]*?)</command-name>", text)
                    args = re.search(r"<command-args>([\s\S]*?)</command-args>", text)
                    out.append({**base, "k": "command", "bi": bi, "name": (name.group(1) if name else "").strip(),
                                "args": (args.group(1) if args else "").strip()})
                elif text.lstrip().startswith("<local-command-std"):
                    v, tr, n = cut(re.sub(r"</?local-command-std\w+>", "", text), L(META_MAX))
                    out.append({**base, "k": "cmdout", "bi": bi, "text": v, "trunc": tr, "len": n})
                else:
                    v, tr, n = cut(text, L(TEXT_MAX))
                    out.append({**base, "k": "user", "bi": bi, "text": v, "trunc": tr, "len": n})
            elif bt == "image":
                out.append({**base, "k": "user", "bi": bi, "text": "", "image": True})
            else:
                out.append({**base, "k": "unknown", "bi": bi, "type": f"user/{bt}"})
    elif t == "assistant":
        mid, model = msg.get("id"), msg.get("model")
        for bi, b in enumerate(msg.get("content") or []):
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            e = {**base, "bi": bi, "mid": mid, "model": model}
            if bt == "text":
                v, tr, n = cut(b.get("text", ""), L(TEXT_MAX))
                out.append({**e, "k": "text", "text": v, "trunc": tr, "len": n})
                if d.get("isApiErrorMessage"):   # Claude Code's synthetic "API Error: …" message that ends a turn
                    out[-1]["apiErr"] = d.get("error") or "api_error"
            elif bt in ("thinking", "redacted_thinking"):
                v, tr, n = cut(b.get("thinking", "") or "", L(TEXT_MAX))
                out.append({**e, "k": "thinking", "text": v, "trunc": tr, "len": n,
                            "ms": d.get("thinkingDurationMs")})
            elif bt in ("tool_use", "server_tool_use"):
                inp, trunc = trim_input(b.get("input") or {}, L(INPUT_STR_MAX))
                name = b.get("name", "tool")
                out.append({**e, "k": "tool", "id": b.get("id"), "name": name, "input": inp, "itrunc": trunc,
                            "desc": tp.describe_tool(name, b.get("input") if isinstance(b.get("input"), dict) else {}),
                            "kind": tp.tool_kind(name)})
            elif bt.endswith("_tool_result"):
                bc = b.get("content")
                if isinstance(bc, dict) and "redacted" in str(bc.get("type", "")):
                    bc = "(redacted result)"
                text, tr, n = cut(result_text(bc) if not isinstance(bc, dict)
                                  else json.dumps(bc, ensure_ascii=False), L(TOOL_RESULT_MAX))
                out.append({**e, "k": "result", "id": b.get("tool_use_id"), "text": text, "trunc": tr, "len": n,
                            "err": False})
            else:
                out.append({**e, "k": "unknown", "type": f"assistant/{bt}"})
        if out and msg.get("usage"):
            tok, cost = tp.usage_cost(model, msg["usage"])
            out[-1]["usage"] = {"tok": tok, "cost": round(sum(cost.values()), 5) if cost else None}
    elif t == "system":
        sub = d.get("subtype") or ""
        if sub in HIDDEN_SYSTEM:
            return []
        content = d.get("content")
        v, tr, n = cut(result_text(content) if not isinstance(content, str) else content, L(META_MAX))
        e = {**base, "k": "system", "sub": sub, "text": v, "trunc": tr, "len": n, "level": d.get("level")}
        for key in ("retryInMs", "retryAttempt", "maxRetries", "error", "cause"):   # api_error / retry entries, if written
            if d.get(key) is not None:
                e[key] = d[key] if not isinstance(d[key], (dict, list)) else json.dumps(d[key])[:300]
        if sub == "compact_boundary":
            cm = d.get("compactMetadata") or {}
            e["pre"], e["post"] = cm.get("preTokens"), cm.get("postTokens")
        out.append(e)
    elif t == "summary":
        out.append({**base, "k": "summary", "text": d.get("summary", "")})
    # every other line type (attachment, mode, ai-title, queue-operation, ...) is metadata: not part of the chat
    return out


OUTLINE_LABEL = 90
NOTE_KINDS = {"compact", "command", "cmdout", "interrupt", "summary", "system"}


def _plain(s):
    s = re.sub(r"<system-reminder>[\s\S]*?</system-reminder>", " ", s or "")
    return tp.short(re.sub(r"<[^>]+>", " ", s), OUTLINE_LABEL)


def outline_mark(e):
    """One entry -> [seq, kind, ts, size, label] for the conversation outline strip, or None (not shown on its own).
    kind: user · text · think · read/write/shell/result/tool (tool kinds) · error · handback · note."""
    k, n = e.get("k"), e.get("len") or len(e.get("text") or "")
    if k == "user":
        return [e["seq"], "user", e.get("ts"), n, "🖼 image" if e.get("image") else _plain(e.get("text")) or "(empty prompt)"]
    if k == "text":
        return [e["seq"], "error" if e.get("apiErr") else "text", e.get("ts"), n, _plain(e.get("text")) or "(empty reply)"]
    if k == "thinking":
        txt = _plain(e.get("text"))
        return [e["seq"], "think", e.get("ts"), n or int((e.get("ms") or 0) / 10), txt or "thought (content not stored in the transcript)"]
    if k == "tool":
        size = sum(len(v) if isinstance(v, str) else len(json.dumps(v, ensure_ascii=False)) for v in (e.get("input") or {}).values()) \
            if isinstance(e.get("input"), dict) else len(str(e.get("input") or ""))
        return [e["seq"], e.get("kind") or "tool", e.get("ts"), size, tp.short(e.get("desc") or e.get("name") or "tool", OUTLINE_LABEL)]
    if k == "result":   # only a result with no call in this transcript shows on its own; the rest attach to their call
        return [e["seq"], "error" if e.get("err") else "result", e.get("ts"), n, "Tool result · " + (_plain(e.get("text")) or "(empty)")]
    if k == "meta":
        txt = e.get("text") or ""
        m = re.search(r'<agent-message from="([\w-]+)"', txt)
        if m:
            body = re.sub(r"^\s*Another Claude session sent a message:\s*(\[[^\]]*\]\s*)?", "", _plain(txt))
            return [e["seq"], "handback", e.get("ts"), n, f"Agent hand-back · {m.group(1)} · " + body]
        title = "Skill loaded" if txt.startswith("Base directory for this skill") else "System context"
        return [e["seq"], "note", e.get("ts"), n, f"{title} · " + _plain(txt)]
    if k in NOTE_KINDS:
        if k == "command":
            label = f"{e.get('name') or 'command'} {e.get('args') or ''}".strip()
        elif k == "interrupt":
            label = "Interrupted by the user"
        elif k == "compact":
            label = "Compacted context"
        elif k == "system":
            label = (e.get("sub") or "system") + (" · " + _plain(e.get("text")) if e.get("text") else "")
        else:
            label = {"cmdout": "Command output", "summary": "Summary"}[k] + " · " + _plain(e.get("text"))
        return [e["seq"], "note", e.get("ts"), n, tp.short(label, OUTLINE_LABEL)]
    return None


class Transcript:
    def __init__(self, path):
        self.path = path
        self.tail = st.Tail(path)
        self.entries = []
        self.epoch = 0
        self.lock = threading.Lock()
        self._reset_outline()

    def _reset_outline(self):
        # the outline grows with the entries (never rebuilt per request); each mark keeps the rev it last changed in
        self.outline, self.omod, self.orev, self.ocall = [], [], 0, {}   # ocall: tool_use_id -> outline index

    def _outline_add(self, e):
        k = e.get("k")
        if k == "result" and e.get("id") in self.ocall:   # attaches to its call: adds its size, turns it red on error
            i = self.ocall[e["id"]]
            m = self.outline[i]
            m[3] += e.get("len") or 0
            if e.get("err"):
                m[1], m[4] = "error", tp.short("✗ " + m[4] + " · " + _plain(e.get("text")), OUTLINE_LABEL + 40)
            self.omod[i] = self.orev
            return
        m = outline_mark(e)
        if not m:
            return
        if k == "tool" and e.get("id"):
            self.ocall[e["id"]] = len(self.outline)
        self.outline.append(m)
        self.omod.append(self.orev)

    def update(self):
        with self.lock:
            s = self.tail.stat()
            if not self.tail.changed(s):
                return
            reset, lines = self.tail.read(s)
            if reset:
                self.entries, self.epoch = [], self.epoch + 1
                self._reset_outline()
            self.orev += 1
            for off, raw in lines:
                d = st.parse_line(raw)
                if not d:
                    continue
                for e in normalize(d):
                    e["seq"], e["off"] = len(self.entries), off
                    self.entries.append(e)
                    self._outline_add(e)

    def outline_since(self, rev=0):
        """Marks added or changed after `rev` (0 = all), with the rev to send next time. Built from the parse cache."""
        self.update()
        with self.lock:
            items = [m for m, r in zip(self.outline, self.omod) if r > rev] if rev else list(self.outline)
            return {"items": items, "rev": self.orev, "epoch": self.epoch, "total": len(self.entries)}

    def page(self, before=None, after=None, limit=150):
        self.update()
        n = len(self.entries)
        limit = max(1, min(int(limit or 150), 500))
        if after is not None:
            a = max(0, min(int(after), n))
            sl = self.entries[a: a + limit * 4]
            start = a
        else:
            b = n if before is None else max(0, min(int(before), n))
            start = max(0, b - limit)
            # never split an assistant message's blocks or a tool call from its result across a page edge
            while start > 0 and self.entries[start].get("k") in ("result",) or (
                    start > 0 and self.entries[start].get("mid") and
                    self.entries[start].get("mid") == self.entries[start - 1].get("mid")):
                start -= 1
            sl = self.entries[start: b]
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            mtime = 0
        return {"entries": sl, "start": start, "total": n, "epoch": self.epoch, "mtime": mtime, "now": time.time()}

    def full(self, seq):
        """The untruncated version of one entry, re-read from its line's byte offset."""
        self.update()
        if not (0 <= seq < len(self.entries)):
            return None
        e = self.entries[seq]
        if not st.inside_root(self.path):
            return None
        with open(self.path, "rb") as f:
            f.seek(e["off"])
            raw = f.readline()
        d = st.parse_line(raw)
        for x in normalize(d, limit=False) if d else []:
            if x.get("bi") == e.get("bi") and x.get("k") == e.get("k"):
                x["seq"], x["off"] = e["seq"], e["off"]
                return x
        return None


class TranscriptCache:
    """LRU of opened transcripts (only chats someone looks at are kept in memory)."""

    def __init__(self, size=16):
        self.size, self.items, self.lock = size, OrderedDict(), threading.Lock()

    def get(self, path):
        with self.lock:
            t = self.items.get(path)
            if t is None:
                t = self.items[path] = Transcript(path)
            self.items.move_to_end(path)
            while len(self.items) > self.size:
                self.items.popitem(last=False)
            return t
