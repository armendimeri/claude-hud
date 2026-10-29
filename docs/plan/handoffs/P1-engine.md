# P1 `engine` handoff

**Date:** 2026-10-29 · **State:** handed-off (after the Q4 resume) · **Model / effort used:** Opus 5.5 / high ·
**Next:** P2 `hud`

## Summary

The engine is built and tested against real sessions. The draft `hud.mjs` from the earlier P1 session was run for
the first time, fixed where tests showed it wrong, and extended for the agent workflow standard:
- it reads standard boards;
- it has a new `lint` command;
- the repository has `git init`, `.gitignore` and a first README.

**Q4 resume (same day):** the first session's permission check refused to write the hooks into your real
`~/.claude/settings.json`, which left gate items 3 and 4 open. You then allowed `node hud.mjs install` and set
`node hud.mjs uninstall` to ask (project `.claude/settings.local.json`). A short resume session proved both items on
the real file, with your real WasteManagement2 work as the watched session. It also fixed one label (below). All 15
gate items are now met.

## Exit gate

| # | Gate item | Result | Evidence |
|---|---|---|---|
| 1 | Serves; health answers; `Host: evil.test` refused | ✅ | `GET /api/health` → `200 {"ok":true,"uptime":3294,"sessions":8,"version":"0.1.0"}`. With `Host: evil.test`: `403 Forbidden`, and also 403 with `evil.test:7777` on `/api/state`. |
| 2 | `/api/state` lists the registry sessions with title, model and tokens; no secrets | ✅ | 8 live sessions with titles, models, effort, branch, tokens and context (sample below). Ended sessions from the last 2 h are listed too. Grep of the state for `Password=`, `Pwd=`, `-P <x>`, `AKIA…`, `ASIA…`, `Bearer`, `AWS_BEARER_TOKEN_BEDROCK=`, and 32+ hex characters: **no match**. |
| 3 | `install` → backup, diff only `hooks`; again → no change; `uninstall` → identical | ✅ real file | **Real file (Q4 resume):** a start-of-session copy hashed `e4f9fa21b4cdbf4f`. `install` → backup `settings.json.hud-backup-20261029210729`, `cmp`-identical to that copy. A JSON key diff: added `hooks` (11 events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Notification, Stop, SubagentStart, SubagentStop, PreCompact), removed none, changed none. Text diff +137 / −1, the −1 being `remoteControlAtStartup` gaining a comma. `install` again → "already installed … not changed", hash `a5c81fa0c7559e46` both times, still 1 backup. `uninstall` → "matches …210729 byte for byte"; `cmp` against the copy: identical, hash `e4f9fa21…` again. Both backups deleted afterwards; none left in `~/.claude/`. **Before that, sandbox:** on a copy byte-identical to your `settings.json`, run under `CLAUDE_CONFIG_DIR`: (a) install wrote a backup identical to the original; (b) diff: +137 lines, all inside the new `hooks` key, and 1 changed line (`"remoteControlAtStartup": false` gains a comma); (c) install again: "already installed", same hash, still 1 backup; (d) uninstall: "matches settings.json.hud-backup-20261029202118 byte for byte", `cmp` identical, both hashes `e4f9fa21b4cdbf4f…`; (e) a file holding your own Stop and PreToolUse hooks was identical after install + uninstall. |
| 4 | Hooks installed: a new session's tool calls appear in `/api/stream` within 1 s; a permission prompt makes it `needs-you` | ✅ real | **Real hooks (Q4 resume), from a recording of `/api/stream` with arrival times:** this session's `Bash · node -e "console.log('marker', …)"` arrived 6 ms after its hook timestamp and 0.7 s *before* the command ran (only PreToolUse is that early). A `Stop` hook gave "Turn finished" 6 ms after it fired. **Real prompts:** your WasteManagement2 session asked you a question (VS Code shows it as a permission prompt): `AskUserQuestion` at 21:11:30, then `needs-you` 6 s later, which you saw on the page. My own `uninstall` waited on its "ask" rule: `needs-you` "Permission: Bash" for this session at 21:12:30, cleared when you approved it. Still to prove on the page in P2: a `needs-you` card while a prompt is open (this check used the feed and your eyes). **Before that, with `--settings`:** a real `claude -p` test session (my own, Haiku) was given exactly the installed entries through `--settings`. Every event reached the stream within 1–138 ms (`Bash · echo hud-live-test` 7 ms; `Agent started` 10 ms; nested `Agent started` 138 ms). **needs-you:** payloads shaped like Claude Code's, sent through the real forwarder: permission Notification → `needs-you` "Permission: Bash" → PreToolUse clears it → `busy`; idle Notification → "Waiting for your input"; AskUserQuestion → "Question for you" → PostToolUse clears it. **A real permission prompt is not tested (Q4).** The bare CLI stops at its first-run theme picker, and getting past it would write onboarding state into your `~/.claude.json`. |
| 5 | HUD stopped: a hooked session works normally; forwarder p95 < 150 ms, both ways | ✅ | HUD down (connect → `000`). `claude -p` with the hooks: exit 0, stdout `finished`, stderr 0 bytes. Without hooks: the same. Claude Code's own record: `"stop_hook_summary","hookCount":1,"hookErrors":[],…"hasOutput":false`. **Timing, 50 calls each:** HUD running: direct p95 75 ms, via Git Bash p95 116 ms. HUD stopped: direct 70 ms, Git Bash 111 ms. Every call exit 0, 0 bytes of output. A listener that never answers: exit 0 after 488 ms. Garbage stdin: exit 0 after 65 ms. **D2 stays `node`.** |
| 6 | A real subagent under its parent (from `meta.json`), own model and tokens, closes; nested at `spawnDepth` 2 | ✅ verified | Test session `23ab13d1`: subagent `a3c17db0…` ("hud nested parent", depth 1, parent = the session) started `ae7d4ed1…` ("hud nested child", **depth 2, parentId = a3c17db0…**). Both on `claude-haiku-5-5`, both `done`. Tokens equal an independent count of each `subagents/*.jsonl` (each `message.id` counted once): parent 4 / 220 / 30,720 / 33,401; child 2 / 4 / 0 / 31,939. Older session `8132e8aa`: two `web-fetch` subagents, tokens equal the independent count too. |
| 7 | `context` matches a hand calculation | ✅ | Session `8132e8aa`, last turn `msg_011CgWruRy35i79Uq7c5BGKh`: input 2 + cache read 316,203 + cache write 4,374 = 320,579 of 1,000,000 = 32.1%. The HUD shows `{"used":320579,"window":1000000,"pct":32.1}`. |
| 8 | Normaliser passes the six ids; Bedrock seen or plainly unverified; D12 off: `/usage` 404, no `aws` ever started | ✅ verified (update below) | **Update 2026-10-29, on a machine where Claude Code runs on Bedrock:** the first version labelled real Bedrock sessions `anthropic`. There, `message.model` is the plain `claude-opus-5-5`; the Bedrock id `us.anthropic.claude-opus-5-5` appears only in `api-request` lines (`params.model`), which were skipped; and `CLAUDE_CODE_USE_BEDROCK=1` is in Claude Code's process environment, not in `settings.json`. Fixed: provider per agent from the request model id, then `msg_bdrk_` message ids, then the settings flag; `modelRaw` is the id as sent. Seen live (HUD on port 7781): this session `bedrock` / `claude-opus-5-5` / raw `us.anthropic.claude-opus-5-5`; a Haiku subagent it started `bedrock` / `claude-haiku-4-5` / raw `us.anthropic.claude-haiku-4-5-20251001-v1:0`, parent correct, own tokens, context 5.1%. `selftest` 41 / 0 (4 new provider cases). `--demo` unchanged (4 anthropic, 1 bedrock). **Original text:** `selftest`: the six ids pass, plus a Mantle id, a dated id and a `[1m]` id. **Bedrock is unverified on a real session:** this PC has no Bedrock setup (`settings.json` has no `env` block, there is no `aws` CLI, and no AWS files were opened). D12 off: `POST /usage` → 404. The only `execFile('aws', …)` is in `pollCloudWatch`, which is scheduled only when `HUD_BEDROCK_REGION` is set; `aws.exe` processes: 0. |
| 9 | D12 on (if you enabled it) | ✅ (tested anyway) | You chose "neither", so this was a test instance only (port 7780, `HUD_ACCEPT_USAGE=1 HUD_BEDROCK_REGION=us-east-1`). An `app` holding `AKIA…`, `-P Secret123`, `Password=abc;` and `AWS_BEARER_TOKEN_BEDROCK=xyz` shows as `billing ••• -P ••• Password=•••; AWS_BEARER_TOKEN_BEDROCK=••• …`; none of the four strings is in the state. No `aws` CLI: `externalError: "CloudWatch: aws CLI not found"`, and the HUD keeps serving. A 17 KB body → 413. |
| 10 | A WasteManagement2 plan appears with phases and edges | ✅ | `customer-history-and-change-requests` (now on the standard board, converted by the pilot): P0 accepted, then P1 → P2, P3 → P4 (P2, P3), P5 (P3) → P6 (P1–P5), each with its agent and model / effort. Header `approved 2026-10-29`. |
| 11 | `--demo` and `--demo=dense` cover every §5 case and change | ✅ | Demo: 3 projects, 5 sessions (needs-you, busy ×2, idle, ended), one on Bedrock (`us.anthropic.claude-sonnet-5-5-v1:0`), a nested subagent (depth 2), a 146-character title, `startedBy` set, 3 external rows (one delayed CloudWatch row). After 22 s: context 49.2 → 62.4%, subagents 3 → 5 (one finished and was replaced), a second session asking a question, P1 `in-progress` → `handed-off`; `bounced` and `blocked` follow at ~100 s and ~120 s. Feed kinds: tool, needs-you, done, agent, plan. Dense: 24 sessions, 6 projects, 3 on Bedrock. |
| 12 | Redaction of the four test strings | ✅ | `selftest`: `sqlcmd -S db -U sa -P ••• -Q "x"; Server=db;User Id=•••;Password=•••; key ••• AWS_BEARER_TOKEN_BEDROCK=•••`. Also Bearer, `token=`, `api_key=`, `secret=`, `aws_secret_access_key`, long keys. Paths, slugs and UUIDs survive. |
| 13 | A background subagent stays `running` after launch and closes when it really finishes | ✅ | In `claude -p`, the outer subagent was launched with `requestShape: "background"`. It stayed `running` past the launch's PostToolUse and the main turn's `Stop` (19:22:20.6), and closed at 19:22:25.0. The fractional `endedAt` shows the close came from `"finished": true` in its `meta.json`. |
| 14 | `claude -p` from another session's shell gets `startedBy` | ✅ | Test session `23ab13d1` (pid 35668), started from this session's Bash shell: `startedBy: "218416a5-…"`, which is this session. `claude -p` sessions do register in `~/.claude/sessions/`. |
| 15 | Account usage: is there a local source? | ✅ answered | Q2: yes, `cachedUsageUtilization` in `~/.claude.json`, and you chose to show it. The state has `account: {"fiveHour":{"pct":10,…},"sevenDay":{"pct":50,…}}`. Only that key is kept. |
| — | W14: `node hud.mjs lint <repo>` | ✅ | Scratch repo made from `workflow/templates/`: `Repository: clean`. A broken copy: 33 problems, at least one for every [lint] line of `conformance.md`. Read-only runs: WasteManagement2 clean (after a fix for wrapped roadmap lines); TourCMS 113 problems and ImPOS-Maui 13 (not migrated yet); claude-hud 6 (not migrated yet: no CLAUDE.md, status, roadmap or checks; `docs/plan/STATUS.md`; the agent-workflow STATUS copies the protocol). |

