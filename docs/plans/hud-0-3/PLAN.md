# Claude HUD 0.3: follow board items, warn early, a lighter page

Status: **proposed** · Written 2026-11-25 · Checked against the code 2026-11-25 · Phased plan: agents start in
[STATUS.md](STATUS.md), not here.

## 1. Goal

When this is done, the owner can:

- **Follow each board item.** See which agent is on which item right now, in every project, and see where the
  board and the agents disagree: an agent working on an item the board still calls `todo`, an `in-progress` item
  nobody is working on, an item started before what it depends on.
- **See what to do next.** One list of what can start now (with its kickoff prompt, ready to copy), what is waiting
  to be accepted, and what is waiting on the owner.
- **Be warned early:** a context window nearly full, a tool that has run too long, a subagent gone silent, usage
  close to a limit.
- **Trust the sessions list:** no blank subagents, no sessions that flash on and off when a window opens, and a
  parent that is waiting on its subagents no longer looks idle.
- **Use it from a phone or a TV:** updates a tenth of today's size, a TV mode, and an optional push to a phone when
  a session needs them.
- **Pay less per hook:** each hook event costs about 40 ms less.

**Out of scope:** changing a board from the HUD; starting, stopping or answering sessions from the HUD; history
kept on disk; money amounts; HTTP hooks; changes to the workflow standard (`workflow/`); Codex links beyond a
session's title and branch.

## 2. What exists

Measured on the live HUD on 2026-11-25 (4 open sessions, 14 boards, 6 projects).

| Area | Finding | Consequence |
|---|---|---|
| Code layout | Everything is in `hud.mjs` (about 5,650 lines): engine, page (`HUD_CSS`, `hudClient`), demo (`makeDemo`), install, `lint`, `selftest`. | Every item changes the same file, so items run one after another, never side by side. Find code by function name: line numbers move after every item. |
| Page code | `hudClient`, `pageMain` and `designMain` are sent to the browser with `Function.prototype.toString`. | Page code can't use anything from the server's scope. Data reaches the DOM through `textContent` and attributes only. |
| Plan link today | `snapshot()` sets `working` on every plan of a project when any session there is busy (`busyBy`). | One agent lights all four WasteManagement boards, and no item is marked. Replaced by §4.2. |
| Waiting parent | A session whose background subagent is running shows `idle`: `sessionStatus()` takes the Stop hook over the registry's `busy`, and `busyBy` skips it. | The board that is being worked on shows no "Working". Fixed in P2 (D6). |
| How sessions name items | In four live transcripts: the `description` of every Agent call starts with the item's ID (4 of 4, "P6-03 partial payments UI test"). 2 of 4 Agent prompts hold `<slug>/<ID>`. Prompts also name many other IDs (dependencies, `D4`, `Q1`, `F-3`). User prompts rarely say "Do `<slug>/<ID>`". Sessions edit the `STATUS.md` of the plan they work on. | The first ID of a description or title is the assignment. IDs elsewhere in a prompt are mentions, never an assignment. Plan-file edits say which plan (§4.2). |
| Repeated IDs | `P6-02` is in two WasteManagement plans. | A bare ID needs its plan from other evidence, or it links to nothing (D2). |
| Plan parser | `parsePlan()` reads standard and older boards into nodes (`id`, `name`, `agent`, `state`, `since`, `waitsFor`, `waitsForOther`, `kind`) and runs (`chunks`, `startWhen`). `diffPlan()` reports state changes to the feed. | Reused as it is. P4 adds only what §4.2 needs. |
| State pushes | `scheduleState()` sends the whole snapshot on every change: 175 KB (plans 116, feed 40, sessions 20), 17 pushes in 30 s. Feed lines also arrive as their own `event` messages. | Plans and feed go out on change only (§4.4). |
| Plan cards | `planCard().update()` rebuilds the need rows and run chips on every push. `planGraph().update()` already skips when nothing changed. | The same guard, in P3. |
| Blank subagents | 12 in the state: a hook with an `agent_id`, no `agent_type` and no transcript, 2 to 5 s after a Stop. `subForAgent()` makes the entry, `sessionView()` shows it, `closeSub()` writes "Agent done ·". | Hidden in P2 (D7). |
| Context windows | `CONTEXT_WINDOWS` ends at the 5.1 models. | A Fable 5.2 session has no context ring (D8). |
| Brief sessions | When a VS Code window opens, old conversations get a process for a few seconds. The ended list was fixed on 2026-11-25 (`lastWork`, `endedLongAgo`). | They still flash as open for about 2 s, write feed lines and play sounds. Fixed in P2 (D7). |
| Hook cost | `node hud.mjs hook` takes 105 ms; bare Node takes 60 ms. The rest is parsing a 381 KB file. | A small second file (D14). |
| Tests | `node hud.mjs selftest` (pure functions), `tests/codex.test.mjs` (a HUD over temp folders, 8 subtests), `tests/browser-smoke.mjs` (Edge, needs a server showing a Codex session). No test posts a hook event. | P1 builds the helpers every later item uses. |
| Secure context | Clipboard, wake lock and browser notifications work on `localhost` and HTTPS only. A LAN address is plain HTTP. | Copy needs a fallback; wake lock is best effort; phone alerts need a push from the server (D13). |
| Docs and gallery | `README.md`, `docs/DESIGN.md` §8, the gallery at `/design` (`designMain`), the demo (`makeDemo`). | Every new visible thing gets a demo entry, a gallery specimen and a DESIGN.md paragraph. |
| This repository | It has no `CLAUDE.md`, `docs/status.md`, `docs/roadmap.md` or `docs/checks.md`, and the kit's skills aren't installed in `~/.claude`. | Agents read the skill and the standard from `workflow/` here, and skip the steps that need those files (STATUS, Always). |
| The live HUD | Task Scheduler runs it from this folder on port 7777 with `--lan`. It reads `hud.mjs` only at start. | Nothing an agent changes is live until the owner restarts it. Agents test on ports 7790 to 7799. |

