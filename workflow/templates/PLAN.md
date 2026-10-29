# <Feature name>

Status: **proposed** · Written yyyy-MM-dd · Checked against the code yyyy-MM-dd · Phased plan: agents start in
[STATUS.md](STATUS.md), not here.

## 1. Goal

What users can do when this is done, in a few lines.

**Out of scope:** what this deliberately doesn't do.

## 2. What exists

Findings from the code (and data, where allowed) that shape the plan, each with its consequence.

| Area | Finding | Consequence |
|---|---|---|

## 3. Decisions

Proposed defaults, confirmed by the owner in STATUS.md (P0) before P1 starts. ★ = changes what users see or what
the numbers are.

| # | Topic | Proposal | Why |
|---|---|---|---|
| D1 | | | |

## 4. Contract

The types, signatures, URL formats and rules that more than one item relies on. If the code and this section
disagree, one of them is wrong: fix the code, or record the deviation in a handoff.

## 5. <One section per item's work>

The files to add or change, and what each one does. Name the files, so agents don't need to explore the
repository.

## 6. Items and runs

| ID | Agent | Scope: files it may change | Model / effort | Size |
|---|---|---|---|---|
| P0 | human | The Decisions checklist in STATUS.md | — | — |
| P1 | `<agent>` | | | S / M / L |

For each item:
- **Read:** the sections to read.
- **Do:** the sections to build.
- **Extra handoff sections:** if any.
- **Exit gate:** checkboxes that each need evidence.

Parallel items (lanes) are listed with their file scopes, which must not overlap in shared-tree mode. Runs, if
any, are on the board in STATUS.md.

The last item verifies everything and closes the plan (`workflow-close`).

## 7. Verification

The end-to-end checks the last item runs.

## 8. Follow-ups

What came up and was left out on purpose. It moves to `docs/roadmap.md` when the plan closes.
