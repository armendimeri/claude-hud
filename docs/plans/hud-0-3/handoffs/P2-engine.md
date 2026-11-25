# P2 `engine` handoff

**Date:** 2026-11-25 · **State:** handed-off · **Model / effort used:** Opus 5.5 / high ·
**Next:** P3

## Summary

Sessions with no work wait 8 s before they show (and ended ones wait 8 s before they reopen), so a conversation the
editor opens for a moment never flashes, writes a feed line or plays a sound. Hook-only placeholder subagents are
hidden and write no "Agent done". `agentsRunning` is on every session; an idle parent with a running subagent reads
"Agents working" in violet. Fable 5.2 and Mythos 5.2 have context windows, with a cited source.

## Exit gate

- [x] `node hud.mjs selftest` ends with "all checks passed".
  ```
  $ node hud.mjs selftest
  ...
  all checks passed
  ```
- [x] `node --test tests/` reports 0 failed: **22 passed** (8 codex, 6 hooks from P1, 8 new in hooks.test.mjs).
  ```
  $ node --test tests/
  ▶ truthful sessions: placeholders, settle time and the waiting parent
    ✔ a SubagentStop for an unknown agent_id with no type adds no subagent and no "Agent done" line (7.3726ms)
    ✔ a session with no work appears at 8 s; one removed at 3 s never appears (10016.2887ms)
    ✔ a session with a hook at once is visible within 1 s (2.8112ms)
    ✔ a dated transcript line shows a session at once; an old conversation opened again waits (3006.9341ms)
    ✔ an ended session that only gets a SessionStart stays ended until it works (3013.4037ms)
    ✔ an ended session under a new process reopens only after 8 s without work (10746.3536ms)
    ✔ an idle session with a running subagent has agentsRunning: 1 (6.5477ms)
  ✔ truthful sessions: placeholders, settle time and the waiting parent (32446.6048ms)
  ℹ tests 22
  ℹ pass 22
  ℹ fail 0
  ```
- [x] Items that touch the page: `node tests/browser-smoke.mjs` passes (exit 0, 9 `pass … at …` lines), and the
  screenshots were looked at: `.hud-tmp/smoke-cards-1440x900.png` (the demo's TourCMS card reads AGENTS WORKING in
  violet, the reactor ring counts it amber), `.hud-tmp/smoke-network-1440x900.png` (the "Booking changes" node is
  violet with the running glyph), `.hud-tmp/smoke-cards-390x844.png`, `.hud-tmp/smoke-network-390x844.png` (no
  sideways scroll, nothing broken). Gallery: `.hud-tmp/p2-shots/p2-design-card-1440x900.png` (the new card specimen)
  and `.hud-tmp/p2-shots/p2-design-states-1440x900.png` (AGENTS WORKING in the states list).
- [x] `README.md` and `docs/DESIGN.md` say what the code now does. README "Using the page": a paragraph on
  "Agents working" and one on the settle time and placeholder subagents. DESIGN §8: reactor ring and Sessions vital,
  card now line and states, compact row, network node states.
- [x] Test: a `SubagentStop` for an unknown `agent_id` with no type adds no subagent and no "Agent done" line.
  `tests/hooks.test.mjs`, first subtest above (`subagents` is `[]`, no feed line starting "Agent done").
- [x] Test: a registry file for a session with no work is absent from the state at 2 s and present at 10 s; one that
  is removed at 3 s never appears and writes no feed line. Second subtest above; it also checks that a session known
  only from a SessionStart hook is absent at 2 s and present at 10 s, and that each shown one has exactly one
  "Session started" line.
- [x] Test: a session with a hook at once is visible within 1 s. Third subtest (`hud.until(..., 1000)` plus an
  elapsed-time assertion; SessionStart + UserPromptSubmit gives one "Session started" line).
