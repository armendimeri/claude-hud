# Claude HUD 0.3: status

How the agents building [Claude HUD 0.3](PLAN.md) pass work to each other. Agents follow the `workflow-run` skill.
In this repository it is at `workflow/skills/workflow-run/SKILL.md`, and the standard at `workflow/STANDARD.md`.
Every agent reads this file first and updates it last.

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | accepted | 2026-11-25 | — | D1 to D16 |
| P1 | Test harness and hook replay | `harness` | P0 | Opus 5.5 / medium | accepted | 2026-11-25 | [P1](handoffs/P1-harness.md) | `node --test tests/` runs via tests/run-all.mjs (Node 26) |
| P2 | Truthful sessions | `engine` | P1 | Opus 5.5 / high | accepted | 2026-11-25 | [P2](handoffs/P2-engine.md) | settle time, placeholders, Agents working, 5.2 windows |
| P3 | A lighter stream | `stream` | P2 | Opus 5.5 / high | accepted | 2026-11-25 | [P3](handoffs/P3-stream.md) | later state 24.2 KB (from 36.8) with --demo=dense; `full: true` first state, `plans` event |
| P4 | Board following: the engine | `tracker` | P3 | Opus 5.5 / xhigh | accepted | 2026-11-25 | [P4](handoffs/P4-tracker.md) | 33 tests passed, all demo marks and lists verified |
| P5 | Board following: the page | `tracker-ui` | P4 | Opus 5.5 / high | accepted | 2026-11-25 | [P5](handoffs/P5-tracker-ui.md) | Selftest, 33 tests and nine browser views rechecked |
| P6 | Warnings and the activity line | `alerts` | P5 | Opus 5.5 / high | accepted | 2026-11-26 | [P6](handoffs/P6-alerts.md) | Selftest, 39 tests and nine browser views rechecked |
| P7 | Page extras | `page` | P6 | Opus 5.5 / high | accepted | 2026-11-26 | [P7](handoffs/P7-page.md) | Selftest, 39 Node tests and all Edge smoke checks rechecked |
| P8 | TV mode and phone push | `away` | P7 | Opus 5.5 / high | accepted | 2026-11-26 | [P8](handoffs/P8-away.md) | Selftest, 42 Node tests and both kiosk layouts independently verified |
| P9 | A faster hook forwarder | `hooks` | P8 | Opus 5.5 / high | todo | | | |
| P10 | Verify and close | `review` | P9 | Opus 5.5 / high | todo | | — | |

Every item changes `hud.mjs`, so they run one after another. The chain in "Depends on" is that order.

## Decisions (P0)

Tick each, or write the change next to it. P1 starts when every box is ticked. Details in PLAN §3. ★ changes what
you see.

- [x] **D1** ★ Following means: the HUD links live agents to board items from evidence and shows where they disagree with the board. It never writes to a board.
- [x] **D2** ★ Evidence order: the plan's slug and the ID together in the task (`hud-0-3/P4`), then the first IDs of the description or title, then the plan whose files the agent touches, then its branch. An ID that could be in two plans links to nothing.
- [x] **D3** Prompts are read in memory for ID-shaped words only; nothing else is kept, sent or shown.
- [x] **D4** ★ Three amber marks: board not updated (3 minutes of work while `todo`), stalled (`in-progress`, nobody on it for 30 minutes), started early.
- [x] **D5** ★ A work queue at the top of Plans: Needs you, In flight, Ready, To accept, Drift. Ready rows copy the kickoff prompt.
- [x] **D6** ★ An idle session with a running subagent reads "Agents working".
- [x] **D7** ★ A session with no work appears after 8 seconds or at its first work; a subagent only a hook has named is not shown.
- [x] **D8** The 5.2 context windows are added only from a cited source.
- [x] **D9** Plans and feed are sent when they change; a steady update stays under 30 KB.
- [x] **D10** ★ Boards that are finished, or 14 days unchanged with nothing live on them, fold under "+N quiet boards".
- [x] **D11** ★ Amber warnings: context at 80% and 90%, a tool running 10 minutes, a subagent silent for 5 minutes, usage at 90%.
- [x] **D12** ★ Page extras: an activity line and last-turn length per session, a "while you were away" summary, project focus, a link that opens the VS Code window.
- [x] **D13** ★ `?kiosk` TV mode. `HUD_PUSH_URL` (off by default) posts the project's name, "needs you" and the kind of prompt, and nothing else.
- [x] **D14** The hook forwarder moves to a second file, `hud-hook.mjs`. HTTP hooks are not adopted. `HUD_RECORD` records hook events for tests, off by default.
- [x] **D15** Git: agents commit on a new local branch `hud-0-3`, first the uncommitted work of 2026-11-25 and this plan, then one commit per accepted item. No push.
- [x] **D16** History on disk, money amounts and approving prompts from the HUD stay out.

## Always

This plan's own rules, on top of the standard.

