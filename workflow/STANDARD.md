# The agent workflow standard

Version **0.9** (draft until the rollout review, then 1.0) · Home: `claude-hud/workflow/` · Installed at
`~/.claude/workflow/` by `node workflow/kit.mjs install`.

How every project on this PC plans, builds, parallelises, documents and reports agent work. Each rule lives
here once. The skills (`workflow-plan`, `workflow-run`, `workflow-close`) say *what to do in which order* and
point here for formats. The templates in [`templates/`](templates/) are these formats, ready to copy.

A project follows this standard when its `CLAUDE.md` says so (§3). A project that doesn't keeps its own
protocol until it's migrated (§15).

## 1. Principles

1. **Files carry the state, not the conversation.** Anything the next agent needs is in a file.
2. **One home per fact.** Status lives in `docs/status.md`, upcoming work in `docs/roadmap.md`, a plan's progress in
   its board. Other files link to these homes rather than repeat them.
3. **Decide defaults; ask little.** A gap with a sensible default is decided and reported. Ask at most four
   questions at a time, each with the recommended answer first.
4. **Evidence, not claims.** Every exit-gate tick has a command and its output, a number, or a file path. Say
   plainly what was not verified.
5. **The cheapest setting that gets it right the first time** (§10).
6. **Never disturb running work.** No reformatting a board while one of its items is `in-progress`, no stopping
   the owner's app, no touching another lane's files.

## 2. Layers

| Layer | Lives in | Holds |
|---|---|---|
| User | `~/.claude/`, linked to this folder by the kit | `CLAUDE.md` imports [`CLAUDE.user.md`](CLAUDE.user.md) (the rules that hold in every project). Skills: `workflow-plan`, `workflow-run`, `workflow-close`, and later `apple-design`. `~/.claude/workflow/` is this folder. |
| Project | each repository | `CLAUDE.md`, `README.md`, `docs/` (§3), and project-only skills in `.claude/skills/`. |
| Plan | `docs/plans/` | One small plan file, or one phased plan folder, per piece of work (§4). Deleted once verified. |

The kit links rather than copies, so editing this folder updates every project at once. Changing the standard
needs a plan in this repository, like any other change (§16).

## 3. Project files

```
<repo>/
├── CLAUDE.md                 rules for agents (§3.1); never the status
├── README.md                 for people: what it is, how to install and run it
├── .claude/skills/<name>/    skills only this project needs (domain skills), if any
└── docs/
    ├── status.md             where the work stands (§3.2); the only place that says so
    ├── roadmap.md            upcoming work in the owner's order (§3.3)
    ├── checks.md             what only the owner can check by hand (§3.4)
    ├── design-system.md      UI projects: tokens, components, the rules that override apple-design
    ├── adr/NNNN-<title>.md   decisions that outlive a plan (§3.5)
    └── plans/
        ├── <slug>.md         a small plan (§4.2)
        └── <slug>/           a phased plan (§4.3): PLAN.md, STATUS.md, handoffs/
```

Other documentation (domain overviews, architecture, deployment guides) is welcome under `docs/`. It describes the
system *as it is*, with no dated change notes and no status.

### 3.1 `CLAUDE.md`

These headings, in this order. Leave out a section that would be empty, but don't add sections in between.

```
# <Project>: notes for agents

<What this is, in five lines at most.>

**Start here:** docs/status.md → this file → docs/roadmap.md → the plan you were given.
**Workflow:** this project follows the agent workflow standard (~/.claude/workflow/STANDARD.md).
**Git:** you commit | agents commit per item (worktree mode)

## Working with the owner      how they test, what they asked for (dated), what they never want
## Build, run, test            commands; the port for each lane
## Parallel work               shared files and the rule for each; the integration branch in worktree mode
## Rules                       domain conventions
## Safety                      databases, secrets, what never to touch
## Pitfalls already hit
```

The **Workflow** line is what switches the standard on for agents. The **Git** line picks the mode (§9.2).
Nothing that `CLAUDE.user.md` already says is repeated here.

