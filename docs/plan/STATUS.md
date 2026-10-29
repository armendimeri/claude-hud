# Claude HUD: status and handoffs

How the agents building [Claude HUD](PLAN.md) pass work to each other. Every agent reads this first and updates it
last.

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | accepted | 2026-10-29 | — | D1–D13 confirmed as proposed |
| P1 | Engine | `engine` | P0, agent-workflow/P1 | Opus 5.5 / high | handed-off | 2026-10-29 | [P1-engine](handoffs/P1-engine.md) | All 15 gate items met; gate 3–4 proven on the real settings file; hooks uninstalled |
| P2 | HUD page and design system | `hud` | P1 | Opus 5.5 / xhigh | todo | | | |
| P3 | Design review, verify, close | `review` | P2 | Opus 5.5 / high | todo | | | |

States: `todo` → `in-progress` → `handed-off` → `accepted` (checked by the next agent). Also `bounced` (the next
agent found the exit gate not met) and `blocked` (needs the user, see Questions).

## Decisions (P0)

Tick each, or write the change next to it. Details in PLAN §3.

- [x] **D1** Port 127.0.0.1:7777 (`HUD_PORT` overrides).
- [x] **D2** Hook forwarder is `node hud.mjs hook`; `curl.exe` only if Node is too slow (> 150 ms p95).
- [x] **D3** Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, PreCompact (+ any subagent-start event).
- [x] **D4** Show titles, models, tool names and short redacted summaries only; never full prompts, output or file contents.
- [x] **D5** JARVIS voice and sound, off by default, toggles in the top bar.
- [x] **D6** Browser notifications for "needs you" and plan phases blocked / bounced / handed off.
- [x] **D7** Memory only: last 500 events, ended sessions kept 2 hours.
- [x] **D8** Autostart at logon through Task Scheduler, no visible window.
- [x] **D9** Localhost only, no phone access.
- [x] **D10** Own repo `claude-hud`, branch `main`, no remote added by agents, no licence file unless asked.
- [x] **D11** Every agent has a `provider` (`anthropic` / `bedrock` / `unknown`), detected from the model id and the `CLAUDE_CODE_USE_BEDROCK` flag; model names normalised; a badge on each card.
- [x] **D12** Bedrock usage from your own apps, **off by default**: `POST /usage` ingest (`HUD_ACCEPT_USAGE=1`) and a CloudWatch read through the `aws` CLI (`HUD_BEDROCK_REGION`, at most once a minute, may cost a very small AWS charge). The HUD never reads AWS credentials. Say here if you want either one switched on in P1, or neither. → **Neither** (both built, both off by default).
- [x] **D13** Tokens per session and per subagent (cache reads shown separately), plus context fill (%); no money amounts. Account limits (5-hour / weekly) only if P1 finds a local source, and then only after asking you.

## Protocol

1. **Orient:** read this file, the PLAN sections for your phase, and every earlier handoff.
2. **Check what you were given:** run the quick parts of the previous phase's exit gate. Pass → set it `accepted`.
   Fail → set it `bounced`, write what failed in its handoff's Review section and in the log, and stop.
3. **Claim:** set your phase to `in-progress` with today's date. If someone else already has it, stop.
4. **Work** only within your phase's scope (PLAN §7). Gaps with a clear best answer: take it and record it. Gaps
   that change what the user sees: set `blocked`, add a question, stop.
5. **Prove it:** every exit-gate tick needs evidence (a command and its output, a number, a screenshot path).
6. **Hand off:** write `docs/plan/handoffs/P<n>-<agent>.md` with:
   - summary;
   - the exit gate with evidence;
   - files changed;
   - deviations and decisions taken;
   - known issues;
   - lasting knowledge (it must end up in `README.md` or `docs/DESIGN.md`);
   - next agent: start here.

   Set your phase `handed-off`, add a log line, stop.

**Always:**
- **Code location:** all code and docs live in this repository
  (`C:\Users\armen\source\repos\armendimeri\claude-hud`). Never create or change files inside a project the HUD
  watches (e.g. WasteManagement2, FidiaCRM).
