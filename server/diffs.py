"""Git-style diffs of the files a chat or run wrote, rebuilt from the transcripts only.

The file itself is never read: `path` is only a search string. Sources, in order of preference:
- the tool_result's toolUseResult: originalFile (the full file before the change), type create|update, structuredPatch;
- the tool_use input: Write content, Edit old_string/new_string (+ replace_all), MultiEdit edits;
- the content reconstructed so far, by replaying the earlier changes in time order.
Failed calls (is_error) are skipped. A change whose previous content is unknown is shown without valid line numbers
and gets no copyable patch.
"""
import difflib
import json
import os
import re
import threading
from collections import OrderedDict

import store as st
import tracker_port as tp

TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
RID = re.compile(rb'"tool_use_id":"([^"]+)"')
_CACHE, _LOCK = OrderedDict(), threading.Lock()


def _scan(path_file, target, aid, label):
    """Changes to `target` in one transcript file, in file order."""
    if not st.inside_root(path_file):
        return []
    needle = target.encode()
    uses, order, results = {}, [], {}
    with open(path_file, "rb") as f:
        for raw in f:
            if raw.startswith(st.SKIP_PREFIXES):
                continue
            has_path = needle in raw
            m = None if has_path else RID.search(raw)
            if not has_path and not (m and m.group(1).decode() in uses):
                continue
            d = st.parse_line(raw)
            if not d:
                continue
            msg = d.get("message") or {}
            if d.get("type") == "assistant":
                for b in msg.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in TOOLS:
                        inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                        fp = inp.get("file_path") or inp.get("notebook_path")
                        if fp and os.path.abspath(fp) == target:
                            uses[b["id"]] = {"id": b["id"], "tool": b["name"], "input": inp, "t": d.get("timestamp"),
                                             "aid": aid, "agent": label}
                            order.append(b["id"])
            elif d.get("type") == "user" and isinstance(msg.get("content"), list):
                tur = d.get("toolUseResult")
                for b in msg["content"]:
                    if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") in uses:
                        c = b.get("content")
                        text = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict))
                        results[b["tool_use_id"]] = {"err": bool(b.get("is_error")) or (isinstance(tur, str) and tur.startswith("Error")),
                                                     "tur": tur if isinstance(tur, dict) else None, "text": text[:300]}
    out = []
    for i in order:
        c = uses[i]
        r = results.get(i)
        c["err"] = bool(r and r["err"])
        c["tur"] = r["tur"] if r else None
        c["rtext"] = r["text"] if r else ""
        c["pending"] = r is None
        out.append(c)
    return out


def _apply_edit(before, old, new, all_):
    if before is None or not isinstance(old, str) or not isinstance(new, str) or old not in before:
        return None
    return before.replace(old, new) if all_ else before.replace(old, new, 1)


def _apply_patch(text, sp, reverse=False):
    """Apply a structuredPatch (or undo it with reverse=True) by line number; None if any line does not match."""
    if text is None or not isinstance(sp, list) or not sp:
        return None
    lines = text.splitlines(keepends=True)
    out, pos = [], 0
    keep_src, keep_dst = ("+", "-") if reverse else ("-", "+")
    for h in sorted(sp, key=lambda h: h.get("newStart" if reverse else "oldStart", 0)):
        body = [x for x in h.get("lines", []) if x and x[0] in " +-"]
        src = [x[1:] for x in body if x[0] in (" ", keep_src)]
        dst = [x[1:] for x in body if x[0] in (" ", keep_dst)]
        start = max(0, int(h.get("newStart" if reverse else "oldStart", 1)) - 1)
        if len(src) == 0 and int(h.get("newLines" if reverse else "oldLines", 0)) == 0:
            start = int(h.get("newStart" if reverse else "oldStart", 0))   # pure insertion: start is the line before
        if start < pos or [x.rstrip("\n") for x in lines[start:start + len(src)]] != src:
            return None
        out += lines[pos:start] + [x + "\n" for x in dst]
        pos = start + len(src)
    res = "".join(out + lines[pos:])
    if not text.endswith("\n") and res.endswith("\n") and pos >= len(lines):
        res = res[:-1]
    return res


def _reverse_edit(after, inp):
    old, new = inp.get("old_string"), inp.get("new_string")
    if after is None or not isinstance(old, str) or not isinstance(new, str) or inp.get("replace_all") or after.count(new) != 1:
        return None
    return after.replace(new, old, 1)