## 3. Decisions

Proposed defaults, confirmed by the owner in STATUS.md (P0) before P1 starts. ★ = changes what the owner sees.

| # | Topic | Proposal | Why |
|---|---|---|---|
| D1 ★ | What "following" means | The HUD links live agents to board items from evidence and shows where they disagree with the board. It never writes to a board. | The board stays the agents' record; the HUD is the check on it. |
| D2 ★ | Evidence, and no guessing | In this order: `<slug>/<ID>` in the agent's task; the first IDs of its description or title; the plan whose files it reads and writes; its branch. An ID found in two plans, with nothing to choose between them, links to nothing. | A wrong link is worse than none, as with the context ring. |
| D3 | Prompts | Task text is read in memory for ID-shaped words only. Nothing else is kept, sent or shown. | Keeps "never full prompts" from the first plan (its D4). |
| D4 ★ | Drift | Three marks, in amber: **board not updated** (worked on for 3 minutes while `todo`), **stalled** (`in-progress`, no agent on it for 30 minutes), **started early** (a dependency isn't handed off). | The three ways a board goes wrong in practice. |
| D5 ★ | Work queue | Five counts at the top of Plans: Needs you, In flight, Ready, To accept, Drift. Each opens its list. A Ready row copies `Do <slug>/<ID>. Follow the workflow-run skill.` | Answers "what do I start next" without opening a board. |
| D6 ★ | Waiting parent | A session that is idle with a running subagent reads "Agents working", in the subagent colour. The API keeps its four statuses and adds a count. | It isn't waiting for the owner. |
| D7 ★ | Noise | A session with no work yet appears after 8 seconds, or at its first work. A subagent only a hook has named is not shown. | Removes the flashes, the blank nodes and their feed lines and sounds. |
| D8 | Context windows | Add the 5.2 models only with a window taken from a source the agent cites. | A wrong ring misleads. |
| D9 | Updates | Plans and feed are sent when they change, not with every push. Target: a steady push under 30 KB with today's 14 boards. | A phone or TV parses 175 KB several times a second today. |
| D10 ★ | Quiet boards | A board is folded under "+N quiet boards" when all its items are finished, or when it hasn't changed for 14 days and nothing on it is in flight or needs the owner. A click unfolds it. | 14 boards are shown; about half are finished or weeks old. |
| D11 ★ | Warnings | Amber, never red (red stays "needs you"): context at 80% and again at 90%; a tool running 10 minutes (not Agent calls, not background commands); a running subagent with no activity for 5 minutes; 5-hour or weekly usage at 90%. Each is announced once. | Trouble that is cheap to see early. |
| D12 ★ | Page extras | A 30-minute line of output tokens per minute on each session, with the length of its last turn. A "while you were away" summary after 5 minutes away. Click a project name to show only that project. A link that opens the session's VS Code window (this PC only). | The rest of the ideas the owner approved on 2026-11-25. |
| D13 ★ | TV and phone | `?kiosk` gives bigger type, no toggles, and focus on whoever needs the owner. `HUD_PUSH_URL` (off by default) posts "`<project>` needs you: `<kind>`" to that address: never a title, a path or a command. | Viewing over the network is in use; a phone can't get browser notifications over plain HTTP. |
| D14 | Hooks | The forwarder moves to a second small file, `hud-hook.mjs`. "One file" becomes two, still with no build. HTTP hooks are not adopted. `HUD_RECORD=<file>` (off by default) writes received hook events, redacted, for building tests. | 40 ms per event. The docs don't say an HTTP hook can run without Claude Code waiting for it. |
| D15 | Git | Agents commit on a new local branch `hud-0-3`: first the uncommitted work of 2026-11-25 and this plan, then one commit per accepted item. No push, no remote. | Ten items in one file need a way back when one is bounced. |
| D16 | Left out | History on disk, money amounts and approving prompts from the HUD stay out. | Each reverses a decision of the first plan. |

## 4. Contract

If the code and this section disagree, one of them is wrong: fix the code, or record the deviation in a handoff.

### 4.1 Keys

- `planKey` = `<project>|<slug>`, the key `renderPlans` already uses.
- `itemKey` = `<planKey>#<ID>`.
- A field that holds a session or agent id is named `sessionId` or `agentId` (both are in `NO_REDACT`). P4 adds
  `plan` to `NO_REDACT`.

### 4.2 From evidence to links (P4)

**What the engine keeps for each agent** (a session or a subagent), in memory only:

| Evidence | Where it comes from | Limit |
|---|---|---|
| `label` | Session: its title. Subagent: its `description`. | — |
| `refs` | ID-shaped words from its task text, in order. Subagent: the `prompt` of the Agent call (`onAgentCall`). Session: each user prompt (`onUserLine`; not `isMeta` lines, not tool results), newest prompt last. | 40 words; the text itself is dropped at once |
| `touched` | Plan files it read or wrote: `Read`, `Edit`, `Write`, `MultiEdit` whose `file_path` is a known plan file, its `PLAN.md` or a file in its `handoffs/`. From the transcript and from `PreToolUse`, counted once per tool-use id. | 20, newest last, each with `write` and `at` |
| `branch` | `info.branch` | — |

ID-shaped words: `<slug>/<ID>` and bare `<ID>`, where an ID is `[A-Z]{1,4}-?\d+(-\d+)?`, or a run `R<n>` / `S<n>`.
Words are kept raw and resolved at snapshot time, because a transcript can be read before its plan is.

**`resolveWork(agent, parentWork, plans)`** is a pure function, covered by `selftest`:

1. Candidate plans are the plans of the agent's project.
2. **Home plan**, first match wins:
   1. the first `<slug>/…` in `refs` that names a candidate plan;
   2. the plan of the newest `touched` entry (a write beats a read made within the same 10 minutes);
   3. a branch `<slug>/…` that names a candidate plan;
   4. the parent's home plan (a subagent's session, or the agent that started it);
   5. none.
