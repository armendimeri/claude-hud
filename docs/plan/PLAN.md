# Claude HUD: one live dashboard for every Claude Code session on this PC

Status: **planned** · Written 2026-10-29 · Built in phases by separate agents that hand over through
[STATUS.md](STATUS.md) and [handoffs/](handoffs/). **Agents: start in STATUS.md, not here.**

## 1. Goal

One local web page (`http://127.0.0.1:7777`) that shows, live, every Claude Code session running on this PC, in
every project:
- what each session is doing right now and which subagents it has running;
- **who started whom:** the full tree of session → subagent → nested subagent, drawn as a live network (§6.4);
- **token usage per agent,** sessions and every subagent separately, plus how full each one's context window is;
- which sessions **need the user** (waiting for approval or input);
- the phase graph of any plan in `docs/plans/` in those projects (the plan template from WasteManagement2);
- **where each agent runs:** Claude Code on the Anthropic API, Claude Code on **Amazon Bedrock**, and (optionally)
  other apps of the user's that call Bedrock with API keys (§3 D11 and D12).

**The design bar is exceptionally high.** It should feel like Tony Stark's heads-up display, built with the craft
of the best product dashboards: cinematic, but calm and instantly readable. §6 defines what that means in
practice, and P3 reviews against it. "Looks fine" is a failed gate.

**Constraints:**
- **One file of code:** `hud.mjs`, Node 22 built-ins only. No `npm install`, no framework, no build step. The page's
  HTML, CSS and JS live inside the script as template strings.
- **Its own git repository** at `C:\Users\armen\source\repos\armendimeri\claude-hud`, to be pushed to a new remote
  by the user. It never writes into a project it watches.
- **Costs no Claude usage.** No model or API calls anywhere. Hooks print nothing (§4.2). The one optional exception
  is D12's CloudWatch read, which is off by default and can carry a very small AWS charge, never model usage.
- **Never slows Claude Code down or breaks it,** whether the HUD is running or not.
- **Local only.** Listens on 127.0.0.1; transcripts hold code and secrets.

**Out of scope:** starting, stopping or steering sessions from the HUD; history beyond what transcripts hold;
OpenTelemetry; anything that needs a Claude API key.

## 2. What exists on this PC (checked 2026-10-29)

| Source | Finding | Consequence |
|---|---|---|
| Node | `v22.12.0`, npm 10.9 | Built-ins are enough: `http`, `fs` (`fs.watch` is recursive on Windows), `path`, `os`, `child_process`. |
| `~/.claude/settings.json` | Holds `model`, `effortLevel`, `modelSettings`, `remoteControlAtStartup`. **No `hooks` key.** | `install` adds a `hooks` key without touching the rest; `uninstall` removes only our entries. |
| `~/.claude/sessions/<pid>.json` | One file per open session: `pid`, `sessionId`, `cwd`, `name` (e.g. `wastemanagement2-de`), `status` (`busy` / `idle`), `entrypoint` (`claude-vscode`), `version` (`2.1.312`), `kind`, `startedAt`, `updatedAt` (epoch ms). 5 files at the time of writing, across WasteManagement2 and FidiaCRM. | The roster of live sessions, even before any hook fires. **Undocumented format:** read defensively, treat missing fields as unknown, check the pid is alive (`process.kill(pid, 0)`). |
| `~/.claude/sessions/*.key`, `~/.claude/.credentials.json` | Peer tokens and login credentials. `messagingSocketPath` in the session files is a named pipe. | **Never read `*.key` or `.credentials.json`, never touch the pipe, never send any of it to the browser.** |
| `~/.claude/projects/<slug>/<sessionId>.jsonl` | One transcript per session, 0.5–7 MB each. Line types include `user`, `assistant`, `ai-title` (`aiTitle`), `last-prompt`, `tools-used`. `assistant` lines carry `message.model` (e.g. `claude-opus-5-5`), `effort`, `gitBranch`, `cwd`, `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and `message.content[]` with `tool_use` items (`name`, `id`). | Title, model, effort, branch and token totals per session. **Undocumented format:** tail-read from a remembered byte offset, skip lines that don't parse. A `<sessionId>/` folder next to the file holds `tool-results/` and `subagents/` (next row). |
| `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` + `agent-<agentId>.meta.json` | **Found 2026-10-29** (WasteManagement2 session `8132e8aa…`, two `web-fetch` subagents). The `.jsonl` has the same line format as a session transcript, every line with `isSidechain: true`, `agentId`, and the parent's `sessionId`; `assistant` lines carry their own `message.model` (here `claude-haiku-5-5`) and `message.usage`. The `.meta.json` holds `agentType`, `description`, **`toolUseId`** (the `id` of the parent's `Agent` tool call), **`spawnDepth`** (1 = started by the session itself), `isBuiltIn`, `requestShape` (`foreground`). | Per-subagent model and token totals, and the parent link: find the transcript (session or another subagent) that contains the `tool_use` with that `toolUseId`. `spawnDepth` > 1 means a nested subagent. A subagent that has finished has no hook-free "done" marker: P1 must find one (last-line age, `SubagentStop`, the parent's `tool_result`). |
| Bedrock | **Not checked on this PC** (no AWS configuration was inspected, and none should be read). Claude Code can run on Bedrock (an environment switch, `CLAUDE_CODE_USE_BEDROCK`, and AWS credentials or a Bedrock API key). Bedrock model ids look different: `anthropic.claude-…-v1:0`, `us.anthropic.claude-…`, `global.anthropic.claude-…`, or an ARN. Bedrock publishes per-model token counts to CloudWatch (`AWS/Bedrock`: `InputTokenCount`, `OutputTokenCount`, `Invocations`, dimension `ModelId`), delayed by a few minutes and not split by app. | Claude Code on Bedrock should still produce the same hooks, registry and transcripts, so it needs normalising of model ids and a `provider` field, not a separate engine (D11). Other apps calling Bedrock are invisible to hooks and transcripts: they need an ingest route or CloudWatch (D12). **P1 verifies the Bedrock transcript shape if the user has a Bedrock setup; otherwise tests the normaliser on sample ids and records "unverified on a real Bedrock session".** |
| Hooks | Claude Code runs configured hook commands on events and passes the event as JSON on stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus event fields such as `tool_name`, `tool_input`, `message`). User-level hooks in `~/.claude/settings.json` apply to every project. | The live event feed. P1 confirms the current event list and input fields in the official hooks documentation before writing the installer (the schema evolves between versions). |
| Plans | WasteManagement2 uses `docs/plans/<slug>/STATUS.md` with a `## Board` table (`Phase \| Agent \| State \| Since \| Handoff \| Notes`), "Waits for …" in Notes, and a `## Log` list. | The HUD draws a phase graph for every such plan in the projects it sees. |
| Repos folder | `C:\Users\armen\source\repos\armendimeri` holds the user's repos side by side and is not itself a git repository. | `claude-hud` is a sibling repo there: `git init -b main`, no remote (the user adds it and pushes). |

