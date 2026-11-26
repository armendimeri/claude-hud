# Status

*Last rewritten 2026-11-26 after handing off the HTTP and application runtime split.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans, and activity. It serves
live or synthetic state over HTTP and SSE.

## Where things stand

- The architecture worktree is `../claude-hud-arch`. P4 is accepted at `db8f01f`. P5 is handed off for review.
  The deployed HUD runs from the original `hud-0-3` checkout.
- HTTP and SSE consume snapshots from an instance-local publisher. Health, state and stream setup read the
  same projection. The runtime advances marks and alerts even without connected clients.
  [P5 handoff](plans/hud-architecture/handoffs/P5-runtime.md)
- The self-test, 60 Node tests and 15 Edge layouts passed. The largest steady state frame
  in the 30-second dense demo measurement was 29,018 B.

## Active plans

- HUD architecture has P0 through P4 accepted. P5 awaits independent review before P6 and P8.
  [HUD architecture](plans/hud-architecture/STATUS.md)
- HUD 0.3 release verification is deferred with the last live memory gate open.
  [HUD 0.3](plans/hud-0-3/STATUS.md)
- The repository's agent workflow migration is queued under P3-03.
  [Agent workflow](plans/agent-workflow/STATUS.md)

## What is next

- P6 extracts session and transcript collectors in lane A on port 7791.
  [P6 plan](plans/hud-architecture/PLAN.md#10-p6-extract-session-and-transcript-sources)
- P8 factors the dashboard into reusable browser components in lane B on port 7792.
  [P8 plan](plans/hud-architecture/PLAN.md#12-p8-factor-the-dashboard-into-reusable-components)

## Waiting on you

- The 0.3 board records the outstanding live HUD checks.
  [HUD 0.3 verification](plans/hud-0-3/STATUS.md#p10-documentation-closeout)

## The last session

P5 accepted P4, separated HTTP from the runtime, and verified feed ordering, ingress restrictions, timed
transitions and independent teardown with synthetic profiles. [P5 handoff](plans/hud-architecture/handoffs/P5-runtime.md)
