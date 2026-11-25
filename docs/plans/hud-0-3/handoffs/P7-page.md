# P7 page handoff

**Date** 2026-11-26 · **State** handed-off · **Model** GPT-6 Codex · **Next** P8

## Summary

The HUD summarizes feed activity after five minutes away or disconnected. Project focus filters Sessions,
Plans and Feed together. Local session cards and compact rows offer an **Open in VS Code** link for VS Code
sessions.

## Exit gate

- [x] `node --check hud.mjs` and `node --check tests/browser-smoke.mjs` exited 0.
  `node hud.mjs selftest` ended with `all checks passed`.
- [x] `node --test tests/` reported `tests 39`, `pass 39` and `fail 0` on Node v26.7.0.
- [x] `node tests/browser-smoke.mjs` passed all nine views without runtime errors or horizontal scroll. Reviewed
  captures under `.hud-tmp/`. Headless Edge ran outside the sandbox after its DevTools connection timed out
  inside the sandbox.
  - Network: `smoke-network-1440x900.png`, `smoke-network-1024x768.png`, `smoke-network-390x844.png`
  - Cards: `smoke-cards-1440x900.png`, `smoke-cards-1024x768.png`, `smoke-cards-390x844.png`
  - Plans: `smoke-plans-1440x900.png`, `smoke-plans-1024x768.png`, `smoke-plans-390x844.png`,
    `smoke-plans-ready-390x844.png`
  - Gallery: `smoke-design-1440x900.png`, `smoke-design-1024x768.png`, `smoke-design-390x844.png`,
    `smoke-design-board-1024x768.png`, `smoke-design-queue-1024x768.png`,
    `smoke-design-warnings-1024x768.png`, `smoke-design-page-extras-1024x768.png`
  - Banners and focus: `smoke-warning-1440x900.png`, `smoke-away-summary-1440x900.png`,
    `smoke-project-focus-1440x900.png`, `smoke-project-focus-390x844.png`, `smoke-project-feed-390x844.png`
- [x] [README](../../../../README.md#using-the-page) and [DESIGN](../../../DESIGN.md#while-you-were-away)
  document the page features. `/design` renders specimens for all three.
- [x] Browser smoke shortened the wait by advancing the page clock at the visibility change and SSE loss.
  The hidden-tab return and a real SSE reconnect each fetched fresh state and showed one summary whose four
  counts matched the demo feed. The visibility test counted two turns, three agents, one item and one
  needs-you event. The reconnect test counted two turns, one agent, one item and one needs-you event.
  An older completion and drift marks were excluded. A brief hide triggered zero requests, and dismissal
  survived the next stream update.
- [x] Browser smoke checked `?project=TourCMS` across all three panels, at the three required sizes, and
  verified Escape restores the projects. It also checked the plan, feed and network project controls, the
  single-project hub label and scoped totals.
- [x] Browser smoke verified `vscode://file/C:/Users/demo/source/repos/Fidia%20CRM` on the session card and
  pinned network card on `127.0.0.1`. The CLI card had no window link target.

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud.mjs` | Changed | Page summary, project focus, local editor links, feed action field and demo and gallery specimens. |
| `tests/browser-smoke.mjs` | Changed | Browser coverage for all three features and both return paths. |
| `README.md`, `docs/DESIGN.md` | Changed | Page controls, timing, scope and window links. |
| `docs/plans/hud-0-3/STATUS.md` | Changed | P7 claim and handoff. |

## Contract as built

- As PLAN §11. The page fetches `/api/state` after a qualifying return and derives the summary from its `feed`.
  Feed rows for completed turns, finished agents and actual board transitions carry an optional `action` field
  with `turn-finished`, `agent-done` or `item-changed`. Needs-you rows use their existing `kind`.
- `createHud(mount, { project, onProject, reconnect })` accepts an initial project and a callback for changes.
  The page keeps the address in sync with the selected project.
- Window links use the session's existing `entrypoint` and `cwd`. Both loopback hostnames named in §11 allow
  the action on session cards, compact rows and pinned network cards.

## Deviations from the plan

None.

## Decisions taken

- The feed's optional `action` field makes counts independent of display text and distinguishes board transitions
  from drift marks. The summary lists requests from the absence window, including requests that may have since
  cleared. Current requests still appear in the red banners.
- Project focus also scopes the Plans work queue and the Feed header. Global alerts remain actionable. Following
  an alert to a different project clears the filter so the destination session is visible.
- The local VS Code action also appears as an icon in compact rows, with the same accessible label as the full
  session card.

## Known issues

The summary covers the feed retained in the latest snapshot, up to 200 events.

## Out-of-scope findings

`node hud.mjs lint .` found no issue for `docs/plans/hud-0-3/` and reported the eight existing repository-level
workflow issues.

The final Node test run reported a `TimeoutNegativeWarning` during the existing short-session settle test.

## Changes to earlier items

P6 was accepted after selftest, 39 Node tests and nine browser views. Its review and implementation are in
local commit `a4c3f81`.

## Lasting knowledge

- `pageMain` owns visibility, reconnect timing and the URL. `createHud` owns project focus and the summary card.
- The ticker keeps unfiltered recent history while focused. Clearing the filter restores events that arrived
  during focus, and selection applies before session and plan reconciliation and network layout.

## Next agent

Review the P7 browser gates. P8 can use the existing `network().pin()` method and test against its own demo
HUD with `HUD_NO_AUTOINSTALL=1`.

## Owner checks

- Click **Open in VS Code** for a real local editor session and confirm that VS Code brings the expected window
  forward. Headless Edge verified the link target.

## Review

- 2026-11-26 · away · Accepted. Selftest and all 39 Node tests passed. Edge smoke confirmed the away summary
  after visibility and SSE reconnection, project focus and Escape across the three panel sizes, and the encoded
  Windows URL on local VS Code sessions.