## 3. Decisions

Confirmed in STATUS.md (P0) before P1 starts. ★ = changes what the user sees.

| # | Topic | Proposal |
|---|---|---|
| D1 | Port | `127.0.0.1:7777`. `HUD_PORT` overrides it. |
| D2 | Hook forwarder | The script itself: `node "<path>/hud.mjs" hook`. It reads stdin, posts it to `/event` with a 400 ms timeout, prints nothing, **always exits 0**. If P1 measures more than 150 ms p95 per call, switch to `curl.exe -s -m 1 --data-binary @- … -o NUL` and record it. |
| D3 | Which events | SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, PreCompact, plus any subagent-start event the current docs list. |
| D4 ★ | What text is shown | Session title, project, model, effort, branch, tool names, and a **short, redacted** summary of each tool call (file path, first 80 characters of a command). Never full prompts, tool output or file contents. |
| D5 ★ | Voice and sound | "JARVIS" voice announcements (browser speech synthesis) and synthesized sound, **both off by default**, toggled in the top bar and remembered in the browser. |
| D6 ★ | Desktop notifications | Browser notifications when the tab is hidden, for: a session needs you, a plan phase is `blocked` / `bounced` / `handed-off`. Asked for on first click of the bell. |
| D7 | Retention | In memory only: the last 500 events, sessions that ended less than 2 hours ago. Restarting the HUD rebuilds sessions from the registry and transcripts. |
| D8 | Autostart | `node hud.mjs autostart on\|off`: a Task Scheduler task at logon, with no visible console window. |
| D9 | Phone access | Off. Listening beyond localhost is out of scope. |
| D10 | Repository | `claude-hud` with `main` as the default branch. Files: `hud.mjs`, `README.md` (hero screenshot), `docs/DESIGN.md` (permanent design reference), `docs/screenshots/`, `.gitignore`, and `docs/plan/` until P3 deletes it. No licence file unless the user asks. Agents commit only if the user asks, and never add a remote. |
| D11 ★ | Providers | Every session and subagent carries a `provider`: `anthropic`, `bedrock` or `unknown`. Detected from the model id (Bedrock id shapes in §2) and, as a second signal, from the `env` block of `~/.claude/settings.json` (only the `CLAUDE_CODE_USE_BEDROCK` flag is read; no other key of that block, and never AWS credentials). Model ids are normalised for display (`us.anthropic.claude-opus-5-5-…` → `claude-opus-5-5`); the raw id stays in the tooltip. The card shows a small `ANTHROPIC` / `BEDROCK` badge. |
| D12 ★ | Bedrock outside Claude Code | Two optional sources, both **off by default**. (a) **Ingest:** `POST /usage` accepts `{ app, provider, model, input, output, cacheRead, cacheWrite, at }` from the user's own apps; the README gives a 10-line snippet to call it after a Bedrock response. (b) **CloudWatch:** with `HUD_BEDROCK_REGION` set, the HUD runs `aws cloudwatch get-metric-data` (child process, at most once a minute) for `AWS/Bedrock` token counts per model, using the user's own AWS CLI profile. It shows per-model totals and a "delayed" label, not per app. The HUD never reads AWS credential files or environment keys and never stores them. CloudWatch API calls can carry a very small AWS charge; this is the only thing in the project that can cost money, and it is off unless the user turns it on. |
| D13 ★ | Usage meters | Per session and per subagent: tokens (input / output / cache read / cache write) and **context fill**: the last turn's input + cache tokens as a share of the model's context window, from a small table in `hud.mjs` (unknown model → shown as "—", never guessed). Headline token numbers are input + output + cache write; **cache read is shown separately**, because it re-counts the same context on every turn and would otherwise dwarf everything else. No money amounts in v1 (prices differ between Anthropic and Bedrock and change). **Account-level usage** (the 5-hour and weekly limits of a subscription) is not in transcripts: P1 checks whether Claude Code exposes it anywhere local without an API call (for example the JSON a status line command receives). If it does, P1 adds it as a question for the user (it would mean adding a status line entry); if not, it stays out of scope and the README says so. |