Sample of gate 2, from `/api/state`:

```
8132e8aa | WasteManagement2 | idle | "Duplicate contract client cancellation scripts" | claude-opus-5-5 | anthropic | xhigh | master | tok in/out/cr/cw=216/126758/17166585/291077 | ctx=32.1% | subs=2
8e1d4afa | FidiaCRM         | idle | "P3-06 Contacts while creating client"           | claude-opus-5-5 | anthropic | medium | web/dev | tok in/out/cr/cw=222/85984/21043954/274536 | ctx=30.5% | subs=0
d2d3c4b1 | WasteManagement2 | idle | "wastemanagement2-03"   (no transcript yet: opened, no prompt sent)
```

## Files changed

| File | What |
|---|---|
| `hud.mjs` | The draft, tested and fixed. Added: standard boards, `lint`, `projects`, `CLAUDE_CONFIG_DIR`. 2,409 lines. Q4 resume: `notificationReason` label fix and 3 `selftest` checks. |
| `.claude/settings.local.json` | Written by you (Q4): allow `node hud.mjs install`, ask for `node hud.mjs uninstall`. |
| `README.md` | New: what it is, commands, setup, what it reads and never reads, hooks, Bedrock, complete removal. |
| `.gitignore` | New: `node_modules/`, `*.log`, `.hud-tmp/`. |
| `.git/` | `git init -b main`. No commits, no remote. |
| `docs/plan/STATUS.md` | P1 board row, log, Q4. |