def _forward(c, before):
    inp, sp = c["input"], (c["tur"] or {}).get("structuredPatch")
    if c["tool"] == "Write":
        return inp.get("content") if isinstance(inp.get("content"), str) else None
    if c["tool"] == "Edit":
        return _apply_patch(before, sp) or _apply_edit(before, inp.get("old_string"), inp.get("new_string"), inp.get("replace_all"))
    if c["tool"] == "MultiEdit":
        after = before
        for e in inp.get("edits") or []:
            after = _apply_edit(after, e.get("old_string"), e.get("new_string"), e.get("replace_all"))
        return _apply_patch(before, sp) or after
    return None


def _rebuild(changes):
    """Replay the successful changes in time order; then walk back from any later known state to fill the gaps."""
    ok = [c for c in changes if not (c["err"] or c["pending"])]
    for c in changes:
        c["before"] = c["after"] = None
        c["create"] = False
    state = None
    for c in ok:
        tur = c["tur"] or {}
        c["create"] = tur.get("type") == "create" or (not tur and c["tool"] == "Write" and "created successfully" in c["rtext"])
        before = "" if c["create"] else tur["originalFile"] if isinstance(tur.get("originalFile"), str) else state
        c["before"], c["after"] = before, _forward(c, before)
        state = c["after"]
    # backward pass: the content after change k is the content before change k+1
    for k in range(len(ok) - 2, -1, -1):
        c, nxt = ok[k], ok[k + 1]
        if c["after"] is None and nxt["before"] is not None:
            c["after"] = nxt["before"]
        if c["before"] is None and c["after"] is not None and c["tool"] in ("Edit", "MultiEdit"):
            c["before"] = _apply_patch(c["after"], (c["tur"] or {}).get("structuredPatch"), reverse=True) \
                or (_reverse_edit(c["after"], c["input"]) if c["tool"] == "Edit" else None)
    return changes


def load(sess, target, scope_files):
    key = (sess.project, sess.id, target, tuple(f for f, _a, _l in scope_files), sess.version)
    with _LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    changes = []
    for f, aid, label in scope_files:
        changes += _scan(f, target, aid, label)
    changes.sort(key=lambda c: c["t"] or "")
    _rebuild(changes)
    with _LOCK:
        _CACHE[key] = changes
        while len(_CACHE) > 4:
            _CACHE.popitem(last=False)
    return changes


# ---------- unified diff ----------
def hunks(a, b, ctx=3):
    al, bl = a.splitlines(keepends=True), b.splitlines(keepends=True)
    out = []
    for g in difflib.SequenceMatcher(None, al, bl, autojunk=False).get_grouped_opcodes(ctx):
        i1, i2, j1, j2 = g[0][1], g[-1][2], g[0][3], g[-1][4]
        lines = []
        for tag, a1, a2, b1, b2 in g:
            if tag == "equal":
                lines += [{"t": " ", "o": a1 + k + 1, "n": b1 + k + 1, "s": al[a1 + k]} for k in range(a2 - a1)]
                continue
            lines += [{"t": "-", "o": a1 + k + 1, "n": None, "s": al[a1 + k]} for k in range(a2 - a1)]
            lines += [{"t": "+", "o": None, "n": b1 + k + 1, "s": bl[b1 + k]} for k in range(b2 - b1)]
        ol, nl = i2 - i1, j2 - j1
        out.append({"header": f"@@ -{i1 + 1 if ol else i1},{ol} +{j1 + 1 if nl else j1},{nl} @@", "lines": lines})
    return out


def patch_text(rel, hs, create=False):
    head = [f"diff --git a/{rel} b/{rel}"]
    head += ["new file mode 100644", "--- /dev/null", f"+++ b/{rel}"] if create else [f"--- a/{rel}", f"+++ b/{rel}"]
    body = []
    for h in hs:
        body.append(h["header"])
        for ln in h["lines"]:
            s = ln["s"]
            body.append(ln["t"] + s.rstrip("\n"))
            if not s.endswith("\n"):
                body.append("\\ No newline at end of file")
    return "\n".join(head + body) + "\n"


def _strip(hs):
    for h in hs:
        for ln in h["lines"]:
            ln["s"] = ln["s"].rstrip("\n")
    return hs


def counts(c):
    p = (c["tur"] or {}).get("structuredPatch")
    if isinstance(p, list) and p:
        add = sum(1 for h in p for ln in h.get("lines", []) if ln.startswith("+"))
        dl = sum(1 for h in p for ln in h.get("lines", []) if ln.startswith("-"))
        return add, dl
    inp = c["input"]
    if c["tool"] == "Write":
        return len((inp.get("content") or "").splitlines()), len((c["before"] or "").splitlines())
    if c["tool"] == "Edit":
        return (inp.get("new_string") or "").count("\n") + 1, (inp.get("old_string") or "").count("\n") + 1
    return 0, 0


