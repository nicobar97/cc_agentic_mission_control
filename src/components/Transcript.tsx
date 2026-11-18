// Read-only conversation view: paginated from the end, live-appended over SSE, scroll position preserved.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, Entry, fmtTok, fmtUsd, go, Head, hhmmss, Page, shortModel, STATIC, useChangeRev } from "../lib";
import { Fold, Info, Markdown } from "./bits";
import { openDiff } from "./Diff";
import { findSeq, Outline, reducedMotion, SeekOpt, visibleSeqs } from "./Outline";

type Props = { p: string; s: string; a?: string; onHead?: (h: Head) => void };
type St = { entries: Entry[]; start: number; total: number; epoch: number };
const PAGE = 150;

export function Transcript({ p, s, a, onHead }: Props) {
  const rev = useChangeRev(p, s);
  const [st, setSt] = useState<St | null>(null);
  const [head, setHead] = useState<Head | null>(null);
  const [full, setFull] = useState<Record<number, Entry>>({});
  const [err, setErr] = useState("");
  const [newCount, setNewCount] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const pend = useRef<{ kind: "bottom" } | { kind: "seek" } | { kind: "prepend"; h: number; top: number } | null>(null);
  const busy = useRef(false), loadingOlder = useRef(false);
  const stRef = useRef(st);
  useEffect(() => { stRef.current = st; }, [st]);
  const key = `${p}/${s}/${a || ""}`;

  // first page: the last PAGE entries, scrolled to the bottom
  useEffect(() => {
    let dead = false;
    setSt(null); setFull({}); setErr(""); setNewCount(0);
    api<Page>("/api/transcript", { p, s, a, limit: PAGE }).then((r) => {
      if (dead) return;
      pend.current = { kind: "bottom" };
      setSt({ entries: r.entries, start: r.start, total: r.total, epoch: r.epoch });
      if (r.head) { setHead(r.head); onHead?.(r.head); }
    }).catch(async (e) => {
      if (dead) return;
      // an agent route that names the wrong chat (the chat was resumed under a new id): ask the resolver and follow it
      if (a && /404/.test(String(e.message))) {
        try {
          const loc = await api<{ a: string; p?: string; s?: string; missing?: string }>("/api/agent-resolve", { p, s, agent: a });
          if (!dead && loc.p && loc.s && (loc.p !== p || loc.s !== s)) { go({ p: loc.p, s: loc.s, a }, true); return; }
        } catch (_) {}
      }
      if (!dead) setErr(String(e.message || e));
    });
    return () => { dead = true; };
  }, [key]);

  // live: fetch only what was appended since our last entry. A change that lands while a fetch is in flight
  // marks the view dirty and re-runs afterwards; the cursor advances by what was received, never past a gap.
  const dirty = useRef(false);
  const catchUp = useCallback(async () => {
    if (busy.current) { dirty.current = true; return; }
    busy.current = true;
    try {
      do {
        dirty.current = false;
        for (let guard = 0; guard < 50; guard++) {
          const cur = stRef.current;
          if (!cur) break;
          const r = await api<Page>("/api/transcript", { p, s, a, after: cur.total, head: 1 });
          if (r.epoch !== cur.epoch) {   // the file was rewritten: start over
            const x = await api<Page>("/api/transcript", { p, s, a, limit: PAGE });
            pend.current = { kind: "bottom" };
            setSt({ entries: x.entries, start: x.start, total: x.total, epoch: x.epoch });
            stRef.current = { entries: x.entries, start: x.start, total: x.total, epoch: x.epoch };
            break;
          }
          if (r.head) { setHead(r.head); onHead?.(r.head); }
          const add = r.entries.filter((e) => e.seq >= cur.total);
          if (!add.length) break;
          const el = box.current;
          const atBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 120 : true;
          if (atBottom) pend.current = { kind: "bottom" }; else setNewCount((n) => n + add.length);
          const next = { ...cur, entries: [...cur.entries, ...add], total: add[add.length - 1].seq + 1 };
          stRef.current = next;
          setSt((o) => o && { ...o, entries: [...o.entries, ...add], total: next.total });
          if (next.total >= r.total) break;   // caught up; otherwise fetch the next slice
        }
      } while (dirty.current);
    } catch (_) { /* the next change event retries */ } finally { busy.current = false; }
  }, [p, s, a]);
  useEffect(() => { if (rev) catchUp(); }, [rev, catchUp]);

  const older = useCallback(() => {
    const cur = stRef.current, el = box.current;
    if (!cur || cur.start === 0 || loadingOlder.current || !el) return;
    loadingOlder.current = true;
    api<Page>("/api/transcript", { p, s, a, before: cur.start, limit: PAGE }).then((r) => {
      pend.current = { kind: "prepend", h: el.scrollHeight, top: el.scrollTop };
      setSt((o) => { const n = o && { ...o, entries: [...r.entries.filter((e) => e.seq < o.start), ...o.entries], start: r.start }; stRef.current = n; return n; });
    }).catch(() => {}).finally(() => { loadingOlder.current = false; });
  }, [p, s, a]);

  // apply the scroll intent after the DOM has the new rows (prepend keeps the reading position)
  useLayoutEffect(() => {
    const el = box.current, pd = pend.current;
    if (!el || !pd) return;
    pend.current = null;
    if (pd.kind === "bottom") el.scrollTop = el.scrollHeight;
    else if (pd.kind === "seek") { const k = seekTo.current; if (k) scrollToSeq(k.seq, false, k.hl, k.off); }
    else {
      el.scrollTop = pd.top + (el.scrollHeight - pd.h);
      // an auto-loaded older page cancels a smooth scroll the outline started: land on its target anyway, and keep
      // loading when the target is older still (a lens drag that went past this page while it loaded)
      const k = seekTo.current;
      if (k && performance.now() - k.at < 1500) {
        scrollToSeq(k.seq, false, false, k.off);
        if (stRef.current && k.seq < stRef.current.start) seek(k.seq, false, { hl: k.hl, off: k.off });
      }
    }
  }, [st]);

  // ---------- outline strip: scroll to any entry of the chat, loading older pages first when it isn't loaded yet ----------
  const [seeking, setSeeking] = useState(false);
  const seekTo = useRef<{ seq: number; at: number; hl: boolean; off: number } | null>(null);
  // `off`: where the entry's top lands, in px below the viewport top (a dragged lens restores an exact offset)
  const scrollToSeq = useCallback((seq: number, smooth: boolean, hl = true, off = 12) => {
    const el = box.current; if (!el) return;
    const n = findSeq(el, seq); if (!n) return;
    const top = n.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - off;
    el.scrollTo({ top, behavior: smooth && !reducedMotion() && !STATIC ? "smooth" : "auto" });
    if (hl) { n.classList.remove("o-hl"); void n.offsetWidth; n.classList.add("o-hl"); window.setTimeout(() => n.classList.remove("o-hl"), 1400); }
    if (!smooth) { const v = visibleSeqs(el); document.body.dataset.outlineLanded = String(seq); document.body.dataset.outlineTop = v ? String(v[0]) : ""; }
  }, []);
  const seek = useCallback(async (seq: number, smooth: boolean, o: SeekOpt = {}) => {
    const cur = stRef.current; if (!cur) return;
    const hl = o.hl ?? true, off = o.off ?? 12;
    seekTo.current = { seq, at: performance.now(), hl, off };
    if (seq >= cur.start) { scrollToSeq(seq, smooth, hl, off); return; }
    if (loadingOlder.current) return;   // the load in flight scrolls to the latest target when it lands
    loadingOlder.current = true; setSeeking(true);
    try {
      let start = cur.start, acc: Entry[] = [];
      while (seekTo.current && seekTo.current.seq < start && start > 0) {
        const r = await api<Page>("/api/transcript", { p, s, a, before: start, limit: 500 });
        if (r.epoch !== cur.epoch) return;
        acc = [...r.entries.filter((e) => e.seq < start), ...acc]; start = r.start;
      }
      if (acc.length) {
        pend.current = { kind: "seek" };
        setSt((o) => { const n = o && { ...o, entries: [...acc.filter((e) => e.seq < o.start), ...o.entries], start: Math.min(start, o.start) }; stRef.current = n; return n; });
      }
    } catch (_) {} finally { loadingOlder.current = false; setSeeking(false); }
  }, [p, s, a, scrollToSeq]);

  const onScroll = () => {
    const el = box.current; if (!el) return;
    if (el.scrollTop < 300) older();
    if (newCount && el.scrollHeight - el.scrollTop - el.clientHeight < 120) setNewCount(0);
  };

  const loadFull = useCallback((seq: number) => {
    api<Entry>("/api/full", { p, s, a, seq }).then((e) => setFull((f) => ({ ...f, [seq]: e }))).catch(() => {});
  }, [p, s, a]);

  const items = useMemo(() => (st ? group(st.entries) : null), [st]);
  if (err) return <div className="scroll"><div className="convo"><div className="empty">{a && /404/.test(err)
    ? <>This agent's chat isn't available: there is no transcript for agent <code>{a}</code> in this chat. Claude Code removes transcripts after <code>cleanupPeriodDays</code> (30 days by default), or it was never written.</>
    : <>Could not load this chat: {err}</>}</div></div></div>;
  if (!st || !items) return <div className="scroll" aria-label="Loading chat"><div className="convo">{[70, 45, 90, 60, 80].map((w, i) => <div key={i} className="msg" style={i % 2 ? { display: "flex", justifyContent: "flex-end" } : undefined}>
    <div style={{ width: `${w}%` }}><div className="skel skel-line" style={{ width: 90, height: 10 }} /><div className="skel" style={{ height: i % 2 ? 44 : 88, borderRadius: 12 }} /></div></div>)}</div></div>;
  const ctx: Ctx = { p, s, a, head, full, loadFull, results: items.results, isAgent: !!a };
  let lastDay = "";
  return (
    <div className="convo-row">
    <div className="scroll" ref={box} onScroll={onScroll}>
      <div className="convo">
        <div className="older">{st.start > 0
          ? <button className="btn" onClick={older}>↑ Load older · {st.start} earlier entries</button>
          : <span className="sub">Beginning of the {a ? "agent's chat" : "chat"} · {st.total} entries</span>}</div>
        {items.list.map((it) => {
          const day = it.ts ? new Date(it.ts).toDateString() : "";
          const sep = day && day !== lastDay ? <div className="daysep" key={"d" + it.key}>{new Date(it.ts!).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</div> : null;
          if (day) lastDay = day;
          return [sep, it.kind === "single" ? <i hidden key={"o" + it.key} data-seq={it.e!.seq} /> : null, <Item key={it.key} it={it} ctx={ctx} />];
        })}
        {!items.list.length && <div className="empty">No messages yet.</div>}
      </div>
      {newCount > 0 && <div className="jump"><button className="btn" onClick={() => { const el = box.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); setNewCount(0); }}>↓ {newCount} new</button></div>}
    </div>
    <Outline p={p} s={s} a={a} box={box} loaded={`${st.start}/${st.total}`} seek={seek} loading={seeking} />
    </div>
  );
}

