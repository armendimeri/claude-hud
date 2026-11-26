# P1 `baseline` handoff

2026-11-26 · handed-off · Codex (GPT-6, session effort) · Next P2

## Summary

Captured the public HTTP, SSE, CLI and settings baseline before the refactor. Synthetic contract tests and a repeatable Windows workload are in the architecture worktree.

## Exit gate

- [x] `node hud.mjs selftest`, `node --test tests/`, and `node tests/browser-smoke.mjs` pass. Self-test ended with `all checks passed`. The Node suite passed all 49 tests with zero skips. Edge 158 passed 11 layouts and wrote 24 screenshots under [`../../../../.hud-tmp/`](../../../../.hud-tmp/). Network, Cards and the design gallery ran at 1440×900, 1024×768 and 390×844. Kiosk ran at 1920×1080 and 390×844. Representative captures are [Network](../../../../.hud-tmp/smoke-network-1440x900.png), [Cards](../../../../.hud-tmp/smoke-cards-390x844.png), [Gallery](../../../../.hud-tmp/smoke-design-1024x768.png) and [Kiosk](../../../../.hud-tmp/smoke-kiosk-1920x1080.png).
- [x] The Windows PID-reuse test passes and the contract fixtures contain synthetic data only. The Node suite passed `Windows registry sessions require the original process when procStart is recorded`. `git diff --exit-code a3605d9 -- hud.mjs hud-hook.mjs tests/hooks.test.mjs` was empty. The live scenario uses the harness PID to provide a running process and substitutes sample identifiers, paths and times in the checked-in examples. The hook-time assertions compare explicit input milliseconds.
- [x] The baseline records Node version, workload, sampling interval, CPU denominator, peak RSS, stream bytes, median time to the first full frame and 30-run hook p95 values. Measurements and open performance gates are below.
- [x] The Windows PID fix is in `73c0351`, an ancestor of the shared code base `a3605d9`. P0 `6318976` is the immediate parent of this work on `hud-architecture`. `git worktree list` shows `C:/Users/armen/source/repos/armendimeri/claude-hud-arch` on `hud-architecture` and the original checkout on `hud-0-3` at `a3605d9`. `git -C ../claude-hud status --short --branch` showed the same 11 board deletions and untracked `.claude/` and `.vs/` before and after P1.

### Performance

Run on Windows x64 with Node `v22.12.0` and an Intel Core i7-1365U. Use `node tests/tools/stream-size.mjs --baseline` from the architecture worktree without other suites running. Its isolated loopback HUD uses 16 Claude and 8 Codex sessions, 256 transcript records per session plus Codex metadata, one board and one SSE subscriber. Once the fixture has loaded, replay appends a Claude record and posts a hook every two seconds.

| Measurement | Result |
|---|---:|
| Median cold process launch to first full SSE frame, seven starts | 175.21 ms |
| Peak HUD RSS from Windows `PeakWorkingSet64` | 60,063,744 B (57.28 MiB) |
| Mean HUD CPU over the 30 s replay | 0.994% of one logical core |
| Synthetic live SSE first frame | 19,904 B |
| Synthetic live SSE largest later `state` | 19,336 B |
| Synthetic live SSE total | 446,305 B across 30 typed frames |
| Dense demo SSE first frame | 33,520 B |
| Dense demo SSE largest later `state` | 28,988 B |
| Dense demo SSE total | 889,223 B across 139 typed frames |

Startup includes a loopback retry interval of 10 ms. It stops at the first full frame, which may arrive before fixture ingestion finishes. Windows resource sampling uses 31 samples at one-second intervals. RSS is the process lifetime high-water mark, including startup. CPU divides the change in user-plus-kernel CPU seconds by elapsed wall seconds and multiplies by 100. SSE bytes include event framing and omit retry lines, keepalives and HTTP overhead. The dense run used `node tests/tools/stream-size.mjs --demo=dense --seconds=30` and passed the later-frame limit of 30 KB.

