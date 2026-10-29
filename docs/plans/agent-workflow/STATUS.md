# Agent workflow standard: status and handoffs

How the agents building [the agent workflow standard](PLAN.md) pass work to each other. Every agent reads this
first and updates it last.

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | accepted | 2026-10-29 | — | W1–W16 confirmed as proposed |
| P1 | Standard, templates, skills, kit | `standard` | P0 | Opus 5.5 / high | accepted | 2026-10-29 | [P1-standard](handoffs/P1-standard.md) | Kit installed by the user 2026-10-29 (Q1) |
| P3-01 | Migrate TourCMS | `migrate` | P1 | Sonnet 5.5 / high | todo | | | Runs in TourCMS · lane A |
| P3-02 | Migrate ImPOS-Maui | `migrate` | P1 | Sonnet 5.5 / high | todo | | | Runs in ImPOS-Maui · lane B |
| P3-03 | Migrate claude-hud | `migrate` | P1 | Sonnet 5.5 / medium | todo | | | Runs in claude-hud · lane C · only between two HUD items |
| P3-04 | Migrate FidiaCRM | `migrate` | P1, O-1 | Opus 5.5 / high | todo | | | Runs in FidiaCRM |
| O-1 | FidiaCRM has no run going (R15–R17 done or paused) | owner | — | — | todo | | | Unlocks P3-04 |
| P4 | Review, standard v1.0, close | `review` | P3-01–P3-04 | Opus 5.5 / high | todo | | | Runs in claude-hud |

States: `todo` → `in-progress` → `handed-off` → `accepted` (by a different agent). Also `blocked` (needs you, see
Questions), `partial` (part of the gate met) and `bounced` (the check failed).

## Decisions (P0)

Tick each, or write the change next to it. Details in PLAN §3.

