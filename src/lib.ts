// Shared types, the tracker's format helpers (ported from tracker.py APP <script>), API, routing and live sync.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// ---------- types ----------
export type Tok = { input: number; output: number; cache_write: number; cache_read: number };
export type Ev = { t: string | null; kind: string; text: string };
export type Agent = {
  id: string; label: string; phase: string; status: string; tools: number; tokens: number; first: string | null;
  last: string | null; token_breakdown: Tok; cost: Tok; cost_total: number; priced: boolean; models: string[];
  last_ev: string; last_text: string; events: Ev[]; n_events: number; agent_type: string; resumed?: boolean; stop?: string;
  ctx?: AgentCtx;
};
export type AgentCtx = { p: string; s: string; chat: string; project: string; run: string; wf: string | null; run_title: string };
export type Phase = { name: string; total: number; done: number; running: number; cost: number };
export type FeedEv = Ev & { agent: string; id: string };
export type FileRow = { name: string; path: string; mtime: string | null; writes: number; edits: number; lines: number | null;
  heads: string[]; sev: { blocker: number; major: number; minor: number } | null; oq: string[] };
export type RunSummary = { id: string; title: string; icon: string; status: string; agents: number; start: string | null;
  end: string | null; tokens: number; cost: number };
export type RunData = { run: string; work: string; finished: boolean; feature: string; task: string; icon: string;
  generated_at: string; phases: Phase[]; agents: Agent[]; feed: FeedEv[]; files: FileRow[]; summary: RunSummary;
  workflow: boolean; src: { wf: string | null } };
export type SessionRow = { id: string; title: string; prompt: string; mtime: number; active: boolean; status: "running" | "stopped" | "idle"; msgs: number;
  prompts: number; agents: number; workflows: number; running: number; cost: number; cost_main: number; tokens: number;
  models: string[]; cwd: string; branch: string; first: string | null; last: string | null };
export type Project = { slug: string; path: string; sessions: SessionRow[]; mtime: number };
export type Global = { today_cost: number; today_tokens: number; today_tokens_breakdown: Tok; today_cost_breakdown: Tok;
  today_messages: number; active_chats: number; running_agents: number };
export type Index = { projects: Project[]; v: number; now: number; changed_at: number; global: Global };
export type Entry = { seq: number; off: number; k: string; ts?: string; bi?: number; mid?: string; model?: string;
  text?: string; trunc?: boolean; len?: number; id?: string; name?: string; input?: any; itrunc?: string[]; desc?: string;
  kind?: string; err?: boolean; agentId?: string; runId?: string; status?: string; sub?: string; args?: string;
  image?: boolean; ms?: number; pre?: number; post?: number; type?: string; usage?: { tok: Tok; cost: number | null };
  totalDurationMs?: number; totalTokens?: number; totalToolUseCount?: number };
export type Head = { project: string; session: string; title: string; cwd: string; branch: string; path: string;
  agent?: { id: string; wf: string | null; label: string; type: string; phase: string; finished: boolean };
  links: Record<string, { a?: string; p?: string; s?: string; wf?: string | null; label?: string; missing?: string; other?: boolean }>;
  elsewhere?: Record<string, { a: string; p: string; s: string; wf: string | null; label: string }>; agents: Record<string, { wf: string | null; label: string }>;
  workflows: string[] };
export type Page = { entries: Entry[]; start: number; total: number; epoch: number; head: Head | null };
export type McResp = { history: RunSummary[]; live: string | null; data: RunData | null; head: Head };

