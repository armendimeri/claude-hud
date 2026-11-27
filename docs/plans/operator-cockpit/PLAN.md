# Operator cockpit and session controls

Status: **proposed** · Written 2026-11-27 · Checked against the code 2026-11-27. [Execution board](STATUS.md)

## Start here

Choose **one** implementation runner from either provider for each phase. These pairings are planning judgments about the work and its reasoning demands. Both runners use the same inputs, scope and exit checks. A Claude Code probe still needs access to Claude Code, and a Codex probe still needs access to Codex, whichever model executes the brief. P0’s runner coordinates after owner approval.

| Phase | Anthropic model / effort | OpenAI model / effort |
|---|---|---|
| [P0](#p0) Accept implementation defaults | Sonnet 5.5 / medium | GPT 6.2 Sol / medium |
| [P1](#p1) Freeze interfaces and capture baseline | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P1-01](#p1-01) Prove sparse and dense screen layouts | Sonnet 5.5 / high | GPT 6.2 Sol / high |
| [P2](#p2) Build stable 3D scene | Sonnet 5.5 / high | GPT 6.2 Sol / high |
| [P3](#p3) Build shared session inspector | Sonnet 5.5 / medium | GPT 6.2 Sol / medium |
| [P4](#p4) Read private history on demand | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P5](#p5) Prove Claude session capabilities | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P6](#p6) Prove Codex session capabilities | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P7](#p7) Integrate lazy route and inspector | Sonnet 5.5 / high | GPT 6.2 Sol / high |
| [P8](#p8) Pair local operator and serve history | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P8-01](#p8-01) Validate, dispatch and reconcile actions | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P9](#p9) Implement verified Claude actions | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P10](#p10) Implement verified Codex actions | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P7-01](#p7-01) Deliver real history in cards and cockpit | Sonnet 5.5 / high | GPT 6.2 Sol / high |
| [P11](#p11) Connect providers and verify live actions | Opus 5.5 / high | GPT 6.2 Astra / high |
| [P12](#p12) Verify packaged build and close | Opus 5.5 / high | GPT 6.2 Astra / high |

## Findings resolved during planning

| Finding in the current checkout | Implementation decision | Verification owner |
|---|---|---|
| Cards and Network both mount in the sessions outlet. The page shell expects mount to return a synchronous disposer. | Use a deferred page wrapper and immediate cleanup token. Capture return state before unmount, and discard late imports by generation. | P7 exercises rapid exit, browser Back and direct URL entry. |
| The dashboard builds a fresh local actions object. Notifications, away tracking and previous snapshot live inside its mount. | Forward inspector actions explicitly and give cross-route effects one page lifetime. Apply discreet presentation to new events and queued speech. | P7 checks duplicate/missed notifications and private labels on exit. |
| Session projection can replace a Claude tool ID with an agent ID and fold a Codex thread into another session's children. | Resolve the parent/child tuple in the private registry. Ambiguous or expired selections lose write capability. | P4/P8 verify sibling isolation. P11 checks original-session delivery. |
| A bounded reverse scan can end inside UTF-8, JSONL or a growing final line. The public feed omits message bodies. | Page at complete byte boundaries, distinguish gaps and maintain forward/backward cursors. Catch up only while the private inspector is visible. | P4 and P7-01 verify append, rotation, bounded reads and late responses. |
| HTTP loopback hook ingestion accepts a missing Origin. The existing LAN display is intentionally readable without pairing. | Introduce private operator routes with their own stricter access checks. Use a one-time local pairing command that works with the background task. | P8 tests LAN, origin, wrong-port, pair-consumption and restart cases. |
| Native provider acknowledgements, question withdrawal and actual resumed work can arrive independently. | Bind submissions to the provider's turn/request; journal action identity before dispatch and surface unknown delivery. | P8-01, P9/P10 and P11 verify concurrency and native outcomes. |
| The browser smoke suite explicitly disables GPU. Archive checks copy a source subtree, while git archive includes only committed files. | Test graceful fallback, a real WebGL frame and the extracted candidate archive separately. Capture renderer and revision. | P12 reports each gate separately. |

## Product intent

A developer working across several agents should be able to glance at the screen, see who is working or waiting, inspect the conversation, make a decision, and keep their place. The same screen should look composed when left open in a café or briefly shared with a client. Use the ordinary live workflow for both settings. Synthetic scenarios belong in development and verification.

### The everyday interaction

1. Open **Cockpit** from the HUD toolbar. Preserve project scope and the return destination, including Cards or Network. Allow direct links and browser Back. Respect the existing kiosk preference separately.
2. Anchor projects in stable positions, group sessions around their project, and attach subagents to their parent. Label sparse scenes directly. In dense scenes, label the selection and waiting sessions first and collapse idle groups with a visible count. Expand a group without losing camera position.
3. Keep a fixed HTML strip for connection state, project filter, working and waiting counts, usage/context when known, and access to plans and recent activity. Selecting a node brings up its task, current tool, elapsed time and latest events. Show last-known state with a reconnect indicator when the stream drops.
4. An expandable card and a selected node open the same inspector. Show the conversation in reading order with tool summaries collapsed between messages. Preserve scroll position when reading older turns. A new-message affordance returns to live activity. Distinguish unavailable history from an empty conversation.
5. Deliver a follow-up to an idle session, steer an active turn, or answer a pending question only when that specific interaction is available. Permission decisions show the requested action and scope separately. Acknowledge delivery, then let observed agent state show whether work resumed.

### Visual direction and public spaces

Use the HUD’s typography and status vocabulary, a restrained luminous core, fine depth cues and readable screen-space labels. Use one brief pulse for a real event or handoff, then settle. Preserve labels and icons alongside color. Keep the default camera still, offer explicit orbit and reset, and respect reduced motion. In a shared space, offer a one-action **discreet display** that aliases names and replaces chat, paths, commands, free-text labels and tooltips with counts and statuses. Hide an already-open inspector immediately. This is local screen privacy. A glance should communicate organized work with no presentation setup.

## Screen specification and HUD coverage

At laptop width, read the screen from the top down. The top bar holds the return control, project scope, connection status and discreet toggle. Under it, the attention row names the oldest waiting session and shows the number of others. The center holds the project map. Selecting a session opens a right-hand inspector while keeping the selected node visible. The bottom activity strip shows the most recent completion and opens a chronological feed. At narrow widths, the inspector becomes a full-width sheet with a visible return control. At any width, typing in the composer suspends global navigation shortcuts.

The visual hierarchy follows the [existing HUD design system](../../DESIGN.md). Red plus a request icon means the operator can act. Amber identifies working sessions, violet identifies subagents and green briefly marks completion. Use the cyan reactor, dark navy field and glass surfaces already familiar from the dashboard. Light the edges of the selected cluster and leave the surrounding clusters readable. Size text in screen pixels so camera zoom preserves legibility. Keep glow below the text layer. Depth shows ownership and grouping. Counts, labels and working relationships carry the same meaning in the accessible HTML list.

| Existing information | Where the operator sees it | Interaction and acceptance case | Owner |
|---|---|---|---|
| Needs you, warnings and connection | Attention row above the map, plus the affected node | Selecting the oldest request reveals its session. A context or long-tool warning explains why it fired. Reconnecting retains the last timestamp and clears live-delivery affordances. | P2, P7 |
| Sessions, providers, model and branch | Project clusters, session labels and inspector header | The selected entity remains selected across snapshots. Two sessions with the same title remain distinct. An idle parent with a running child still shows “Agents working.” | P2, P3 |
| Subagents and shell-launched sessions | Parent links and expandable groups | Distinguish delegated work from an independently launched session using the existing relationship metadata. Expanding a completed group retains the camera. A subagent with no separate input channel remains inspectable. | P2, P3 |
| Current tool, context, tokens, duration and usage | Context ring, selected card and vitals drawer | Reuse existing units, sparkline and quota labels. Unknown context has an unknown state. Selecting Codex leaves Claude account limits clearly attributed to Claude. | P3, P7 |
| Plans, queue, handoffs and drift | Project drawer available from the map and linked item inside inspector | Follow project → board item → active agent and back. Show ready work, owner inputs, handoffs and drift with the same scopes and counts as the dashboard. Keep board questions distinguishable from interactive agent requests. | P3, P7 |
| Feed, last done and away summary | Bottom strip and expandable activity list | A real completion updates the strip. Selecting an event reveals its source when available. Returning after an absence shows the existing summary once. Switching views cannot duplicate a notification. | P7 |
| Chat and replies | Expanded card or node inspector | Activity appears immediately. Private history loads for the selected entity. A reply appears with the correct speaker and delivery status in either view. | P3, P4, P7-01, P11 |

P7 compares each row against Cards or Network on the same frozen snapshot. Use the existing selectors, plan panel, vitals components, feed and away summary wherever they already own the behavior. Preserve the existing dense-row threshold and dashboard view preference. In the cockpit, render aggregate counts for a collapsed project and cap labels by available space. Keep waiting entities reachable by the attention row even when their labels overlap.

### Walkthroughs to build against

**Morning scan.** Open with two projects, three working sessions, an idle parent with one running child, and one genuine question. Within two seconds the operator can find the waiting state. Activating the attention row selects the relevant project and question without an automatic camera flight on subsequent updates. Closing the inspector returns keyboard focus to the opener. Escape closes the innermost surface first, then clears project focus using the existing behavior.

**Read and intervene.** Expand a compact dashboard card while two sessions are emitting events. The inspector header identifies project, session and provider. Activity shows the current tool, start time and latest completed step. Conversation opens at the newest visible turn. Load earlier messages, scroll midway, and let a new reply arrive. Keep the reading position and show a jump-to-latest control. Scope a draft to its session and request in memory. Switching agents cannot send a draft to the new selection. Enter inserts a newline in multiline input, and a labeled Send button or Ctrl/Cmd+Enter submits. Disable repeat submission for the same action.

**Leave it open while working.** New sessions settle into free positions. Finished sessions give one completion cue. Existing nodes keep their places. With the window in the background, suspend drawing while retaining store state. On return, reconcile to the latest snapshot and surface missed outcomes in the feed. For a screen share, discreet display immediately replaces identifying content everywhere, including inspector, event labels, tooltips, accessible names and future updates. Maintain the operator’s selected project and camera when toggling back.

**Return to 2D.** From a project-filtered compact row, enter Cockpit, pan, inspect a child, then return to the originating view, project and row. Browser Back follows navigation history. A direct cockpit link has an explicit path back to the dashboard. Interrupting load or losing WebGL always leaves a usable list, inspector and exit control.

## Session detail and delivery specification

| Session condition | Operator action | Request binding | Visible result |
|---|---|---|---|
| Observed in terminal or editor | Read activity and any available history, open the existing VS Code folder link where supported | Known session identity | Explain available controls for this session. Label folder navigation accurately. |
| Idle and connected | Send follow-up | Session and action ID | Show sending, provider acknowledgement, then the new observed turn. |
| Busy and steerable | Steer current turn | Session and expected active turn | If the turn finished while typing, retain the draft and offer it as a new follow-up with explicit submission. |
| Waiting for an answer | Select an offered option or submit permitted free text | Session, pending request ID and allowed answer shape | Display the agent’s actual question and options. On a native-client answer, close the obsolete form and show “Answered elsewhere” when confirmed. |
| Waiting for permission | Allow once or deny | Pending permission ID, operation and scope | Show the requested operation before the choice. Expire controls immediately when the provider resolves or withdraws the request. |
| Disconnected after sending | Inspect delivery status | Same action ID and target | Show “Delivery unconfirmed” until reconciled. Preserve the distinction between acknowledged delivery and resumed work. |
| Ended, truncated or compacted | Read remaining visible conversation | Session and history cursor | Mark gaps explicitly. An ended session exposes only capabilities returned by its adapter. |

**Proposed reader defaults for P1 fixtures.** Request the newest 40 visible entries and return an opaque cursor bound to the session and file generation. Budget 512 KiB of source reads per page. A budget-limited scan can return a continuation even when it finds zero visible messages. Test a late append during pagination, rotation between pages, and a single record bigger than the budget. Bind event IDs to source and location, order ties deterministically, and deduplicate overlapping pages. On a generation change, surface a refresh boundary. Escape message content before display. Retain user-visible conversation only while the private panel is open.

**Live history without an extra public stream.** P7-01 owns the browser client for real history. Fetch the first page on open, then fetch newer entries using an opaque forward cursor. Coalesce session activity into one in-flight request and do a bounded catch-up while the panel is visible so final replies arrive even if a public signal is missed. Abort on close, selection change or discreet display. Refresh capabilities when a pending request changes and revalidate on submit. P4 implements both cursor directions; P8 exposes them through authenticated history routes and owns the private capability endpoint. A fixture containing different marker strings for parent, child and sibling proves isolation.

**Provider feasibility worksheet.** P5 and P6 each return one row per combination of installed provider version, host surface and connection mode. Cover ordinary CLI, ordinary VS Code and an explicitly connected session wherever the provider supports one. Columns are visible history, idle follow-up, active steer, structured answer, allow/deny, original-session acknowledgement, and setup required. Include native and HUD timestamps and session/turn/request identifiers using synthetic data. A read-only history file can pass the first column alone. If an installation, account or preview restriction prevents a test, mark the cell unverified and record the exact prerequisite. P9 and P10 implement only verified cells. P11 reports the user-visible compatibility matrix alongside setup instructions.

## Integration points and proposed contracts

- The [page shell](../../../src/web/components/page.mjs) owns one store and transport. The [registry](../../../src/web/view-registry.mjs) statically imports existing descriptors, and Cards and Network both stay mounted inside the sessions outlet. Use a lightweight page descriptor and dynamically import the cockpit implementation on entry. Return a synchronous cancellation handle even while imports are pending. Load the inspector separately on demand from either view.
- Serve a pinned, licensed native Three.js module and its transitive local imports through the existing [asset allowlist](../../../src/http/assets.mjs). Include the license and required files in the packaged archive. Keep startup free of preloads, scene CSS, private history requests and GPU initialization. Share snapshots through the current store instead of opening another public stream.
- Freeze UI inputs at P1. Proposed scene interface is `mountScene(host, {store, actions, motion, signal}) → cleanup`. Selection carries an opaque session key plus optional subagent key. Inspector receives that selection and an injected operator client. Reuse provider identity and joins from the store. Older frames and missing fields render with unknown values.
- The [live runtime](../../../src/app/live.mjs) tails Claude and Codex files for summaries. Today’s public stream deliberately omits full prompt bodies. Resolve selected identities against known local sources on the server. Add a private, bounded history reader without a background scan or duplicate transcript database. Return visible user/assistant messages and redacted tool summaries. Exclude reasoning, system instructions and raw tool output.
- Proposed private HTTP contract under `/api/operator/sessions/{key}/`: `history?before=<opaque cursor>` returns entries and a next cursor, `capabilities` returns supported actions and current turn/request identities, `actions` accepts a POST with action ID, kind, target turn/request and payload. Initial actions are prompt, steer, answer, allow-once and deny. Negotiate per session and per surface. Return unavailable, stale, pending, acknowledged or delivery-unknown explicitly. A refreshed page can reconcile an action by ID. Keep transcripts and action bodies out of the public snapshot, SSE, event recording and logs.
- P8-01 owns the provider-neutral dispatcher. Adapters expose capabilities, dispatch and reconciliation. Bind each action to the intended session and active turn or pending request. Deduplicate retries and concurrent submissions. After a disconnect with ambiguous delivery, reconcile through the provider or surface uncertainty and require an explicit operator decision before any resend. Never translate chat text into an approval.
- Private routes require loopback client and host, a same-origin authenticated operator session with request-forgery protection, and bounded inputs. Pair or bootstrap the operator locally. Public/LAN views receive only the existing display data. Provider credentials and file paths stay on the server. Explicitly test a LAN-enabled server from both local and remote clients. Render transcript text as inert content.

## Implementation phases by model and effort

Each phase ends with prompts for its direct successors. Where two phases point to the same successor, the coordinator claims it once after all dependencies pass, integrates their accepted revisions into its worktree, and records the selected runner. Fill up to four slots; completed workers return prompts to the coordinator for dispatch. Start with the owner’s [P0 prompt](#p0). S, M and L describe relative work size. Medium and high specify the effort to select on the chosen runner. Run commands from the assigned worktree root. New test files belong to the phase that names them.

### Owner-assisted coordination

#### P0

**Accept implementation defaults** · Depends on — · Owner approval

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Sonnet 5.5 / medium | GPT 6.2 Sol / medium |

The coordinator records the base revision and dispatches prepared briefs after the owner authorizes kickoff.

**Owner and coordinator.** Record kickoff once the owner authorizes implementation. Record the chosen base commit, branch and worktree for each of the four initial assignments. Snapshot unrelated pending changes with `git status --short` for the coordinator's own reference. Build from the agreed base including the plan, in isolated worktrees. Leave the installed task, hooks and deployment checkout alone. Stage handoffs by explicit file path.

**Dispatch.** Give each agent its exact ID, worktree, base revision and links to its brief and upstream handoffs. The coordinator updates the board. The agent writes only its named production scope, its named tests, and `docs/plans/operator-cockpit/handoffs/<ID>.md`. For a missing cross-lane seam, send the expected input/output and a failing fixture to the owning lane, then continue through an injected fake. Check off P0 and dispatch P1, P1-01, P5 and P6 concurrently.

**Starting prompt for P0**

> I approve the proposed operator-cockpit plan and its P0 defaults. Act as kickoff coordinator in the claude-hud repository. Read docs/plans/operator-cockpit/PLAN.md, STATUS.md and CONTRACTS.md in that directory. Complete P0, prepare a shared base containing the plan, and preserve unrelated working-tree changes. Start P1, P1-01, P5 and P6 in separate worktrees using the prompts and model/effort choices under P0. If you cannot launch a lane, return its exact prompt, model, effort, base revision and worktree path so I can launch it. Report which lanes actually started.

**Next assignments after P0**

**[P1](#p1) · Freeze interfaces and capture baseline**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P0 is accepted.

> Execute operator-cockpit/P1 in your assigned claude-hud worktree. Read P1 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P0 are present. Capture the dashboard baseline and freeze shared synthetic fixtures for selection, history and action delivery. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P1.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P1-01](#p1-01) · Prove sparse and dense screen layouts**  
Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high  
Ready when P0 is accepted.

> Execute operator-cockpit/P1-01 in your assigned claude-hud worktree. Read P1-01 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P0 are present. Produce sparse and dense laptop layouts and a narrow-screen layout showing waiting, inspection and exit. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P1-01.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P5](#p5) · Prove Claude session capabilities**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P0 is accepted.

> Execute operator-cockpit/P5 in your assigned claude-hud worktree. Read P5 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P0 are present. Probe Claude Code in disposable terminal and VS Code sessions. Record which operations reach the original session. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P5.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P6](#p6) · Prove Codex session capabilities**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P0 is accepted.

> Execute operator-cockpit/P6 in your assigned claude-hud worktree. Read P6 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P0 are present. Probe Codex in disposable terminal and VS Code sessions. Record which operations reach the original thread and turn. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P6.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

### Fixture-driven implementation

#### P3

**Build shared session inspector** · Depends on P1, P1-01 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Sonnet 5.5 / medium | GPT 6.2 Sol / medium |

The inspector uses frozen inputs and fixture clients. Medium effort covers its focused UI state and keyboard tests.

**Scope.** New `src/web/inspector/panel.mjs`, state module, stylesheet, fixture-backed tests in `tests/cockpit-inspector.test.mjs`. P7-01 owns the eventual network client. Read `src/web/components/dom.mjs`, `lifetime.mjs`, `sessions.mjs` and the P1 DTOs.

1. Export one mount with entity selection, public store, injected private client and close callback. Immediately render public header and current activity. Do private reads only on explicit history/interaction access. Use a monotonically increasing request generation plus AbortController for each selection.
2. Implement explicit loading/empty/partial/error/ready histories. Prepend older rows keyed by entry ID; preserve a visible anchor and its pixel offset. Append newer rows once; auto-scroll only when the user was at the bottom. Use textContent and wrap oversized strings. Treat provider text as inert, including links and HTML-like strings.
3. Implement capability-specific forms against fakes. Scope draft to the tuple/turn/request and clear on close, privacy or expiry. Keep in-memory drafts on ordinary switches while the panel remains open. Clear or explicitly retarget a finished-turn draft. Focus the first unanswered field, allow newline in text input, handle submission shortcuts once, and label pending/unknown status.
4. Escape closes the innermost panel. Prevent the shell's Escape listener from simultaneously clearing the project. Restore focus by entity key even when compact rows were rebuilt. At narrow widths render a sheet with a visible exit. Inspect inactive tabs for hidden private DOM after close.
5. Run `node --test tests/cockpit-inspector.test.mjs`. Use fake delayed A/B responses, scroll-while-append, two pending questions, an externally closed request, a denied permission and an unconfirmed delivery. Provide keyboard and screenshot evidence at the P1-01 sizes.

**Next assignments after P3**

**[P7](#p7) · Integrate lazy route and inspector**  
Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high  
Ready when P2 and P3 are accepted.

> Execute operator-cockpit/P7 in your assigned claude-hud worktree. Read P7 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P2, P3 are present. Wire the lazy cockpit route and shared inspector. Verify navigation restoration, fallback and zero cold-entry 3D requests. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P7.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

### UI and runtime integration

#### P1-01

**Prove sparse and dense screen layouts** · Depends on P0 · S

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Sonnet 5.5 / high | GPT 6.2 Sol / high |

The runner translates established HUD tokens into dense, narrow and keyboard-accessible compositions.

**Scope.** Design assets under this plan's `handoffs/design/` plus P1-01 handoff. Start from `docs/DESIGN.md`, `docs/screenshots/dense-network-1440x900.png` and `src/web/styles/foundation.css`. Work from synthetic values.

1. Compose 1440×900 with two project groups, parent and child, one waiting question, one completion and top-level counts. Create a companion view with the right inspector open. Anchor projected nodes in the available scene rectangle when panel width changes.
2. Draw a dense desktop and 390×844 case with selected node, overlapping labels, compact activity strip and expanded inspector. At 1024×768 retain attention and exit controls; allow the inspector to overlay the scene when the map cannot fit both.
3. Annotate node hierarchy, minimum hit area (target 44 CSS px for primary actions), focus order, selection outline, status text, label suppression priority, reduced-motion state and GPU fallback. Include real example strings for a blocked question, active tool, disconnected source and long session title. Supply layout dimensions, token names and rules for wrapping.
4. Check a static screenshot with color removed. Identify waiting, working and finished entities from labels/shapes alone. Check all public labels and the inspector in discreet state. Deliver actual images plus a click/keyboard walkthrough for P2/P3; the coordinator can accept using the checks without waiting for a taste review.

**Next assignments after P1-01**

**[P2](#p2) · Build stable 3D scene**  
Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high  
Ready when P1 and P1-01 are accepted.

> Execute operator-cockpit/P2 in your assigned claude-hud worktree. Read P2 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P1-01 are present. Build the lazy-loadable 3D scene and prove stable layout, idle rendering and GPU cleanup. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P2.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P3](#p3) · Build shared session inspector**  
Anthropic: Sonnet 5.5 / medium · OpenAI: GPT 6.2 Sol / medium  
Ready when P1 and P1-01 are accepted.

> Execute operator-cockpit/P3 in your assigned claude-hud worktree. Read P3 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P1-01 are present. Build the shared card and cockpit inspector against fixture clients. Prove selection and draft isolation. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P3.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P2

**Build stable 3D scene** · Depends on P1, P1-01 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Sonnet 5.5 / high | GPT 6.2 Sol / high |

Stable scene layout, GPU disposal and hidden-tab rendering must work together across repeated mounts.

**Scope.** New `src/web/cockpit/scene.mjs`, `layout.mjs`, scene stylesheet and `src/web/vendor/three/` assets, license and `tests/cockpit-layout.test.mjs`. Asset registration belongs to P7. Use `src/web/components/geometry.mjs` and `network-map.mjs` as reference, and P1-01 layouts.

1. Implement pure keyed layout first. Stable sort incoming groups on first render. Assign free ring slots, retain existing allocations per project and session, free slots when entities expire. Bound retained slot history. Child depth and parent links come from published relationships. Handle orphan/cyclic edges defensively. Test adding unrelated work leaves surviving positions unchanged.
2. Separate the store projection from drawing. Draw nodes, links and selection with shared shapes/materials. Render labels in HTML using text nodes; line styles distinguish delegation from shell linkage. Display count/expand for collapsed finished groups. An accessible list invokes the same selection callback.
3. Add pointer pick, drag threshold, orbit/zoom limits, reset and keyboard selection. Clicking a node never sends an action. DPR cap, resize observer and one pending frame follow CONTRACTS. Reject background-tab invalidation until visible. Graph update compares meaningful properties independently of the server clock.
4. Implement a disposal stack for owned resources and callbacks including partially constructed renderers. Wrap renderer creation, module failure and context loss in the shell fallback contract. Record version, hash, imports and license for P7. Use an isolated scene harness in your worktree pending integration.
5. Run `node --test tests/cockpit-layout.test.mjs`. Supply before/after positions for an unrelated insertion, screenshot for dense selection and frame counter over a quiet interval. Verify an event causes a frame after the scene has gone idle.

**Next assignments after P2**

**[P7](#p7) · Integrate lazy route and inspector**  
Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high  
Ready when P2 and P3 are accepted.

> Execute operator-cockpit/P7 in your assigned claude-hud worktree. Read P7 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P2, P3 are present. Wire the lazy cockpit route and shared inspector. Verify navigation restoration, fallback and zero cold-entry 3D requests. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P7.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P7

**Integrate lazy route and inspector** · Depends on P2, P3 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Sonnet 5.5 / high | GPT 6.2 Sol / high |

Route history, lazy imports, existing HUD panels and one shared stream have to survive rapid view changes.

**Scope.** Shell/browser integration: `src/web/components/page.mjs`, `view-registry.mjs`, `legacy-hud.mjs`, `components/{session-panel,sessions,controls,notifications}.mjs`, existing view entries as needed, `src/http/assets.mjs`, packaging checks and `tests/browser-smoke.mjs`. New feature assets live under their owners' directories. Integrate in three reviewable steps.

1. **Navigation first.** Replace the single boot-time route decision with a location-driven renderer retaining the same store. Adapt page descriptors to the synchronous close contract. The cockpit wrapper returns a disposer immediately, lazy-imports scene and CSS, checks mount generation and tears down on abort. Preserve the initial full-frame gate, demo-only Activity and kiosk → Network precedence. Provide direct-link and history handling from CONTRACTS. Add card/row/pinned-card inspector entry using current entity identity; legacy-hud builds its own local api, so explicitly forward the new actions there.
2. **Panels and effects.** Implement the coverage table in PLAN one row at a time. Compose alert/away, reactor/vitals, external account state/error, plans/work queue, scoped feed and last completion using their current update APIs. Hoist shared notifications/away to one page lifetime. Browser store calls listeners on connection, snapshot and feed; handle each type. Apply discreet policy before DOM/ARIA, speech and notifications. Route Escape and focus restoration by stable key; when the row expired, use the view selector. Ensure a project chosen inside the cockpit is restored or discarded according to the explicit return semantics in CONTRACTS.
3. **Distribution and close.** Register individual native modules, vendor transitive imports and styles under exact URLs/MIME types in the allowlist. Extend package tests to read assets from the distribution. Keep Three.js out of initial entry graph and hud.css imports. Test normal route, Activity, kiosk, deep link, direct refresh and ten rapid entry/exit cycles. Include capture/interception of late module and private responses.
4. Run `node --test tests/packaging.test.mjs tests/browser-store.test.mjs` and `node tests/browser-smoke.mjs`. Deliver screen coverage against the same frozen snapshot at three widths, network log for cold entry, one SSE connection through route changes, HTML fallback and a real scene smoke where GPU is available. P7 can ship public-data preview independently.

**Next assignments after P7**

**[P7-01](#p7-01) · Deliver real history in cards and cockpit**  
Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high  
Ready when P7 and P8 are accepted.

> Execute operator-cockpit/P7-01 in your assigned claude-hud worktree. Read P7-01 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P7, P8 are present. Connect the inspector to real private history in Cards and Cockpit. Verify live append, older-page scroll and bounded reads. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P7-01.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P7-01

**Deliver real history in cards and cockpit** · Depends on P7, P8 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Sonnet 5.5 / high | GPT 6.2 Sol / high |

The HTTP and UI contracts are established, but paging, pairing expiry and stale responses need integration testing.

**Scope.** `src/web/inspector/client.mjs`, injected binding in the inspector and `tests/operator-history-flow.test.mjs`. Wait for P7 and P8, independently of P9/P10.

1. Bind real same-origin transport to the panel. Prompt to pair only at first private use; keep public activity available while pairing. Support expired pairing while preserving the selected entity. Never put sensitive responses in storage or debug logs.
2. Start at newest page, load earlier on demand and coalesce newer reads to a single flight. Proposed visible-panel catch-up interval is five seconds. Pause in a hidden tab, back off on failures and recover once on visibility return. Bound rendered entries to 200; allow explicit older paging with an anchor and reload path. On close or selection change abort both directions and ignore stale results.
3. Add real HTTP + isolated file fixture tests for fresh append, duplicate public hints, busy child, no input rights, provider disconnect, rotate while reading, expired pairing and redaction. Render the same private data in Cards and Cockpit, aborting reads in discreet mode. Verify network traces for cold route, closed panel and idle background.
4. Run `node --test tests/operator-history-flow.test.mjs tests/operator-access.test.mjs` and `node tests/browser-smoke.mjs`. Show an appended native-shaped reply appearing exactly once and older pages holding position. Hand off this independently usable history milestone.

**Next assignments after P7-01**

**[P11](#p11) · Connect providers and verify live actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P7-01 and P8-01 and P9 and P10 are accepted.

> Execute operator-cockpit/P11 in your assigned claude-hud worktree. Read P11 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P7-01, P8-01, P9, P10 are present. Integrate the dispatcher and verified providers. Publish original-session evidence and report cockpit, history and control outcomes separately. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P11.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

### Protocol, correctness and verification

#### P1

**Freeze interfaces and capture baseline** · Depends on P0 · S

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

The runner must freeze interfaces shared by several teams and distinguish real startup regressions from measurement noise.

**Scope.** Shared fixture inputs, contract assertions, baseline evidence and repeatable browser measurement under `tests/fixtures/cockpit/`, `tests/cockpit-contract.test.mjs` and `tests/tools/cockpit-baseline.mjs`. Read `src/contract/snapshot.mjs`, `src/web/data/store.mjs`, `tests/fixtures/contract/scenario.mjs`, `tests/browser-smoke.mjs` and `tests/helpers.mjs`.

1. Pin time, viewport, data seed, browser executable/version, CPU power mode, device pixel ratio and commit. Drive a fresh browser profile via the existing DevTools protocol approach. Start two isolated HUDs from baseline and later candidate directories. Keep fonts/network conditions identical. Record local asset requests/bytes separately from optional Google fonts.
2. Define “first usable HUD” as first full snapshot rendered with session rows/nodes and an operable view switch. Do a warm-up, alternate 20 cold loads per build with browser cache disabled, save per-load elapsed times and median/p95. Record server idle CPU over the same interval, client frame count, and dense SSE bytes. Baseline helper must accept a build URL so P12 can rerun the same procedure. If a graphics device is unavailable, record it separately from the CPU baseline.
3. Create frozen snapshots for empty, sparse, dense (>8 live), same-title sessions, idle parent with running child, tool-ID-only subagent, ended selection and reconnection. Include Claude, Bedrock and Codex. Put an identifiable synthetic marker in each private DTO, absent from the public fixtures. Provide before/after updates and expected counts, selected keys and visible statuses.
4. Create history and action examples for conflicting sessions, multi-question requests, observed-only, stale pending ID, unsupported surface, duplicate action and ambiguous delivery. Freeze clock/IDs and constructor contracts for fake store/client/adapter. Run `node --test tests/cockpit-contract.test.mjs tests/public-contract.test.mjs tests/browser-store.test.mjs` and `node tests/tools/stream-size.mjs --demo=dense --seconds=30`.
5. Handoff the fixtures, baseline invocation, raw samples, expected assertions and screenshots policy. Downstream agents import the examples unchanged. The baseline runner alone may land before the hardware measurements if another runner is needed; keep the measurement outstanding on P1.

**Next assignments after P1**

**[P2](#p2) · Build stable 3D scene**  
Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high  
Ready when P1 and P1-01 are accepted.

> Execute operator-cockpit/P2 in your assigned claude-hud worktree. Read P2 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P1-01 are present. Build the lazy-loadable 3D scene and prove stable layout, idle rendering and GPU cleanup. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P2.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P3](#p3) · Build shared session inspector**  
Anthropic: Sonnet 5.5 / medium · OpenAI: GPT 6.2 Sol / medium  
Ready when P1 and P1-01 are accepted.

> Execute operator-cockpit/P3 in your assigned claude-hud worktree. Read P3 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P1-01 are present. Build the shared card and cockpit inspector against fixture clients. Prove selection and draft isolation. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P3.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P4](#p4) · Read private history on demand**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P1 is accepted.

> Execute operator-cockpit/P4 in your assigned claude-hud worktree. Read P4 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1 are present. Build bounded Claude and Codex history readers. Prove pagination, rotation and parent/child isolation. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P4.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P8](#p8) · Pair local operator and serve history**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P1 and P4 are accepted.

> Execute operator-cockpit/P8 in your assigned claude-hud worktree. Read P8 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P4 are present. Implement local pairing, authorized private history routes and source resolution. Verify LAN denial and graceful shutdown. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P8.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P8-01](#p8-01) · Validate, dispatch and reconcile actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P1 is accepted.

> Execute operator-cockpit/P8-01 in your assigned claude-hud worktree. Read P8-01 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1 are present. Implement action validation, deduplication and receipt reconciliation with a fake adapter. Prove that an ambiguous retry dispatches at most once. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P8-01.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P9](#p9) · Implement verified Claude actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P1 and P5 are accepted.

> Execute operator-cockpit/P9 in your assigned claude-hud worktree. Read P9 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P5 are present. Implement only the Claude adapter capabilities demonstrated by P5. Prove target binding and observed-only fallback. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P9.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

**[P10](#p10) · Implement verified Codex actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P1 and P6 are accepted.

> Execute operator-cockpit/P10 in your assigned claude-hud worktree. Read P10 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P6 are present. Implement only the Codex adapter capabilities demonstrated by P6. Prove turn/request binding and observed-only fallback. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P10.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P4

**Read private history on demand** · Depends on P1 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

Byte-bound pagination, partial UTF-8 records and parent/child transcript isolation require careful boundary reasoning.

**Scope.** New `src/sources/history/` and `tests/operator-history.test.mjs`. Read `src/sources/claude-transcripts.mjs`, `codex-rollouts.mjs`, `tail-reader.mjs`, `src/domain/subagents.mjs` and `sessions.mjs`. P8 wires real registry access; accept an injected trusted resolver here.

1. Create a fixture writer containing real-shaped JSONL with parent, separate child, sibling, meta instruction, reasoning block, tool result, visible message, repeated blocks, multibyte text, CRLF and a partial last line. Use distinct private canaries; assert **exactly** the visible allowlist output for both providers.
2. Start from file size, scan backwards in fixed blocks for the first/older page; on new pages scan forward from the last complete line. Track byte offsets in binary. Return continuation across metadata-only windows. Specify merge precedence for duplicate user events/assistant blocks using the installed shape. Test two consecutive legitimate identical messages remain distinct.
3. Scope cursors to the validated source identity, file generation and direction. Detect replacement and truncation. Borrow the validated file handle for this call. The P8 resolver closes it in finally; use a spy in the reader test to verify the reader never closes a borrowed handle. Add an injected read counter verifying the byte limit even for an oversized record split over many windows. Sanitize tools with the existing summarizer. Group gaps and unknown content without rendering hidden bodies.
4. Run `node --test tests/operator-history.test.mjs tests/codex.test.mjs tests/public-contract.test.mjs`. Supply tests for equal timestamps, partial Unicode line followed by append, missing child, cursor from sibling, conflict, extra configured provider root and stale generation. The publisher and the existing tailer's memory footprint remain independent of history.

**Next assignments after P4**

**[P8](#p8) · Pair local operator and serve history**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P1 and P4 are accepted.

> Execute operator-cockpit/P8 in your assigned claude-hud worktree. Read P8 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P4 are present. Implement local pairing, authorized private history routes and source resolution. Verify LAN denial and graceful shutdown. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P8.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P5

**Prove Claude session capabilities** · Depends on P0 · S

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

The probe has to distinguish a message reaching Claude Code from an answer resolving the original native request.

**Scope.** Claude capability evidence only in P5 handoff. Read local version/help, Claude channel and permission-relay docs linked in PLAN. Use a throwaway native CLI session, a separate VS Code session and a synthetic repository. Keep current user work outside all experiments.

1. Record CLI/editor version, provider/auth category (including Bedrock if available), enabled plugin/policy and launch method. No credentials in evidence. Check supported channel enablement for this version/account. A remote-control feature in the native app does not demonstrate a HUD API.
2. In each surface ask the native agent to retain a unique marker, pause for a choice, then report it. Exercise independently: idle follow-up, redirect during a long harmless task, answer a native structured question, allow-once and deny a benign file read. Capture which channel owns delivery, the native request ID when provided, native resolution and subsequent activity.
3. Run first on ordinary uninstrumented sessions, then on an explicitly enabled session. Classify queued channel delivery separately from in-turn steering. Free-text delivery proves a prompt path only. Never test permission outcomes by changing the account’s approval policy.
4. If an approved channel or supported request path is unavailable, mark the affected cells unavailable/unverified with reason and continue the other cells. Avoid terminal automation, writing transcript JSONL, or starting a resumed session as evidence of continuity. Return the matrix and the smallest documented adapter boundary that worked. This output is a valid dependency even with zero writable cells.

**Next assignments after P5**

**[P9](#p9) · Implement verified Claude actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P1 and P5 are accepted.

> Execute operator-cockpit/P9 in your assigned claude-hud worktree. Read P9 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P5 are present. Implement only the Claude adapter capabilities demonstrated by P5. Prove target binding and observed-only fallback. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P9.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P6

**Prove Codex session capabilities** · Depends on P0 · S

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

The probe has to verify Codex thread ownership and interpret version-specific request and acknowledgement events.

**Scope.** Codex capability evidence only in P6 handoff. Read local `codex --version`, `codex app-server --help` and generated schemas. Generate into a temporary directory via `codex app-server generate-json-schema --experimental --out <temp-directory>`; use concrete method names and experimental negotiation for the installed version.

1. Start separate disposable CLI and VS Code test sessions. Identify thread and turn from supported native evidence. Determine whether a documented control connection addresses the *running owner* on Windows. The installed proxy mentions a Unix socket; help text alone cannot prove a Windows editor attachment. Keep any opt-in connected test separate in the matrix.
2. On a verified connection, initialize protocol and subscribe according to its schema. Test idle follow-up with turn/start, active guidance with turn/steer and expectedTurnId. Send a mismatched completed turn as a negative test through the fixture harness. Check subsequent native event shows the marker once on the same thread.
3. Capture a structured input and a benign approval request. Reply by the server request ID using the exact generated response shape. Verify both the accepted answer and the distinct case of withdrawal/native resolution. Record if a second client can observe but cannot answer. Test a client disconnect before acknowledgement.
4. Record a row per surface and action with version, opt-in, transcript identity, request ownership and evidence. A new app-server over stdio proves only its own sessions. If attachment cannot be established, stop that branch at observed-only. Supply synthetic event examples for P10.

**Next assignments after P6**

**[P10](#p10) · Implement verified Codex actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P1 and P6 are accepted.

> Execute operator-cockpit/P10 in your assigned claude-hud worktree. Read P10 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P1, P6 are present. Implement only the Codex adapter capabilities demonstrated by P6. Prove turn/request binding and observed-only fallback. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P10.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P8

**Pair local operator and serve history** · Depends on P1, P4 · L

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

Private history must enforce local authorization, one-use pairing and validated source access across runtime boundaries.

**Scope.** Private local access and history: new `src/operator/access.mjs`, `routes.mjs`, private resolver, `src/http/server.mjs`, `src/app/live.mjs`, `src/app/runtime.mjs`, `src/cli/commands.mjs`, demo runtime/config only as needed, `tests/operator-access.test.mjs`. P8-01 owns delivery mechanics in a separate file.

1. Wire an **optional** private service from the engine through runtime and CLI into createHttpServer. Preserve the public source/writer test doubles and existing hook/usage behavior. Lazily construct private readers and service on first private request. The demo engine uses synthetic records and a fake adapter only; prove this even when real profile directories exist.
2. Implement local pairing, access validation and ephemeral receipt epoch as specified. Generate code from the per-user CLI; ensure terminal, foreground task and background task agree on instance/port. Exercise file permissions and atomic consume in two concurrent requests. Reject a hostile Origin and a LAN peer even with a valid secret. For HEAD on private routes return method-not-allowed to avoid loading content.
3. Implement the private entity resolver as a closure over the engine registry, including Codex folded children and Claude alias conflicts. Open only validated source handles. The resolver closes each handle exactly once in finally after success, cancellation, parse error or rotation. Count opens and closes in the integration tests. Compose P4 history endpoints, capability lookup and private no-store responses. Permit faults to affect one request. A disconnected provider still permits local authorized history when readable.
4. Add injected dispatcher slots for action POST and receipt GET, returning unavailable until P11 registers P8-01. Fixture adapter enables route tests without a provider process. Verify graceful runtime shutdown aborts pending reads, closes private resources and invalidates credentials.
5. Run `node --test tests/operator-access.test.mjs tests/operator-history.test.mjs tests/runtime.test.mjs tests/hooks.test.mjs tests/public-contract.test.mjs`. Include CLI pairing round trip, wrong port, stale epoch, duplicate credential exchange, disabled provider, LAN read/write denial, origin/header checks and no secret in logs. Keep the existing unauthenticated local hook clients compatible.

**Next assignments after P8**

**[P7-01](#p7-01) · Deliver real history in cards and cockpit**  
Anthropic: Sonnet 5.5 / high · OpenAI: GPT 6.2 Sol / high  
Ready when P7 and P8 are accepted.

> Execute operator-cockpit/P7-01 in your assigned claude-hud worktree. Read P7-01 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P7, P8 are present. Connect the inspector to real private history in Cards and Cockpit. Verify live append, older-page scroll and bounded reads. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P7-01.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P8-01

**Validate, dispatch and reconcile actions** · Depends on P1 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

Concurrent submissions, ambiguous acknowledgements and retries require reasoning about exactly when dispatch can occur.

**Scope.** Independently deliver `src/operator/dispatch.mjs` and `tests/operator-dispatch.test.mjs`. Depends only on P1. Inject clock, epoch, adapter lookup and receipt storage so this lane does not edit HTTP routes or runtime.

1. After authenticating the caller and target, check for an existing matching receipt before validating the current turn for a new dispatch. An identical retry after the turn finishes returns the retained receipt. A different payload under the same ID returns 409. For a new action, validate the DTO, turn/request identity, expiry and session-scoped capability. Normalize inputs for fingerprinting and reserve ID plus pending request atomically before the first asynchronous provider call. Cap memory and live requests. Old epoch and stale target never dispatch.
2. Model pending → acknowledged/rejected/unknown. A definitive provider rejection and a transport timeout have different results. Reconcile delayed authoritative outcomes by ID. Keep an acknowledged message separate from evidence that the next turn actually ran.
3. Exercise same action twice, same ID/different body, two IDs answering one request, two pages racing, native answer first, late provider receipt, server restart and full journal. A fake adapter records the exact call count and target. On ambiguous delivery default to no replay. Provide P8/P11 an injectable factory and error DTO examples.
4. Run `node --test tests/operator-dispatch.test.mjs tests/cockpit-contract.test.mjs`. Handoff the trace for a timeout followed by retry with **one** provider call and one for a stale capability with **zero** calls.

**Next assignments after P8-01**

**[P11](#p11) · Connect providers and verify live actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P7-01 and P8-01 and P9 and P10 are accepted.

> Execute operator-cockpit/P11 in your assigned claude-hud worktree. Read P11 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P7-01, P8-01, P9, P10 are present. Integrate the dispatcher and verified providers. Publish original-session evidence and report cockpit, history and control outcomes separately. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P11.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P9

**Implement verified Claude actions** · Depends on P1, P5 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

The adapter must preserve Claude request identity and expose only actions demonstrated on each native surface.

**Scope.** `src/providers/claude/`, `tests/operator-claude.test.mjs` and setup notes in its handoff. Read P5's matrix and P1's interface fixtures. Work only on demonstrated cells.

1. Implement `capabilities(target)`, `dispatch(target, action)`, `reconcile(target, receipt)` and `close()` around the verified channel integration. Register opt-in instances by verified native identity; expose separate prompt, steering, question and single-request permission capabilities. Include version/account requirements in data returned to the operator.
2. Bind each reply to a specific live connection and pending native request. Handle channel replacement, timeout and native answers. A foreign session ID or unchecked request shape yields observed-only/unavailable. A queued message produces a queue/delivery acknowledgement; wait for observed work to claim progress.
3. Replay P5's scrubbed event fixtures and assert exact adapter output. Confirm opted-out/unsupported Claude and Bedrock configurations retain observation. If P5 proved no writable cells, deliver the minimal capability mapping and its tests; omit transport scaffolding for an unavailable protocol.
4. Run `node --test tests/operator-claude.test.mjs tests/hooks.test.mjs`. Handoff a minimal startup recipe for a verified connection, synthetic passthrough transcript and required runtime registration for P11.

**Next assignments after P9**

**[P11](#p11) · Connect providers and verify live actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P7-01 and P8-01 and P9 and P10 are accepted.

> Execute operator-cockpit/P11 in your assigned claude-hud worktree. Read P11 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P7-01, P8-01, P9, P10 are present. Integrate the dispatcher and verified providers. Publish original-session evidence and report cockpit, history and control outcomes separately. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P11.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P10

**Implement verified Codex actions** · Depends on P1, P6 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

The adapter must map HUD identities to Codex threads, turns and pending requests across disconnects.

**Scope.** `src/providers/codex/`, `tests/operator-codex.test.mjs` and setup notes in handoff. Read P6's matrix and the installed schemas.

1. Implement the provider-neutral adapter interface frozen in P1 using the connection type verified in P6. Run with a fake dispatcher so P10 can finish independently of P9. Track mapping between HUD `codex:` IDs and protocol IDs only in this adapter. Track pending requests by exact server request identity as well as expected turn. On reconnect reset stale handles and recompute capabilities.
2. Send idle prompts and active steering through the distinct operations proven by P6. For multiple questions preserve provider question IDs and allowed answer shapes. Restrict approval actions to a supported one-time decision. If the provider offers broader permission grants, leave them to the native client.
3. Parse asynchronous receipts, withdrawal, interruption and completion. A resolved notification clears the form; only label “Answered elsewhere” with evidence of an answer. Reject switch-to-new-thread fallbacks. Verified observation remains useful on detached editor sessions.
4. Run `node --test tests/operator-codex.test.mjs tests/codex.test.mjs` against scrubbed fixtures. Exercise native answer before submit, simultaneous threads, dropped transport and unsupported adapter version. Handoff minimum supported configuration plus observed-only cells.

**Next assignments after P10**

**[P11](#p11) · Connect providers and verify live actions**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P7-01 and P8-01 and P9 and P10 are accepted.

> Execute operator-cockpit/P11 in your assigned claude-hud worktree. Read P11 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P7-01, P8-01, P9, P10 are present. Integrate the dispatcher and verified providers. Publish original-session evidence and report cockpit, history and control outcomes separately. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P11.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P11

**Connect providers and verify live actions** · Depends on P7-01, P8-01, P9, P10 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

The runner reconciles browser, server and provider behavior and verifies each claimed capability in the original session.

**Scope.** Final integration in runtime/provider registry, `src/web/inspector/client.mjs`, CLI/README setup and `tests/operator-control-flow.test.mjs`. Inherit shared files only after their owners deliver.

1. Wire P8-01 dispatcher and provider factories; resolve the active provider and connection for the targeted entity. Replace fixture client writes with real endpoints. Register only advertised cells; on unsupported hosts expose public activity, private history if available and native folder navigation where valid.
2. Pair a local operator; read, submit, refresh and reconcile a receipt using both views. Switch to another agent before the first acknowledgement. Action outcomes belong only to the original target. Disable input on lost live state until capabilities are revalidated. Recover expired credentials without implicit replay.
3. Run a harmless original-session test on every combination marked demonstrated; record command, provider version, UI action, provider acknowledgement and next observed state. Where an interactive native client is unavailable on this runner, keep the cell explicitly unverified until an equipped runner proves it. Publish the matrix beside the actual setup instructions.
4. Run `node --test tests/operator-control-flow.test.mjs tests/operator-dispatch.test.mjs tests/operator-claude.test.mjs tests/operator-codex.test.mjs`. Test full flow with provider fakes on CI and record native evidence separately. Prepare a combined revision for P12. Report the cockpit, real history and live control as three independent outcomes. If neither provider demonstrates a native write, mark live control unverified and release only the proven observation/history features. Name the missing native capability and the evidence needed to revisit it.

**Next assignments after P11**

**[P12](#p12) · Verify packaged build and close**  
Anthropic: Opus 5.5 / high · OpenAI: GPT 6.2 Astra / high  
Ready when P11 is accepted.

> Execute operator-cockpit/P12 in your assigned claude-hud worktree. Read P12 in docs/plans/operator-cockpit/PLAN.md and the shared CONTRACTS.md in that directory. Verify the accepted inputs from P11 are present. Independently verify the combined release archive, initial-load budget, real GPU path, privacy and supported native controls. Record outstanding gates. Follow the phase scope and run its exit checks. Write docs/plans/operator-cockpit/handoffs/P12.md with the revision, results and limitations. Return the eligible next prompts and both runner choices to the coordinator.

#### P12

**Verify packaged build and close** · Depends on P11 · M

| Anthropic model / effort | OpenAI model / effort |
|---|---|
| Opus 5.5 / high | GPT 6.2 Astra / high |

Independent verification spans the archive, performance baseline, real GPU path, privacy checks and both provider integrations.

**Scope.** Independent verification, archive evidence, final board status and cross-feature regressions. Reuse commands in README and `docs/ARCHITECTURE.md`. Use a fresh combined revision from P11. A worktree with uncommitted vendor files will not be reproduced by git archive.

1. Run `node hud.mjs selftest`, `node tests/run-all.mjs`, `node tests/browser-smoke.mjs`, `node tests/tools/stream-size.mjs --demo=dense --seconds=30`. Then package the combined revision with git archive to a unique temp path. Extract to a path with a space, launch isolated demo and isolated live fixture instances and drive the **extracted** entry. Record Node version, commit and archive checksum.
2. Validate initial request graph, lazy entry, direct link, missing asset, unavailable WebGL, context loss, ten toggles, hidden tab and fallback on the archive. Capture native GPU renderer and p95 orbit frame time. Compare cold baseline using P1's measured observable and identical conditions. Keep pass/fail separate for startup, GPU availability, steady scene performance and fallback. If threshold repeatedly fails, return evidence to P2 for rendering or P7 for routing/imports.
3. Re-run the screen coverage matrix against a single frozen snapshot. Exercise keyboard-only answer, reduced motion, expired selection, discreet reload/exit, compact rows, duplicate titles, while-away summary and background notifications. Inspect DOM text/ARIA/title, URL, console and mock notifications for synthetic canaries. Measure waiting identification with the owner’s laptop if available; explicitly mark hardware/user checks outstanding otherwise.
4. Run private boundaries and race tests, verify conditional capability matrix, turn evidence, real package license/assets and ordinary 2D smoke. Publish a table of expected, actual, evidence and owner for failures. Revert/redeploy through the established release process only if separately authorized. An unresolved required performance or privacy gate keeps that milestone open; a documented unsupported provider cell disables only that capability.

**Final handoff**

P12 closes the implementation sequence. Send the owner the archive revision, release-check results, verified provider matrix and any open gates. For a failed required gate, return the failing check to the phase owner listed above with its existing model choices. Deployment requires a separate owner decision.

## Handoff, merge and recovery

Every handoff states ID and revision, inputs/versions, changed paths, commands with results, failing cases fixed, remaining limitations, and exact next consumer. Attach synthetic captures or fixture IDs; scrub home directories and credentials. A passing mock result and a verified native result get separate rows. The coordinator checks that each dependency revision is present before accepting a handoff. Re-run the named regression checks on the combined revision whenever two branches touched an integration seam sequentially.

| If this happens | Assigned response |
|---|---|
| A field needed by two lanes is ambiguous | P1 coordinator adds one input and expected output to the contract fixtures, updates CONTRACTS and distributes the same revision. Existing public snapshot contract remains authoritative. |
| Agent lacks a GPU, editor account or provider entitlement | Finish deterministic tests and public/fallback behavior, mark that exact native check unverified, and route the evidence request to a capable lane. Never invent a passing result. |
| A shared file is needed ahead of its owner | Add a local fixture/injected interface inside the assigned module and send the receiving owner the expected call. Only its owner edits the production composition point. |
| One provider cannot act on a native session | Accept the probe result, ship observation/history for that cell, and continue the other provider and independent milestones. |
| Whole-repo checks fail on an unrelated baseline issue | Reproduce on the recorded base revision and report separately. A newly introduced regression goes back to its phase owner. |

### Provider references for the probes

Claude channels require explicit session opt-in and custom channels have preview distribution constraints. Permission relay and free-text replies require different evidence. Include deployment eligibility in the Claude matrix. [Claude Code channels](https://code.claude.com/docs/en/channels)

Codex App Server supports steering a specific in-flight turn and matching server requests to replies. A local rollout alone establishes observation. Test ownership and attachment on the installed editor and CLI separately. [Codex App Server](https://developers.openai.com/codex/app-server/)

## Fast execution with four slots

Start all four independent kickoff lanes: P1, P1-01, P5 and P6. As slots free, prioritize P4 after P1 and P2/P3 after P1 plus the visual study. Start P7 as soon as scene and inspector pass, and P8 as soon as history passes. Use P8-01 as an independent server assignment after P1. Give free slots to eligible provider adapters or P8-01 without displacing the visual and history milestones. P7-01 joins the browser and private server as soon as P7/P8 pass. Assign P11 after real history and the dispatcher and both adapter handoffs, including documented observed-only outcomes.

The earliest **interactive visual preview** follows the longer of P1 and P1-01, then the longer of P2/P3, then P7. It uses fixture history for testing and real public activity for normal use. **Private history** has its own deliverable at P7-01. **Live controls** additionally depend on the longer provider branch and P11 integration. If one provider cannot attach to an existing surface, publish that cell as observed-only and advance the verified combinations. Adding support by launching agents through the HUD would be a separate product decision.

Use one isolated worktree per active lane, one coordinator for board edits and integration, unique OS-assigned test ports, temporary profiles and `HUD_NO_AUTOINSTALL=1`. Agents return handoffs with their change reference, gate evidence and any contract deviations. Merge the P1 contract first. P2/P3/P4/P9/P10 own new modules in disjoint directories. P7 owns shared browser entry points and packaging, P8 owns shared server entry points and P8-01 owns the independent dispatcher, and P11 takes those seams only after handoff. A contract change goes through P1’s coordinator and updates the fixtures before consumers adopt it.

## Release checks

- Compare main dashboard against P1 on the same hardware, browser, viewport and dense fixture, alternating 20 cold loads per build. Record transferred bytes, requests, median and p95 time to first usable HUD, idle CPU and SSE frame size. Proposed regression threshold is 5% on median and p95; repeat a noisy run and investigate persistent deltas. Hard gates are zero 3D/history requests on ordinary entry and zero additional public streams. Report actual measurements.
- In cockpit, measure p95 frame time while orbiting a dense scene (proposed target 33 ms on the operator’s laptop), then verify idle/hidden behavior. Expect bounded retained resources after warm-up across ten cycles. Respect reduced motion and recover from context loss or GPU unavailability.
- With a keyboard only, locate the oldest waiting agent, read its last exchange, answer, and return to the previous view. With a dense scene at normal laptop size, the operator should be able to identify the waiting state within two seconds. Inspect discreet display before and after new events for leaked identifying text.
- Run `node hud.mjs selftest`, `node tests/run-all.mjs`, and the repository’s Edge smoke and archive checks, including native GPU manually if browser smoke uses software rendering. Exercise loopback and LAN, active and ended sessions, both providers and an unsupported client. Store only synthetic or scrubbed evidence.
