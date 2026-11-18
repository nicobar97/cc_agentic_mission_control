// Write mode: move a chat to the macOS Trash (~/.Trash/Mission Control/…), with a confirm dialog, an Undo toast,
// a "Trash" list in the sidebar and a notice in other tabs. The server does every check; the UI only explains.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { agoSecs, api, fmtBytes, fmtDate, QS, STATIC, useChangeRev, useNow, useWriteMode, writeApi } from "../lib";
import { Bot, ChevronIcon, Info, TrashIcon } from "./bits";

type TrashInfo = { p: string; s: string; title: string; path: string; cwd: string; mtime: number; last: string | null; msgs: number;
  agents: number; workflows: number; size: number; files: number; has_dir: boolean; refused?: string };
type TrashItem = { p: string; s: string; entry: string; trashed_at: number; size: number; restorable: boolean; title?: string; cwd?: string; msgs?: number };
type Toast = { id: number; kind: "trashed" | "ok" | "err"; text: string; sub?: string; undo?: { p: string; entry: string }; ms: number };

// ---------- module state: the open dialog, the toast, and a counter that refreshes the Trash list ----------
let target: { p: string; s: string } | null = null, toast: Toast | null = null, ver = 0, toastN = 0;
const subs = new Set<() => void>();
const emit = () => { ver++; subs.forEach((f) => f()); };
const useVer = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => ver);
export const openTrash = (p: string, s: string) => { target = { p, s }; emit(); };
const closeTrash = () => { target = null; emit(); };
const showToast = (t: Omit<Toast, "id">) => { toast = { ...t, id: ++toastN }; emit(); };
const dropToast = (id: number) => { if (toast?.id === id) { toast = null; emit(); } };
const home = (s: string) => (s || "").replace(/^\/Users\/[^/]+/, "~");

export async function restore(p: string, entry: string, title?: string) {
  const r = await writeApi<{ ok: boolean }>("restore", { p, entry });
  showToast(r.ok ? { kind: "ok", text: "Restored", sub: title, ms: 3500 }
    : { kind: "err", text: "Not restored", sub: r.data.error || `refused (${r.status})`, ms: 9000 });
  emit();
  return r.ok;
}

/** The hover / focus button on a sidebar row (write mode only). Disabled on the chat that is open. */
export function TrashButton({ p, s, title, open }: { p: string; s: string; title: string; open: boolean }) {
  return <button className="trashbtn" disabled={open} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openTrash(p, s); }}
    aria-label={open ? `“${title}” is open: open another chat to move this one to the Trash` : `Move “${title}” to the Trash…`}
    title={open ? "This chat is open. Open another chat first to move it to the Trash." : "Move to the Trash…"}><TrashIcon /></button>;
}

/** Hosts the confirm dialog and the toast (App level: the row unmounts once its chat is gone). */
export function TrashHost() {
  useVer();
  useEffect(() => {   // screenshots only: ?static=1&trash=<p>/<s> opens the dialog (a dry run), &toast=demo shows the toast
    if (!STATIC) return;
    const t = QS.get("trash"); if (t && t.includes("/")) { const [p, s] = t.split("/"); openTrash(p, s); }
    if (QS.get("toast") === "demo") showToast({ kind: "trashed", text: "Moved to Trash", sub: "Example chat title", undo: { p: "-demo", entry: "demo" }, ms: 600000 });
  }, []);
  return <>{target && <TrashDialog key={target.p + target.s} p={target.p} s={target.s} />}{toast && <ToastView key={toast.id} t={toast} />}</>;
}