// ---------- grouping: consecutive assistant blocks form one turn; tool results attach to their call ----------
type It = { key: string; ts?: string; kind: "asst" | "single"; blocks: Entry[]; e?: Entry };
const ASST = new Set(["text", "thinking", "tool"]);
function group(entries: Entry[]) {
  const results = new Map<string, Entry>(), toolIds = new Set<string>();
  entries.forEach((e) => { if (e.k === "tool" && e.id) toolIds.add(e.id); if (e.k === "result" && e.id) results.set(e.id, e); });
  const list: It[] = [];
  for (const e of entries) {
    if (e.k === "result" && e.id && toolIds.has(e.id)) continue;
    const isAsst = ASST.has(e.k) || (e.k === "unknown" && e.mid);
    const last = list[list.length - 1];
    if (isAsst && last && last.kind === "asst") { last.blocks.push(e); continue; }
    list.push(isAsst ? { key: "a" + e.seq, ts: e.ts, kind: "asst", blocks: [e] } : { key: "e" + e.seq, ts: e.ts, kind: "single", blocks: [], e });
  }
  return { list, results };
}

type Ctx = { p: string; s: string; a?: string; head: Head | null; full: Record<number, Entry>; loadFull: (seq: number) => void; results: Map<string, Entry>; isAgent: boolean };

