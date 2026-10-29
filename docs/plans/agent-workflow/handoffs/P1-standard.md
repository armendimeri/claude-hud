# P1 `standard` handoff

**Date:** 2026-10-29 · **State:** handed-off · **Model / effort used:** Opus 5.5 / high · **Next:** P3-01–P3-04 `migrate`

## Summary

The standard exists and works. `workflow/` in claude-hud holds:
- STANDARD.md (v0.9) and the shared rules;
- three workflow skills, plus a merged `apple-design`;
- nine templates and a conformance checklist;
- a kit that links it all into `~/.claude/` and removes it cleanly.

A dry run with three real Claude Code sessions planned, built and closed a two-item feature in a scratch repository
using only the skills. The kit is **not installed** at the end of P1: the owner installs it before P3 (Q1).

## Exit gate

- [x] **`workflow/STANDARD.md` covers all of PLAN §4.** Where each part went:

  | PLAN | STANDARD |
  |---|---|
  | §4.1 | §2 |
  | §4.2 | §3 and §3.2–3.5 |
  | §4.3 | §3.1 |
  | §4.4 | §4 |
  | §4.5 | §5 |
  | §4.6 | §6 |
  | §4.7 | §7, §8 |
  | §4.8 | §9 |
  | §4.9 | §10 |
  | §4.10 | §11 |
  | §4.11 | §12 |
  | §4.12 | §14 |
  | §4.13 | §13 |
  | §4.14 | §17 |
  | §5.1 | §15 |

  Formats live only in STANDARD.md and the templates. Each skill opens with
  `Formats: ~/.claude/workflow/STANDARD.md (§n)` and cites sections rather than restating formats. The skills do
  restate the *steps* of the protocol in short procedure form, because that's their job.
- [x] **Templates.** All nine exist:
  - plans: `templates/PLAN.md`, `STATUS.md`, `handoff.md`, `plan-small.md`;
  - project: `templates/project/CLAUDE.md`, `status.md`, `roadmap.md`, `checks.md`, `adr.md`.

  I copied the plan templates into a fake repository and ran the board checker on them:
  `{"plans":["docs\\plans\\phased\\STATUS.md","docs\\plans\\small.md"],"problems":[]}`. The project templates'
  headings match §3.1–§3.5 in order (checked with grep).
- [x] **Skills.**
  - Line counts: `workflow-plan` 82, `workflow-run` 65 (plus `parallel.md` and `adopting.md`, loaded only when
    needed), `workflow-close` 45. All are under 200.
  - `apple-design` is merged (318 lines). It's built from the ImPOS-Maui copy, the newest one: the ImPOS-only parts
    are generalised, and a "project's design system first, and it wins" section is added.
  - The ImPOS-Maui and FidiaCRM specifics are written out for P3-02 and P3-04 in
    [../design-rules-to-move.md](../design-rules-to-move.md).
- [x] **Kit.**
  - **Sandbox homes** (`CLAUDE_KIT_HOME`): five cases. No `CLAUDE.md`; one ending in a newline; one without a
    newline; an empty one; and `install apple-design`. Each was installed twice and then uninstalled. The second
    install always printed "Already installed: nothing changed." After uninstall, every case was **identical** to
    before (snapshot of `CLAUDE.md` hash and the link list). Backups were written in the cases with an existing
    `CLAUDE.md`. A folder already at `skills/workflow-run` made install refuse (exit 1) and change nothing.
  - **Your real `~/.claude`:**
    - Install wrote 4 junctions plus a `~/.claude/CLAUDE.md` holding only the import block.
    - Install again: "Already installed: nothing changed."
    - Uninstall: "IDENTICAL to before". There was no `CLAUDE.md` before, so there was nothing to back up.
    - After the dry run I uninstalled again: identical to the very first snapshot.
