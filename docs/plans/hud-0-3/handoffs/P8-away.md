# P8 away handoff

**Date** 2026-11-26 · **State** handed-off · **Model** GPT-6 Codex · **Next** P9

## Summary

Kiosk mode is a larger network view that pins the longest-waiting session in view and requests screen wake lock
where available. An optional phone receiver gets a rate-limited message with the project and request kind.

## Exit gate

- [x] `node --check hud.mjs` and `node --check tests/browser-smoke.mjs` exited 0.
  `node hud.mjs selftest` ended with `all checks passed`.
- [x] With `HUD_PUSH_URL` empty in the test shell, `node --test tests/` reported 42 passed and 0 failed.
  `node --test tests/push.test.mjs` separately reported 3 passed and 0 failed.
- [x] The loopback receiver captured one POST for the first request with `Title: Claude HUD` and exactly
  `Demo Project needs you: permission` in the body. The session title, folder, transcript path, command, and
  session ID were absent from the request. Another transition within one minute produced zero extra requests.
- [x] An unset endpoint produced zero requests. A `file:` endpoint disabled push and logged a startup message
  with no URL. A receiver HTTP 503 appeared as a generic error on SSE, a subsequent success cleared it, and
  21 sessions triggered exactly 20 attempts within the hour window. Fixtures covered all three request kinds.
- [x] `node tests/browser-smoke.mjs` passed all nine existing views and both kiosk sizes in isolated headless
  Edge. At 1920×1080, body text measured 18 px, there was no page scroll, display controls were hidden, and the
  waiting session was pinned even with `view=cards` in the URL. At 390×844, there was no horizontal scroll.
  The wake-lock stub exercised initial refusal and reacquisition on visibility. The gallery showed the pin and
  linked to the TV view.
- [x] Reviewed the 24 browser captures under `.hud-tmp/`. The kiosk views show the pinned card and readable
  banners. The captures are grouped below.
  - Network: `smoke-network-1440x900.png`, `smoke-network-1024x768.png`, `smoke-network-390x844.png`
  - Cards: `smoke-cards-1440x900.png`, `smoke-cards-1024x768.png`, `smoke-cards-390x844.png`
  - Plans: `smoke-plans-1440x900.png`, `smoke-plans-1024x768.png`, `smoke-plans-390x844.png`,
    `smoke-plans-ready-390x844.png`
  - Gallery: `smoke-design-1440x900.png`, `smoke-design-1024x768.png`, `smoke-design-390x844.png`,
    `smoke-design-board-1024x768.png`, `smoke-design-queue-1024x768.png`, `smoke-design-warnings-1024x768.png`,
    `smoke-design-page-extras-1024x768.png`
  - Banners and focus: `smoke-warning-1440x900.png`, `smoke-away-summary-1440x900.png`,
    `smoke-project-focus-1440x900.png`, `smoke-project-focus-390x844.png`, `smoke-project-feed-390x844.png`
  - Kiosk: `smoke-kiosk-1920x1080.png`, `smoke-kiosk-390x844.png`
- [x] [README](../../../../README.md#viewing-it-from-another-device) and [DESIGN](../../../DESIGN.md#kiosk-display)
  document the controls, screen wake lock, endpoint configuration, and payload.

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud.mjs` | Changed | New-transition phone push, kiosk layout, automatic pin, and the kiosk gallery specimen. |
| `tests/push.test.mjs` | New | Isolated loopback checks for payload, privacy, rate limits, startup validation, and streamed errors. |
| `tests/browser-smoke.mjs` | Changed | Kiosk layout and wake-lock checks alongside existing browser smoke. |
| `README.md`, `docs/DESIGN.md` | Changed | Phone configuration and kiosk operation. |
| `docs/plans/hud-0-3/STATUS.md` | Changed | P8 claim and handoff. |

## Contract as built

- As PLAN §4.3. Both `/api/state` and the state stream expose `push: { enabled: boolean, lastError: string | null }`.
  It describes endpoint configuration and the latest completed delivery attempt. An invalid address reports
  a generic configuration error and leaves push disabled.
- As PLAN §12. A new request posts UTF-8 plain text with a fixed `Title: Claude HUD` header. A waiting session
  with no known project uses `Session` for the label.
- `?kiosk` adds the `kiosk` class to the document element and uses the network view. The automatic pin chooses
  the oldest request within the current project view without moving keyboard focus.

## Deviations from the plan

None.

## Decisions taken

- Phone delivery is disabled in demo mode. The demo's waiting sessions still exercise the kiosk view.
- Historical requests from transcript replay do not trigger a push. A delivery timeout is 5 seconds. Rate limits
  count attempts, including receiver failures, and use a monotonic clock. Delivery goes to the configured URL.
- The kiosk uses the same ordering as the needs-you banner. It respects the active project filter and clears
  its automatic pin when nobody in view is waiting.

## Known issues

Headless Edge exercised wake-lock behavior with a stub. An actual TV browser controls whether the screen stays awake.

## Out-of-scope findings

Run the integration suite with `HUD_PUSH_URL` cleared in the test shell. The shared test helper inherits it
and falls outside P8's scope. The push tests explicitly provide their own loopback URL.

`node hud.mjs lint .` found no issue for `docs/plans/hud-0-3/`. It reports the eight existing repository-level
workflow issues and the existing user-level setup issues.

## Changes to earlier items

P7 was independently accepted after selftest, 39 Node tests, and Edge smoke. Local commit `3b418ee` records
P7 and its review.

## Lasting knowledge

- Phone push uses only the project label and request kind. Delivery errors and the endpoint are kept separate
  so the API status remains safe to expose to the page.
- The browser owns kiosk presentation and wake-lock reacquisition. It does not send phone requests.

## Next agent

Review the P8 gates. The fast backend check is `node --test tests/push.test.mjs`. The TV gate is in
`node tests/browser-smoke.mjs` and uses the demo over a loopback port.

## Owner checks

- On the TV, open the HUD with `?kiosk` and confirm that the waiting card is readable at viewing distance
  and the browser keeps the display awake where supported.
- If you enable phone alerts, confirm that an ordinary needs-you request arrives on your phone through the
  receiver you configure.

## Review

- 2026-11-26 · coordinator · Accepted. Selftest passed, and the full Node run reported 42 passed and zero
  failed, including exact push bytes, privacy, rate limits, disabled endpoint and SSE error state. Isolated
  Edge smoke passed all 11 layouts. Reviewed the 1920×1080 and 390×844 kiosk captures and rechecked
  hidden controls, automatic pinning and wake-lock recovery with a stub.