| Command | p95 launch through exit |
|---|---:|
| `node -e ""` | 73.33 ms |
| `node hud.mjs hook` | 133.01 ms |
| `node hud-hook.mjs` | 89.84 ms |

The hook batch used 30 interleaved runs per command and identical synthetic input for both hook commands. The isolated receiver got all 60 POSTs and returned 204. Both hook commands were silent and exited 0. Standalone overhead was 16.51 ms in this run, 1.51 ms over the 15 ms budget. The previous 0.3 P9 check measured 5.60 ms overhead. Re-run the same procedure at P9 and P10.

The last complete [0.3 live release measurement](../../hud-0-3/STATUS.md#p10-documentation-closeout) recorded 213.12 MB peak RSS against the 150 MB limit, 0.979% mean CPU on one core and 7.368% peak over rolling 30-second windows. It predates the transcript-reader and PID fixes. The ten-minute live release gate remains open for P10.

## Files changed

| File | Change |
|---|---|
| `tests/helpers.mjs` | Exposes non-waiting launch and isolated CLI spawning. The isolated profile defaults disable phone push and external usage ingress. |
| `tests/fixtures/contract/scenario.mjs` | Shared synthetic board, registry, hook and transcript inputs. |
| `tests/fixtures/contract/snapshot.json` | Synthetic live snapshot excerpts and a demo account and session example. |
| `tests/public-contract.test.mjs` | Checks HTTP and SSE shapes, two subscribers, a fresh connection, both demos, CLI output and settings restoration. |
| `tests/tools/stream-size.mjs` | Adds the Windows baseline workload, cold startup and hook timing, RSS, CPU and exact SSE byte counts. |
| `docs/status.md` and `docs/plans/hud-architecture/STATUS.md` | Session summary and P1 board handoff. |

## Contract as built

`GET /api/state` returns the complete snapshot. Live exposes `codex` monitoring metadata and uses `demo: false`. The ordinary demo uses `demo: true` and includes a synthetic Codex session. Dense uses `demo: "dense"`. Both demos omit the monitoring field. `GET /api/health` returns `ok`, `uptime`, `sessions` and `version`.

P1 observed the full `state` with `full: true` as the first typed SSE message on each connection. A later `state` omits `full`, `plans` and `feed`. In the fixture replay, the tool feed event arrives before its partial state, and the board transition feed event arrives before the separate whole-array `plans` replacement. Both subscribers see that order. A reopened connection gets the edited board and current feed in its full frame.

## Deviations from the plan

The repeatable resource sampler uses Windows process counters. The stream-size URL and demo modes and the portable contract tests continue to use Node built-ins. The browser gate uses the existing demo-based suite. The live release measurement belongs to P10.

## Decisions taken

- Use a synthetic live workload for the comparable P6 and P10 measures so collection and transcript replay run alongside publication. Use dense demo separately for the stream-size gate.
- Assert the actual hook timestamps relative to the replay clock and compare stable fields after substituting synthetic paths, process IDs and timestamps. The demo account timing and usage are checked by shape because the demo advances its own counters.

## Known issues

- The standalone hook p95 exceeded the relative budget in this batch. The last complete live run exceeded the memory target. Both results are retained for later comparison.

## Out-of-scope findings

- The 0.3 board documents the unresolved live verification and the owner checks for real hardware and the deployed HUD.

## Changes to earlier items

None.

## Lasting knowledge

Keep `tests/public-contract.test.mjs`, its synthetic examples and the comparable benchmark when the phase board closes. Carry the command and measurements into `docs/ARCHITECTURE.md` at P10.

## Next agent

Review P1 with `node --test tests/public-contract.test.mjs`. For P2, use the snapshot and SSE examples to check parity while moving the browser code. Re-run dense stream sizing independently if SSE delivery changes.

## Review

Accepted 2026-11-26 by assets (P2). Re-ran node --test tests/public-contract.test.mjs with HUD_NO_AUTOINSTALL=1. All 3 tests passed, covering live HTTP and SSE, both demos, and the CLI/settings round trip.
