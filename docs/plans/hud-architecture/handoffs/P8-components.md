# P8 `components` handoff

**Date:** 2026-11-26 · **State:** handed-off · **Model used:** Codex (GPT-6, session settings) ·
**Next:** P9 after P7

## Summary

Cards, Network and Activity share one registered view system and one browser store. The dashboard
and `/design` use the same native browser components. CSS remains ordered through one entry sheet.

## Exit gate

- [x] Cards, Network and Activity each use the registry and shared store. Components have explicit
  cleanup for timers, observers, global listeners, and subscriptions. Repeated mount/unmount cycles
  leave one active set of handlers. `node tests/browser-smoke.mjs` exercised six mounts in one Edge
  document, twice for each view, with one active stream and one store subscriber per mount. It
  checked global listener counts, resize observers, the dashboard interval and mounted DOM before
  and after cleanup. Closed stores also ignored stale frames.
- [x] Edge smoke and screenshots cover dashboard, gallery, kiosk, reduced motion, navigation/focus,
  links, and visual parity. A view imports only the fixtures, selectors, and components it uses.
  Edge passed all 15 layouts and captured 28 screenshots. Three gallery captures were pixel-identical
  to P5. In 13 before/after layout captures, mean RGB difference stayed below 3.4/255 with the
  dynamic clock and feed. The ten imported CSS files concatenate to the original stylesheet in
  the same order after line-ending normalization. Activity, Cards and Network import their own
  DOM helpers, selectors and components.
  [Baseline captures](../../../../.hud-tmp/p8/baseline/)
  [P8 captures](../../../../.hud-tmp/p8/after/)

`HUD_NO_AUTOINSTALL=1 node hud.mjs selftest` reported `all checks passed` and
`HUD_NO_AUTOINSTALL=1 node --test tests/` passed **60 of 60 tests** against P8 and the accepted
P5 backend. Automated browser instances used OS-assigned ports. The architecture worktree's
isolated demo on Lane B port **7792** served Cards, Network, Activity and Design, demo state and all
ten shared stylesheets. Its process and fixture profile were closed after verification.

## Files changed

| File | New / changed | What |
|---|---|---|
| `src/web/{entry,design,legacy-hud,view-registry}.mjs` | Changed | Browser entry and registry, dashboard composition and direct gallery imports. |
| `src/web/components/` | New | Page and panel lifetimes, shared session cards and subagent details, Network map, plans, queue, alerts, feed, vitals and controls. |
| `src/web/{data/selectors,views/activity}.mjs`, `src/web/views/{cards,network}.mjs` | Changed / new | Shared joins and registered views. |
| `src/web/styles/`, `src/http/assets.mjs` | Changed / new | Ordered component and layout sheets plus explicit registrations for public assets. |
| `tests/browser-smoke.mjs`, `docs/adding-a-view.md` | Changed | Component, lifecycle and visual coverage, with the view and cleanup recipe. |

## Contract as built

`mountHudPage(element, { store, transport })` mounts one outlet after the first full frame and
returns page cleanup. Session descriptors call `actions.connect({ el, update, jump })` and return
their own cleanup. The session panel keeps Cards and Network mounted during switches. It routes
snapshot updates to the visible view and preserves card identities and Network pins between switches.
The Activity page subscribes directly and returns its subscription and DOM cleanup. `/design` mounts
the same components over local fixtures.

## Deviations from the plan

Added explicit module and CSS entries to `src/http/assets.mjs`, which P8's scope did not list.
The existing public asset allowlist requires those entries for the new browser imports.

## Decisions taken

- Kept `legacy-hud.mjs` as the dashboard shell at the existing asset path. Each view renderer and
  feature component moved to its own module.
- Preserved Cards and Network state through view switches by retaining both mounts within one
  dashboard lifetime. The hidden view receives no store renders until selected again.
- Fixed needs-you dismissal during extraction. The dismiss handler now refreshes the waiting list
  instead of calling an undefined function. Added an Edge assertion for the dismissal.

## Known issues

Phone widths were emulated in Edge. Before/after comparisons use independently running demo streams,
so dynamic clock and feed pixels vary. The pre-feature extraction smoke attempt encountered an
intermittent board detail assertion. The feature and final Edge runs passed that interaction.

## Out-of-scope findings

The live dashboard switchover and release checks remain with P10.

## Changes to earlier items

Lane A independently accepted P5 in `252af2e`. P8 re-ran seven runtime and alert dependency tests
successfully and used the accepted runtime contract.

## Lasting knowledge

[Add a HUD view](../../../adding-a-view.md) describes how to register an outlet, subscribe to the
store, own resources and publish styles and modules. Keep layout, motion and kiosk styles after the
component sheets in `hud.css`.

## Next agent: start here

P9 should review the view and asset recipe, re-run the Edge smoke, and verify the complete tree
when staging the distribution. Its other dependency is P7.

## Review

Accepted 2026-11-26 by P9 packaging. Edge passed 15 layouts and six mount/unmount cycles against the combined P7/P8 tree and captured 28 screenshots. The sandbox run timed out opening the browser protocol. The isolated run with normal Windows permissions passed.
