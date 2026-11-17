# Mission Control

A local web app that watches Claude Code sessions live: every chat, its subagents and its workflows. It is read-only
unless you turn on write mode (below).
Mission Control per chat is a React port of the "Agent Mission Control" tracker
(`~/.claude/skills/feature-delivery/scripts/tracker.py`), with the same design, rules and prices.

## Run

```bash
npm install          # once
npm start            # build the UI and serve it + the API on http://127.0.0.1:8765
npm run dev          # API on :8765 + Vite on http://127.0.0.1:5173 (proxies /api), hot reload
npm run serve        # serve the last build without rebuilding
PORT=9000 npm start  # another port
```

Background, as left running:

```bash
PYTHONDONTWRITEBYTECODE=1 nohup python3 -B server/server.py --port 8765 --static dist > run.log 2>&1 &
echo $! > server.pid
kill "$(cat server.pid)"      # stop
```

Requires Python 3.9+ (stdlib only) and Node 18+ for the build. `npm run dev` reuses an API already
answering on `MC_API_PORT` (default 8765) instead of starting a second one; Vite's port is `MC_DEV_PORT` (5173).

Headless screenshots: add `?static=1`, because an open EventSource keeps Chrome's `--virtual-time-budget` from expiring.

## What it shows

- **Sidebar · Chats.** Projects by readable path (taken from the sessions' `cwd`), each with its sessions.
  - **Active now** at the top with a live pulse: a chat counts as active when its transcript, or one of its agents, changed in the last 5 min.
  - Older chats below, newest first.
  - Each row shows the title (the `summary` or `ai-title` line, else the first prompt), time, message count, 🤖 agents and cost (chat + its agents).
  - Search with `⌘K`.
  - **Stars.** ☆ on a project header (shown on hover, keyboard-focusable) pins it in a **Starred** section under Active now, in the order you starred them. Drag a starred project, or press Alt+↑/↓, to reorder.
    - Active chats still appear in Active now, and search lists starred matches first.
    - Stars live in this browser's `localStorage` (`mc.starredProjects`) only, with no server call, so they work in read-only mode. If storage is blocked, stars last only until the next reload.
- **Top bar.**
  - Global tiles: today's cost and tokens, over every chat and agent, deduped per message id.
  - The number of active chats and of running agents.
  - A "live · updated Ns ago" indicator.
- **Conversation.** A read-only transcript:
  - user and assistant messages rendered as markdown, with raw HTML shown as text;
  - collapsed thinking;
  - tool calls with their input (Bash, Edit diff, Write, Agent prompt…) and a collapsible result;
  - long outputs truncated server-side, with "Show all" fetching the full block;
  - timestamps and day separators;
  - compaction, recap, command and hand-back notes.
  - Loads 150 entries from the end and fetches older pages as you scroll up, keeping your reading position.
  - New lines stream in over SSE. It sticks to the bottom only if you were already there; otherwise a "↓ N new" button appears.
- **Mission Control** tab: the tracker dashboard for the chat. Each workflow (`subagents/workflows/wf_*`) is a run, and so is each plain agent, as in the tracker's history.
  - It has the same parts as the tracker:
    - the 13 stat tiles, with ⓘ legends;
    - phase rings, which filter on click;
    - agent cards with live elapsed time, a "quiet Xm" badge and an activity sparkline;
    - a live feed, deliverables and the run switcher (`r`), with `● Live` to return to the live run;
    - search (`/`), status filters, a drawer with the cost table, latest reasoning and timeline, and both themes (`t`).
  - The sparkline bars have tooltips, react on hover and open the drawer at that action on click.
  - A hovered card defers its redraw until the mouse leaves.
- **Navigation.**
  - Clicking an agent card, an `Agent` tool call ("Open agent chat ↗") or a hand-back note opens that subagent's transcript, with breadcrumbs (project › chat › workflow › agent) and back.
  - A `Workflow` call links to its run in Mission Control.
  - **One resolver** (`Session.resolve` in `server/store.py`, also at `GET /api/agent-resolve?p&s&tool=|agent=`) maps every Agent/Task call, SendMessage and hand-back note to an agent chat. It uses only recorded ids, never descriptions:
    - `meta.json` `toolUseId`;
    - `toolUseResult.agentId` from the chat and from every agent transcript;
    - SendMessage `to`.

    It refreshes with every live update.
  - **An agent whose transcript sits under another session** (a resumed chat gets a new session id) is found through a global agent-id index, and the link is marked "(other chat)". A deep link that names the wrong chat redirects to the right one.
  - **A call with no reachable agent** shows a disabled link with an ⓘ giving the reason: rejected call, id not known yet, transcript not written yet, or removed by Claude Code's 30-day cleanup.
  - **"Agent chats ▾"** in the session header lists the chat's agents, grouped by workflow, from any tab.

- **Home.** Every agent across all chats, rendered with the same card, drawer and feed components as Mission Control.
  - **Running now:** each card carries an extra line naming its chat, project, workflow and phase. When nothing runs, it shows "No agents running".
  - **Recently finished:** the last 24 h, 24 cards at a time with "Show more". Each card shows the first line of the agent's final report.
  - **A merged live feed.** Search (`/`) and the status filters work across all cards.
  - Clicking a card opens the agent's chat, with a `Home ›` breadcrumb back; ☰ or a sparkline bar opens the drawer.
- **Diffs.** Click a deliverable in Mission Control, or "± diff" on a Write/Edit call in a conversation, for a git-style diff of every change to that file in the run (or the whole chat), in time order.
  - The header shows `diff --git`, `---` / `+++` and `@@` hunks, with old and new line gutters and dimmed context. Unified view is the default, with a split view.
  - Long hunks collapse behind "Expand", and `j` / `k` step through changes.
  - "This change" toggles with "All changes combined". "Copy patch" copies a unified diff that `git apply` accepts.
  - The file itself is never read. Each change is rebuilt from the transcript, in this order of preference:
    - the tool result's `originalFile` and `structuredPatch`;
    - the Write content or the Edit `old_string` / `new_string`;
    - replaying earlier changes, forwards from a known base and backwards from a later known state.
  - A change whose base is unknown shows Claude Code's recorded hunks, with real line numbers.
  - A Write over a file whose previous content isn't recorded shows every line as added, with a note.
  - The combined diff covers the last unbroken stretch of history and says where it starts.

Deep links (hash routes): `#/s/<project-slug>/<session-id>`, `…?tab=mc&run=<run-id>`, `…/a/<agent-id>`.
`?static=1` (one fetch, no SSE) and `?theme=light|dark` help with screenshots. With `static=1` only, `write=1` starts in
write mode, `hover=<session-id>` shows that row's hover state, `trash=<slug>/<session-id>` opens the Trash dialog (a dry
run, nothing moves), `toast=demo` shows a sample Undo toast and `trashlist=1` opens the sidebar's Trash list.

