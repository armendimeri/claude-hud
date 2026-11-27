# Operator cockpit implementation board

Start at your phase heading in [the implementation plan](PLAN.md#implementation-phases-by-model-and-effort). Use the [shared contracts](CONTRACTS.md) and the named dependency handoffs for integration.

Choose either model/effort pair in Notes for every row. At dispatch, record the chosen runner in the single Model / effort field. P0 remains owner-authorized with either model available for coordination.

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Accept implementation defaults | human | — | — | done | 2026-11-27 | [P0](handoffs/P0.md) | Owner approved the P1 start |
| P1 | Freeze interfaces and capture baseline | contract | P0 | Codex API session | partial | 2026-11-27 | [P1](handoffs/P1.md) | Owner paused work. Contract tests and 40-load Edge baseline recorded. Resume P1. |
| P1-01 | Prove sparse and dense screen layouts | design | P0 | — | todo |  | — | Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high · S |
| P2 | Build stable 3D scene | scene | P1, P1-01 | — | todo |  | — | Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high · M |
| P3 | Build shared session inspector | inspector | P1, P1-01 | — | todo |  | — | Anthropic: Sonnet 5.5 / medium · OpenAI: GPT 6.2 Sol / medium · M |
| P4 | Read private history on demand | history | P1 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P5 | Prove Claude session capabilities | claude | P0 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · S |
| P6 | Prove Codex session capabilities | codex | P0 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · S |
| P7 | Integrate lazy route and inspector | shell | P2, P3 | — | todo |  | — | Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high · M |
| P8 | Pair local operator and serve history | operator | P1, P4 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · L |
| P8-01 | Validate, dispatch and reconcile actions | dispatch | P1 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P9 | Implement verified Claude actions | claude | P1, P5 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P10 | Implement verified Codex actions | codex | P1, P6 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P7-01 | Deliver real history in cards and cockpit | history-ui | P7, P8 | — | todo |  | — | Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high · M |
| P11 | Connect providers and verify live actions | integration | P7-01, P8-01, P9, P10 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P12 | Verify packaged build and close | review | P11 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |

## Decisions (P0)

- [x] Start the operator-first cockpit with a stable layout, HTML detail panel and optional discreet display.
- [x] Keep private chat on demand and controls local. Expose actions per verified session capability.
- [x] Use the proposed laptop performance budgets and four-slot schedule as the initial implementation targets.

## Kickoff

After approval, start four independent worktrees. Each kickoff below specifies the first evidence to bring back.

| Lane | First assignment | First handoff |
|---|---|---|
| Contracts | P1 · baseline and API fixtures | Cold-start measurement and neutral examples for scene selection, history and delivery |
| Design | P1-01 · actual screen composition | Labeled sparse/dense and narrow/desktop layouts with the waiting-to-inspect interaction |
| Claude Code probe | P5 · Claude CLI and VS Code | Per-surface capability worksheet with original-session evidence |
| Codex probe | P6 · Codex CLI and VS Code | Per-surface capability worksheet with original-session evidence |

After those handoffs, dispatch ready items using the dependency column. Review P7 as the first working cockpit, P7-01 as the first real history release candidate, and P11 as the first live-control release candidate. P12 verifies the distributable.

Use the [P0 kickoff prompt](PLAN.md#p0) to start. Each phase in PLAN.md ends with the literal prompt, Anthropic and OpenAI runner settings, and prerequisites for each direct successor. The coordinator assigns each eligible item once and supplies its integrated base revision and worktree path.

## Log

- 2026-11-27 · planner · Proposed the work packages and dependency schedule.
- 2026-11-27 · planner · Added phase-specific execution briefs and private/browser contracts. Split action dispatch into an independent lane and checked the installed provider tooling.