- **Claude Code settings:** never edit `~/.claude/settings.json` by hand; only through `install` / `uninstall`.
  At the end of your phase, leave the user's settings exactly as you found them, unless your phase is meant to leave
  hooks installed (say so in the handoff).
- **Files never to read:** `~/.claude/.credentials.json` and `~/.claude/sessions/*.key`.
- **Secrets:** never copy any (database passwords from other projects, tokens) into a file here. This repo will be
  pushed.
- **Git:** no commits unless the user asks; never add a remote or push.
- **Watched sessions:** don't stop or interfere with the user's running Claude Code sessions. Create your own
  sessions for testing.

## Questions

| # | Item | Question | Recommended | Answer |
|---|---|---|---|---|
| 1 | P1 | P0 isn't done: D1–D13 under Decisions are all unticked and P0 is still `todo`, and PLAN §3 requires them confirmed before P1 starts (D4, D5, D6 change what you see). Please tick each decision or write your change next to it, set P0 to `handed-off`, then start P1 again in a new session. | — | 2026-10-29, user: "unblock them all". D1–D13 confirmed as proposed; D12: neither source switched on. |
| 2 | P1 | D13: Claude Code keeps account usage locally: `cachedUsageUtilization` in `~/.claude.json` (5-hour and weekly percent, reset times; refreshed by Claude Code itself), and the documented `rate_limits` field of the status line input. Show it, and from which source? | — | 2026-10-29, user: yes, from the `~/.claude.json` cache, reading only that key. |
| 3 | P1 | The user asked for a plan to unify how agents work across all projects, before more HUD code. | — | Plan written: [`docs/plans/agent-workflow/`](../plans/agent-workflow/STATUS.md). P1 resumes after that plan's P0 decisions and its P1, which fixes the board format the HUD reads. |
| 4 | P1 | The agent's permission check refused `node hud.mjs install` on your real `~/.claude/settings.json` (it classes it as self-modification), so two gate items are open: the real install/uninstall diff, and a real permission prompt turning a session `needs-you` (that needs an interactive session: you). Both work on a sandbox copy and through the real forwarder (handoff, gate 3–4). How do you want to finish them? | Allow exactly `Bash(node hud.mjs install)` and `Bash(node hud.mjs uninstall)` for this project (`/permissions`), then start P1 again: one short session, and you answer one permission prompt it triggers. Or run `install` yourself before that session and `uninstall` after it. | 2026-10-29, user: project `.claude/settings.local.json` allows `Bash(node hud.mjs install)` and asks for `Bash(node hud.mjs uninstall)`. The uninstall prompt doubles as the real permission prompt for gate 4. |

## Log

- 2026-10-29 · planner · — · Plan written from the WasteManagement2 session; machine facts checked (Node 22.12, no existing hooks, session registry and transcript format). Moved to its own repo folder at the user's request, design bar raised (PLAN §6).
- 2026-10-29 · planner · — · Plan extended after review: live network of who started whom (`parentId`, `spawnDepth`), tokens and context fill per subagent, Bedrock support (D11–D13). Subagent transcripts found at `<sessionId>/subagents/` with `.meta.json` (`toolUseId`, `spawnDepth`). D11–D13 need P0 confirmation like D1–D10.
- 2026-10-29 · engine · P1 · Blocked before claiming: P0 decisions D1–D10 not confirmed (all unticked, P0 still `todo`). No work started; only this file changed. See Q1.
- 2026-10-29 · user · P0 · D1–D13 confirmed as proposed ("unblock them all"); D12 neither source switched on. Other agents stopped.
- 2026-10-29 · engine · P1 · P0 checked (D1–D13 ticked) → `accepted`. P1 claimed, `in-progress`.
- 2026-10-29 · engine · P1 · Facts checked:
  - the hooks docs list 33 events and support `async` hooks; Git Bash runs hook commands on Windows; settings edits are picked up live;
  - a message's usage repeats on every transcript line of that message, so each `message.id` is counted once;
  - a subagent's `meta.json` gets `finished: true` when it ends;
  - a refused localhost connect takes 3 ms.

  Q2 asked and answered (account usage from the cache).
