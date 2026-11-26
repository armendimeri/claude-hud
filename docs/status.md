# Status

*Last rewritten 2026-11-26 after handing off the project, board, usage and alert extraction.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans and activity.
It serves live and synthetic state over HTTP and SSE.

## Where things stand

- P0 through P6 are accepted. P6 is committed at `7b843d7`. P7 and P8 await review in `../claude-hud-arch`.
- The runtime now composes separate project, board, account and external usage sources. Board links, mark clocks,
  alerts and phone push keep the v1 snapshot and stream behavior. [P7 handoff](plans/hud-architecture/handoffs/P7-boards.md)
- The CLI self-test, 63 Node checks and 15 Edge layouts passed. Seven HTTP snapshots and ten SSE frames matched
  the pre-P7 fixture replay.

## Active plans

- HUD architecture has P7 and P8 handed off. P9 can review them and finish the CLI, demos and packaging.
  [HUD architecture](plans/hud-architecture/STATUS.md)
- HUD 0.3 release verification is deferred with the last live memory gate open.
  [HUD 0.3](plans/hud-0-3/STATUS.md)
- The repository's agent workflow migration is queued under P3-03.
  [Agent workflow](plans/agent-workflow/STATUS.md)

## What is next

- P9 reviews P7 and P8 and verifies the CLI, demo paths and bundled installation.
  [P9 plan](plans/hud-architecture/PLAN.md#13-p9-finish-cli-demos-and-packaging)

## Waiting on you

- The 0.3 board records the outstanding live HUD checks.
  [HUD 0.3 verification](plans/hud-0-3/STATUS.md#p10-documentation-closeout)

## The last session

P7 accepted P6 and separated discovery, board rules, usage and alerts. The fixture replay verified that live
SSE links and stable plan records stay independent and that feed, plan and state events keep their order.
[P7 handoff](plans/hud-architecture/handoffs/P7-boards.md)
