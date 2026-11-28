# Owner checks

## HUD architecture

- [ ] After release approval, perform the Windows task switchover and confirm port 7777, the installed hook path and fresh feed activity. Use the verified previous installation if rollback is needed. [Deployment and rollback](ARCHITECTURE.md#windows-deployment-and-rollback)
- [ ] On a LAN device, open the deployed dashboard. Check that feed and plan updates arrive, clipboard copy works, and the kiosk view stays readable and awake. [HUD 0.3 owner checks](plans/hud-0-3/STATUS.md#p10-documentation-closeout)

## Operator cockpit P1

- [ ] Native-GPU cold-load timing is unmeasured. The P1 baseline ran with Edge's software renderer on the 40-load host. Repeat it on a machine with a GPU before the 3D scene gate.
- [ ] Pages not opened in a browser by me: all of them. The Edge smoke wrote screenshots that nobody has reviewed. [Smoke screenshots](../.hud-tmp)

## Operator cockpit P1-01

- [ ] Review the layout frames for taste. Open `docs/plans/operator-cockpit/handoffs/design/frames/<name>.html` in a browser (add `?annot` or `?gray`), or view the PNGs in `handoffs/design/images/`. Regenerate with `node docs/plans/operator-cockpit/handoffs/design/build.mjs` then `render.mjs`. The audit ran offline without the HUD's web fonts, so label widths differ slightly from the live HUD.

## Operator cockpit P4

- [ ] The history readers were tested on synthetic record shapes only. Feed a throwaway Claude Code session (temporary `CLAUDE_CONFIG_DIR`) and a throwaway Codex session (temporary `CODEX_HOME`) through `readHistory` to confirm the real formats. Planned for P5, P6 or P11. Regression check: `node --test tests/operator-history.test.mjs`.

## Operator cockpit P8

- [ ] Real LAN device: start a scratch HUD with `HUD_PORT=7788 HUD_OPERATOR_DIR=<temp> node hud.mjs --lan`, pair on this PC with `node hud.mjs operator pair` (same two variables) at `http://127.0.0.1:7788`, then on a phone check that `http://<pc-ip>:7788/` loads and `/api/operator/instance` returns 403.
- [ ] With the scheduled task running, run `node hud.mjs operator pair` in an ordinary terminal and pair. Regression check: `node --test tests/operator-access.test.mjs`.

## Operator cockpit P2

- [ ] On the operator laptop, run `node src/web/cockpit/harness/run-evidence.mjs --native --out=<dir>` and check `results.json` for the chosen renderer and orbit p95. The agent's native run used a headless window on this PC. Regression check: `node --test tests/cockpit-layout.test.mjs`.
- [ ] Design review: in `handoffs/P2/native/dense-1440-selected.png` the selected node in the crowded Ledger cluster overlaps its neighbours.

## Operator cockpit P3

- [ ] The inspector has run only against fixture clients in an isolated harness. Its look in the real shell is reviewed with P7. Regression checks: `node --test tests/cockpit-inspector.test.mjs` and `node src/web/inspector/harness/run.mjs`.
