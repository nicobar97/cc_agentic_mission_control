// Git-style diff of one file, rebuilt from the transcripts (server/diffs.py). Opened from a deliverable or a Write/Edit call.
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, fmtDate, hhmmss } from "../lib";
import { Info } from "./bits";

type Req = { p: string; s: string; path: string; run?: string; id?: string } | null;
type Line = { t: " " | "+" | "-"; o: number | null; n: number | null; s: string };
type Hunk = { header: string; lines: Line[] };
type Change = { i: number; id: string; t: string; tool: string; agent: string; aid: string | null; add: number; del: number; kind: string; exact: boolean };
type Resp = { path: string; rel: string; changes: Change[]; failed: number; combined: boolean; combined_from: number | null;
  diff?: { hunks: Hunk[]; patch: string | null; create: boolean; note: string } };

let req: Req = null;
const subs = new Set<() => void>();
export const openDiff = (r: Req) => { req = r; subs.forEach((f) => f()); };
const useReq = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => req);

const BIG = 80;   // hunks longer than this start collapsed

export function DiffHost() {
  const r = useReq();
  return r ? <DiffPanel key={r.p + r.s + r.path + (r.run || "")} r={r} /> : null;
}

function DiffPanel({ r }: { r: NonNullable<Req> }) {
  const [sum, setSum] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"one" | "all">("one");
  const [sel, setSel] = useState<number | null>(null);
  const [view, setView] = useState<"unified" | "split">("unified");
  const [diff, setDiff] = useState<Resp["diff"] | null>(null);
  const [copied, setCopied] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => openDiff(null);

  useEffect(() => {
    api<Resp>("/api/diff", { p: r.p, s: r.s, path: r.path, run: r.run }).then((x) => {
      setSum(x);
      const pick = r.id ? x.changes.findIndex((c) => c.id === r.id) : -1;
      setSel(pick >= 0 ? pick : x.changes.length - 1);
    }).catch((e) => setErr(String(e.message || e)));
  }, []);
  const cur = sum && sel != null ? sum.changes[sel] : null;
  useEffect(() => {
    if (!sum || (mode === "one" && !cur)) return;
    setDiff(null);
    api<Resp>("/api/diff", { p: r.p, s: r.s, path: r.path, run: r.run, ...(mode === "all" ? { combined: 1 } : { change: cur!.i }) })
      .then((x) => setDiff(x.diff || null)).catch((e) => setErr(String(e.message || e)));
  }, [sum, sel, mode]);
  useEffect(() => { listRef.current?.querySelector(".dc.sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      else if ((e.key === "j" || e.key === "k") && sum?.changes.length) {
        setMode("one");
        setSel((x) => Math.max(0, Math.min(sum.changes.length - 1, (x ?? 0) + (e.key === "j" ? 1 : -1))));
      }
    };
    addEventListener("keydown", k, true); return () => removeEventListener("keydown", k, true);
  }, [sum]);

  const copy = async () => {
    if (!diff?.patch) return;
    try { await navigator.clipboard.writeText(diff.patch); }
    catch { const t = document.createElement("textarea"); t.value = diff.patch; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
    setCopied("Copied"); setTimeout(() => setCopied(""), 1400);
  };
  const tot = sum ? sum.changes.reduce((a, c) => [a[0] + c.add, a[1] + c.del], [0, 0]) : [0, 0];
  const rel = sum?.rel || r.path;
  return <>
    <div className="scrim open dscrim" onClick={close} />
    <aside className="diffpanel" role="dialog" aria-label={`Diff of ${rel}`}>
      <div className="dp-h">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">Diff · {r.run ? `run ${r.run}` : "whole chat"}</div>
          <div className="dp-path" title={sum?.path || r.path}>📄 {rel}</div>
          <div className="sub">{sum ? `${sum.changes.length} change${sum.changes.length === 1 ? "" : "s"} · ` : ""}<span className="d-add">+{tot[0]}</span> <span className="d-del">−{tot[1]}</span>{sum?.failed ? ` · ${sum.failed} failed call${sum.failed > 1 ? "s" : ""} skipped` : ""}</div>
        </div>
        <div className="tools">
          <div className="seg"><button className={mode === "one" ? "on" : ""} onClick={() => setMode("one")}>This change</button>
            <button className={mode === "all" ? "on" : ""} disabled={!sum?.combined} title={sum?.combined ? "" : "Not available: the content before the first change is not recorded"} onClick={() => setMode("all")}>All changes combined</button></div>
          <div className="seg"><button className={view === "unified" ? "on" : ""} onClick={() => setView("unified")}>Unified</button><button className={view === "split" ? "on" : ""} onClick={() => setView("split")}>Split</button></div>
          <button className="btn" disabled={!diff?.patch} title={diff?.patch ? "Copy a unified diff that git apply accepts" : "No valid patch for this change (its position in the file is unknown)"} onClick={copy}>{copied || "⧉ Copy patch"}</button>
          <Info right label="Legend: diff">
            <span className="li">Rebuilt from the Write / Edit calls in the transcripts: the file on disk is never read</span>
            <span className="li"><span className="sw" style={{ background: "var(--d-add-bg)", border: "1px solid var(--d-add)" }} /><b>+</b> added line · <span className="sw" style={{ background: "var(--d-del-bg)", border: "1px solid var(--d-del)" }} /><b>−</b> removed line · context dimmed</span>
            <span className="li">Gutters: old line number · new line number</span>
            <span className="li"><b>All changes combined</b> = the file before the first change vs after the last one (from the last unbroken stretch of history)</span>
            <span className="li">Keys: <kbd>j</kbd> / <kbd>k</kbd> next / previous change · <kbd>esc</kbd> close</span>
          </Info>
          <button className="btn" onClick={close} title="Close (esc)">✕</button>
        </div>
      </div>
      <div className="dp-b">
        <div className="dp-list" ref={listRef}>
          {!sum && !err && Array.from({ length: 6 }, (_, i) => <div key={i} className="skel" style={{ height: 46, margin: "6px 8px" }} />)}
          {sum && !sum.changes.length && <div className="empty" style={{ margin: 8 }}>No Write / Edit change recorded for this file.<br /><span className="sub">If a shell command changed it (a redirect, <code>sed -i</code>, a script), the transcript keeps the command but not the before / after text, so there is no diff.</span></div>}
          {sum?.changes.map((c, k) => <button key={c.i} className={"dc" + (mode === "one" && k === sel ? " sel" : "")} onClick={() => { setMode("one"); setSel(k); }}>
            <span className="dc-t"><b>{c.tool}</b><span className="ts">{fmtDate(c.t)}</span></span>
            <span className="dc-a">{c.agent}</span>
            <span className="dc-n"><span className="d-add">+{c.add}</span> <span className="d-del">−{c.del}</span>{c.kind === "create" ? <span className="mdl">new</span> : null}</span>
          </button>)}
        </div>
        <div className="dp-main">
          {err && <div className="empty">Could not load the diff: {err}</div>}
          {mode === "one" && cur && <div className="dp-meta"><b>{cur.agent}</b> · {cur.tool} · {fmtDate(cur.t)} · change {(sel ?? 0) + 1} of {sum!.changes.length}</div>}
          {diff?.note && <div className="cnote">{diff.note}</div>}
          {!diff && !err && <div className="skel" style={{ height: 320 }} />}
          {diff && <Patch rel={rel} d={diff} view={view} />}
        </div>
      </div>
    </aside>
  </>;
}

