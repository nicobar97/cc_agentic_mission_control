import { useEffect, useMemo, useRef, useState } from "react";
import { fmtUsd, href, Index, Project, QS, SessionRow, STATIC, useWriteMode, when } from "../lib";
import { Bot, Info, Logo } from "./bits";
import { NewChat } from "./Write";
import { TrashButton, TrashSection } from "./Trash";

const SHOW = 6;
const STAR_KEY = "mc.starredProjects";   // browser-only: an ordered list of project slugs (no server write)
const readStars = (): string[] => { try { const v = JSON.parse(localStorage.getItem(STAR_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
function useStars() {
  const [stars, setStars] = useState<string[]>(readStars);
  useEffect(() => { const f = (e: StorageEvent) => { if (e.key === STAR_KEY) setStars(readStars()); }; addEventListener("storage", f); return () => removeEventListener("storage", f); }, []);
  const save = (next: string[]) => { setStars(next); try { localStorage.setItem(STAR_KEY, JSON.stringify(next)); } catch (_) { /* blocked storage: stars last for this page only */ } };
  const toggle = (slug: string) => save(stars.includes(slug) ? stars.filter((x) => x !== slug) : [...stars, slug]);
  const move = (slug: string, to: number) => { const rest = stars.filter((x) => x !== slug); rest.splice(Math.max(0, Math.min(to, rest.length)), 0, slug); save(rest); };
  return { stars, toggle, move };
}

export function Sidebar({ idx, sel }: { idx: Index | null; sel?: { p?: string; s?: string } }) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState<Record<string, boolean>>({});
  const ref = useRef<HTMLInputElement>(null);
  const { stars, toggle, move } = useStars();
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ref.current?.focus(); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);

  const { active, projects, starred, n } = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const hit = (p: Project, s: SessionRow) => !ql || [s.title, s.prompt, p.path, s.branch, s.id, s.cwd].some((x) => String(x || "").toLowerCase().includes(ql));
    const active: [Project, SessionRow][] = [];
    const projects: [Project, SessionRow[]][] = [];
    let n = 0;
    const starred: [Project, SessionRow[]][] = [];
    const bySlug = new Map((idx?.projects || []).map((p) => [p.slug, p]));
    for (const p of idx?.projects || []) {
      const rows = p.sessions.filter((s) => hit(p, s));
      n += rows.length;
      rows.filter((s) => s.active).forEach((s) => active.push([p, s]));   // active chats stay in "Active now", starred or not
      const older = rows.filter((s) => !s.active);
      if (older.length && !stars.includes(p.slug)) projects.push([p, older]);
    }
    for (const slug of stars) {   // starred projects, in the order they were starred (or dragged)
      const p = bySlug.get(slug);
      if (!p) continue;
      const rows = p.sessions.filter((s) => hit(p, s));
      if (ql && !rows.length && !p.path.toLowerCase().includes(ql)) continue;
      starred.push([p, rows.filter((s) => !s.active)]);
    }
    active.sort((a, b) => b[1].mtime - a[1].mtime);
    return { active, projects, starred, n };
  }, [idx, q, stars]);

  const group = (p: Project, rows: SessionRow[], isStar: boolean) => {
    const isClosed = closed[p.slug] ?? false, show = all[p.slug] || q ? rows : rows.slice(0, SHOW);
    const flip = () => setClosed((c) => ({ ...c, [p.slug]: !isClosed }));
    const dnd = isStar ? {
      draggable: true,
      onDragStart: (e: React.DragEvent) => { drag.current = p.slug; e.dataTransfer.effectAllowed = "move"; },
      onDragOver: (e: React.DragEvent) => { if (drag.current && drag.current !== p.slug) { e.preventDefault(); setOver(p.slug); } },
      onDragLeave: () => setOver((o) => (o === p.slug ? null : o)),
      onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag.current) move(drag.current, stars.indexOf(p.slug)); drag.current = null; setOver(null); },
      onDragEnd: () => { drag.current = null; setOver(null); },
    } : {};
    return <div key={p.slug} className={"proj" + (isClosed ? " closed" : "") + (isStar ? " starred" : "") + (over === p.slug ? " drop" : "")} {...dnd}>
      <div className="proj-h" title={p.path}>
        <button className="proj-tg" aria-expanded={!isClosed} onClick={flip}
          onKeyDown={(e) => { if (isStar && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); move(p.slug, stars.indexOf(p.slug) + (e.key === "ArrowUp" ? -1 : 1)); } }}>
          <span className="chev">▼</span><span className="pn"><bdi>{p.path.replace(/^\/Users\/[^/]+/, "~")}</bdi></span><span className="cnt">{rows.length}</span></button>
        <button className={"star" + (isStar ? " on" : "")} aria-pressed={isStar} aria-label={isStar ? `Unstar ${p.path}` : `Star ${p.path} to pin it on top`}
          title={isStar ? "Unstar" : "Star to pin on top"} onClick={() => toggle(p.slug)}>{isStar ? "★" : "☆"}</button>
      </div>
      {!isClosed && <>{show.map((s) => <Row key={s.id} p={p} s={s} sel={sel} />)}
        {isStar && !rows.length && <div className="proj-empty">{q ? "No match in this project" : "Its chats are all in Active now"}</div>}
        {rows.length > show.length && <button className="more" onClick={() => setAll((a) => ({ ...a, [p.slug]: true }))}>Show {rows.length - show.length} more</button>}</>}
    </div>;
  };

  return (
    <nav className="side">
      <div className="side-head">
        <div className="brand"><div className="logo"><Logo /></div><div><div className="eyebrow">Claude Code</div><h1>Mission Control</h1>
          <div className="sub">{idx ? `${idx.projects.length} projects · ${idx.projects.reduce((s, p) => s + p.sessions.length, 0)} chats` : "indexing…"}</div></div></div>
        <input ref={ref} type="search" placeholder="Search chats…  ( ⌘K )" value={q} onChange={(e) => setQ(e.target.value)} />
        <NewChat idx={idx} />
      </div>
      <div className="side-list">
        {!idx && <div aria-label="Indexing ~/.claude/projects">{Array.from({ length: 9 }, (_, i) => <div key={i} style={{ padding: "8px 10px" }}><div className="skel skel-line" style={{ width: `${60 + (i * 13) % 35}%`, margin: "4px 0" }} /><div className="skel skel-line" style={{ width: "40%", height: 9, margin: "6px 0 0" }} /></div>)}</div>}
        {idx && q && !n && <div className="empty" style={{ margin: 10 }}>No chat matches “{q}”.</div>}
        {active.length > 0 && <>
          <div className="sec-h"><span className="eyebrow">Active now</span><span>{active.length}
            <Info right label="Legend: active"><span className="li"><span className="pulse" /> a file of this chat (or of one of its agents) changed in the last 5 min</span><span className="li"><span className="pulse busy" /> agents are running</span><span className="li"><span className="badge stopped">stopped</span> = the last turn was interrupted</span></Info></span></div>
          {active.map(([p, s]) => <Row key={p.slug + s.id} p={p} s={s} sel={sel} showProject />)}
        </>}
        {starred.length > 0 && <>
          <div className="sec-h"><span>Starred</span><span>{starred.length}
            <Info right label="Legend: starred"><span className="li"><b>★</b> starred projects stay on top, in the order you starred them</span><span className="li">Drag a starred project to reorder it, or press <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> on its name</span><span className="li">Stars are saved in this browser only</span></Info></span></div>
          {starred.map(([p, rows]) => group(p, rows, true))}
        </>}
        <div className="sec-h"><span>Projects</span><span>
          <Info right label="Legend: rows"><span className="li"><b>Row</b> title (the chat's summary, or its first prompt)</span><span className="li">time of the last change · messages · <Bot /> subagents · cost of the chat and its agents (list API prices)</span><span className="li">Newest first. <kbd>⌘K</kbd> searches titles, prompts, paths and branches</span><span className="li"><b>☆</b> on a project (shown on hover) stars it to pin it on top</span><span className="li"><span className="badge stopped">stopped</span> = the last turn was interrupted</span><span className="li">In write mode, the trash icon on a row (shown on hover) moves that chat to the macOS Trash, after a confirmation</span></Info></span></div>
        {projects.map(([p, rows]) => group(p, rows, false))}
        <TrashSection />
      </div>
    </nav>
  );
}