3. **Items**, all that apply, at most 3:
   1. `via: 'ref'`: the first `<slug>/<ID>` in `refs` whose plan has that ID. A run ID links the run and its current
      item (the first of its `chunks` that isn't `handed-off`, `accepted` or `done`).
   2. `via: 'name'`: each ID in `label`, in text order. It resolves in the home plan if that plan has it; else in the
      only candidate plan that has it; else in the only candidate plan where that item isn't finished; else it links
      to nothing.
   3. `via: 'branch'`: a branch `<slug>/<ID or run>`.
   A bare ID in `refs` is never an item: it only counts as a mention.
4. **Role:** `coordinator` for a session that has a subagent linked in the same plan, else `worker`.
5. An agent is **active** when it is a running subagent, or a session that is `busy` or `needs-you`.

**Who changed the board.** `planWrites` maps a plan file to the last agent that wrote it and when. When `diffPlan()`
sees an item change state in a scan that follows such a write within 60 seconds, the change is recorded with that
agent. Each plan keeps its last 50 changes, in memory.

**Marks and lists** (D4, D5). An item is **in flight** when a linked agent is active.

| Name | True when | Applies to |
|---|---|---|
| `unclaimed` | in flight for 3 minutes without a break, and its state is `todo` | every board |
| `stalled` | `in-progress`, not in flight, and 30 minutes since it was last in flight, last changed state, or its file last changed (whichever is latest) | every board |
| `early` | `in-progress` or in flight, while a dependency in the same plan is not `handed-off`, `accepted` or `done` | boards with a dependency column |
| `ready` | `todo`, not an owner input, every dependency `handed-off`, `accepted` or `done`, not in flight. A run: `todo` and every "Start when" ID done. | standard boards |
| `awaiting` | `handed-off` | standard boards |
| `ownerInputs` | an `O-<n>` in `todo` that a `todo` item depends on, with the IDs it unlocks | standard boards |

### 4.3 State (`/api/state`)

```
session.agentsRunning   n                                   P2   running subagents
session.work            { plan, items: [{ id, via }], role } | null      P4   also on every subagent
state.board             {                                   P4
  items:   { <itemKey>: { agents: [{ sessionId, agentId, active, via, role }], flags: [..], since } },
  plans:   { <planKey>: { active: n } },
  ready:   [{ plan, id, run }],   awaiting: [{ plan, id }],   ownerInputs: [{ plan, id, unlocks: [..] }],
  history: { <planKey>: [{ at, id, from, to, sessionId, agentId }] }
}
state.alerts            [{ id, kind, sessionId, agentId, project, text, since }]     P6
session.pulse           { start, perMin: [..] }            P6   also on every subagent
session.turn            { startedAt, lastMs }              P6
state.push              { enabled, lastError }             P8
```

- `board.items` holds only items that have an agent or a mark.
- `plans[n].working` is removed in P3. From P3 the page counts busy sessions by project itself; from P4 it uses
  `board.plans[planKey].active`.
- `pulse.start` is the epoch time of the first minute; the page pads the list up to now, so an idle session needs
  no push to stay correct.
- `alerts[n].id` is stable while the condition lasts (`<kind>:<sessionId>:<agentId or level>`), so the page can
  announce it once and remember that it was dismissed.

### 4.4 Stream (`/api/stream`), from P3

| Event | Sent | Holds |
|---|---|---|
| `state` | First on every connection: the full state. Then on change, as today: the state **without** `plans` and `feed`. | §4.3 |
| `plans` | When the plans change (compared as JSON), after the first `state` | `{ plans: [...] }` |
| `event` | As today | one feed line |

`pageMain` keeps the last `plans` and `feed` and puts them back before `hud.render(st)`. `/api/state` always
returns everything. The demo follows the same rules.

### 4.5 Test helpers (`tests/helpers.mjs`), from P1

```
startHud({ demo, env })  →  { base, port, dir, claude, codex, state(), until(predicate), post(event), stream(), stop(), restart() }
transcript(hud, sessionId, lines)      registry(hud, sessionId, { pid, ...fields })
board(hud, slug, markdown)             said(sessionId, at, extra)        // one assistant line
```

`startHud` runs `hud.mjs` over temp folders with the environment `tests/codex.test.mjs` uses today (`HOME`,
`USERPROFILE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HUD_CODEX_DIRS`, `HUD_CLAUDE_DIRS=''`, `HUD_NO_AUTOINSTALL=1`,
`HUD_PORT` = a free port, `HUD_LAN=0`). `post` sends a hook event to **that** HUD's `/event`.

### 4.6 Rules for all page work

- Colours, type, spacing and motion come from `docs/DESIGN.md`. Amber is "working, waiting"; red is "needs you" only.
- The background stays quiet. New motion goes in the foreground, means something, and stops with the EFFECTS toggle
  and with reduced motion.
- Every new component gets a demo entry (`makeDemo`), a specimen in `/design` (`designMain`) and a paragraph in
  `docs/DESIGN.md` §8.
- It must work at 1440×900, 1024×768 and 390×844 with no horizontal page scroll.

## 5. P1: test harness and hook replay

- `tests/helpers.mjs` (new): §4.5, lifted from the set-up at the top of `tests/codex.test.mjs`, which then uses it.
- `tests/hooks.test.mjs` (new): posts hook events and checks the state. First cases: a `PreToolUse` sets the current
  tool; `Stop` clears it; a `Notification` with `permission_prompt` gives `needs-you`; an Agent call with
  `SubagentStart` and `SubagentStop` gives one finished subagent.
- `tests/browser-smoke.mjs`: starts its own `--demo` HUD on a free port instead of taking a URL. It visits
  `/?view=network`, `/?view=cards` and `/design` at the three sizes of §4.6, fails on a runtime exception or a
  horizontal page scroll, and saves screenshots to `.hud-tmp/`.
- `hud.mjs`: `HUD_RECORD=<file>`. `handle()` appends each accepted `/event` body, after `redactDeep`, as one JSON
  line. Off unless set. `README.md` gets a line under "The hooks".

**Hard parts**
- Free ports: take one from the OS (as the Codex test does), never a fixed number.
- A test must never post to port 7777: `post` only knows its own HUD.
- Stopping: stop the child you started, by its handle. Never stop `node` by name: other tools run on Node.
- The Edge profile folder can stay locked for a moment; keep the retry that `browser-smoke.mjs` has.

## 6. P2: truthful sessions

All in `hud.mjs`, engine first, then the page.

- **Blank subagents (D7).** A subagent that has no `toolUseId`, no transcript (`sub.tail`), no `type` and no
  `description` is a placeholder. `sessionView()` leaves it out, and `closeSub()` writes no feed line for it. It
  stays in `s.subs`, so a `meta.json` that arrives later still completes it.
- **Settle time (D7).** A session known only from the registry is not in `snapshot()` until 8 seconds after it was
  first seen, or its first work (`lastWork(s) > 0`), whichever comes first. Its "Session started" or "Session
  resumed" feed line is written when it becomes visible, and "Session ended" only if it was visible.
- **Waiting parent (D6).** `sessionView()` adds `agentsRunning`. The page shows "Agents working" (subagent colour,
  running glyph) where it shows Idle, when `status === 'idle'` and `agentsRunning > 0`: in `statusTag` callers,
  `sessionCard`, `compactRow`, the network node face and `nodeCard`. The reactor's ring counts it with busy.
- **Context windows (D8).** Add the 5.2 models to `CONTEXT_WINDOWS` with a cited source in the handoff. If no source
  can be found, leave them out and say so.

**Hard parts**
- The settle timer must not delay a session that works at once: a hook or a dated transcript line shows it
  immediately. Sessions found at start-up (`scanRegistry` in the first 5 seconds) are shown at once.
- `happenings()` plays a sound when a session appears: with the settle time it now fires when the session becomes
  visible, which is the wanted result. Check it doesn't fire twice.
- Don't add a fifth status. `STATUS_ORDER`, the `rank` maps, `totalsFor` and the announcer all switch on the four.

## 7. P3: a lighter stream

- Server: `scheduleState()` sends `state` without `plans` and `feed`, and a `plans` event when the plans' JSON
  changed. `openStream()` still sends everything first. `snapshot()` drops `working`. `makeDemo` does the same.
- Page: `pageMain` merges (§4.4). `createHud().render` must not clear the plans when a state has none.
  `planCard().update()` skips the need rows and the run chips when their text is unchanged. The "Working" chip
  counts busy sessions (and sessions with `agentsRunning`) by project, on the page.
- `tests/tools/stream-size.mjs` (new): connects for a given time and prints the number, size and rate of each event.

**Hard parts**
- Reconnect: a new connection starts with a full `state`, so the page must replace, not merge, on that one. Mark
  the first message of a connection.
- `tick.sync(feed)` fills gaps from the snapshot's feed. With no feed in later pushes it must do nothing, not clear.
- The `/design` gallery calls `render` with complete fixtures: it must keep working unchanged.

## 8. P4: board following, the engine

All in `hud.mjs`, plus tests. Nothing on the page changes in this item.

- Parser: keep whether the Handoff cell is filled (`handoff: true | false`), and each run's `chunks`.
- Evidence (§4.2): `refs` in `onAgentCall` and `onUserLine`; `touched` in `onAssistantLine` and `onHook`
  (`PreToolUse`); `planWrites`.
- `resolveWork()`, the marks and the lists (§4.2), computed in `snapshot()` into `work` and `board` (§4.3).
- `diffPlan()` records who changed what, and feeds "`<plan>`: P3 claimed by `<title>`" when it knows.
- Feed and `needs-you`: a mark that turns on writes one feed line (`kind: 'plan'`), once per item and mark.
- `makeDemo`: links, one item of each mark, and every list, so P5 has data to draw.

**Hard parts, each with its test**
- **Order of arrival.** A transcript is often read before its plan. Keep words raw; resolve in `snapshot()`. Test:
  the same state whether the board or the transcript is written first.
- **Restart.** Everything except `history` and the 3- and 30-minute timers is rebuilt from transcripts. After a
  restart, `unclaimed` and `stalled` start counting from the restart. Test: links are equal before and after
  `restart()`.
- **Repeated IDs.** Test with two plans that both have `P6-02`: a bare ID links to nothing; with a `touched` plan
  file it links to that plan; with `<slug>/P6-02` it links to that slug.
- **Mentions.** A prompt that lists six IDs links to none of them. Only the label and a `<slug>/<ID>` can assign.
- **Older boards.** FidiaCRM's 116-item board and ImPOS-Maui's tables have no dependency column and other states:
  links and `unclaimed` / `stalled` work, the lists are skipped.
- **Windows paths.** Compare file paths lower-cased, with either slash. A worktree's plan file belongs to the main
  repository's plan (`rootFor().mainRoot`).
- **Privacy.** No prompt text is stored: a test posts a prompt holding a marker word and checks the marker is in
  neither `/api/state` nor a `HUD_RECORD` file.
- **Cost.** `snapshot()` runs up to four times a second. Resolve once per snapshot, not per reader; keep it under
  5 ms with 300 items and 30 agents (measure it).

## 9. P5: board following, the page

- **Plan graph** (`planGraph`, `planNodeCard`): an item in flight gets the pulse an `in-progress` item has today,
  plus the number of agents on it. A mark shows as a small amber badge. The item's card lists who is on it (click
  jumps to that session), its marks in words, and its last three changes ("claimed by … 14:02").
