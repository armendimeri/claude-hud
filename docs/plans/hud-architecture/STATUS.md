# Claude HUD architecture and refactor status

Implementation board for the [architecture plan](PLAN.md). Follow the repository's [workflow-run skill](../../../workflow/skills/workflow-run/SKILL.md).

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | accepted | 2026-11-26 | — | D1–D7 accepted and Q4 answered |
| P1 | Capture the baseline | `baseline` | P0 | Opus 5.5 / high | accepted | 2026-11-26 | [P1-baseline](handoffs/P1-baseline.md) | 49 tests and 11 Edge layouts passed. Hook p95 overhead was 16.51 ms |
| P2 | Serve native browser assets | `assets` | P1 | Opus 5.5 / high | accepted | 2026-11-26 | [P2-assets](handoffs/P2-assets.md) | 50 Node tests and 11 Edge layouts passed |
| P3 | Extract the browser store | `client-data` | P2 | Opus 5.5 / high | accepted | 2026-11-26 | [P3-client-data](handoffs/P3-client-data.md) | 55 Node tests and 11 Edge layouts passed |
| P4 | Prove a new full-page view | `activity` | P3 | Sonnet 5.5 / high | accepted | 2026-11-26 | [P4-activity](handoffs/P4-activity.md) | 55 Node tests and 15 Edge layouts passed |
| P5 | Separate HTTP from the application runtime | `runtime` | P4 | Opus 5.5 / xhigh | accepted | 2026-11-26 | [P5-runtime](handoffs/P5-runtime.md) | 60 Node tests and 15 Edge layouts passed |
| P6 | Extract session and transcript sources | `sessions` | P5 | Opus 5.5 / high | accepted | 2026-11-26 | [P6-sessions](handoffs/P6-sessions.md) | Lane A, port 7791. 61 Node tests and 15 Edge layouts passed. |
| P7 | Extract projects, boards, usage and alerts | `boards` | P6 | Opus 5.5 / high | accepted | 2026-11-26 | [P7-boards](handoffs/P7-boards.md) | Lane A, port 7791. 63 Node tests and a matching v1 replay |
| P8 | Factor the dashboard into reusable components | `components` | P5 | Sonnet 5.5 / high | todo | | | Lane B |
| P9 | Finish CLI, demos and packaging | `packaging` | P7, P8 | Sonnet 5.5 / high | todo | | | Verify standalone hook and install layout |
| P10 | Verify and close | `review` | P9 | Opus 5.5 / high | todo | | | Parity, performance, and release checks |

## Decisions (P0)

- [x] **D1** Keep Node 22 and native ES modules with no build step, bundler or framework.
- [x] **D2** Preserve the existing JSON and SSE contract through the move.
- [x] **D3** Use a shared browser store with registered session and full-page views.
- [x] **D4** ★ Add a demo-only Activity preview at `?view=activity` as the first proof. It comes only from the URL and is never saved as the view preference.
- [x] **D5** ★ Distribute the complete module and asset tree while keeping the current root entry paths. Do all work in `../claude-hud-arch`. The live task and hook paths stay on the original checkout until an owner-approved switchover after P10.
- [x] **D6** Start from the patched checkout, keep the 0.3 release independently deployable, and compare performance against its baseline.
- [x] **D7** Use the committed PID fix and existing branches. Commit P0 on `hud-architecture`, return the original checkout to `hud-0-3`, then add the architecture worktree. Make one commit per accepted item. No pushes or merges into `hud-0-3` or `main` without the owner.

## Always

- Treat port 7777, the **Claude HUD** scheduled task and the original checkout (`hud-0-3`) as the owner's running dashboard. After kickoff, leave that checkout on `hud-0-3` and work only in `../claude-hud-arch`.
- Start every test instance with `HUD_NO_AUTOINSTALL=1`. Without it, an instance started from the worktree would rewrite Claude Code's hook paths to point at the worktree. Use temp profiles for setup tests and fixture data for any recorded output.
- Preserve the Windows PID fix through the move. Keep refactor changes separate from unrelated work, including the stash on `main`.
- Use the OS-assigned test ports from [the existing helpers](../../../tests/helpers.mjs). For manual isolated instances use 7791 for lane A and 7792 for lane B. The final read-only comparison uses 7790.
- P6/P7 and P8 may run together after P5 in the same worktree with the disjoint scopes in the plan. Coordinate changes to shared contract tests before committing.
- Use `handoffs/<ID>-<agent>.md` for exit-gate evidence, including any owner checks. Follow the plan's deployment verification before an owner-approved live switchover.

## Questions

