# Contracts and resolved design questions

Use this alongside the phase cards. The examples are synthetic. Routes, response shapes, and limits below are implementation targets. Existing code references are relative to the repository root. P1 translates these decisions into fixtures. If a measured runtime contradicts one, attach the smallest failing case and revise both this document and the fixture together.

## Baseline and compatibility

The planning inspection used commit `5262553`, Node 26.7.0, Claude Code 2.1.312 and the VS Code extension's Codex CLI 0.171.0-alpha.13.2 on Windows. Keep the project's Node 22 minimum and native ESM distribution. Run compatibility checks with Node 22 as well as the development version. The installed Codex generator emitted TurnSteerParams, ToolRequestUserInputResponse and CommandExecutionRequestApproval types with experimental schemas enabled. Its CLI lists an app-server proxy. These findings establish available protocol vocabulary. Ownership of an existing native session and ability to reply on its connection require a separate live test. Claude help advertises Remote Control and print-mode input. Ordinary help on this installation did not list channels. Record actual opt-in availability at P5. [Codex protocol](https://developers.openai.com/codex/app-server/) · [Claude channels](https://code.claude.com/docs/en/channels)

## Selection and information boundaries

1. Use a selection object `{sessionId, agentId: null|string}` throughout the browser. Session IDs already include `codex:` for Codex. Preserve exact strings through JSON; compare tuples, never split on punctuation. Opaque HTTP key is base64url of UTF-8 JSON array `[sessionId,agentId]`. Validate the decoded shape, cap the key at 2 KiB, and authorize against the live registry. Encoding gives identity transport only.
2. Claude publishes `sub.agentId || sub.toolUseId` through `subView`. Internally resolve both known aliases on the same parent. If a placeholder changes ID and the server cannot prove the alias, close its pending composer and show “Select the updated agent”. Never carry a write across a guessed identity. A Codex child can appear nested under its root while its rollout is attached to a separate internal session. Validate its recorded ancestor chain before opening that child's source.
3. Resolve source files exclusively from attached server-side records. Restrict real paths to the configured transcript/rollout roots, verify the opened file represents the resolved generation, and close the descriptor on abort or rotation. Two profiles claiming the same identity with different sources make private access ambiguous. Return unavailable until the conflict resolves. Opening the parent never substitutes for a missing child.
4. Public snapshots, feed, recordings, phone notifications and hook payloads keep their current field policies. Public events never contain private DTOs, tokens or confirmations. Discreet display concerns this browser's display and notifications. Browser extensions, OS capture, and separate LAN viewers have their own contexts.

## Browser lifecycle

| Event | Required transition | Failure case to test |
|---|---|---|
| Open normal HUD | Keep the existing store and transport. Toolbar handler is lightweight. | Cold load discovers zero cockpit assets, inspector modules, private routes or WebGL contexts. |
| Enter from dashboard | Save originating URL, view preference, project, opener identity and scroll offsets in memory; push one cockpit history entry. Close the outgoing view. Immediately mount a status, fallback list and exit control. | Double click while loading produces one navigation. |
| Scene import resolves | Compare a mount generation, lifetime signal and host connection before creating a renderer. Register cleanup before subscribing to updates. | Enter → leave → enter before import resolves mounts only the last scene. A rejected import leaves the list usable. |
| Explicit exit or browser Back | Restore originating entry via Back when the app created it. On direct entry replace the cockpit URL with the corresponding dashboard URL, retaining the current project. For entry from the dashboard restore the originating project, even if the operator selected another project in the cockpit. On popstate render from location without pushing. | Explicit `?view=cards`, URL project and saved Network preference survive a round trip. Removed origin row falls back to the view selector. Browser Forward works. |
| Tab hidden, page cached, GPU lost | Cancel pending frame, pause private refresh. On visibility or pageshow revalidate state. On context loss retain HTML selection and show fallback with an explicit retry. | Return from the browser back/forward cache has one store. Retry has one canvas. Reduced motion still conveys status. |
| Discreet enabled | Close private panel, abort reads, discard drafts and local response buffers, cancel queued speech, suppress identifying browser notifications. Use stable tab-local aliases and allowlisted numeric/status fields. Keep focus/filter identity in memory. | A late response, tooltip, title, URL project parameter or queued utterance cannot reintroduce names. While discreet, remove identifying project query from the displayed URL and restore on opt-out. Carry the preference across route changes and reload using tab-scoped storage; filter the dashboard display on exit or explicitly keep the user on a masked return surface until they choose to reveal. |

Choose a masked return surface for v1. Exit from discreet cockpit presents **Return to dashboard and reveal details** and **Stay discreet**. Browser Back to a HUD route while discreet lands on a masked shell with the same choice before any dashboard DOM or announcements mount. Never trap Back to another site. A masked reload ignores identifying query parameters before first paint. Navigation history entries store only non-private handles; no transcript, drafts or permission text.

The page shell owns one notification/away controller across dashboard and cockpit routes. Move the previous snapshot comparison, away tracking and visibility listener out of the dashboard mount; inject the outputs into the active view. Reconnect first frames reseed state; suppress historical duplicate announcements. Separate change detection from a clock tick: `snapshot.now` changes often. Compare projected node properties and dirty geometry only when visible data or camera changes. Elapsed labels can use the HTML timer. Coalesce all invalidations into at most one outstanding animation frame.

## History and capability wire examples

All paths below use `/api/operator`. Require a locally paired session, never permit cross-origin credential access, and return `Cache-Control: no-store`. Successful reads return 200. Errors have the stable shape `{"code":"stale_request","message":"This question has closed."}`. No raw provider error bodies.

```json
{
  "entries": [
    {"id":"e1","at":1700000000000,"kind":"user","text":"Check the invoice export."},
    {"id":"e2","at":1700000000500,"kind":"tool","text":"Read · export.mjs"},
    {"id":"e3","at":1700000001000,"kind":"assistant","text":"Which date should the export use?"}
  ],
  "before":null,
  "after":"cursor-newest",
  "gap":null
}
```

- GET `/sessions/{key}/history` returns ascending source order. For older pages pass `before`; for catch-up pass `after`. Reject both together. Return 40 entries maximum, scan at most 512 KiB per request, cap a displayed entry at 8 KiB UTF-8 with an explicit truncation marker. Encode generation, direction, entity and offset in an opaque integrity-checked cursor. An initial page anchors to its EOF snapshot; the forward boundary is after the last **complete** line. A partial final UTF-8 record is retried when complete. Scan blocks by byte offset and split on LF before UTF-8 decoding. Never emit half a code point or parse an oversized record as several messages. Continue advancing through oversized or filtered records across bounded pages. Return a visible gap and fresh-page option on stale generation (409), and an empty success for a valid empty conversation.
- Claude: allow visible user text and assistant text blocks. Filter meta/compaction, tool-result content, images, thinking and hidden blocks. Fold repeated assistant entries using provider message/block identity where available. Codex: select a canonical user-visible event family per supported version, use a fixture for duplicate event/response representations, and omit developer/system/context, reasoning and tool outputs. Use the existing redacted tool summarizer on allowlisted tool fields. Unknown format returns a gap/unavailable state. Representing an unreadable format as an empty conversation hides errors.
- Private capabilities response fields are `epoch, revision, actionWindow, available[], activeTurnId, pending[], reason`. Each pending request includes its own ID, turn, kind and actual display fields. For questions return an array of question IDs, labels, choice IDs, choice count bounds and whether free text is allowed. For permission return the operation, scope and allowed single-request decisions. Support concurrent pending requests. When a provider cannot represent a pending request faithfully, omit its submit capability and offer the native surface. The opaque actionWindow signs the epoch, target, revision and expiry and travels back on each command. It is issued only for supported writes.
- A display-only session with history can return `{"epoch":"i1","revision":"v1","actionWindow":null,"available":["history"],"activeTurnId":null,"pending":[],"reason":"observed_only"}`. Map unavailable source to 404, expired cursor or stale target to 409, bad shape to 400, unauthorized to 401/403, oversized body to 413 and temporarily disconnected provider to 503. A private endpoint never redirects to a transcript path.

### History clarifications accepted with P4 (2026-11-27)

These refine the history contract above. Details and rationale are in [the P4 handoff](handoffs/P4.md).

- `gap` is `null` or `{records, reasons}`. `reasons` counts skipped records by `compacted`, `malformed`, `oversized`, `overflow` and `unknown`.
- An entry cut at 8 KiB carries `truncated: true`.
- An older page returns `after: null`, and a newer page returns `before: null`. The browser keeps the initial page's `after` for catch-up. The non-null `after` in the `historyPages.older` fixture is illustrative only.
- Reader error codes: `bad_request` 400, `invalid_cursor` 400, `stale_cursor` 409, `unavailable` 404.
- `source.provider` names the transcript format (`claude` or `codex`), not the model provider. P8 maps `anthropic` and `bedrock` targets to `claude`, and `openai` targets to `codex`.

## Operator access and action delivery

A paired browser session establishes control on the local PC. The initial read-only cockpit opens immediately. Pair at the first private action, including opening real conversation history. For fixture demo history use synthetic sources only. Implement the pairing command in P8, document it in P11, and exercise it with a temporary profile.

1. Use `node hud.mjs operator pair` to issue a single-use random 256-bit code with a five-minute expiry for the local installation and port. Support the existing background Windows task by issuing the code from a second CLI invocation. Exchange through a per-user application-data directory with verified user-only access (on Windows use the user profile ACL and verify before writing; on POSIX use 0700/0600). Place only a digest, expiry and intended local instance identifier in the ticket file. Obtain the instance nonce from a loopback-only route. Create atomically, consume atomically before issuing a session, and reject expired or replaced tickets. Print the secret only in the invoking terminal. Keep code and credentials out of URLs, public CLI startup output, recordings and handoffs. If private storage permissions cannot be established, keep the public HUD running and explain the pairing failure.
2. Pair via JSON POST to `/pair`. Require exact loopback host, socket peer, matching Origin including port, same-origin fetch and JSON. Reject cross-origin, missing Origin on state-changing browser endpoints, forwarded headers and broad LAN hostnames. Bound pair attempts and expire unused tickets. Issue an HttpOnly, SameSite=Strict, host-only, operator-path cookie and a tab-readable anti-forgery token retrieved by authenticated same-origin bootstrap. Tie both to this runtime instance; localhost cookies alone do not distinguish ports. Tokens remain in memory except the cookie. Do not weaken the existing separate hook endpoint's origin rules.
3. POST `/sessions/{key}/actions` accepts `{actionId,epoch,revision,actionWindow,kind,turnId,requestId,payload}`. Use a UUID for the action. Validate up to 16 KiB JSON. A prompt or steer has `{text}`; an answer has `{answers:[{questionId,choiceIds,text?}]}`; a permission has `{decision:"allow-once"|"deny"}` matching its kind. The server rechecks live ownership, allowed shape and target at dispatch. Capability revision tracks meaningful turn/request changes, not every timer tick.
4. Before awaiting the provider, reserve the action ID with target, body fingerprint and an expiry. For an authenticated target, look up a retained receipt before applying current-turn validation to a new action. An identical retry after turn completion returns the receipt without another call. Serialize competing replies to the same request. Identical retries return the original receipt; mismatched reuse returns 409. Two different IDs for the same pending decision can dispatch at most once. GET `/sessions/{key}/actions/{actionId}` returns pending, acknowledged, rejected, or delivery-unknown. After timeout, status remains unknown until reliable provider evidence arrives. UI text “resumed” requires a separate observed state transition. `serverRequest/resolved` alone also covers withdrawal.
5. Keep a bounded per-instance journal (proposed 1,024 receipts, 30-minute recovery window). Store receipts, target and a keyed digest, never the action text. On overflow refuse new writes while in-flight or replayable entries occupy the limit. Issue commands with a server-issued expiring action window tied to epoch and revision; reject retries outside the window even after receipt expiry. After restart, reject old epoch writes and display “Check the native session before sending again.” The client stores only opaque receipt/target handles in tab session storage so refresh can reconcile. It never automatically retries a write or recreates an action on reconnect.
6. Operator routes and adapters initialize on first private use. Provide no adapter and safe observed-only capabilities in demo/live until explicitly connected. Opening a chat, loading the dashboard, or inspecting a rollout must never start a paid agent session. Supporting provider-controlled launches later is a separate decision.

### Operator access accepted with P8 (2026-11-27)

These record what P8 built. The full error list and test evidence are in [the P8 handoff](handoffs/P8.md).

- **Pairing:** `node hud.mjs operator pair [--port=<n>]` writes a one-time ticket (code digest, instance, port, five-minute expiry) to the per-user operator folder and prints the code only in that terminal. The folder must be readable only by the user, SYSTEM and Administrators. The HUD restricts a folder it just created; an existing folder is only checked. A failed check returns 503 `pairing_unavailable` while the public HUD keeps running.
- **Routes** under `/api/operator`: `/instance`, `/pair` (exchange the code once), `/bootstrap` (same-origin anti-forgery token), plus the history, capability, action and receipt routes. The service loads on the first request. Without it every `/api/operator` path is 404.
- **Session:** the HttpOnly, SameSite=Strict cookie `hud_operator_<port>` and the anti-forgery token are held in memory, so a restart invalidates them. Sessions last 12 hours, with at most 16 kept.
- **Request checks:** loopback peer and Host only, same Origin (required on POST), no proxy headers, and `X-HUD-Operator` on every private route (`1` on instance/pair/bootstrap, the token elsewhere). Responses are never cacheable and never carry CORS headers.
- **Extra statuses:** 405 for HEAD/OPTIONS, 415 for a non-JSON pair, 429 for too many attempts, 503 `actions_unavailable` until a dispatcher is registered. An action body is size-checked (413) before its target is resolved.
- **Targets:** a Claude subagent's resolved target carries `nativeAgentId`, because it has no session ID of its own.
- **P8-01 seam:** P8 lazily calls `createDispatcher({clock, epoch, resolveAdapter})` once. `submit` returns a receipt, `receipt` returns a receipt or `null`, and errors are thrown as `{code, message, status}` with provider text removed. Issuing and signing `actionWindow` is open for P8-01 and P11.
- **Public projection note:** a Codex session's first user message already appears publicly as its title. Do not assume user prompts never appear in the public snapshot.

### Scene interface accepted with P2 (2026-11-27)

`mountScene` keeps the frozen signature. P2 added optional, additive members, listed in [the P2 handoff](handoffs/P2.md):

- Actions: `getSelection`, `subscribeSelection`, `getDiscreet`, `subscribeDiscreet`.
- Option: `loadThree`, an injectable loader for tests.
- The returned `close` also exposes `setSelection`, `reset`, `retry`, `refresh`, `stats`, `screenOf`, `worldOf`, `keyOf`, `getMode` and `root`.
- Three.js 0.180.0 (MIT) is vendored under `src/web/vendor/three/` and loaded only by dynamic `import()`. P7 registers it and excludes `src/web/cockpit/harness/` from the allowlist and the package.
- **For P7:** the narrow 390 px composition from P1-01 is not built in 3D. P7 decides what narrow widths mount, for example a list-only mode. The scene does not handle Escape.

### Inspector interface accepted with P3 (2026-11-27)

`mountInspector(host, {selection, store, client, onClose, signal, ...}) => {select, close, root, inspect}` keeps the frozen shape. `createEntityCard` is the shared public card. Details are in [the P3 handoff](handoffs/P3.md).

- Optional additive members: `getDiscreet`, `subscribeDiscreet`, `restoreFocus`, and `onClose({reason, selection})`.
- A draft for a finished turn or a closed request is discarded with a notice, not retargeted.
- Once "Show conversation" is pressed, it stays open across selection switches until close or discreet.
- The panel handles Escape in the capture phase on `document` and calls `preventDefault`. The shell's Escape handler must check `event.defaultPrevented`.
- The panel switches to the sheet layout below 600 px. P7 owns placement and width, and excludes `src/web/inspector/harness/` from the allowlist and the package.

## Interfaces to freeze in P1

Use plain JS modules and JSDoc. The names below are the common seam between worktrees. A local implementation can introduce private helpers without changing callers.

The frozen public exports are `snapshots`, `timeline`, `selectionKey`, `expected` and `createFixtureStore(initialFrame?)` in [public.mjs](../../../tests/fixtures/cockpit/public.mjs). The store exposes `getSnapshot()`, `getConnection()`, `getServerTime()` and `subscribe(listener)` like the existing HUD store. Tests drive it with `setFrame(frame)`. A frame carries the snapshot, the expected selection and the connection status. A reconnect frame can reuse the last snapshot.

[private.mjs](../../../tests/fixtures/cockpit/private.mjs) exports keyed history DTOs, cursor examples, capabilities, commands, receipts, server-resolved fixture targets and `deliveryCases`. The documents and fixtures use `nativeSessionId` for the adapter's verified native session or thread ID and `connectionGeneration` for its current connection. `createFixtureClient(overrides?)` and `createFixtureAdapter(overrides?)` accept scripted async results. Tests can hold a history response across selection changes and inspect the adapter's `calls` array. The dispatcher owns idempotency, so use `deliveryCases` as expected results and assert provider calls at the dispatcher seam.

| Producer → consumer | Interface | Caller responsibilities |
|---|---|---|
| P7 → P2 | `mountScene(host, {store, actions, motion, signal}) => close`. Actions include `select({sessionId,agentId})`, `getProject()` and `subscribeProject(listener)`. | Shell owns module loading and outer signal. Scene owns renderer, selection hit targets and their teardown. Close is synchronous and safe twice. |
| P7 → P3 | `mountInspector(host,{selection,store,client,onClose,signal}) => {select(selection),close()}` | Reuse one inspector per active page. A new selection invalidates earlier requests. A project-only event has no private entity target. |
| P7-01/P11 → P3 | `client.history(selection,{before?,after?,signal})`, `client.capabilities(selection,{signal})`, `client.submit(selection,command,{signal})`, `client.receipt(selection,actionId,{signal})` return promises for private DTOs. | Client owns encoding, credentials, pairing expiry and errors. Aborting a fetch may cancel display only; action delivery may already have happened. P7 preview injects a public-only client with an unavailable reason. |
| P4 → P8 | `readHistory({source,selection,before?,after?,signal}) => Promise<HistoryPage>`. Source is a trusted server reference with provider, generation and opened file handle. | Resolver owns opening, validation and finally closing the handle. Reader borrows it for the call, owns bounded byte reads, cursor validation and decoding. |
| P9/P10 → P8-01 | `adapter.capabilities(target)`, `dispatch(target,action)`, `reconcile(target,receipt)` return promises. `close()` releases the connection. | Target is server-resolved with provider, native thread identity and connection generation. An adapter cannot choose another target on failure. Unknown provider capabilities default to an empty set of writes. |
| P8-01 → P8/P11 | `createDispatcher({clock,epoch,resolveAdapter}) => {submit(target,command),receipt(target,actionId),close()}` | P8 accepts a fixture or unavailable implementation. P11 injects the actual dispatcher. Validate authentication in HTTP and target/turn/request validity again at dispatch. |

### Common fixture sequence

Build one deterministic story and use it at all layers. At T0 two sessions share the displayed title “Export”; only session A has a child. Use different private marker strings for A, its child and B. At T1 A requests a two-choice answer, B stays busy. At T2 the operator opens A, then switches to B before A's history resolves. At T3 the native client resolves A's request while a stale HUD form exists. At T4 a new request from A receives a HUD answer and the provider drops the connection before the browser gets its receipt. At T5 reconnect returns the authoritative outcome.

| Assertion | Expected result |
|---|---|
| Opening ordinary dashboard at T0 | No private API activity or 3D asset downloads. Both sessions remain distinct despite identical labels. |
| Selecting B at T2 | B’s transcript only. No A or child marker in B’s panel, title or ARIA description. |
| Submitting A’s old form after T3 | Stale response and zero new adapter calls. Never redirect to A's current turn or to B. |
| Refresh/retry at T4 | Same action identity and at most one dispatch. Unknown status remains visible until evidence arrives. |
| Observation at T5 | Confirm delivery only from provider evidence and resumption only from observed work. The public snapshot contains none of the private marker strings. |

Use an additional clean branch of the fixture for the happy path where the HUD answer is delivered immediately. Test permission, idle-prompt and steer separately; each binds to a different combination of target fields. Store exact fake timestamps in fixtures so ordering assertions do not depend on machine speed.

## 3D distribution and performance decisions

Use the native ESM build of Three.js 0.180.0 as the reproducible starting pin, with its transitive local build modules and MIT license. Record release, exact files and hashes in the scene handoff. Import the relative vendor path from the deferred scene module. Use built-in geometry, instancing where measured, HTML labels, directional light and emissive materials. Implement pointer orbit with clamped tilt, zoom and reset for v1. Avoid bare addon imports, postprocessing, external textures, web fonts unique to this view and a runtime CDN. Cap device pixel ratio at 1.5 initially; lower to 1 if the P12 budget fails before reducing meaningful labels. Keep camera, layout and readable waiting list available on integrated graphics. [Three.js release manifest](https://raw.githubusercontent.com/mrdoob/three.js/r180/package.json)

The existing smoke harness passes `--disable-gpu`. Keep that regression suite for HTML/fallback. Add a separately selectable GPU-enabled path and report the actual WebGL renderer, including software rendering. An archive can pass the fallback test with every vendor file missing; the graphics path must assert a real scene frame, successful module requests and a working selection. On exit dispose owned geometries, materials, textures, render targets, renderer and observers, cancel frames, and remove the canvas. Browser modules may remain cached; resource gates count active work and bounded retained GPU objects after warm-up.