function TrashDialog({ p, s }: { p: string; s: string }) {
  const [info, setInfo] = useState<TrashInfo | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null), okRef = useRef<HTMLButtonElement>(null), cancelRef = useRef<HTMLButtonElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const now = useNow();
  useEffect(() => {
    writeApi<TrashInfo>("trash-info", { p, s }).then((r) => { if (r.ok) setInfo(r.data); else setErr(r.data.error || `refused (${r.status})`); });
    return () => { const b = back.current as HTMLElement | null; if (b && document.contains(b)) b.focus(); };
  }, []);
  const blocked = !info || !!info.refused || !!err;
  useEffect(() => { (blocked ? cancelRef : okRef).current?.focus(); }, [blocked]);
  const confirm = async () => {
    if (blocked || busy) return;
    setBusy(true);
    const r = await writeApi<{ ok: boolean; entry: string; title: string }>("trash", { p, s });
    setBusy(false);
    if (!r.ok) { setErr(r.data.error || `refused (${r.status})`); return; }
    closeTrash();
    showToast({ kind: "trashed", text: "Moved to Trash", sub: info?.title, undo: { p, entry: r.data.entry }, ms: 10000 });
  };
  useEffect(() => {   // Enter confirms, Esc cancels, Tab stays inside (capture: other Esc / key handlers never see these)
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeTrash(); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (document.activeElement === cancelRef.current) closeTrash(); else confirm(); }
      else if (e.key === "Tab") {
        const f = [...(box.current?.querySelectorAll<HTMLElement>("button:not([disabled])") || [])];
        if (!f.length) return;
        e.preventDefault(); e.stopPropagation();
        const i = f.indexOf(document.activeElement as HTMLElement);
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      } else if (!e.metaKey && !e.ctrlKey) e.stopPropagation();   // no theme / search shortcuts behind the dialog
    };
    addEventListener("keydown", k, true); return () => removeEventListener("keydown", k, true);
  });
  const idle = info ? Math.max(0, now / 1000 - info.mtime) : 0;
  return <>
    <div className="scrim open tscrim" onClick={closeTrash} />
    <div className="tdlg" role="alertdialog" aria-modal="true" aria-labelledby="tdlg-h" aria-describedby="tdlg-d" ref={box}>
      <div className="tdlg-h"><span className="tdlg-ico"><TrashIcon size={16} /></span><h2 id="tdlg-h">Move this chat to the Trash?</h2></div>
      {!info && !err && <div className="skel skel-line" style={{ margin: "12px 0", height: 60 }} />}
      {info && <>
        <div className="tdlg-title" title={info.title}>{info.title}</div>
        <dl className="tdlg-facts">
          <dt>Project</dt><dd title={info.path}><bdi>{home(info.path)}</bdi></dd>
          <dt>Last activity</dt><dd>{fmtDate(new Date(info.mtime * 1000).toISOString())} · {agoSecs(idle)}</dd>
          <dt>Messages</dt><dd>{info.msgs}</dd>
          <dt>Agents</dt><dd><Bot /> {info.agents} agent{info.agents === 1 ? "" : "s"} · {info.workflows} workflow{info.workflows === 1 ? "" : "s"}</dd>
          <dt>Size on disk</dt><dd>{fmtBytes(info.size)} · {info.files} file{info.files === 1 ? "" : "s"}</dd>
        </dl>
      </>}
      <p id="tdlg-d" className="tdlg-d">Moves it to the macOS Trash. You can restore it from Finder.
        <Info right label="What moves"><span className="li">The transcript <code>{s}.jsonl</code>{info?.has_dir ? <> and its folder (subagents, workflows, tool results)</> : null}, to <code>~/.Trash/Mission Control/{p}/</code></span>
          <span className="li">Nothing else under <code>~/.claude</code> is touched, and nothing is deleted</span>
          <span className="li">Undo, or Restore in the sidebar's Trash list, moves it back to the same place</span></Info></p>
      {(info?.refused || err) && <div className="cnote err" role="alert">{info?.refused || err}</div>}
      <div className="tdlg-acts">
        <button ref={cancelRef} className="btn" onClick={closeTrash}>Cancel</button>
        <button ref={okRef} className="btn danger" disabled={blocked || busy} onClick={confirm}>{busy ? "Moving…" : "Move to Trash"}</button>
      </div>
    </div>
  </>;
}