| # | Item | Question | Recommended | Answer |
|---|---|---|---|---|
| Q1 | D5 | How do we protect the live HUD, which runs from this checkout? | Refactor in a worktree and leave the task alone | 2026-11-26: as recommended |
| Q2 | D7 | Where does the uncommitted PID fix go? | Commit it to `hud-0-3`, then branch `hud-architecture` from there | 2026-11-26: as recommended |
| Q3 | D4 | How is the Activity preview selected? | `?view=activity`, URL-only, never saved to preferences | 2026-11-26: as recommended |
| Q4 | D7 | D7 and the Kickoff setup are stale. `hud-0-3` and `hud-architecture` both point at `a3605d9`, which already holds the PID fix (`73c0351`). This checkout, which the live task runs from, is on `hud-architecture`. How should D7 read? | Switch this checkout back to `hud-0-3` and add the worktree from the existing `hud-architecture` branch | 2026-11-26: as recommended. Commit only the architecture plan on `hud-architecture` before switching. |

## Log

- 2026-11-26 · planner · — · Drafted the phase plan from the `hud-0-3` checkout and the local Windows PID fix.
- 2026-11-26 · planner · — · Review applied. Added the live-deployment finding, D7 (git and worktree), the URL rules for the Activity preview, Out of scope, and numeric startup, memory and hook gates. Owner answered Q1–Q3 as recommended. D1–D7 still await P0.
- 2026-11-26 · planner · — · During the review, `73c0351` and `a3605d9` landed and this checkout moved to `hud-architecture`. `docs/plans/hud-0-3/` is deleted in the working tree but not committed. D7 and the Kickoff setup no longer match (Q4, deferred by the owner). Resolve Q4 before P0 is accepted.
- 2026-11-26 · human · P0 · Accepted D1–D7 and answered Q4 as recommended. Commit only the architecture plan on `hud-architecture`, switch the original checkout to `hud-0-3`, and add the worktree from the existing `hud-architecture` branch.
- 2026-11-26 · baseline · P1 · Handed off synthetic contract coverage and performance evidence. Self-test, 49 Node tests and 11 Edge layouts passed. Recorded the hook timing overage and the open 0.3 live memory gate.
- 2026-11-26 · assets · P2 · Accepted P1 and handed off native browser assets. Self-test, 50 Node tests and 11 Edge layouts passed from the architecture worktree or staged copy.
- 2026-11-26 · client-data · P3 · Accepted P2 at 61cf0d7 and handed off the shared browser store. Self-test, 55 Node tests, and 11 Edge layouts passed.
- 2026-11-26 · activity · P3 · Accepted after all five browser-store fixture tests passed.
- 2026-11-26 · activity · P4 · Handed off the demo-only Activity preview after the self-test, 55 Node tests and 15 Edge layouts passed. Verified the first-frame gate, shared stream, cleanup and live fallback.

- 2026-11-26 · runtime · P4 · Accepted after five browser-store tests and all 15 isolated Edge layouts passed, including Activity lifecycle and live fallback.

- 2026-11-26 · runtime · P5 · Handed off the runtime and HTTP split after 60 Node tests and 15 Edge layouts passed. Verified two-instance teardown and a 29,018 B maximum steady state dense-demo frame.
- 2026-11-26 · sessions · P5 · Accepted after all 12 runtime, stream and public contract checks passed.


- 2026-11-26 · sessions · P6 · Handed off the session and transcript sources after 61 Node tests, a matching 24-session replay and the comparative P1 benchmark.

- 2026-11-26 · boards · P6 · Accepted after all 25 Codex and hook checks passed.

- 2026-11-26 · boards · P7 · Handed off project, plan, usage and alert modules after 63 Node tests and a matching v1 replay. Edge captured 28 screenshots.

- 2026-11-26 · packaging · P7 · Accepted after the 27 board, usage, alert, push, and stream checks passed.

## Kickoff

Run this one-time setup from the original checkout on `hud-architecture` after P0 is accepted (D7). Both branches start at `a3605d9` and include the PID fix in `73c0351`.

```
git commit -m "[P0] Accept HUD architecture decisions" -- docs/plans/hud-architecture/
git switch hud-0-3
git worktree add ../claude-hud-arch hud-architecture
```

Start P1 from `../claude-hud-arch`.

| ID | Folder | Prompt |
|---|---|---|
| P1 | `../claude-hud-arch` | Do hud-architecture/P1. Follow the workflow-run skill. |
| P2–P10 | `../claude-hud-arch` | Do hud-architecture/&lt;ID&gt;. Follow the workflow-run skill. |
