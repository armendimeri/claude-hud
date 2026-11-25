# P5 tracker-ui handoff

**Date** 2026-11-25 · **State** handed-off · **Model** GPT-6 Codex · **Next** P6

## Summary

Plans shows a five-list work queue, live agent counts and drift badges, selectable item details, and a persistent
quiet-board disclosure. Session and subagent views show linked items. New drift marks follow the sound and voice toggles.

## Exit gate

- [x] `node hud.mjs selftest` ended with `all checks passed`.
- [x] `node --test tests/` reported `tests 33`, `pass 33`, `fail 0` on Node v26.7.0.
- [x] `node tests/browser-smoke.mjs` passed all nine views with zero runtime exceptions and zero horizontal page
  overflow. Headless Edge ran outside the sandbox after the sandboxed browser timed out connecting to DevTools.
  Reviewed the screenshots in `.hud-tmp/`.
  - Network: `smoke-network-1440x900.png`, `smoke-network-1024x768.png`, `smoke-network-390x844.png`
  - Cards: `smoke-cards-1440x900.png`, `smoke-cards-1024x768.png`, `smoke-cards-390x844.png`
  - Plans: `smoke-plans-1440x900.png`, `smoke-plans-1024x768.png`, `smoke-plans-390x844.png`,
    `smoke-plans-ready-390x844.png`
  - Gallery: `smoke-design-1440x900.png`, `smoke-design-1024x768.png`, `smoke-design-390x844.png`,
    `smoke-design-board-1024x768.png`, `smoke-design-queue-1024x768.png`
- [x] [README](../../../../README.md#using-the-page) explains board following, the queue, clipboard behavior and quiet
  boards. [DESIGN](../../../DESIGN.md#plan-graph) documents the graph, queue and quiet boards.
- [x] Browser smoke found the pulse and active-agent count on TourCMS P4, all three marks, all five counts, the open
  Ready list with Copy, and the linked item and plan on the session, subagent and network cards. It also verified
  that Enter opens details, the three latest changes show a timed claim with its actor, and both jump actions work.
- [x] Browser smoke read the exact prompt `Do booking-changes/P2. Follow the workflow-run skill.` back from Edge's
  clipboard on loopback. With the clipboard API absent and legacy copy forced to fail, the same text stayed
  selected in a read-only field and the HUD showed **Press Ctrl+C**.
- [x] Browser smoke measured all five buttons on one row at 1440×900, 1024×768 and 390×844. Both default views
  showed the first board title above the fold at 1024×768. The mobile Ready list opened without page overflow.
- [x] Browser smoke found the in-flight node, all three drift badges, full and empty queues and a folded quiet
  board in `/design`. The demo included a completed board and a 16-day-old inactive board, and retained their
  expansion across a reload.

Additional checks covered stable graph nodes across identical updates, graph rebuild after live counts and marks
change, emission of a new-mark announcement, and the no-board state. An isolated dense demo measured five later
SSE states at 25.4 KB average and 25.5 KB maximum with `node tests/tools/stream-size.mjs --demo=dense --seconds=6`.

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud.mjs` | Changed | Board components, session labels, drift announcements, layout, demo and gallery fixtures. |
| `tests/browser-smoke.mjs` | Changed | Queue, copy, jump, motion, preferences, live graph and gallery checks. |
| `README.md`, `docs/DESIGN.md` | Changed | User and design documentation. |
| `docs/plans/hud-0-3/STATUS.md` | Changed | P5 claim, handoff and log. |

## Contract as built

- The client uses `board.items`, `board.plans[planKey].active`, `board.ready`, `board.awaiting`, and
  `board.ownerInputs` from P4. It reads history from `plans[n].history` and each assignment's own `plan` key.
- `workQueue(api).update(rows, open?)` accepts row arrays keyed by `need`, `flight`, `ready`, `accept` and
  `drift`. `api.jump(sessionId, agentId?)` targets an agent when the current view shows it.
- The quiet-board disclosure saves its expansion in `hud.quietBoardsExpanded` through `prefs`.
- `happenings(prev, next)` emits `{ type: 'board-mark', text }` for each newly active drift mark.

## Deviations from the plan

None. The live board state and stream follow the P4 contract.

## Decisions taken

- Selecting a graph node or run opens its details below the board graph. Keyboard focus moves to the details,
  where session jumps, Escape and a close button are available.
- In flight and Drift count items. An item can list multiple agents or marks in its row. Needs you counts owner
  inputs from the engine, while board questions and decisions stay in their board cards.
- Between 900 and 1100 px the Sessions panel scrolls internally so the work queue and first board remain
  visible at 1024×768. Narrow plan headers wrap their chips so project names and totals remain readable.

## Known issues

None found in the verified demo views.

## Out-of-scope findings

None.

## Changes to earlier items

P4 was accepted after selftest, all 33 tests, all nine baseline browser views, and a separate demo-state check.
The P4 implementation and its review are in local commit `848c1d5`.

## Lasting knowledge

- Graph rebuild signatures include the per-item active count and flags. Selected details update separately so
  history or attribution changes can be drawn without rebuilding the graph.
- The queue and gallery use the same rendering components. Each new board or queue specimen should be covered
  by the browser smoke test and described in DESIGN §8.

## Next agent

Review P5 with `node hud.mjs selftest`, `node --test tests/` and `node tests/browser-smoke.mjs`. P6 can extend
`happenings()` and the announcer alongside the existing `board-mark` event and add warning fixtures in the gallery.

## Owner checks

- Confirm the copy experience on a physical LAN device if using the HUD over plain HTTP. The browser test simulates
  missing clipboard access and legacy copy failure.
- Listen to a new drift mark with Voice or Sound enabled. The browser test verifies detection of the new mark.

## Review

- Accepted on 2026-11-25 by `alerts`. Selftest passed, all 33 Node tests passed, and all nine browser views
  passed, including exact clipboard copy, the fallback, and the one-line queue and first-board layout.