function ToastView({ t }: { t: Toast }) {
  const [undoing, setUndoing] = useState(false);
  useEffect(() => { const i = window.setTimeout(() => dropToast(t.id), t.ms); return () => clearTimeout(i); }, []);
  const undo = async () => { if (!t.undo || undoing) return; setUndoing(true); await restore(t.undo.p, t.undo.entry, t.sub); };
  return <div className={"toast " + t.kind} role="status" aria-live="polite">
    {t.kind === "trashed" && <span className="tdlg-ico"><TrashIcon /></span>}
    <span className="tmsg"><b>{t.text}</b>{t.sub && <small title={t.sub}>{t.sub}</small>}</span>
    {t.undo && <button className="btn undo" onClick={undo} disabled={undoing}>{undoing ? "Undoing…" : "Undo"}</button>}
    <button className="iconbtn" aria-label="Dismiss" onClick={() => dropToast(t.id)}>✕</button>
    <i className="tbar" style={{ animationDuration: `${t.ms}ms` }} />
  </div>;
}

/** Sidebar, bottom: the chats Mission Control moved to the Trash, each with Restore (write mode only). */
export function TrashSection() {
  const on = useWriteMode();
  const v = useVer(), rev = useChangeRev();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [open, setOpen] = useState(STATIC && QS.get("trashlist") === "1");
  const now = useNow();
  useEffect(() => { if (on) writeApi<{ items: TrashItem[] }>("trashed").then((r) => r.ok && setItems(r.data.items)); }, [on, v, rev]);
  if (!on || !items.length) return null;
  return <div className={"trashsec" + (open ? "" : " closed")}>
    <div className="sec-h"><button className="trash-tg" aria-expanded={open} onClick={() => setOpen((o) => !o)}><ChevronIcon size={12} className="chev" /> Trash</button><span className="sec-r"><span className="cnt">{items.length}</span>
      <Info right label="Legend: trash"><span className="li">Chats Mission Control moved to <code>~/.Trash/Mission Control/</code></span><span className="li"><b>Restore</b> moves one back to its original place, unless something is there now</span><span className="li">Emptying the macOS Trash deletes them for good</span></Info></span></div>
    {open && items.map((x) => <div key={x.p + x.entry} className="trow">
      <span style={{ minWidth: 0 }}><b title={x.title}>{x.title || x.s}</b>
        <small>{agoSecs(now / 1000 - x.trashed_at)} · {(home(x.cwd || "") || x.p).split("/").pop()} · {fmtBytes(x.size)}</small></span>
      <button className="iconbtn" disabled={!x.restorable} title={x.restorable ? "Move it back to its original place" : "A chat with this id already exists at the original place"}
        onClick={() => restore(x.p, x.entry, x.title)}>Restore</button>
    </div>)}
  </div>;
}

/** In place of a chat that was moved to the Trash (this tab still had it open). Clears itself after an Undo. */
export function useTrashed(p: string, s: string, present: boolean | null) {
  const [st, setSt] = useState<{ trashed: boolean; entry?: string } | null>(null);
  const v = useVer();
  useEffect(() => {
    if (present !== false) { setSt(null); return; }
    api<{ trashed: boolean; entry?: string }>("/api/trash-state", { p, s }).then(setSt).catch(() => {});
  }, [p, s, present, v]);
  return st?.trashed ? st : null;
}

export function TrashedNotice({ p, entry }: { p: string; entry?: string }) {
  const on = useWriteMode();
  return <div className="scroll"><div className="convo"><div className="empty gone">
    <span className="tdlg-ico"><TrashIcon size={16} /></span>
    <div><b>This chat was moved to the Trash</b>
      <p>Its files are in <code>~/.Trash/Mission Control/{p}/</code>. You can restore it from Finder{on ? ", or here:" : ", or with Restore in the sidebar's Trash list (write mode)."}</p>
      {on && entry && <button className="btn" onClick={() => restore(p, entry)}>Restore</button>}</div>
  </div></div></div>;
}