- **The live HUD is the owner's running app.** It runs on port 7777 from this folder, started by the scheduled task
  "Claude HUD". Never stop it, restart it, end its task, or send it a test event. It reads `hud.mjs` only at start,
  so your edits don't reach it.
- **Your own HUDs:** start them on a port the OS gives you (or 7790 to 7799), always with `HUD_NO_AUTOINSTALL=1`,
  and over temp folders unless your item says otherwise. Stop each one by the handle or process id you started it
  with. Never stop `node` by name: other tools on this PC run on Node.
- **Settings:** never change `~/.claude/settings.json` or any other watched folder's settings. `install` and
  `uninstall` are run only against a temp `CLAUDE_CONFIG_DIR`.
- **Never read** `~/.claude/.credentials.json`, `~/.claude/sessions/*.key`, `~/.aws/`, or Codex's `auth.json`.
- **Privacy:** this repository will be pushed. Test data is made up. Nothing from the owner's transcripts (prompt
  text, commands, paths or names from other projects, secrets) goes into a file here.
- **Other projects:** never create or change a file in a project the HUD watches.
- **No dependencies:** Node 22 built-ins only. No `npm install`, no build step. The code is `hud.mjs` and, from
  P9, `hud-hook.mjs`.
- **Find code by function name.** Line numbers in `hud.mjs` move after every item.
- **Files this repository doesn't have:** `CLAUDE.md`, `docs/status.md`, `docs/roadmap.md`, `docs/checks.md`. Don't
  create them. Skip the skill's steps that read or rewrite them. What only the owner can check goes in your
  handoff, under "Owner checks".
- **Git (D15):** work on the branch `hud-0-3`. Commit only the files of the item's scope, never `git add -A`
  (`.vs/` is untracked on purpose). Never push, never add a remote.
- **Scratch files** go in `.hud-tmp/` (ignored by git).

## Questions

| # | Item | Question | Recommended | Answer |
|---|---|---|---|---|

## Log

- 2026-11-25 · planner · — · Plan written after a review of the live HUD (4 open sessions, 14 boards). The stale
  ended-sessions fix of the same day is in the working tree, uncommitted.
- 2026-11-25 · coordinator · P0 · The owner took D1 to D16 as recommended. P0 accepted.
- 2026-11-25 · harness · P1 · Handed off: tests/helpers.mjs, hooks.test.mjs (4 cases + HUD_RECORD), codex test on
  startHud, browser smoke with its own demo HUD (9 screenshots), HUD_RECORD. `node --test tests/` 14 passed; it
  failed at the baseline on Node 26 and now runs tests/run-all.mjs.
- 2026-11-25 · coordinator · P1 · Accepted: selftest, 14/14 tests, smoke and screenshots, HUD_RECORD re-checked, scope clean.
- 2026-11-25 · engine · P2 · Handed off: 8 s settle for sessions (and reopens) with no work, hidden hook-only
  subagents, `agentsRunning` and "Agents working", Fable/Mythos 5.2 windows (cited). 22/22 tests, smoke passes; the
  page check of "Agents working" ran in a scratch copy of the smoke test (out of scope).
- 2026-11-25 · coordinator · P2 · Accepted: selftest, 22/22 tests, smoke, both 5.2 sources fetched, Agents working seen on the page, scope clean.
- 2026-11-25 · coordinator · — · The owner asked for a usage check every 5 minutes with no AI tokens, after P10, outside this plan: the HUD reads Claude Code's OAuth token from `~/.claude/.credentials.json` in memory only (an exception the owner granted for that change alone; plan items still never read it), sends it only to api.anthropic.com, never refreshes or writes it, backs off on errors and keeps the cached value. A switch on the page next to the account limits, changeable only from this PC, on by default, kept across restarts, hidden in kiosk.
- 2026-11-25 · stream · P3 · Handed off: the stream's first state is full (`full: true`), later states carry no plans
  or feed, a `plans` event on board change; the page keeps them, counts Working itself, skips unchanged need rows and
  run chips. tests/stream.test.mjs (25/25 tests), tests/tools/stream-size.mjs: later state 36.8 → 24.2 KB
  (--demo=dense, 30 s). Smoke passes; the 10 s, board-change and reconnect page checks ran in a scratch copy (out of
  scope).
- 2026-11-25 · coordinator · P3 · Accepted: selftest, 25/25 tests, smoke, stream size 24.1 KB re-measured, 10 s page check re-run, scope clean.
- 2026-11-25 · tracker · P4 · Handed off the board engine, demo and eight integration tests. All 33 tests and nine
  browser checks passed. Board resolution averaged 0.218 ms and steady dense demo updates averaged 25.4 KB.
- 2026-11-25 · tracker-ui · P4 · Accepted after selftest, 33 tests, nine browser views and a demo check of work fields, marks and lists.
- 2026-11-25 · tracker-ui · P5 · Handed off the work queue, live board details, session links, quiet boards and
  drift announcements. Selftest, all 33 tests and all nine browser views passed, including copy and mobile layout.
