import { useCallback, useEffect, useRef, useState } from "react";
import { agoSecs, api, fmtDate, fmtTok, fmtUsd, go, href, Head, Index, McResp, Route, STATIC, startLive, useChangeRev, useLive, useNow, useRoute, when } from "./lib";
import { Bot, Info, Logo, RunIcon } from "./components/bits";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { MissionControl } from "./components/MissionControl";
import { Composer, WriteToggle } from "./components/Write";
import { DiffHost } from "./components/Diff";
import { Home } from "./components/Home";

startLive();

const setTheme = (th: string) => { document.documentElement.dataset.theme = th; try { localStorage.setItem("tracker-theme", th); } catch (_) {} };
const THEMES = ["light", "dark", "dim"] as const;
const curTheme = () => document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
const toggleTheme = () => setTheme(THEMES[(THEMES.indexOf(curTheme() as any) + 1) % THEMES.length]);
function ThemeSwitch() {
  const [th, setTh] = useState(curTheme());
  useEffect(() => { const o = new MutationObserver(() => setTh(curTheme())); o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); return () => o.disconnect(); }, []);
  return <div className="seg themesw" role="radiogroup" aria-label="Theme (t cycles)" title="Theme (t cycles)">
    {THEMES.map((x) => <button key={x} role="radio" aria-checked={th === x} className={th === x ? "on" : ""} onClick={() => setTheme(x)}>{x === "light" ? "Light" : x === "dark" ? "Dark" : "Dim"}</button>)}</div>;
}

export default function App() {
  const route = useRoute();
  const anyRev = useChangeRev();
  const [idx, setIdx] = useState<Index | null>(null);
  const timer = useRef<number | undefined>();

  const loadIdx = useCallback(() => { api<Index>("/api/index").then(setIdx).catch(() => {}); }, []);
  useEffect(() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(loadIdx, anyRev ? 400 : 0); }, [anyRev, loadIdx]);
  useEffect(() => { if (STATIC) return; const i = setInterval(loadIdx, 30000); return () => clearInterval(i); }, [loadIdx]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { const el = document.activeElement as HTMLElement | null; const typing = !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable); if (e.key === "t" && !typing && !e.metaKey && !e.ctrlKey) toggleTheme(); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);
  useEffect(() => {
    const g = idx?.global;
    document.title = `${g?.running_agents ? "● " : ""}Mission Control${g ? ` · ${fmtUsd(g.today_cost)} today` : ""}`;
  }, [idx]);

  return (
    <div className="app">
      <Sidebar idx={idx} sel={route} />
      <main className="mainpane">
        <TopBar idx={idx} />
        {route.p && route.s ? <SessionView key={route.p + "/" + route.s} route={route} idx={idx} /> : <Home idx={idx} />}
      </main>
      <DiffHost />
    </div>
  );
}

function LiveDot() {
  const L = useLive(), now = useNow();
  const age = L.lastOk ? Math.max(0, (now - L.lastOk) / 1000) : 0;
  const stale = !STATIC && (!L.connected || age > 15);
  const text = STATIC ? "snapshot" : !L.lastOk ? "connecting" : stale ? `offline · retrying` : `live · updated ${Math.round(age)}s ago`;
  return <span className={"live" + (stale ? " stale" : "") + (STATIC ? " fin" : "")} title={L.lastChange ? `last change on disk: ${new Date(L.lastChange).toLocaleTimeString([], { hour12: false })}` : ""}>
    <span className="dot" /><span>{text}</span></span>;
}

function TopBar({ idx }: { idx: Index | null }) {
  const g = idx?.global;
  const b = g?.today_cost_breakdown;
  return (
    <div className="topbar">
      <div className="gtiles">
        <div className="gstat"><div className="k">Today · cost<Info label="today's cost">{b ? `Every chat and agent, messages since local midnight, deduped per message id and priced per model at list API prices (fast mode 2×). Input ${fmtUsd(b.input)} · output ${fmtUsd(b.output)} · cache write ${fmtUsd(b.cache_write)} · cache read ${fmtUsd(b.cache_read)}. A subscription plan bills differently.` : "…"}</Info></div><div className="v">{g ? fmtUsd(g.today_cost) : "—"}</div></div>
        <div className="gstat"><div className="k">Today · tokens<Info label="today's tokens">{g ? `${fmtTok(g.today_tokens_breakdown.input)} input · ${fmtTok(g.today_tokens_breakdown.output)} output · ${fmtTok(g.today_tokens_breakdown.cache_write)} cache write · ${fmtTok(g.today_tokens_breakdown.cache_read)} cache read, over ${g.today_messages} messages` : "…"}</Info></div><div className="v">{g ? fmtTok(g.today_tokens) : "—"}</div></div>
        <div className="gstat"><div className="k">Active chats<Info label="active chats">a chat counts as active when its transcript or one of its agents changed in the last 5 min, unless its last turn was interrupted (stopped) and none of its agents is running</Info></div><div className="v">{g ? g.active_chats : "—"}</div></div>
        <div className="gstat"><div className="k">Running agents<Info label="running agents">subagents and workflow agents still running, by the tracker's rules: not finished, no hand-back, not stopped (stoppedByUser, killed, or its last turn interrupted), and not silent for 45 min</Info></div><div className="v">{g ? g.running_agents : "—"}</div></div>
      </div>
      <div className="tools"><WriteToggle /><LiveDot />
        <Info right label="Legend: live"><span className="li"><span className="dot" style={{ animation: "none" }} /><b>live</b> pushed by the server as files change (Server-Sent Events)</span><span className="li"><span className="dot" style={{ animation: "none", background: "var(--idle)" }} /><b>offline</b> the server is not answering; it reconnects by itself</span><span className="li">Read-only: nothing under ~/.claude is ever written</span><span className="li">Keys: <kbd>⌘K</kbd> chats · <kbd>/</kbd> search agents · <kbd>r</kbd> runs · <kbd>t</kbd> theme · <kbd>esc</kbd> close</span></Info>
        <ThemeSwitch /></div>
    </div>
  );
}

