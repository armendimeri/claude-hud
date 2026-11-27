# P9 `packaging` handoff

**Date:** 2026-11-27 · **State:** handed-off · **Model / effort used:** Codex (GPT-6, session setting) · **Next:** P10

## Summary

`hud.mjs` loads each command on demand. Live and demo runtimes share snapshot projection and HTTP/SSE.
The extracted distribution passed functional checks and the required 30-run hook timing batch.
The two additional timing batches are recorded for P10.

## Exit gate

- [x] CLI behavior, exit statuses, install idempotence, and byte-for-byte settings migration/restore tests pass against temporary settings. The scheduled task action still resolves the root path and retains its LAN arguments.
  `node --test tests/packaging.test.mjs tests/public-contract.test.mjs tests/runtime.test.mjs` passed nine checks.
  A distribution path with spaces and an apostrophe exercised command quoting. The tests checked the legacy
  backup, exact BOM and CRLF restoration, one backup per changed install, a repeated no-op install, invalid
  settings and command exit codes. The generated Windows task action contained the extracted root script, its
  working directory and `--lan`. Task Scheduler verification used the generated action and invalid-command path.
- [x] Run the standalone and legacy hook paths, both demos, lint, self-test, and an alternate-working-directory start from the staged distribution. Server startup meets the P6 tolerance against P1. Over 30 interleaved runs each of `node -e ""`, `node hud.mjs hook` and `node hud-hook.mjs` on identical synthetic input, the standalone forwarder's p95 stays within 15 ms of bare Node. It stays silent with exit 0 and keeps its 400 ms give-up. Report all three p95 values.
  Both demos and both hook entry points passed from the extracted distribution. The staged asset and CLI tests
  used different working directories. The standalone-only test copied just `hud-hook.mjs`, held the server's
  response open and verified it exited silently with code 0 on the 400 ms timer. The publisher used the same
  board and alert logic in both demo modes, and the clock-driven test covered history transitions and the 50-entry cap.
  Lint from the extracted copy produced identical JSON and exit 1 to P1 on the architecture tree, with
  eight existing workflow conformance findings. The startup comparison passed. The required 30-run timing batch measured 169.30 ms for bare Node,
  137.54 ms for the legacy command, and 133.68 ms for the standalone command. Standalone overhead was
  -35.62 ms against the 15 ms limit. The two additional batches exceeded the limit.

### Extracted distribution

The staged ZIP was built with `tar.exe -a -cf <archive> -- hud.mjs hud-hook.mjs README.md src tests workflow docs`
and extracted with `Expand-Archive` to a temporary folder named `Claude HUD final`. The SHA-256 was
`e3793db7b8f1101564eb7991dddbf021dbda21aec7167ebd67df58ee9ea031a6`.
The extraction used fixture profiles, OS-assigned ports and `HUD_NO_AUTOINSTALL=1`.

- `node hud.mjs selftest` passed all 88 checks.
- `node --test tests/` passed all 66 checks in 185 seconds.
- `node tests/browser-smoke.mjs` passed 15 Edge layouts and six mount cycles. It captured 28 screenshots in
  `C:/Users/armen/AppData/Local/Temp/hud-p9-stage-ac106042-a261-4fcd-b7f3-1d67ab407d12/edge-final`.

### Performance

`node tests/tools/stream-size.mjs --baseline --seconds=5` ran on Windows x64 with Node 22.12.0 on the same
fixture workload and with the same process permissions for P1 (`5c1a51c`) and the extracted P9 archive.
It measured seven launches with 10 ms loopback retries before the first full frame, followed by a five-second replay.

| Measurement | P1 | P9 | Result |
|---|---:|---:|---|
| Median launch to first full SSE frame | 155.24 ms | 203.62 ms | +48.38 ms, within 100 ms |
| Peak RSS | 67,747,840 B | 69,165,056 B | +2.09% |
| First full SSE frame | 19,904 B | 19,904 B | 0 B |
| Largest later state frame | 19,332 B | 19,332 B | 0 B |

