# P7 `boards` handoff

**Date:** 2026-11-26 · **State:** handed-off · **Model / effort used:** Codex (GPT-6, session setting) ·
**Next:** P9

## Summary

Project discovery and plan file watches supply board inputs to the parser and link rules. The running engine owns
mark clocks and alert latches and commits their effects with the redacted snapshot. Account and Bedrock usage share
the live projection, and optional phone push subscribes to fresh needs-you transitions.

## Exit gate

- [x] Board, alert, usage and push tests pass, including ambiguous IDs, plan edits in either arrival order, worktree identity, restart behavior, and transitions that affect the feed.
  `node --test tests/` passed all 63 checks on Node 22.12.0. Board tests covered both arrival orders, link
  precedence, Windows worktree identity, restart history and one feed announcement per mark. The alert and push
  tests covered latches, the local receiver, payload and rate limits. The two [external usage checks](../../../../tests/usage.test.mjs)
  covered all four CloudWatch metrics, delayed and reported row coexistence, poll failure and recovery, and region validation.
- [x] Sample v1 snapshots and stream events match equivalent pre-refactor fixture replays, including the difference between live board links and stable plan data.
  `node replay.mjs` in the temporary fixture directory compared P6 at `7b843d7` with P7. All seven `/api/state` snapshots
  and ten `/api/stream` frames matched after normalizing the fixture paths, host and generated clock fields. A new
  transcript link produced a partial state frame and left the plan record unchanged. An attributed board edit
  produced the same feed event, plan replacement and state frame, in that order. The replay also covered the
  account warning, external usage ingress, permission notification and restart.

`node hud.mjs selftest` passed all 88 checks. `node tests/browser-smoke.mjs` passed the 15 Edge layouts and
six mount cycles and generated 28 screenshots in a temporary directory. The run used isolated fixture profiles and OS-assigned ports.

## Files changed

| File | Change |
|---|---|
| `hud.mjs`, `src/app/runtime.mjs` | Compose the sources, retain instance-local board and alert state, and dispatch needs-you events. |
| `src/sources/{projects,plan-files}.mjs` | Resolve worktree identity and discover and watch plan files. |
| `src/sources/{account,external-usage}.mjs` | Read Claude's usage cache and profile flags, and poll CloudWatch when configured. |
| `src/domain/{plan-parser,board-links,board-status}.mjs` | Parse boards, resolve evidence, and maintain plan history, work links, marks and queues. |
| `src/domain/{alerts,feed,usage}.mjs` | Evaluate latches, deduplicate feed lines and aggregate usage. |
| `src/app/{publish,phone-push}.mjs` | Project public state and deliver the optional phone notification. |
| `tests/usage.test.mjs` | Exercise the CloudWatch adapter and usage aggregation with synthetic command responses. |

## Contract as built

The runtime's public `source` and `writer` interfaces follow section 4 of PLAN. The plan scanner hands
`{ file, mtime, text, planText }` to `parsePlanCandidate(record, root)` as each file is read.
`selectPlanFiles(candidates)` resolves companion and supersession precedence before the engine updates its
plan state. `followBoards(agents, plans, { now, track, unclaimedMs, stalledMs, floor })` returns marks and
`board` and attaches resolved `work` to the current session and subagent views.

`alertsFor(sessions, account, now, active, toolFor)` updates the supplied alert map. Snapshot reads use the committed
state. `phonePush.onNeedsYou(session, kind)` is subscribed at live startup and uses the existing per-session and
hourly limits.

## Deviations from the plan

None.

## Decisions taken

- Parse each document as it is read and retain its board and replacement reference. Plan scans can continue
  discarding Markdown bodies while keeping replacement precedence.
- Keep the phone transport behind a runtime event subscription. Source reconciliation still decides when a
  needs-you transition is new.

## Known issues

CloudWatch used synthetic AWS CLI responses, and phone push used a local test receiver. Phone browser widths
were emulated in Edge.

## Out-of-scope findings

The deployment switchover and live release measurements belong to P10.

## Changes to earlier items

Accepted P6 after all 25 Codex and hook checks passed and committed it as `7b843d7`. [P6 review](P6-sessions.md#review)

## Lasting knowledge

SSE plan replacement must stay independent of live board links. The app updates board clocks and alert latches
before publication so extra HTTP readers and SSE clients see the same committed transition. Carry those boundaries
into the architecture guide during P10.

## Next agent: start here

Review P7 with `node --test tests/board.test.mjs tests/plans.test.mjs tests/alerts.test.mjs tests/push.test.mjs tests/usage.test.mjs tests/stream.test.mjs`
under `HUD_NO_AUTOINSTALL=1`. Review P8 from its handoff. P9 owns the CLI, demos and staged distribution.

## Review

Accepted 2026-11-26 by P9 packaging. The targeted Node suite passed all 27 checks for board discovery and links, alerts, usage, push and SSE. Removed a trailing blank line from the usage test before committing.