- [x] **W1** The standard lives in this repo, in `workflow/` (spec, templates, skills).
- [x] **W2** Shared rules and skills at user level, *linked* to this repo: an `@import` in `~/.claude/CLAUDE.md` and directory junctions in `~/.claude/skills/`, through `node workflow/kit.mjs install|uninstall` (backup, safe to repeat, clean uninstall).
- [x] **W3** The same project files everywhere (PLAN §4.2). Renames: ImPOS `BACKLOG.md` → `docs/roadmap.md`; TourCMS `browser-checklist.md` → `docs/checks.md`; FidiaCRM `Documentation/` → `docs/`.
- [x] **W4** Two plan sizes with one shape: a small plan (one file, one run) and a phased plan (a folder with PLAN, STATUS and handoffs). Both have a Board.
- [x] **W5** One board format: `ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes`, plus an optional Runs table.
- [x] **W6** One set of state words: todo, in-progress, blocked, partial, handed-off, accepted, bounced (FidiaCRM's `done` → `accepted`).
- [x] **W7** Only a different agent sets an item `accepted`: the next agent that depends on it, or the verify item.
- [x] **W8** One run per session; a run is one item unless the plan groups small items; no stopping inside a run.
- [x] **W9** Lanes A/B (code) and C (docs/tests); shared-tree mode by default, worktree mode opt-in per project; a port per lane.
- [x] **W10** Git mode stays per project: `you commit` (default) or `agents commit per item` (FidiaCRM).
- [x] **W11** Model and effort per item, with the escalation rule (PLAN §4.9).
- [x] **W12** At most four questions, recommended answer first; the same end-of-session report everywhere, ending with paste-ready Next prompts.
- [x] **W13** `docs/status.md` per project, rewritten at the end of every session.
- [x] **W14** The HUD reads the standard (and old formats until migrated); `node hud.mjs lint <repo>`; open decisions and questions show as "needs you".
- [x] **W15** Rollout: TourCMS, ImPOS-Maui, claude-hud in parallel → FidiaCRM when no run is going. *(changed by the user 2026-10-29: the WasteManagement2 pilot is removed from this plan)*
- [x] **W16** One `apple-design` skill at user level; project overrides live in each project's `docs/design-system.md`.

## Protocol

The standard's own `workflow-run` skill doesn't exist until P1 is done, so this plan uses the protocol it
formalises:
1. **Orient:** read this file, the PLAN sections for your item, and every earlier handoff.
2. **Check what you were given:** re-run the quick parts of each dependency's exit gate. Pass → `accepted`;
   fail → `bounced`, with what failed in its handoff's Review section and in the log; then stop.
3. **Claim:** set your item `in-progress` with today's date. If someone else has it, stop.
4. **Work** only within your item's scope (PLAN §6). A gap with a clear best answer: take it and record it. A gap
   that changes what you see or do: set `blocked`, add a question, stop.
5. **Prove it:** every exit-gate tick needs evidence (a command and its output, a number, a file path).
6. **Hand off:** write `handoffs/<ID>-<agent>.md` with: summary; exit gate with evidence; files changed;
   deviations; decisions taken; known issues; lasting knowledge; next agent: start here. Set your item
   `handed-off`, add a log line, and end with the report in PLAN §4.10.

**Always:**
- P3 agents work **in the target repo**, change only its docs, CLAUDE.md and skills (never code), and write
  their handoff here: `C:\Users\armen\source\repos\armendimeri\claude-hud\docs\plans\agent-workflow\handoffs\`.
- Never convert a board while one of its items is `in-progress`. Never touch FidiaCRM while a run is going.
- `~/.claude` changes only through `workflow/kit.mjs` (and `settings.json` only through `hud.mjs install`).
- Never read `~/.claude/.credentials.json` or `~/.claude/sessions/*.key`; never copy a secret into any file.
- Git: each project's own mode (W10). In this repo: no commits unless you ask; never add a remote.

## Questions

| # | Item | Question | Recommended | Answer |
|---|---|---|---|---|
| Q1 | P3-01–P3-04 | Auto mode's permission check refused `kit.mjs install` into `~/.claude`. Will you install the kit yourself? | Yes. In a terminal, run `node C:/Users/armen/source/repos/armendimeri/claude-hud/workflow/kit.mjs install`, then `… status` (four `linked` lines and the import). The migrations use the `workflow-run` skill's Adopting section. Uninstall is clean (re-tested in a sandbox). | Installed by the user 2026-10-29; `kit.mjs status` shows 4 links and the import |

## Log

- 2026-10-29 · engine (HUD P1) · — · Plan written at the user's request, before more HUD code. Based on reading how WasteManagement2, FidiaCRM, TourCMS and ImPOS-Maui run agents today (PLAN §2). The HUD's P1 waits for this plan's P1 (the board format).
- 2026-10-29 · user · P0 · W1–W16 confirmed as proposed ("confirm all and go").
- 2026-10-29 · standard · P1 · P0 checked (W1–W16 ticked) → `accepted`. P1 claimed, `in-progress`.
- 2026-10-29 · standard · P1 · `workflow/` built (STANDARD v0.9, shared rules, 3 workflow skills + merged apple-design, 9 templates, conformance, kit). Kit tested on 5 sandbox homes and on ~/.claude (install twice, uninstall: identical). Dry run in a scratch repo: planner, P1 and P2 sessions followed the skills end to end ($1.37 in all). Fixes from the dry run applied (closing in "you commit" projects, B-ids, lint wording). Not cheaper per session in tokens (about equal): see the handoff. `handed-off`.
- 2026-10-29 · pilot · P1 · Gate re-checked: templates through boardcheck (no problems), skill line counts 65/83/49, kit install ×2 + uninstall in a sandbox home (identical apart from the backups). Install into the real `~/.claude` was refused by the auto-mode permission check, so not re-run there. Cost box left as P1 reported it (about equal per session). `accepted`.
- 2026-10-29 · pilot · P2 · Claimed, `in-progress`.
- 2026-10-29 · pilot · P2 · WasteManagement2 migrated (docs only; boardcheck clean; conformance passes except the kit line). 7 fixes made in `workflow/`. Kit install refused by auto mode → Q1. The item run (WasteManagement2 customer-history P1) is still to come. `blocked`.

## Kickoff

| Item | Open Claude Code in | Model | Effort |
|---|---|---|---|
| P1 | `C:\Users\armen\source\repos\armendimeri\claude-hud` | Opus 5.5 | high |
| P3-01 | `…\TourCMS` | Sonnet 5.5 | high |
| P3-02 | `…\ImPOS-Maui` | Sonnet 5.5 | high |
| P3-03 | `…\claude-hud` | Sonnet 5.5 | medium |
| P3-04 | `…\FidiaCRM` | Opus 5.5 | high |
| P4 | `…\claude-hud` | Opus 5.5 | high |

> You are the agent for item `<ID>` of the agent workflow standard. Follow the protocol in
> `C:\Users\armen\source\repos\armendimeri\claude-hud\docs\plans\agent-workflow\STATUS.md` exactly: orient, check
> your dependencies, claim your item, work only within its scope in `PLAN.md`, prove your exit gate with evidence,
> write your handoff, update STATUS, and stop. If something needs the user's decision, set your item `blocked`,
> add it under Questions, and stop.
- 2026-10-29 · user · P2 · WasteManagement2 removed from this plan: the P2 pilot row, its gate (incl. the "real item run" that tied the rollout to a WasteManagement2 feature), its kickoff and the P2 handoff are deleted; W3, W10 and W15 no longer mention it; P3-01–P3-04 now depend on P1. The `workflow/` fixes made during the pilot stay (CLAUDE.user "Start", STANDARD §5 Runs and §15 header mapping, adopting.md draft/finished plans and secrets, README install note). Cost finding kept for P4: an item agent reads ~17.3 KB vs ~15.4 KB with the old protocol.
- 2026-10-29 · user · — · Q1 answered: kit installed (`kit.mjs status`: workflow, workflow-plan, workflow-run, workflow-close linked; `~/.claude/CLAUDE.md` holds only the import). `apple-design` not linked, as planned. P3-01–P3-03 can start; P3-04 still waits for O-1.