const Item = memo(function Item({ it, ctx }: { it: It; ctx: Ctx }) {
  if (it.kind === "asst") return <AsstTurn it={it} ctx={ctx} />;
  const e = ctx.full[it.e!.seq] || it.e!;
  switch (e.k) {
    case "user": return (
      <div className="msg user"><div className="who-row"><span className="ts">{hhmmss(e.ts)}</span><b>{ctx.isAgent ? (e.seq === 0 ? "Task prompt" : "Parent") : "You"}</b></div>
        <div className="bubble">{e.image ? <span className="imgph">🖼 image</span> : <Markdown text={e.text || ""} />}<TruncNote e={e} ctx={ctx} /></div></div>);
    case "meta": return <MetaItem e={e} ctx={ctx} />;
    case "compact": return <div className="msg"><Fold className="meta-f" head={<><span className="nm">🗜 Compacted context</span><span className="ds">the summary Claude continued from</span><span className="ts">{hhmmss(e.ts)}</span></>}><Markdown text={e.text || ""} /><TruncNote e={e} ctx={ctx} /></Fold></div>;
    case "command": return <div className="note"><span className="chip">{e.name}{e.args ? " " + e.args : ""}</span> <span className="ts">{hhmmss(e.ts)}</span></div>;
    case "cmdout": return <div className="msg"><Fold className="meta-f" head={<><span className="nm">⌘ command output</span><span className="ds">{(e.text || "").slice(0, 140)}</span></>}><pre className="out">{e.text}</pre><TruncNote e={e} ctx={ctx} /></Fold></div>;
    case "interrupt": return <div className="note center">⏹ Interrupted by the user · <span className="ts">{hhmmss(e.ts)}</span></div>;
    case "summary": return <div className="note center">📌 <b>Summary</b> · {e.text}</div>;
    case "system":
      if (e.sub === "compact_boundary") return <div className="note center">🗜 <b>Conversation compacted</b>{e.pre ? ` · ${fmtTok(e.pre)} → ${fmtTok(e.post || 0)} tokens` : ""} · <span className="ts">{hhmmss(e.ts)}</span></div>;
      if (e.sub === "away_summary") return <div className="note">💤 <b>Recap</b> · {e.text}</div>;
      return <div className="note"><b>{e.sub || "system"}</b> · {e.text} <span className="ts">{hhmmss(e.ts)}</span></div>;
    case "result": return <div className="msg"><ResultBlock r={e} ctx={ctx} /></div>;
    default: return <div className="note">Unrecognised entry <code>{e.type || e.k}</code></div>;
  }
}, (x, y) => x.it === y.it && x.ctx.full === y.ctx.full && x.ctx.results === y.ctx.results && x.ctx.head === y.ctx.head);