Outside the repository: nothing. `~/.claude/settings.json` is byte-identical to its state at the start of this
session (`e4f9fa21…`), and no backup files were left in `~/.claude/`. Test sessions of my own (about $0.05 in all, on
Haiku) wrote transcripts under `~/.claude/projects/C--Users-armen-AppData-Local-Temp-…-scratchpad-livetest/`. The
HUD shows them as ended for two hours.

## Contract as built (additions to PLAN §4.4)

- State: `projects: [{ project, root, headline, standard, git }]`. The headline is the first section of
  `docs/status.md`; `standard` and `git` come from the CLAUDE.md Workflow and Git lines (STANDARD §17). Also
  `account`, `externalError`, `hooksInstalled`, `version`, and
  `totals: { sessions, needsYou, busy, subagentsRunning, agentsRunning, tokensToday, plansInProgress, plansNeedingYou }`.
- Plans:
  - `format` (`standard` | `legacy`) and `size` (`phased` | `small`);
  - `state` and `stateDate`, from the plan header line;
  - `needsYou: [{ kind: 'decision' | 'question', id, item?, text }]`, from unticked Decisions (P0) boxes and
    unanswered Questions rows;
  - `runs` (the same node shape plus `chunks`, `lane`, `startWhen`).
- Plan nodes: `kind` (`phase` | `chunk` | `item` | `input` | `run`), `stateRaw`, `group`, `model`, `effort`, and
  `waitsForOther` (`<slug>/<ID>` dependencies on another plan, kept out of `waitsFor`). States are the standard's
  seven, plus `done` and `unknown` for old boards.
