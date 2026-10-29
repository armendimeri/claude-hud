# Conformance checklist

Is a repository on the standard? Tick every line with evidence: the file and line, or a command and its output.
Lines marked **[lint]** are the ones `node hud.mjs lint <repo>` checks by itself; the rest need a reader.
Section numbers refer to [STANDARD.md](STANDARD.md).

## Project (§3)

- [ ] **[lint]** `CLAUDE.md` has the `**Workflow:**` line naming the standard, and a `**Git:**` line saying
      `you commit` or `agents commit per item`.
- [ ] **[lint]** `CLAUDE.md` headings appear in the §3.1 order, with none in between (sections may be left out).
- [ ] `CLAUDE.md` doesn't repeat `CLAUDE.user.md` or state the project's status.
- [ ] **[lint]** `docs/status.md` exists, with the six §3.2 headings in order.
- [ ] `docs/status.md` is current: its date is the last session that changed something, and its test numbers are
      real.
- [ ] **[lint]** `docs/roadmap.md` exists, with the §3.3 headings. Every item is `**B-<n>**` with a state from §3.3,
      and no ID repeats.
- [ ] **[lint]** `docs/checks.md` exists (it may be empty apart from its headings).
- [ ] UI projects: `docs/design-system.md` exists, and no copy of a shared skill remains in `.claude/skills/`
      or `docs/skills/`.
- [ ] **[lint]** No old homes are left: no `BACKLOG.md`, `follow-ups.md`, `browser-checklist.md` or
      `docs/plans/_template/`, and no second status file.
- [ ] **[lint]** ADRs are named `docs/adr/NNNN-<kebab-title>.md`, each with a `Status:` line.

## Every plan (§4–§6)

- [ ] **[lint]** It's either `docs/plans/<slug>.md` (small) or `docs/plans/<slug>/` containing `PLAN.md` and
      `STATUS.md` (phased).
- [ ] **[lint]** The header line is `Status: **<proposed|approved|building|verified>**`, with the date for
      approved.
- [ ] **[lint]** The `## Board` table header is exactly
      `| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |`.
- [ ] **[lint]** IDs are unique and match `P<n>`, `P<n>-<nn>`, `O-<n>` or an existing `<PREFIX>-<n>`. A phased
      plan starts with `P0`.
- [ ] **[lint]** Every State is one word from §6. Every Since is empty or `yyyy-MM-dd`.
- [ ] **[lint]** Every Depends on is `—` or IDs that exist (in this plan, or `<slug>/<ID>` in another), with ranges
      written as `A–B`.
- [ ] **[lint]** Model / effort is `—` or `<Model> / <low|medium|high|xhigh|max>`.
- [ ] **[lint]** Every `handed-off`, `accepted` or `bounced` item of a phased plan links to an existing handoff
      file.
- [ ] **[lint]** Runs, Branches and Questions tables, when present, have the §5 headers.
- [ ] **[lint]** A phased plan has `## Decisions (P0)` with `- [ ]` or `- [x]` lines, plus `## Log` and
      `## Kickoff`.
- [ ] STATUS.md doesn't copy the protocol; it points to the `workflow-run` skill.
- [ ] Every item has a file scope, an exit gate that can be proven, and a model and effort.
- [ ] In shared-tree mode, items on parallel lanes have file scopes that don't overlap.

## User level (§2), checked once per PC

- [ ] **[lint]** `node workflow/kit.mjs status` shows the import line and the workflow skills linked into
      `~/.claude/`.
