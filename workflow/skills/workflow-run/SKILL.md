---
name: workflow-run
description: Do an item or a run of a plan that follows the agent workflow standard (a docs/plans board, in a repository whose CLAUDE.md says it follows the standard). Use when told "Do <plan>/<item or run>", "continue run R<n>" or "adopt the agent workflow standard", or when starting work on any item of such a board. Covers checking dependencies (accept or bounce), claiming, working within scope, proving the exit gate, the handoff, the board, parallel lanes and the end-of-session report.
---

# Do a plan's item or run (agent workflow standard)

Formats: `~/.claude/workflow/STANDARD.md` (§n). Templates: `~/.claude/workflow/templates/`. Don't stop between the
items of your run.

- **Parallel lanes, worktree mode** ("Git: agents commit per item" in CLAUDE.md), **or waiting for another run:**
  read `${CLAUDE_SKILL_DIR}/parallel.md` first.
- **"Adopt the agent workflow standard":** follow `${CLAUDE_SKILL_DIR}/adopting.md` instead of the steps below.

## Find your work

- "Do `<slug>/<ID>`" is that item. "Do `<slug>/R<n>`" is that run's items, in order.
- "Continue run `R<n>`": run `git status`, finish the item that's `in-progress`, then carry on.
- The board is in `docs/plans/<slug>/STATUS.md` (phased) or `docs/plans/<slug>.md` (small). If your item is
  already `in-progress` under another agent, stop and say so.

## For each item

1. **Orient.** Read:
   - the board and the plan's Always rules;
   - `CLAUDE.md`;
   - the PLAN sections your item lists;
   - each dependency's handoff.

   Read nothing else unless the plan names it.
2. **Check your dependencies.** For each one that's `handed-off` (and not your own work from this run):
   - Re-run the quick parts of its exit gate.
   - If it passes: set it `accepted` and write the date and what you checked in its handoff's Review.
   - If it fails: set it `bounced`, write what failed in its Review and in the log, and skip every item of yours
     that needs it.
3. **Claim.** Set your item `in-progress`, with today's date in Since. Edit only your own rows.
4. **Work within scope.** Change only the files your item's scope names.
   - A change needed elsewhere goes under "Out-of-scope findings" in your handoff.
   - A gap with a clear best answer: take it, and record it under "Decisions taken".
   - A gap that changes what users see or what the numbers are, or a missing secret or owner input: don't guess.
     Set the item `blocked`, add a Questions row (recommended answer first), and carry on with items that don't
     need it.
5. **Prove the exit gate.** Every box needs evidence: a command and its output, a number, or a file path. Build and
   tests must pass. Add every page you didn't open in a browser to `docs/checks.md`.
6. **Hand off.**
   - Phased plan: write `handoffs/<ID>-<agent>.md` from `templates/handoff.md`, with Lasting knowledge.
   - Set the item `handed-off` (or `partial`, with the reason in Notes), fill in Since and the Handoff link, and
     append `- yyyy-MM-dd · <agent> · <ID> · <what happened>` to the log.
7. **Escalation:** after a wrong result, or two failed builds on the same problem, set `partial`, carry on, and
   propose a redo one step up (effort first, then the model) in the report.

**The plan's last item** (verify and close): follow the `workflow-close` skill.

## Session end

1. Rewrite `docs/status.md` (§3.2): where things stand, the plan's line under Active plans, Waiting on you, and The
   last session. Don't append history.
2. Report (§11):
   - what's done, accepted and left;
   - what you verified and what you didn't;
   - the decisions you took;
   - at most four questions;
   - a Next block for each item or run that can start now: model, effort, lane, port, and the prompt
     `Do <slug>/<ID>. Follow the workflow-run skill.`;
   - in "you commit" projects, a commit message.
