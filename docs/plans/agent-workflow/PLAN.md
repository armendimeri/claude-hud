# Agent workflow standard: one way of working in every project

Status: **approved** 2026-10-29 · Written 2026-10-29 · Built in phases by separate agents that hand over through
[STATUS.md](STATUS.md) and [handoffs/](handoffs/). **Agents: start in STATUS.md, not here.**

## 1. Goal

Every project on this PC plans, runs, parallelises, documents and reports agent work the same way. Today that's
FidiaCRM, TourCMS, ImPOS-Maui and claude-hud; every new project follows the same way from day one.
- **Same files, same places, same sections.** An agent new to any project finds where it stands, what's next and
  the active board in at most three file reads.
- **One board format and one set of state words.** Any agent, and the HUD, can read any project's plans.
- **One protocol per session**, kept once in shared skills instead of copied into every STATUS.md.
- **One way to work in parallel**, one way to pick a model and effort, and one end-of-session report with
  ready-to-paste prompts for the next run.

The standard takes the best of what each project already does (§2) and makes it the default everywhere. It must
cost **fewer** tokens and fewer prompts from you than today, not more.

**Out of scope:**
- Each project's domain rules (stack, data, UI conventions). They stay in that project's `CLAUDE.md`.
- How you do git where you've already decided (W10 keeps that per project).
- Anything that needs a server, an API key or Claude usage to run.

## 2. What exists today (checked 2026-10-29)

| | WasteManagement2 | FidiaCRM | TourCMS | ImPOS-Maui |
|---|---|---|---|---|
| Where plans live | `docs/plans/<slug>/`: PLAN, STATUS, handoffs, copied from `_template/` | `Documentation/Implementation/`: master plan, one file per phase, one STATUS for all | `docs/plans/<name>.md`, one file per roadmap item | `docs/<topic>/`: PLAN, IMPLEMENTATION_PLAN, STATUS, HANDOFF, PLAN-1…5 |
| Unit of work | Phase `P<n>` | Chunk `P<phase>-<nn>` (also `UX-nn`) | Slice inside a plan (`E2`–`E4`) | Phase, informal |
| One session does | One phase, then stops | A run `R<n>`: several chunks in a row, no stopping | The whole approved plan | Whatever was asked |
| Board | `Phase \| Agent \| State \| Since \| Handoff \| Notes`; dependencies as "Waits for" in Notes | `Chunk \| Title \| Depends on \| Model / effort \| Status \| Handoff` per phase, plus Runs, Branches and Owner inputs tables | None (state line in the plan) | `Phase \| State`, free text |
| State words | todo, in-progress, handed-off, accepted, bounced, blocked, verified | todo, in progress (date), done, partial, blocked | proposed, approved, building | "Done, committed (`307e784`)." |
| Who checks the work | The next agent re-runs the previous exit gate (accept / bounce) | Build and tests per chunk; owner checks per phase | You test the UI | You |
| Parallel work | Phases side by side in one working tree, disjoint files, own ports | Lanes A/B (+ C side), a worktree and branch per run, fast-forward merge to `web/dev` after each chunk, waiting by polling | None | None |
| Git | Agents don't commit unless asked | Agents commit and merge (one commit per chunk) | You do all git | Only when you ask |
| Where the project stands | Per plan only | The STATUS board | `docs/status.md`, rewritten every session, the only place | `docs/<topic>/STATUS.md` narratives |
| Upcoming work | `docs/follow-ups.md` | Phase files | `docs/roadmap.md` | `docs/BACKLOG.md` (`B-<n>`, 840 lines) |
| Decisions | P0 checklist `D1…` with ★ | Master plan §2 table | "Rules decided by default" in the plan, then ADRs | Plan asks every question before code |
| Questions to you | Questions table, phase `blocked` | Handoff "Open questions", owner inputs `O-n` | At most 4, recommended answer first | Before code |
| Model / effort | Kickoff table per phase | Per chunk and per run, with an escalation rule | — | — |
| Report at the end | Handoff file | Handoff per chunk and a **Next** block with paste-ready prompts | One report and a commit message | "Say what you verified and what you didn't" |
| Skills | — (empty `docs/skills/`) | `apple-design`, adapted copy | `apple-design` in `docs/skills/`, so never loaded | `apple-design`, `module-feature` |
| Lasting knowledge | Moved to CLAUDE.md / design-system; plan folder deleted | Handoffs kept | ADR; plan file deleted | Docs kept |