- [x] Test: an idle session with a running subagent has `agentsRunning: 1`; the smoke test finds "Agents working".
  The API half is the last subtest above (background Agent call, Stop: `status: 'idle'`, `agentsRunning: 1`; after
  SubagentStop: 0). The page half: `tests/browser-smoke.mjs` is outside P2's scope, so I ran a scratch copy of it
  (`.hud-tmp/p2-agents-check.mjs`, ignored by git) with one extra assertion per page: a `.stag` reading "Agents
  working" in cards, and an `.na[data-s=agents]` node whose aria-label says "Agents working" in the network.
  ```
  $ node .hud-tmp/p2-agents-check.mjs
    P2 network at 1440x900: Session in TourCMS: Booking changes: waiting on the review agent. Claude Code. Agents working. sonnet 5.5 on Anthropic. 16.1k tokens. Context 41%.
    P2 cards at 1440x900: 1 tags; now line: Agents working1 subagent running; compact: 0; card: 1
    P2 cards at 390x844: 1 tags; now line: Agents working1 subagent running; compact: 0; card: 1
  pass browser runtime; 9 screenshots:
  exit=0
  ```
  (All 6 network and cards sizes passed; three lines shown.) A plain text search would not do: the reactor's label
  already said "Agents working" before P2. See Out-of-scope findings.
- [x] The 5.2 context windows have a cited source. `claude-fable-5-2` and `claude-mythos-5-2`, 1,000,000 tokens each:
  - https://platform.claude.com/docs/en/models/fable-5-2/overview: "Model ID: `claude-fable-5-2`", "Context window:
    1M tokens · Max output: 128K tokens" (released November 9, 2026).
  - https://platform.claude.com/docs/en/models/mythos-5-2/overview: "Model ID: `claude-mythos-5-2`", "Context window:
    1M tokens", "the same specifications and pricing as Claude Fable 5.2".
  Bedrock ids (`global.anthropic.claude-fable-5-2`) already normalise to the same key through `normalizeModel`.