def summary(changes, rel, path):
    ok = [c for c in changes if not c["err"] and not c["pending"]]
    rows = []
    for i, c in enumerate(changes):
        if c["err"] or c["pending"]:
            continue
        add, dl = counts(c)
        rows.append({"i": i, "id": c["id"], "t": c["t"], "tool": c["tool"], "agent": c["agent"], "aid": c["aid"], "add": add, "del": dl,
                     "kind": "create" if c.get("create") else "write" if c["tool"] == "Write" else "edit",
                     "exact": c["before"] is not None and c["after"] is not None or bool((c["tur"] or {}).get("structuredPatch")), "desc": tp.describe_tool(c["tool"], {"file_path": rel})})
    _ok, j = segment(changes)
    return {"path": path, "rel": rel, "changes": rows, "failed": sum(1 for c in changes if c["err"]),
            "combined": j is not None, "combined_from": j}


def one(changes, i, rel):
    c = changes[i]
    inp = c["input"]
    if c["before"] is not None and c["after"] is not None:
        hs = hunks(c["before"], c["after"])
        pt = patch_text(rel, hs, c.get("create")) if hs else None
        return {"hunks": _strip(hs), "patch": pt, "create": bool(c.get("create")), "note": "" if hs else "No textual change."}
    sp = (c["tur"] or {}).get("structuredPatch")
    if isinstance(sp, list) and sp:   # the CLI recorded the hunks with real line numbers
        hs = []
        for h in sp:
            o, n, lines = int(h.get("oldStart", 0)), int(h.get("newStart", 0)), []
            for x in h.get("lines", []):
                if not x or x[0] not in " +-":
                    continue
                t = x[0]
                lines.append({"t": t, "o": o if t != "+" else None, "n": n if t != "-" else None, "s": x[1:] + "\n"})
                o += t != "+"
                n += t != "-"
            hs.append({"header": f"@@ -{h.get('oldStart')},{h.get('oldLines')} +{h.get('newStart')},{h.get('newLines')} @@", "lines": lines})
        pt = patch_text(rel, hs)
        return {"hunks": _strip(hs), "patch": pt, "create": False,
                "note": "Hunks as recorded by Claude Code; the full file before this change is not in the transcript."}
    if c["tool"] == "Edit":   # position unknown: diff the replaced fragment only
        hs = hunks(inp.get("old_string") or "", inp.get("new_string") or "")
        for h in hs:
            h["header"] = "@@ -?,? +?,? @@ position not recorded"
            for ln in h["lines"]:
                ln["o"] = ln["n"] = None
        return {"hunks": _strip(hs), "patch": None, "create": False,
                "note": "The file's previous content is not in the transcript: showing only the replaced text, without line numbers."}
    if c["tool"] == "Write":
        hs = hunks("", inp.get("content") or "")
        return {"hunks": _strip(hs), "patch": None, "create": False,
                "note": "Previous content not recorded: every line of the new content is shown as added."}
    return {"hunks": [], "patch": None, "create": False, "note": f"{c['tool']} changes can't be shown as a text diff."}


def segment(changes):
    """Start of the last continuous run of fully known changes (after_k == before_k+1), or None."""
    ok = [c for c in changes if not c["err"] and not c["pending"]]
    if not ok or ok[-1]["after"] is None:
        return ok, None
    j = len(ok) - 1
    while j > 0 and ok[j]["before"] is not None and ok[j - 1]["after"] is not None and ok[j - 1]["after"] == ok[j]["before"] \
            and ok[j - 1]["before"] is not None:
        j -= 1
    return ok, (j if ok[j]["before"] is not None else None)


def combined(changes, rel):
    ok, j = segment(changes)
    if j is None:
        return {"hunks": [], "patch": None, "create": False, "note": "The combined diff needs the content before the first change and after the last one."}
    hs = hunks(ok[j]["before"], ok[-1]["after"])
    create = bool(ok[j].get("create"))
    pt = patch_text(rel, hs, create) if hs else None
    note = "" if j == 0 else (f"Combined from change {j + 1} of {len(ok)} ({ok[j]['agent']}, {(ok[j]['t'] or '')[:16].replace('T', ' ')}): "
                              "before it, the file was replaced outside these transcripts, so earlier changes can't be chained.")
    return {"hunks": _strip(hs), "patch": pt, "create": create, "note": note or ("" if hs else "No net change."), "from": j}