### 3.2 `docs/status.md`

It's rewritten, never added to, at the end of every session that changed something, and kept short enough to
read in one go. It has six sections:

```
# Status

*Last rewritten yyyy-MM-dd, after <what>.*

## The project in one paragraph
## Where things stand          git, build, tests (real numbers), what has been opened in a browser, databases
## Active plans                one line each: plan, state, current item, link
## What is next                links to roadmap items
## Waiting on you              questions, owner inputs, checks
## The last session            what changed and what was checked
```

There are no history sections: git has the history, and ADRs hold the decisions.

### 3.3 `docs/roadmap.md`

Upcoming work only, in the owner's order. A built item leaves it.

```
# Roadmap

## Next
- **B-12** Booking changes · approved 2026-10-28 · [plan](plans/booking-changes.md)
  One or two lines of context, if needed.
## Later
## On hold
## Found while building        findings left out on purpose, each saying where it came from
```

- IDs are `B-<n>`, never reused.
- The item states are `proposed`, `approved yyyy-MM-dd`, `building` and `on hold`.

### 3.4 `docs/checks.md`

What only the owner can check by hand (pages not yet opened in a browser, real devices, production), grouped by
area. Every item adds its unchecked entries here. The owner ticks or deletes them.

```
# Checks for the owner

## <Area or page>
- [ ] <What to try and what should happen> (item <plan>/<ID>, yyyy-MM-dd)

## Found while testing
| Date | Where | What happened | Fixed in |
|---|---|---|---|
```

### 3.5 ADRs

`docs/adr/NNNN-<kebab-title>.md`, numbered from the next free number. An accepted ADR's decision is never
rewritten; it may get dated notes, or be superseded by a newer ADR.

```
# NNNN <Title>

Status: accepted yyyy-MM-dd · From plan <slug> (deleted; see git history)

## Context
## Decision
## Consequences
```

## 4. Plans

### 4.1 Size and header

- **Small plan:** one agent builds it in one session. At most about five items, no parallel lanes, and no
  contract between items that needs writing down.
- **Phased plan:** anything bigger, or anything where a different agent should check the work.

Both sizes start with the same header line:

```
Status: **proposed** · Written yyyy-MM-dd · Checked against the code yyyy-MM-dd
```

The state moves `proposed` → `approved` *yyyy-MM-dd* → `building` → `verified`, and the plan is deleted once
verified (§14).

### 4.2 Small plan: `docs/plans/<slug>.md`

```
# Plan: <title>
Status: …
## Goal                         what the user can do afterwards; **Out of scope:**
## What exists and is reused    real file, class and method names, checked in the code
## Rules decided by default     "say if one is wrong"; ★ on what changes what users see or the numbers
## Items                        one subsection per item: scope (files), what to do, exit gate
## Board                        §5
## Left out on purpose
## Tests
```

There's no STATUS file and there are no handoffs: the end-of-session report (§11) and `docs/status.md` cover it.

### 4.3 Phased plan: `docs/plans/<slug>/`

