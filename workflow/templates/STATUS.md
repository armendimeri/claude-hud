# <Feature name>: status

How the agents building [<feature>](PLAN.md) pass work to each other. Agents follow the `workflow-run` skill
(`~/.claude/workflow/STANDARD.md`). Every agent reads this file first and updates it last.

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | todo | | — | |
| P1 | <title> | `<agent>` | P0 | Sonnet 5.5 / high | todo | | | |

## Decisions (P0)

Tick each, or write the change next to it. P1 starts when every box is ticked. Details in PLAN §3.

- [ ] **D1** <proposal, one line>

## Always

This plan's own rules, on top of the standard: ports, files never to touch, data that must not change.

- <rule>

## Questions

| # | Item | Question | Recommended | Answer |
|---|---|---|---|---|

## Log

- yyyy-MM-dd · planner · — · Plan written.

## Kickoff

| Item or run | Open Claude Code in | Model | Effort |
|---|---|---|---|
| P1 | `<repository folder>` | Sonnet 5.5 | high |

> Do `<slug>/<ID>`. Follow the workflow-run skill.