function Patch({ rel, d, view }: { rel: string; d: NonNullable<Resp["diff"]>; view: "unified" | "split" }) {
  if (!d.hunks.length) return null;
  return <div className={"patch " + view}>
    <div className="pl meta">diff --git a/{rel} b/{rel}</div>
    {d.create && <div className="pl meta">new file mode 100644</div>}
    <div className="pl meta">--- {d.create ? "/dev/null" : `a/${rel}`}</div>
    <div className="pl meta">+++ b/{rel}</div>
    {d.hunks.map((h, i) => <HunkView key={i} h={h} view={view} />)}
  </div>;
}

function HunkView({ h, view }: { h: Hunk; view: "unified" | "split" }) {
  const [open, setOpen] = useState(h.lines.length <= BIG);
  const shown = open ? h.lines : [...h.lines.slice(0, 24), null, ...h.lines.slice(-8)];
  const rows = useMemo(() => (view === "split" ? pair(shown) : null), [view, open, h]);
  return <>
    <div className="pl hunk">{h.header}</div>
    {view === "unified" ? shown.map((l, i) => l ? <div key={i} className={"pl " + cls(l.t)}><span className="g">{l.o ?? ""}</span><span className="g">{l.n ?? ""}</span><span className="sg">{l.t === " " ? " " : l.t === "+" ? "+" : "−"}</span><span className="tx">{l.s || " "}</span></div>
      : <button key={i} className="pl expand" onClick={() => setOpen(true)}>⋯ Expand {h.lines.length - 32} hidden lines</button>)
      : rows!.map((rw, i) => rw === null ? <button key={i} className="pl expand" onClick={() => setOpen(true)}>⋯ Expand {h.lines.length - 32} hidden lines</button>
        : <div key={i} className="pl srow">
          <Fragment>{side(rw[0])}{side(rw[1])}</Fragment></div>)}
  </>;
}

const cls = (t: string) => (t === "+" ? "add" : t === "-" ? "del" : "ctx");
const side = (l: Line | null) => l ? <span className={"half " + cls(l.t)}><span className="g">{l.t === "+" ? l.n : l.o}</span><span className="sg">{l.t === " " ? " " : l.t === "+" ? "+" : "−"}</span><span className="tx">{l.s || " "}</span></span>
  : <span className="half none" />;
function pair(lines: (Line | null)[]): ([Line | null, Line | null] | null)[] {
  const out: ([Line | null, Line | null] | null)[] = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l === null) { out.push(null); i++; continue; }
    if (l.t === " ") { out.push([l, l]); i++; continue; }
    const dels: Line[] = [], adds: Line[] = [];
    while (i < lines.length && lines[i] && lines[i]!.t === "-") dels.push(lines[i++]!);
    while (i < lines.length && lines[i] && lines[i]!.t === "+") adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push([dels[k] || null, adds[k] || null]);
  }
  return out;
}
