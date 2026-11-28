# Status

*Last updated 2026-11-27 after handing off operator cockpit P7.*

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

- The operator cockpit public-data preview is ready for review. P7 handed off the lazy route and shared inspector after passing 132 tests and the native Edge smoke. [Implementation board](plans/operator-cockpit/STATUS.md)
- HUD 0.3 release verification is deferred. [HUD 0.3 board](plans/hud-0-3/STATUS.md)
- The workflow migration is queued under P3-03. [Workflow board](plans/agent-workflow/STATUS.md)

## What is next

- P7-01 connects private history in Cards and Cockpit after P7 is accepted. [P7-01 scope](plans/operator-cockpit/PLAN.md#p7-01)
- Use the staged deployment and rollback commands for an owner-approved switchover.
  [Windows deployment and rollback](ARCHITECTURE.md#windows-deployment-and-rollback)

## Waiting on you

- Verify the deployed Windows task and real LAN devices after release approval. [Owner checks](checks.md)

## The last session

Resumed and handed off P7. Fixed inspector selection and discreet navigation, and verified zero cockpit requests at dashboard startup and one SSE stream. The repeat measured a 7.9% increase in startup p95 against P1, above the proposed 5% target. [P7 handoff](plans/operator-cockpit/handoffs/P7.md)
