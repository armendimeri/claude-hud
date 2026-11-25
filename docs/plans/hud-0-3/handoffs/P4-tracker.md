# P4 tracker handoff

**Date** 2026-11-25 · **State** handed-off · **Model / effort** Opus 5.5 / xhigh (initial engine), GPT-6 Codex (completion) · **Next** P5

## Summary

The engine links sessions and subagents to board items, tracks drift and queue entries, and records board changes in memory. The demo uses the same resolver and shows all three marks and all three queue lists.

## Exit gate

- [x] `node hud.mjs selftest` ended with `all checks passed`.
- [x] `node --test tests/` reported `tests 33`, `pass 33`, `fail 0` on Node v26.7.0.
- [x] `node tests/browser-smoke.mjs` passed in headless Edge with nine views, zero runtime exceptions and zero horizontal page overflow. Edge and Chrome timed out at `Runtime.enable` inside the sandbox. Edge passed outside it against an isolated demo HUD.
  Reviewed all nine screenshots in `.hud-tmp/`.
  - Network: `smoke-network-1440x900.png`, `smoke-network-1024x768.png`, `smoke-network-390x844.png`
  - Cards: `smoke-cards-1440x900.png`, `smoke-cards-1024x768.png`, `smoke-cards-390x844.png`
  - Gallery: `smoke-design-1440x900.png`, `smoke-design-1024x768.png`, `smoke-design-390x844.png`
- [x] `README.md` describes the board API, timers, history and prompt handling. The design gallery still describes the current interface. P5 owns the board UI and `docs/DESIGN.md`.
- [x] Resolver selftests cover home-plan rules 2.1–2.5, item rules 3.1–3.3, the three-item cap, ambiguous and missing IDs, prompt-only mentions, the wrong project and parent roles.
- [x] `node --test tests/board.test.mjs` reported `pass 8`, `fail 0`. The first seven tests cover arrival order, restart, repeated IDs, six mentions, old chunk and phase boards, Windows case and slashes with a worktree, and user and Agent prompt privacy. Restart also covers attributed change history, the claim feed line and fresh clocks.
- [x] The eighth test uses 1,000 ms and 3,000 ms limits. It verifies each mark and queue list turns on and off, and each mark writes one feed line even when it reappears.
- [x] `node hud.mjs selftest` measured 0.218 ms per snapshot for 300 items in 14 plans and 30 agents, averaged over 200 runs. It measures indexing, resolving and board state together.
- [x] An isolated `startHud({ demo: true })` returned a `work` field on every session and subagent from `/api/state`. Four sessions and two subagents had item links. The response contained `early`, `stalled` and `unclaimed`, plus one entry each in `ready`, `awaiting` and `ownerInputs`. Each marked item wrote one feed line. The first SSE state matched the API board, and a later state carried the board without plans or feed.

`node tests/tools/stream-size.mjs --demo=dense --seconds=30` measured 29 later states at 25.4 KB average and 25.5 KB maximum. P3 averaged 24.2 KB. The live HUD answered `GET /api/health` on port 7777 with HTTP 200 after verification. No test posted to it. Workflow lint reported existing repository and user setup findings and zero findings for this plan.

## Files changed

| File | Change |
|---|---|
| `hud.mjs` | Board evidence, resolver, marks, lists, history, privacy handling for direct hook posts, demo state and resolver selftests. |
| `tests/board.test.mjs` | Eight integration tests against isolated HUDs. |
| `README.md` | Board state contract, evidence handling, timer overrides and measured stream size. |
| `docs/plans/hud-0-3/STATUS.md` | P4 row and log. |

## Contract as built

- Session and subagent `work` is `{ plan, items: [{ id, via, plan }], role }` or `null`. `via` is `ref`, `name` or `branch`. `role` is `worker` or `coordinator`.
- `state.board` follows PLAN §4.3 for `items`, `plans`, `ready`, `awaiting` and `ownerInputs`. `items` contains only linked or marked items. `plans` contains only plans with active agents. `since` measures the current in-flight stretch or, for a quiet in-progress item, the start of the stalled clock. Other rows carry `null`. Flags are ordered `unclaimed`, `stalled`, `early`.
- Each plan carries `history: [{ at, id, from, to, sessionId, agentId }]` (last 50, in memory). Each item or run carries `handoff: boolean`. A blank cell or em dash is false.
- `followBoards(agents, planList, { now, track, unclaimedMs?, stalledMs?, floor? })` fills `view.work` and returns `{ board, turnedOn }`. The engine and demo each hold their own clocks.
- New marks write a `plan` feed line once per item and mark. Known writes that move an item to in-progress say `<plan>: <ID> claimed by <label>`.

## Deviations from the plan

- History rides with `plans[n].history` in the `plans` event. The steady `board` payload omits history.
- Each linked item carries its own `plan` so the page can render an item resolved outside the agent’s home plan. A qualified title or description ID can also identify its plan.
- P5 will switch the page’s Working chip to `board.plans[planKey].active`. P4 supplies the count.
- A linked subagent can coordinate its own children. A ready run represents its chunks in the queue, and owner inputs count dependents already marked `blocked`. Ready entries also exclude rows assigned to `human` or `owner`.
- Marks present during the first five seconds are treated as startup state for the live feed. Demo seed marks are announced so the feed illustrates them.

## Decisions taken

- Scan prompts from newest to oldest and keep up to 40 ID-shaped words per holder. Discard older bare mentions first. Skip synthetic Claude Code messages and tool results.
- Read prompt evidence from transcripts so it rebuilds at restart. The hook forwarder omits prompt bodies. The HTTP receiver also removes `prompt` and `tool_input.prompt` from direct posts before recording.
- Use the newest board write signal for attribution. A successful PostToolUse refreshes the PreToolUse timestamp. Evidence from hooks alone clears on restart.
- Use the same resolver for the engine and demo. Dense mode also includes a linked session and subagent so the stream measurement includes board data.

## Known issues

- A coordinator title containing item IDs can make those items count as in flight while the coordinator is active.
- If the watched docs directory is first created after project discovery, the existing watcher may miss it until restart. A board that disappears temporarily also loses its individual item clocks.
- Claude Code transcripts supply prompt and file-tool evidence. Codex sessions contribute their existing titles and branches.

## Out-of-scope findings

P9 can add `HUD_UNCLAIMED_MS` and `HUD_STALLED_MS` to CLI help when it edits `HELP`.

## Changes to earlier items

None.

## Lasting knowledge

- Raw ID words and file evidence resolve at snapshot time. Tests cover a transcript arriving before its board and reconstruction from scratch. The transcript tail and subagent comments explain where evidence lives.
- `planFile()` and `planFileKey()` must produce the same key for the scanner and tool evidence. Keep them aligned when plan slug rules change.
- `board` is part of a steady SSE state. Board history follows the existing change-only `plans` event.

## Next agent

P5 can read this contract and use `node hud.mjs --demo` on its isolated test port. The default demo has a TourCMS unclaimed item, a stalled FidiaCRM item, early starts and all three queue lists. Use each item’s `plan` when rendering its link and `plans[n].history` when rendering changes.

## Owner checks

None for the P4 engine. The plan’s P10 verification covers real-session evidence and live stream measurements.

## Review

- 2026-11-25 · tracker-ui · Accepted. Selftest passed (0.205 ms per snapshot), all 33 tests passed, and the nine headless Edge views passed. The isolated demo exposed work fields, all three marks and all three engine lists.