- 2026-10-29 · engine · P1 · Scope change at the user's request: plans are read from every `STATUS.md` / `*-STATUS.md` / `HANDOFF.md` under `docs/` or `Documentation/` (FidiaCRM chunk boards with runs and owner inputs, ImPOS-Maui `Phase | State` tables), not only from `docs/plans/*/STATUS.md`.
- 2026-10-29 · engine · P1 · `blocked` (Q3): paused at the user's request for the agent workflow plan.
  - Left behind: a `hud.mjs` draft (engine, demo, install/uninstall, autostart, selftest), **not yet run or tested**.
  - Not done yet: `git init`, README, .gitignore. `~/.claude/settings.json` is untouched.
  - On resume: align the plan parser with the standard's board (agent-workflow PLAN §4.5, §4.14), then test against the exit gate.
- 2026-10-29 · standard (agent-workflow P1) · P1 · The board format is fixed (`workflow/STANDARD.md` §5, §17). P1 is back to `todo`. On resume, also add `node hud.mjs lint <repo>`, starting from `docs/plans/agent-workflow/boardcheck.mjs` and the [lint] lines of `workflow/conformance.md` (agent-workflow W14).
- 2026-10-29 · engine · P1 · Resumed. agent-workflow/P1 checked for what HUD P1 relies on: the STANDARD §5 / §17 board format is fixed, `boardcheck.mjs` runs (only its known "copies the protocol" line), and the kit is uninstalled as stated. Not set `accepted`: its own gate has the cost box unticked, which is for its pilot or the user to judge. P1 claimed again, `in-progress`.
- 2026-10-29 · engine · P1 · `blocked` (Q4). The draft was run and tested against real sessions (handoff [P1-engine](handoffs/P1-engine.md)):
  - 13 of 15 gate items are proven, including the nested subagent at `spawnDepth` 2, a background subagent, `startedBy`, the context hand check, and forwarder p95 of 70–116 ms;
  - added standard boards, `lint`, `git init`, `.gitignore` and the README;
  - fixed six bugs found by the tests;
  - open: the real install/uninstall and a real permission prompt, because the permission check refused writing to `~/.claude/settings.json`;
  - `~/.claude/settings.json` is byte-identical to the start of the session.
- 2026-10-29 · engine · P1 · Resume attempt: Q4 still unanswered. No `hud.mjs` allow rule in `~/.claude/settings.json` (no `.claude/` in this repo either), no `hooks` key, hash still `e4f9fa21…`. Nothing run, P1 stays `blocked`. Only this line changed.
- 2026-10-29 · engine · P1 · Q4 answered (project `.claude/settings.local.json`: install allowed, uninstall asks). Resumed; `handed-off`.
  - Gate 3 on the real file: only `hooks` added; the second install made no change; uninstall restored it byte for byte (`e4f9fa21…`); test backups deleted.
  - Gate 4: hook events arrive in 6 ms. Two real prompts went `needs-you`: the user's WasteManagement2 question and this session's uninstall "ask".
  - Fixed: AskUserQuestion asked through a permission prompt read "Permission: AskUserQuestion", now "Question for you"; selftest 37 / 0.
  - Hooks are not installed now; the HUD is stopped.

## Kickoff

Start each phase in a new Claude Code session **opened in this repository**
(`C:\Users\armen\source\repos\armendimeri\claude-hud`):

| Phase | Model | Effort | Why |
|---|---|---|---|
| P1 `engine` | Opus 5.5 | high | Hooks, file tailing, settings install/uninstall: correctness and safety |
| P2 `hud` | Opus 5.5 | xhigh | The design bar: three critique rounds, a design system, cinematic motion |
| P3 `review` | Opus 5.5 | high | An independent eye on the design, plus end-to-end verification |

> You are the agent for phase P<n> of the Claude HUD plan in this repository. Follow the protocol in
> `docs/plan/STATUS.md` exactly: orient, check the previous phase's handoff, claim your phase, work only within its
> scope in `docs/plan/PLAN.md`, prove your exit gate with evidence, write your handoff, update STATUS, and stop. If
> something needs the user's decision, set your phase to `blocked`, add it under Questions, and stop.
