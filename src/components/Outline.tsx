// Conversation outline: a slim vertical strip on the right of the transcript, one mark per entry of the WHOLE chat
// (from /api/outline, not only the loaded page), coloured like the agent cards' sparkline (MARK_KIND), with the same
// tooltip (Tip). Hovering shows a quick preview in the tooltip; a click jumps the chat there; a translucent box (the lens)
// shows what is on screen. Long chats are bucketed into ~3 px rows coloured by their dominant kind (a prompt or an error wins).
// Dragging the lens scrolls the chat live; while dragged the strip zooms into one mark per entry around the lens (a thin
// mini-map on its left edge shows which part of the chat the zoomed window covers), and zooms back out on release. The
// whole chat stays reachable mid-drag: the window pans at the strip's edges (faster the further past them), with the
// wheel, and by moving the pointer left of the strip, where its height maps to the whole chat like the mini-map.
import { RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, MARK_KIND, QS, STATIC, useChangeRev } from "../lib";
import { showTip, Tip } from "./bits";

/** [seq, kind, ts, size hint, label] */
export type Mark = [number, string, string | null, number, string];
type OutResp = { items: Mark[]; rev: number; epoch: number; total: number };
type Row = { i0: number; i1: number; top: number; h: number; k: string; w: number; target: number };
/** Options of a seek: `hl` flashes the entry, `off` is where its top lands, in px below the viewport top (default 12). */
export type SeekOpt = { hl?: boolean; off?: number };
/** The zoomed window while the lens is dragged: first entry index (fractional: it pans smoothly), lens top entry, lens
 *  height in entries, px per entry. */
type Zoom = { w0: number; cur: number; span: number; px: number };
type Drag = { id: number; y0: number; y: number; cx: number; on: boolean; grab: number; dir: number; cur: number; w0: number;
  span: number; raf: number; t: number; anchor: { seq: number; off: number } | null; key: (e: KeyboardEvent) => void;
  map: boolean;                  // the pointer is left of the strip: its height maps to the whole chat
  v: number; pc: number; pt: number };   // how fast the lens travels (entries/s, smoothed), to defer page loads

const ROW = 3, MAXSLOT = 10, THROTTLE = 60;
const LANDOFF = 2;   // lens seeks land the entry 2 px under the viewport top, so it is the first one the lens shows
const EDGE = 20;     // px at the strip's top and bottom where a dragged lens keeps panning the zoomed window
const MAPX = 10;     // px left of the strip from where a drag scrubs the whole chat (the mini-map's scale)
const FAST = 40;     // entries/s: above this a lens over pages not loaded yet waits for the pan to slow down
/** Auto-pan speed in entries/s for a pointer `depth` px past the inner edge line: slow near it, very fast far past it. */
const panSpeed = (depth: number) => Math.min(4000, 10 + 0.3 * Math.pow(Math.max(0, depth), 1.5));
const zoomPx = (H: number) => Math.max(7, Math.min(11, Math.round(H / 80)));   // ~±40 entries, marks 5–9 px tall
const sizeW = (m: Mark) => (m[1] === "user" ? 1 : 0.3 + 0.7 * Math.min(1, Math.log10(1 + (m[3] || 0)) / 4.6));
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- DOM helpers shared with Transcript: entries carry data-seq (a turn's blocks, or a hidden anchor before an item) ----------
export const seqEls = (box: HTMLElement) => box.querySelectorAll<HTMLElement>("[data-seq]");
/** The element to measure for a data-seq node: a hidden anchor stands for the item right after it. */
export const nodeOf = (el: HTMLElement) => (el.hidden ? (el.nextElementSibling as HTMLElement | null) || el : el);
/** The rendered element of an entry, or of the nearest rendered entry before it (results attach to their call). */
export function findSeq(box: HTMLElement, seq: number): HTMLElement | null {
  const els = seqEls(box);
  let lo = 0, hi = els.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (+els[m].dataset.seq! <= seq) { best = m; lo = m + 1; } else hi = m - 1; }
  return best < 0 ? (els[0] ? nodeOf(els[0]) : null) : nodeOf(els[best]);
}
/** First and last entry seq at least partly inside the scroller's viewport. */
export function visibleSeqs(box: HTMLElement): [number, number] | null {
  const els = seqEls(box);
  if (!els.length) return null;
  const r = box.getBoundingClientRect();
  const firstBelow = (y: number, edge: "top" | "bottom") => {   // first index whose rect[edge] > y
    let lo = 0, hi = els.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (nodeOf(els[m]).getBoundingClientRect()[edge] > y) hi = m; else lo = m + 1; }
    return lo;
  };
  const a = Math.min(els.length - 1, firstBelow(r.top + 1, "bottom"));
  const b = Math.max(a, firstBelow(r.bottom - 1, "top") - 1);
  return [+els[a].dataset.seq!, +els[b].dataset.seq!];
}

