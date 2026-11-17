"""The one place that decides whether a chat or an agent is running, stopped or idle (not in tracker.py).

A turn interrupted by the user (Esc, a stopped request, a rejected tool use) ends with an interruption marker:
- a user line whose text starts with "[Request interrupted by user" (also "... for tool use]");
- an is_error tool_result saying "The user doesn't want to proceed with this tool use" or "... take this action
  right now" (a rejection that carries the user's feedback is not a stop: the turn goes on).
Only a later user prompt or assistant output makes the transcript live again; metadata lines (attachments,
system turn_duration, titles, queue operations) never do.
"""
import datetime as dt
import re

FRESH_SECS = 300
INTERRUPT_RE = re.compile(r"^\s*\[Request interrupted by user")
REJECT_RE = re.compile(r"^\s*(?:Error: )?(?:The user doesn't want to (?:proceed with this tool use|take this action)"
                       r"|\[Request interrupted by user|Interrupted by user)")
NOTE_RE = re.compile(r"<task-notification>([\s\S]*?)</task-notification>")


def _epoch(s):
    try:
        return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _text(c):
    if isinstance(c, str):
        return c
    return " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")


def is_marker(d):
    """True when this user line is an interruption marker."""
    c = (d.get("message") or {}).get("content")
    if INTERRUPT_RE.match(_text(c)):
        return True
    for b in c if isinstance(c, list) else []:
        if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
            bc = b.get("content")
            s = bc if isinstance(bc, str) else " ".join(x.get("text", "") for x in bc or [] if isinstance(x, dict))
            if REJECT_RE.match(s or "") and "the user said:" not in s:
                return True
    return False


def notifications(d):
    """[(task id, status, epoch)] of the task-notifications a user line or a queue enqueue carries."""
    if d.get("type") == "queue-operation" and d.get("operation") == "enqueue":
        text = d.get("content") if isinstance(d.get("content"), str) else ""
    elif d.get("type") == "user":
        text = _text((d.get("message") or {}).get("content"))
    else:
        return []
    if not text.lstrip().startswith("<task-notification>"):
        return []
    out, t = [], _epoch(d.get("timestamp"))
    for body in NOTE_RE.findall(text):
        tid, stt = re.search(r"<task-id>([^<]+)</task-id>", body), re.search(r"<status>([^<]+)</status>", body)
        if tid and stt:
            out.append((tid.group(1).strip(), stt.group(1).strip(), t))
    return out


class TurnState:
    """Where the last turn of one transcript stands: "busy" (prompt or tool result, more to come), "tool" (a tool
    call pending), "end" (the turn ended normally), "stopped" (it ended in an interruption marker), or None."""

    def __init__(self):
        self.state, self.t, self.stop_t = None, None, None   # t: epoch of the last prompt/assistant output

    def feed(self, d):
        t = d.get("type")
        if t == "assistant":
            msg = d.get("message") or {}
            kinds = {b.get("type") for b in msg.get("content") or [] if isinstance(b, dict)}
            self.state = "tool" if "tool_use" in kinds else "end" if msg.get("stop_reason") in ("end_turn", "stop_sequence") else "busy"
            self.t = _epoch(d.get("timestamp")) or self.t
        elif t == "user" and not d.get("isMeta") and not d.get("isCompactSummary"):
            if is_marker(d):
                self.state, self.stop_t = "stopped", _epoch(d.get("timestamp"))
                return
            c = (d.get("message") or {}).get("content")
            if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                if self.state != "stopped":
                    self.state = "busy"
                return
            text = _text(c).lstrip()
            if not text:
                return
            self.state = "end" if text.startswith(("<local-command-stdout", "<local-command-stderr")) else "busy"
            self.t = _epoch(d.get("timestamp")) or self.t
        elif t == "system" and d.get("subtype") == "turn_duration" and self.state in ("busy", "tool"):
            self.state = "end"


def chat_status(turn, mtime, now, fresh=FRESH_SECS):
    """"stopped" | "running" | "idle" for a chat (or agent) transcript."""
    if turn.state == "stopped":
        return "stopped"
    if turn.state in ("busy", "tool") and now - (mtime or 0) < fresh:
        return "running"
    return "idle"


def agent_stop(meta, turn, killed_at=None):
    """Why an agent is stopped, or None: stoppedByUser in its meta, a <status>killed</status> notification for it,
    or its own transcript ending in an interruption marker. Later activity (a revive) clears the first two."""
    if turn.state == "stopped":
        return "interrupted"
    if killed_at and not (turn.t and turn.t > killed_at):
        return "killed by the user"
    if meta.get("stoppedByUser"):
        rev = meta.get("revivedAt")
        if not (rev and turn.t and turn.t * 1000 >= rev):
            return "stopped by the user"
    return None
