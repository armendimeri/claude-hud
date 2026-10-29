# Adopting the standard in a project (STANDARD §15)

Change docs, `CLAUDE.md` and skills only, never code. Don't start while a run is going in the project or any board
item is `in-progress`; say so in the report instead.

1. **Inventory first.** List every doc, plan, status file, backlog and skill, and map each one to its home in §3.
   Put the map in your report, or in your handoff when a plan runs the migration, before you move anything.
   A doc that holds a secret (a password, a key): don't move, copy or quote it; report it as a finding.
2. **`CLAUDE.md`:** rewrite it into the §3.1 order from `templates/project/CLAUDE.md`, with the Workflow line and the
   right Git line. Keep every project rule with the same meaning, dated where the owner asked for it. Drop what
   `~/.claude/workflow/CLAUDE.user.md` already says.
3. **Homes:**
   - Create `docs/status.md`, `docs/roadmap.md` and `docs/checks.md` from the templates, filled from what exists
     (status files, backlog, follow-ups, browser checklist). Keep existing `B-<n>` IDs.
   - Delete the old files, and fix every link that pointed at them (`grep` for the old names).
4. **Plans:**
   - Active plans: convert each board to §5 with the §15 mapping table. A plan in a different shape gets a
     STATUS.md or a small-plan Board.
   - Draft plans: header `proposed`, and a board built from their phases. Say in the log that the board,
     dependencies and model/effort are your proposal, to be reviewed at P0. Never tick a decision for the owner.
   - Finished plans: move their lasting knowledge into ADRs (`templates/project/adr.md`). Their "not verified"
     list goes to `docs/checks.md`, and their open questions to the roadmap ("Found while building") or the ADR's
     Consequences. Then delete them, once `git ls-files` shows git holds them unchanged.
   - Remove `docs/plans/_template/`.
5. **Skills:**
   - Remove copies of shared skills (`apple-design`, anywhere in the repo), and move their project-specific rules
     into `docs/design-system.md`.
   - Keep domain skills, in `.claude/skills/<name>/`.
6. **Check:** run `node <claude-hud>/hud.mjs lint .` if it exists. Otherwise tick every line of
   `~/.claude/workflow/conformance.md`, with evidence.
7. **Report** (§11): the inventory map, what moved where, what was deleted, the conformance result, and the commit
   message in "you commit" projects.
