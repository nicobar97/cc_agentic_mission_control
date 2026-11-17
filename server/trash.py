"""Write mode: move a chat to the macOS Trash, and put it back (Undo / Restore). Never deletes anything.

What moves, and only this:
  ~/.claude/projects/<slug>/<sid>.jsonl   (the transcript)
  ~/.claude/projects/<slug>/<sid>/        (subagents, workflows, tool-results), if it exists
to ~/.Trash/Mission Control/<slug>/<sid>[-YYYYmmdd-HHMMSS]/ with the same names inside. Nothing else under ~/.claude
(file-history, todos, settings, memory) is touched. os.rename, or shutil.move across devices. No unlink, no rmdir:
an entry emptied by a restore stays as an empty folder in the Trash and is skipped by the list.

Guards (on top of the POST /api/write/* token + Origin + Host checks in server.py), in this order:
shape (UUID session id, slug pattern) -> containment (slug is a real directory directly under the projects root, real
paths stay inside it) -> symlinks (transcript or session dir being a symlink is refused) -> liveness (changed in the
last 5 min, the "Active now" rule, or a Mission Control run on it). Logs carry only the session id, slug and result.
"""
import errno
import os
import re
import shutil
import time

import store as st

TRASH_ROOT = os.path.abspath(os.path.expanduser(os.environ.get("MC_TRASH") or "~/.Trash/Mission Control"))
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
ENTRY_RE = re.compile(r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(-\d{8}-\d{6}(-\d{1,3})?)?$")
SLUG_RE = re.compile(r"^-[A-Za-z0-9-]{1,250}$")


class Refused(Exception):
    def __init__(self, code, msg, why="refused"):
        super().__init__(msg)
        self.code, self.msg, self.why = code, msg, why


def log(event, sid, slug, result):
    print(f"write: event={event} session={sid if UUID_RE.match(str(sid or '')) else '?'} "
          f"slug={slug if SLUG_RE.match(str(slug or '')) else '?'} result={result}", flush=True)


def _inside(path, root):
    rp = os.path.realpath(path)
    return rp == root or rp.startswith(root + os.sep)


def check_ids(slug, sid):
    if not isinstance(sid, str) or not UUID_RE.match(sid):
        raise Refused(400, "That is not a chat id (a UUID is expected).", "bad-id")
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        raise Refused(400, "That is not a project folder name.", "bad-slug")


def project_dir(slug):
    """ROOT/<slug>: listed directly under the projects root, a real directory, not a symlink."""
    root = st.ROOT
    try:
        names = os.listdir(root)
    except OSError:
        names = []
    pdir = os.path.join(root, slug)
    if slug not in names or os.path.islink(pdir) or not os.path.isdir(pdir) \
            or os.path.dirname(os.path.realpath(pdir)) != root or os.path.realpath(pdir) != pdir:
        raise Refused(404, "Unknown project folder.", "bad-project")
    return pdir


def chat_paths(slug, sid):
    """The transcript and the session dir of one chat, after every path guard. The dir may not exist."""
    check_ids(slug, sid)
    pdir = project_dir(slug)
    tp, sd = os.path.join(pdir, sid + ".jsonl"), os.path.join(pdir, sid)
    if os.path.islink(tp) or os.path.islink(sd):
        raise Refused(400, "This chat's transcript or folder is a symlink, so Mission Control will not move it.", "symlink")
    if not os.path.isfile(tp):
        raise Refused(404, "Unknown chat (no transcript on disk).", "missing")
    if os.path.dirname(os.path.realpath(tp)) != pdir or (os.path.lexists(sd) and os.path.realpath(sd) != sd):
        raise Refused(400, "This chat's files resolve outside its project folder.", "outside")
    if os.path.lexists(sd) and not os.path.isdir(sd):
        raise Refused(400, "This chat's folder is not a directory.", "not-dir")
    return pdir, tp, sd


def walk_stats(tp, sd):
    """(bytes, files, newest mtime) over the transcript and the session dir, never following symlinks."""
    s = os.lstat(tp)
    size, files, newest = s.st_size, 1, s.st_mtime
    if os.path.isdir(sd) and not os.path.islink(sd):
        newest = max(newest, os.lstat(sd).st_mtime)
        for dp, dns, fns in os.walk(sd, followlinks=False):
            for n in fns + [d for d in dns if os.path.islink(os.path.join(dp, d))]:
                try:
                    x = os.lstat(os.path.join(dp, n))
                except OSError:
                    continue
                size, files, newest = size + x.st_size, files + 1, max(newest, x.st_mtime)
    return size, files, newest


def _move(src, dst):
    if os.path.lexists(dst):
        raise OSError(errno.EEXIST, "destination exists")
    try:
        os.rename(src, dst)
    except OSError as e:
        if e.errno != errno.EXDEV:
            raise
        shutil.move(src, dst)   # another volume: copy then remove the source (symlinks kept as links)


class Trash:
    def __init__(self, store, runner, transcripts, publish):
        self.store, self.runner, self.transcripts, self.publish = store, runner, transcripts, publish

    # ---------- the checks a move needs (also the dialog's dry run) ----------
    def _facts(self, slug, sid):
        """Caller holds store.lock. Returns (sess, tp, sd, facts, refusal or None)."""
        _pdir, tp, sd = chat_paths(slug, sid)
        sess = self.store.projects.get(slug, {}).get(sid)
        if not sess:
            raise Refused(404, "Unknown chat (not indexed yet).", "missing")
        # liveness from a fresh lstat of every file (not sess.refresh(): that would swallow the watcher's change event)
        size, files, newest = walk_stats(tp, sd)
        last = max(sess.mtime, newest)
        i = sess.info
        facts = {"p": slug, "s": sid, "title": i.title(), "path": self.store.project_path(slug, self.store.projects.get(slug, {})),
                 "cwd": i.cwd, "mtime": last, "last": i.last_ts, "msgs": i.prompts + len(i.msg_ids),
                 "agents": len(sess.agents), "workflows": len(sess.journals), "size": size, "files": files,
                 "has_dir": os.path.isdir(sd)}
        refusal = None
        idle = time.time() - last
        if any(r.session_id == sid or r.target == sid for r in self.runner.active()):
            refusal = Refused(409, "Mission Control is running a message in this chat (or forking it). Wait for it to "
                                   "finish, or stop it, then try again.", "busy")
        elif idle < st.ACTIVE_SECS:
            refusal = Refused(409, f"This chat is active: it or one of its agents changed {round(idle)}s ago (the "
                                   f"“Active now” rule is 5 min). Wait until it has been quiet for 5 minutes.", "active")
        return sess, tp, sd, facts, refusal

    def preview(self, slug, sid):
        with self.store.lock:
            _s, _tp, _sd, facts, refusal = self._facts(slug, sid)
        if refusal:
            facts["refused"] = refusal.msg
        return facts

    def _dest(self, slug, sid):
        base = os.path.join(TRASH_ROOT, slug)
        os.makedirs(base, exist_ok=True)
        if not _inside(base, os.path.realpath(TRASH_ROOT)) or os.path.islink(base):
            raise Refused(500, "The Trash folder for this project is not a plain folder.", "trash-path")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        for name in [sid, f"{sid}-{stamp}"] + [f"{sid}-{stamp}-{n}" for n in range(2, 100)]:
            d = os.path.join(base, name)
            try:
                os.mkdir(d)    # exclusive: a name collision moves on to the next suffix
                return name, d
            except FileExistsError:
                continue
        raise Refused(500, "Could not pick a free name in the Trash.", "trash-path")

    # ---------- move to the Trash ----------
    def trash(self, slug, sid):
        try:
            with self.store.lock:
                sess, tp, sd, facts, refusal = self._facts(slug, sid)
                if refusal:
                    raise refusal
                entry, dest = self._dest(slug, sid)
                paths = [sess.path] + [a.path for a in sess.agents.values()]
                _move(tp, os.path.join(dest, sid + ".jsonl"))
                if os.path.isdir(sd):
                    try:
                        _move(sd, os.path.join(dest, sid))
                    except OSError:
                        _move(os.path.join(dest, sid + ".jsonl"), tp)   # roll back: the chat stays whole
                        raise Refused(500, "Could not move the chat's folder, so nothing was moved.", "move-failed")
                # forget it everywhere: index, run cache, parsed transcripts (main + agents)
                self.store.projects.get(slug, {}).pop(sid, None)
                self.store._runs_cache.pop((slug, sid), None)
                self.transcripts.drop(paths, prefix=sd + os.sep)
                changed = self.store.scan()
                self.store.version += 1
                self.store.changed_at = time.time()
        except Refused as e:
            log("trash", sid, slug, "refused-" + e.why)
            raise
        except OSError as e:
            log("trash", sid, slug, "error-" + (errno.errorcode.get(e.errno, "os")))
            raise Refused(500, "The move failed (" + (os.strerror(e.errno) if e.errno else "OS error") + ").", "os")
        log("trash", sid, slug, "ok")
        self.publish(list(changed) + [(slug, sid)])
        return {"ok": True, "p": slug, "s": sid, "entry": entry, "size": facts["size"], "files": facts["files"],
                "title": facts["title"]}

    # ---------- put back ----------
    def _entry(self, slug, entry):
        if not isinstance(entry, str) or not ENTRY_RE.match(entry):
            raise Refused(400, "That is not a Trash entry.", "bad-entry")
        sid = ENTRY_RE.match(entry).group(1)
        check_ids(slug, sid)
        troot = os.path.realpath(TRASH_ROOT)
        base, edir = os.path.join(TRASH_ROOT, slug), os.path.join(TRASH_ROOT, slug, entry)
        if os.path.islink(base) or os.path.islink(edir) or not os.path.isdir(edir) \
                or os.path.realpath(edir) != os.path.join(troot, slug, entry):
            raise Refused(404, "That chat is not in Mission Control's Trash folder any more.", "not-in-trash")
        ttp, tsd = os.path.join(edir, sid + ".jsonl"), os.path.join(edir, sid)
        if os.path.islink(ttp) or os.path.islink(tsd):
            raise Refused(400, "The trashed files are symlinks, so Mission Control will not move them.", "symlink")
        if not os.path.isfile(ttp):
            raise Refused(404, "That Trash entry has no transcript (already restored?).", "not-in-trash")
        return sid, ttp, tsd

    def restore(self, slug, entry):
        sid = ENTRY_RE.match(entry).group(1) if isinstance(entry, str) and ENTRY_RE.match(entry) else None
        try:
            with self.store.lock:
                sid, ttp, tsd = self._entry(slug, entry)
                pdir = project_dir(slug)
                tp, sd = os.path.join(pdir, sid + ".jsonl"), os.path.join(pdir, sid)
                if os.path.lexists(tp) or os.path.lexists(sd):
                    raise Refused(409, "Something already exists at this chat's original place, so nothing was "
                                       "overwritten. The chat stays in the Trash.", "exists")
                if os.path.isdir(tsd):   # the folder first: the store sees a whole chat when the transcript appears
                    _move(tsd, sd)
                try:
                    _move(ttp, tp)
                except OSError:
                    if os.path.isdir(sd) and not os.path.lexists(tsd):
                        _move(sd, tsd)
                    raise
                changed = self.store.scan()
        except Refused as e:
            log("restore", sid, slug, "refused-" + e.why)
            raise
        except OSError as e:
            log("restore", sid, slug, "error-" + (errno.errorcode.get(e.errno, "os")))
            raise Refused(500, "The move back failed (" + (os.strerror(e.errno) if e.errno else "OS error") + ").", "os")
        log("restore", sid, slug, "ok")
        self.publish(list(changed) + [(slug, sid)])
        return {"ok": True, "p": slug, "s": sid}

    # ---------- what Mission Control has put in the Trash ----------
    _titles = {}

    def _title(self, ttp):
        try:
            x = os.stat(ttp)
        except OSError:
            return {}
        key = (ttp, x.st_size, x.st_mtime_ns)
        if key not in self._titles:
            info = st.MainInfo()
            try:
                with open(ttp, "rb") as f:
                    for raw in f:
                        d = st.parse_line(raw.rstrip(b"\n"))
                        if d:
                            info.feed(d)
            except OSError:
                pass
            self._titles[key] = {"title": info.title(), "cwd": info.first_cwd or info.cwd, "last": info.last_ts,
                                 "msgs": info.prompts + len(info.msg_ids)}
        return self._titles[key]

    def listing(self, limit=50):
        out = []
        troot = os.path.realpath(TRASH_ROOT) if os.path.isdir(TRASH_ROOT) else None
        if not troot:
            return out
        for slug in sorted(os.listdir(troot)):
            base = os.path.join(troot, slug)
            if not SLUG_RE.match(slug) or os.path.islink(base) or not os.path.isdir(base):
                continue
            for entry in os.listdir(base):
                m = ENTRY_RE.match(entry)
                edir = os.path.join(base, entry)
                if not m or os.path.islink(edir) or not os.path.isdir(edir):
                    continue
                ttp = os.path.join(edir, m.group(1) + ".jsonl")
                if os.path.islink(ttp) or not os.path.isfile(ttp):
                    continue   # emptied by a restore
                try:
                    size, _files, _n = walk_stats(ttp, os.path.join(edir, m.group(1)))
                    at = os.lstat(edir).st_mtime
                except OSError:
                    continue
                out.append({"p": slug, "s": m.group(1), "entry": entry, "trashed_at": at, "size": size,
                            "restorable": not os.path.lexists(os.path.join(st.ROOT, slug, m.group(1) + ".jsonl")),
                            **self._title(ttp)})
        out.sort(key=lambda r: -r["trashed_at"])
        return out[:limit]

    def state(self, slug, sid):
        """Read side, for a tab that still shows a chat: was it moved to the Trash by Mission Control?"""
        try:
            check_ids(slug, sid)
        except Refused:
            return {"trashed": False}
        base = os.path.join(TRASH_ROOT, slug)
        if os.path.islink(base) or not os.path.isdir(base):
            return {"trashed": False}
        best = None
        for entry in os.listdir(base):
            m = ENTRY_RE.match(entry)
            if m and m.group(1).lower() == sid.lower():
                ttp = os.path.join(base, entry, m.group(1) + ".jsonl")
                if os.path.isfile(ttp) and not os.path.islink(ttp):
                    at = os.lstat(os.path.join(base, entry)).st_mtime
                    if not best or at > best[1]:
                        best = (entry, at)
        return {"trashed": bool(best), "entry": best[0] if best else None, "trashed_at": best[1] if best else None}
