# Status

*Last rewritten 2026-11-26 after the browser store extraction.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans, and activity. It serves live
or synthetic state over HTTP and SSE.

## Where things stand

- The architecture worktree is `../claude-hud-arch`. P2 is accepted at `61cf0d7`, and P3 has been accepted in the
  worktree. The original checkout on `hud-0-3` still hosts the deployed HUD.
- The self-test and all 55 Node tests passed on Node `v22.12.0`, including the five browser data fixture tests.
- Edge passed all 11 dashboard, gallery, and kiosk layouts and verified both away-summary paths, manual retry,
  connection indicators, and a single stream across view and project changes.
  [P3 handoff](plans/hud-architecture/handoffs/P3-client-data.md)

## Active plans

- HUD architecture has P0 through P3 accepted.
  [HUD architecture](plans/hud-architecture/STATUS.md)
- HUD 0.3 release verification is deferred with the last live memory gate open. [HUD 0.3](plans/hud-0-3/STATUS.md)
- The repository's agent workflow migration is queued under P3-03. [Agent workflow](plans/agent-workflow/STATUS.md)

## What is next

- P4 uses the shared store for the demo-only Activity preview.
  [P4 plan](plans/hud-architecture/PLAN.md#8-p4-prove-a-new-full-page-view)

## Waiting on you

- The architecture work has no open owner decisions. The 0.3 board records the outstanding live HUD checks.
  [HUD 0.3 verification](plans/hud-0-3/STATUS.md#p10-documentation-closeout)

## The last session

P3 moved frame handling, recent feed history, the connection lifecycle, and the away fetch out of the renderer.
Verification used fixture data and an isolated staged distribution. [P3 handoff](plans/hud-architecture/handoffs/P3-client-data.md)