- 2026-11-25 · alerts · P5 · Accepted after selftest, all 33 tests, and nine browser views covering the queue,
  clipboard, board details, quiet-board persistence and responsive layout.
- 2026-11-25 · alerts · P6 · Handed off amber warnings, 30-minute activity lines and turn duration. Selftest, all
  39 tests and nine browser views passed, including warning dismissal across a live update and the gallery.
- 2026-11-26 · page · P6 · Accepted after selftest, 39 Node tests and nine browser views covering warning dismissal and the activity line.
- 2026-11-26 · page · P7 · Handed off the away summary, project focus and local VS Code links. Selftest, 39 Node
  tests and Edge smoke passed, including both return paths, all three focus panel sizes and Windows URL encoding.
- 2026-11-26 · away · P7 · Accepted after selftest, 39 Node tests and Edge smoke covering focus, local VS Code links
  and both away summary triggers.
- 2026-11-26 · away · P8 · Handed off kiosk mode and phone push after selftest, 42 Node tests, and Edge smoke.
- 2026-11-26 · coordinator · P8 · Accepted after selftest, 42 Node tests and 11 Edge views, including the kiosk
  gates at 1920×1080 and 390×844. Loopback push delivery, payload privacy and both rate limits passed.
  The TV view fit 1920×1080 with 18 px body text and the waiting session pinned. Loopback tests confirmed the
  payload, rate limits, and error state.

## Kickoff

| Item or run | Open Claude Code in | Model | Effort |
|---|---|---|---|
| P1 to P10, one coordinator | `C:\Users\armen\source\repos\armendimeri\claude-hud` | Opus 5.5 | high |
| A single item | the same folder | as its board row | as its board row |

A single item:

> Do `hud-0-3/<ID>`. Follow the workflow-run skill (`workflow/skills/workflow-run/SKILL.md`).

All of them, with one coordinator session that starts one subagent per item:

> You are the coordinator for the plan `docs/plans/hud-0-3` in this repository (claude-hud). Run every item on its
> board, P1 to P10, in order, one at a time.
>
> **Before anything**
> 1. Read `docs/plans/hud-0-3/STATUS.md` in full, then `workflow/skills/workflow-run/SKILL.md` and
>    `workflow/STANDARD.md` §5 to §8, §11 and §12. Read PLAN.md §1 to §4 only: the item sections are for the agents
>    that do them.
> 2. If P0 is not `accepted`, or a Decisions box is unticked, stop and tell me which.
> 3. Git (D15): create the local branch `hud-0-3` from the current HEAD, keeping the working tree. Commit what is
>    already changed (`hud.mjs`, `tests/codex.test.mjs`, `README.md`, `docs/plans/hud-0-3/`) as "[baseline] Stale
>    sessions fix and the hud-0-3 plan". Never push, never add a remote, never `git add -A`.
> 4. Run `node hud.mjs selftest` and `node --test tests/`. Both must pass before P1 starts.
>
> **For each item, in board order**
> 1. Start one subagent for it, with a fresh context, on the model and effort of its board row. Its task, word for
>    word: "Do hud-0-3/&lt;ID&gt; in this repository. Follow workflow/skills/workflow-run/SKILL.md (the standard is
>    workflow/STANDARD.md, the templates are in workflow/templates/). Start in docs/plans/hud-0-3/STATUS.md and obey
>    its Always rules. Stay inside your item's file scope. Prove every exit-gate box with a command and its output,
>    write your handoff, set your row, and report." Wait for it. Run nothing beside it.
> 2. Check it yourself; don't take its word. Read its handoff. Run `node hud.mjs selftest` and `node --test tests/`.
>    For an item that touches the page, also run `node tests/browser-smoke.mjs` and look at the screenshots. Re-run
>    two of its exit-gate boxes of your choice. Check with `git status` that only files in its scope changed.
> 3. If it holds: set the item `accepted` (Since, a Review line in its handoff, a log line), and commit its files
>    as "[&lt;ID&gt;] &lt;title&gt;". If it doesn't: set it `bounced`, write why in the handoff's Review, and start one new
>    subagent for the same item, with that Review as its first reading. On a second failure, stop and report.
> 4. If an item comes back `blocked` or `partial`, stop and report: every later item depends on it.
>
> **All the way through**
> - STATUS.md "Always" binds you and every subagent. Above all: the HUD on port 7777 and its scheduled task are my
>   running app. Never stop it, restart it, or send it test events.
> - Don't edit PLAN.md. A wrong plan is a reason to stop and report, not to improvise.
> - Don't do an item's work yourself. Don't fix a subagent's work beyond a one-line fix that you record in its
>   handoff.
> - Keep your own context small: read handoffs and test output, not `hud.mjs`.
>
> When P10 is accepted, or when you stop early, end with the report of STANDARD §11: what is done, accepted and
> left; what was verified and what wasn't; what was decided without asking; every "Owner checks" entry in one list;
> and the command that restarts the live HUD.
