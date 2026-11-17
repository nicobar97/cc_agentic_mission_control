// React port of the tracker's "Agent Mission Control" app (tracker.py APP): header, stat tiles, phase rings,
// agent cards with sparklines, live feed, deliverables, drawer, run switcher. Same classes, same CSS, same rules.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Agent, api, attention, ago, fmtDate, fmtDur, fmtTok, fmtUsd, go, hhmmss, KIND, McResp, quietSecs, RunData, RunSummary,
  shortModel, STATIC, sumCost, sumTok, t, useChangeRev, useNow, view,
} from "../lib";
import { Info, RunIcon, showTip as setTipGlobal, Tip, useFeedHeight } from "./bits";
export { Tip };   // the shared cursor tooltip (also used by the conversation outline)
import { openDiff } from "./Diff";

type Props = { p: string; s: string; run?: string; onMeta?: (m: { runs: number; running: number }) => void };

export function MissionControl({ p, s, run, onMeta }: Props) {
  const rev = useChangeRev(p, s);
  const [resp, setResp] = useState<McResp | null>(null);
  const [err, setErr] = useState("");
  const sig = useRef("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [phase, setPhase] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; n: number | null } | null>(null);
  const [menu, setMenu] = useState(new URLSearchParams(location.search).has("menu"));
  const qRef = useRef<HTMLInputElement>(null);
  const wrapRef = useFeedHeight();

  // tracker.py show(): compare the payload without generated_at; redraw only when something else differs
  const load = useCallback(async () => {
    try {
      const r = await api<McResp>("/api/mc", { p, s, run });
      const key = JSON.stringify({ ...r, data: r.data ? { ...r.data, generated_at: 0 } : null });
      if (key === sig.current) return;
      sig.current = key;
      setResp(r); setErr("");
    } catch (e: any) { setErr(String(e.message || e)); }
  }, [p, s, run]);
  useEffect(() => { load(); }, [load, rev]);
  useEffect(() => { if (STATIC) return; const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]); // time-based rules
  const d = resp?.data || null;
  useEffect(() => { setPhase(null); setOpen(null); }, [d?.run]);   // a new run: clear phase filter and drawer

  useEffect(() => {
    if (resp) onMeta?.({ runs: resp.history.length, running: resp.history.filter((h) => h.status === "running").length });
  }, [resp, onMeta]);

  // keys: / search · r runs · esc close (t theme is global)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement;
      if (e.key === "/" && document.activeElement !== qRef.current) { e.preventDefault(); qRef.current?.focus(); }
      else if (e.key === "Escape") { setOpen(null); setMenu(false); qRef.current?.blur(); }
      else if (e.key === "r" && !typing && !e.metaKey && !e.ctrlKey) setMenu((m) => !m);
    };
    addEventListener("keydown", k);
    const c = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".runsw")) setMenu(false); };
    addEventListener("click", c);
    return () => { removeEventListener("keydown", k); removeEventListener("click", c); };
  }, []);

  if (err && !resp) return <div className="wrap"><div className="empty">Could not load Mission Control: {err}</div></div>;
  if (!resp) return <div className="wrap" aria-label="Loading Mission Control"><div style={{ display: "flex", gap: 12, padding: "18px 0" }}><div className="skel" style={{ width: 32, height: 32 }} /><div style={{ flex: 1 }}><div className="skel skel-line" style={{ width: 120 }} /><div className="skel skel-line" style={{ width: 260 }} /></div></div>
    <div className="hero">{Array.from({ length: 12 }, (_, i) => <div key={i} className="skel" style={{ height: 76, borderRadius: 12 }} />)}</div>
    <div className="grid">{[0, 1, 2, 3].map((i) => <div key={i} className="skel card-skel" />)}</div></div>;
  if (!d) return (
    <div className="wrap"><div className="empty" style={{ marginTop: 30 }}>This chat started no subagent or workflow yet.<br />
      <span className="sub">Runs appear here live as soon as an Agent or Workflow call starts.</span></div></div>
  );

  const H = resp.history, liveId = resp.live, isPast = !!d && d.run !== liveId;
  const select = (id: string | null) => { setMenu(false); go({ p, s, tab: "mc", run: id && id !== liveId ? id : undefined }, true); };
  const matches = (a: Agent) => matchAgent(a, filter, q, phase);
  const openChat = (id: string) => go({ p, s, a: id });

  return (
    <div className="wrap mcwrap" ref={wrapRef}>
      <header className="mc-header">
        <div className="brand"><div className="logo"><RunIcon icon={d.icon} /></div>
          <div><div className="eyebrow">{d.feature || d.work}</div><h1 title={d.task}>{d.task || "Agents"}</h1>
            <div className="sub" id="sub">{`${d.work} · run ${d.run} · ${isPast ? "history · " + fmtDate(d.summary?.start) + " · " : ""}${d.finished ? "finished" : "in progress"}`}</div></div></div>
        <div className="tools">
          <input ref={qRef} type="search" placeholder="Search agents, activity…  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="seg">{[["all", "All"], ["running", "Running"], ["done", "Done"], ["attention", "Attention"]].map(([f, l]) =>
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{l}</button>)}</div>
          <Info right label="Legend: header">
            <span className="li"><b>Runs</b> every workflow of this chat is a run, and so is every plain agent</span>
            <span className="li"><b>Attention</b> filter = quiet or failed agents</span>
            <span className="li"><b>🕘 History</b> every run of this chat: pick one to see its full dashboard; the live run is the default</span>
            <span className="li">Keys: <kbd>/</kbd> search · <kbd>r</kbd> runs · <kbd>t</kbd> theme · <kbd>esc</kbd> close</span>
          </Info>
          {isPast && liveId ? <button className="btn live-btn" title="Back to the live run" onClick={() => select(null)}>● Live</button> : null}
          <div className="runsw">
            <button className="btn" title="Run history (r)" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}>🕘 <span>{H.length ? `${H.length} runs` : "History"}</span> ▾</button>
            <RunsMenu open={menu} hist={H} cur={d.run} liveId={liveId} onPick={select} />
          </div>
        </div>
      </header>
      <Hero d={d} hist={H} isPast={isPast} />
      {d.phases.length > 0 && <>
        <h2><span>Phases<Info label="Legend: phases"><span className="li"><b>Ring</b> = share of the phase's agents that are done</span><span className="li">Click a phase to show only its agents and activity; click again to clear</span></Info></span></h2>
        <section className="phases">{d.phases.map((ph) => { const pc = ph.total ? Math.round(ph.done * 100 / ph.total) : 0;
          return <div key={ph.name} className={"phase" + (phase === ph.name ? " sel" : "")} role="button" tabIndex={0} aria-pressed={phase === ph.name} onClick={() => setPhase(phase === ph.name ? null : ph.name)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPhase(phase === ph.name ? null : ph.name); } }}>
            <div className="ring" style={{ ["--p" as any]: pc, background: `conic-gradient(var(--ok) ${pc}%,var(--bg2) 0)` }}><span>{pc}%</span></div>
            <div><b>{ph.name}</b><small>{ph.done}/{ph.total} done{ph.running ? ` · ${ph.running} running` : ""} · {fmtUsd(ph.cost)}</small></div></div>; })}</section>
      </>}
      <section className="main"><div>
        <h2><span>Agents<Info label="Legend: agents">
          <span className="li"><b>Edge colour</b></span><span className="li"><span className="ln" style={{ background: "var(--run)" }} />running</span><span className="li"><span className="ln" style={{ background: "var(--ok)" }} />done</span><span className="li"><span className="ln" style={{ background: "var(--idle)" }} />quiet: running, silent for over 10 min</span><span className="li"><span className="ln" style={{ background: "var(--bad)" }} />failed</span><span className="li"><span className="ln" style={{ background: "var(--mut)" }} />stopped: by the user, or silent for 45 min</span>
          <span className="li"><b>Meta</b> 🔧 tool calls · ✦ output tokens · ⏱ active time</span>
          <span className="li"><b>Activity bars</b> = last 36 actions, oldest left</span>{Object.entries(KIND).map(([k, [l, c]]) => <span key={k} className="li"><span className="sw" style={{ background: k === "tool" ? "var(--bg2)" : c, border: k === "tool" ? "1px solid var(--bd)" : undefined }} />{k === "tool" ? "other tool" : l}</span>)}
          <span className="li">Click a card to open the agent's chat · click a bar or ☰ for its timeline</span></Info></span>
          <span>{`${d.agents.filter(matches).length} of ${d.agents.length}`}</span></h2>
        <Grid d={d} list={d.agents.filter(matches)} isPast={isPast} onOpen={(id, n) => setOpen({ id, n })} onChat={openChat} />
        <h2 style={{ marginTop: 22 }}><span>Deliverables<Info label="Legend: deliverables"><span className="li">Files the run's agents wrote or edited, newest first (taken from their Write / Edit calls)</span><span className="li"><span className="ln" style={{ background: "var(--ok)" }} /><b>green edge</b> written in the last 5 min</span><span className="li"><b>mentions</b> on review files = times "blocker / major / minor" appear (a rough hint)</span><span className="li">Hover a file for its sections · click it for a git-style diff of every change</span></Info></span><span>{d.files.length} files</span></h2>
        <Files d={d} onOpen={(path) => openDiff({ p, s, path, run: d.run })} />
      </div>
        <aside className="panel"><h2><span>Live activity<Info right label="Legend: activity"><span className="li">Newest first · new rows flash</span><span className="li"><span className="k-read">●</span> read</span><span className="li"><span className="k-write">●</span> write</span><span className="li"><span className="k-shell">●</span> shell</span><span className="li"><span className="k-think">●</span> thinking</span><span className="li"><span className="k-result">●</span> result</span><span className="li">Click a name to open that agent</span></Info></span><span><kbd>/</kbd> search · <kbd>esc</kbd> close</span></h2>
          <Feed d={d} phase={phase} q={q} onWho={(id) => setOpen({ id, n: null })} /></aside>
      </section>
      <Drawer d={d} open={open} onClose={() => setOpen(null)} onChat={openChat} />
    </div>
  );
}