function TruncNote({ e, ctx }: { e: Entry; ctx: Ctx }) {
  if (!e.trunc) return null;
  return <div className="trunc-note">Showing {fmtTok((e.text || "").length)} of {fmtTok(e.len || 0)} chars <button className="mini" onClick={() => ctx.loadFull(e.seq)}>Show all</button></div>;
}

function MetaItem({ e, ctx }: { e: Entry; ctx: Ctx }) {
  const txt = e.text || "";
  const from = txt.match(/<agent-message from="([\w-]+)"/);
  const elsewhere = from ? ctx.head?.elsewhere?.[from[1]] : undefined;
  const hand = from && (ctx.head?.agents[from[1]] || elsewhere);
  const handMissing = !!(from && ctx.head && !hand);
  const first = txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  const title = hand ? "Agent hand-back" : txt.startsWith("Base directory for this skill") ? "Skill loaded" : "System context";
  return <div className="msg"><Fold className="meta-f" head={<>
    <span className="nm">{title}</span>
    {hand && <button className="linkbtn" onClick={(ev) => { ev.stopPropagation(); go({ p: elsewhere?.p || ctx.p, s: elsewhere?.s || ctx.s, a: from![1] }); }}>{hand.label} ↗</button>}
    {handMissing && <span className="linkbtn off" aria-disabled="true" onClick={(ev) => ev.stopPropagation()}>agent chat<Info right label="Why the agent chat is unavailable">No transcript for agent {from![1]} in this chat: Claude Code removed it (cleanupPeriodDays, 30 days by default), or it was never written.</Info></span>}
    <span className="ds">{first}</span><span className="ts">{hhmmss(e.ts)}</span></>}>
    <pre className="out">{txt}</pre><TruncNote e={e} ctx={ctx} /></Fold></div>;
}

