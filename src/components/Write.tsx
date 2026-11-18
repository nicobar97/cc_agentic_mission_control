// Write mode: start chats and send messages through the local `claude` CLI (headless). Off by default.
import { useEffect, useRef, useState } from "react";
import { fmtUsd, go, hhmmss, Index, KIND, noteRun, dropRun, RunSnap, setWriteMode, TOKEN, useChangeRev, useNow, useRuns, useWriteMode, writeApi, WriteOptions, shortModel } from "../lib";
import { Folder, Info, PencilIcon } from "./bits";

const MODE_HELP = <>
  <span className="li"><b>default</b> Claude can read and answer; anything that would ask for your approval (edits, most shell commands) is refused, because a headless run has nobody to approve it</span>
  <span className="li"><b>acceptEdits</b> file edits inside the working directory go through without asking</span>
  <span className="li"><b>plan</b> Claude only plans: nothing is changed</span>
  <span className="li">Your <code>settings.json</code> allow / deny rules always apply. Bypass modes are never offered, and the server refuses them.</span>
</>;

export function WriteToggle() {
  const on = useWriteMode();
  return <span className="wtoggle">
    <button className={"switch" + (on ? " on" : "")} role="switch" aria-checked={on} aria-label="Write mode" disabled={!TOKEN}
      title={TOKEN ? "Write mode: start chats and send messages" : "Write mode needs the page served by the Mission Control server"}
      onClick={() => setWriteMode(!on)}><i /><PencilIcon size={12} /><span className="tlab">Write mode</span></button>
    <Info right label="Legend: write mode">
      <span className="li"><b>Off</b> (default) Mission Control only reads ~/.claude/projects</span>
      <span className="li"><b>On</b> a composer appears under each chat and “＋ New chat” in the sidebar. Messages run the local <code>claude</code> CLI headless, in the chat's own folder; the reply lands in the transcript and shows here live</span>
      <span className="li">A chat that changed in the last 2 min and isn't being written by Mission Control (for example an open terminal session) is never written into: you can fork it into a new chat instead</span>
      <span className="li">One message per chat at a time, at most 3 runs at once</span>
      <span className="li">The trash icon on a sidebar chat moves it to the macOS Trash (<code>~/.Trash/Mission Control/</code>), with Undo. Never deleted; open, active or running chats are refused</span>
    </Info>
  </span>;
}

function useOptions(p?: string, s?: string) {
  const on = useWriteMode();                 // read-only mode makes no write calls at all
  const [o, setO] = useState<WriteOptions | null>(null);
  const rev = useChangeRev(p, s);
  const runs = useRuns().filter((r) => r.status === "running" || r.status === "starting").length;
  useEffect(() => { if (on) writeApi<WriteOptions>("options", { p, s }).then((r) => r.ok && setO(r.data)); }, [on, p, s, rev, runs]);
  useEffect(() => { if (!on) return; const i = setInterval(() => writeApi<WriteOptions>("options", { p, s }).then((r) => r.ok && setO(r.data)), 15000); return () => clearInterval(i); }, [on, p, s]);
  return o;
}

function Selectors({ o, model, setModel, mode, setMode }: { o: WriteOptions | null; model: string; setModel: (m: string) => void; mode: string; setMode: (m: string) => void }) {
  return <>
    <label className="sel" title="Model">
      <select value={model} onChange={(e) => setModel(e.target.value)}>
        {(o?.models || [""]).map((m) => <option key={m} value={m}>{m ? shortModel(m) : "Default model"}</option>)}
      </select></label>
    <label className="sel" title="Permission mode">
      <select value={mode} onChange={(e) => setMode(e.target.value)}>
        {(o?.modes || ["default", "acceptEdits", "plan"]).map((m) => <option key={m} value={m}>{m}</option>)}
      </select></label>
    <Info right label="Legend: permission modes">{MODE_HELP}</Info>
  </>;
}

export function RunPanel({ run, compact }: { run: RunSnap; compact?: boolean }) {
  const now = useNow();
  const box = useRef<HTMLDivElement>(null);
  const live = run.status === "running" || run.status === "starting";
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; }, [run.events.length, run.partial]);
  const stop = async () => { const r = await writeApi<RunSnap>("stop", { run: run.id }); if (r.ok) noteRun(r.data); };
  const secs = Math.round(((run.ended ? run.ended * 1000 : now) - run.started * 1000) / 1000);
  return (
    <div className={"runpanel " + run.status}>
      <div className="rp-h">
        {live ? <span className="badge running">Claude is working…</span> : <span className={"badge " + (run.status === "done" ? "done" : run.status === "stopped" ? "stopped" : "failed")}>{run.status}</span>}
        <span className="ts">{run.fork ? "fork · " : run.kind === "new" ? "new chat · " : ""}{run.model ? shortModel(run.model) : "default model"} · {run.mode} · {secs}s{run.cost != null ? ` · ${fmtUsd(run.cost)}` : ""}</span>
        <span style={{ flex: 1 }} />
        {live ? <button className="btn stop" onClick={stop} title="End this claude process">■ Stop</button>
          : <button className="iconbtn" onClick={() => dropRun(run.id)} title="Dismiss">✕</button>}
      </div>
      <div className="rp-b" ref={box} style={compact ? { maxHeight: 150 } : undefined}>
        {run.events.map((e) => <div key={e.n} className={"rp-e k-" + e.k}>
          <code>{hhmmss(new Date(e.t * 1000).toISOString())}</code>
          {e.k === "tool" ? <span className="kdot" style={{ background: (KIND[e.kind || "tool"] || KIND.tool)[1] }} /> : null}
          <span>{e.text}</span></div>)}
        {run.partial && <div className="rp-e k-partial"><code>…</code><span>{run.partial}<i className="caret" /></span></div>}
        {!run.events.length && !run.partial && live && <div className="rp-e"><code>…</code><span className="sub">starting claude…</span></div>}
        {run.error && <pre className="out">{run.error}</pre>}
      </div>
    </div>
  );
}