/** tracker.py matches(): phase, status filter and search; shared by Mission Control and the home page. */
export function matchAgent(a: Agent, filter: string, q: string, phase?: string | null, extra: string[] = []) {
  if (phase && a.phase !== phase) return false;
  if (filter === "running" && a.status !== "running") return false;
  if (filter === "done" && a.status !== "done") return false;
  if (filter === "attention" && !attention(a)) return false;
  if (!q) return true;
  const ql = q.toLowerCase();
  return [a.label, a.phase, a.last_ev, a.last_text, ...extra].some((x) => String(x || "").toLowerCase().includes(ql));
}

function RunsMenu({ open, hist, cur, liveId, onPick }: { open: boolean; hist: RunSummary[]; cur: string; liveId: string | null; onPick: (id: string) => void }) {
  const now = useNow();
  const cost = hist.reduce((s, r) => s + (r.cost || 0), 0), tok = hist.reduce((s, r) => s + (r.tokens || 0), 0);
  return (
    <div className={"runs" + (open ? " open" : "")} onClick={(e) => e.stopPropagation()}>
      <div className="rh"><span>Run history · newest first</span><span>{hist.length} runs · {fmtTok(tok)} tok · {fmtUsd(cost)}</span></div>
      {hist.length ? hist.map((r) => {
        const st = r.status !== "running" ? r.status : r.id === liveId ? "live" : r.end && now - +t(r.end)! > 1800e3 ? "stale" : "running";
        const cls = ({ live: "running", stale: "quiet", running: "running" } as any)[st] || st;
        return <div key={r.id} className={"run" + (r.id === cur ? " sel" : "")} title={r.title} onClick={() => onPick(r.id)}>
          <span className="ri"><RunIcon icon={r.icon} size={16} /></span>
          <span style={{ minWidth: 0 }}><b>{r.title}</b><small>{fmtDate(r.start)} · {r.agents} agent{r.agents === 1 ? "" : "s"} · {fmtTok(r.tokens)} tok</small></span>
          <span className="rs"><span className={"badge " + cls}>{st}</span><small>{fmtUsd(r.cost)}</small></span></div>;
      }) : <div className="empty">No run recorded yet.</div>}
    </div>
  );
}