## How it works

- `server/tracker_port.py` is a faithful copy of the tracker's parsing and pricing logic. Each function names its `tracker.py` origin:
  - `PRICES`, `price_for`, `usage_cost`, with fast mode at 2×;
  - usage deduped per message id;
  - `read_agent` as an incremental `AgentState`, and `read_journal` as `JournalState`;
  - `collect`, `summary`, `pick_icon`, `feature_name`, `task_name`.
  - Done rules: journal result, `meta.finished`, or `SubagentHandback` / `StructuredOutput`. `stoppedByUser` means stopped. A run is finished after 2 min idle. With no live loop per run, it always applies the snapshot rule: 45 min of silence means stopped.
  - It was checked against the original `collect()` on all 30 runs of a real session: identical statuses, costs, events, feed and phases.
  - One extension beyond the tracker: a plain agent resumed after its hand-back (via SendMessage) has activity after its last result event, so it shows as running again until it hands back once more, or goes silent for 45 min. The tracker would keep it "done".
- **Deliverables** are rebuilt from the `Write` / `Edit` tool inputs inside the transcripts, because the app never reads files outside `~/.claude/projects`.
- `server/store.py` tails every JSONL file by byte offset. It parses only complete lines appended since the last pass, and re-reads a file that shrank or changed inode. A 1.5 s poll thread stats the files and pushes a `change` Server-Sent Event naming the chats that changed. The UI refetches only those, so a growing chat costs only its new lines.
- `server/transcript.py` normalizes lines into entries. Unknown line and block types degrade to a small note. `/api/full` re-reads one line by its byte offset for the untruncated block.
- **No redraw when nothing changed.** Mission Control compares each payload without `generated_at` and keeps the current DOM if nothing else differs. Timers tick on their own.