function AsstTurn({ it, ctx }: { it: It; ctx: Ctx }) {
  const model = it.blocks.find((b) => b.model)?.model;
  const cost = it.blocks.reduce((s, b) => s + (b.usage?.cost || 0), 0);
  const out = it.blocks.reduce((s, b) => s + (b.usage?.tok.output || 0), 0);
  const pending = it.blocks.some((b) => b.k === "tool" && b.id && !ctx.results.has(b.id));
  return (
    <div className={"msg asst" + (pending ? " live" : "")}>
      <div className="who-row"><b>{ctx.isAgent ? "Agent" : "Claude"}</b>{model && <span className="mdl">{shortModel(model)}</span>}
        <span className="ts">{hhmmss(it.ts)}</span>{out ? <span className="ts" title="output tokens and estimated cost of this turn, list API prices">· ✦ {fmtTok(out)} · {fmtUsd(cost)}</span> : null}</div>
      <div className="bubble">{it.blocks.map((b) => <div className="blk" key={b.seq} data-seq={b.seq}><Block e={ctx.full[b.seq] || b} ctx={ctx} /></div>)}</div>
    </div>
  );
}

function Block({ e, ctx }: { e: Entry; ctx: Ctx }) {
  if (e.k === "text") return <><Markdown text={e.text || ""} /><TruncNote e={e} ctx={ctx} /></>;
  if (e.k === "thinking") {
    const empty = !(e.text || "").trim();
    const head = <><span className="nm">💭 Thinking</span><span className="ds">{empty ? "content not stored in the transcript" : (e.text || "").slice(0, 160)}</span>{e.ms ? <span className="ts">{(e.ms / 1000).toFixed(1)}s</span> : null}</>;
    return empty ? <span className="think-pill" title="Claude thought here; the transcript keeps only a signature, not the text">💭 thought{e.ms ? ` ${(e.ms / 1000).toFixed(1)}s` : ""}</span>
      : <Fold className="think-f" head={head}><Markdown text={e.text || ""} /><TruncNote e={e} ctx={ctx} /></Fold>;
  }
  if (e.k === "tool") return <ToolCall e={e} ctx={ctx} />;
  return <div className="note">Unrecognised block <code>{e.type}</code></div>;
}

