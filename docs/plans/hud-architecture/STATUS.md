# Claude HUD architecture and refactor status

Implementation board for the [architecture plan](PLAN.md). Follow the repository's [workflow-run skill](../../../workflow/skills/workflow-run/SKILL.md).

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | todo | | — | |
| P1 | Capture the baseline | `baseline` | P0 | Opus 5.5 / high | todo | | | Include the local Windows PID fix |
| P2 | Serve native browser assets | `assets` | P1 | Opus 5.5 / high | todo | | | Preserve existing routes and rendering |
| P3 | Extract the browser store | `client-data` | P2 | Opus 5.5 / high | todo | | | Shared data, connection and selectors |
| P4 | Prove a new full-page view | `activity` | P3 | Sonnet 5.5 / high | todo | | | First milestone |
| P5 | Separate HTTP from the application runtime | `runtime` | P4 | Opus 5.5 / xhigh | todo | | | Application and publication interfaces |
| P6 | Extract session and transcript sources | `sessions` | P5 | Opus 5.5 / high | todo | | | Lane A |
| P7 | Extract projects, boards, usage and alerts | `boards` | P6 | Opus 5.5 / high | todo | | | Lane A |
| P8 | Factor the dashboard into reusable components | `components` | P5 | Sonnet 5.5 / high | todo | | | Lane B |
| P9 | Finish CLI, demos and packaging | `packaging` | P7, P8 | Sonnet 5.5 / high | todo | | | Verify standalone hook and install layout |
| P10 | Verify and close | `review` | P9 | Opus 5.5 / high | todo | | | Parity, performance, and release checks |

## Decisions (P0)

- [ ] **D1** Keep Node 22 and native ES modules with no build step.
- [ ] **D2** Preserve the existing JSON and SSE contract through the move.
- [ ] **D3** Use a shared browser store with registered session and full-page views.
- [ ] **D4** Add a demo-only Activity preview as the first proof.
- [ ] **D5** Distribute the complete module and asset tree while keeping the current root entry paths.
- [ ] **D6** Start from the patched checkout, keep the 0.3 release independently deployable, and compare performance against its baseline.

## Always

- Treat port 7777 and the **Claude HUD** scheduled task as the owner's running dashboard. Test on isolated ports with `HUD_NO_AUTOINSTALL=1`. Use temp profiles for setup tests and fixture data for any recorded output.
- Record the source revision and the Windows PID fix before starting. Preserve that fix through the move. Keep refactor changes separate from unrelated work in the working tree and stash.
- Use the OS-assigned test ports from [the existing helpers](../../../tests/helpers.mjs). For manual isolated instances use 7791 for lane A and 7792 for lane B. The final read-only comparison uses 7790.
- P6/P7 and P8 may run together after P5 with the disjoint scopes in the plan. Coordinate changes to shared contract tests before merging.
- Use `handoffs/<ID>-<agent>.md` for exit-gate evidence, including any owner checks. Follow the plan's deployment verification before an owner-approved live switchover.

## Questions

| # | Item | Question | Recommended | Answer |
|---|---|---|---|---|

## Log

- 2026-11-26 · planner · — · Drafted the phase plan from the `hud-0-3` checkout and the local Windows PID fix.

## Kickoff

Use the repository root as the working directory. Model and effort are in the board.

> Do `hud-architecture/P1`. Follow `workflow/skills/workflow-run/SKILL.md`. Start from this board and carry forward the local Windows PID fix when capturing the baseline.