function Stat({ k, hint, children, extra }: { k: string; hint: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return <div className="stat"><div className="k">{k}<Info label={hint}>{hint}</Info></div><div className="v">{children}</div>{extra}</div>;
}

const WallClock = ({ from, to, live }: { from: number; to: number; live: boolean }) => {
  const now = useNow();
  return <span>{fmtDur(((live ? now : to) - from) / 1000)}</span>;
};

// tracker.py hero(): the same tiles, hints and figures
function Hero({ d, hist, isPast }: { d: RunData; hist: RunSummary[]; isPast: boolean }) {
  const A = d.agents, done = A.filter((a) => a.status === "done").length, run = A.filter((a) => a.status === "running").length, att = A.filter(attention).length;
  const tok = A.reduce((s, a) => s + (a.tokens || 0), 0), tools = A.reduce((s, a) => s + (a.tools || 0), 0);
  const firsts = A.map((a) => a.first).filter(Boolean).map((x) => +t(x)!), lasts = A.map((a) => a.last).filter(Boolean).map((x) => +t(x)!);
  const pct = A.length ? Math.round(done * 100 / A.length) : 0;
  const mc: Record<string, number> = {}; A.forEach((a) => (a.models || []).forEach((m) => (mc[m] = (mc[m] || 0) + 1)));
  const names = Object.keys(mc);
  const cr = sumTok(A, "cache_read"), allIn = cr + sumTok(A, "input") + sumTok(A, "cache_write");
  const totalCost = A.reduce((s, a) => s + (a.cost_total || 0), 0);
  return (
    <section className="hero">
      <Stat k="Progress" hint="agents done out of all agents started" extra={<div className="bar"><i style={{ width: pct + "%" }} /></div>}>{pct}%</Stat>
      <Stat k="Running" hint="agents working right now">{run}</Stat>
      <Stat k="Done" hint="agents that returned their result">{done}<span className="sub"> / {A.length}</span></Stat>
      <Stat k="Attention" hint="quiet over 10 min, or failed">{att}</Stat>
      <Stat k="Tool calls" hint="reads, edits, searches, shell commands">{tools}</Stat>
      <Stat k="Output tokens" hint="tokens written by all agents (deduplicated per message)">{fmtTok(tok)}</Stat>
      <Stat k="Model" hint={names.length ? names.map((m) => `${m}: ${mc[m]} agent${mc[m] > 1 ? "s" : ""}`).join(" · ") : "no model reported yet"}>
        <span className="v sm">{names.length ? names.map(shortModel).join(" · ") : "—"}</span></Stat>
      <Stat k="Cache hit" hint="share of input tokens served from the prompt cache (cheaper and faster)">{allIn ? Math.round(cr * 100 / allIn) + "%" : "—"}</Stat>
      <Stat k="Total tokens" hint="input + output + cache write + cache read, all agents">{fmtTok((["input", "output", "cache_write", "cache_read"] as const).reduce((s, k) => s + sumTok(A, k), 0))}</Stat>
      <Stat k="Avg / agent" hint="average estimated cost per agent">{A.length ? fmtUsd(totalCost / A.length) : "—"}</Stat>
      <Stat k="Cost" hint={`Estimated at list API prices per model. Input ${fmtUsd(sumCost(A, "input"))} · output ${fmtUsd(sumCost(A, "output"))} · cache write ${fmtUsd(sumCost(A, "cache_write"))} · cache read ${fmtUsd(sumCost(A, "cache_read"))}. A subscription plan bills differently.${A.some((a) => !a.priced) ? " Some models have no price: their part is excluded." : ""}`}>{fmtUsd(totalCost)}</Stat>
      <Stat k="Wall clock" hint="from the first agent start to now / the end">
        {firsts.length ? <WallClock from={Math.min(...firsts)} to={Math.max(...lasts)} live={!d.finished && !isPast} /> : "0m00s"}</Stat>
      {hist.length > 1 && <Stat k="All runs" hint={`Every run of this chat: ${fmtTok(hist.reduce((s, r) => s + (r.tokens || 0), 0))} tokens (input, output, cache) and ${hist.reduce((s, r) => s + (r.agents || 0), 0)} agents. Open 🕘 to switch run.`}>
        {fmtUsd(hist.reduce((s, r) => s + (r.cost || 0), 0))}<span className="sub"> · {hist.length} runs</span></Stat>}
    </section>
  );
}

// ---------- cards ----------
function Spark({ a }: { a: Agent }) {
  const all = a.events || [], ev = all.slice(-36), off = all.length - ev.length, pad = Math.max(0, 36 - ev.length);
  return <div className="spark">
    {Array.from({ length: pad }, (_, i) => <i key={"p" + i} />)}
    {ev.map((e, i) => <i key={i} className={e.kind} data-k={e.kind} data-n={off + i + 1} style={{ height: `${30 + (i / ev.length) * 70}%` }}
      onMouseMove={(m) => setTipGlobal({ k: e.kind, t: e.t || "", x: e.text, n: off + i + 1, of: all.length, cx: m.clientX, cy: m.clientY })}
      onMouseLeave={() => setTipGlobal(null)} />)}
  </div>;
}

const Elapsed = ({ a, live }: { a: Agent; live: boolean }) => {
  const now = useNow();
  const el = a.first ? ((live ? now : +t(a.last)!) - +t(a.first)!) / 1000 : 0;
  return <span title="active time (first to last action; live while running)">⏱ {fmtDur(el)}</span>;
};
const Badge = ({ a }: { a: Agent }) => {
  const now = useNow(), v = view(a, now);
  return <span className={"badge " + v}>{v === "quiet" ? `quiet ${fmtDur(quietSecs(a, now))}` : v}</span>;
};

/** The agent card. ctxLine names where the agent lives (home page); lastLine replaces the latest-action line. */
export const Card = memo(function Card({ a, isPast, idx, first, onOpen, onChat, ctxLine, lastLine }: { a: Agent; isPast: boolean; idx: number; first: boolean;
  onOpen: (id: string, n: number | null) => void; onChat: (id: string) => void; ctxLine?: string; lastLine?: string }) {
  // a hovered card defers its redraw until the mouse leaves (tracker.py grid()), so hover never flickers
  const [shown, setShown] = useState(a);
  const hover = useRef(false), pending = useRef<Agent | null>(null);
  const prevLast = useRef(a.last_ev);
  const [flash, setFlash] = useState(false);
  useEffect(() => { if (hover.current) pending.current = a; else setShown(a); }, [a]);
  useEffect(() => { if (prevLast.current !== shown.last_ev) { setFlash(true); const i = setTimeout(() => setFlash(false), 1300); prevLast.current = shown.last_ev; return () => clearTimeout(i); } }, [shown.last_ev]);
  const now = useNow();
  const v = view(shown, now), live = shown.status === "running" && !isPast;
  return (
    <div className={"card " + v} style={{ animationDelay: (first ? Math.min(idx, 12) * 30 : 0) + "ms" }} role="button" tabIndex={0} aria-label={`${shown.label}: open the agent's chat`}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onChat(shown.id); }}
      onMouseEnter={() => (hover.current = true)}
      onMouseLeave={() => { hover.current = false; if (pending.current) { setShown(pending.current); pending.current = null; } }}
      onClick={(e) => { const b = (e.target as HTMLElement).closest(".spark i[data-k]") as HTMLElement | null;
        if (b) { onOpen(shown.id, +b.dataset.n!); setTipGlobal(null); } else onChat(shown.id); }}>
      <div className="ch"><b>{shown.label}</b><span className="acts">
        <button className="iconbtn" title="Timeline and latest reasoning" onClick={(e) => { e.stopPropagation(); onOpen(shown.id, null); }}>☰</button>
        <Badge a={shown} /></span></div>
      <div className="meta">{(shown.models || []).map((m) => <span key={m} className="mdl" title="model">{shortModel(m)}</span>)}
        <span title="phase">{shown.phase || shown.agent_type || "—"}</span><span title="tool calls">🔧 {shown.tools}</span><span title="output tokens">✦ {fmtTok(shown.tokens)}</span>
        <span title="estimated cost at list API prices">💲 {shown.priced === false ? "n/a" : fmtUsd(shown.cost_total)}</span><Elapsed a={shown} live={live} /></div>
      {ctxLine && <div className="ctxline" title={ctxLine}>{ctxLine}</div>}
      <div className={"last" + (flash ? " flash" : "")} title={lastLine || shown.last_ev}>{lastLine || shown.last_ev}</div><Spark a={shown} />
    </div>
  );
}, (x, y) => x.isPast === y.isPast && x.ctxLine === y.ctxLine && x.lastLine === y.lastLine && JSON.stringify(x.a) === JSON.stringify(y.a));