- [ ] **Dry run, cost part only.** The dry run itself passed: a scratch repository under this session's `%TEMP%`
  scratchpad (`textstats`, a 20-line Node CLI, git, "you commit"), three `claude -p` sessions on Sonnet 5.5, kit
  installed.

  | Session | Prompt | Turns | Cost | Time | First-turn context | Result |
  |---|---|---|---|---|---|---|
  | Planner | "Plan roadmap item B-1 … Use the workflow-plan skill." | 26 | $0.60 | 251 s | 40,467 | Phased plan `top-words-json`: P0 with D1–D5 ★, Always, Kickoff. Board checker clean. Stopped for P0. |
  | P1 | "Do top-words-json/P1. Follow the workflow-run skill." | 27 | $0.34 | 114 s | 38,561 | Built `--top`; tests 2 → 10 pass; handoff from the template; board `handed-off` with link; log; `status.md` rewritten; report with Next prompt and commit message. |
  | P2 | "Do top-words-json/P2. Follow the workflow-run skill." | 41 | $0.42 | 132 s | 40,286 | Accepted P1 by re-running its gate; built `--json`; 14 of 14 tests; plan verification; lasting knowledge → `CLAUDE.md`; roadmap and status updated; plan deleted; report and commit message. |

  **Cost against today:** the only WasteManagement2 phase session on this PC (`f5bc8c25`, the P1 session you
  stopped) had a first-turn context of 44,601 tokens. About 37K of every first turn is Claude Code's own system
  prompt and tools. The protocol text an agent reads:

  | | Today | Standard |
  |---|---|---|
  | Protocol | 4,043 B in every STATUS.md | `workflow-run` 3,855 B + `CLAUDE.user.md` 1,686 B |
  | Kickoff | 458 B | 74 B |

  That's about +300 tokens per session. It is **not measurably cheaper per session; it's about the same**, so I've
  left this part of the box unticked. The savings are elsewhere:
  - one protocol instead of a copy per plan (STATUS.md is 2.4 KB instead of 10 KB);
  - 2-line kickoffs;
  - runs, which save your prompts;
  - the shared rules replace text every project's `CLAUDE.md` repeats today.
- [x] **Boards.**
  - This plan's STATUS.md and the HUD's `docs/plan/STATUS.md` use the §5 board.
  - Running [boardcheck.mjs](../boardcheck.mjs) on claude-hud reports one problem only: this plan's STATUS "copies
    the protocol". That's deliberate (see Deviations).
  - The HUD board lives in `docs/plan/`, outside `docs/plans/`, so I checked it by eye: the header is exact and
    every Questions row has five cells.

## Files changed

| File | New / changed | What |
|---|---|---|
| `workflow/STANDARD.md` | new | The standard, v0.9 |
| `workflow/CLAUDE.user.md` | new | Rules for every project, imported into `~/.claude/CLAUDE.md` |
| `workflow/README.md` | new | What the folder is, install / remove, adoption prompt |
| `workflow/conformance.md` | new | The checklist; lines marked [lint] are for `hud.mjs lint` |
| `workflow/kit.mjs` | new | `install [apple-design]` / `uninstall` / `status` |
| `workflow/skills/workflow-plan/SKILL.md` | new | Planning procedure |
| `workflow/skills/workflow-run/SKILL.md`, `parallel.md`, `adopting.md` | new | Item / run procedure; lanes, worktrees and waiting; adopting a project |
| `workflow/skills/workflow-close/SKILL.md` | new | Verify and close |
| `workflow/skills/apple-design/SKILL.md` | new | Merged, generic design skill |
| `workflow/templates/*`, `workflow/templates/project/*` | new | Nine templates |
| `docs/plans/agent-workflow/design-rules-to-move.md` | new | ImPOS-Maui / FidiaCRM design specifics for P3-02 and P3-04 |
| `docs/plans/agent-workflow/boardcheck.mjs` | new | The dry run's board checker, the starting point for `hud.mjs lint` |
| `docs/plans/agent-workflow/STATUS.md`, `PLAN.md` | changed | P0 accepted, P1 board and log; PLAN header `approved` only |
| `docs/plan/STATUS.md` | changed | HUD board and Questions table in §5 columns; P1 notes |

Outside the repository:
- `~/.claude` was installed and uninstalled during the tests, and is identical at the end.
- The scratch dry-run repository is in this session's scratchpad.
- Claude Code wrote the three dry-run session transcripts to `~/.claude/projects/<scratch-path slug>/`.

## Deviations from the plan

- **`~/.claude/workflow` is a junction to `workflow/`.** PLAN didn't name it. It gives the skills, templates and the
  import one stable path (`~/.claude/workflow/...`) on any PC.
- **`apple-design` is built but not linked by default.** Claude Code's rule is "personal over project" for skills of
  the same name, so a user-level copy would immediately override ImPOS-Maui's and FidiaCRM's own copies, including
  run R16 going in FidiaCRM now. `kit.mjs install apple-design` links it. Do that after P3-02 and P3-04 have removed
  the project copies (P4 at the latest).
- **Templates live in `workflow/templates/`** rather than inside `workflow-plan`, so every skill and a person can find
  them in one place.
- **`workflow-run` is split** into a short `SKILL.md` plus two files loaded only when needed. That roughly halved its
  cost per session.
- **Adopting a project** is STANDARD §15 plus `workflow-run/adopting.md`, triggered by "Adopt the agent workflow
  standard". There's no fourth skill.
- **The kit is uninstalled at the end of P1.** The standard goes live with the pilot (W15). P2 runs
  `kit.mjs install` first.
- **This plan's own STATUS.md keeps its protocol.** Its P2–P4 agents work across repositories, which `workflow-run`
  doesn't cover. P3-03 converts it when claude-hud migrates.