**Worth keeping, by project:**
- **WasteManagement2:** decisions confirmed before code (P0); exit gates with evidence; the next agent accepts or
  bounces; a handoff with "Lasting knowledge"; the plan deleted once verified.
- **FidiaCRM:**
  - runs, so one prompt does many small items;
  - model and effort per item, with an escalation rule;
  - lanes with worktrees, plus rules for files several items touch;
  - waiting for another run by polling;
  - owner inputs as dependencies;
  - the Next block with paste-ready prompts.
- **TourCMS:** one status file, rewritten rather than appended to; one home per fact; ADRs; at most four
  questions, each with the recommended answer first; sensible defaults decided and reported; "say which pages were
  not opened".
- **ImPOS-Maui:** domain skills (`module-feature`); safety rules up front; "say what you verified and what you didn't".

**What costs today:**
- The protocol (about 60 lines) is copied into every STATUS.md and drifts, so kickoff prompts are long.
- Four board formats: no agent can read another project's state without learning its format, and the HUD needs a
  parser for each.
- State cells mix the state, a date and a reason ("partial (2026-10-21): P0-14 done apart from the owner's review").
- Five names for upcoming work: follow-ups, phase files, roadmap, backlog, handoff "next".
- `apple-design` exists three times, and the copies already differ.
- There is no `~/.claude/CLAUDE.md`, so rules that hold everywhere (git, secrets, reporting) are restated per
  project, each time a little differently.

## 3. Decisions

Proposed defaults, confirmed in STATUS.md (P0) before P1 starts. ★ = changes what you see or do.

