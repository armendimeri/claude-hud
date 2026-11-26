# P4 `activity` handoff

**Date:** 2026-11-26 · **State:** handed-off · **Model / effort used:** Codex (GPT-6, session setting) ·
**Next:** P5

## Summary

Demo and dense demo expose a full-page Activity preview at `/?view=activity`. The page shows project-filtered
sessions, attention state, linked board items, and the recent feed from the shared browser store.

## Exit gate

- [x] Demo and dense demo render the preview at desktop and phone widths. A fixture test drives session, plan,
  and feed changes through the same browser store. `node tests/browser-smoke.mjs` passed on Edge
  `158.0.4370.33` at 1440×900 and 390×844 for each demo. Regular demo rendered 6 sessions and dense demo
  rendered 24. Both switched from two columns to one without horizontal overflow. The fixture verified
  updates to session title, attention, linked work and feed, plus both empty states. Ingestion and public
  HTTP and SSE contracts are unchanged.
  [Demo desktop](../../../../.hud-tmp/smoke-activity-1440x900.png),
  [Demo phone](../../../../.hud-tmp/smoke-activity-390x844.png),
  [Dense desktop](../../../../.hud-tmp/smoke-activity-dense-1440x900.png),
  [Dense phone](../../../../.hud-tmp/smoke-activity-dense-390x844.png)
- [x] The Edge trace counted one EventSource while entering Activity, focusing a project and returning to
  Dashboard. Injected connection events verified disconnect and resume with retained data. The detached
  preview stopped reacting to store and project events. The contributor guide covers registration,
  scoped styles, fixtures, and browser coverage.
  [Browser trace](../../../../tests/browser-smoke.mjs), [View guide](../../../adding-a-view.md)
- [x] The trace held a real non-demo server's first full frame. It showed Connecting with neither outlet
  mounted. Releasing the frame mounted Network, and `hud.view` remained `network`. An unknown value
  also fell back to Network. The demo trace exercised the same first-frame gate.

With `HUD_NO_AUTOINSTALL=1`, `node hud.mjs selftest` reported `all checks passed` and
`node --test tests/` passed 55 of 55 on Node `v22.12.0`. The full Edge smoke suite also passed the
11 existing dashboard, gallery and kiosk layouts alongside the four Activity layouts. It captured
28 screenshots and reported zero runtime exceptions. The Activity desktop and dense phone captures
were reviewed. The original checkout's Git status matched its starting state.

## Files changed

| File | New / changed | What |
|---|---|---|
| `src/web/entry.mjs` | Changed | Owns initial selection, the shared stream, project focus, and the return to Dashboard. |
| `src/web/view-registry.mjs` | New | Registers the dashboard's session views and the Activity page outlet. |
| `src/web/views/activity.mjs` | New | Mounts the preview with store and project subscriptions. |
| `src/web/styles/activity.css` | New | Provides the responsive Activity layout using HUD tokens. |
| `src/http/assets.mjs` | Changed | Allows the new view module, registry and stylesheet through the static asset boundary. |
| `tests/browser-smoke.mjs` | Changed | Checks four preview layouts, controlled updates, stream lifetime, and live fallback. |
| `docs/adding-a-view.md` | New | Documents how to add, register, style, and test a view. |
| `docs/plans/hud-architecture/STATUS.md`, `docs/status.md` | Changed | Record the P4 handoff and next item. |

## Contract as built

- The registry maps view keys to descriptors with `key`, `outlet`, and `mount(element, { store, actions, ui })`.
  Page descriptors can declare `demoOnly` and a `stylesheet` URL. Mount returns cleanup.
- The entry waits for the first full snapshot before choosing the outlet. `activity` is eligible for demo
  values `true` and `'dense'`. Kiosk uses the existing forced Network view.
- `actions` exposes `getProject()`, `setProject(name)`, `subscribeProject(listener)`, `dashboardUrl()`, and
  `leaveView()`. `ui` supplies the existing DOM and status helpers and the connection labels. Store and
  selector signatures are as in the P3 handoff.

## Deviations from the plan

Added the three public asset registrations required to serve the native modules and CSS. The registration
follows the existing allowlist and path containment.

## Decisions taken

- The Dashboard link clears the preview query in place, keeps the project focus and restores the regular
  dashboard. This leaves the same store and stream active while it disposes of the preview.
- The preview uses the adjacent HUD's design tokens and status tags. The worktree has no standalone
  `docs/design-system.md`.

## Known issues

Phone-width checks used Edge emulation. The owner's deployed instance was outside this verification.

## Out-of-scope findings

The baseline's hook timing overage and the separate 0.3 live memory gate remain documented.
[P1 handoff](P1-baseline.md)

## Changes to earlier items

Accepted P3 after all five store fixture tests passed and committed it as `fad5ddb`.
[P3 review](P3-client-data.md#review)

## Lasting knowledge

The view guide records the module and asset registration steps and the subscription and cleanup contract.
[Add a HUD view](../../../adding-a-view.md)

## Next agent: start here

Review the browser exit gate with `HUD_NO_AUTOINSTALL=1` and `node tests/browser-smoke.mjs` in the architecture
worktree. P5 can then move the HTTP and SSE seams behind the application runtime while preserving the
wire contract used by both outlets.

## Review

Accepted by runtime on 2026-11-26. All five browser-store fixture tests passed. Isolated Edge smoke passed all 15 layouts, including Activity at desktop and phone widths in both demos, one stream, preview cleanup, and live fallback. Both checks ran with `HUD_NO_AUTOINSTALL=1`.