function SessionView({ route, idx }: { route: Route; idx: Index | null }) {
  const { p, s, a } = route as Required<Pick<Route, "p" | "s">> & Route;
  const [head, setHead] = useState<Head | null>(null);
  const [mcMeta, setMcMeta] = useState<{ runs: number; running: number } | null>(null);
  const proj = idx?.projects.find((x) => x.slug === p);
  const row = proj?.sessions.find((x) => x.id === s);
  const title = row?.title || head?.title || s;
  const ag = a ? head?.agent || (head?.agents[a] ? { id: a, wf: head.agents[a].wf, label: head.agents[a].label } as any : null) : null;
  const tab = a ? "chat" : route.tab;
  const nAgents = row ? row.agents : head ? Object.keys(head.agents).length : 0;
  const onMeta = useCallback((m: { runs: number; running: number }) => setMcMeta(m), []);
  const back = () => { if (a && route.from !== "home") go({ p, s, tab: "mc" }); else go({}); };
  return (
    <>
      <div className="shead">
        <div className="crumbs">
          <button className="back" title={a ? "Back to Mission Control" : "Back to the overview"} onClick={back}>←</button>
          {route.from === "home" && <><a href={href({})}>Home</a><span className="sep">›</span></>}
          <a href={href({})} title={proj?.path}>{(proj?.path || p).split("/").pop()}</a><span className="sep">›</span>
          {a ? <a href={href({ p, s })} title={title}>{title}</a> : <span className="cur" title={title}>{title}</span>}
          {a && ag?.wf && <><span className="sep">›</span><a href={href({ p, s, tab: "mc", run: ag.wf })}>⚙ {ag.wf}</a></>}
          {a && <><span className="sep">›</span><span className="cur"><Bot /> {ag?.label || a}</span></>}
        </div>
        <div className="tabs"><div className="seg">
          <button className={tab === "chat" && !a ? "on" : ""} onClick={() => go({ p, s })}>💬 Conversation</button>
          <AgentsMenu p={p} s={s} a={a} label={ag?.label} count={nAgents} />
          <button className={tab === "mc" ? "on" : ""} onClick={() => go({ p, s, tab: "mc" })}><Logo size={13} /> Mission Control<span className="n" title="subagents and workflow agents"><Bot /> {nAgents}</span>{row?.running ? <span className="n" style={{ color: "var(--run)" }} title="running">● {row.running}</span> : null}</button>
        </div></div>
      </div>
      {tab === "mc" ? <div className="scroll"><MissionControl p={p} s={s} run={route.run} onMeta={onMeta} chatCost={row?.cost_main} /></div>
        : <div className="convo-col"><Transcript key={a || "main"} p={p} s={s} a={a} onHead={setHead} />{!a && <Composer p={p} s={s} />}</div>}
    </>
  );
}

type Task = { id: string; wf: string | null; agentId: string | null; title: string; icon?: string; status: string;
  agents: number; tokens: number; cost: number; start: string | null; members: { id: string; label: string }[] };
const PLAIN_SHOWN = 8;

/** "Agent Tasks ▾": every task of this chat as one block. A workflow is one task with several agents; a plain agent is a task of one.
 *  Figures come from the run summaries the run switcher uses (/api/mc history), so the two always agree. */