After all runs: port 7777 `/api/health` → 200 `{"ok":true,"uptime":4248538,"sessions":6,"version":"0.2.0"}`; the
only `hud.mjs` process is the owner's 65024 (started 20:27:59, `--lan`); 0 headless Edge with an `edge-profile-`
folder; 0 `hud-test-*` temp folders. (One empty `hud-test-*` skeleton from 21:21, left by an interrupted run of mine,
was deleted.)

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud.mjs` | changed | Engine: `CONTEXT_WINDOWS` (5.2), `SETTLE_MS` / `SETTLE_WORK_MS` / `STARTUP_MS`, `getSession` (settle timer), new `settle`, `sessionLine`, `askResume`, `isPlaceholder`; `closeSub`, `endSession`, `scanRegistry`, `onHook`, `processLine`, `scanRecentTranscripts`, `codexTree`, `sessionView` (`agentsRunning`), `snapshot` (filter). Page: `viewStatus`, `STATUS.agents`, `nowLine`, `sessionCard`, `compactRow`, `reactor`, `vitals`, network `graph` / `prio` / `FACE_GLYPH`, `COUNT_C`, CSS for `agents`. Demo: a TourCMS session waiting on a background subagent (and one in `--demo=dense`); `agentsRunning` in the demo snapshot. Gallery: an "Agents working" card and state. |
| `tests/hooks.test.mjs` | changed | New test "truthful sessions" with 7 subtests. |
| `README.md` | changed | "Using the page": Agents working; settle time and placeholder subagents. |
| `docs/DESIGN.md` | changed | §8: reactor, vitals, session card, compact rows, network node states. |

## Contract as built

- `session.agentsRunning`: as PLAN §4.3 (a number on every session in `/api/state`; Codex roots count their busy or
  needs-you child threads). Subagents don't carry it.
- `status` keeps the four values. "Agents working" is a page-only display state: `viewStatus(x)` in `hudClient`
  returns `'agents'` when `x.status === 'idle' && x.agentsRunning > 0`. Cards and compact rows set `data-s="agents"`,
  network session nodes `data-s="agents"`.
- Engine session fields (in memory, not in the API): `seenAt`, `shown`, `pendingLine`, `resumeAt`.
  `settle(s, now = Date.now(), worked = false)` decides visibility and pending resumes; call it after anything that
  can count as work.

## Deviations from the plan

- The page half of "the smoke test finds 'Agents working'" was checked with a scratch copy of the smoke test, not by
  changing `tests/browser-smoke.mjs` (not in P2's scope).
- The settle time also covers an **ended** session that gets a new process or a SessionStart hook: it stays ended
  until it works or has run for 8 s, then reopens with one "Session resumed" line. PLAN §6 names the "Session
  resumed" line but not the reopen; without this, an old conversation the HUD still holds (ended under 2 hours ago)
  would flash open for the few seconds the editor keeps it.

## Decisions taken

- **What counts as first work:** a hook other than SessionStart / SessionEnd arriving now (whatever its `hud_at`), or
  a dated transcript line no more than 60 s (`SETTLE_WORK_MS`) older than when the HUD first saw the session. PLAN
  said `lastWork(s) > 0`, but an old conversation's transcript has old dated lines, so that test would show exactly
  the sessions D7 is meant to hide. The 60 s covers a registry file noticed a little after the first line.
- **Start-up:** every session the HUD creates in its first 5 s (registry or hook), and every ended session that
  `scanRecentTranscripts` creates, is shown at once.
- **A session that ends before it is shown** stays hidden and writes no line, even if its transcript has recent work.
- **"Session started" vs "Session resumed"** while waiting: one pending line; a "Session resumed" replaces a pending
  "Session started". The feed line keeps the time it happened, not the time it was shown.
- **Waiting parent in the vitals:** "Sessions: busy · idle" counts it with busy, as the reactor ring does. Nobody
  asked for this, but leaving it under "idle" would contradict the card next to it.
- **Network node:** violet with the running glyph, no spinner (the spinner means the node itself is working).
- **Codex** sessions are not delayed (no registry, no editor flashes).

## Known issues

- The demo now has one more node at the bottom of the network at 1440×900, and the legend line ("RUNNING · LAUNCHED
  BY · SIZE = TOKENS · RING = …") still overlaps the lowest subagent label, as P1 reported. Not made worse in kind;
  page work (P5 to P7) may want to look.
- The plans of a project appear as soon as any session of it is known, including one that is still settling (roots
  are created by `setCwd`). A plan board can therefore show for a few seconds for a conversation that never appears.
  Low impact; not fixed.

## Out-of-scope findings

- `tests/browser-smoke.mjs`: add the "Agents working" assertion from `.hud-tmp/p2-agents-check.mjs` (a `.stag` with
  that text in cards, an `.na[data-s=agents]` node in the network). P5, P6 or P7 have that file in scope. The scratch
  script is in the ignored `.hud-tmp/`, so copy the idea, not the file.

## Changes to earlier items

None.

## Lasting knowledge

- Sessions have a settle step: anything that creates a session or ends a session should go through `settle`,
  `sessionLine` and `endSession` (which already respect `shown`), never `pushFeed` a session line directly. Written
  in the comment above `settle` in `hud.mjs`.
- Tests that check settle behaviour must start their sessions more than 5 s after the HUD started (`pause(5500)`
  after `startHud`), or they are shown at once as start-up sessions. In `tests/hooks.test.mjs`.

## Next agent: start here

- Read the comment above `settle` in `hud.mjs`, then `tests/hooks.test.mjs` ("truthful sessions").
- `snapshot()` now drops sessions with `!s.shown`. If P3 adds per-session data to the stream, take it from the same
  list.
- `node hud.mjs selftest`, `node --test tests/` (about 40 s now, the settle tests wait for real time),
  `node tests/browser-smoke.mjs`.

## Owner checks

- After restarting the live HUD: open a VS Code window with old conversations in it and see that none flash in the
  sessions list or play the session sound.
- Run a coordinator with a background subagent and see its card read "Agents working" while it waits, then "Idle"
  (or "Just finished") when the subagent ends.
- A Fable 5.2 session now has a context ring.

## Review

- 2026-11-25 · coordinator · **accepted**. Checked: `node hud.mjs selftest` all checks passed; `node --test tests/` 22 pass / 0 fail; `node tests/browser-smoke.mjs` 10 pass lines; `git status` shows only P2-scope files. Re-ran two gate boxes independently: (1) fetched both cited pages myself; fable-5-2 and mythos-5-2 each state "Context window: 1M tokens"; (2) ran `.hud-tmp/p2-agents-check.mjs` (exit 0) and saw "agents working" in violet in the cards view at 1440x900. Nit for P5 to P7: the summary under the cards reads "1 agents working" (should be singular). Port 7777 /api/health 200 after.
