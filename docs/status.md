# Status

*Last rewritten 2026-11-26 after the Activity preview handoff.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans, and activity. It serves
live or synthetic state over HTTP and SSE.

## Where things stand

- The architecture worktree is `../claude-hud-arch`. P3 is accepted at `fad5ddb` and P4 is handed off.
  The original `hud-0-3` checkout still hosts the deployed HUD.
- Demo and dense demo now expose a full-page Activity preview at `/?view=activity`.
  [P4 handoff](plans/hud-architecture/handoffs/P4-activity.md)
- The self-test, all 55 Node tests, and all 15 Edge layouts passed. The browser trace verified the preview
  lifecycle, recovery, and the stored Network fallback on an isolated live-mode instance.

## Active plans

- HUD architecture has P0 through P3 accepted and P4 handed off for P5 review.
  [HUD architecture](plans/hud-architecture/STATUS.md)
- HUD 0.3 release verification is deferred with the last live memory gate open.
  [HUD 0.3](plans/hud-0-3/STATUS.md)
- The repository's agent workflow migration is queued under P3-03.
  [Agent workflow](plans/agent-workflow/STATUS.md)

## What is next

- P5 reviews P4 and separates HTTP and SSE from the application runtime.
  [P5 plan](plans/hud-architecture/PLAN.md#9-p5-separate-http-from-the-application-runtime)

## Waiting on you

- The architecture work has no open owner decisions. The 0.3 board records the outstanding live HUD checks.
  [HUD 0.3 verification](plans/hud-0-3/STATUS.md#p10-documentation-closeout)

## The last session

P4 used the shared store to render Activity and added a guide for future page outlets. Verification used
isolated fixture instances and OS-assigned ports. [P4 handoff](plans/hud-architecture/handoffs/P4-activity.md)
