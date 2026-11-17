import { memo, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { ago, hhmmss, MARK_KIND, useNow } from "../lib";

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
  return <div ref={ref} className={"tip" + (tip ? " on" : "")} role="tooltip">{tip && <>
    <div className="th"><span className="sw" style={{ background: k[1] }} />{k[0]}<span className="tm">{hhmmss(tip.t)}{tip.t2 && tip.t2 !== tip.t ? `–${hhmmss(tip.t2)}` : ""} · {ago(tip.t2 || tip.t, now)}</span></div>
    {tip.rows ? <div className="rows">{tip.rows.map((r, i) => <div key={i} className="rw"><span className="sw" style={{ background: (MARK_KIND[r.k] || MARK_KIND.tool)[1] }} /><span>{r.x}</span></div>)}
      {tip.more ? <div className="rw more">+ {tip.more} more</div> : null}</div> : <div className="tx">{tip.x}</div>}
    <div className="ft">{tip.ft ?? `action ${tip.n} of ${tip.of} · click to open in the timeline`}</div></>}</div>;
}

/** The tracker's ⓘ legend: a small icon whose popover opens on hover or focus (no inline legend rows). */
export function Info({ children, right, label }: { children: ReactNode; right?: boolean; label?: string }) {
  return (
    <span className="info" tabIndex={0} aria-label={label || "Legend"} onClick={(e) => e.stopPropagation()}>
      i<span className={"pop" + (right ? " right" : "")}>{children}</span>
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
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}><span className="tw">▶</span>{head}</div>
      {open && children ? <div className="fb">{children}</div> : null}
    </div>
  );
}

// Monochrome inline icons (currentColor), replacing emoji whose glyphs render blue on macOS.
const sv = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const Logo = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...sv}>
    <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" /><ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(-28 12 12)" />
    <circle cx="19.6" cy="7.6" r="1.4" fill="currentColor" stroke="none" />
  </svg>);
export const Bot = () => (
  <svg className="ico" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" {...sv}>
    <rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4M9 12.5h.01M15 12.5h.01M9.5 16h5" /></svg>);
export const Folder = () => (
  <svg className="ico" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" {...sv}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></svg>);
/** A run's icon from the tracker (pick_icon); its default satellite becomes the monochrome logo. */
export const RunIcon = ({ icon, size }: { icon?: string; size?: number }) => (!icon || icon === "🛰️" ? <Logo size={size} /> : <>{icon}</>);

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