| File | Holds |
|---|---|
| `PLAN.md` | Header; **1 Goal** (with Out of scope); **2 What exists** (finding → consequence table); **3 Decisions** (`D<n>`, proposal and why, ★); **4 Contract** between items (types, signatures, formats several items rely on); **5…** one section per item's work, naming the files; **Items and runs** (scope, Read / Do, exit gate, model and effort); **Verification**; **Follow-ups**. |
| `STATUS.md` | **Board** (§5); **Runs** when needed; **Branches** in worktree mode; **Decisions (P0)** checklist; **Always** (this plan's own rules: ports, files never to touch); **Questions**; **Log**; **Kickoff**. It doesn't copy the protocol: one line says "Agents follow the `workflow-run` skill." |
| `handoffs/<ID>-<agent>.md` | One per finished item (§12). |

PLAN.md is not edited while the plan is being built. A wrong plan is reported in a handoff and decided by the
owner, not rewritten in silence.

## 5. The board

One format everywhere. It sits in STATUS.md (phased) or in the plan file itself (small).

```
## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | accepted | 2026-10-29 | — | |
| P1 | Data and history | `data` | P0 | Opus 5.5 / high | in-progress | 2026-10-29 | | port 5098 |
| P2 | History tab | `history-ui` | P1 | Sonnet 5.5 / high | todo | | | lane A |
| O-1 | Sample quotations | owner | — | — | todo | | | unlocks P3 |
```

| Column | Rule |
|---|---|
| ID | `P<n>`, or `P<n>-<nn>` for items inside phase *n*. Owner inputs are `O-<n>`. An existing prefix may stay (`UX-10`). IDs are unique within the plan and never reused. A phased plan's first row is `P0 Decisions`, agent `human`. |
| Item | A short title. |
| Agent | The role name in backticks (`data`, `history-ui`), `human` for P0, `owner` for owner inputs. One agent per item. |
| Depends on | IDs, comma-separated. A range is `P3-01–P3-05` (en dash, or "to"). Another plan is `<slug>/<ID>`. `—` means none. Dependencies are never written in Notes. |
| Model / effort | `<Model> / <effort>`, for example `Sonnet 5.5 / high` (§10). `—` for human and owner rows. |
| State | **One word** from §6. Nothing else in the cell. |
| Since | `yyyy-MM-dd` of the last state change, or empty. |
| Handoff | A link to `handoffs/<ID>-<agent>.md`, `—` when none will exist, or empty. |
| Notes | Short context: lane, port, the reason for `blocked` or `partial`. |

**Runs**, only when a run holds more than one item. When every run is a single item, the lane and port go in
Notes (`Lane A · port 5098`), and a Runs table would only repeat the board:

```
## Runs

| Run | Items, in order | Model / effort | Lane | Start when | State |
|---|---|---|---|---|---|
| R1 | P1-01 → P1-02 → P1-03 | Sonnet 5.5 / medium | A | P0 | in-progress |
```

- Run IDs are `R<n>`; side runs (lane C) are `S<n>`.
- "Start when" holds the IDs that must be `handed-off` or `accepted` first.
- The run's State uses the same words as items.

**Branches**, in worktree mode only:
`| Branch | From | Merges into | State | Who merges |`, one row per open branch.

**Decisions (P0)**, in STATUS.md: `- [ ] **D<n>** <proposal, one line>`. The owner ticks each box, or writes the
change next to it. P1 starts when every box is ticked.

**Questions:** `| # | Item | Question | Recommended | Answer |`. A row with an empty Answer is waiting on the
owner.

**Log:** append only, newest last: `- yyyy-MM-dd · <agent> · <ID or —> · <what happened>`.

**Kickoff:** a table `| Item or run | Open Claude Code in | Model | Effort |`, followed by the one prompt:

> Do `<slug>/<ID or run>`. Follow the workflow-run skill.

## 6. States

| State | Meaning | Set by |
|---|---|---|
| `todo` | Not started | the planner |
| `in-progress` | An agent has it | that agent, when it claims it |
| `blocked` | Needs a person; there's a row under Questions, or an owner input is missing | the agent |
| `partial` | Stopped with part of the gate met; the handoff says what's left | the agent |
| `handed-off` | The gate is proven with evidence, and the handoff is written | the agent |
| `accepted` | Checked by a **different** agent: the next one that depends on it, or the plan's verify item | the checker |
| `bounced` | The check failed; the item goes back to its owner, with the reason in its handoff's Review | the checker |

- Inside a run, the same agent's later items don't count as a check. The next run, or the verify item, accepts.
- An item whose dependencies are `handed-off` or `accepted` may start.
- Owner inputs (`O-n`) go `todo` → `accepted` once the owner provides them.

## 7. Sessions, runs and the protocol

A session does **one run**. A run is one item unless the plan groups small sequential items into a run, and the
agent doesn't stop between the items of its run. The `workflow-run` skill is the procedure. In short, for each
item:

1. **Orient:**
   - read STATUS (or the small plan), `CLAUDE.md`, the PLAN sections the item lists, and the handoff of each
     dependency;
   - don't explore the whole repository: the plan names the files.
2. **Check what you were given:** re-run the quick parts of each dependency's exit gate.
   - If it passes, set it `accepted`.
   - If it fails, set it `bounced`, write why in its Review, and skip every item of yours that needs it.
3. **Claim:** set the item `in-progress` with today's date. If another agent has it, stop.
4. **Work within the item's scope:**
   - A needed change outside the scope goes under "Out-of-scope findings" in your handoff; don't make it.
   - A gap with a clear best answer: take that answer and record it under "Decisions taken".
   - A gap that changes what users see or what the numbers are: set the item `blocked`, add a question, and carry on
     with the items that don't depend on it.
5. **Prove the exit gate** with evidence.
6. **Hand off:**
   - Write `handoffs/<ID>-<agent>.md` (phased plans only).
   - Set the item `handed-off`, fill in the Handoff column, and append a log line.
7. **Next item** of the run, or the session end.

**Session end:**
1. Rewrite `docs/status.md` (§3.2).
2. Add unchecked items to `docs/checks.md`.
3. Report (§11).

**Resuming:** "continue run `R<n>`" means:
1. Check `git status` and the board.
2. Finish the item that's `in-progress`.
3. Carry on with the run.

## 8. Rules for every agent

- Don't edit PLAN.md while the plan is being built. Report a wrong plan instead.
- Edit only your own rows on the board, your run's row and your branch's row, and append log lines.
- Your scratchpad is yours alone. What the next agent needs goes in the handoff.
- Never copy secrets (connection strings, keys, tokens) into any file. Never read credential files.
- Never stop or rebuild over the owner's running app. Use your lane's port, or a scratch copy.
- Don't quietly fix another item's work. The exception is an obvious one-line fix, listed under "Changes to earlier
  items" in your handoff.

## 9. Parallel work

### 9.1 Lanes

- Lanes **A** and **B** are for code, and lane **C** is for docs and tests only.
- At most two code lanes run at once, and never two runs in the same lane.
- Each lane runs the app on its own port; `CLAUDE.md` "Build, run, test" lists them.

### 9.2 Two modes, chosen by the project's Git line

| | Shared tree (default, "you commit") | Worktrees ("agents commit per item") |
|---|---|---|
| Working folder | One, shared | One worktree per run, on branch `<plan-slug>/<run>`, made from the integration branch |
| When items may run side by side | Only if the plan says their file scopes don't overlap | When their dependencies allow; shared files follow §9.3 |
| Commits | None by agents; the handoff lists every changed file | One per item, `[<ID>] <title>`; after each item, merge the integration branch in, rebuild, test, then fast-forward the integration branch (`--ff-only`), retrying if it moved |
| Board | — | A Branches table; whoever creates a branch merges and deletes it |

### 9.3 Shared files

`CLAUDE.md` "Parallel work" lists the files several items touch, with the rule for each:
- registrations are appended one line per module, in alphabetical order;
- partial classes, one file per module;
- each module's own resource files;
- no reordering or reformatting of other sections.

A conflict outside these rules means stop, set the item `blocked`, and describe the conflict in the handoff.

### 9.4 Waiting for another run

Before an item starts, check each of its dependencies:
- Done (`handed-off` or `accepted`): start the item.
- Not done, but its run is still going: do another item of yours first if you can. Otherwise wait, as a
  background command that polls the board every 10 minutes for up to 8 hours.
  - In worktree mode, read the board from the integration branch: `git show <branch>:<path to STATUS.md>`.
  - In shared-tree mode, read the file itself.
- Not done, and no run has it: skip the item and every item that depends on it, and list them in your report.

## 10. Model and effort

| Model | Use for |
|---|---|
| Haiku 5.5 | Mechanical work: copying, installing, docs that list what the code already says |
| Sonnet 5.5 | **Default:** CRUD pages, lists, dialogs, most UI work, doc migrations |
| Opus 5.5 | Rules that must be exact or are hard to test (auth, money, numbering, documents, status flows, shared abstractions), and plans themselves |
| Fable 5.1 | Not planned; the last escalation step only |

Effort levels:
- `low`: mechanical work.
- `medium`: normal work.
- `high`: many rules or tricky state.
- `xhigh`: exact output that is hard to verify.

A run uses the strongest setting any of its items needs; one model with medium effort covers the next model down
with high effort.

**Escalation:** after a wrong result, or two failed builds on the same problem:
1. Set the item `partial` and carry on with the rest of the run.
2. In the report, propose a redo one step up: effort first, then the model.
3. Write the setting you used in the handoff, and update the item's row so later items of the same kind start
   there.

## 11. Questions and the end-of-session report

- Decisions are `D<n>` in PLAN, confirmed in the STATUS P0 checklist. ★ marks the ones that change what users see
  or what the numbers are.
- Ask at most four open questions at a time. Each has the recommended answer first, with the reason. Write answers
  that change the design into the repository the same day.

Every session's final message ends like this; leave out lines that would be empty:

```
Done: <IDs> handed off · Accepted: <IDs> · Left: <ID> partial / blocked / skipped: <one-line reason>
Verified: … · Not verified: … (and why)
Decided without asking: …
Questions (≤ 4): Q<n> …, recommended: … because …

Next: <plan>/<item or run>: <model>, effort <level>[, lane <x>, port <p>]
  git worktree add ../<repo>-<run> -b <plan-slug>/<run> <integration branch>     (worktree mode only)
  Open Claude Code in <folder> and say: "Do <plan>/<item or run>. Follow the workflow-run skill."
Blocked on you: <question or O-n>: unlocks <IDs>
Still running: <run> (lane <x>)
```

There's one Next block for every item or run that can start now. In a "you commit" project, the report also gives
a commit message.

## 12. Handoffs

`handoffs/<ID>-<agent>.md`, written from [`templates/handoff.md`](templates/handoff.md). Sections:
- Summary.
- Exit gate with evidence.
- Files changed.
- Contract as built.
- Deviations from the plan.
- Decisions taken.
- Known issues.
- Out-of-scope findings.
- Changes to earlier items.
- Lasting knowledge, and where it went.
- Next agent: start here.
- Review (filled in by the checker).

A plan may add its own sections (a screen inventory, SQL moved, logic changes for review, owner checks) by listing
them in PLAN "Items and runs".

## 13. Skills

| Skill | Level | Used when |
|---|---|---|
| `workflow-plan` | user | Asked to plan a feature, a roadmap item or a migration |
| `workflow-run` | user | Doing a plan's item or run |
| `workflow-close` | user | The plan's last item, or "close the plan" |
| `apple-design` | user | Any UI work. It reads the project's `docs/design-system.md` first, and that file wins. |
| domain skills | project | Knowledge only one project needs (ImPOS-Maui's `module-feature`), in `.claude/skills/<domain-name>/` |

Rules for writing a skill:
- The description puts the use case first.
- The body is a procedure, under 200 lines (it stays in context once loaded), and points here for formats.
- A personal skill **overrides** a project skill of the same name, so a shared skill is installed only once no
  project still has its own copy of it.

## 14. Closing a plan (`workflow-close`)

The last item of every plan verifies and closes it:
1. Check every item that isn't `accepted` yet, and run the plan's Verification.
2. Move lasting knowledge (from every handoff's "Lasting knowledge") to its permanent home: an ADR, `CLAUDE.md`,
   `docs/design-system.md`, the domain docs or code comments.
3. Put the follow-ups the owner wants into `docs/roadmap.md` "Found while building", as `**B-<n>**` items with the
   next free numbers.
4. Remove the roadmap item, update `docs/status.md`, and set the plan header to `verified`.
5. Delete the plan (file or folder), but **only if git already holds it**: `git ls-files docs/plans/<slug>` lists
   it, and `git status` shows no uncommitted changes in it.
   - Otherwise (usual in "you commit" projects) leave it `verified`, and add "Commit, then delete
     `docs/plans/<slug>/`" under "Waiting on you" in `docs/status.md`. The owner's commit keeps the plan in history.
   - The next session that finds a `verified` plan that git holds deletes it.
6. The close item writes no handoff: its report is the record.
7. Report (§11), with a commit message in "you commit" projects.

## 15. Adopting the standard in a project

The owner starts one run in the project: "Adopt the agent workflow standard. Follow the workflow-run skill, section
Adopting." The agent changes docs, `CLAUDE.md` and skills only, never code:

1. **Inventory first.** List every doc and plan, and map each one to §3. The map goes in the report (or the
   handoff, when a plan runs the migration) before anything moves.
2. **`CLAUDE.md`:** rewrite it into the §3.1 order, with the Workflow and Git lines. Keep every project-specific rule
   with the same meaning, and drop what `CLAUDE.user.md` already says.
3. **Homes:** create `docs/status.md`, `docs/roadmap.md` and `docs/checks.md` from what exists (the backlog,
   follow-ups, a browser checklist), then delete the old files. Fix the links that pointed at them.
4. **Plans:**
   - Convert active boards to §5 at the next item boundary, never while an item is `in-progress`, using the mapping
     below.
   - Finished plans: move their lasting knowledge into ADRs, then delete them.
5. **Skills:** remove copies of shared skills and move their project-specific rules into `docs/design-system.md`.
   Keep domain skills, in `.claude/skills/`.
6. **Check:** `node hud.mjs lint <repo>` is clean, or every line of [`conformance.md`](conformance.md) is ticked with
   evidence.

| Old | New |
|---|---|
| `Phase` / `Chunk` columns | `ID` and `Item` |
| "Waits for X" in Notes | `Depends on` |
| `done`, "Done, committed" | `accepted` |
| `in progress (date)` | `in-progress`, with the date in Since |
| `partial (…): text`, "Built…, uncommitted" | `partial` or `handed-off`, with the text in Notes |
| `verified` on a board | `accepted`, plus `verified` in the plan header |
| Plan header `draft` | `proposed`; decisions never ticked stay unticked in the P0 checklist |
| Plan header `planned` (decisions confirmed) | `approved yyyy-MM-dd` |
| Plan header `implemented`, or "all phases done" | a finished plan: ADRs, then deleted |
| backlog, follow-ups | `docs/roadmap.md`, keeping existing `B-<n>` IDs |
| browser checklist, owner checks | `docs/checks.md` |
| `_template/` folders | removed; the templates live in `~/.claude/workflow/templates/` |

## 16. Changing the standard

A change is a plan in this repository (`docs/plans/`) like any other.
- It bumps the version at the top of this file.
- It says in its Goal what projects have to change. A format change that would break boards already in use needs a
  migration item for each project.

## 17. What tools read

Tools read these, so their shape is fixed:
- **Plan files:** `docs/plans/<slug>.md` and `docs/plans/<slug>/STATUS.md`. A plan with no header line is not a
  plan.
- **Header line:** `Status: **<state>**` with an optional date.
- **Tables:** the `## Board` table with exactly the §5 header, and the `## Runs`, `## Branches` and `## Questions`
  tables.
- **Decisions:** the `## Decisions (P0)` checklist. An unticked box, or an unanswered question, shows as "needs you".
- **Project files:** the first section of `docs/status.md`, used as the project's headline; the `CLAUDE.md`
  Workflow and Git lines.

The HUD (`claude-hud/hud.mjs`) shows these files. Its `lint` command checks them against this file.