## 4. Contract

### 4.1 Commands

```
node hud.mjs                 serve on 127.0.0.1:7777 (HUD_PORT overrides)
node hud.mjs --demo          serve with simulated sessions, subagents, a plan and events (for building and showing off)
node hud.mjs hook            hook forwarder: stdin JSON -> POST /event; prints nothing; exit 0 always
node hud.mjs install         add our hooks to ~/.claude/settings.json (backup first, idempotent)
node hud.mjs uninstall       remove only our hook entries; leave everything else exactly as it was
node hud.mjs autostart on|off
```

### 4.2 Hook rules (non-negotiable)

- The forwarder **never writes to stdout or stderr** (for some events Claude adds hook stdout to its context, which
  costs tokens on every prompt).
- It **always exits 0.** A hook that exits 2 blocks the tool call; any non-zero exit shows an error in the session.
- Timeout in the hook config: 2 seconds. The forwarder gives up on its own after 400 ms.
- `install` writes a timestamped backup (`settings.json.hud-backup-<yyyyMMddHHmmss>`) before changing the file,
  keeps every other key and hook untouched, and marks our entries by the exact command string so `uninstall` finds
  them. Running `install` twice leaves one set of entries.
- Commands use forward slashes and a quoted script path, and must work in the shell Claude Code uses for hooks on
  Windows (P1 checks which one that is).

### 4.3 HTTP

| Route | What |
|---|---|
| `GET /` | The HUD page |
| `GET /design` | The component gallery (§6.6), served in every mode |
| `GET /api/state` | Full state snapshot (§4.4) as JSON |
| `GET /api/stream` | Server-sent events: `state` (full snapshot) on connect and at most 4 times a second after a change; `event` for each new feed line |
| `POST /event` | Hook payloads. Body limit 256 KB. |
| `POST /usage` | D12 ingest from the user's own apps. Body limit 16 KB, answers 404 unless `HUD_ACCEPT_USAGE=1`. |
| `GET /api/health` | `{ ok, uptime, sessions, version }` |

