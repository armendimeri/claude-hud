# P5 `runtime` handoff

**Date:** 2026-11-26 · **State:** handed-off · **Model / effort used:** Codex (GPT-6, session setting) ·
**Next:** P6 and P8

## Summary

HTTP owns routes, request guards, assets and SSE. Each live or demo runtime owns its collectors, transition
clocks and published state. Health, state and initial stream frames read the published snapshot.

## Exit gate

- [x] Health/state calls and a second SSE client cannot trigger duplicate mark announcements or mutate
  latches. Tests cover update ordering, including a hook and transcript reporting the same event.
  [Stream tests](../../../../tests/stream.test.mjs) exercise a single mark across two clients and API reads,
  plus one redacted feed line per tool in both arrival orders. [Alert tests](../../../../tests/alerts.test.mjs)
  read a context warning through two streams, health and state and check that the warning keeps its timestamp
  until the latch clears. [Runtime tests](../../../../tests/runtime.test.mjs) catch a timed mark before the
  first snapshot read and verify that two synchronous writes publish as one batch.
- [x] Full/partial frames, privacy checks, keepalives, demo routes, and write guards match the contract.
  An instance test starts and closes two isolated runtimes with different configuration and no crossed state
  or leftover handles. [Contract tests](../../../../tests/public-contract.test.mjs) cover live and demo fields,
  staged assets, and host, origin, content type and body limits. The real stream sends the 2 s retry directive
  and 15 s keepalive. The two-runtime test checks both profiles, the optional usage writer, and Windows
  watcher, timer and child-process resource counts before startup and after close.

All verification ran with `HUD_NO_AUTOINSTALL=1` and OS-assigned test ports. Node `v22.12.0`
reported `all checks passed` for `node hud.mjs selftest` and **60 of 60 tests** passed for `node --test tests/`,
including the Windows PID-reuse regression. `node tests/browser-smoke.mjs` passed **all 15 Edge layouts and wrote 28 screenshots**
using isolated fixtures. [Browser captures](../../../../.hud-tmp/)

`node tests/tools/stream-size.mjs --demo=dense --seconds=30` reported 29 steady state frames
averaging 28,810 B, with a maximum of 29,018 B. The initial frame was 33,586 B.

The first full Node run overlapped Edge and hit two timing-sensitive hook failures. Both passed in the isolated rerun. The mark fixture also passed after it referenced the board item in its transcript.

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud.mjs` | Changed | Uses explicit configuration and wraps the existing live and demo collectors in per-instance state. |
| `src/config.mjs` | New | Parses the environment and discovers configured collector paths once per invocation. |
| `src/app/runtime.mjs`, `src/app/publish.mjs` | New | Own startup, teardown, ordered writes, projection, redaction and feed publication. |
| `src/contract/snapshot.mjs` | New | Defines the snapshot, feed line and source interfaces and the partial state fields. |
| `src/http/server.mjs`, `src/http/security.mjs`, `src/http/sse.mjs` | New | Serve the existing HTTP routes, enforce ingress guards, and send stream frames. |
| `tests/runtime.test.mjs` | New | Checks write coalescing, timed marks and independent runtime cleanup. |
| `tests/alerts.test.mjs`, `tests/public-contract.test.mjs`, `tests/stream.test.mjs` | Changed | Cover subscriber ordering, warning latches, write guards and keepalives. |
| `docs/plans/hud-architecture/STATUS.md`, `docs/status.md` | Changed | Record P5 and the two available follow-up lanes. |

## Contract as built

- `readConfig({ env, argv, home, hostname })` in `src/config.mjs` accepts overrides for independent profiles.
- `createHudRuntime(config, demoMode = false)` in `hud.mjs` returns `{ start, source, writer, close }`.
  `source.readSnapshot()` reads the most recent projection after `start()`, with a fresh clock.
  `source.subscribeUpdates(listener)` delivers `{ snapshot, lines }` and returns an unsubscribe function.
  `source.close()` and `runtime.close()` share the same teardown.
- `writer.ingestHook(value)` and optional `writer.reportUsage(value)` resolve to `[HTTP status, message]`.
  Hook recording and prompt omission happen at this application entry point.
- `createHttpServer({ config, source, writer })` in `src/http/server.mjs` exposes async `start()` and
  `close()`. HTTP owns sockets and stream timers. The runtime owns collector watchers, timers, reads and
  subprocesses. A composition caller closes both.
- A full stream frame seeds the connection synchronously. Each update delivers feed lines before any plan
  replacement and partial state. A client that seeds from an already published update skips its pending
  duplicate plan and state frames.

## Deviations from the plan

The last legacy projection and its transition rules live with the collectors in the `hud.mjs` closure.
P6 and P7 can replace those legacy inputs in sequence. The publisher owns sanitization, snapshot storage
and notifications. `git diff -w` helps review the collector code after it was moved into the closure.

## Decisions taken

- File and timer invalidations share a 250 ms projection window. Hook and usage writes accepted together
  commit in arrival order, and a successful POST waits for the commit so a subsequent state read sees
  its synchronous effects. Collector polls also drive transitions with zero readers.
- Redacted feed lines are stored once and reused for snapshots and the wire. Each client tracks the
  plan and partial state it has received across seed and update frames.

## Known issues

Edge phone widths were emulated. Verification used fixture workloads. P6 and P10 own the baseline
startup/RSS comparison and P10 owns the sustained live-read run.

## Out-of-scope findings

P1 records the baseline hook timing overage and the 0.3 live memory gate.
[P1 handoff](P1-baseline.md)

## Changes to earlier items

Accepted and committed P4 as `db8f01f` after all five browser-store tests and all 15 isolated Edge layouts
passed. [P4 review](P4-activity.md#review)

## Lasting knowledge

The source and writer interfaces are documented in `src/contract/snapshot.mjs` and
`src/http/server.mjs`. P10 should carry the runtime ownership and publication order into the
architecture guide.

## Next agent: start here

Review `tests/runtime.test.mjs` and `tests/stream.test.mjs` with `HUD_NO_AUTOINSTALL=1`.
P6 can replace legacy session and transcript inputs through the runtime in lane A on port 7791.
P8 can use the existing browser contract in lane B on port 7792.

## Review

Accepted 2026-11-26 by sessions (P6). Re-ran `node --test tests/runtime.test.mjs tests/stream.test.mjs tests/public-contract.test.mjs` with `HUD_NO_AUTOINSTALL=1`. All 12 tests passed, covering isolated runtime cleanup, mark and hook ordering, full/partial frames, keepalives, privacy, staged assets and write guards.
