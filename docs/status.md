# Status

*Last rewritten 2026-11-26 after the HUD architecture baseline.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans and activity. It serves live or synthetic state over HTTP and SSE.

## Where things stand

- `hud-architecture` is checked out in `../claude-hud-arch`, based on the accepted P0 commit `6318976`. The original checkout is on `hud-0-3` at `a3605d9`.
- The app runs directly on Node with no build step. Self-test and all 49 integration tests passed on Node `v22.12.0`, including the Windows PID-reuse regression.
- Edge smoke passed 11 layouts with 24 screenshots under `../.hud-tmp/` relative to this file.

## Active plans

- [HUD architecture](plans/hud-architecture/STATUS.md) has P0 accepted and P1 handed off. P2 is ready to review the baseline and start browser asset extraction.
- [HUD 0.3](plans/hud-0-3/STATUS.md) has release verification deferred with the last live memory gate open.
- [Agent workflow](plans/agent-workflow/STATUS.md) has the repository migration under P3-03 queued.

## What is next

- P2 moves the existing browser code and styles into native assets and checks route, HTTP and screenshot parity against P1.

## Waiting on you

- The architecture work has no open owner decisions. The [HUD 0.3 board](plans/hud-0-3/STATUS.md#p10-documentation-closeout) records the outstanding checks on the deployed HUD.

## The last session

P0 recorded D1–D7 and Q4 and set up the architecture worktree. P1 added synthetic CLI, settings, HTTP and SSE coverage and captured comparative startup, stream, RSS, CPU and hook timing. The synthetic median was 175.21 ms to the first full frame, and peak RSS was 57.28 MiB. Standalone hook p95 overhead was 16.51 ms against the 15 ms gate. [P1 handoff](plans/hud-architecture/handoffs/P1-baseline.md)