- **Work queue** (new, top of the Plans panel): the five counts of D5. A count opens its list; a row shows project,
  plan, ID, title, and model and effort. Ready rows have a Copy button for the kickoff prompt and show the folder to
  open. In-flight rows jump to the agent.
- **Sessions:** `sessionCard`, `compactRow`, subagent rows and `nodeCard` show "On `<ID>` · `<plan title>`".
- **Quiet boards (D10):** folded under one row at the end of Plans; the choice is remembered (`prefs`).
- **Announcements:** `happenings()` reports a mark turning on (sound and voice follow the existing toggles).
- The "Working" chip now uses `board.plans[planKey].active`.

**Hard parts**
- **Copy over the network.** `navigator.clipboard` is missing on a LAN address. Fall back to a selected, read-only
  text field and `document.execCommand('copy')`; if that fails too, leave the text selected and say "Press Ctrl+C".
- **Rebuilds.** The graph is rebuilt only when its signature changes. Add the in-flight count and the marks to the
  signature, or they won't update.
- **Room.** The queue must fit a 390 px wide screen and must not push the first board below the fold at 1024×768:
  one line of counts, lists open in place.
- **Empty states.** No boards; boards but nothing in any list.

## 10. P6: warnings and the activity line

- Engine: `alerts` (§4.3, D11) computed in `snapshot()`, with hysteresis (context: on at 80, off below 75; the 90
  step likewise at 85). Tool alerts need `status === 'busy'`, a current tool older than 10 minutes, and skip `Agent`,
  `Task` and commands with `run_in_background`. Usage alerts come from `account`.
