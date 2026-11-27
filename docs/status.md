# Status

*Last rewritten 2026-11-27 after handing off CLI, demos, and packaging.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans and activity.
It serves live and synthetic state over HTTP and SSE.

## Where things stand

- P7 and P8 were accepted and committed as `645a1dc` and `a0ae048` in `../claude-hud-arch`.
- P9 separated CLI commands, Windows setup and the demo runtime. The extracted ZIP passed 88 self-checks,
  66 Node checks and 15 Edge layouts. Its median startup reached the first full frame 48.38 ms after the
  P1 comparison result, within the 100 ms tolerance.
- The optimized archive passed the required 30-run hook gate. Two additional batches measured p95
  overheads of 29.57 and 45.23 ms against the 15 ms limit.
  [P9 handoff](plans/hud-architecture/handoffs/P9-packaging.md)

## Active plans

- HUD architecture has P9 handed off. P10 can start its independent review and final verification.
  [HUD architecture](plans/hud-architecture/STATUS.md)
- HUD 0.3 release verification is deferred with the last live memory gate open.
  [HUD 0.3](plans/hud-0-3/STATUS.md)
- The repository's agent workflow migration is queued under P3-03.
  [Agent workflow](plans/agent-workflow/STATUS.md)

## What is next

- P10 runs parity, performance, and deployment verification. It also documents the architecture and rollback.
  [P10 plan](plans/hud-architecture/PLAN.md#14-p10-verify-and-close)

## Waiting on you

- The 0.3 board records the outstanding live HUD checks.
  [HUD 0.3 verification](plans/hud-0-3/STATUS.md#p10-documentation-closeout)

## The last session

The owner approved a targeted forwarder startup edit. The hook skips opening stdout during a normal forward.
All 66 Node tests and the additional held-open stdin check passed. The optimized archive met the 15 ms
budget in the required 30-run batch. All three measurements are recorded for P10.
[P9 handoff](plans/hud-architecture/handoffs/P9-packaging.md)
