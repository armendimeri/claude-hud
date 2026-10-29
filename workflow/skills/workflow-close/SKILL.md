---
name: workflow-close
description: Verify and close a finished plan of the agent workflow standard. Use for a plan's last (verify) item, or when asked to "close the plan", in a repository whose CLAUDE.md says it follows the standard. Checks every item not yet accepted, runs the plan's verification, moves lasting knowledge to its permanent home (ADRs, CLAUDE.md, design system, docs), updates the roadmap and status, deletes the plan in the same change and reports.
---

# Close a plan (agent workflow standard)

The formats are in `~/.claude/workflow/STANDARD.md` (§14), and the templates are in `~/.claude/workflow/templates/`.
Closing is the last item of every plan. You are a different agent from the ones who built it, so you check rather
than trust.

1. **Orient.** Read the whole board, every handoff and PLAN "Verification".
2. **Accept what's left.** For every item that's `handed-off`:
   - Re-run its exit gate, the quick parts at least.
   - Accept it, or bounce it with the reason in its Review.

   If anything ends up `bounced`, `blocked` or `partial`, **don't close**. Report what's left, with a Next prompt
   for its owner, and stop.
3. **Verify end to end.** Run every check in PLAN "Verification", with evidence. Anything that only the owner can
   check goes in `docs/checks.md`.
4. **Move lasting knowledge.** For every handoff's "Lasting knowledge", and every decision that outlives the plan:

   | Kind of knowledge | Where it goes |
   |---|---|
   | A decision and its reasons | A new ADR (`templates/project/adr.md`), with the next free number in `docs/adr/` |
   | A rule agents must follow | `CLAUDE.md`, in the right §3.1 section, dated when the owner asked for it |
   | A UI rule or component | `docs/design-system.md` |
   | How the system works | The domain or architecture docs, as it is now, with no dates |
   | Something the code needs to say | A code comment, only if this item's scope allows code changes |

   Nothing important may live only in the plan.
5. **Follow-ups:** move the ones the owner wants to `docs/roadmap.md` "Found while building" as roadmap items: the
   next free `**B-<n>**`, a title, `proposed`, and where it came from (§3.3). Drop the rest, and say so in the
   report.
6. **Roadmap and status:**
   - Remove the plan's roadmap item.
   - Rewrite `docs/status.md`: drop the plan from "Active plans", and record what was built and verified under
     "Where things stand" and "The last session".
7. **Set the plan header to `verified`, then delete the plan only if git already holds it.** That means
   `git ls-files docs/plans/<slug>` lists it and `git status` shows nothing uncommitted in it. Otherwise
   (usual when the owner commits), keep it, and add "Commit, then delete `docs/plans/<slug>/`" under "Waiting on you"
   in `docs/status.md`, so the owner's commit keeps the plan in history. ADRs that point at the plan say
   "deleted; see git history". The close item writes no handoff: the report is the record.
8. **Report** (§11):
   - what was verified and what wasn't;
   - where each piece of lasting knowledge went;
   - what was left out;
   - the commit message, in "you commit" projects;
   - the next roadmap item, as a `workflow-plan` prompt.