function ToolCall({ e, ctx }: { e: Entry; ctx: Ctx }) {
  const r0 = e.id ? ctx.results.get(e.id) : undefined;
  const r = r0 ? ctx.full[r0.seq] || r0 : undefined;
  const name = e.name || "tool";
  const desc = (e.desc || "").replace(new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*"), "");
  // one resolver for every agent link (server: Session.resolve): tool call id -> agent chat, or the reason there is none
  const L = e.id ? ctx.head?.links[e.id] : undefined;
  const startsAgent = name === "Agent" || name === "Task";
  const agentId = L && !L.missing ? L.a : undefined;
  const runId = r?.runId;
  const status = !r ? <span className="st-wait">running</span> : r.err ? <span className="st-err">✗ error</span> : <span className="st-ok">✓</span>;
  const link = agentId
    ? <button className="linkbtn" title={name === "SendMessage" ? "Open the chat of the agent this message resumed" : "Open the agent's own chat"} onClick={(ev) => { ev.stopPropagation(); go({ p: L!.p || ctx.p, s: L!.s || ctx.s, a: agentId }); }}>{name === "SendMessage" ? "Open resumed agent ↗" : "Open agent chat ↗"}{L?.other ? " (other chat)" : ""}</button>
    : startsAgent || (name === "SendMessage" && L)
      ? <span className="linkbtn off" aria-disabled="true" onClick={(ev) => ev.stopPropagation()}>Open agent chat<Info right label="Why the agent chat is unavailable">{L?.missing || (ctx.head ? "The agent's id isn't known yet: the link appears as soon as the agent starts." : "Loading…")}</Info></span>
    : runId ? <button className="linkbtn" onClick={(ev) => { ev.stopPropagation(); go({ p: ctx.p, s: ctx.s, tab: "mc", run: runId }); }}>Open in Mission Control ↗</button>
    : ["Write", "Edit", "MultiEdit"].includes(name) && e.input?.file_path && !r?.err
      ? <button className="linkbtn" title="Git-style diff of every change to this file in the chat" onClick={(ev) => { ev.stopPropagation(); openDiff({ p: ctx.p, s: ctx.s, path: String(e.input.file_path), id: e.id }); }}>Diff</button> : null;
  return (
    <Fold className={"tool-f" + (r?.err ? " err" : "")} head={<>
      <span className={"kdot " + (e.kind || "tool")} /><span className="nm">{name}</span><span className="ds" title={desc}>{desc}</span>{link}{status}<span className="ts">{hhmmss(e.ts)}</span></>}>
      <ToolInput e={e} ctx={ctx} />
      {r ? <ResultBody r={r} ctx={ctx} /> : <div className="lbl">Result<span className="st-wait">waiting</span></div>}
    </Fold>
  );
}

function ToolInput({ e, ctx }: { e: Entry; ctx: Ctx }) {
  const i = e.input || {};
  const more = e.itrunc && e.itrunc.length ? <div className="trunc-note">Input shortened ({e.itrunc.join(", ")}) <button className="mini" onClick={() => ctx.loadFull(e.seq)}>Show all</button></div> : null;
  let body;
  if (e.name === "Bash" && typeof i.command === "string") body = <pre>{"$ " + i.command}</pre>;
  else if (e.name === "Edit" && "old_string" in i) body = <><div className="lbl">{i.file_path}{i.replace_all ? " · replace all" : ""}</div><pre className="diff-old">{String(i.old_string)}</pre><pre className="diff-new" style={{ marginTop: 6 }}>{String(i.new_string)}</pre></>;
  else if (e.name === "Write" && "content" in i) body = <><div className="lbl">{i.file_path}</div><pre>{String(i.content)}</pre></>;
  else if ((e.name === "Agent" || e.name === "Task") && typeof i.prompt === "string") body = <><div className="lbl">{i.subagent_type || "agent"} · {i.description}</div><pre>{i.prompt}</pre></>;
  else body = <pre>{typeof i === "string" ? i : JSON.stringify(i, null, 2)}</pre>;
  return <><div className="lbl">Input</div>{body}{more}</>;
}

function ResultBody({ r, ctx }: { r: Entry; ctx: Ctx }) {
  const extra = [r.status, r.totalToolUseCount ? `${r.totalToolUseCount} tools` : "", r.totalTokens ? `${fmtTok(r.totalTokens)} tokens` : "", r.totalDurationMs ? `${Math.round(r.totalDurationMs / 1000)}s` : ""].filter(Boolean).join(" · ");
  return <><div className="lbl">Result{r.err ? " · error" : ""}<span>{extra}</span></div><pre className="out">{r.text || "(empty)"}</pre><TruncNote e={r} ctx={ctx} /></>;
}

function ResultBlock({ r, ctx }: { r: Entry; ctx: Ctx }) {
  return <Fold className={"tool-f" + (r.err ? " err" : "")} head={<><span className="kdot result" /><span className="nm">Tool result</span><span className="ds">{(r.text || "").slice(0, 140)}</span><span className="ts">{hhmmss(r.ts)}</span></>}>
    <ResultBody r={r} ctx={ctx} /></Fold>;
}