/** Composer under a chat (main sessions only: a subagent's chat can't be resumed). */
export function Composer({ p, s }: { p: string; s: string }) {
  const on = useWriteMode();
  const o = useOptions(on ? p : undefined, on ? s : undefined);
  const runs = useRuns();
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState("default");
  const [msg, setMsg] = useState("");
  const [forceFork, setForceFork] = useState(false);
  const [sending, setSending] = useState(false);
  const myRuns = runs.filter((r) => r.target === s || r.session_id === s);
  const busy = myRuns.some((r) => !r.fork && (r.status === "running" || r.status === "starting"));
  const fork = !!o?.session?.live_elsewhere || forceFork;
  // a fork becomes its own chat: open it as soon as its transcript appears
  const opened = useRef(new Set<string>());
  useEffect(() => {
    for (const r of myRuns) if (r.fork && r.session_id && r.appeared && !opened.current.has(r.id)) { opened.current.add(r.id); go({ p: r.project, s: r.session_id }); }
  }, [myRuns]);
  if (!on) return null;
  const send = async () => {
    if (!text.trim() || sending || busy) return;
    setSending(true); setMsg("");
    const r = await writeApi<RunSnap>("send", { p, s, prompt: text, model, mode, fork });
    setSending(false);
    if (r.ok) { noteRun(r.data); setText(""); }
    else { setMsg(r.data.error || `refused (${r.status})`); if (r.data.fork_offered) setForceFork(true); }
  };
  const last = myRuns.filter((r) => !r.fork || !r.appeared).slice(-1)[0];
  return (
    <div className="composer">
      {last && <RunPanel run={last} compact />}
      {fork && <div className="cnote">⑂ This chat is live elsewhere{o?.session ? ` (changed ${o.session.idle_secs}s ago, not by Mission Control)` : ""}, so it is never written into. Sending forks it into a new chat with the same history.</div>}
      {msg && <div className="cnote err">{msg}</div>}
      <div className="cbox">
        <textarea rows={2} placeholder={busy ? "Claude is still answering in this chat…" : fork ? "Message for the fork…  (Enter to send, Shift+Enter for a new line)" : "Message Claude…  (Enter to send, Shift+Enter for a new line)"}
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <div className="crow">
          <Selectors o={o} model={model} setModel={setModel} mode={mode} setMode={setMode} />
          <span className="ts" title={o?.session?.cwd}><Folder /> {(o?.session?.cwd || "").replace(o?.home || "~", "~")}</span>
          <span style={{ flex: 1 }} />
          <button className={"btn send" + (fork ? " fork" : "")} disabled={!text.trim() || sending || busy} onClick={send}>
            {sending ? "Starting…" : fork ? "⑂ Fork into a new chat" : "Send ↵"}</button>
        </div>
      </div>
    </div>
  );
}

/** "＋ New chat" in the sidebar: cwd picker, model, mode and the first prompt. */
export function NewChat({ idx }: { idx: Index | null }) {
  const on = useWriteMode();
  const [open, setOpen] = useState(new URLSearchParams(location.search).get("newchat") === "1");
  const o = useOptions();
  const runs = useRuns();
  const [cwd, setCwd] = useState("");
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState("default");
  const [msg, setMsg] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const run = runs.find((r) => r.id === runId);
  useEffect(() => { if (!cwd && o?.cwds.length) setCwd(o.cwds.find((c) => c.includes("/Projects/")) || o.cwds[0]); }, [o]);
  useEffect(() => {   // select the new chat as soon as its transcript appears
    if (run?.session_id && run.appeared && idx?.projects.some((p) => p.slug === run.project && p.sessions.some((x) => x.id === run.session_id))) {
      go({ p: run.project, s: run.session_id }); setOpen(false); setRunId(null); setText("");
    }
  }, [run, idx]);
  if (!on) return null;
  const start = async () => {
    setMsg("");
    const r = await writeApi<RunSnap>("new", { cwd, prompt: text, model, mode });
    if (r.ok) { noteRun(r.data); setRunId(r.data.id); } else setMsg(r.data.error || `refused (${r.status})`);
  };
  return <>
    <button className="btn newchat" onClick={() => setOpen((x) => !x)}>＋ New chat</button>
    {open && <div className="ncpanel">
      <div className="lbl">Working directory<span className="sub">inside your home</span></div>
      <input list="mc-cwds" type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/Projects/…" spellCheck={false} />
      <datalist id="mc-cwds">{(o?.cwds || []).map((c) => <option key={c} value={c} />)}</datalist>
      <div className="lbl">First message</div>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should Claude do?"
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (text.trim() && !run) start(); } }} />
      <div className="crow"><Selectors o={o} model={model} setModel={setModel} mode={mode} setMode={setMode} /><span style={{ flex: 1 }} />
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn send" disabled={!text.trim() || !cwd || (!!run && run.status !== "error" && run.status !== "stopped")} onClick={start}>Start chat ↵</button></div>
      {msg && <div className="cnote err">{msg}</div>}
      {run && <RunPanel run={run} compact />}
    </div>}
  </>;
}