- Engine: `pulse` (output tokens per minute, 30 minutes, kept beside `byDay` and corrected the same way when a
  message's usage line repeats) and `turn` (from `UserPromptSubmit` and `Stop`; Codex from `task_started` and
  `task_complete`).
- Page: warnings share the banner area under the top bar, below any "needs you" banner, in amber, each with ×.
  `happenings()` announces a new alert id once (the existing sound, voice and notification toggles apply). The
  activity line is a small SVG in `sessionCard` and `nodeCard`; the last turn's length sits next to it.

**Hard parts**
- A message's usage is written on several lines: `onAssistantLine` subtracts the earlier count before adding. The
  per-minute buckets must do the same, or they double.
- An open tool with no result line (an interrupted call) can look as if it has run for hours: require `busy`.
- Dismissing: remembered by alert id until that id leaves the state; the 90% step is a new id.

## 11. P7: page extras

Page code only, except one field.

- **While you were away:** when the page becomes visible after 5 minutes hidden, or the stream reconnects after 5
  minutes, fetch `/api/state` and show one dismissable card: turns finished, agents done, items that changed state,
  what needs the owner, counted from the feed since the page was last seen.
- **Project focus:** clicking a project name (network group label, plan card, feed line) shows only that project in
  sessions, plans and feed. `?project=<name>` does the same. Escape, or a second click, clears it.
