import { memo, ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Marked } from "marked";
import { ago, hhmmss, MARK_KIND, QS, STATIC, useNow } from "../lib";

/** The sparkline tooltip (tracker.py showTip()): follows the cursor, flips at the window edges, hides on any scroll.
 *  Shared by the agent cards' sparklines and the conversation outline strip. One is mounted per view; the last one
 *  rendered receives showTip(). `ft` replaces the footer, `rows` lists what an outline bucket holds, `t2` ends a time
 *  range, and `sticky` keeps it through scrolls (the outline scrolls the chat while you hover it). */
export type TipState = { k: string; t: string; x: string; n: number; of: number; cx: number; cy: number;
  ft?: string; t2?: string; rows?: { k: string; x: string }[]; more?: number; sticky?: boolean } | null;
let setTipGlobal: (t: TipState) => void = () => {};
export const showTip = (t: TipState) => setTipGlobal(t);

export function Tip() {
  const [tip, setTip] = useState<TipState>(null);
  const ref = useRef<HTMLDivElement>(null);
  const cur = useRef<TipState>(null); cur.current = tip;
  const now = useNow();
  setTipGlobal = setTip;
  useEffect(() => { const h = () => { if (!cur.current?.sticky) setTip(null); }; addEventListener("scroll", h, { passive: true, capture: true }); return () => removeEventListener("scroll", h, { capture: true } as any); }, []);
  useLayoutEffect(() => {   // tracker.py showTip(): follow the cursor, flip at the window edges
    const el = ref.current; if (!el || !tip) return;
    const r = el.getBoundingClientRect(), pad = 14;
    let left = tip.cx + pad, top = tip.cy + pad;
    if (left + r.width > innerWidth - 8) left = tip.cx - r.width - pad;
    if (top + r.height > innerHeight - 8) top = tip.cy - r.height - pad;
    el.style.left = Math.max(8, left) + "px"; el.style.top = Math.max(8, top) + "px";
  });
  const k = tip ? MARK_KIND[tip.k] || MARK_KIND.tool : MARK_KIND.tool;
  return createPortal(<div ref={ref} className={"tip" + (tip ? " on" : "")} role="tooltip">{tip && <>
    <div className="th"><span className="sw" style={{ background: k[1] }} />{k[0]}<span className="tm">{hhmmss(tip.t)}{tip.t2 && tip.t2 !== tip.t ? `–${hhmmss(tip.t2)}` : ""} · {ago(tip.t2 || tip.t, now)}</span></div>
    {tip.rows ? <div className="rows">{tip.rows.map((r, i) => <div key={i} className="rw"><span className="sw" style={{ background: (MARK_KIND[r.k] || MARK_KIND.tool)[1] }} /><span>{r.x}</span></div>)}
      {tip.more ? <div className="rw more">+ {tip.more} more</div> : null}</div> : <div className="tx">{tip.x}</div>}
    <div className="ft">{tip.ft ?? `action ${tip.n} of ${tip.of} · click to open in the timeline`}</div></>}</div>, document.body);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** The tracker's ⓘ legend: a small icon whose popover opens on hover or focus. The popover is portalled to <body>
 *  (position: fixed, placed from the trigger's rect, flipped to stay in the viewport), so no overflow, sticky header or
 *  stacking context can clip or cover it. Esc closes it. Screenshots: ?static=1&info=<label-slug> pins one open. */
export function Info({ children, right, label }: { children: ReactNode; right?: boolean; label?: string }) {
  const pin = STATIC && !!QS.get("info") && QS.get("info") === slug(label || "Legend");
  const [open, setOpen] = useState(pin);
  const tr = useRef<HTMLSpanElement>(null), pop = useRef<HTMLDivElement>(null), timer = useRef<number>();
  const id = useId();
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hide = () => { if (pin) return; clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(false), 120); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = tr.current, el = pop.current; if (!t || !el) return;
      const r = t.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, m = 8, gap = 8;
      let left = right ? r.right + 10 - w : r.left - 10;
      if (left + w > innerWidth - m) left = r.right + 10 - w;   // flip horizontally
      if (left < m) left = r.left - 10;
      left = Math.max(m, Math.min(left, innerWidth - m - w));
      let top = r.bottom + gap;
      if (top + h > innerHeight - m && r.top - gap - h >= m) top = r.top - gap - h;   // flip above
      top = Math.max(m, Math.min(top, innerHeight - m - h));
      el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`;
    };
    place();
    addEventListener("scroll", place, true); addEventListener("resize", place);
    return () => { removeEventListener("scroll", place, true); removeEventListener("resize", place); };
  }, [open, right]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span ref={tr} className={"info" + (open ? " on" : "")} tabIndex={0} role="button" aria-label={label || "Legend"} aria-describedby={id} aria-expanded={open}
      onClick={(e) => e.stopPropagation()} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={() => !pin && setOpen(false)}
      onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}>
      <InfoGlyph />
      {createPortal(<div ref={pop} id={id} role="tooltip" className={"ipop" + (open ? " on" : "")} hidden={!open}
        onMouseEnter={show} onMouseLeave={hide} onClick={(e) => e.stopPropagation()}>{children}</div>, document.body)}
    </span>
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const safeHref = (h: string) => (/^(https?:|mailto:|#)/i.test(h.trim()) ? h : "");

// Raw HTML in transcripts is shown as text, never rendered; links open in a new tab and only http(s)/mailto pass.
const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    html(token: any) { return escapeHtml(token.text || token.raw || ""); },
    link(this: any, token: any) {
      const h = safeHref(token.href || "");
      const inner = this.parser.parseInline(token.tokens || []);
      return h ? `<a href="${escapeHtml(h)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
    },
    image(token: any) { return `<span class="imgph">🖼 ${escapeHtml(token.text || "image")}</span>`; },
  },
});

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    try { return md.parse(text || "", { async: false }) as string; } catch { return escapeHtml(text || ""); }
  }, [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** A collapsible block (thinking, meta, tool call). */
export function Fold({ head, children, className = "", defaultOpen = false, open: ctrl, onToggle }: {
  head: ReactNode; children?: ReactNode; className?: string; defaultOpen?: boolean; open?: boolean; onToggle?: (o: boolean) => void;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = ctrl ?? own;
  const toggle = () => { const n = !open; setOwn(n); onToggle?.(n); };
  return (
    <div className={`fold ${open ? "open" : ""} ${className}`}>
      <div className="fh" role="button" tabIndex={0} aria-expanded={open} onClick={toggle}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}><ChevronIcon size={12} className="tw" />{head}</div>
      {open && children ? <div className="fb">{children}</div> : null}
    </div>
  );
}

// The icon set: monochrome line icons (stroke 1.75, currentColor) at 12 / 14 / 16 px, in fixed boxes (.ico is
// display:block inside an inline-grid .ibox, so it centres the same in buttons, rows and text).
const sv = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
type IP = { size?: number; className?: string };
const mk = (paths: ReactNode, vb = 24) => ({ size = 14, className = "" }: IP) => (
  <span className={"ibox " + className} style={{ width: size, height: size }} aria-hidden="true">
    <svg className="ico" width={size} height={size} viewBox={`0 0 ${vb} ${vb}`} {...sv}>{paths}</svg></span>);
export const Logo = ({ size = 18 }: { size?: number }) => (
  <span className="ibox" style={{ width: size, height: size }} aria-hidden="true">
  <svg className="ico" width={size} height={size} viewBox="0 0 24 24" {...sv}>
    <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" /><ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(-28 12 12)" />
    <circle cx="19.6" cy="7.6" r="1.4" fill="currentColor" stroke="none" />
  </svg></span>);
const BotI = mk(<><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4M9 12.5h.01M15 12.5h.01M9.5 16h5" /></>);
export const Bot = ({ size = 12 }: IP) => <BotI size={size} />;
const FolderI = mk(<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />);
export const Folder = ({ size = 12 }: IP) => <FolderI size={size} />;
export const TrashIcon = mk(<path d="M4 7h16M9.5 7V4.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8V7M6.5 7l.9 12a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.9-12M10 11v6M14 11v6" />);
export const ChatIcon = mk(<path d="M5 18.5V6.8A1.8 1.8 0 0 1 6.8 5h10.4A1.8 1.8 0 0 1 19 6.8v7.4a1.8 1.8 0 0 1-1.8 1.8H9z" />);
export const ClockIcon = mk(<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>);
export const PencilIcon = mk(<path d="M14.5 5.5l4 4M4.5 19.5l1-4.5L15.8 4.7a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L9 18.5z" />);
export const ListIcon = mk(<path d="M5 7h14M5 12h14M5 17h9" />);
export const GearIcon = mk(<><circle cx="12" cy="12" r="2.8" /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6" /></>);
export const ChevronIcon = mk(<path d="M8 10l4 4 4-4" />);
export const StarIcon = ({ on, size = 14 }: { on?: boolean; size?: number }) => (
  <span className="ibox" style={{ width: size, height: size }} aria-hidden="true">
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" {...sv} fill={on ? "currentColor" : "none"}>
      <path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" /></svg></span>);
const InfoGlyph = () => <svg className="ico" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
  <circle cx="5" cy="2.1" r="1" fill="currentColor" /><path d="M5 4.3v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
/** A run's icon from the tracker (pick_icon); its default satellite becomes the monochrome logo. */
export const RunIcon = ({ icon, size = 18 }: { icon?: string; size?: number }) => (!icon || icon === "🛰️" ? <Logo size={size} />
  : <span className="ibox emo" style={{ width: size, height: size, fontSize: Math.round(size * .86) }} aria-hidden="true">{icon}</span>);

/** Sizes the side feed panel of a dashboard (.wrap > .main > aside.panel) to fill its column: sticky under the header,
 *  at least down to the viewport bottom from where it starts, at most one viewport tall, never taller than needed. */
export function useFeedHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const w = ref.current, sc = w?.closest(".scroll") as HTMLElement | null;
    if (!w || !sc) return;
    const run = () => {
      const head = w.querySelector(".mc-header") as HTMLElement | null, panel = w.querySelector(".main > aside.panel") as HTMLElement | null;
      const left = w.querySelector(".main > div") as HTMLElement | null;
      if (!panel) return;
      const mch = head ? head.getBoundingClientRect().height : 0;
      const view = sc.clientHeight;
      const top = panel.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;   // panel top at scroll 0
      const natural = view - top - 16, cap = view - mch - 24, leftH = left ? left.getBoundingClientRect().height : 0;
      const h = Math.max(220, Math.max(natural, Math.min(cap, leftH)));
      w.style.setProperty("--mch", `${Math.round(mch)}px`);
      w.style.setProperty("--feedh", `${Math.round(h)}px`);
    };
    const ro = new ResizeObserver(run);
    ro.observe(sc); ro.observe(w);
    const left = w.querySelector(".main > div"); if (left) ro.observe(left);
    run();
    return () => ro.disconnect();
  });
  return ref;
}