| # | Topic | Proposal | Why |
|---|---|---|---|
| W1 ★ | Home of the standard | This repo, folder `workflow/`: the spec (`STANDARD.md`), the templates and the skills. Changing the standard means a plan here, like any other change. | One source; today it lives in four places and drifts. |
| W2 ★ | Shared rules and skills at user level, linked to this repo | `~/.claude/CLAUDE.md` gets one `@import` of `workflow/CLAUDE.user.md` (the rules that hold in every project). The skills are linked into `~/.claude/skills/` with directory junctions (no admin rights needed), not copied. `node workflow/kit.mjs install` / `uninstall`: backup first, safe to repeat, and uninstall leaves `~/.claude` exactly as it was. | Every project and every worktree gets the same rules and skills, with no copies. Editing them here updates everything. |
| W3 ★ | Project files | §4.2, the same in every repo. Renames: ImPOS `BACKLOG.md` → `docs/roadmap.md`; TourCMS `browser-checklist.md` → `docs/checks.md`; FidiaCRM `Documentation/` → `docs/` (with its links fixed). | The same fact in the same place everywhere. |
| W4 ★ | Two plan sizes, one shape | **Small plan**: one file, one agent, one run (TourCMS-sized). **Phased plan**: a folder with PLAN, STATUS and handoffs (WasteManagement2- and FidiaCRM-sized). Both have the same sections and a Board. | Small work doesn't need three files; big work does. |
| W5 ★ | One board format | §4.5: fixed columns, IDs, a real "Depends on" column, a one-word State; an optional Runs table. | Any agent and the HUD can read it, with no prose to parse. |
| W6 ★ | One set of state words | §4.6. FidiaCRM's `done` becomes `accepted`; `verified` is used only in the plan's header line. | One meaning per word. |
| W7 ★ | Work is checked by a different agent | The author sets an item `handed-off`. Only another agent sets it `accepted`: the next agent that depends on it, or the plan's verify item. Inside a multi-item run, the same agent's later items don't count. | Keeps WasteManagement2's quality check, at the cost of one gate re-run, not a review session. |
| W8 ★ | Sessions and runs | One run per session. A run is one item unless the plan groups small sequential items into it. The agent doesn't stop between the items of its run. | Fewer prompts for small items (FidiaCRM), clean handovers for big ones (WasteManagement2). |
| W9 ★ | Parallel work | Lanes A and B for code, C for docs and tests only. At most two code lanes at once, never two runs in one lane. Two modes, chosen per project: **shared tree** (default; parallel only with disjoint files; no agent commits) or **worktrees** (opt-in; a branch per run; fast-forward merge after each item). Each lane gets its own port, listed in CLAUDE.md. | Fits each project's git choice without needing two standards. |
| W10 | Git stays per project | CLAUDE.md says which mode applies: `you commit` (TourCMS, ImPOS-Maui, claude-hud, and new projects by default) or `agents commit per item` (FidiaCRM, worktree mode). | You've already decided this per project. |
| W11 | Model and effort per item | The §4.9 role table and escalation rule, recorded in the Board column. A run uses the strongest setting any of its items needs. | The cheapest setting that gets the item right the first time. |
| W12 ★ | Questions and the end-of-session report | At most four open questions, each with the recommended answer first. Sensible defaults are decided and reported, not asked. Every project ends a session with the same report (§4.10), finishing with paste-ready Next prompts. | One habit, so you read every project's report the same way. |
| W13 | One status file per project | `docs/status.md`, rewritten (not added to) at the end of every session. A plan's STATUS.md stays per plan. | One place says where a project stands. |
| W14 | HUD support | The HUD reads this standard, plus the old formats until a project is migrated. `node hud.mjs lint <repo>` checks a repo against §4. Unticked decisions and unanswered questions show as "needs you". | Instant visibility; lint stops projects drifting apart again. |
| W15 ★ | Rollout order | TourCMS, ImPOS-Maui and claude-hud in parallel, straight after P1 (no pilot; changed 2026-10-29). FidiaCRM goes last, after its running runs (R15–R17) end. Never during an item that's `in-progress`. | Lowest risk first, and nothing running is disturbed. |
| W16 ★ | One shared design skill | One `apple-design` at user level. Project tokens and overrides live in that project's `docs/design-system.md`, which the skill reads first and which wins. FidiaCRM's section 0 rules move into its design-system.md. | The three copies have already diverged. |

## 4. The standard (the contract P1 writes up in full)

### 4.1 Three layers

| Layer | Lives in | Holds |
|---|---|---|
| User | `~/.claude/`, linked to `workflow/` in this repo (W2) | `CLAUDE.md`: shared rules (git default, secrets, questions, report, never stop your running apps). Skills: `workflow-plan`, `workflow-run`, `workflow-close` and `apple-design`. |
| Project | each repo | `CLAUDE.md` (project rules), README, `docs/` (§4.2), project-only skills in `.claude/skills/`. |
| Plan | `docs/plans/` | One small plan file, or one phased plan folder, per piece of work. Deleted once verified. |

### 4.2 Project files

```
<repo>/
├── CLAUDE.md                 rules for agents, fixed sections (§4.3); never the status
├── README.md                 for people: what it is, how to run it
├── .claude/skills/<name>/    skills only this project needs (domain), if any
└── docs/
    ├── status.md             where the work stands; rewritten at the end of every session; the only place
    ├── roadmap.md            upcoming work in your order: B-<n> items with a state and a plan link;
    │                         sections Next, Later, On hold, Found while building
    ├── checks.md             what only you can check by hand (browser, devices, production), by area
    ├── design-system.md      UI projects: tokens, components, the rules that override the design skill
    ├── adr/NNNN-<title>.md   decisions that outlive a plan
    └── plans/
        ├── <slug>.md         a small plan
        └── <slug>/           a phased plan: PLAN.md, STATUS.md, handoffs/<ID>-<agent>.md
```