- Subagents: `background`, `modelRaw`.

## Deviations from the plan

- **The installer was proven on a sandbox copy**, and the live tests used `--settings` instead of the installed file.
  Both are because of the refusal (Q4).
- **The plan sources are broader than §5.4 says** (the user's scope change, logged earlier):
  - every `STATUS.md` / `*-STATUS.md` / `HANDOFF.md` under `docs/`, `Documentation/` or `doc/`;
  - small plans in `docs/plans/<slug>.md`;
  - the standard's board is the primary format; old formats keep working (W14).
- **The hook events list has two more than D3:** `PostToolUseFailure` and `SubagentStart`, from the current hooks
  docs ("plus any subagent-start event").

## Decisions taken

- **A session missing from the registry at startup is `ended`.** The registry lists every running session; checked:
  `claude -p` sessions register too. A later hook reopens it. Before, sessions that had just exited showed as
  `busy` for ten minutes after a HUD restart.
- **Only SessionStart, UserPromptSubmit and PreToolUse reopen an ended session.** Async Stop / SessionEnd hooks
  arrive after the registry file is gone, and used to reopen and re-end it (two "Session ended" lines).
- **"Session started" is counted once**, whether the registry or the hook reports it first.
- **`parentAgentId` in `meta.json`** (new in 2.1.312) sets a nested subagent's parent directly. The `toolUseId`
  index still works alone (it gave the right parent before this was added).
- **`/usage` redacts `app` before cutting it to 80 characters.** The draft cut first, which can leave a secret
  shorter than the patterns recognise.
- **Bodies over the limit get a real `413`** instead of a dropped connection.
- **`CLAUDE_CONFIG_DIR` is honoured** (sessions, projects, settings, `.claude.json`), as Claude Code does. It also
  made the sandbox test possible.
- **agent-workflow/P1 was not set `accepted`.** It's a dependency of this phase, and the parts HUD P1 relies on check
  out (the §5/§17 format; `boardcheck.mjs` runs). But its own gate has the cost box unticked, and the pilot was
  working on that board at the same time. Its pilot or you should judge it.
- **A permission prompt for AskUserQuestion or ExitPlanMode keeps that tool's label** ("Question for you", "Plan
  approval") instead of "Permission: AskUserQuestion" (Q4 resume). The VS Code extension asks both through a
  `permission_prompt` notification; your real session showed the wrong label. Fixed in `notificationReason`, with
  three new `selftest` checks: 37 pass, 0 fail. Not re-checked against a live prompt: the hooks were already
  uninstalled.

## Known issues

- **The context windows** in `CONTEXT_WINDOWS` are from the draft and not checked against the docs. One check:
  session `20c2cc20` ran at 584K tokens of context on `claude-opus-5-5`, so its window is above 200K, which means
  1M.
- **Plan watch:** only `.md` changes under `docs/` trigger a rescan. A `CLAUDE.md` Workflow / Git line change at
  the repo root shows on the next rescan.
- **The session `branch` reads `HEAD`** in a repository with no commits (this one, right now). That's git's own
  answer, not a bug.
- **Status for transcript tool lines:** tool calls of sessions *without* hooks reach the stream from transcript
  tailing, 0.1–3.7 s late, as the file is written.

## Out-of-scope findings

- **Testing interactive sessions headlessly** is blocked on this PC by the CLI's first-run theme picker: the bare
  CLI has never been run outside VS Code. P2's "network seen live" and "needs-you banner" checks will need a
  person, or a session in VS Code. The Q4 resume shows a way that works: install, and the user's real VS Code work
  plus the agent's own `uninstall` "ask" prompt give real prompts.
- **Two test-harness traps:**
  - Git Bash turns `\\` inside single quotes into `\`, which breaks hand-written JSON with Windows paths. Build test
    payloads in Node.
  - `--allowedTools` takes several values and swallows a prompt placed after it. Put the prompt first.

## Changes to earlier items

None.

## Lasting knowledge (where it went)

- What the HUD reads and never reads, the hook rules and timing, Bedrock ingest, complete removal: `README.md`.
- These facts go into `docs/DESIGN.md` or the README in P2 / P3:
  - transcript formats;
  - `meta.json` fields: `toolUseId`, `spawnDepth`, `parentAgentId`, `requestShape`, `finished`;
  - a background subagent is closed by `finished: true`;
  - `claude -p` registers a pid;
  - `stop_hook_summary` lines are proof of silent hooks.

## Next agent: start here

**P2 `hud`** (P1 is complete; the Q4 resume proved gate items 3 and 4 on the real file):
- Check first: `node hud.mjs selftest` (37 pass) and the gate 1 health / `Host` checks on your own port.
- **The hooks are not installed now.** `~/.claude/settings.json` is as it was. Project `.claude/settings.local.json`
  allows `node hud.mjs install` and asks for `uninstall`; run `uninstall` before you finish. The user approves that
  prompt, and the prompt itself is a real `needs-you` test.
- The page is `PAGE_HTML` / `DESIGN_HTML` in `hud.mjs`.
- The state shape is above, under Contract as built.
- `node hud.mjs --demo` / `--demo=dense` covers every state, including plan needs-you rows (a legacy question, a
  small plan's open decision).
- P2 needs the hooks installed for its live checks: the same permission applies.

## Review

Filled in by the checker.
