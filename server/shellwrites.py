"""Files a Bash command writes, guessed from its text (never run, never touched on disk).

Why: Write/Edit calls are exact, but Claude also changes files through the shell (redirects, tee, sed -i, cp/mv, touch,
python/node scripts). The transcript only has the command, so this is a heuristic: it favours the common shapes and
skips scratch locations. A file found this way is shown as "changed via shell" and has no diff (no before/after text).
"""
import os
import re
import shlex

SKIP_PREFIXES = ("/dev/", "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")
SKIP_SUFFIXES = (".log", ".pid", ".DS_Store", ".out", ".tmp")   # redirect targets of background runs, not deliverables
SEPARATORS = {";", "&&", "||", "|", "&", "(", ")", "|&"}
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][\w]*)\1")
# python: open('p','w'), open(var,'w'), Path('p').write_text(...)
PY_OPEN_LIT = re.compile(r"""open\(\s*(['"])(.+?)\1\s*,\s*(['"])[^'"]*[wax+][^'"]*\3""")
PY_OPEN_VAR = re.compile(r"""open\(\s*([A-Za-z_]\w*)\s*,\s*(['"])[^'"]*[wax+][^'"]*\2""")
PY_PATH_WRITE = re.compile(r"""Path\(\s*(['"])(.+?)\1\s*\)\s*\.\s*write_(?:text|bytes)""")
PY_ASSIGN = re.compile(r"""\b([A-Za-z_]\w*)\s*=\s*(['"])(.+?)\2""")
PATH_LITERAL = re.compile(r"""['"]((?:~|\.{0,2})/?[\w.@+-]+(?:/[\w.@+-]+)+\.[A-Za-z0-9]{1,8})['"]""")


def _split_heredocs(cmd):
    """(command text without heredoc bodies, [bodies]); newlines outside bodies become ';'."""
    shell, bodies, tag, cur = [], [], None, []
    for line in cmd.split("\n"):
        if tag is not None:
            if line.strip() == tag:
                bodies.append("\n".join(cur)); tag, cur = None, []
            else:
                cur.append(line)
            continue
        shell.append(line)
        m = HEREDOC.search(line)
        if m:
            tag = m.group(2)
    if tag is not None:
        bodies.append("\n".join(cur))
    return " ; ".join(shell), bodies


def _words(shell):
    # posix=False keeps the quotes on a word, so an operator is only an operator when it was not quoted
    lex = shlex.shlex(shell, posix=False, punctuation_chars=True)
    lex.commenters = ""
    return list(lex)


def _unq(w):
    return w[1:-1] if len(w) >= 2 and w[0] == w[-1] and w[0] in "'\"" else w


def _simple_commands(words):
    cur = []
    for w in words:
        if w in SEPARATORS:
            if cur:
                yield cur
            cur = []
        else:
            cur.append(w)
    if cur:
        yield cur


def _python_paths(text):
    out = [m.group(2) for m in PY_OPEN_LIT.finditer(text)] + [m.group(2) for m in PY_PATH_WRITE.finditer(text)]
    assigned = {}
    for m in PY_ASSIGN.finditer(text):
        assigned.setdefault(m.group(1), []).append(m.group(3))
    unresolved = False
    for m in PY_OPEN_VAR.finditer(text):
        vals = assigned.get(m.group(1))
        if vals:
            out += vals
        else:
            unresolved = True   # open(f, 'w') where f is a parameter: fall back to the path-looking literals
    if unresolved:
        out += [p for p in PATH_LITERAL.findall(text) if "://" not in p]
    return out


def _from_command(w):
    """Written paths of one simple command (list of words)."""
    out, args, i = [], [], 0
    while i < len(w):
        x = w[i]
        if x in (">", ">>", ">|") and i + 1 < len(w):     # output redirection: the next word is the file
            if not w[i + 1].startswith(("&", "(")):
                out.append(_unq(w[i + 1]))
            i += 2
            continue
        if re.fullmatch(r"[<>&|]+", x):                   # other operators (>&, <, <<, <<<...): skip with their target
            i += 2 if x in ("<", "<<", "<<<", "<<-", ">&") else 1
            continue
        if x.isdigit() and i + 1 < len(w) and re.fullmatch(r"[<>&]+", w[i + 1]):   # the fd in 2> or 2>&1
            i += 1
            continue
        args.append(_unq(x))
        i += 1
    while args and (re.fullmatch(r"[A-Za-z_]\w*=.*", args[0]) or args[0] in ("sudo", "rtk", "proxy", "command", "time", "env")):
        args = args[1:]
    if not args:
        return out
    cmd, rest = os.path.basename(args[0]), args[1:]
    flags_free = [a for a in rest if a and not a.startswith("-")]
    if cmd == "tee":
        out += flags_free
    elif cmd == "touch":
        out += flags_free
    elif cmd in ("cp", "mv", "install") and len(flags_free) >= 2:
        dest = flags_free[-1]
        if not dest.endswith("/") and "." in os.path.basename(dest):   # a dest without an extension is most often a directory
            out.append(dest)
    elif cmd == "sed" and any(a == "--in-place" or re.fullmatch(r"-[A-Za-z]*i[A-Za-z]*", a) or a.startswith("-i") for a in rest):
        files = flags_free[1:] if not any(a in ("-e", "-f") for a in rest) else flags_free
        out += files
    elif cmd == "perl" and any(re.fullmatch(r"-[A-Za-z]*i[A-Za-z]*", a) for a in rest):
        out += flags_free[1:] if not any(a == "-e" for a in rest) else flags_free
    return out


def shell_writes(cmd, cwd=""):
    """Absolute paths the command probably writes. Order kept, duplicates and scratch locations dropped."""
    if not isinstance(cmd, str) or not cmd.strip():
        return []
    shell, bodies = _split_heredocs(cmd)
    found = []
    try:
        for w in _simple_commands(_words(shell)):
            found += _from_command(w)
    except ValueError:   # unbalanced quotes: the command is too odd to read
        pass
    for text in [shell] + bodies:
        if "open(" in text or "write_text" in text or "write_bytes" in text:
            found += _python_paths(text)
    out, seen = [], set()
    for p in found:
        if not p or any(c in p for c in "$`*?{}|<>!") or len(p) > 400:
            continue
        p = os.path.expanduser(p)
        p = os.path.abspath(p if os.path.isabs(p) else os.path.join(cwd or "", p))
        if p in seen or p.startswith(SKIP_PREFIXES) or not os.path.basename(p) or p.endswith(SKIP_SUFFIXES):
            continue
        seen.add(p)
        out.append(p)
    return out