Every request: refuse unless the `Host` header is `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard). No
CORS headers.

### 4.4 State (sent to the page)

```js
{
  now, uptime, demo,
  sessions: [{
    id, pid, project, cwd, name, title, entrypoint, version,
    status,            // 'busy' | 'idle' | 'needs-you' | 'ended'
    needsYou,          // null | { since, reason }   e.g. 'Permission: Bash'
    provider,          // 'anthropic' | 'bedrock' | 'unknown'   (D11)
    model, modelRaw, effort, branch,   // model is normalised, modelRaw is the id as seen
    startedAt, lastActivityAt,
    currentTool,       // null | { name, summary, since }   summary already redacted
    tools,             // count of tool calls seen
    startedBy,         // null | sessionId of the session whose process started this one (§5)
    tokens: { input, output, cacheRead, cacheWrite },   // this session's own turns only
    tokensTree: { input, output, cacheRead, cacheWrite },   // own + every descendant subagent
    context,           // null | { used, window, pct }   (D13); null when the model's window is unknown
    subagents: [{      // a flat list of every descendant; the tree comes from parentId
      id, parentId /* session id or another subagent's id */, depth /* spawnDepth */,
      description, type, model, provider, state /* 'running' | 'done' */, startedAt, endedAt,
      tokens: { input, output, cacheRead, cacheWrite }, context, currentTool
    }]
  }],
  external: [{         // D12, empty unless enabled
    source,            // 'ingest' | 'cloudwatch'
    app,               // ingest only
    provider, model, tokens: { input, output, cacheRead, cacheWrite },
    windowStart, windowEnd, delayed   // delayed: true for cloudwatch
  }],
  plans: [{
    project, slug, title, path,
    phases: [{ id /* 'P1' */, name, agent, state, since, waitsFor: ['P0', …], notes }],
    lastLog: [ '…' ]   // last 5 log lines
  }],
  feed: [{ at, sessionId, project, kind, text }]   // newest first, max 200 in a snapshot
}
```

### 4.5 Redaction (server side, before anything leaves the process)

Applied to every string that reaches the page:
- `-P <value>`, `Password=…;`, `Pwd=…;`, `User Id=…;`;
- `Bearer …`, `token=…`, `apikey=…`, `api_key=…`, `secret=…`;
- AWS material: access key ids (`AKIA…` / `ASIA…` followed by 16 characters), `aws_secret_access_key=…`,
  `aws_session_token=…`, `AWS_BEARER_TOKEN_BEDROCK=…`;
- anything that looks like a key: 32+ characters of hex or base64.

The same function runs over everything that arrives through `POST /usage`, whatever the sender wrote in `app`.

Replace each match with `•••`. The page also sets every value with `textContent` (never `innerHTML` with data), so
nothing from a transcript can inject markup.

## 5. P1: the engine (no styling)

All in `hud.mjs`:
- **Server:** the routes in §4.3, Host check, SSE with keep-alive comments every 15 s.
- **Sources:**
  1. hook events (`POST /event`) → session updates and feed lines;
  2. the session registry (`~/.claude/sessions/*.json`, watched, skipping `*.key`);
  3. transcripts: tail from a byte offset on change, for title, model, effort, branch, tokens;
  4. plans: for each distinct project root (walk up from the session `cwd` to the folder with `.git`), parse
     `docs/plans/*/STATUS.md` (skip `_template`) into §4.4 `plans`; watch those files.
- **Session status rules:**
  - `needs-you` from a Notification event (the reason comes from its message), cleared by the next PreToolUse,
    UserPromptSubmit or Stop event of that session;
  - `busy` / `idle` from the registry, overridden by recent hook events;
  - `ended` after SessionEnd or a dead pid.
- **Subagents and the tree:**
  - An `Agent` (or `Task`) tool call opens a subagent (description, type from `tool_input`), keyed by the tool call's
    `id` until its `agentId` is known from `meta.json`.
  - **Closing:** a foreground subagent closes on SubagentStop or the matching PostToolUse. A **background** subagent
    (`run_in_background` in `tool_input`, or a `requestShape` other than `foreground` in `meta.json`) gets its
    PostToolUse as soon as it is *launched*, so it closes only on SubagentStop or, as a fallback, when its
    transcript has been silent for 2 minutes and its parent has moved on. Only `foreground` has been seen on this PC
    (2 samples): P1 runs a real background subagent and records what closes it.
  - Once `<sessionId>/subagents/agent-<id>.meta.json` appears (watch the folder), it gives `toolUseId` and
    `spawnDepth`. `parentId` is the session or subagent whose transcript holds the `tool_use` with that id; for
    `spawnDepth` 1 it is the session. Keep an index `toolUseId → owner` while tailing, and resolve late-arriving
    links when the owner's transcript is read later.
  - Tail each subagent's `.jsonl` exactly like a session transcript for model, tokens, context and current tool.
  - P1 runs a real subagent that itself starts a subagent, to confirm nesting (`spawnDepth` 2) and how "done" is
    detected, and records both in the handoff. Without a real nested run, nesting is **unverified**: say so.
- **Sessions started by other sessions (`startedBy`):** when a new session pid appears in the registry, walk its
  parent-process chain once (one `Get-CimInstance Win32_Process` call through `child_process`, 3 s timeout, at most
  8 levels). If an ancestor pid is another live session, set `startedBy` to that session (e.g. a coordinator that
  ran `claude -p` from its shell). Otherwise `startedBy` is null. The chain is read once per session, never polled.
- **Providers (D11):** normalise model ids, set `provider` on sessions and subagents, read the one
  `CLAUDE_CODE_USE_BEDROCK` flag. Unit-test the normaliser on at least: `claude-opus-5-5`,
  `anthropic.claude-opus-5-5-v1:0`, `us.anthropic.claude-opus-5-5-v1:0`, `global.anthropic.claude-sonnet-5-5-v1:0`,
  an `arn:aws:bedrock:…:inference-profile/…` id, and an unknown string (stays as it is, `provider: 'unknown'`).
- **Usage and context (D13):** per-turn `usage` is summed per agent; `context` comes from the **latest** turn only.
  A model-to-window table lives at the top of `hud.mjs`; an unknown model gives `context: null`.
- **External Bedrock usage (D12), only when enabled:** `POST /usage` validation (types, sizes, redaction, a cap of
  200 distinct `app`+`model` rows) and the optional CloudWatch poller (child process with a 10 s timeout, errors
  shown as one line in the state, never thrown). Neither runs, and neither route answers, unless switched on.
- **Demo mode** (`--demo`): realistic enough to design against, covering every state the page must handle:
  - 3 projects and 5 sessions: one needs you, one busy with two subagents (one of which has a nested subagent of its
    own), one idle, one that just ended, one with a very long title;
  - one of those sessions runs on `bedrock` (with a Bedrock-style model id) and the rest on `anthropic`;
  - three `external` rows (two ingest apps, one delayed CloudWatch row) so the panel can be designed;
  - token counters that grow, and a context fill that climbs towards ~90% on one session;
  - a plan with a P1 → (P2 ∥ P3) → P4 graph whose states advance every ~20 s, including one `bounced`;
  - a steady, varied feed.
  `--demo=dense` gives 24 sessions, to design the compact layout.
- **Commands:** `install` / `uninstall` / `autostart` (§4.1, §4.2).
- A minimal unstyled page at `/` that prints the state as JSON, so the engine can be checked before P2.
- **Repository:** `git init -b main`, `.gitignore` (`node_modules/`, `*.log`, `.hud-tmp/`), and a first `README.md`
  (what it is, the commands, how to remove it completely).

## 6. P2: the HUD (design bar)

The page inside `hud.mjs`, and `docs/DESIGN.md` describing it.

### 6.1 Direction

A **holographic tactical display**: layers of translucent glass panels over deep space navy, lit by arc-reactor
cyan. It should be cinematic, in the spirit of film UI (the Iron Man HUD), with the discipline of a premium product
dashboard: clear hierarchy, generous spacing, no decoration that carries no information.

Within **two seconds**, the user must be able to answer three questions:
1. Does anything need me?
2. What is running?
3. What just finished?

Every visual choice serves that order. Spectacle is reserved for what is live; everything at rest is calm and flat.

### 6.2 Foundations (tokens as CSS custom properties, documented in `docs/DESIGN.md`)

- **Colour.** Each colour has one job:

  | Token | Value | Job |
  |---|---|---|
  | `--void` | `#04070d` | Background |
  | `--deep` | `#08111c` | Panel base |
  | `--glass` | `rgba(16, 34, 52, .55)` | Panel fill, with `backdrop-filter: blur(14px)` |
  | `--arc` | `#29e6ff` | Live, primary |
  | `--arc-soft` | — | The same cyan at 35% / 15% / 6% for borders, glows and fills |
  | `--amber` | `#ffb547` | Working, waiting |
  | `--alert` | `#ff4d5e` | Needs you, blocked, bounced |
  | `--ok` | `#4dffa6` | Done, handed off |
  | `--agent` | `#b28cff` | Subagents |
  | `--ink` | `#d6f3ff` | Text |
  | `--ink-2` | `#d6f3ff` at 68% | Secondary text |
  | `--ink-3` | `#d6f3ff` at 42% | Labels only, never body text |

  All body text is at least 4.5:1 against its actual background.
