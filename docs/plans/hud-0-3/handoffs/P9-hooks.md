# P9 hooks handoff

**Date** 2026-11-26 · **State** handed-off · **Model** GPT-6 Codex · **Next** P10

## Summary

The 3.4 KB `hud-hook.mjs` forwards Claude Code events without loading the dashboard. Installation migrates old
hooks automatically and the legacy invocation still works.

## Exit gate

- [x] `node --check hud-hook.mjs`, `node --check hud.mjs` and `node --check tests/hooks.test.mjs` passed.
  `node hud.mjs selftest` ended with `all checks passed`.
- [x] `node --test tests/` reported 43 passed and 0 failed on Node v26.7.0 with `HUD_PUSH_URL` empty in the test shell.
  Ordinary hook replays in `tests/hooks.test.mjs` used the real forwarder on a private ephemeral port and asserted
  exit 0 and empty stdout and stderr. The suite also exercised the old invocation and checked the retained fields
  in the redacted server recording.
- [x] The README documents the two scripts, migration, compatibility, uninstall and the 400 ms budget.
  [The hooks](../../../../README.md#the-hooks)
- [x] `node .hud-tmp/p9-verify.mjs bench` timed startup through exit. Each batch interleaved 30 runs per command.
  The two hook commands received identical valid synthetic hook JSON and used a local HTTP receiver returning
  204. The old command ran from a scratch copy of `hud.mjs` at `eedbabb`. Each batch delivered all 60 expected POSTs.

  | Batch | Bare `node -e ""` p95 | Old hook p95 | Standalone p95 | Overhead vs. bare |
  |---|---:|---:|---:|---:|
  | 1 | 39.27 ms | 75.24 ms | 43.91 ms | 4.64 ms |
  | 2 | 42.79 ms | 73.61 ms | 48.67 ms | 5.88 ms |

- [x] `node .hud-tmp/p9-verify.mjs migrate` ran legacy install, current install twice and current uninstall
  against a temporary `CLAUDE_CONFIG_DIR`. It replaced 11 entries, preserved the unrelated hook, and the second
  install changed 0 bytes and made 0 backups. Uninstall restored the exact pre-install fixture, including the
  BOM and CRLF. Both fixture SHA-256 hashes were
  `5fa53eb01cde1635a14b89ef3483aa0f2a01733ac46c5eaa8375ad25852470af`.
- [x] `Get-FileHash` on the owner's `~/.claude/settings.json` before and after P9 returned this SHA-256 both times,
  `83374DC316AAF30A0732982AAF6F101C4C856DB6FE090F641F530DFC8C1073D6`.
- [x] `node .hud-tmp/p9-verify.mjs failures` verified silence and exit 0 on malformed input (42 ms with no POST),
  an unavailable receiver (44 ms), and a receiver that accepted the POST and never responded (446 ms including
  startup).

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud-hook.mjs` | New | Standalone forwarding, field allowlists and the shared port parser. |
| `hud.mjs` | Changed | Legacy dispatch, install and uninstall recognition, help and migration selftests. |
| `tests/hooks.test.mjs` | Changed | Real-command replay, legacy compatibility and verification of forwarded fields. |
| `README.md` | Changed | Two-file setup and upgrade behavior. |
| `docs/plans/hud-0-3/STATUS.md` | Changed | P9 claim and handoff. |

## Contract as built

- As PLAN §13. Installed command hooks use `node "<path>/hud-hook.mjs"`. Both command formats are recognized
  when a folder is moved, and both support `HUD_PORT`.
- `hud-hook.mjs` exports `runHook()`, `slimHookPayload(payload, at)`, the three allowlists, `LOOPBACK` and
  `portFrom(value)`. A direct invocation compares resolved paths case-insensitively on Windows.
- The standalone sends a fixed HTTP/1.1 JSON POST to loopback using `node:net`, correct UTF-8 byte length and
  `Connection: close`. It drains the response. The 400 ms timer bounds any wait for stdin or the receiver.

## Deviations from the plan

—

## Decisions taken

- Use a socket for the fixed loopback POST to meet the startup target. The first implementation using the
  HTTP client module measured 18.19 ms above bare Node p95. The final two batches used the same workload
  and measured delivery to the receiver through process exit.
- The uninstall gate compares to the exact pre-install settings from the legacy install backup. The CLI
  migration exercise begins by creating that backup through the legacy command.
- Backdated events and malformed request bodies in tests go directly to the receiver. Regular fixtures go
  through the forwarder, which supplies their current timestamp.

## Known issues

—

## Out-of-scope findings

—

## Changes to earlier items

—

## Lasting knowledge

- Keep the two scripts together. During startup, `installInto` replaces stale commands using the same path as
  the explicit install command and backs up the settings first.
- Keep the set of forwarded fields in `hud-hook.mjs`. The legacy command delegates to the shared forwarder
  and synthetic historical events can still use direct POST with a timestamp.

## Next agent

Start with the two scratch verification commands in the exit gate or rerun the migration checks in selftest.
Run the timing batch by itself so other test processes do not skew Windows process-start timings.

## Owner checks

- After restarting the live HUD, confirm that Claude Code's installed hooks point to `hud-hook.mjs` and new
  actions appear in the feed.

## Review

- 2026-11-26 · coordinator · Accepted. Selftest and all 43 Node tests passed. Independently rechecked the
  byte-exact CLI migration and uninstall, and all 60 valid loopback POSTs in a 30-run benchmark. P95 was
  39.19 ms bare, 67.00 ms legacy and 44.79 ms standalone. The owner settings hash still matched.
