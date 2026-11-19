import { useEffect, useMemo, useRef, useState } from "react";
import { BUILD, fmtUsd, href, Index, Project, QS, SessionRow, STATIC, useWriteMode, when } from "../lib";
import { Bot, ChevronIcon, Info, Logo, StarIcon } from "./bits";
import { NewChat } from "./Write";

const SHOW = 6;
const STAR_KEY = "mc.starredProjects";   // browser-only: an ordered list of project slugs (no server write)
const HIDE_KEY = "mc.hiddenChats";
const readHidden = (): string[] => { try { const v = JSON.parse(localStorage.getItem(HIDE_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
/** Chats hidden from the list: browser localStorage only. Nothing on disk is touched. */
function useHidden() {
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const save = (next: string[]) => { setHidden(next); try { localStorage.setItem(HIDE_KEY, JSON.stringify(next)); } catch (_) { /* blocked storage: lasts for this page only */ } };
  // write mode hides a chat's parent once a fork of it is opened ("mc-hide" event, so Write.tsx needs no import from here)
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setHidden((h) => { if (h.includes(id)) return h; const next = [...h, id]; try { localStorage.setItem(HIDE_KEY, JSON.stringify(next)); } catch (_) { /* ignore */ } return next; });
    };
    addEventListener("mc-hide", on);
    return () => removeEventListener("mc-hide", on);
  }, []);
  return { hidden, hide: (id: string) => save([...hidden.filter((x) => x !== id), id]), unhide: (id: string) => save(hidden.filter((x) => x !== id)) };
}
const readStars = (): string[] => { if (STATIC && QS.get("stars")) return QS.get("stars")!.split(",").filter(Boolean); try { const v = JSON.parse(localStorage.getItem(STAR_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
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
  const { hidden, hide, unhide } = useHidden();
  const [showHidden, setShowHidden] = useState(false);
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ref.current?.focus(); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);

  const { active, projects, starred, n, hiddenRows } = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const match = (p: Project, s: SessionRow) => !ql || [s.title, s.prompt, p.path, s.branch, s.id, s.cwd].some((x) => String(x || "").toLowerCase().includes(ql));
    const hit = (p: Project, s: SessionRow) => !hidden.includes(s.id) && match(p, s);
    // hidden chats never mix into the lists above: they get a section of their own at the bottom
    const hiddenRows: [Project, SessionRow][] = [];
    for (const p of idx?.projects || []) for (const s of p.sessions) if (hidden.includes(s.id) && match(p, s)) hiddenRows.push([p, s]);
    hiddenRows.sort((a, b) => b[1].mtime - a[1].mtime);
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
    return { active, projects, starred, n, hiddenRows };
  }, [idx, q, stars, hidden]);

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
          <ChevronIcon size={12} className="chev" /><span className="pn"><bdi>{p.path.replace(/^\/Users\/[^/]+/, "~")}</bdi></span><span className="cnt">{rows.length}</span></button>
        <button className={"star" + (isStar ? " on" : "")} aria-pressed={isStar} aria-label={isStar ? `Unstar ${p.path}` : `Star ${p.path} to pin it on top`}
          title={isStar ? "Unstar" : "Star to pin on top"} onClick={() => toggle(p.slug)}><StarIcon on={isStar} /></button>
      </div>
      {!isClosed && <>{show.map((s) => <Row key={s.id} p={p} s={s} sel={sel} hid={hidden.includes(s.id)} onHide={() => (hidden.includes(s.id) ? unhide : hide)(s.id)} />)}
        {isStar && !rows.length && <div className="proj-empty">{q ? "No match in this project" : "Its chats are all in Active now"}</div>}
        {rows.length > show.length && <button className="more" onClick={() => setAll((a) => ({ ...a, [p.slug]: true }))}>Show {rows.length - show.length} more</button>}</>}
    </div>;
  };

  return (
    <nav className="side">
      <div className="side-head">
        <div className="brand"><div className="logo"><Logo /></div><div><div className="eyebrow">Claude Code</div><h1>Mission Control</h1>
          <div className="sub">{idx ? `${idx.projects.length} projects · ${idx.projects.reduce((s, p) => s + p.sessions.length, 0)} chats` : "indexing…"}</div>
          <div className="sub ver" title={`Version ${BUILD.version}, build ${BUILD.build}${BUILD.commit ? ` (commit ${BUILD.commit}${BUILD.dirty ? ", with uncommitted changes" : ""})` : ""}${BUILD.date ? `, built ${BUILD.date}` : ""}`}>
            v{BUILD.version} · build {BUILD.build}{BUILD.dirty ? "+" : ""}</div></div></div>
        <input ref={ref} type="search" placeholder="Search chats…  ( ⌘K )" value={q} onChange={(e) => setQ(e.target.value)} />
        <NewChat idx={idx} />
      </div>
      <div className="side-list">
        {!idx && <div aria-label="Indexing ~/.claude/projects">{Array.from({ length: 9 }, (_, i) => <div key={i} style={{ padding: "8px 10px" }}><div className="skel skel-line" style={{ width: `${60 + (i * 13) % 35}%`, margin: "4px 0" }} /><div className="skel skel-line" style={{ width: "40%", height: 9, margin: "6px 0 0" }} /></div>)}</div>}
        {idx && q && !n && <div className="empty" style={{ margin: 10 }}>No chat matches “{q}”.</div>}
        {active.length > 0 && <>
          <div className="sec-h"><span className="eyebrow">Active now</span><span className="sec-r"><span className="cnt">{active.length}</span>
            <Info right label="Legend: active"><span className="li"><span className="pulse" /> a file of this chat (or of one of its agents) changed in the last 5 min</span><span className="li"><span className="pulse busy" /> agents are running</span><span className="li"><span className="badge stopped">stopped</span> = the last turn was interrupted</span></Info></span></div>
          {active.map(([p, s]) => <Row key={p.slug + s.id} p={p} s={s} sel={sel} showProject hid={hidden.includes(s.id)} onHide={() => (hidden.includes(s.id) ? unhide : hide)(s.id)} />)}
        </>}
        {starred.length > 0 && <>
          <div className="sec-h"><span>Starred</span><span className="sec-r"><span className="cnt">{starred.length}</span>
            <Info right label="Legend: starred"><span className="li"><StarIcon on /> starred projects stay on top, in the order you starred them</span><span className="li">Drag a starred project to reorder it, or press <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> on its name</span><span className="li">Stars are saved in this browser only</span></Info></span></div>
          {starred.map(([p, rows]) => group(p, rows, true))}
        </>}
        <div className="sec-h"><span>Projects</span><span className="sec-r">
          <Info right label="Legend: rows"><span className="li"><b>Row</b> title (the chat's summary, or its first prompt)</span><span className="li">time of the last change · messages · <Bot /> subagents · cost of the chat and its agents (list API prices)</span><span className="li">Newest first. <kbd>⌘K</kbd> searches titles, prompts, paths and branches</span><span className="li"><StarIcon /> on a project (shown on hover) stars it to pin it on top</span><span className="li"><span className="badge stopped">stopped</span> = the last turn was interrupted</span><span className="li">✕ on a row (shown on hover) hides that chat from the list; nothing is deleted. "Show hidden chats" at the bottom brings them back</span></Info></span></div>
        {projects.map(([p, rows]) => group(p, rows, false))}
        {hidden.length > 0 && <button className="agm-more" onClick={() => setShowHidden((v) => !v)}>{showHidden ? "Hide hidden chats" : `Show hidden chats (${hidden.length})`}</button>}
        {showHidden && <>
          <div className="sec-h"><span>Hidden chats</span><span className="sec-r"><span className="cnt">{hiddenRows.length}</span></span></div>
          {hiddenRows.length ? hiddenRows.map(([p, s]) => <Row key={p.slug + s.id} p={p} s={s} sel={sel} showProject hid onHide={() => unhide(s.id)} />)
            : <div className="proj-empty">{q ? "No hidden chat matches" : "No hidden chats"}</div>}
        </>}
      </div>
    </nav>
  );
}

const HOVER = STATIC ? QS.get("hover") : null;   // screenshots only: show one row's hover state

function Row({ p, s, sel, showProject, hid, onHide }: { p: Project; s: SessionRow; sel?: { p?: string; s?: string }; showProject?: boolean; hid?: boolean; onHide?: () => void }) {
  const on = sel?.p === p.slug && sel?.s === s.id;
  const write = useWriteMode();
  return (
    <div className={"chatrow w" + (HOVER === s.id ? " hov" : "")}>
    <a className={"chat" + (on ? " sel" : "") + (s.active ? " act" : "")} href={href({ p: p.slug, s: s.id })} aria-current={on ? "page" : undefined} title={`${s.title}\n${s.prompt}\n${s.cwd}${s.branch ? " · " + s.branch : ""}`}>
      {s.active && <span className={"pulse" + (s.running ? " busy" : "")} />}
      <b>{s.title}</b><span className="cost">{fmtUsd(s.cost)}</span>
      <small>{showProject && <span className="pj">{p.path.split("/").pop()} · </span>}{when(s.mtime)} · {s.msgs} msg{s.msgs === 1 ? "" : "s"}{s.agents ? <> · <Bot /> {s.agents}</> : null}{s.running ? ` · ${s.running} running` : ""}</small>
      <span className="rt">{s.status === "stopped" && <span className="badge stopped" title="the last turn was interrupted">stopped</span>}</span>
    </a>
    <button className="trashbtn" title={hid ? "Show this chat again" : "Hide this chat from the list (nothing is deleted)"}
      aria-label={hid ? "Unhide chat" : "Hide chat"} onClick={(e) => { e.preventDefault(); onHide?.(); }}>{hid ? "↺" : "✕"}</button>
    </div>
  );
}