const HOVER = STATIC ? QS.get("hover") : null;   // screenshots only: show one row's hover state

function Row({ p, s, sel, showProject }: { p: Project; s: SessionRow; sel?: { p?: string; s?: string }; showProject?: boolean }) {
  const on = sel?.p === p.slug && sel?.s === s.id;
  const write = useWriteMode();
  return (
    <div className={"chatrow" + (write ? " w" : "") + (HOVER === s.id ? " hov" : "")}>
    <a className={"chat" + (on ? " sel" : "")} href={href({ p: p.slug, s: s.id })} aria-current={on ? "page" : undefined} title={`${s.title}\n${s.prompt}\n${s.cwd}${s.branch ? " · " + s.branch : ""}`}>
      <span style={{ minWidth: 0 }}>
        <b>{s.active && <span className={"pulse" + (s.running ? " busy" : "")} />}<span>{s.title}</span></b>
        <small>{showProject && <span className="pj">{p.path.split("/").pop()} · </span>}{when(s.mtime)} · {s.msgs} msg{s.msgs === 1 ? "" : "s"}{s.agents ? <> · <Bot /> {s.agents}</> : null}{s.running ? ` · ${s.running} running` : ""}</small>
      </span>
      <span className="rt">{s.status === "stopped" && <span className="badge stopped" title="the last turn was interrupted">stopped</span>}<span className="cost">{fmtUsd(s.cost)}</span></span>
    </a>
    {write && <TrashButton p={p.slug} s={s.id} title={s.title} open={on} />}
    </div>
  );
}
