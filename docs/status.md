# Status

*Last rewritten 2026-11-26 after the HUD browser asset extraction.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans and activity. It serves live
or synthetic state over HTTP and SSE.

## Where things stand

- `hud-architecture` is checked out in `../claude-hud-arch`. The accepted P1 baseline is `5c1a51c`. P2 is
  in the worktree awaiting review. The original checkout is on `hud-0-3` at `a3605d9`.
- The app runs directly on Node with no build step. Self-test passed and all 50 integration tests passed on
  Node `v22.12.0`, including the Windows PID-reuse regression.
- Edge passed all 11 layouts for the dashboard, gallery and kiosk using the staged distribution. The P2 handoff
  links to the 24 captures and records the staged launch from a different working directory.
  [P2 handoff](plans/hud-architecture/handoffs/P2-assets.md)

## Active plans

- HUD architecture has P0 and P1 accepted, P2 handed off, and P3 ready for review and browser store extraction.
  [HUD architecture](plans/hud-architecture/STATUS.md)
- HUD 0.3 release verification is deferred with the last live memory gate open. [HUD 0.3](plans/hud-0-3/STATUS.md)
- The repository's agent workflow migration is queued under P3-03. [Agent workflow](plans/agent-workflow/STATUS.md)

## What is next

- P3 extracts the browser store, transport and selectors while preserving the dashboard and SSE behavior.
  [P3 plan](plans/hud-architecture/PLAN.md#7-p3-extract-the-browser-store)

## Waiting on you

- The architecture work has no open owner decisions. The 0.3 board records the outstanding live HUD checks.
  [HUD 0.3 verification](plans/hud-0-3/STATUS.md#p10-documentation-closeout)

## The last session

P2 moved the dashboard and gallery to native browser modules and shared CSS, added the public asset allowlist
and same-origin script CSP, and documented the full installation layout. Verification used a staged copy and
synthetic data. [P2 handoff](plans/hud-architecture/handoffs/P2-assets.md)