## Write mode (off by default)

Toggle **✎ Write mode** in the top bar. It lasts for the current tab only, and new tabs start read-only. With it on:
- a composer appears under each chat: Enter sends, Shift+Enter adds a new line, and there are model and permission-mode selectors;
- the sidebar gets **＋ New chat**, with a working-directory picker (recent project folders, or type a path), model, mode and first prompt. The UI selects the new chat as soon as its transcript appears.
- each sidebar chat gets a **trash icon** on hover or focus, to move that chat to the macOS Trash (see "Moving a chat to the Trash").

A "Claude is working…" panel streams the run's text and tool calls, with **■ Stop**, which ends that process group. The reply lands in the transcript, which the existing sync shows in place.

How a message runs: the server spawns the local CLI with an argv list (no shell). The flags were checked against `claude --help` for 2.1.323:
```
claude -p --output-format stream-json --verbose --include-partial-messages \
       --permission-mode <manual|acceptEdits|plan> --permission-prompts none [--model M] [--resume <id> [--fork-session]]
```
- The prompt goes through **stdin**, so it can't be parsed as a flag (for example `--dangerously-skip-permissions`) and doesn't show in `ps`.
- `cwd` is the new chat's folder, or the original folder of the resumed chat.

Safety rules:
- **Two guards on every write.** Write endpoints are `POST /api/write/*` only. Each needs:
  - the **per-launch token**, made with `secrets.token_urlsafe` at start, held only in memory and injected into the served `index.html` as `<meta name="mc-token">`, sent back in the `X-MC-Token` header;
  - an **Origin** equal to the app's own origin, or the Vite dev origin given with `--dev-origin`.

  The `Host` check still applies. The token never goes in a cookie, a URL or the logs.