`docs/status.md` sections, in order:
1. The project in one paragraph.
2. Where things stand: git, build, tests with real numbers, what's been opened in a browser, databases and the
   newest script.
3. Active plans, with links.
4. What's next.
5. Waiting on you.
6. The last session.

### 4.3 CLAUDE.md sections, in a fixed order

1. **What this is**, in five lines at most, and **Start here**: `docs/status.md` → this file → `docs/roadmap.md` →
   the plan you were given.
2. **Working with the owner:** the git mode (W10), how they test, project-specific requests (dated).
3. **Build, run, test:** commands and the port for each lane.
4. **Parallel work:** the shared files and the rule for each (as in FidiaCRM README §8), and the integration
   branch in worktree mode.
5. **Rules:** domain conventions.
6. **Safety:** databases, secrets, what never to touch.
7. **Pitfalls already hit.**

Nothing that `~/.claude/CLAUDE.md` already says is repeated here.

### 4.4 Plans

The header line is the same for both sizes:
`Status: **proposed** | **approved** yyyy-MM-dd | **building** | **verified** · Written yyyy-MM-dd · Checked against the code yyyy-MM-dd`.

- **Small plan** (`docs/plans/<slug>.md`). Sections:
  - Goal.
  - What exists and is reused (real names, checked in the code).
  - Decisions: defaults, "say if one is wrong".
  - Items, each with its scope and exit gate.
  - Board.
  - Left out on purpose.
  - Tests.

  There is no STATUS file and there are no handoff files: the end-of-session report and `docs/status.md` cover it.
- **Phased plan** (`docs/plans/<slug>/`):
  - **`PLAN.md`:** Goal; What exists; Decisions (`D<n>`, ★); Contract between items; one section per item's work;
    Items and runs (scope, gate, model and effort); Verification; Follow-ups.
  - **`STATUS.md`:** Board; Runs (when needed); Decisions (the P0 checklist); Questions; Log; Kickoff. It does
    **not** copy the protocol. One line points to the `workflow-run` skill, followed by the plan's own "Always"
    rules (ports, files never to touch).
  - **`handoffs/<ID>-<agent>.md`:** one per finished item (§4.11).

### 4.5 The board, one format everywhere

```
## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | accepted | 2026-10-29 | — | |
| P1 | Data and history | `data` | P0 | Opus 5.5 / high | in-progress | 2026-10-29 | | port 5098 |
| P2 | History tab | `history-ui` | P1 | Sonnet 5.5 / high | todo | | | lane A |
| O-1 | Sample quotations | owner | — | — | todo | | | unlocks P3 |
```