// ---------- tracker.py format helpers (same names and output) ----------
export const t = (iso?: string | null) => (iso ? new Date(iso) : null);
export const hhmmss = (iso?: string | null) => (iso ? t(iso)!.toLocaleTimeString([], { hour12: false }) : "");
export const fmtDate = (iso?: string | null) => iso ? t(iso)!.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
export const fmtDur = (s: number) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(x).padStart(2, "0")}s`; };
export const fmtTok = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n || 0);
export const fmtUsd = (v: number | null | undefined) => v == null ? "n/a" : v >= 100 ? "$" + v.toFixed(0) : v >= 1 ? "$" + v.toFixed(2) : "$" + v.toFixed(3);
export const sumCost = (A: Agent[], k: keyof Tok) => A.reduce((s, a) => s + ((a.cost || ({} as Tok))[k] || 0), 0);
export const sumTok = (A: Agent[], k: keyof Tok) => A.reduce((s, a) => s + ((a.token_breakdown || ({} as Tok))[k] || 0), 0);
export const shortModel = (m: string) => String(m || "").replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-(\d)$/, " $1").replace(/^(\w)/, (c) => c.toUpperCase());
export const quietSecs = (a: Agent, now = Date.now()) => a.status === "running" && a.last ? (now - +t(a.last)!) / 1000 : 0;
export const view = (a: Agent, now = Date.now()) => (a.status === "running" && quietSecs(a, now) > 600 ? "quiet" : a.status);
export const attention = (a: Agent) => { const v = view(a); return v === "quiet" || v === "failed"; };
export const ago = (iso?: string | null, now = Date.now()) => { if (!iso) return ""; const s = (now - +t(iso)!) / 1000; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`; };
export const agoSecs = (sec: number) => sec < 60 ? `${Math.round(sec)}s ago` : sec < 3600 ? `${Math.round(sec / 60)}m ago` : sec < 86400 ? `${(sec / 3600).toFixed(1)}h ago` : `${Math.round(sec / 86400)}d ago`;
export const KIND: Record<string, [string, string]> = {
  read: ["read / search", "var(--c-read)"], write: ["write / edit", "var(--c-write)"],
  shell: ["shell", "var(--c-shell)"], think: ["thinking", "var(--c-think)"],
  result: ["result returned", "var(--c-ok)"], tool: ["tool", "var(--c-tool)"],
};
export const when = (epochSec: number) => {
  const d = new Date(epochSec * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

// ---------- one shared 1 s clock (only tickers re-render, like the tracker's tick()) ----------
let nowMs = Date.now();
const subs = new Set<() => void>();
setInterval(() => { nowMs = Date.now(); subs.forEach((f) => f()); }, 1000);
export const useNow = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => nowMs);

// ---------- API ----------
export const QS = new URLSearchParams(location.search);
export const STATIC = QS.get("static") === "1";   // screenshots: no SSE, one fetch
export async function api<T>(path: string, params: Record<string, string | number | undefined | null> = {}): Promise<T> {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") u.set(k, String(v)); });
  const r = await fetch(`${path}?${u}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---------- routing (hash) ----------
// #/                         overview
// #/s/<project>/<session>    conversation           (+ ?tab=mc&run=<id> for Mission Control)
// #/s/<project>/<session>/a/<agentId>   a subagent's transcript
export type Route = { p?: string; s?: string; a?: string; tab: "chat" | "mc"; run?: string; focus?: string; from?: string };
export function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const q = new URLSearchParams(qs || "");
  const parts = (path || "").split("/").map(decodeURIComponent);
  const r: Route = { tab: q.get("tab") === "mc" ? "mc" : "chat", run: q.get("run") || undefined, focus: q.get("focus") || undefined, from: q.get("from") || undefined };
  if (parts[0] === "s" && parts[1] && parts[2]) { r.p = parts[1]; r.s = parts[2]; if (parts[3] === "a" && parts[4]) r.a = parts[4]; }
  return r;
}
export function href(r: Partial<Route>): string {
  if (!r.p || !r.s) return "#/";
  let h = `#/s/${encodeURIComponent(r.p)}/${encodeURIComponent(r.s)}`;
  if (r.a) h += `/a/${encodeURIComponent(r.a)}`;
  const q = new URLSearchParams();
  if (r.tab === "mc" && !r.a) q.set("tab", "mc");
  if (r.run && !r.a) q.set("run", r.run);
  if (r.focus) q.set("focus", r.focus);
  if (r.from) q.set("from", r.from);
  const s = q.toString();
  return s ? `${h}?${s}` : h;
}
export const go = (r: Partial<Route>, replace = false) => {
  const h = href(r);
  if (replace) history.replaceState(null, "", location.pathname + location.search + h);
  else location.hash = h;
  if (replace) dispatchEvent(new HashChangeEvent("hashchange"));
};
export function useRoute(): Route {
  const [r, setR] = useState(parseRoute);
  useEffect(() => { const f = () => setR(parseRoute()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return r;
}

// ---------- live sync: one EventSource, every view subscribes to its session's changes ----------
type ChangeMsg = { v: number; changed?: { p: string; s: string }[]; at: number; all?: boolean };
let everConnected = false;
const changeSubs = new Set<(m: ChangeMsg) => void>();
export const live = { lastOk: 0, lastChange: 0, connected: false };
const liveSubs = new Set<() => void>();
let liveVer = 0;
function bump() { liveVer++; liveSubs.forEach((f) => f()); }
export function startLive() {
  if (STATIC) { live.lastOk = Date.now(); bump(); return; }
  let es: EventSource | null = null, retry = 1000;
  const open = () => {
    es = new EventSource("/api/events");
    const ok = (e: MessageEvent) => { live.lastOk = Date.now(); live.connected = true; retry = 1000; try { const m = JSON.parse(e.data); live.lastChange = (m.at || 0) * 1000; } catch (_) {} bump(); };
    // after a reconnect, every view refetches: changes made while offline were never pushed
    es.addEventListener("hello", ((e: MessageEvent) => { const again = everConnected; everConnected = true; ok(e); if (again) changeSubs.forEach((f) => f({ v: 0, at: 0, all: true })); }) as any);
    es.addEventListener("ping", ok as any);
    es.addEventListener("runs", ((e: MessageEvent) => { ok(e); pollRuns(); }) as any);
    es.addEventListener("change", ((e: MessageEvent) => { ok(e); const m: ChangeMsg = JSON.parse(e.data); changeSubs.forEach((f) => f(m)); }) as any);
    es.onerror = () => { live.connected = false; bump(); es?.close(); setTimeout(open, retry); retry = Math.min(retry * 2, 15000); };
  };
  open();
}
export const useLive = () => { useSyncExternalStore((f) => { liveSubs.add(f); return () => liveSubs.delete(f); }, () => liveVer); return live; };
/** A counter that bumps whenever the given session (or, with no args, anything) changes on disk. */
export function useChangeRev(p?: string, s?: string): number {
  const [rev, setRev] = useState(0);
  const key = useRef({ p, s }); key.current = { p, s };
  useEffect(() => {
    const f = (m: ChangeMsg) => { const k = key.current; if (!k.p || m.all || (m.changed || []).some((c) => c.p === k.p && c.s === k.s)) setRev((x) => x + 1); };
    changeSubs.add(f); return () => { changeSubs.delete(f); };
  }, []);
  return rev;
}

// ---------- write mode (off by default; the toggle lasts for this tab only) ----------
export const TOKEN = (document.querySelector('meta[name="mc-token"]') as HTMLMetaElement | null)?.content || "";
export type RunEv = { n: number; t: number; k: "status" | "text" | "tool" | "error" | "result"; text: string; kind?: string };
export type RunSnap = { id: string; kind: "new" | "send"; status: "starting" | "running" | "done" | "error" | "stopped";
  session_id: string | null; target: string | null; fork: boolean; cwd: string; model: string; mode: string; started: number;
  ended: number | null; exit: number | null; error: string; cost: number | null; partial: string; seq: number; events: RunEv[];
  project: string; appeared: boolean; result: { is_error: boolean; turns: number; denials: number } | null };
export type WriteOptions = { models: string[]; modes: string[]; cwds: string[]; home: string; active: number; max: number; bin: boolean;
  session?: { live_elsewhere: boolean; busy: boolean; cwd: string; idle_secs: number } };

let writeOn = (() => { try { return sessionStorage.getItem("mc-write") === "1"; } catch { return false; } })();
const writeSubs = new Set<() => void>();
export function setWriteMode(on: boolean) {
  writeOn = on; try { sessionStorage.setItem("mc-write", on ? "1" : "0"); } catch (_) {}
  writeSubs.forEach((f) => f()); if (on) pollRuns();
}
export const useWriteMode = () => useSyncExternalStore((f) => { writeSubs.add(f); return () => writeSubs.delete(f); }, () => writeOn);

export async function writeApi<T = any>(op: string, body: object = {}): Promise<{ ok: boolean; status: number; data: T & { error?: string; fork_offered?: boolean; busy?: boolean } }> {
  const r = await fetch(`/api/write/${op}`, {
    method: "POST", credentials: "omit",
    headers: { "Content-Type": "application/json", "X-MC-Token": TOKEN }, body: JSON.stringify(body),
  });
  let data: any = {};
  try { data = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, data };
}

// runs: merged snapshots, polled (with the token) while any is active or when the SSE "runs" nudge arrives
const runs = new Map<string, RunSnap>();
let runsVer = 0, polling = false, again = false, pollTimer: number | undefined;
const runSubs = new Set<() => void>();
export async function pollRuns() {
  if (!TOKEN || !writeOn) return;
  if (polling) { again = true; return; }
  polling = true;
  try {
    const since: Record<string, number> = {};
    runs.forEach((r) => (since[r.id] = r.events.length ? r.events[r.events.length - 1].n + 1 : 0));
    const res = await writeApi<{ runs: RunSnap[] }>("runs", { since });
    if (res.ok) {
      for (const s of res.data.runs) {
        const old = runs.get(s.id);
        const evs = old ? [...old.events, ...s.events.filter((e) => !old.events.length || e.n > old.events[old.events.length - 1].n)] : s.events;
        runs.set(s.id, { ...s, events: evs.slice(-400) });
      }
      runsVer++; runSubs.forEach((f) => f());
    }
  } catch (_) {} finally { polling = false; }
  const active = [...runs.values()].some((r) => r.status === "starting" || r.status === "running" || (!r.appeared && !!r.session_id && Date.now() / 1000 - (r.ended || 0) < 30));
  window.clearTimeout(pollTimer);
  if (again || active) { again = false; pollTimer = window.setTimeout(pollRuns, active ? 500 : 0); }
}
export function noteRun(s: RunSnap) { runs.set(s.id, s); runsVer++; runSubs.forEach((f) => f()); pollRuns(); }
export function dropRun(id: string) { runs.delete(id); runsVer++; runSubs.forEach((f) => f()); }
export function useRuns(): RunSnap[] {
  useSyncExternalStore((f) => { runSubs.add(f); return () => runSubs.delete(f); }, () => runsVer);
  return [...runs.values()].sort((a, b) => a.started - b.started);
}
