// Conversation outline: a slim vertical strip on the right of the transcript, one mark per entry of the WHOLE chat
// (from /api/outline, not only the loaded page), coloured like the agent cards' sparkline (MARK_KIND), with the same
// tooltip (Tip). Hovering scrubs the chat to that entry (throttled); a click pins it; a translucent box shows what is
// on screen. Long chats are bucketed into ~3 px rows coloured by their dominant kind (a prompt or an error wins).
import { RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, MARK_KIND, QS, useChangeRev } from "../lib";
import { showTip, Tip } from "./bits";

/** [seq, kind, ts, size hint, label] */
export type Mark = [number, string, string | null, number, string];
type OutResp = { items: Mark[]; rev: number; epoch: number; total: number };
type Row = { i0: number; i1: number; top: number; h: number; k: string; w: number; target: number };

const ROW = 3, MAXSLOT = 10, THROTTLE = 60;
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
  seek: (seq: number, smooth: boolean) => void;
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
  const [vp, setVp] = useState<{ top: number; h: number; first: number } | null>(null);
  const measure = useCallback(() => {
    const el = box.current;
    if (!el || !rows.length) { setVp(null); return; }
    const v = visibleSeqs(el);
    if (!v) { setVp(null); return; }
    const ra = rows[rowOfMark(markOfSeq(v[0]))], rb = rows[rowOfMark(markOfSeq(v[1]))];
    const top = ra.top, bot = rb.top + Math.max(rb.h, 2);
    setVp((o) => (o && o.top === top && o.h === bot - top && o.first === v[0] ? o : { top, h: Math.max(6, bot - top), first: v[0] }));
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

  // ---------- hover: scrub (throttled), click pins, leaving keeps the scroll where it is ----------
  const [hov, setHov] = useState(-1);
  const [pinned, setPinned] = useState(false);
  const th = useRef({ last: 0, timer: 0, seq: -1, sent: -1 });
  const focusSeq = useRef<number | null>(null);
  const go = useCallback((seq: number, smooth: boolean) => { th.current.sent = seq; focusSeq.current = seq; seek(seq, smooth); }, [seek]);
  const scrub = (seq: number) => {
    const t = th.current; t.seq = seq;
    if (seq === t.sent) return;
    const wait = THROTTLE - (performance.now() - t.last);
    if (wait <= 0) { t.last = performance.now(); window.clearTimeout(t.timer); t.timer = 0; go(seq, true); }
    else if (!t.timer) t.timer = window.setTimeout(() => { t.timer = 0; t.last = performance.now(); if (t.seq !== t.sent) go(t.seq, true); }, wait);
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
    const hint = pin ? "pinned · leave the strip to scrub again" : "click to pin";
    if (one) return showTip({ k: m0[1], t: m0[2] || "", x: m0[4], n: r.i0 + 1, of: N, cx, cy, sticky: true, ft: `entry ${r.i0 + 1} of ${N} · ${hint}` });
    const list = marks.slice(r.i0, r.i1), shown = list.slice(0, 6);
    showTip({ k: r.k, t: m0[2] || "", t2: m1[2] || "", x: "", n: r.i0 + 1, of: N, cx, cy, sticky: true,
      rows: shown.map((x) => ({ k: x[1], x: x[4] })), more: list.length - shown.length, ft: `entries ${r.i0 + 1}–${r.i1} of ${N} · ${hint}` });
  };
  const onMove = (e: React.MouseEvent) => {
    const b = rowAt(e.clientY);
    if (b < 0) { setHov(-1); showTip(null); return; }
    setHov(b); tipFor(b, e.clientX, e.clientY);
    if (!pinned) scrub(rows[b].target);
  };
  const onLeave = () => { setHov(-1); setPinned(false); showTip(null); };
  const onClick = (e: React.MouseEvent) => {
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

  const cls = "ostrip" + (hov >= 0 ? " hov" : "") + (loading ? " busy" : "") + (pinned ? " pinned" : "");
  return (
    <div className={cls} ref={track} tabIndex={0} role="slider" aria-orientation="vertical"
      aria-label="Conversation outline: hover to scrub through the chat, click to pin, ↑ and ↓ jump between your prompts"
      aria-valuemin={0} aria-valuemax={users.length} aria-valuenow={curPrompt}
      aria-valuetext={users.length ? `prompt ${curPrompt} of ${users.length}` : "no prompts"} aria-busy={loading || undefined}
      onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick} onKeyDown={onKey} onBlur={() => { setHov(-1); showTip(null); }}>
      {rows.map((r, b) => {
        const c = (MARK_KIND[r.k] || MARK_KIND.tool)[1];
        const near = hov >= 0 && Math.abs(b - hov) === 1;
        return <i key={b} className={(r.k === "user" ? "u" : "") + (b === hov ? " on" : near ? " nb" : "")}
          style={{ top: r.top, height: r.h, width: r.k === "user" ? undefined : `calc(${(r.w * 100).toFixed(1)}% - 4px)`, background: c, color: c }} />;
      })}
      {vp && <div className="ovp" style={{ top: vp.top - 1, height: vp.h + 2 }} />}
      {loading && <div className="oload" style={{ top: hov >= 0 ? rows[hov].top : 0 }} aria-hidden="true" />}
      <Tip />
    </div>
  );
}
