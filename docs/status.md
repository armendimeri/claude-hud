# Status

*Last rewritten 2026-11-26 after handing off the session and transcript sources.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans, and activity. It serves
live or synthetic state over HTTP and SSE.

## Where things stand

- P5 is accepted at `252af2e`. P6 is accepted in `../claude-hud-arch`.
  The deployed HUD runs from the original `hud-0-3` checkout.
- Claude registry entries, Claude transcripts, Codex rollouts and hook events have dedicated input adapters.
  The shared reader tracks file identity and resumes from byte offsets. The session and subagent rules
  use the same published shapes. [P6 handoff](plans/hud-architecture/handoffs/P6-sessions.md)
- The CLI self-test and all 61 Node tests passed. Edge covered 15 layouts across two runs. A replay matched 24 public
  sessions and daily token totals. Against an archived P1 build rerun in this session, P6 was 51.06 ms slower
  to the first full frame and used 1.71% more peak RSS. The original P1 record and the new readings are in
  the handoff.

## Active plans

- HUD architecture has P0 through P6 accepted. P8 can start in Lane B on port 7792.
  [HUD architecture](plans/hud-architecture/STATUS.md)
- HUD 0.3 release verification is deferred with the last live memory gate open.
  [HUD 0.3](plans/hud-0-3/STATUS.md)
- The repository's agent workflow migration is queued under P3-03.
  [Agent workflow](plans/agent-workflow/STATUS.md)

## What is next

- P7 reviews P6 and extracts projects, boards, usage and alerts in Lane A on port 7791.
  [P7 plan](plans/hud-architecture/PLAN.md#11-p7-extract-projects-boards-usage-and-alerts)

## Waiting on you

- The 0.3 board records the outstanding live HUD checks.
  [HUD 0.3 verification](plans/hud-0-3/STATUS.md#p10-documentation-closeout)

## The last session

P6 accepted P5 and extracted the source adapters, Windows process lookup and session rules. It verified
larger-file rotation, lifecycle ordering and parity with the public snapshots. [P6 handoff](plans/hud-architecture/handoffs/P6-sessions.md)