- **Fixes made after the dry run:**
  - In "you commit" projects a closed plan is deleted only once git holds it. The dry run's P2 deleted a plan that
    was never committed, so its board and handoffs were lost. The plan now stays `verified`, with "Commit, then
    delete" under Waiting on you.
  - Follow-ups go to the roadmap as `B-<n>` items.
  - Lint isn't put into gates until it exists.

## Decisions taken

- `CLAUDE.user.md` says "where a project's CLAUDE.md or the owner says otherwise, they win". Claude Code
  concatenates user and project memory without any precedence (memory docs), so the rule has to say it itself.
- The skill descriptions say "in a repository whose CLAUDE.md says it follows the standard", so unmigrated
  projects, FidiaCRM's running work included, never trigger them.
- `CLAUDE_KIT_HOME` points the kit at a sandbox home, and is used for tests only.

## Known issues

- **`hud.mjs lint` doesn't exist yet.** It belongs to the HUD's P1 (W14). Until then, migrations tick
  `conformance.md` by hand.
- **Open sessions don't load the shared rules.** `~/.claude/CLAUDE.md` is read when a session starts. Skills, by
  contrast, appear live: this session saw them seconds after install.
- **Cloud sessions** (claude.ai/code) don't see user-level skills (PLAN §7 follow-up).
- **Dry-run sessions in the HUD:** the three dry-run transcripts will show in the HUD as recently ended sessions for
  two hours.

## Out-of-scope findings

- Node 22 rejects `node --test <folder>`; use `node --test`. That's only relevant to projects that copy the dry run's
  command.

## Changes to earlier items

None.

## Lasting knowledge

- **Same-name skills:** a personal skill overrides a project skill of the same name. Recorded in STANDARD §13 and in
  the kit's comments.
- **User-level imports and junctions:** imports in `~/.claude/CLAUDE.md` load without a dialog, and a skill folder
  may be a symlink or junction. Recorded in STANDARD §2 and `workflow/README.md`.
- **Deleting closed plans:** never delete a plan git doesn't hold. Recorded in STANDARD §14 and `workflow-close`.
- **Token costs:** these go into P4's write-up for STANDARD v1.0.
  - About 37K tokens of every first turn are Claude Code's own.
  - The standard's protocol share is about 1.4K tokens.
  - A trivial item costs $0.34–$0.60 on Sonnet 5.5.

## Next agent: start here

*Updated 2026-10-29: the user removed the WasteManagement2 pilot (P2) from this plan. The next items are
P3-01–P3-04.*

**P3 `migrate`, in each target repo** (model and effort on the board):
1. The owner installs the kit first: `node C:/Users/armen/source/repos/armendimeri/claude-hud/workflow/kit.mjs install`
   (not `apple-design`), then `kit.mjs status` to check it (Q1).
2. Say: "Adopt the agent workflow standard. Follow the workflow-run skill, section Adopting." Read
   `workflow-run/adopting.md` and STANDARD §15. The specifics for each project are in PLAN §5.2.
3. Every fix to the standard that the migration shows is needed goes into `workflow/` in claude-hud, and is listed
   in the handoff.

**HUD P1 can resume in parallel.** It's a different repository, and its files don't overlap with the migrations'
(they may edit `workflow/`; the HUD edits `hud.mjs`). It needs to:
- read §5 boards (PLAN header, `## Board`, `## Runs`, `## Questions`, `## Decisions (P0)`);
- add `node hud.mjs lint <repo>`, starting from [boardcheck.mjs](../boardcheck.mjs) and the [lint] lines of
  `conformance.md`.

## Review

**Accepted** 2026-10-29, by the agent of the since-removed P2. What I re-ran:
- Templates: `plan-small.md`, `PLAN.md` and `STATUS.md` copied into a fake repo, then `boardcheck.mjs` →
  `"problems": []`. Project template headings match STANDARD §3.1–§3.5 in order (`grep -n '^## '`).
- Skills: `wc -l`. `workflow-run` 65, `workflow-plan` 83, `workflow-close` 49, all under 200.
- Kit: in a sandbox home (`CLAUDE_KIT_HOME`, existing `CLAUDE.md`), `install` linked 4 junctions and added the
  import block. A second `install` printed "Already installed: nothing changed." `uninstall` removed everything.
  The file listing and the `CLAUDE.md` hash were identical to before, except for the two backups it wrote, as
  designed.
- **Not re-run:** install into the real `~/.claude`. The auto-mode permission check refused it in this session.
  P1's own evidence for that box stands.
- **The cost box** stays as P1 reported it: about equal per session, and not cheaper. That's a measured result, not
  a defect P1 could fix within its scope, so I didn't bounce for it.
