# <Project>: notes for agents

<What this is, in five lines at most: the product, the users, the stack.>

**Start here:** [docs/status.md](docs/status.md) → this file → [docs/roadmap.md](docs/roadmap.md) → the plan you were
given.
**Workflow:** this project follows the agent workflow standard (~/.claude/workflow/STANDARD.md).
**Git:** you commit

## Working with the owner

- How they test (for example: they click through the UI themselves; agents test with service and database tests).
- What they asked for, dated: "<request>" (said yyyy-MM-dd).
- What they never want.

## Build, run, test

```
<build command>
<test command>
<run command>   lane A: port <n> · lane B: port <n> · lane C: port <n>
```

## Parallel work

| Shared thing | Rule |
|---|---|
| <file or folder several items touch> | <e.g. add one line per module, keep the list alphabetical> |

## Rules

Domain conventions: data access, services, UI, localisation, tests.

## Safety

- The databases, servers and files agents never touch.
- Where secrets live (never in the repository).

## Pitfalls already hit

- <what went wrong, why, and what to do instead>