function layout(marks: Mark[], H: number): { rows: Row[]; slot: number } {
  const N = marks.length;
  if (!N || H < 24) return { rows: [], slot: 0 };
  const cap = Math.max(1, Math.floor(H / ROW)), nb = Math.min(N, cap);
  const slot = N <= cap ? Math.min(MAXSLOT, H / N) : H / nb;
  const rows: Row[] = [];
  for (let b = 0; b < nb; b++) {
    const i0 = Math.floor((b * N) / nb), i1 = Math.max(i0 + 1, Math.floor(((b + 1) * N) / nb));
    const cnt: Record<string, number> = {};
    let size = 0, user = -1, err = false;
    for (let i = i0; i < i1; i++) {
      const m = marks[i]; cnt[m[1]] = (cnt[m[1]] || 0) + 1; size += m[3] || 0;
      if (m[1] === "user" && user < 0) user = i;
      if (m[1] === "error") err = true;
    }
    const k = user >= 0 ? "user" : err ? "error" : Object.entries(cnt).sort((x, y) => y[1] - x[1])[0][0];
    // length encodes size, within limits: 30% … 100% of the strip on a log scale (prompts always span it)
    const w = user >= 0 ? 1 : 0.3 + 0.7 * Math.min(1, Math.log10(1 + size) / 4.6);
    const top = Math.round(b * slot), bot = Math.round((b + 1) * slot);
    rows.push({ i0, i1, top, h: Math.max(2, bot - top - (slot >= 3 ? 1 : 0)), k, w, target: marks[user >= 0 ? user : i0][0] });
  }
  return { rows, slot };
}

type Props = {
  p: string; s: string; a?: string;
  box: RefObject<HTMLDivElement>;      // the transcript's scroller
  loaded: string;                      // changes whenever the loaded entries change: re-measure the viewport box
  seek: (seq: number, smooth: boolean, o?: SeekOpt) => void;
  loading: boolean;                    // older pages are loading for a seek
};