function Grid({ d, list, isPast, onOpen, onChat }: { d: RunData; list: Agent[]; isPast: boolean; onOpen: (id: string, n: number | null) => void; onChat: (id: string) => void }) {
  const firstPaint = useRef(true);
  useEffect(() => { firstPaint.current = false; });
  if (!list.length) return <div className="grid"><div className="empty">No agents match the current filter.</div></div>;
  return <div className="grid" onMouseLeave={() => setTipGlobal(null)}>
    {list.map((a, i) => <Card key={d.run + a.id} a={a} isPast={isPast} idx={i} first={firstPaint.current} onOpen={onOpen} onChat={onChat} />)}
    <Tip />
  </div>;
}

export function Feed({ d, phase, q, onWho }: { d: Pick<RunData, "run" | "agents" | "feed">; phase: string | null; q: string; onWho: (id: string) => void }) {
  const seen = useRef<{ run: string; keys: Set<string>; first: boolean }>({ run: "", keys: new Set(), first: true });
  if (seen.current.run !== d.run) seen.current = { run: d.run, keys: new Set(), first: true };
  const ph = new Map(d.agents.map((a) => [a.id, a.phase]));
  const items = d.feed.filter((e) => (!phase || ph.get(e.id) === phase) && (!q || (e.agent + " " + e.text).toLowerCase().includes(q.toLowerCase()))).slice(0, 80);
  const first = seen.current.first;
  const rows = items.map((e) => { const k = e.id + e.t + e.text, isNew = !first && !seen.current.keys.has(k); seen.current.keys.add(k); return { e, k, isNew }; });
  useEffect(() => { seen.current.first = false; });
  return <ul className="feed">{rows.length ? rows.map(({ e, k, isNew }) =>
    <li key={k} className={isNew ? "new" : ""}><code>{hhmmss(e.t)}</code><div><span className="who" role="button" tabIndex={0} onClick={() => onWho(e.id)} onKeyDown={(k) => k.key === "Enter" && onWho(e.id)}>{e.agent}</span> <span className={"k-" + e.kind}>●</span> {e.text}</div></li>)
    : <li><div className="sub">No activity yet</div></li>}</ul>;
}

