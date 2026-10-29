---
name: workflow-plan
description: Plan a feature, roadmap item or project migration as files before any code is written, in a repository whose CLAUDE.md says it follows the agent workflow standard. Use when asked to plan, scope, design or break down work for agents. Produces docs/plans/<slug>.md (small) or docs/plans/<slug>/PLAN.md and STATUS.md (phased), with decisions for the owner, items with file scopes and exit gates, model and effort per item, lanes for parallel work and paste-ready kickoff prompts, then stops for the owner's decisions.
---

# Plan work as files (agent workflow standard)

The formats are in `~/.claude/workflow/STANDARD.md` (cited as §n below), and the templates are in
`~/.claude/workflow/templates/`. This skill is the order of work. Don't write code: a plan only reads code.

## 1. Orient

1. Read `docs/status.md`, `CLAUDE.md` and `docs/roadmap.md`. Find the roadmap item you were asked to plan. If there
   isn't one, add it under Next as `proposed`.
2. If a plan for it already exists in `docs/plans/`, update that plan instead of starting another.

## 2. Research

- Read the code the work touches. Note real file, class and method names, and check every one.
- Write each finding with its consequence. These become "What exists".
- Note what can be reused, and what several items would need to share (the contract).
- Stay on the code path you were asked about. Ask before reading unrelated flows.

## 3. Choose the size (§4.1)

| Small plan | Phased plan |
|---|---|
| One agent, one session, up to about five items | Anything bigger |
| No parallel lanes | Parallel lanes, or a contract between items |
| The owner checks the result | A different agent should check each item |

## 4. Write it

1. **Copy the template.** Small: `templates/plan-small.md` → `docs/plans/<slug>.md`. Phased: `templates/PLAN.md`
   and `templates/STATUS.md` → `docs/plans/<slug>/`. The slug is lowercase with hyphens, named after the feature.
2. **Header:** `Status: **proposed**`, today's date as Written, and today's date as Checked against the code.
3. **Goal:** what users can do afterwards, plus **Out of scope**.
4. **Decisions (phased) or Rules decided by default (small):**
   - Give every open choice a concrete proposal and the reason for it.
   - Mark with ★ the ones that change what users see or what the numbers are.
   - Prefer a plain default to an open question. Keep first versions simple, and list what was left out.
5. **Contract (phased):** the types, signatures and formats that more than one item relies on.
6. **Items:**
   - Size each one to fit a single session.
   - For each: its scope as a list of files, what to read, what to do, and an exit gate where every box can be
     proven with a command, a number or a file.
   - Name the files, so agents don't have to explore the repository.
   - The last item verifies everything and closes the plan.
7. **Model and effort** per item (§10): Sonnet by default; Opus where exactness matters or testing is hard; Haiku for
   mechanical work.
8. **Parallel work** (§9), only where it helps:
   - In shared-tree mode, items run side by side only when their file scopes don't overlap. Say so in the plan.
   - Give each lane its own port.
   - Group small sequential items into a run (`R<n>`) when one session can do them all.
9. **Board** (§5): the `P0 Decisions` row (phased), then one row per item and per owner input, every state `todo`.
   For a phased plan, add the Decisions (P0) checklist, the plan's own Always rules, and the Kickoff table with the
   prompt `Do <slug>/<ID>. Follow the workflow-run skill.`
10. **Questions:** only those that block the plan. At most four, each with the recommended answer first.

## 5. Link it

- Update the roadmap item: `proposed`, plus a link to the plan.
- Add the plan under "Active plans" in `docs/status.md`.

## 6. Check it

- Every ID on the board is unique, and every **Depends on** resolves.
- Every item has a scope, an exit gate, and a model and effort.
- The board header matches §5 exactly, and every State is one word from §6.
- Lint: once the HUD's `lint` command exists, `node <claude-hud>/hud.mjs lint .` is clean. Until then, these
  checks by hand are the check; don't try to run it.

## 7. Stop and report

End with the report (§11):
- what the plan proposes;
- the ★ decisions worth a real look;
- the questions;
- for a phased plan, the Next prompt for P1, to use once P0 is ticked.

Don't start building: the owner confirms the decisions first. When they confirm, set P0 to `accepted`, tick the
boxes and set the header to `approved yyyy-MM-dd`. Then the first item can start, in this session if the owner says
"go", or in a new one.