- **ID:** `P<n>`, or `P<n>-<nn>` for items inside a phase. Owner inputs are `O-<n>` rows in the same board, with
  agent `owner`. An existing prefix (FidiaCRM's `UX-nn`) may stay. IDs are unique within a plan and never reused.
- **Depends on:** IDs, comma-separated; ranges as `P3-01–P3-05`; another plan as `<slug>/<ID>`; `—` for none.
  Dependencies never go in Notes.
- **State:** one word from §4.6. A date goes in Since; a reason goes in Notes or the handoff.
- **Model / effort:** for example `Sonnet 5.5 / high` (§4.9).
- **Runs** (only when a run holds more than one item, or lanes are used):

  ```
  ## Runs

  | Run | Items, in order | Model / effort | Lane | Start when | State |
  |---|---|---|---|---|---|
  | R1 | P1-01 → P1-02 → P1-03 | Sonnet 5.5 / medium | A | P0 | in-progress |
  ```
- **Questions:** `| # | Item | Question | Recommended | Answer |`. A row with an empty Answer is waiting on you.

### 4.6 States

| State | Meaning | Set by |
|---|---|---|
| `todo` | Not started | the planner |
| `in-progress` | An agent has it | that agent, when it claims it |
| `blocked` | Needs a person; there's a row under Questions | the agent |
| `partial` | Stopped with part of the gate met; the handoff says what's left | the agent |
| `handed-off` | Gate proven with evidence; handoff written | the agent |
| `accepted` | Checked by a different agent (W7) | the checker |
| `bounced` | The check failed; the item goes back to its owner | the checker |

The plan's header line moves `proposed` → `approved` → `building` → `verified`, and the plan is deleted once it's
verified.

Migration mapping:
- FidiaCRM: `done` → `accepted`; `in progress (date)` → `in-progress` with the date in Since; `partial (…): text` →
  `partial`, with the text moved to Notes.
- ImPOS-Maui: "Done, committed" → `accepted`; "Built…, uncommitted" → `handed-off`.

### 4.7 Sessions, runs and the protocol (`workflow-run`)

- A session does one run. A run does each of its items in order:
  1. Orient: STATUS, CLAUDE.md, the PLAN sections the item lists, and the handoffs of its dependencies.
  2. Check the dependencies' gates: accept or bounce.
  3. Claim the item.
  4. Work within its scope.
  5. Prove the exit gate.
  6. Write the handoff.
  7. Update the board and log.
  8. Go on to the next item, or report.
- An item that can't go on is set `blocked`, and the run carries on with its items that don't depend on it.
- At the end of the session: rewrite `docs/status.md` (including "The last session"), then report (§4.10).
- A run that stopped part-way is resumed with "continue run `R<n>`": check `git status` and the board, finish the
  item that's `in-progress`, then carry on.

### 4.8 Parallel work

- **Lanes:** A and B for code, C for docs and tests only. At most two code lanes at once, and never two runs in one
  lane. Each lane runs the app on its own port; the project's base port plus the lane is listed in CLAUDE.md.
- **Shared tree mode** (default): one working folder. Items run in parallel only if the plan says their file
  scopes don't overlap. Agents don't commit.
- **Worktree mode** (opt-in, FidiaCRM today): a branch `<plan>/<run>` per run, made from the integration branch in
  its own worktree. After each item, merge into the integration branch fast-forward only. Every open branch is
  listed in a Branches table on the board.
- **Shared files:** CLAUDE.md §4 lists the files several items touch, and the rule for each (append-only
  registration, partial classes, the item's own resource files). A conflict outside those rules means stop and set
  the item `blocked`.
- **Waiting for another run:** poll the board every 10 minutes for up to 8 hours, as a background command (waiting
  costs nothing). Skip what can't start.
- **STATUS edits:** only your own rows, and appended log lines.

### 4.9 Model and effort

| Model | Use for |
|---|---|
| Haiku 5.5 | Mechanical work: copying, installing, docs that list what the code already says |
| Sonnet 5.5 | **Default:** CRUD pages, lists, dialogs, most UI and migrations of docs |
| Opus 5.5 | Rules that must be exact or are hard to test: auth, money, numbering, documents, status flows, shared abstractions, plans themselves |
| Fable 5.1 | Not planned; the last escalation step only |

Effort levels:
- `low`: mechanical work.
- `medium`: normal work.
- `high`: many rules or tricky state.
- `xhigh`: exact output that's hard to verify.

**Escalation:** after a wrong result, or two failed builds on the same problem, set the item `partial`. The report
proposes a redo one step up: effort first, then model. Update the item's row so later items of the same kind start
there.

### 4.10 Questions and the end-of-session report

- Decisions are `D<n>` in PLAN, confirmed in STATUS's P0 checklist; ★ marks the ones that change what users see or
  what the numbers are.
- At most four open questions. Each has the recommended answer first, with the reason. A gap with a sensible
  default is decided and reported, not asked. Answers that change the design are written into the repo the same day.
- Every session's final message, in this order:

  ```
  Done: <items> handed off · Accepted: <items> · Left: <item> partial / blocked: <one-line reason>
  Verified: … · Not verified: … (why)
  Decided without asking: …
  Questions (≤ 4): Q<n> …, recommended: … because …

  Next: <run or item>: <model>, effort <level>[, lane <x>, port <p>]
    [git worktree add … ]          (worktree mode only)
    Open Claude Code in <folder> and say: "Do <plan>/<run or item>. Follow the workflow-run skill."
  Still running: <run> (lane <x>)
  ```

### 4.11 Handoffs

There's one handoff per item, at `handoffs/<ID>-<agent>.md`. Sections:
- Summary.
- Exit gate with evidence.
- Files changed.
- Contract as built.
- Deviations.
- Decisions taken.
- Known issues.
- Out-of-scope findings.
- Lasting knowledge, and where it went.
- Next agent: start here.
- Review (filled in by the checker).

A plan may add its own sections, for example FidiaCRM's screen inventory, SQL moved, logic changes for review and
owner checks.

### 4.12 Closing a plan (`workflow-close`)

The last item:
1. Verifies everything that isn't yet `accepted`.
2. Moves lasting knowledge to its permanent home: an ADR, CLAUDE.md, `docs/design-system.md` or code comments.
3. Removes the item from the roadmap, updates `docs/status.md`, and deletes the plan in the same change.
4. Proposes a commit message when the project's git mode is `you commit`.

### 4.13 Skills

| Skill | Level | Used when |
|---|---|---|
| `workflow-plan` | user | Asked to plan a feature or a roadmap item. Researches, writes a small or phased plan with decisions, items, gates and model/effort, and stops for P0. Ships the templates. |
| `workflow-run` | user | Started on a plan's item or run: the §4.7 protocol, parallel rules, waiting, escalation, the report. |
| `workflow-close` | user | The plan's last item, or "close the plan": §4.12. |
| `apple-design` | user | Any UI work. Reads the project's `docs/design-system.md` first; that file wins (W16). |
| domain skills | project | For example ImPOS-Maui's `module-feature`. Named after the domain, in `.claude/skills/`. |

Skills say each rule once and link to `workflow/STANDARD.md`, not restate it. Each body stays short, because it's
loaded every time it's invoked.

### 4.14 What the HUD reads (W14)

The HUD reads:
- every plan's Board and Runs;
- the plan's header state;
- unticked P0 decisions and unanswered questions, which show as "needs you" at plan level;
- the first section of `docs/status.md`, as the project's one-line headline.

`node hud.mjs lint <repo>` reports every place a repo differs from §4. The old formats (§2) keep working until a
project is migrated.

## 5. Rollout

### 5.1 Migrating one project (one run, done in that project)

The agent works in the target repo and changes docs only, never code.
1. Inventory the project's docs and plans, and map each one to §4.2. Write the map into the handoff before moving
   anything.
2. Rewrite `CLAUDE.md` into the §4.3 order, and drop what `~/.claude/CLAUDE.md` now covers. Keep every
   project-specific rule, unchanged in meaning.
3. Create `docs/status.md` from the current status files, `docs/roadmap.md` from the backlog / roadmap /
   follow-ups, and `docs/checks.md` from the browser checklist or owner checks. One home per fact: delete the old
   copies.
4. Active plans: convert the board at the next item boundary, never while an item is `in-progress`. Finished
   plans: move their lasting knowledge into ADRs, then delete them.
5. Remove copies of shared skills; move their project-specific rules into `docs/design-system.md`. Keep domain
   skills.
6. Run `node hud.mjs lint <repo>` until it's clean (or tick `workflow/conformance.md` by hand if lint doesn't
   exist yet).
7. Report in the §4.10 format. Use the project's git mode, and never copy a secret.

### 5.2 Order and per-project notes

| Order | Project | Notes |
|---|---|---|
| 1 (parallel) | TourCMS | `status.md` already matches. Single-file plans become small plans with a Board; `browser-checklist.md` → `checks.md`; `docs/skills/apple-design` removed (W16). |
| 1 (parallel) | ImPOS-Maui | `BACKLOG.md` → `roadmap.md`, keeping the `B-<n>` IDs. Active topics (phone-app phase 7, stock, fiscal reports) become plans; finished ones (subscriptions) become ADRs plus `status.md`. |
| 1 (parallel) | claude-hud | `docs/plan/` → `docs/plans/claude-hud/` at an item boundary; this plan already follows the standard's shape. |
| 2 | FidiaCRM | The biggest. Run R16 is `in-progress`, and R15, R17 and R11 are `todo`: migrate only when no run is going (O-1). README §1 and §6–8 are replaced by the skills plus CLAUDE.md "Parallel work"; phase files become plans; `UX-nn` IDs stay; `Documentation/` → `docs/` (W3). |

## 6. Items and agents

| # | Agent | Scope | Size |
|---|---|---|---|
| P0 | human | The decisions in STATUS.md | — |
| P1 | `standard` | `workflow/` in this repo: STANDARD.md, `CLAUDE.user.md`, templates, the three workflow skills and the merged `apple-design`, `conformance.md`, `kit.mjs`; this plan's own files | L |
| P3-01 … P3-04 | `migrate` | One repo each: TourCMS, ImPOS-Maui, claude-hud, FidiaCRM. Docs only, plus fixes to `workflow/` the migration shows are needed. | M each |
| P4 | `review` | Conformance across all four repos, standard v1.0, closing this plan | M |

There is no P2: the pilot was removed from this plan on 2026-10-29 (see STATUS log), and the ID isn't reused.
Agents for P3 run in the target repo, change nothing in it but docs, CLAUDE.md and skills, and write their
handoff into this folder (`handoffs/`). The kickoff prompts in STATUS.md give the full paths.

**P1 exit gate:**
- [ ] `workflow/STANDARD.md` covers all of §4 and states each rule once. The skills and templates link to it
      rather than restate it.
- [ ] Templates exist for: small plan, PLAN, STATUS, handoff, `status.md`, `roadmap.md`, `checks.md`, project
      `CLAUDE.md` and an ADR. Each template passes `conformance.md`.
- [ ] `workflow-plan`, `workflow-run` and `workflow-close` are written, each body under 200 lines;
      `apple-design` is merged from the three copies, with FidiaCRM's rules marked for its design-system.md.
- [ ] `node workflow/kit.mjs install` then `install` again: one set of links, `~/.claude/CLAUDE.md` changed only
      by the import line, and a backup written. `uninstall`: `~/.claude` is identical to before (a diff of
      listings and file hashes).
- [ ] Dry run in a scratch repo under `%TEMP%`, never in one of your projects: a fresh session plans a two-item
      feature with `workflow-plan`, and two further sessions build it with `workflow-run`. Boards, handoffs and
      reports match the standard. Input tokens per session are recorded next to a phase run with
      today's protocol, as evidence that it costs less.
- [ ] This plan's STATUS.md and the HUD's STATUS.md use the §4.5 board.

**P3-xx exit gate (each):**
- [ ] §5.1 is done; no code changed; in-flight work untouched; lint clean, or `conformance.md` ticked with
      evidence.

**P4 exit gate:**
- [ ] In each of the four repos, a fresh agent answers "where does this project stand, what's next, what's
      waiting on me?" from the same three files.
- [ ] Kickoff prompts are two lines or fewer everywhere.
- [ ] The HUD shows every project's plans with no old-format warnings.
- [ ] STANDARD.md is marked v1.0; lasting knowledge has moved into `workflow/`; this plan folder is deleted.

## 7. Follow-ups (not in this plan)

- A shared baseline of allowed commands (`settings.local.json` differs per project today).
- Cloud sessions (claude.ai/code) don't see user-level skills. If you start using them, vendor the skills into each
  repo with the same kit.
- A `/plan` slash command that starts `workflow-plan` with the right template.
