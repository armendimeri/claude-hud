# P3 `client-data` handoff

**Date:** 2026-11-26 · **State:** handed-off · **Model / effort used:** Codex (GPT-6, session effort) ·
**Next:** P4

## Summary

The dashboard uses a shared browser store for complete snapshots, connection state, server time, and recent feed.
The browser transport owns EventSource and the full-state fetch. The away service uses that fetch on visibility
return and stream recovery. Cards and Network share the existing page connection.

## Exit gate

- [x] A fixture-driven test covers full and partial states, empty plans, plan-only events, repeated feed lines,
  malformed frames, stale callbacks, and reconnect with a changed snapshot. `node --test tests/browser-store.test.mjs`
  passed all five tests, including feed order and bounds, the retry lifecycle, away refresh, and selectors.
  [Store tests](../../../../tests/browser-store.test.mjs)
- [x] The browser passes both away-summary return paths, manual retry, connection indicators, and feed behavior.
  Switching view or project does not open another stream. With `HUD_NO_AUTOINSTALL=1`, `node tests/browser-smoke.mjs`
  passed against the staged P3 distribution on Edge `158.0.4370.33`. The test exercised an actual server restart and
  counted EventSource instances while switching view and project. Controlled feed lines verified hover pause,
  duplicate suppression, grouped tools, redraw order, and delivered history across manual retry. All 11 layouts
  passed and the suite captured 24 screenshots with no browser runtime exceptions.
  [Browser smoke](../../../../tests/browser-smoke.mjs),
  [Cards on phone](../../../../.hud-tmp/p3-browser/.hud-tmp/smoke-cards-390x844.png),
  [Away summary](../../../../.hud-tmp/p3-browser/.hud-tmp/smoke-away-summary-1440x900.png),
  [Gallery](../../../../.hud-tmp/p3-browser/.hud-tmp/smoke-design-1024x768.png),
  [Kiosk](../../../../.hud-tmp/p3-browser/.hud-tmp/smoke-kiosk-1920x1080.png)

`node hud.mjs selftest` reported `all checks passed`. `node --test tests/` passed 55 of 55 with no skips on
Node `v22.12.0`. All browser modules and the smoke script passed `node --check`. An isolated HTTP probe verified
GET and HEAD with JavaScript MIME types for all four data assets and a 404 for an unlisted data path. The phone
Cards and desktop away-summary captures were reviewed.

## Files changed

| File | New / changed | What |
|---|---|---|
| `src/web/entry.mjs` | Changed | Owns one store, one transport, and the away service for the dashboard. |
| `src/web/legacy-hud.mjs` | Changed | Renders complete data and consumes store feed history and delivery notifications. |
| `src/web/data/store.mjs` | New | Validates wire frames, publishes snapshots and connection state, tracks server time and feed history. |
| `src/web/data/transport.mjs`, `src/web/data/away.mjs` | New | Connect to the existing endpoints and coordinate the return summary. |
| `src/web/data/selectors.mjs` | New | Project filters, session and plan lookups, and Activity rows with work joins. |
| `src/http/assets.mjs` | Changed | Registers the four new browser modules. |
| `tests/browser-store.test.mjs`, `tests/browser-smoke.mjs` | New / changed | Prove the data contract and the dashboard behavior. |
| `docs/plans/hud-architecture/STATUS.md`, `docs/status.md` | Changed | Record the handoff and workflow status. |

## Contract as built

- `createHudStore({ transport, clock? })` returns `getSnapshot()`, `getConnection()`, `getServerTime()`,
  `subscribe(listener)`, `reconnect()`, and `close()`. Call `reconnect()` to start the first stream. The snapshot
  is initially `null`. Treat returned snapshots and arrays as read-only. `getConnection()` returns
  `{ status, lastAt }`. `lastAt` is in browser time. `getServerTime()` applies the state-derived clock offset.
- `subscribe(listener)` returns an unsubscribe function. The listener can re-read the full snapshot on each
  notification. Updates have `type: 'snapshot'`, `type: 'feed'` with `line`, or `type: 'connection'`.
  On stream open, a connection update carries `resumedSince`, either the browser-time outage start or `null`.
  The connection may be `live` before the first full frame, so view eligibility reads the snapshot.
- A browser or fixture transport implements `connect({ open, error, frame })` and returns stream cleanup.
  `error(permanent)` distinguishes a closed stream from native retry. `frame(type, data)` takes the wire name
  and JSON text. The away service calls `fetchSnapshot({ signal })` through the transport.
- `selectActivityRows(snapshot, project)` returns ordered `{ session, work }` rows using the server's session
  and work order. Each work entry has `{ planKey, plan, item, node }`. The plan or node can be undefined when a
  linked item is absent from the current plan data.

## Deviations from the plan

P3 extends the P2 asset allowlist in `src/http/assets.mjs` to serve the four new modules. The P2 handoff calls for
this registration when browser files are added.

## Decisions taken

- Use the existing 200-line ticker limit for shared history. Reuse the same feed array when all lines in a
  reconnect frame were already delivered so the ticker can keep its grouped rows and hover state.
- Wait for a valid full state before processing a connection's plan, feed, or partial state frames. Native
  EventSource retries transient failures. The store schedules a replacement after 3 seconds for a closed source.
- Advance the last SSE state clock for plan-only updates and use the full-state fetch's server time for away
  cutoffs. Keep the activity chart driven by the page clock between server pushes.

## Known issues

The first browser runs exposed a strict-mode syntax error and an activity smoke probe using the previous
clock helper. Both were corrected, and the staged suite passed on the corrected sources. The owner’s deployed HUD
and live performance were outside this verification.

## Out-of-scope findings

The P1 hook timing overage and 0.3 live memory gate remain recorded in the baseline handoff.
[P1 handoff](P1-baseline.md)

## Changes to earlier items

Accepted P2 after all four public-contract tests passed and committed it as `61cf0d7`.
[P2 review](P2-assets.md#review)

## Lasting knowledge

Mount views against the existing page store. Use the snapshot and connection getters after subscribing. Add
browser modules to the explicit asset allowlist so both the staged and installed trees can import them.

## Next agent

Run `node --test tests/browser-store.test.mjs` with `HUD_NO_AUTOINSTALL=1` in `claude-hud-arch` to review P3.
Start P4 from `src/web/entry.mjs` and the Activity selector. Resolve demo eligibility from the first complete snapshot.

## Review

Accepted 2026-11-26 by activity. With HUD_NO_AUTOINSTALL=1, node --test tests/browser-store.test.mjs passed all five fixture tests on Node v22.12.0.