- **Open the window:** sessions whose `entrypoint` contains `vscode` get a link `vscode://file/<cwd>`, shown only
  when the page is open on `127.0.0.1` or `localhost`.

**Hard parts**
- The focus filter must not break the "more below" bars or the network layout: filter the lists before they reach
  `reconcile` and `net.update`.
- Windows paths in the link: forward slashes, each part URL-encoded, the drive letter kept.
- Whether the link really brings the window forward can't be checked from a headless browser: it goes under "Owner
  checks" in the handoff.

## 12. P8: TV mode and phone push

- **`?kiosk`:** a class on the root. Hides the toggles and the view switch, scales the type up, keeps the screen on
  with `navigator.wakeLock` where it exists, and pins the session that needs the owner (the first, when several).
- **Push (D13):** `HUD_PUSH_URL`. When a session first becomes `needs-you`, the server POSTs the text
  "`<project>` needs you: `<permission | question | input>`" with a `Title` header. At most one per session per
  minute and 20 an hour. Errors are kept in `state.push.lastError` and never thrown. `README.md` gains the variable,
  what is sent, and a line in "What it reads, and what it never touches".

**Hard parts**
- This is the HUD's first outgoing request. Test it against a local server started by the test; assert the exact
  body, and that no title, path, command or session id is in it.
- Only `http:` and `https:` URLs; anything else disables push with a message at start.
- Wake lock is refused over plain HTTP: catch it and carry on; say so in the README.

## 13. P9: a faster hook forwarder

- `hud-hook.mjs` (new): the forwarder alone. It exports `slimHookPayload` and its field lists, and runs when it is
  the script Node was started with. `hud.mjs` imports them, so each list still has one home.
- `hud.mjs`: `HOOK_COMMAND` becomes `node "<path>/hud-hook.mjs"`. `OUR_HOOK_RE` and `isOurHook` accept the old and
  the new command. `installInto()` replaces an old entry with the new one. `uninstallFrom()` removes both.
  `node hud.mjs hook` keeps working.
- `selftest`: the old command is recognised, replaced on install and removed on uninstall.
- `README.md`: "It's one file" becomes two; "The hooks" names the new command.

**Hard parts**
- "Am I the main script" on Windows: compare resolved, lower-cased paths, not URLs.
- Never test on the real `settings.json`. Use a temp `CLAUDE_CONFIG_DIR`. The owner's files change when they
  restart the HUD (its start-up install, which writes a backup first).
- Keep it silent: no output, exit 0, give up after 400 ms, exactly as `runHook` does now.

## 14. P10: verify and close

Follow `workflow/skills/workflow-close/SKILL.md`. Run §16. Set `VERSION` to `0.3.0` (and the version the tests
expect). Refresh the README screenshots from the demo. Give the owner the restart command.

## 15. Items and runs

| ID | Agent | Scope: files it may change | Model / effort | Size |
|---|---|---|---|---|
| P0 | human | The Decisions checklist in STATUS.md | — | — |
| P1 | `harness` | `tests/` (all), `hud.mjs` (`handle`, `HELP`), `README.md`, `.gitignore` | Opus 5.5 / medium | M |
| P2 | `engine` | `hud.mjs`, `tests/hooks.test.mjs`, `tests/codex.test.mjs`, `README.md`, `docs/DESIGN.md` | Opus 5.5 / high | M |
| P3 | `stream` | `hud.mjs`, `tests/stream.test.mjs` (new), `tests/tools/stream-size.mjs` (new), `README.md` | Opus 5.5 / high | M |
| P4 | `tracker` | `hud.mjs` (engine, `makeDemo`, `selftest`), `tests/board.test.mjs` (new), `README.md` | Opus 5.5 / xhigh | L |
| P5 | `tracker-ui` | `hud.mjs` (`HUD_CSS`, `hudClient`, `designMain`, `makeDemo`), `tests/browser-smoke.mjs`, `README.md`, `docs/DESIGN.md` | Opus 5.5 / high | L |
| P6 | `alerts` | `hud.mjs`, `tests/alerts.test.mjs` (new), `tests/browser-smoke.mjs`, `README.md`, `docs/DESIGN.md` | Opus 5.5 / high | L |
| P7 | `page` | `hud.mjs` (page, `makeDemo`), `tests/browser-smoke.mjs`, `README.md`, `docs/DESIGN.md` | Opus 5.5 / high | M |
| P8 | `away` | `hud.mjs`, `tests/push.test.mjs` (new), `tests/browser-smoke.mjs`, `README.md`, `docs/DESIGN.md` | Opus 5.5 / high | M |
| P9 | `hooks` | `hud-hook.mjs` (new), `hud.mjs` (hooks, install, `selftest`, `HELP`), `tests/hooks.test.mjs`, `README.md` | Opus 5.5 / high | M |
| P10 | `review` | `hud.mjs` (`VERSION`), `tests/` (the version), `README.md`, `docs/`, this plan | Opus 5.5 / high | M |

