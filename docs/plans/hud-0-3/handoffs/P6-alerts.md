# P6 alerts handoff

**Date** 2026-11-25 · **State** handed-off · **Model** GPT-6 Codex · **Next** P7

## Summary

The HUD shows dismissible amber warnings below red needs-you banners. Session cards and network node details
show output per minute for the last 30 minutes and the last completed turn's duration when known.

## Exit gate

- [x] `node --check hud.mjs` exited 0. `node hud.mjs selftest` ended with `all checks passed`.
- [x] `node --test tests/` reported `tests 39`, `pass 39`, `fail 0` on Node v26.7.0.
- [x] `node tests/browser-smoke.mjs` passed all nine views without runtime errors or horizontal page scroll.
  Headless Edge ran outside the sandbox because the sandboxed browser timed out connecting to DevTools.
  Reviewed the screenshots under `.hud-tmp/`:
  - Network: `smoke-network-1440x900.png`, `smoke-network-1024x768.png`, `smoke-network-390x844.png`
  - Cards: `smoke-cards-1440x900.png`, `smoke-cards-1024x768.png`, `smoke-cards-390x844.png`
  - Plans: `smoke-plans-1440x900.png`, `smoke-plans-1024x768.png`, `smoke-plans-390x844.png`,
    `smoke-plans-ready-390x844.png`
  - Gallery: `smoke-design-1440x900.png`, `smoke-design-1024x768.png`, `smoke-design-390x844.png`,
    `smoke-design-board-1024x768.png`, `smoke-design-queue-1024x768.png`
  - P6: `smoke-warning-1440x900.png`, `smoke-design-warnings-1024x768.png`
- [x] [README](../../../../README.md#using-the-page) documents thresholds, dismissal and session activity.
  [DESIGN](../../../DESIGN.md#warnings) documents banner order, color, dismissal and activity rendering.
- [x] The alert tests cover context at 80% and 90% and recovery below 75% and 85%, tool age at ten minutes,
  subagent inactivity at five, and both cached usage windows at 90%. An idle or permission-blocked session
  gives no tool warning. Agent, Task and background calls give none. Activity, completion and account resets
  clear their applicable warnings. An elapsed tool threshold sends an SSE update.
- [x] The Claude transcript test writes three usage lines for one message across two minute buckets and
  reports a single corrected count of 82. It also verifies old buckets age out, a subagent gets its own
  pulse, and a second Stop preserves turn length. The Codex test verifies cumulative usage and task timing.
- [x] Browser smoke verified an amber demo warning below a red banner, dismissal through a subsequent real SSE
  update, reappearance after clearing, and a separate 90% step. Each newly active ID produced one announcement event.
- [x] `/design` exposed both context stages, long tool, silent subagent and both usage windows, plus empty,
  steady and burst activity samples. Browser smoke also advanced the chart clock without a state push and
  checked output on a network subagent card.

`node tests/tools/stream-size.mjs --demo=dense --seconds=6` measured five later SSE states at 28.1 KB on
average and 28.2 KB maximum.

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud.mjs` | Changed | Alert, pulse and turn state, banner and chart rendering, demo and gallery specimens. |
| `tests/alerts.test.mjs` | New | Six integration tests for warnings, usage and turn timing. |
| `tests/browser-smoke.mjs` | Changed | Warning ordering, dismissal, announcements, charts and gallery checks. |
| `README.md`, `docs/DESIGN.md` | Changed | Warning and activity documentation. |
| `docs/plans/hud-0-3/STATUS.md` | Changed | P6 claim, handoff and log. |

## Contract as built

- As PLAN §4.3. `alerts` is present on full and later state messages. Kinds are `context`, `tool`,
  `subagent` and `usage`. Account warnings have null project, session and agent identifiers.
- `pulse.start` is the epoch millisecond of the first included minute, or null when `perMin` is empty.
  Interior gaps are zero. The page pads missing minutes on either side and ages the line without a push.
- `turn.startedAt` and `turn.lastMs` are nullable millisecond values. An aborted Codex turn clears the active
  start and keeps the last completed duration.
- `banners(api).update(sessions, alerts)` renders both kinds of banner. `happenings()` emits
  `{ type: 'warning', alert }` when an ID first appears after the initial state.

## Deviations from the plan

None.

## Decisions taken

- Both context steps stay independently active until they cross their recovery thresholds. Each can be dismissed
  separately. High context and usage indicators use amber to match D11.
- Claude workers confirmed by a SubagentStart hook stay running until completion or session end, even with an idle
  parent. This lets those workers reach the 5-minute warning. The existing inference still handles unconfirmed calls.
- Minute correction uses the timestamp of the latest usage record for a message, as the daily totals do. Session
  activity is the session's output, with a separate series for each subagent.

## Known issues

For Codex, the existing 10-minute session inactivity cutoff can end a session with no further transcript activity
before a long-tool warning is emitted.

## Out-of-scope findings

`node hud.mjs lint .` found no issue for `docs/plans/hud-0-3/`. Its repository-level output still lists eight
existing workflow issues outside this plan, including the files listed as absent under Always.

## Changes to earlier items

P5 was accepted after selftest, 33 Node tests and nine browser views. Its review and implementation are in local
commit `e70f9d1`.

## Lasting knowledge

- The tooltip and full session card share `activityLine()`. The activity window uses the page's synchronized clock,
  so an idle session needs no new samples to scroll the chart.
- A warning ID represents a condition. Dismissals belong to the page and are released only after the ID disappears
  from state. Context hysteresis uses the active IDs and runs on the server.

## Next agent

Review the P6 gates above. P7 can extend `createHud()` and `pageMain()` using the existing state render and
SSE reconnect handlers.

## Owner checks

- Listen for a warning with Sound or Voice enabled and confirm notification delivery when the tab is hidden and
  browser permission is granted. Browser smoke verified announcement detection.

## Review

- 2026-11-26 · `page` · Accepted. `node hud.mjs selftest` ended with `all checks passed`. `node --test tests/`
  reported 39 passed and zero failed. `node tests/browser-smoke.mjs` passed all nine views and rechecked warning
  ordering and dismissal across SSE, activity aging and the gallery.
