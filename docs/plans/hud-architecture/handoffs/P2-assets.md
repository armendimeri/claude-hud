# P2 `assets` handoff

**Date:** 2026-11-26 · **State:** handed-off · **Model / effort used:** Codex (GPT-6, session effort) ·
**Next:** P3

## Summary

The dashboard and design gallery load native ES modules and shared CSS from `src/web`. The HTTP handler
serves four explicitly allowed assets and checks their resolved paths. Script CSP permits same-origin scripts.

## Exit gate

- [x] Existing Edge smoke behavior and the gallery work from the served modules at every tested viewport. No module-load errors
  are observed. The unchanged `node tests/browser-smoke.mjs` suite passed against the staged P2 distribution with Edge
  `158.0.4370.33`. Network, Cards and the gallery passed at 1440×900, 1024×768 and 390×844. Kiosk passed at
  1920×1080 and 390×844 with 18 px body text. The suite reported no runtime exceptions. It wrote 24 screenshots.
  [Network](../../../../.hud-tmp/p2-assets/.hud-tmp/smoke-network-1440x900.png),
  [Cards](../../../../.hud-tmp/p2-assets/.hud-tmp/smoke-cards-390x844.png),
  [Gallery](../../../../.hud-tmp/p2-assets/.hud-tmp/smoke-design-1024x768.png),
  [Kiosk](../../../../.hud-tmp/p2-assets/.hud-tmp/smoke-kiosk-390x844.png)
- [x] Contract tests cover known assets, missing assets, and confinement to the public tree. The full distribution works
  from a different working directory. The asset contract test copies the root scripts and `src/` to a temp distribution
  and starts its HUD script by absolute path from the parent directory. It checks both shells, their CSP, GET and HEAD
  MIME types and asset bytes, missing and unlisted files, noncanonical request paths, and an out-of-tree Windows junction.
  [Contract test](../../../../tests/public-contract.test.mjs)

`node hud.mjs selftest` reported `all checks passed`. `node --test tests/` passed 50 of 50 with no skips on
Node `v22.12.0`, including the Windows PID-reuse regression and P1 HTTP and SSE fixtures. A source comparison against
P1 confirmed identical stylesheet content and browser function bodies. Representative browser screenshots were
reviewed, including the P1 and P2 phone kiosk captures.

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud.mjs` | Changed | Thin HTML shells, same-origin script CSP and static asset routing. |
| `src/http/assets.mjs` | New | Exact URL allowlist, MIME types and resolved-path confinement. |
| `src/web/entry.mjs`, `src/web/design.mjs` | New | The dashboard and gallery entry modules from `pageMain` and `designMain`. |
| `src/web/legacy-hud.mjs`, `src/web/styles/hud.css` | New | Shared `hudClient` factory and extracted stylesheet. |
| `tests/public-contract.test.mjs`, `tests/codex.test.mjs` | Changed | HTTP asset contracts replace inline-script syntax checks. |
| `README.md` | Changed | Full distribution layout and setup instructions. |
| `docs/status.md`, `docs/plans/hud-architecture/STATUS.md` | Changed | Session summary and phase board. |

## Contract as built

`GET /` loads `/assets/entry.mjs` and `GET /design` loads `/assets/design.mjs`. Both import
`/assets/legacy-hud.mjs` via a relative import and link `/assets/styles/hud.css`. The browser factory remains
`hudClient()` and the `H` passed to each entry function has the same interface. Both page routes, the API, and
SSE retain their existing behavior.

`readPublicAsset(target)` takes the raw path without a query string and resolves to `{ body: Buffer, contentType: string }`
or `null` for an unavailable asset. GET and HEAD share the fixed asset URLs and headers. The existing host checks
apply before asset handling.

## Deviations from the plan

None. The existing browser smoke file ran unchanged.

## Decisions taken

- Match the four public paths before URL normalization, then check each resolved file against `src/web`. This keeps
  the boundary explicit on Windows and allows the process to start from another working directory.
- Keep the pre-existing `H` binding available to Edge's smoke probes as a read-only global. Both modules still call
  their own renderer with the shared client factory.
- Use `blocking="render"` on the modules to preserve startup layout. An early run briefly measured the phone kiosk
  under 18 px. The focused probe restored 18 px in three consecutive runs, and the full smoke suite confirmed it.
  [HTML Standard](https://html.spec.whatwg.org/multipage/scripting.html#attr-script-blocking)

## Known issues

One early Edge retry did not render its first navigation before the smoke deadline. The diagnostic run and final
unmodified suite loaded the page. The live deployment and performance comparison remain scheduled for P10.

## Out-of-scope findings

P1's hook timing overage and the open 0.3 live memory gate remain recorded in the baseline handoff.
[P1 handoff](P1-baseline.md)

## Changes to earlier items

Accepted P1 by rerunning all three of its public contract tests and committed its baseline as `5c1a51c`.

## Lasting knowledge

Run the HUD from the complete distribution. Add each new browser module or stylesheet to the allowlist when
introducing it. Keep the browser smoke probes in mind when changing the client bootstrap in a later phase.
[Setup](../../../../README.md#setting-it-up), [Asset manifest](../../../../src/http/assets.mjs)

## Next agent

Re-run `node --test tests/public-contract.test.mjs` with `HUD_NO_AUTOINSTALL=1` in `claude-hud-arch`.
Start the P3 store and transport extraction from `src/web/entry.mjs` and `src/web/legacy-hud.mjs`.

## Review

Accepted 2026-11-26 by client-data. With HUD_NO_AUTOINSTALL=1, `node --test tests/public-contract.test.mjs` passed all four tests, including the staged distribution, MIME types, and public-tree confinement.
