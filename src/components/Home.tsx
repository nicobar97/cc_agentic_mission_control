// Home: every agent across all chats, with the Mission Control card, drawer and feed (shared, not forked).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Agent, AgentCtx, agoSecs, api, FeedEv, fmtUsd, go, Index, STATIC, useChangeRev, useNow, when } from "../lib";
import { Card, Drawer, Feed, matchAgent, Tip } from "./MissionControl";
import { Bot, ChatIcon, Info, Logo, useFeedHeight } from "./bits";

type AgentsResp = { state: string; total: number; agents: Agent[]; feed: (FeedEv & { ctx: AgentCtx })[] };

const ctxLine = (a: Agent) => {
  const c = a.ctx!;
  const proj = (c.project || "").split("/").pop();
  if (c.main) {   // a main chat: its own agents are counted on it
    const n = c.n_agents || 0;
    return ["Main chat", proj, n ? `${n} agent${n === 1 ? "" : "s"}${c.n_running ? ` · ${c.n_running} running` : ""}` : "no agents"].join(" · ");
  }
  return [c.chat, proj, c.wf || null, a.phase || null].filter(Boolean).join(" · ");
};
const firstLine = (s: string) => (s || "").replace(/[#*`>_]/g, "").split("\n").map((x) => x.trim()).find(Boolean) || "";

function useAgents(state: "running" | "recent", limit: number) {
  const rev = useChangeRev();
  const [data, setData] = useState<AgentsResp | null>(null);
  const sig = useRef("");
  const timer = useRef<number | undefined>();
  const load = useCallback(() => {
    api<AgentsResp>("/api/agents", { state, limit }).then((r) => {
      const k = JSON.stringify(r);             // no redraw when nothing changed
      if (k !== sig.current) { sig.current = k; setData(r); }
    }).catch(() => {});
  }, [state, limit]);
  useEffect(() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(load, rev ? 500 : 0); }, [rev, load]);
  useEffect(() => { if (STATIC) return; const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);
  return data;
}

export function Home({ idx }: { idx: Index | null }) {
  const [limit, setLimit] = useState(24);
  const running = useAgents("running", 200);
  const recent = useAgents("recent", limit);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<{ id: string; n: number | null } | null>(null);
  const qRef = useRef<HTMLInputElement>(null);
  const wrapRef = useFeedHeight();
  const now = useNow();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== qRef.current && !(document.activeElement instanceof HTMLTextAreaElement)) { e.preventDefault(); qRef.current?.focus(); }
      else if (e.key === "Escape") { setOpen(null); qRef.current?.blur(); }
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);
  const all = useMemo(() => [...(running?.agents || []), ...(recent?.agents || [])], [running, recent]);
  const byId = useRef(new Map<string, Agent>());
  byId.current = new Map(all.map((a) => [a.id, a]));
  const onChat = useCallback((id: string) => { const c = byId.current.get(id)?.ctx; if (c) go(c.main ? { p: c.p, s: c.s, from: "home" } : { p: c.p, s: c.s, a: id, from: "home" }); }, []);
  const onOpen = useCallback((id: string, n: number | null) => setOpen({ id, n }), []);
  const match = (a: Agent) => matchAgent(a, filter, q, null, [a.ctx?.chat || "", a.ctx?.project || "", a.ctx?.wf || ""]);
  const run = (running?.agents || []).filter(match), done = (recent?.agents || []).filter(match);
  const feedD = useMemo(() => ({ run: "home", agents: all, feed: running?.feed || [] }), [all, running]);
  const first = useRef(true); useEffect(() => { first.current = false; });

  return (
    <div className="scroll"><div className="wrap home" ref={wrapRef}>
      <header className="mc-header">
        <div className="brand"><div className="logo"><Logo /></div><div><div className="eyebrow">All chats · all projects</div><h1>Agents</h1>
          <div className="sub">{running ? `${running.total} running · ${recent?.total ?? "…"} finished in the last 24 h` : "loading…"}</div></div></div>
        <div className="tools">
          <input ref={qRef} type="search" placeholder="Search agents, chats, activity…  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="seg">{[["all", "All"], ["running", "Running"], ["done", "Done"], ["attention", "Attention"]].map(([f, l]) =>
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{l}</button>)}</div>
          <Info right label="Legend: home"><span className="li"><b>Running now</b> every subagent and workflow agent still running, in any chat, and every main chat active in the last 2 min</span><span className="li"><b>Main chat</b> cards are the conversations themselves: the line under the name gives the number of their own agents (and how many run); click one to open the chat</span><span className="li"><b>Recently finished</b> agents that finished or stopped in the last 24 h, with the first line of their final report</span><span className="li">Cards, bars and the drawer work as in Mission Control: click a card for the agent's chat, the list button or a bar for its timeline</span><span className="li">Keys: <kbd>/</kbd> search · <kbd>esc</kbd> close</span></Info>
        </div>
      </header>
      <section className="main"><div>
        <h2><span>Running now<Info label="Legend: running"><span className="li">Same card as Mission Control, plus a line naming its chat, project, workflow and phase</span><span className="li"><b>quiet Xm</b> running but silent for over 10 min</span></Info></span><span>{running ? `${run.length} of ${running.total}` : ""}</span></h2>
        {!running ? <div className="grid">{[0, 1].map((i) => <div key={i} className="skel card-skel" />)}</div>
          : run.length ? <div className="grid" >{run.map((a, i) => <Card key={a.id} a={a} isPast={false} idx={i} first={first.current} onOpen={onOpen} onChat={onChat} ctxLine={ctxLine(a)} />)}</div>
          : <div className="empty">{running.total ? "No running agent matches the filter." : "No agents running."}</div>}
        <h2 style={{ marginTop: 24 }}><span>Recently finished<Info label="Legend: finished"><span className="li">Finished or stopped in the last 24 h, newest first. The line under each card is the start of its final report.</span></Info></span><span>{recent ? `${done.length} of ${recent.total}` : ""}</span></h2>
        {!recent ? <div className="grid">{[0, 1, 2].map((i) => <div key={i} className="skel card-skel" />)}</div>
          : done.length ? <div className="grid">{done.map((a, i) => <Card key={a.id} a={a} isPast idx={i} first={first.current} onOpen={onOpen} onChat={onChat} ctxLine={ctxLine(a)} lastLine={firstLine(a.last_text) || a.last_ev} />)}</div>
          : <div className="empty">Nothing finished in the last 24 hours.</div>}
        {recent && recent.total > done.length && filter === "all" && !q && <div className="older"><button className="btn" onClick={() => setLimit((l) => l + 24)}>Show more · {recent.total - done.length} older</button></div>}
      </div>
        <aside className="panel"><h2><span>Live activity<Info right label="Legend: activity"><span className="li">The latest actions of every running agent, newest first</span><span className="li">Click a name to open that agent's timeline</span></Info></span><span>{when(Date.now() / 1000)}</span></h2>
          <Feed d={feedD} phase={null} q={q} onWho={(id) => setOpen({ id, n: null })} /></aside>
      </section>
      <Tip />
      <Drawer d={{ agents: all }} open={open} onClose={() => setOpen(null)} onChat={onChat} />
    </div></div>
  );
}