No item runs beside another: they all change `hud.mjs`.

**Every item's exit gate starts with these four**, each with the command and its last lines as evidence:

- [ ] `node hud.mjs selftest` ends with "all checks passed".
- [ ] `node --test tests/` reports 0 failed (give the number passed).
- [ ] Items that touch the page: `node tests/browser-smoke.mjs` passes, and the agent has looked at the screenshots
      it saved (list them).
- [ ] `README.md` and `docs/DESIGN.md` say what the code now does.

**Every handoff adds one section, "Owner checks":** what only the owner can confirm by eye or on a real device.

### P1 `harness`
- **Read:** §2, §4.5, §5; `tests/codex.test.mjs`; `tests/browser-smoke.mjs`; `onHook` and `handle` in `hud.mjs`.
- **Do:** §5.
- **Exit gate:**
  - [ ] `tests/codex.test.mjs` uses `startHud` and still has its 8 subtests passing.
  - [ ] `tests/hooks.test.mjs` has the four cases of §5, passing.
  - [ ] `node tests/browser-smoke.mjs` with no argument starts and stops its own demo HUD and writes 9 screenshots.
  - [ ] With `HUD_RECORD` set, one posted event gives one JSON line with secrets masked; unset, no file is written.
  - [ ] After the tests, port 7777 still answers and no extra `hud.mjs` process is left (show the process list).

### P2 `engine`
- **Read:** §2, §3 (D6 to D8), §4.3, §6; in `hud.mjs`: `subForAgent`, `closeSub`, `sessionView`, `scanRegistry`,
  `onHook`, `snapshot`, `lastWork`, `sessionStatus`, the `STATUS` map and its users on the page.
- **Do:** §6.
- **Exit gate:**
  - [ ] Test: a `SubagentStop` for an unknown `agent_id` with no type adds no subagent and no "Agent done" line.
  - [ ] Test: a registry file for a session with no work is absent from the state at 2 s and present at 10 s; one
        that is removed at 3 s never appears and writes no feed line.
  - [ ] Test: a session with a hook at once is visible within 1 s.
  - [ ] Test: an idle session with a running subagent has `agentsRunning: 1`; the smoke test finds "Agents working".
  - [ ] The 5.2 context windows have a cited source in the handoff, or are left out with the reason.

### P3 `stream`
- **Read:** §4.4, §7; in `hud.mjs`: `scheduleState`, `openStream`, `snapshot`, `makeDemo`'s `snapshot`, `pageMain`,
  `createHud` (`render`, `renderPlans`), `planCard`, `ticker` (`sync`).
- **Do:** §7.
- **Exit gate:**
  - [ ] Test: the first `state` has `plans` and `feed`; later ones have neither; a board edit gives one `plans` event.
  - [ ] Test: after `restart()`, the page's next first message is complete again (checked through the stream).
  - [ ] `tests/tools/stream-size.mjs` against `--demo=dense` for 30 s: the average later `state` is under 30 KB (give
        the number, and the number before the change).
  - [ ] Smoke test: plans and feed are still on the page 10 s after load, in both views.

### P4 `tracker`
- **Read:** §2, §3 (D1 to D5), §4.1 to §4.3, §8; in `hud.mjs`: `parsePlan`, `diffPlan`, `scanRoot`, `onAgentCall`,
  `onUserLine`, `onAssistantLine`, `onHook`, `sessionView`, `subView`, `snapshot`, `redactDeep`, `selftest`.
