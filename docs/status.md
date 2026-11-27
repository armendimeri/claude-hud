# Status

*Last rewritten 2026-11-27 after verifying the HUD architecture plan.*

## The project in one paragraph

Claude HUD is a local Node 22 dashboard for Claude Code and Codex sessions, plans and activity.
It serves live and synthetic state over HTTP and SSE.

## Where things stand

- The architecture refactor is verified on `hud-architecture`. The staged build passed
  89 self-checks, 68 integration and unit tests, 15 follow-up CLI and contract tests,
  and 15 Edge layouts. [Architecture guide](ARCHITECTURE.md)
- The final live comparison measured 0.617% mean CPU and 87.75 MB peak RSS.
  Dense SSE reached 29,014 B per later state frame. The passing 30-run hook batch
  measured +10.41 ms p95. The evidence includes the slower repeat batches.
  [P10 verification](plans/hud-architecture/handoffs/P10-review.md#final-verification)

## Active plans

- The operator cockpit, private session history and connected agent controls are proposed. [Implementation board](plans/operator-cockpit/STATUS.md)
- HUD 0.3 release verification is deferred. [HUD 0.3 board](plans/hud-0-3/STATUS.md)
- The workflow migration is queued under P3-03. [Workflow board](plans/agent-workflow/STATUS.md)

## What is next

- Use the staged deployment and rollback commands for an owner-approved switchover.
  [Windows deployment and rollback](ARCHITECTURE.md#windows-deployment-and-rollback)

## Waiting on you

- Verify the deployed Windows task and real LAN devices after release approval. [Owner checks](checks.md)

## The last session

Bounded the redaction cache, removed redundant transcript and board work, and shortened
the hook response path. Verified cold startup after loading the HTTP and runtime
modules concurrently. The browser test exercised Activity reconnecting to a restarted demo.
