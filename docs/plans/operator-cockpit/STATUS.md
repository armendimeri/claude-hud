# Operator cockpit implementation board

Start at your phase heading in [the implementation plan](PLAN.md#implementation-phases-by-model-and-effort). Use the [shared contracts](CONTRACTS.md) and the named dependency handoffs for integration.

Choose either model/effort pair in Notes for every row. At dispatch, record the chosen runner in the single Model / effort field. P0 remains owner-authorized with either model available for coordination.

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P0 | Accept implementation defaults | human | — | — | done | 2026-11-27 | [P0](handoffs/P0.md) | Owner approved the P1 start |
| P1 | Freeze interfaces and capture baseline | contract | P0 | Codex API session | done | 2026-11-27 | [P1](handoffs/P1.md) | Accepted by coordinator: 14/14 contract tests re-run on Node 22.12.0. Fixtures in `4e07e03`. Baseline-runner fix still uncommitted in main. Native-GPU timing open (docs/checks.md). |
| P1-01 | Prove sparse and dense screen layouts | design | P0 | Claude Code subagent · Sonnet 5.5 / high | done | 2026-11-27 | [P1-01](handoffs/P1-01.md) | Accepted by coordinator: re-ran build.mjs and render.mjs (all 10 frames pass the audit) and the contract test (4/4). Static 2D frames only. Live fonts, native GPU and owner taste review unverified. |
| P2 | Build stable 3D scene | scene | P1, P1-01 | Claude Code subagent · Sonnet 5.5 / high | done | 2026-11-27 | [P2](handoffs/P2.md) | Accepted by coordinator: re-ran the full suite (108/108) and the software-WebGL harness (64/64). Native Iris Xe run by the agent (64/64, orbit p95 16.9 ms, headless). Narrow composition handed to P7. Crowded selected cluster noted for design review. |
| P3 | Build shared session inspector | inspector | P1, P1-01 | Claude Code subagent · Sonnet 5.5 / medium | done | 2026-11-27 | [P3](handoffs/P3.md) | Accepted by coordinator: re-ran the full suite (123/123, includes the 98-check Edge test). Fixture clients only; not yet in the real shell. |
| P4 | Read private history on demand | history | P1 | Claude Code subagent · Opus 5.5 / high | done | 2026-11-27 | [P4](handoffs/P4.md) | Accepted by coordinator: re-ran the phase exit check (30/30) and the full suite (87/87). Synthetic formats only, not yet checked against real Claude/Codex files. Contract clarifications recorded in CONTRACTS. |
| P5 | Prove Claude session capabilities | claude | P0 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · S |
| P6 | Prove Codex session capabilities | codex | P0 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · S |
| P7 | Integrate lazy route and inspector | shell | P2, P3 | Claude Code · Sonnet 5.5 / high, resumed in Codex | handed-off | 2026-11-27 | [P7](handoffs/P7.md) | Full suite 132/132 and native Edge smoke passed. Cold entry gates passed. Startup p95 was 7.9% higher on the repeat. |
| P8 | Pair local operator and serve history | operator | P1, P4 | Claude Code subagent · Opus 5.5 / high | done | 2026-11-27 | [P8](handoffs/P8.md) | Accepted by coordinator: re-ran the exit check (48/48), full suite (97/97) and contract test (4/4). Six access decisions accepted as defaults and recorded in CONTRACTS. Real LAN device and scheduled-task pairing unverified. |
| P8-01 | Validate, dispatch and reconcile actions | dispatch | P1 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P9 | Implement verified Claude actions | claude | P1, P5 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P10 | Implement verified Codex actions | codex | P1, P6 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P7-01 | Deliver real history in cards and cockpit | history-ui | P7, P8 | — | todo |  | — | Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high · M |
| P11 | Connect providers and verify live actions | integration | P7-01, P8-01, P9, P10 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P12 | Verify packaged build and close | review | P11 | — | todo |  | — | Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high · M |
| P2-01 | Cinematic look study (JARVIS hologram + opening) | `look` | P1-01 | Opus 5.5 / high | in-progress | 2026-11-28 | [P2-01](handoffs/P2-01.md) | Prototype: `node docs/plans/operator-cockpit/handoffs/design/redo/serve.mjs`, then :7791 (URLs in handoff). 10 stills on native Iris Xe (D3D11). Dense orbit p95 33.3 ms (2-vsync step, mean ~18 ms), DPR cap 1.25. Waits on O-1. |
| O-1 | Owner approves the P2-01 look | owner | P2-01 | — | todo |  |  | Unlocks P2-02 |
| P2-02 | Rebuild the scene to the approved look | `scene` | P2-01, O-1 | Opus 5.5 / high | todo |  |  | Owner accepts side by side on the native GPU |

## Decisions (P0)

- [x] Start the operator-first cockpit with a stable layout, HTML detail panel and optional discreet display.
- [x] Keep private chat on demand and controls local. Expose actions per verified session capability.
- [x] Use the proposed laptop performance budgets and four-slot schedule as the initial implementation targets.
- [x] **V1–V6 (visual redo, 2026-11-28, confirmed by the owner):** JARVIS hologram direction, cinematic opening (≤ 2.5 s, skippable), look approved before code, plumbing kept, same performance budget, visual work paused until O-1. Details in PLAN "Visual redo".

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
- 2026-11-27 · contract · P1 · Fixed benchmark revision reporting and the Edge launcher exit, re-verified the contract tests on Node 22.12.0 and handed off for acceptance.
- 2026-11-27 · coordinator · Accepted P1 (re-ran contract tests, 14/14 on Node 22.12.0). Owner asked for one lane at a time. Dispatched P1-01 to a Claude Code subagent in an isolated worktree from base `4e07e03`. Queue after it: P4, P8-01, P5, P6, then dependents as they become eligible.
- 2026-11-27 · coordinator · Accepted P1-01 (design audit passes for all 10 frames, contract test 4/4). P2 and P3 are now eligible. Dispatched P4 to a Claude Code subagent in the main checkout. Queue: P8-01, P5, P6, P2, P3.
- 2026-11-27 · coordinator · Accepted P4 (exit check 30/30, full suite 87/87). Recorded its five history clarifications in CONTRACTS. Reordered the queue to the plan's milestone priority. Dispatched P8. Queue: P2, P3, P8-01, P5, P6.
- 2026-11-27 · coordinator · Accepted P8 (exit check 48/48, full suite 97/97). Recorded operator access and the P8-01 seam in CONTRACTS. Dispatched P2. Queue: P3, P8-01, P5, P6. P7-01 waits for P7.
- 2026-11-27 · coordinator · Accepted P2 (full suite 108/108, harness 64/64). Recorded its additive scene interface and the narrow-width handover in CONTRACTS. Dispatched P3. Queue: P7 (after P3), P8-01, P5, P6.
- 2026-11-27 · coordinator · Accepted P3 (full suite 123/123). Recorded its inspector interface in CONTRACTS. Dispatched P7. Queue: P7-01 (after P7), P8-01, P5, P6.
- 2026-11-27 · shell · Resumed and handed off P7. Verified one SSE stream, zero cockpit assets at startup, responsive layouts and native Iris Xe rendering. P7-01 follows coordinator acceptance.
- 2026-11-28 · owner · P2 · Rejected the 3D scene on first sight ("a game from 20 years ago", wants Iron Man / JARVIS style and a cool opening). Coordinator wrote the visual redo (PLAN "Visual redo": P2-01, O-1, P2-02; decisions V1–V6) and paused visual work. P7 stays handed-off, not accepted. Nothing dispatched until V1–V6 are confirmed.
- 2026-11-28 · owner · V1–V6 confirmed ("confirm and do all of them"). Coordinator dispatched P2-01 to a Claude Code subagent (Opus 5.5 / high) in the main checkout, port 7791. O-1 (owner approves the look) comes before P2-02.
- 2026-11-28 · look · P2-01 · Handed off the hologram look study: prototype in handoffs/design/redo/ (fixture and live /api/state through a proxy on 7791; the HUD sends no CORS headers), 10 stills at 1440×900 on native Iris Xe, opening 2.4 s and skippable, dense orbit p95 33.3 ms. **O-1 now waits on the owner.**
- 2026-11-28 · owner · P2-01 · First look reviewed: "much better". Round 2 asked: (1) structure the 3D world more, (2) make obvious what is linked to what, (3) a smaller centre (this PC) that takes less space. P2-01 back to `in-progress`; V4 relaxed: the prototype may propose layout changes, which P2-02 then carries into layout.mjs. O-1 still open.