- **Do:** §8.
- **Exit gate:**
  - [ ] `selftest` has cases for `resolveWork`: each rule of §4.2 steps 2 and 3, and each "links to nothing" case.
  - [ ] `tests/board.test.mjs` has one passing test for each of the first seven hard parts of §8 (Cost is measured
        in the fourth box).
  - [ ] Test: each mark and each list of §4.2 turns on and off as its row says (the 3- and 30-minute limits are read
        from two environment variables in tests, so the test doesn't wait).
  - [ ] Measured: resolving 300 items and 30 agents takes under 5 ms (give the number).
  - [ ] `--demo` state has `work` on sessions and subagents, and a `board` with every mark and list filled.

### P5 `tracker-ui`
- **Read:** §3 (D4, D5, D10), §4.3, §4.6, §9; `docs/DESIGN.md` §2, §6, §8 "Plan graph"; in `hud.mjs`: `planGraph`,
  `planNodeCard`, `planCard`, `renderPlans`, `sessionCard`, `compactRow`, `nodeCard`, `happenings`, `designMain`.
- **Do:** §9.
- **Exit gate:**
  - [ ] Smoke test finds, in the demo: an item with its in-flight pulse and count, each of the three marks, the five
        counts, an open Ready list with a Copy button, and "On `<ID>`" on a session card and a subagent row.
  - [ ] Smoke test: Copy puts the exact prompt on the clipboard on `127.0.0.1`, and the fallback field holds it
        when `navigator.clipboard` is removed.
  - [ ] Screenshots at the three sizes show the queue on one line and the first board visible at 1024×768.
  - [ ] `/design` has specimens for: item in flight, each mark, the queue (empty and full), a folded quiet-boards row.

### P6 `alerts`
- **Read:** §3 (D11, D12), §4.3, §4.6, §10; `docs/DESIGN.md` §8 "Needs-you banner" and "Session card"; in `hud.mjs`:
  `onAssistantLine` (`addDay`), `onHook`, `sessionView`, `banners`, `happenings`, `announcer`, `sessionCard`.
- **Do:** §10.
- **Exit gate:**
  - [ ] Tests: each alert kind turns on and off at its limit, with the hysteresis; a tool on an idle session gives none.
  - [ ] Test: a usage line written three times for one message adds its tokens to the minute once.
  - [ ] Smoke test: an amber warning under a red banner in the demo; × hides it and it stays hidden after the next push.
  - [ ] `/design` has specimens for each warning kind and for the activity line (empty, steady, one burst).

### P7 `page`
- **Read:** §3 (D12), §4.6, §11; in `hud.mjs`: `createHud`, `network` (group labels), `planCard`, `ticker`, `pageMain`.
- **Do:** §11.
- **Exit gate:**
  - [ ] Smoke test: hiding the page for the test's shortened limit, then showing it, gives the summary with counts
        that match the demo feed.
  - [ ] Smoke test: `?project=<a demo project>` shows only that project in all three panels; Escape restores them.
  - [ ] Smoke test: the window link is present on `127.0.0.1` for a VS Code session, absent for a CLI one, and its
        `href` is a correctly encoded `vscode://file/` URL for a Windows path with a space.

### P8 `away`
- **Read:** §3 (D13), §4.3, §12; in `hud.mjs`: `setNeedsYou`, `serve`, `handle`, `topBar`, `network` (`pin`).
- **Do:** §12.
- **Exit gate:**
  - [ ] Test: with `HUD_PUSH_URL` at a test server, a `needs-you` gives one POST with the exact text; a title, path
        and command placed in the session are not in it; a second prompt within a minute gives none.
  - [ ] Test: unset, no request is made; a `file:` URL disables push with a message.
  - [ ] Smoke test at 1920×1080 with `?kiosk`: no toggles, body text at least 18 px, no page scroll, the needing
        session pinned.

### P9 `hooks`
- **Read:** §3 (D14), §13; in `hud.mjs`: `runHook`, `slimHookPayload`, `HOOK_COMMAND`, `OUR_HOOK_RE`, `isOurHook`,
  `ourGroup`, `installInto`, `uninstallFrom`, `autoInstall`, the install checks in `selftest`; README "The hooks".
- **Do:** §13.
- **Exit gate:**
  - [ ] 30 timed runs each of `node -e ""`, the old command and the new one: the new one's 95th percentile is within
        15 ms of bare Node (give all three).
  - [ ] In a temp `CLAUDE_CONFIG_DIR`: a file holding the old command is moved to the new one by `install`; a second
        `install` changes nothing; `uninstall` restores the first file byte for byte.
  - [ ] `tests/hooks.test.mjs` passes when events are sent through `hud-hook.mjs` (the real forwarder, to the test's port).
  - [ ] The owner's `~/.claude/settings.json` has the same hash before and after the item (give both).

### P10 `review`
- **Read:** every handoff; §16; `workflow/skills/workflow-close/SKILL.md`.
- **Do:** §14.
- **Exit gate:**
  - [ ] Every item is `accepted`, and §16 passes line by line with evidence.
  - [ ] Every "Owner checks" entry is in the final report, in one list.
  - [ ] The report gives the restart command and says what the owner will see change.

## 16. Verification

1. `node hud.mjs selftest`, `node --test tests/`, `node tests/browser-smoke.mjs`: all pass.
2. A HUD on port 7790 with `HUD_NO_AUTOINSTALL=1`, reading the owner's real folders (read only), for 10 minutes while
   the owner's sessions run:
   - no blank subagent and no session that appears for under 8 seconds;
   - every running subagent whose description starts with a board ID shows that item in flight, and no agent is
     linked to an item of the wrong plan (check each link against its transcript by hand; list them);
   - the steady `state` event is under 30 KB (`tests/tools/stream-size.mjs`);
   - the process stays under 1% of one core and 150 MB.
3. `node hud.mjs lint .` reports nothing for `docs/plans/hud-0-3/`.
4. The README's "What it reads, and what it never touches" lists every new thing read or sent.
5. `git status` shows only this plan's files; the owner's `settings.json` hash is unchanged.

## 17. Follow-ups

- Tokens spent per board item (needs a rule for agents that work on several).
- HTTP hooks, once the docs say whether Claude Code waits for them.
- History on disk and a per-day view (reverses D7 of the first plan).
- The first plan (`docs/plan/`) still has P3 `todo` and D15 unticked: close it or delete it.
- Process-identity check for registry entries (`procStart`), against a reused process id.