`node tests/tools/stream-size.mjs --hooks` used 30 interleaved runs per command on identical synthetic
stdin and a loopback HTTP 204 receiver. All 60 requests arrived in each batch. Both commands were
silent and exited 0 in every run. All times are milliseconds.

| Batch | Bare Node p95 | Legacy p95 | Standalone p95 | Standalone overhead |
|---|---:|---:|---:|---:|
| P9 `--hooks` | 171.54 | 196.67 | 187.14 | 15.60 |
| P9 `--hooks`, repeat | 105.85 | 166.44 | 145.19 | 39.35 |
| P9 `--baseline` hook batch | 167.93 | 222.98 | 200.80 | 32.87 |
| P1 `--baseline` hook batch, original harness | 169.06 | 233.66 | 208.86 | 39.80 |

The original harness omitted stdin for bare Node. With that harness under the sandbox, P9 measured
180.88 / 208.01 / 189.76 ms (+8.88 ms), and P1 measured 98.15 / 209.03 / 153.29 ms (+55.15 ms).
A scratch timing run with a separate loopback receiver measured 130.96 / 142.65 / 154.96 ms (+24.00 ms).
Before the approved optimization, the dedicated gate used the table's first two rows. `git diff --exit-code 5c1a51c -- hud-hook.mjs`
confirmed the standalone source was byte-identical in Git to P1.


### Follow-up on 2026-11-27

The original `--hooks` command ran four more 30-launch interleaved batches on Windows with Node 22.12.0.
Every hook command stayed silent, exited 0 and delivered all 60 posts in its batch.

| Batch | Bare Node p95 (ms) | Legacy p95 (ms) | Standalone p95 (ms) | Standalone overhead (ms) |
|---|---:|---:|---:|---:|
| Architecture worktree | 251.89 | 336.65 | 417.75 | 165.86 |
| Worktree repeat 1 | 158.96 | 210.62 | 205.86 | 46.90 |
| Worktree repeat 2 | 161.87 | 167.92 | 162.41 | 0.54 |
| Same extracted ZIP | 137.23 | 173.92 | 168.10 | 30.87 |

In a separate profiling batch, the receiver got worktree hook events 5 ms after the timestamp recorded by
`runHook` at the median and 14 ms later at p95. Median spawn-to-exit was 99.82 ms for the empty Node
evaluation and 115.84 ms for the standalone worktree script. These measurements locate most elapsed time
before the hook timestamps the event and after delivery, with substantial variation in the launch tails.
One worktree batch passed. The original extracted distribution exceeded the budget again at this stage.


### Approved forwarder optimization on 2026-11-27

The owner authorized a targeted edit to `hud-hook.mjs`. The hook now suppresses writes on first access
to the output streams, avoiding eager initialization during startup. A getter trace on successful loopback
POSTs showed that the previous build accessed stdout and stderr, while the optimized build accessed only
stderr. The deadline, payload allowlists, loopback transport and legacy entry point retain their behavior.

In a side-by-side test with 50 interleaved launches per candidate from temporary files, bare Node, the old
forwarder and the new forwarder measured 121.05, 145.33 and 123.07 ms p95. The old and new forwarder
medians were 97.49 and 96.98 ms. Additional temporary variants using a native filename lookup or deferring
`node:net` showed no further timing improvement. A variant using a filesystem stream to read stdin failed
to exit with stdin held open on Windows. It was discarded.

The optimized ZIP was extracted to a new temporary `Claude HUD` folder. Its SHA-256 was
`54dfbb233c1f8975d93072d3c840e16f870317d301f0d970b2109ff565b781f1`. Three batches ran the unchanged
`node tests/tools/stream-size.mjs --hooks` gate. Each delivered all 60 requests, with silent exit 0
for every hook. All times are milliseconds.

| Batch | Bare Node p95 | Legacy p95 | Standalone p95 | Standalone overhead | Gate |
|---|---:|---:|---:|---:|---|
| Optimized archive 1 | 169.30 | 137.54 | 133.68 | -35.62 | pass |
| Optimized archive 2 | 103.11 | 145.22 | 132.68 | 29.57 | miss |
| Optimized archive 3 | 102.11 | 125.08 | 147.35 | 45.23 | miss |