- **Permission modes:** only `default` (sent as `manual`, the CLI's name for it), `acceptEdits` and `plan` are offered. `bypassPermissions`, `dontAsk`, `auto` and anything "dangerously" are refused by the server too. `--permission-prompts none` means that in a headless run, anything that would ask for approval is denied. Your `settings.json` allow/deny rules still apply.
- **Working directory:** absolute, existing and inside your home, with no `..`. Symlinks are resolved, so `~/x -> /etc` is refused. `~/.claude`, other top-level dot-folders and `~/Library` are refused too.
- **Live chats are never written in place.** If a chat's transcript (or one of its agents) changed in the last 2 min and Mission Control isn't the one writing it, sending is refused (409) and **"⑂ Fork into a new chat"** (`--resume <id> --fork-session`) is offered instead. An open terminal session is always in this state, and the UI navigates to the fork when it appears.
  - The server remembers its own writes in memory only. Right after a restart, a chat it wrote in the last 2 minutes counts as foreign and is forked: the safe side.
- **Limits:** one run per chat, at most 3 at once.
- **Environment:** inherited minus `MC_*` and the variables that tie a process to a parent Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_PID`, …).
- **Logs:** only metadata (run, session id, cwd, mode, model, exit code), never prompts or output.

### Moving a chat to the Trash

The trash icon on a sidebar row (write mode only) opens a confirmation dialog. It shows the chat's title, project, last
activity, messages, agents and workflows, and its size on disk, and says "Moves it to the macOS Trash. You can restore it
from Finder." **Move to Trash** (Enter) or **Cancel** (Esc).
- **What moves:** only the transcript `~/.claude/projects/<slug>/<id>.jsonl` and, if it exists, the session folder
  `~/.claude/projects/<slug>/<id>/` (subagents, workflows, tool results). They go to
  `~/.Trash/Mission Control/<slug>/<id>/`, under the same names, or to `<id>-YYYYmmdd-HHMMSS/` if that name is taken.
  Nothing else under `~/.claude` (file-history, todos, settings, memory) is touched.
- **Never deleted.** It uses `os.rename`, or `shutil.move` across volumes. Mission Control never empties the Trash and
  has no unlink or rmdir: a Trash entry emptied by a restore stays as an empty folder.
- **Undo.** A "Moved to Trash · Undo" toast stays for 10 s. A **Trash** section at the bottom of the sidebar lists what
  Mission Control has trashed, each with **Restore**. Both move the files back to their exact original paths, and refuse
  if anything now exists at either path. Finder's "Put Back" doesn't know these files, because Finder didn't trash them;
  dragging the folder's contents back works.
- **Refused by the server**, with the reason shown in the dialog:
  - an active chat (its transcript, or any file of its session folder, changed in the last 5 min, the "Active now" rule);
  - a chat Mission Control is running a message in, or forking;
  - a session id that isn't a UUID, a project slug that isn't an existing folder directly under `~/.claude/projects`
    (so no `..` or `/`), paths whose real location leaves `~/.claude/projects/<slug>/`, and a transcript or session
    folder that is a symlink.

  The chat that is open in this tab can't be trashed: its button is disabled.
- **Same guards as every write:** `POST /api/write/*` only (GET gets 405), the `X-MC-Token`, the own-Origin check and
  the Host check.
- **After the move**, the server drops the chat from its index, run cache and parsed transcripts, and pushes a `change`
  event: it leaves the sidebar, Home and the counts. A tab that still had it open shows "This chat was moved to the Trash",
  with Restore in write mode.
- **Logs:** only the session id, the slug and the result (for example `refused-active`).

> **Note: transcripts older than 30 days.** Every `claude` start, interactive or headless (including Mission Control's runs), applies Claude Code's own `cleanupPeriodDays` (default 30) and deletes older transcripts under `~/.claude/projects`. Raise it in `~/.claude/settings.json` if you want to keep them.

In dev (`npm run dev`), the API is started with `--dev-origin http://127.0.0.1:5173`. Vite's server-side plugin fetches the token from `/api/dev-token`, which is enabled only in that mode and refuses any browser request, because those carry an Origin or Sec-Fetch header.

## Theme

All tokens live in `src/theme.css`, under three themes, picked with **Light / Dark / Dim** in the top bar (`t` cycles them). The choice is saved, and `?theme=light|dark|dim` overrides it.
- **Dark** is a soft charcoal: `#17171a` page, `#1b1b1e` sidebar, `#1e1e21` cards, `#252529` raised, `#2c2c31` hover.
- **Dim** is deeper, between the charcoal and black.
- **Light** uses the same token names.

All greys are neutral; there is no blue anywhere.
- **Accent:** orange, `#ff8a3d` on dark, and `#ea6a12` fills with `#a2490c` text on light.
- **Status:** running is yellow, done green, failed red, quiet/stopped grey.
- **Sparkline categories:** read teal-green, write pink, shell yellow, thinking orange, result green, other grey.

The macOS emoji that render blue (🛰️, 🤖, 📁) were replaced by monochrome inline SVG icons.

`src/refine.css` is the design pass:
- a 5-size type scale (11 / 12 / 13 / 14 / 22 px) with tabular numbers;
- a 4/8 px grid;
- status shown as a pill plus a left edge;
- 150–200 ms ease-out motion, with `prefers-reduced-motion` respected;
- visible focus rings, keyboard reachability and skeleton loading states.

WCAG AA, computed on every resting layer of each theme. Text needs at least 4.5:1, and status pill text is measured on its own 12% tint. Bars and dots need at least 3:1.

### dark (charcoal): layers #17171a / #1b1b1e / #1e1e21 / #252529
- text fg #ececee: min 12.94
- text fg2 #a8a8b0: min 6.47
- text mut #8c8c95: min 4.58
- text acc #ff8a3d: min 6.51
- pill acc #ff8a3d on its 12% tint: min 5.30
- pill run #f2c94c on its 12% tint: min 7.27
- pill ok #4cc38a on its 12% tint: min 5.54
- pill bad #f2747e on its 12% tint: min 4.59
- pill idle #9c9ca5 on its 12% tint: min 4.60
- bar read #45c4b0: min 7.11 (3:1 needed)
- bar write #e47aa8: min 5.56 (3:1 needed)
- bar think #ff8a3d: min 6.51 (3:1 needed)
- bar shell #f2c94c: min 9.62 (3:1 needed)
- bar result #4cc38a: min 6.89 (3:1 needed)
- bar tool #7c7c86: min 3.70 (3:1 needed)
- primary button #17171a on #ff8a3d: 7.63
### dim: layers #111113 / #141416 / #17171a / #1d1d21
- text fg #ececee: min 14.24
- text fg2 #a8a8b0: min 7.11
- text mut #86868f: min 4.66
- text acc #ff8a3d: min 7.16
- pill acc #ff8a3d on its 12% tint: min 5.86
- pill run #f2c94c on its 12% tint: min 8.08
- pill ok #4cc38a on its 12% tint: min 6.13
- pill bad #f0636f on its 12% tint: min 4.60
- pill idle #9a9aa3 on its 12% tint: min 4.98
- bar read #45c4b0: min 7.82 (3:1 needed)
- bar write #e47aa8: min 6.12 (3:1 needed)
- bar think #ff8a3d: min 7.16 (3:1 needed)
- bar shell #f2c94c: min 10.59 (3:1 needed)
- bar result #4cc38a: min 7.58 (3:1 needed)
- bar tool #7c7c86: min 4.07 (3:1 needed)
- primary button #111113 on #ff8a3d: 8.04
### light: layers #fafafa / #f7f7f8 / #ffffff / #f4f4f5
- text fg #18181b: min 16.12
- text fg2 #52525b: min 7.03
- text mut #6b6b75: min 4.79
- text acc #a2490c: min 5.47
- pill acc #a2490c on its 12% tint: min 4.61
- pill run #7b5f09 on its 12% tint: min 4.66
- pill ok #26714d on its 12% tint: min 4.57
- pill bad #c21221 on its 12% tint: min 4.58
- pill idle #64646d on its 12% tint: min 4.56
- bar read #2e8f80: min 3.57 (3:1 needed)
- bar write #c8457f: min 4.14 (3:1 needed)
- bar think #e46712: min 3.06 (3:1 needed)
- bar shell #ad850d: min 3.11 (3:1 needed)
- bar result #359d6b: min 3.09 (3:1 needed)
- bar tool #8b8b96: min 3.07 (3:1 needed)
- primary button #1a1a1a on #ea6a12: 5.44

## Safety (read side)

- It binds to `127.0.0.1` only. Reads are GET/HEAD; writes are the guarded `POST /api/write/*` above, in write mode only; everything else gets a 405.
- There are no CORS headers, and the `Host` header must be `127.0.0.1` or `localhost`, which blocks DNS rebinding.
- Ids in API calls are looked up in the index, never joined into paths from user input, and every read is checked to stay under `~/.claude/projects`. The only other folder it reads is its own `~/.Trash/Mission Control/` (the Trash list and the "moved to the Trash" notice); it never lists `~/.Trash` itself.
- Mission Control itself never writes or deletes anything under `~/.claude`. In write mode, and only when you confirm it, it **moves a chat to the macOS Trash** (its transcript and session folder, see "Moving a chat to the Trash") and moves it back on Undo or Restore. Otherwise only the `claude` CLI it starts writes there, as it always does. It runs with `-B` / `PYTHONDONTWRITEBYTECODE`, and it copies the tracker logic rather than importing it, so no `__pycache__` lands there.
- The UI bundle is fully local, with no CDN at runtime. Its dependencies are React, `marked`, Vite and TypeScript.

## API

Read (GET), plus `/api/trash-state?p&s` (was this chat moved to the Trash by Mission Control?):

| Path | |
|---|---|
| `/api/index` | projects, sessions and the global tiles |
| `/api/transcript?p&s[&a]&before|after&limit` | a page of transcript entries (`a` = agent id) |
| `/api/full?p&s[&a]&seq` | one entry, untruncated |
| `/api/mc?p&s[&run]` | run history + one run's tracker payload |
| `/api/agents?state=running\|recent[&limit&hours]` | home: every agent across chats, from the cached runs |
| `/api/agent-resolve?p&s&tool=<toolUseId>\|agent=<agentId>` | where an agent's chat lives (or why it isn't available) |
| `/api/diff?p&s&path[&run][&change=i\|combined=1]` | the changes to one file, and one rendered diff |
| `/api/events` | Server-Sent Events: `hello`, `change`, `runs` (a write-mode run changed; no content), `ping` (every 5 s) |

Write (POST, `X-MC-Token` plus own Origin, JSON body): `/api/write/options`, `/api/write/new`, `/api/write/send` (`fork: true` to fork), `/api/write/stop`, `/api/write/runs`,
`/api/write/trash-info` (`p`, `s`: the dialog's facts and a dry run), `/api/write/trash` (`p`, `s`), `/api/write/restore` (`p`, `entry`), `/api/write/trashed` (the Trash list).
`MC_TRASH` moves the Trash folder elsewhere for a test server, like `MC_ROOT` for the projects.