- **Type:**
  - Display (wordmark, the reactor number, section titles): **Orbitron**.
  - Labels: **Rajdhani** 600, uppercase, letter-spacing +0.14em.
  - Body: **Inter**.
  - Numbers: **JetBrains Mono** with tabular figures.
  - Load them from Google Fonts with `display=swap`; offline fallbacks are `system-ui` and `Consolas`.
  - Scale: 11 / 13 / 15 / 18 / 24 / 34 / 56 px. Two weights per family at most.
- **Space.** A 4 px grid. Panel padding 20 px, gaps 16 / 24 px. Hairline borders are 1 px of `--arc` at 22%.
- **Shape.** Panels have 12 px cut corners (`clip-path`) with 2 px corner brackets in `--arc` at 60%. Chips are
  pills. Never mix rounded and cut corners in one component.
- **Depth.** Three layers only:
  1. background: a hex grid at 4% opacity, a radial vignette, a scanline overlay at ≤ 3%;
  2. panels: glass, inner glow, `0 0 40px` of `--arc` at 6%;
  3. floating: alerts and tooltips, a stronger glow, a 1 px brighter border.
- **Icons.** Inline SVG drawn for this project in one consistent 1.5 px stroke style: terminal, file, edit, search,
  web, agent, plan, bell, voice, sound. No icon fonts, no emoji.

### 6.3 Layout

- **≥ 1440 px:** a 12-column grid.
  - Left (3 columns): the reactor and the vital totals.
  - Centre (6 columns): the sessions.
  - Right (3 columns): plans.
  - Full-width ticker along the bottom (collapsible).
  - A slim top bar.
- **1024–1439 px:** plans move under the sessions.
- **< 900 px:** one column, with the reactor shrunk into the top bar.
- **Density.** Comfortable cards for up to 8 sessions; above that, compact rows (one line per session) switch on by
  themselves. Both must look composed: check with `--demo` and `--demo=dense`.
- **Long text** (titles, project names) truncates with an ellipsis and shows in full in a tooltip. Nothing ever
  overflows its panel.

### 6.4 Components

- **Top bar:**
  - **HUD** wordmark in Orbitron, with a thin reactor glyph;
  - live clock (tabular), uptime;
  - stream status light (cyan steady = live, amber pulse = reconnecting, red = down);
  - toggles for voice, sound and notifications as icon buttons with tooltips and visible on/off states.
- **Arc reactor** (SVG):
  - three concentric rings rotating at different speeds and directions;
  - one lit segment per active session on the outer ring, coloured by its state;
  - the inner ring fills with subagents;
  - the centre number is running agents (sessions + subagents), counting up and down with a short tick;
  - while anything needs you, the reactor shifts to `--alert` and breathes slowly (1.6 s cycle);
  - with nothing running it dims to a slow idle glow.
  - Below it, vitals: sessions, subagents, tokens today (with an input / output split), plans in progress, each a
    label over a number. "Tokens today" counts turns timestamped since local midnight, from transcripts; after a
    HUD restart it is rebuilt by re-reading today's turns, so it never resets to 0 by accident.