function AgentsMenu({ p, s, a, label, count }: { p: string; s: string; a?: string; label?: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [resp, setResp] = useState<McResp | null>(null);
  const [exp, setExp] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);
  const rev = useChangeRev(p, s);
  useEffect(() => { if (open) api<McResp>("/api/mc", { p, s }).then(setResp).catch(() => {}); }, [open, rev, p, s]);
  useEffect(() => { const c = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".agmenu")) setOpen(false); }; addEventListener("click", c); return () => removeEventListener("click", c); }, []);
  const head = resp?.head;
  const agents = head ? Object.entries(head.agents).map(([id, x]) => ({ id, ...x })) : [];
  const members = new Map<string, { id: string; label: string }[]>();
  agents.forEach((x) => { if (x.wf) members.set(x.wf, [...(members.get(x.wf) || []), { id: x.id, label: x.label }]); });
  const seen = new Set<string>();
  const tasks: Task[] = (resp?.history || []).map((r) => {
    const wf = r.id.startsWith("wf_") ? r.id : null, agentId = wf ? null : r.id.replace(/^agent-/, "");
    seen.add(wf || agentId!);
    return { id: r.id, wf, agentId, title: wf ? r.title : head?.agents[agentId!]?.label || r.title, icon: r.icon, status: r.status,
      agents: r.agents, tokens: r.tokens, cost: r.cost, start: r.start, members: wf ? members.get(wf) || [] : [] };
  });
  agents.forEach((x) => {  // agents with no run summary yet still get a row
    const k = x.wf || x.id; if (seen.has(k)) return; seen.add(k);
    tasks.push({ id: k, wf: x.wf, agentId: x.wf ? null : x.id, title: x.wf ? `⚙ ${x.wf}` : x.label, status: "running",
      agents: x.wf ? (members.get(x.wf) || []).length : 1, tokens: 0, cost: 0, start: null, members: x.wf ? members.get(x.wf) || [] : [] });
  });
  tasks.sort((x, y) => (+(y.status === "running") - +(x.status === "running")) || String(y.start || "").localeCompare(String(x.start || "")));
  const plain = tasks.filter((t) => !t.wf), shown = new Set((all ? plain : plain.slice(0, PLAIN_SHOWN)).map((t) => t.id));
  const visible = tasks.filter((t) => t.wf || shown.has(t.id));
  const total = tasks.reduce((n, t) => n + (t.cost || 0), 0), nAgents = tasks.reduce((n, t) => n + (t.agents || 0), 0);
  const close = () => setOpen(false);
  const meta = (t: Task) => [t.start ? fmtDate(t.start) : null, t.wf ? `${t.agents} agent${t.agents === 1 ? "" : "s"}` : null,
    t.tokens ? `${fmtTok(t.tokens)} tok` : null].filter(Boolean).join(" · ");
  const side = (t: Task) => <span className="rs"><span className={"badge " + (t.status === "running" ? "running" : t.status)}>{t.status}</span>
    {t.cost ? <small>{fmtUsd(t.cost)}</small> : null}</span>;
  if (!count && !a) return <button disabled title="This chat started no subagent or workflow"><Bot /> Agent Tasks<span className="n">0</span></button>;
  return <span className="agmenu">
    <button className={a ? "on" : ""} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      title="This chat's tasks: a workflow with its agents, or a single agent"><Bot /> {a ? (label || a) : "Agent Tasks"}<span className="n">{count}</span> ▾</button>
    {open && <div className="runs open agm" role="menu" onClick={(e) => e.stopPropagation()}>
      <div className="rh"><span>Agent Tasks</span><span>{resp ? `${tasks.length} tasks · ${nAgents} agents · ${fmtUsd(total)}` : "…"}</span></div>
      {!resp && <div className="skel skel-line" style={{ margin: 10 }} />}
      {visible.map((t) => t.wf ? <div key={t.id} className="agm-task">
        <div className={"run task" + (t.members.some((m) => m.id === a) ? " sel" : "")}>
          <button className="chev" aria-expanded={!!exp[t.id]} aria-label={(exp[t.id] ? "Hide" : "Show") + " this task's agents"}
            onClick={() => setExp((e) => ({ ...e, [t.id]: !e[t.id] }))}>{exp[t.id] ? "▾" : "▸"}</button>
          <a role="menuitem" className="tl" href={href({ p, s, tab: "mc", run: t.id })} onClick={close} title={`${t.title} · open in Mission Control (${t.id})`}>
            <span className="ri"><RunIcon icon={t.icon} size={16} /></span><span style={{ minWidth: 0 }}><b>{t.title}</b><small>{meta(t)}</small></span></a>
          {side(t)}</div>
        {exp[t.id] && <div className="agm-members">{t.members.map((m) => <a key={m.id} role="menuitem" className={"mem" + (m.id === a ? " sel" : "")}
          href={href({ p, s, a: m.id })} onClick={close} title={m.id}><Bot /> <span>{m.label}</span></a>)}</div>}
      </div> : <a key={t.id} role="menuitem" className={"run" + (t.agentId === a ? " sel" : "")} href={href({ p, s, a: t.agentId! })} onClick={close} title={`${t.title} (${t.agentId})`}>
        <span className="ri"><Bot /></span><span style={{ minWidth: 0 }}><b>{t.title}</b><small>{meta(t)}</small></span>{side(t)}</a>)}
      {plain.length > PLAIN_SHOWN && <button className="agm-more" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${plain.length} single-agent tasks`}</button>}
    </div>}
  </span>;
}