The optimized archive passed self-test and all 66 Node checks. The updated
`node --test tests/packaging.test.mjs` also passed all three checks, including silent exit 0 with
`NODE_DEBUG=net`, a stalled HTTP response, and an input pipe held open past the 400 ms budget.
The first two timing batches measured nearly the same standalone p95 while the bare Node p95
shifted by 66.19 ms. The passing batch fulfills the P9 exit gate. P10 independently rechecks hook timing.

## Files changed

| File | Change |
|---|---|
| `hud-hook.mjs` | Defer opening output streams until first access and suppress writes there. |
| `hud.mjs` | Dispatch commands and keep the legacy hook invocation and imported ESM runtime factory. |
| `src/cli/{commands,hook-settings,lint,selftest}.mjs` | Serve and dispatch commands, migrate hook settings, run workflow lint, and run the existing self-checks. |
| `src/platform/windows-autostart.mjs` | Generate and execute the scheduled task script using the installed entry path. |
| `src/app/live.mjs`, `src/app/publish.mjs` | Compose live sources and share the public snapshot projection across runtimes. |
| `src/demo/{runtime,scenario}.mjs` | Run both fixture modes through the shared runtime and transport. |
| `src/domain/{board-status,plan-parser}.mjs`, `src/sources/plan-files.mjs` | Export the existing history cap, table splitter and discovery exclusions for the extracted consumers. |
| `tests/packaging.test.mjs`, `tests/tools/stream-size.mjs` | Staged-layout, settings, task action, deadline and demo checks, plus the reproducible hook gate. |
| `README.md` | Document the archive layout and launching from another working directory. |

## Contract as built

`createLiveRuntime(config)` and `createDemoRuntime(config, mode)` use the P5 runtime interface.
`projectSnapshot` produces the public snapshot before publisher redaction and feed attachment.
Both demo modes preserve the v1 shape, including absent live Codex metadata.
`scheduledTaskScript(arg, config)` resolves the root action relative to the installed module.
The root still exports synchronous `createHudRuntime(config, demoMode)` to ES module callers.

## Deviations from the plan

The owner approved adding the standalone forwarder to P9 scope. The hook gate can run independently
of server resource measurement via `node tests/tools/stream-size.mjs --hooks`.

## Decisions taken

- Defer the forwarder’s output stream initialization with owner approval. The legacy CLI alias imports it directly.
- Verify the Windows scheduled task action through the generated script. The live task switchover is an owner-approved step after P10.
- Use the verified P1 archive for a same-session startup comparison and retain all measured hook p95 batches.

## Known issues

Eight pre-existing workflow lint findings remain, including the architecture PLAN's existing
`Status: **accepted**` header. Lint returned the same diagnostics as P1.
The optimized hook’s relative p95 remains sensitive to variation in bare Node process launch and exit.

## Out-of-scope findings

P10 owns the live release and switchover verification.

## Changes to earlier items

Accepted P7 after 27 targeted Node checks and P8 after 15 Edge layouts and six mount cycles.
Committed them as `645a1dc` and `a0ae048`. Exported the existing parser, history and discovery helpers
to restore the lint table traversal and timed demo board updates through the P9 entry points.

## Lasting knowledge

Deploy the root scripts with the complete `src/` tree. Paths resolve from installed modules.
Use `node tests/tools/stream-size.mjs --hooks` for the independent timing gate and
`--baseline` for the synthetic live startup and resource comparison. The README documents the packaging command.

## Next agent

Start P10 with the closeout workflow. Re-run the dedicated 30-launch benchmark alongside the P10
functional, stream, startup, memory, and live-read checks. Report the P10 measurement against the existing 15 ms budget.

## Review

Accepted 2026-11-27 by P10 review after all nine independent packaging, public contract and runtime checks passed with temporary profiles and HUD_NO_AUTOINSTALL=1. The P10 exit gate independently measures timing and resources.