- **Network ("who started whom"):** the centre column has a switch, `CARDS | NETWORK`, remembered in the browser;
  `NETWORK` is the default when any subagent exists, `CARDS` otherwise. SVG, laid out from `parentId`:
  - **Core:** a small hub in the middle labelled with the machine name. **Sessions** are large hexagon nodes in an
    inner ring, grouped by project (a faint arc and the project label behind each group). **Subagents** are smaller
    violet hexagons on outer rings, one ring per `depth`, placed near their parent.
  - **Edges** run parent → child as thin lines. While a child runs, dashes flow along the edge from parent to
    child; when it finishes, one bright pulse travels back and the edge dims. That return pulse is the "handed
    the result back" moment.
  - **Node face:** state ring (same colours and shapes as the cards), the model's short name below, and a **context
    ring** around the node that fills with the context percentage (amber from 70%, red from 90%).
  - **Size or label carries tokens:** node radius scales with the agent's total tokens on a square-root scale
    (clamped to a 3× range, so nothing vanishes and nothing swallows the screen); the exact numbers are in the
    tooltip.
  - **Provider** is shown by a one-letter marker on the node (`A` / `B`), never by colour alone.
  - **Hover or focus** a node: its card appears as a floating tooltip (title, model, provider, current tool, token
    split, time running) and the path to the root lights up. **Click** pins it and scrolls its card into view.
  - **`startedBy` links** between sessions are drawn as a second edge style (a thin double line, no flow), so "this
    session was launched by that one" is not confused with a subagent.
  - **Calm rule:** only edges to *running* children move, and all flowing edges together count as **one** of the
    three moving things allowed by §6.5. With more than 3 running children, only the 3 newest edges flow; the rest
    stay lit but still. At rest the graph is still. Under reduced motion the dashes are off and the return pulse is
    a 300 ms fade of the edge.
  - **Density:** above 40 nodes, finished subagents collapse into a single numbered satellite on their parent
    (click to expand). Keyboard: arrow keys move between nodes, Enter pins.
  - **Empty:** just the hub, with "No active sessions · systems nominal".
- **Externals panel (only if D12 is on):** under the vitals on the left, a compact list of `external` rows: provider
  badge, app or model, tokens, and a `DELAYED` tag on CloudWatch rows. Hidden entirely when there are none.
- **Session card:**
  - Header: project label, then the title (Inter 15/600).
  - Chips: model + effort, branch, and a provider badge (`ANTHROPIC` / `BEDROCK`).
  - Status is always a word plus a colour plus a shape, never colour alone: BUSY has a fine amber scanning line
    across the top edge; NEEDS YOU has a red frame and breathes; IDLE is calm; ENDED drops to 45% and moves to the
    bottom.
  - Current tool: icon, name, redacted summary in mono, and a live timer.
  - "Started by …" line when `startedBy` is set (click jumps to that session).
  - Thin token meters (input / output / cache write, and cache read on its own line) with the numbers beside them;
    the session's figure is its own, with "incl. subagents" from `tokensTree` beside it; a **context meter** (percentage
    plus bar, "—" when the window is unknown; amber from 70%, red from 90%, always with the number).
  - Subagents as violet child rows, indented by `depth` (up to 3 levels, deeper ones fold into "+n more"), each
    with its own model, token total, context % and a spinning ring while it runs. When one finishes, the ring
    closes into a check that glows green for 1.5 s.
- **Plan graph** (SVG, laid out from `waitsFor`):
  - hexagon nodes with the phase id inside and the agent name under them;
  - colour by state: todo outlined dim, in-progress `--arc` pulsing, handed-off / accepted `--ok`, blocked /
    bounced `--alert`;
  - edges are thin lines; an edge into an in-progress node carries flowing dashes;
  - hovering a node shows a tooltip card with agent, since and notes;
  - the last log line sits under the graph.
- **Alert banner:** slides down from the top bar when a session needs you: project · session · reason, the time
  waiting, and a dismiss control. Several waiting sessions stack, with a count.
- **Ticker:** monospace lines with fixed-width coloured tags (`TOOL`, `AGENT`, `NEEDS YOU`, `DONE`, `PLAN`,
  `SESSION`); the newest line slides in at the top; hovering pauses it.

### 6.5 Motion, sound, voice

- **Boot sequence**, once per page load, at most 1.6 s, skippable with a click or a key, skipped entirely under
  reduced motion. In order:
  1. the grid fades in;
  2. the reactor rings draw on (stroke-dashoffset);
  3. the panels unfold from their corner brackets, 60 ms apart;
  4. the numbers count up from 0;
  5. "SYSTEMS ONLINE" types into the ticker.
- **State changes animate:**
  - a card enters by scaling from 0.98 with a fade (220 ms);
  - a status colour cross-fades (300 ms);
  - a card leaving collapses (200 ms).
- **Timing.** Durations 150–400 ms, easing `cubic-bezier(.2, .8, .2, 1)`. Only `transform`, `opacity`,
  `stroke-dashoffset` and `filter` are animated; never layout.