export function Outline({ p, s, a, box, loaded, seek, loading }: Props) {
  const rev = useChangeRev(p, s);
  const [marks, setMarks] = useState<Mark[]>([]);
  const meta = useRef({ rev: 0, epoch: -1, busy: false, again: false });

  // the whole chat's marks: everything once, then only what was added or changed (by rev); a rewritten file starts over
  const pull = useCallback(async () => {
    const m = meta.current;
    if (m.busy) { m.again = true; return; }
    m.busy = true;
    try {
      do {
        m.again = false;
        let r = await api<OutResp>("/api/outline", { p, s, a, rev: m.epoch < 0 ? 0 : m.rev });
        if (m.epoch >= 0 && r.epoch !== m.epoch) r = await api<OutResp>("/api/outline", { p, s, a, rev: 0 });
        const fresh = m.epoch < 0 || r.epoch !== m.epoch;
        m.rev = r.rev; m.epoch = r.epoch;
        if (fresh) setMarks(r.items);
        else if (r.items.length) setMarks((old) => {
          const at = new Map(old.map((x, i) => [x[0], i])), out = old.slice();
          let sorted = true;
          for (const x of r.items) {
            const i = at.get(x[0]);
            if (i !== undefined) out[i] = x;
            else { if (out.length && out[out.length - 1][0] > x[0]) sorted = false; out.push(x); }
          }
          if (!sorted) out.sort((x, y) => x[0] - y[0]);
          return out;
        });
      } while (m.again);
    } catch (_) { /* the next change event retries */ } finally { m.busy = false; }
  }, [p, s, a]);
  useEffect(() => { pull(); }, [rev, pull]);

  // strip height -> rows
  const track = useRef<HTMLDivElement>(null);
  const [H, setH] = useState(0);
  useLayoutEffect(() => {
    const el = track.current; if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el); setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const { rows, slot } = useMemo(() => layout(marks, H), [marks, H]);
  const rowOfMark = useCallback((i: number) => {   // the row holding mark i
    let lo = 0, hi = rows.length - 1, best = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].i0 <= i) { best = m; lo = m + 1; } else hi = m - 1; }
    return best;
  }, [rows]);
  const markOfSeq = useCallback((seq: number) => {   // the last mark at or before seq
    let lo = 0, hi = marks.length - 1, best = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (marks[m][0] <= seq) { best = m; lo = m + 1; } else hi = m - 1; }
    return best;
  }, [marks]);

  // the viewport box: which entries are on screen, mapped onto the strip (from data-seq, not a scroll ratio: the DOM
  // holds only the loaded tail of the chat)
  const [vp, setVp] = useState<{ top: number; h: number; first: number; a: number; b: number } | null>(null);
  const measure = useCallback(() => {
    const el = box.current;
    if (!el || !rows.length) { setVp(null); return; }
    const v = visibleSeqs(el);
    if (!v) { setVp(null); return; }
    const a = markOfSeq(v[0]), b = markOfSeq(v[1]);
    const ra = rows[rowOfMark(a)], rb = rows[rowOfMark(b)];
    const top = ra.top, h = Math.max(6, rb.top + Math.max(rb.h, 2) - top);
    setVp((o) => (o && o.top === top && o.h === h && o.first === v[0] && o.a === a && o.b === b ? o : { top, h, first: v[0], a, b }));
  }, [box, rows, rowOfMark, markOfSeq]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    let raf = 0;
    const on = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    el.addEventListener("scroll", on, { passive: true });
    const ro = new ResizeObserver(on); ro.observe(el);
    on();
    return () => { el.removeEventListener("scroll", on); ro.disconnect(); cancelAnimationFrame(raf); };
  }, [box, measure]);
  useEffect(() => { const r = requestAnimationFrame(measure); return () => cancelAnimationFrame(r); }, [loaded, measure]);

  // ---------- hover: a quick preview in the tooltip only; click jumps the chat there ----------
  const [hov, setHov] = useState(-1);
  const [pinned, setPinned] = useState(false);
  const th = useRef({ last: 0, timer: 0, seq: -1, sent: -1 });
  const focusSeq = useRef<number | null>(null);
  const go = useCallback((seq: number, smooth: boolean, o?: SeekOpt) => { th.current.sent = seq; focusSeq.current = seq; seek(seq, smooth, o); }, [seek]);
  const drag = useRef<Drag | null>(null);
  const swallow = useRef(false);   // eat the click that follows a lens drag (pointer capture sends it to the strip)
  // a dragged lens scrolls the chat to the entry under its top, instantly, at most every THROTTLE ms (the last one always
  // lands). Over pages not loaded yet a fast pan waits until it slows down, so it doesn't fire a load per frame.
  const loadedStart = +loaded.split("/")[0] || 0;
  const scrub = (seq: number, fast: boolean) => {
    const t = th.current; t.seq = seq;
    if (seq === t.sent) return;
    const fire = () => { t.last = performance.now(); go(t.seq, false, { hl: false, off: LANDOFF }); };
    const later = () => { t.timer = 0; if (drag.current?.on && t.seq !== t.sent) fire(); };
    if (fast && seq < loadedStart) { window.clearTimeout(t.timer); t.timer = window.setTimeout(later, 160); return; }
    const wait = THROTTLE - (performance.now() - t.last);
    if (wait <= 0) { window.clearTimeout(t.timer); t.timer = 0; fire(); }
    else if (!t.timer) t.timer = window.setTimeout(later, wait);
  };
  useEffect(() => () => window.clearTimeout(th.current.timer), []);
  const rowAt = (clientY: number) => {
    const el = track.current; if (!el || !rows.length) return -1;
    const y = clientY - el.getBoundingClientRect().top;
    const last = rows[rows.length - 1];
    if (y > last.top + Math.max(slot, last.h) + 6) return -1;   // below the last mark of a short chat
    let lo = 0, hi = rows.length - 1, best = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].top <= y) { best = m; lo = m + 1; } else hi = m - 1; }
    return best;
  };
  const tipFor = (b: number, cx: number, cy: number, pin = pinned) => {
    const r = rows[b], N = marks.length, one = r.i1 - r.i0 === 1, m0 = marks[r.i0], m1 = marks[r.i1 - 1];
    const hint = pin ? "shown in the chat" : "click to jump there";
    if (one) return showTip({ k: m0[1], t: m0[2] || "", x: m0[4], n: r.i0 + 1, of: N, cx, cy, sticky: true, ft: `entry ${r.i0 + 1} of ${N} · ${hint}` });
    const list = marks.slice(r.i0, r.i1), shown = list.slice(0, 6);
    showTip({ k: r.k, t: m0[2] || "", t2: m1[2] || "", x: "", n: r.i0 + 1, of: N, cx, cy, sticky: true,
      rows: shown.map((x) => ({ k: x[1], x: x[4] })), more: list.length - shown.length, ft: `entries ${r.i0 + 1}–${r.i1} of ${N} · ${hint}` });
  };
  const onMove = (e: React.MouseEvent) => {
    if (drag.current?.on) return;
    const b = rowAt(e.clientY);
    if (b < 0) { setHov(-1); showTip(null); return; }
    setHov(b); tipFor(b, e.clientX, e.clientY);
  };
  const onLeave = () => { if (drag.current?.on) return; setHov(-1); setPinned(false); showTip(null); };
  const onClick = (e: React.MouseEvent) => {
    if (swallow.current) { swallow.current = false; return; }   // the click that ends a lens drag
    const b = rowAt(e.clientY); if (b < 0) return;
    window.clearTimeout(th.current.timer); th.current.timer = 0;
    go(rows[b].target, true); setPinned(true); tipFor(b, e.clientX, e.clientY, true);
  };

  // ---------- keyboard: ↑/↓ between your prompts, Home/End to the ends ----------
  const users = useMemo(() => marks.map((m, i) => (m[1] === "user" ? i : -1)).filter((i) => i >= 0), [marks]);
  const tipAtRow = (b: number) => {
    const el = track.current; if (!el) return;
    const r = el.getBoundingClientRect();
    tipFor(b, r.left - 4, r.top + rows[b].top, false);
  };
  const jumpMark = (i: number) => { if (i < 0 || i >= marks.length) return; const b = rowOfMark(i); setHov(b); go(marks[i][0], true); tipAtRow(b); };
  const onKey = (e: React.KeyboardEvent) => {
    if (!marks.length) return;
    const cur = focusSeq.current ?? vp?.first ?? marks[marks.length - 1][0];
    let i = -1;
    if (e.key === "ArrowDown") i = users.find((u) => marks[u][0] > cur) ?? -1;
    else if (e.key === "ArrowUp") i = [...users].reverse().find((u) => marks[u][0] < cur) ?? -1;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = marks.length - 1;
    else if (e.key === "PageUp" || e.key === "PageDown") {   // the lens moves by one screen: scroll the chat by one
      e.preventDefault();
      const el = box.current; if (!el) return;
      focusSeq.current = null; setHov(-1); showTip(null);
      el.scrollBy({ top: (e.key === "PageUp" ? -1 : 1) * Math.max(40, el.clientHeight - 48), behavior: reducedMotion() || STATIC ? "auto" : "smooth" });
      return;
    }
    else return;
    e.preventDefault();
    jumpMark(i);
  };
  const curPrompt = useMemo(() => {   // the prompt at or above the viewport top (aria-valuenow)
    const at = focusSeq.current ?? vp?.first;
    if (at == null) return 0;
    let n = 0; for (const u of users) { if (marks[u][0] <= at) n++; else break; }
    return n;
  }, [users, marks, vp]);

  // ---------- drag the lens: the chat follows live, the strip zooms into the entries around it ----------
  const N = marks.length, Z = zoomPx(H), win = H / Z;    // win: entries the zoomed window shows
  const maxW0 = Math.max(0, N - win);
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [phase, setPhase] = useState<"" | "prep" | "in" | "on" | "out">("");   // zoom animation: in, held, back out
  const phaseT = useRef(0);
  const lensH = (span: number) => Math.min(H * 0.6, Math.max(Z, span * Z));
  const lensTip = (d: Drag, i: number) => {
    const el = track.current, m = marks[i]; if (!el || !m) return;
    const cy = el.getBoundingClientRect().top + (d.cur - d.w0) * Z + Math.min(lensH(d.span), 12) / 2;
    showTip({ k: m[1], t: m[2] || "", x: m[4], n: i + 1, of: N, cx: d.cx, cy, sticky: true,
      ft: `entry ${i + 1} of ${N} · ${d.map ? "whole chat: move right to fine-tune" : "release to stay here"} · esc goes back` });
  };
  const clampW0 = (w: number) => Math.max(0, Math.min(maxW0, w));
  // the lens follows the pointer 1:1 at the zoomed scale (or, left of the strip, at the whole chat's scale); its top
  // entry is what the chat shows
  const apply = (d: Drag) => {
    if (d.map) {
      const c = Math.max(0, Math.min(N - d.span, (d.y / H) * N));
      d.w0 = clampW0(c - win / 2); d.cur = c;
      d.grab = d.y - (c - d.w0) * Z;   // coming back onto the strip continues from here, without a jump
    } else {
      const top = Math.max(0, Math.min(H - lensH(d.span), d.y - d.grab));
      d.cur = Math.max(0, Math.min(N - 1, d.w0 + top / Z));
    }
    const now = performance.now(), dt = Math.max(1, now - d.pt);
    d.v = 0.7 * d.v + 0.3 * (Math.abs(d.cur - d.pc) * 1000) / dt; d.pc = d.cur; d.pt = now;
    setZoom({ w0: d.w0, cur: d.cur, span: d.span, px: Z });
    const i = Math.floor(d.cur + 1e-6), seq = marks[i][0];
    scrub(seq, d.v > FAST);
    lensTip(d, i);
  };
  // auto-pan: with the pointer in the top or bottom EDGE px, or anywhere past them (captured), the window keeps moving
  // that way, faster the further the pointer goes, with no limit: one drag crosses the whole chat
  const loop = (now: number) => {
    const d = drag.current; if (!d || !d.on) return;
    const dt = Math.min(50, now - d.t) / 1000; d.t = now;
    let v = 0;   // entries per second
    if (!d.map && d.y < EDGE && (d.dir < 0 || d.y < 0)) v = -panSpeed(EDGE - d.y);
    else if (!d.map && d.y > H - EDGE && (d.dir > 0 || d.y > H)) v = panSpeed(d.y - (H - EDGE));
    if (v) { const w = clampW0(d.w0 + v * dt); if (w !== d.w0) { d.w0 = w; apply(d); } }
    else if (d.v > 1) { d.v *= 0.8; if (d.v <= FAST) apply(d); }   // the pan stopped: let a deferred load go
    d.raf = requestAnimationFrame((t) => fx.current.loop(t));
  };
  // the wheel: while dragging it pans the zoomed window (and the lens with it); otherwise it scrolls the chat, as over it
  const wheel = (e: WheelEvent) => {
    if (e.ctrlKey) return;   // pinch-zoom
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * H : e.deltaY;
    e.preventDefault();
    const d = drag.current;
    if (d?.on) { if (!d.map) { d.w0 = clampW0(d.w0 + dy / Z); apply(d); } return; }
    box.current?.scrollBy({ top: dy });
  };
  const begin = (d: Drag) => {
    const bx = box.current;
    if (!vp || !N || !bx) return;
    const span = Math.max(1, Math.min(Math.floor(win * 0.6), vp.b - vp.a + 1));
    const f = Math.max(0, Math.min(1, (d.y0 - vp.top) / Math.max(1, vp.h)));   // where in the lens it was grabbed
    d.w0 = Math.max(0, Math.min(maxW0, vp.a + f * span - d.y0 / Z));            // keep that entry under the pointer
    d.grab = d.y0 - (vp.a - d.w0) * Z;
    d.span = span; d.cur = vp.a; d.pc = vp.a; d.on = true; d.t = d.pt = performance.now();
    const n = findSeq(bx, vp.first);   // Esc restores this exact reading position (scrollTop moves when pages prepend)
    d.anchor = n ? { seq: vp.first, off: n.getBoundingClientRect().top - bx.getBoundingClientRect().top } : null;
    th.current.sent = marks[vp.a][0];
    setHov(-1); setPinned(false);
    document.documentElement.classList.add("odrag");
    window.addEventListener("keydown", d.key, true);
    d.raf = requestAnimationFrame((t) => fx.current.loop(t));
    window.clearTimeout(phaseT.current);
    if (reducedMotion()) setPhase("on");
    else {
      setPhase("prep");   // the zoomed layer mounts at the overview's scale, then animates in
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (drag.current !== d) return;
        setPhase("in");
        phaseT.current = window.setTimeout(() => { if (drag.current === d) setPhase("on"); }, 160);
      }));
    }
    apply(d);
  };
  const end = (cancel: boolean) => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.raf);
    window.removeEventListener("keydown", d.key, true);
    document.documentElement.classList.remove("odrag");
    try { track.current?.releasePointerCapture(d.id); } catch (_) {}
    if (!d.on) return;   // never moved: the click that follows jumps, as before
    swallow.current = true;
    const t = th.current; window.clearTimeout(t.timer); t.timer = 0;
    showTip(null);
    if (cancel && d.anchor) {
      t.sent = d.anchor.seq; focusSeq.current = null;
      seek(d.anchor.seq, false, { hl: false, off: d.anchor.off });
      document.body.dataset.lensDrop = "cancel:" + d.anchor.seq;
    } else if (N) {
      const seq = marks[Math.floor(d.cur + 1e-6)][0];
      go(seq, true, { off: LANDOFF });   // a smooth settle on the dropped entry
      document.body.dataset.lensDrop = String(seq);
    }
    window.clearTimeout(phaseT.current);
    if (reducedMotion()) { setPhase(""); setZoom(null); }
    else { setPhase("out"); phaseT.current = window.setTimeout(() => { setPhase(""); setZoom(null); }, 170); }
  };
  const fx = useRef({ loop, end, wheel }); fx.current = { loop, end, wheel };
  useEffect(() => {   // not React's onWheel: that one is passive, and the wheel must not also scroll the page
    const el = track.current; if (!el) return;
    const h = (e: WheelEvent) => fx.current.wheel(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);
  useEffect(() => () => { const d = drag.current; if (d) { cancelAnimationFrame(d.raf); window.removeEventListener("keydown", d.key, true); document.documentElement.classList.remove("odrag"); } window.clearTimeout(phaseT.current); }, []);

  const yOf = (clientY: number) => clientY - (track.current?.getBoundingClientRect().top ?? 0);
  const onPointerDown = (e: React.PointerEvent) => {
    swallow.current = false;
    if (e.button !== 0 || !vp || !(e.target as HTMLElement).closest(".ovp")) return;   // off the lens: click-to-jump
    e.preventDefault();   // no text selection, no native drag
    const el = track.current!;
    el.focus({ preventScroll: true, focusVisible: false } as FocusOptions);   // keys work, no focus ring for a mouse drag
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    const y = yOf(e.clientY);
    drag.current = { id: e.pointerId, y0: y, y, cx: e.clientX, on: false, grab: 0, dir: 0, cur: 0, w0: 0, span: 1, raf: 0, t: 0, anchor: null,
      map: false, v: 0, pc: 0, pt: 0,
      key: (ev) => { if (ev.key === "Escape" && drag.current?.on) { ev.preventDefault(); ev.stopPropagation(); fx.current.end(true); } } };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || e.pointerId !== d.id) return;
    const y = yOf(e.clientY);
    if (y !== d.y) d.dir = Math.sign(y - d.y);
    d.y = y; d.cx = e.clientX;
    if (!d.on) { if (Math.abs(y - d.y0) >= 3) begin(d); return; }
    const left = track.current ? track.current.getBoundingClientRect().left : 0;
    d.map = e.clientX < left - MAPX;
    apply(d);
  };
  const onPointerUp = (e: React.PointerEvent) => { if (drag.current && e.pointerId === drag.current.id) end(false); };

  // ---------- test hook: ?outline=<seq> jumps there once (instantly) and shows the hovered mark with its tooltip ----------
  const hook = useRef(QS.get("outline"));
  useEffect(() => {
    if (hook.current == null || !rows.length || !box.current) return;
    const seq = +hook.current; hook.current = null;
    if (!Number.isFinite(seq)) return;
    const b = rowOfMark(markOfSeq(seq));
    focusSeq.current = seq; th.current.sent = seq;
    seek(seq, false); setHov(b);
    requestAnimationFrame(() => tipAtRow(b));
  });

  // the zoom: the overview scales up by k around the point that maps onto the zoomed window, the per-entry layer scales
  // from 1/k to 1 around the same point, crossfading; that point moves with the window, so zooming out lands where dropped
  const zoomed = !!zoom && (phase === "in" || phase === "on");
  const per = N && rows.length === N ? slot : H / Math.max(1, N);   // overview px per entry
  const k = zoom ? Math.max(1, zoom.px / Math.max(per, 0.01)) : 1;
  const oy = zoom && k > 1.01 ? (zoom.w0 * zoom.px) / (k - 1) : 0;
  const lag = zoomed && N > 0 && marks[Math.min(N - 1, Math.floor(zoom!.cur + 1e-6))][0] < loadedStart;   // over entries not loaded yet
  const lens = zoomed ? { top: (zoom!.cur - zoom!.w0) * zoom!.px, h: lensH(zoom!.span) } : vp;
  const cls = "ostrip" + (hov >= 0 ? " hov" : "") + (loading ? " busy" : "") + (pinned ? " pinned" : "") + (zoom && phase ? " z-" + phase : "") + (drag.current?.map ? " map" : "") + (lag ? " busy" : "");
  return (
    <div className={cls} ref={track} tabIndex={0} role="slider" aria-orientation="vertical" data-zoom={phase || undefined}
      data-lens={vp ? `${vp.a}-${vp.b}` : undefined}
      style={{ "--k": k, "--oy": `${oy}px` } as React.CSSProperties}
      aria-label="Conversation outline: hover for a quick preview, click to jump there, drag the lens to scroll; the bar zooms while dragging (hold past its ends, use the wheel, or move left of it to reach the whole chat). ↑ and ↓ jump between your prompts, Page Up and Page Down move by one screen"
      aria-valuemin={0} aria-valuemax={users.length} aria-valuenow={curPrompt}
      aria-valuetext={users.length ? `prompt ${curPrompt} of ${users.length}` : "no prompts"} aria-busy={loading || undefined}
      onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick} onKeyDown={onKey}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onLostPointerCapture={() => { if (drag.current) end(false); }}
      onBlur={() => { if (drag.current?.on) return; setHov(-1); showTip(null); }}>
      <div className="olay ov">{rows.map((r, b) => {
        const c = (MARK_KIND[r.k] || MARK_KIND.tool)[1];
        const near = hov >= 0 && Math.abs(b - hov) === 1;
        return <i key={b} className={(r.k === "user" ? "u" : "") + (b === hov ? " on" : near ? " nb" : "")}
          style={{ top: r.top, height: r.h, width: r.k === "user" ? undefined : `calc(${(r.w * 100).toFixed(1)}% - 4px)`, background: c, color: c }} />;
      })}</div>
      {zoom && phase && (() => {
        const i0 = Math.max(0, Math.floor(zoom.w0)), i1 = Math.min(N, Math.ceil(zoom.w0 + H / zoom.px) + 1), at = Math.floor(zoom.cur + 1e-6);
        const before = Math.floor(zoom.w0 + 0.5), after = Math.max(0, N - Math.ceil(zoom.w0 + win - 0.5));   // entries outside the window
        return <>
          {zoomed && before > 0 && <div className="ohint up" aria-hidden="true">▲ {before} earlier</div>}
          {zoomed && after > 0 && <div className="ohint dn" aria-hidden="true">▼ {after} later</div>}
          <div className={"olay zm" + (before > 0 ? " fu" : "") + (after > 0 ? " fd" : "")} aria-hidden="true"><div className="zin" style={{ transform: `translateY(${(-zoom.w0 * zoom.px).toFixed(2)}px)` }}>
            {marks.slice(i0, i1).map((m, j) => {
              const i = i0 + j, c = (MARK_KIND[m[1]] || MARK_KIND.tool)[1];
              return <i key={i} className={(m[1] === "user" ? "u" : "") + (i === at ? " on" : "")}
                style={{ top: i * zoom.px, height: zoom.px - 2, width: m[1] === "user" ? undefined : `calc((100% - 8px) * ${sizeW(m).toFixed(3)})`, background: c, color: c }} />;
            })}
          </div></div>
          <div className="omap" aria-hidden="true">
            <b style={{ top: `${(zoom.w0 / N) * 100}%`, height: `max(4px, ${Math.min(1, win / N) * 100}%)` }} />
            <u style={{ top: `${(zoom.cur / N) * 100}%` }} />
          </div>
        </>;
      })()}
      {lens && <div className="ovp" title="Drag to scroll the chat: the bar zooms in while you drag. Hold past its ends or use the wheel to go further, move left of the bar for the whole chat, Esc goes back" style={{ top: lens.top - 1, height: lens.h + 2 }} />}
      {(loading || lag) && <div className="oload" style={{ top: lens && zoomed ? lens.top : hov >= 0 ? rows[hov].top : 0 }} aria-hidden="true" />}
      <Tip />
    </div>
  );
}