function Files({ d, onOpen }: { d: RunData; onOpen: (path: string) => void }) {
  const now = useNow();
  if (!d.files.length) return <div className="files"><div className="empty">Nothing written yet.</div></div>;
  return <div className="files">{d.files.map((f) => {
    const fresh = f.mtime ? (now - +t(f.mtime)!) / 1000 < 300 : false;
    const what = [f.lines != null ? `${f.lines} lines` : null, f.writes ? `${f.writes} write${f.writes > 1 ? "s" : ""}` : null, f.edits ? `${f.edits} edit${f.edits > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ");
    return <div key={f.path} className={"file" + (fresh ? " fresh" : "")} title={[f.path, ...f.heads].join(" · ")} role="button" tabIndex={0} aria-label={`Diff of ${f.name}`}
      onClick={() => onOpen(f.path)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(f.path); } }}>
      <span className="n">📄 {f.name}</span><span className="m">{what}{f.sev ? <span title="Times the words blocker / major / minor appear in this review file (rough hint, not an exact issue count)"> · blocker {f.sev.blocker} · major {f.sev.major} · minor {f.sev.minor} mentions</span> : null} · {hhmmss(f.mtime)}</span></div>;
  })}</div>;
}

export function Drawer({ d, open, onClose, onChat }: { d: Pick<RunData, "agents">; open: { id: string; n: number | null } | null; onClose: () => void; onChat: (id: string) => void }) {
  const a = open ? d.agents.find((x) => x.id === open.id) : null;
  const dbRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open?.n) return;
    const i = setTimeout(() => dbRef.current?.querySelector(`.tl li[data-n="${open.n}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 120);
    return () => clearTimeout(i);
  }, [open?.id, open?.n]);
  const tb = a?.token_breakdown || ({} as any), co = a?.cost || ({} as any);
  return <>
    <div className={"scrim" + (a ? " open" : "")} onClick={onClose} />
    <aside className={"drawer" + (a ? " open" : "")}>
      {a && <>
        <div className="dh"><div className="ch"><b style={{ fontSize: 16 }}>{a.label}</b><Badge a={a} /></div>
          <div className="meta"><span>{a.phase || a.agent_type || "—"}</span><span>🔧 {a.tools} tools</span><span>✦ {fmtTok(a.tokens)} tokens</span><span>started {hhmmss(a.first)}</span><span>last {hhmmss(a.last)}</span></div>
          <div className="acts"><button className="linkbtn" onClick={() => onChat(a.id)}>Open the agent's chat ↗</button><button className="btn" onClick={onClose}>Close <kbd>esc</kbd></button></div></div>
        <div className="db" ref={dbRef}>
          <h2>Cost <span style={{ textTransform: "none", letterSpacing: 0 }}>{(a.models || []).join(", ") || "model unknown"}</span></h2>
          <table className="ct"><tbody><tr><th>Tokens</th><th>Count</th><th>Cost</th></tr>
            {([["Input", "input"], ["Output", "output"], ["Cache write", "cache_write"], ["Cache read", "cache_read"]] as const).map(([l, k]) =>
              <tr key={k}><td>{l}</td><td>{fmtTok(tb[k] || 0)}</td><td>{fmtUsd(co[k] || 0)}</td></tr>)}
            <tr className="tot"><td>Total</td><td></td><td>{a.priced === false ? "n/a" : fmtUsd(a.cost_total)}</td></tr></tbody></table>
          <h2 style={{ marginTop: 16 }}>Latest reasoning</h2><pre>{a.last_text || "—"}</pre>
          <h2 style={{ marginTop: 16 }}>Timeline</h2>
          <ul className="tl">{(a.events || []).map((e, i) => ({ e, n: i + 1 })).reverse().map(({ e, n }) =>
            <li key={n} className={"k-" + e.kind + (open?.n === n ? " hl" : "")} data-n={n}><code>{hhmmss(e.t)}</code> <span style={{ color: "var(--fg)" }}>{e.text}</span></li>)}</ul>
        </div></>}
    </aside>
  </>;
}