- **Calm rule:** at most three continuously moving things on screen besides the reactor.
- **`prefers-reduced-motion`:** rotation, scanning, dashes and the boot sequence are off; state changes become plain
  fades.
- **Sound (D5, off by default):** synthesized with Web Audio, each sound under 120 ms, a different pitch per event
  type, at most one every 300 ms.
- **Voice (D5, off by default):** short, butler-like announcements ("FidiaCRM needs your approval", "Phase P3
  handed off", "All agents idle"), queued so they never overlap, never more than one every 4 s.

### 6.6 Every state, designed

- **States:** boot, live, empty ("No active sessions · systems nominal", idle reactor), reconnecting (amber light and
  a thin banner; the last state stays visible and dimmed), and an error in one panel (shown in that panel only, with
  a retry).
- **Accessibility:**
  - keyboard focus visible (2 px `--arc` ring, 2 px offset) on every control;
  - `aria-live="polite"` on the ticker and alerts;
  - every icon button labelled.
- **Component gallery** at `/design`: every component in every state side by side (card × 4 states, reactor × idle
  / busy / alert, graph node × 5 states, banner, ticker, chips, the type scale, the colour tokens, **network × (1
  session / 1 session + nested subagents / 24 sessions), network node × (running, done, needs-you, context 50 / 80 /
  95%, Anthropic, Bedrock), context meter × 4 levels + unknown, externals panel**). This is how the design is
  reviewed and kept consistent.

### 6.7 Process (part of the P2 exit gate)

1. Write the direction and tokens into `docs/DESIGN.md` first, then build `/design`, then the page.
2. Run at least **three critique rounds**. Each round:
   - screenshot `/` (demo and dense) and `/design` at 1440×900, 1024×768 and 390×844;
   - critique against §6.1–6.6 and the checklist below, in writing, in the handoff;
   - fix what the critique found.
3. Keep round 1 and the final round as evidence: final images in `docs/screenshots/`, round 1 in the handoff
   folder.
4. **Tooling:** screenshots, traces and the reduced-motion check need a browser driver. P2 may use Playwright
   installed **outside this repository** (e.g. in `%TEMP%`), or Edge's headless mode, and records which in the
   handoff. Nothing it installs may become a dependency of `hud.mjs` or appear in the repo.

**Checklist** (every item must be true at the end):
- [ ] The three questions of §6.1 are answered within two seconds, for 1 session and for 24.
- [ ] Nothing is decorative without carrying information. Glow appears only on live things.
- [ ] Alignment holds to the 4 px grid. Spacing is consistent between panels of the same kind.
- [ ] Type uses only the scale and the families in §6.2. Numbers are tabular and never jump in width.
- [ ] No text overflows at any of the three sizes. Long names truncate and show a tooltip.
- [ ] Status is never shown by colour alone.
- [ ] Motion is smooth (no dropped frames visible in a Playwright trace). Idle page CPU stays under 5%.
- [ ] Reduced motion is checked (emulated).
- [ ] Contrast of body and secondary text measured (≥ 4.5:1).
- [ ] In the network view, "who started whom" is readable at a glance for a 3-level tree, and the busiest agent
      (by tokens) is visibly the biggest node, without opening anything.
- [ ] Context and token numbers are always shown as text next to any bar or ring, and a provider is never shown by
      colour alone.
- [ ] The hero screenshot is good enough for the top of the README, and shows the network view with a subagent tree.

### 6.8 Alive (D14, added by the user during P2)

The user wants the page to look **alive at rest**, full cinematic. Motion has three layers:
1. **Ambient** (not driven by data): reactor heartbeat, a radar sweep over the network, nodes that float, grid
   shimmer, mouse parallax, drifting particles, holographic flicker on panel edges, glitch transitions. Slow (4–12 s
   cycles) and dim, so it never competes with layer 3.
2. **Data:** everything that moves because something happened (sparks for tool calls, flowing dashes to running
   children, return pulses, rolling counters, filling rings, the ticker).
3. **Alert:** needs-you, blocked, bounced. The only fast, bright, red motion.

An **EFFECTS** toggle in the top bar (remembered in the browser, on by default) turns layer 1 off; layers 2 and 3
stay. `prefers-reduced-motion` turns layer 1 off and applies §6.5's reduced-motion rules to layer 2.

This replaces, for layer 1 only: §6.1 "everything at rest is calm and flat", the "three moving things" calm rules
of §6.4 and §6.5 (they still apply to layer 2), and the checklist item "nothing is decorative without carrying
information. Glow appears only on live things". The other checklist items still hold with effects on, in
particular the two-second questions and idle CPU under 5%.

## 7. Phases and agents

| # | Agent | Scope | Size |
|---|---|---|---|
| P0 | human | Decisions in `docs/plan/STATUS.md` | — |
| P1 | `engine` | `hud.mjs` (engine, demo, minimal page), `README.md`, `.gitignore`, `git init`; `~/.claude/settings.json` only through `install`/`uninstall` | M |
| P2 | `hud` | The page and `/design` inside `hud.mjs`, `docs/DESIGN.md`, `docs/screenshots/`, the README's screenshot and usage section. The engine only for bugs found while building, listed in the handoff | L |
| P3 | `review` | An independent design review against §6 (it may bounce P2) and the verification in §8; `autostart`; the final README. Then it deletes `docs/plan/`; `docs/DESIGN.md` stays. | M |

The phases run one after another: there is one code file, so no two agents may work at the same time.

**P1 exit gate:**
- [ ] `node hud.mjs` serves; `curl http://127.0.0.1:7777/api/health` answers; a request with `Host: evil.test` is refused.
- [ ] `/api/state` lists the sessions from `~/.claude/sessions/*.json` with title, model and tokens from their transcripts (output pasted, secrets checked to be absent).
- [ ] `install` → backup file exists, the diff of `settings.json` shows only the added `hooks`; `install` again → no change; `uninstall` → file identical to the backup (`fc` / `diff` output).
- [ ] With hooks installed, a new Claude Code session's tool calls appear in `/api/stream` within 1 s; a permission prompt makes that session `needs-you`.
- [ ] With the HUD **stopped**, a session with hooks installed works normally: no error and no added output. Forwarder timing: p95 under 150 ms over 50 calls, measured both with the HUD running and stopped.
- [ ] One real subagent shows up under its parent (`parentId` correct, from `meta.json`'s `toolUseId`), with its own
      model and token totals read from its `subagents/*.jsonl`, and closes when it finishes. A nested subagent
      (`spawnDepth` 2) shows under the right parent, or is recorded as **unverified** with the reason.
- [ ] `context` is computed for a real session and matches a hand calculation from that transcript's last turn.
- [ ] Provider: the normaliser passes the six test ids in §5. A real Bedrock Claude Code session is seen with
      `provider: 'bedrock'`, **or** the handoff says in plain words that none was available and the Bedrock path is
      unverified. With D12 off, `POST /usage` answers 404 and no `aws` process is ever started (checked).
- [ ] With D12 on (if the user enabled it): a `POST /usage` with a fake key in `app` shows redacted in `/api/state`;
      a CloudWatch failure (no `aws` CLI, bad profile) leaves the HUD running and shows one error line.
- [ ] A plan from WasteManagement2 appears in `plans` with its phases and edges.
- [ ] `--demo` and `--demo=dense` produce changing state covering every case in §5.
- [ ] Redaction: a test string with `-P Secret123`, `Password=abc;`, `AKIAABCDEFGHIJKLMNOP` and
      `AWS_BEARER_TOKEN_BEDROCK=xyz` comes out as `•••` in each place.
- [ ] A background subagent stays `running` after its launch returns and closes when it really finishes (or the
      handoff records what was seen instead).
- [ ] A session started from another session's shell (`claude -p "say hi"`) shows `startedBy` set to that session.
- [ ] Account-level usage: the handoff states whether a local source exists (with evidence), and asks the user if so.

**P2 exit gate:**
- [ ] §6.7 done: three critique rounds written up, round 1 and the final screenshots kept, every checklist item true.
- [ ] `/design` shows every component in every state, including the network, context meter and externals panel.
- [ ] Network view seen live with a real session that starts a subagent: the node appears, dashes flow while it
      runs, the return pulse plays when it finishes, and the node's size grows as its tokens do.
- [ ] Live update seen without reload with real sessions; stopping and starting the server shows reconnecting, then recovers.
- [ ] Needs-you banner, reactor alert, a notification when the tab is hidden, and voice and sound (when switched on) all seen or heard.
- [ ] `docs/DESIGN.md` documents the tokens, type, motion rules and components as built.

**P3 exit gate:**
- [ ] Design review written in the P2 handoff's Review section: what meets the bar, what doesn't. Anything below
      the bar → bounce P2 with a specific list.
- [ ] Everything in §8 passes on a clean run.
- [ ] Autostart on and off works.
- [ ] README complete, with the hero screenshot.
- [ ] `docs/plan/` deleted; `git status` shows a clean tree ready for the user's first commit.

## 8. Verification

1. `uninstall`, then check that `settings.json` equals its pre-install backup.
2. `install`, then open two sessions in different projects. Both appear with the right titles.
3. Start a coordinator with subagents in WasteManagement2: the subagents appear under it, and the plan graph updates
   as STATUS.md changes.
4. Trigger a permission prompt: banner, red reactor, notification.
5. Kill the HUD in the middle of a session: the session carries on unaffected. Restart the HUD: the state rebuilds.
6. `autostart on`, log off and on: the HUD is running with no visible window. `autostart off` removes the task.
7. Search the served page and `/api/state` for the WasteManagement2 database password: no match.
8. Start a coordinator that starts a subagent that starts another: all three levels appear in the network with the
   right parents, each with its own tokens; the totals in the vitals equal the sum of the agents.
9. Bedrock: if the user has Claude Code on Bedrock, open one session with it and one on the Anthropic API: both are
   listed, with correct badges and normalised model names. If not, state that this was not tested.
10. Search the served page, `/api/state` and the repository for AWS access keys, secret keys and
    `AWS_BEARER_TOKEN_BEDROCK` values: no match. Confirm by code search that `hud.mjs` never opens
    `~/.aws/*` and never reads `AWS_*` environment variables.
