# workflow/: the agent workflow standard

One way for agents to plan, build, parallelise, document and report work, in every project on this PC.

| File | What it is |
|---|---|
| [STANDARD.md](STANDARD.md) | The standard. Every rule, once. |
| [CLAUDE.user.md](CLAUDE.user.md) | The rules for every project, imported into `~/.claude/CLAUDE.md` |
| [skills/](skills/) | `workflow-plan`, `workflow-run`, `workflow-close`, and the shared `apple-design` |
| [templates/](templates/) | Plan, STATUS, handoff and small-plan templates; [templates/project/](templates/project/) has `CLAUDE.md`, `status.md`, `roadmap.md`, `checks.md` and an ADR |
| [conformance.md](conformance.md) | The checklist for "is this repository on the standard?" |
| [kit.mjs](kit.mjs) | Links all of this into `~/.claude/` and removes it again |

## Install and remove

```
node workflow/kit.mjs install                 link the workflow skills, ~/.claude/workflow and the import line
node workflow/kit.mjs install apple-design    also the shared design skill (only once no project has its own copy)
node workflow/kit.mjs status                  show what is linked
node workflow/kit.mjs uninstall               remove exactly what install added
```

- `install` links rather than copies, using directory junctions (no admin rights needed), so editing this folder
  updates every project at once.
- It never replaces a skill or folder it didn't create, and it backs up `~/.claude/CLAUDE.md` before changing it.
- Running it twice changes nothing.
- `uninstall` leaves `~/.claude` as it was before `install`.
- Run `install` and `uninstall` yourself, in a terminal. In auto mode, Claude Code's permission check refuses an
  agent's change to `~/.claude` (seen in the pilot, 2026-10-29).

## Using it in a project

- A project follows the standard once its `CLAUDE.md` has the line
  `**Workflow:** this project follows the agent workflow standard (~/.claude/workflow/STANDARD.md).`
- To get there, open Claude Code in the project and say:
  "Adopt the agent workflow standard. Follow the workflow-run skill, section Adopting."
- After that, the everyday prompts are "Plan <feature>" (`workflow-plan`) and "Do `<plan>/<item>`" (`workflow-run`).

## Changing the standard

A change is a plan in this repository, like any other (STANDARD §16), and it bumps the version at the top of
STANDARD.md.
