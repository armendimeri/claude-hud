# P10 `review` closeout evidence

**Date:** 2026-11-27 · **State:** handed-off · **Model / effort used:** Codex (session setting)

## Summary

Accepted P9 after nine independent checks and committed its packaging changes at `0dc01ef`.
The extracted candidate passed functional parity and relative startup and RSS checks.
The plan is verified on the final staged candidate. Earlier misses and repeat timing variability are recorded below.

## Initial verification

- [x] `node hud.mjs selftest` passed 88 checks and `node --test tests/` passed 66 of 66
  in 185.5 s. `node tests/browser-smoke.mjs` passed 15 Edge layouts and six mount cycles on a
  fresh-profile retry after the first navigation timed out. Reviewed all 28 screenshots across
  dashboard, gallery, kiosk, board and Activity at their tested widths. Lint findings are below.

- [ ] Dense SSE, P1 startup and RSS tolerances, and the standalone hook gate. Dense SSE passed at
  28,916 B over 29 later state frames with `node tests/tools/stream-size.mjs --demo=dense --seconds=30`.
  The fixture startup and RSS tolerances passed. The independent hook batches straddled the 15 ms limit.
- [ ] Ten-minute read-only live check. The candidate stayed under 150 MB. Mean CPU exceeded 1% on both
  builds. Live expiry and the unresolved ID-prefixed links require a sample that captures those cases.
- [x] Activity change set, fixture and real SSE, including reconnect, and the deployment and rollback
  rehearsal. Edge verified the Activity fixture trace and the normal and dense demo routes.
  The dense preview reconnected without navigation and rendered a fresh first frame after a real
  server restart. The rollback rehearsal passed. [Deployment runbook](../../../ARCHITECTURE.md#windows-deployment-and-rollback)

### Same-session fixture comparison

Windows x64, Node v22.12.0. `node tests/tools/stream-size.mjs --baseline --seconds=30` used the same
16 Claude / 8 Codex profile fixture, seven launches, one SSE subscriber and the same permissions
in the P1 archive (`5c1a51c`) and the extracted candidate.

| Metric | P1 | P10 | Delta |
|---|---:|---:|---:|
| Median launch to first full frame | 128.34 ms | 150.47 ms | +22.13 ms, within +100 ms |
| Peak working set | 67,571,712 B | 69,033,984 B | +2.16%, within +10% |
| Largest later state frame | 19,366 B | 19,320 B | −46 B |

Each hook batch ran 30 interleaved launches per command with identical synthetic stdin. The loopback
receiver got all 60 posts in each batch. Both hook commands stayed silent and exited 0.
The standalone budget is +15 ms p95 over bare Node.

| Batch | Bare Node p95 | Legacy p95 | Standalone p95 | Overhead |
|---|---:|---:|---:|---:|
| Candidate `--hooks` | 52.36 ms | 68.85 ms | 68.12 ms | +15.76 ms, exceeds budget |
| P1 `--baseline` | 101.15 ms | 157.64 ms | 146.71 ms | +45.56 ms, exceeds budget |
| Candidate `--baseline` | 77.31 ms | 99.59 ms | 82.89 ms | +5.58 ms, within budget |

### Ten-minute live read

Two isolated processes read the same live folders simultaneously. The candidate listened on 7790
and P1 used an OS-assigned loopback port. Each had 601 one-second process samples and HTTP state
reads, plus one SSE subscriber, over 599.98 s. Auto-install, recording, push and external usage
were disabled. Only aggregate observations were saved. CPU uses process CPU seconds divided by
elapsed seconds on one logical core. RSS is the Windows process lifetime peak working set.

| Metric | P1 | P10 | Delta |
|---|---:|---:|---:|
| Peak RSS | 84.93 MB | 85.23 MB | +0.30 MB |
| Mean CPU | 1.542% | 1.714% | +0.172 percentage points |
| Peak rolling 30-second CPU | 6.258% | 7.614% | +1.356 percentage points |
| Largest later state frame | 13,074 B | 13,074 B | 0 B |
| Later state frames | 248 | 249 | +1 |
| SSE feed entries | 105 | 104 | −1 |

Each watcher saw at most seven sessions and four plans. Each observed eight new visible sessions
and two removals from an open state. Neither recorded a visibility interval under eight seconds,
a transition to ended, or a blank subagent. The Node suite separately verified the eight-second
settle behavior, expiry and resumption using fixtures.

On each build the single sampled work link matched its board entry. The observer detected three
P1 and four candidate running subagents with ID-shaped description prefixes without an active link
for that prefix. The original observer counted labels by shape. A 20-second paired recheck found no
active ID-prefixed subagents to test for a matching item in the same project. The link observations
therefore leave live matching unresolved. Each stream delivered its observed feed without a
duplicate. The Node suite separately verified plan disambiguation and exactly-once mark feed delivery.

### Local evidence

The extracted candidate, both benchmark logs and the read-only probe results are under
`C:/Users/armen/AppData/Local/Temp/hud-p10-f8b1e64c1dd6403c95eae414c7d46ba3`. The browser screenshots and review sheets are in `edge-retry/` and
`screenshot-review-1.png` / `screenshot-review-2.png` under that directory.

### Lint

`node hud.mjs lint . --json` reports the existing `Status: **accepted**` header on the architecture
PLAN. Six existing findings elsewhere cover the missing `CLAUDE.md` and roadmap, the duplicate
project status, two findings in the legacy Codex support plan, and the copied protocol heading in
the workflow plan. Adding the owner check list resolved the previous missing-checks diagnostic.

## Files changed

| File | Change |
|---|---|
| `README.md`, `docs/ARCHITECTURE.md` | Link the architecture, verification, deployment and rollback guide. |
| `docs/adding-a-view.md`, `tests/browser-smoke.mjs` | Show the Activity change set and check a real dense-demo restart in the mounted preview. |
| `docs/checks.md`, `docs/status.md`, architecture board and this handoff | Record remaining owner checks and the P10 evidence. |

## Contract as built

The public contract and release code are those of `0dc01ef`. Staging used a complete distribution.
All 83 executable entry, module and stylesheet files in the committed ZIP matched the worktree
after normalizing Git line endings. The fixture rehearsal used alternate working directories and verified candidate and
previous server health, public assets, the migration backup and byte-exact settings restoration.
The packaging suite checked the generated Windows task action and LAN flag. The live task
registration and real-device checks are listed in [owner checks](../../../checks.md).

## Decisions taken

Used a same-session P1 baseline for both resource comparisons and recorded all hook batches.
Used process handles for the isolated listeners and disposable settings in the deployment
rehearsal. Retained the plan and its evidence while the release gate is open.

## Findings from the first pass

- P1 and the candidate both exceeded the 1% live mean CPU target. The candidate's mean was 0.172
  percentage points higher. D6 leaves release performance review open when the starting build misses.
- P9's packaging role owns any standalone hook timing follow-up. P7's board role owns diagnosis if the
  missing in-flight links reproduce for a worker with a corresponding item in its project.
- The architecture PLAN's existing header and the other workflow lint findings remain visible.

## Lasting knowledge

The [architecture guide](../../../ARCHITECTURE.md) documents runtime ownership, the public SSE
boundary, verification commands and Windows deployment and rollback. The
[view guide](../../../adding-a-view.md) documents the Activity module, asset registration and transport tests.

## Verification follow-up

At the owner's request, this pass extended P10 from verification to fixing the findings.
The revised build skips large Claude records that were already ignored, reuses Codex tail
file checks, and avoids allocating intermediate key/value arrays during redaction.
Board discovery caches parsed records until the file or its companion changes. The
publisher reuses the redacted plan array, and SSE reuses its serialization. The hook
reuses its stdin handle and exits on the HUD's response bytes. The 400 ms deadline,
standalone entry, payload allowlists and loopback request still passed their fixture checks.

The transcript microbenchmark read the same 104.92 MiB fixture five times per build after
warmup. Median process CPU fell from 578 ms to 156 ms. The regression tests exercise both
oversize ignored records and multibyte model records with a valid character count.

### Rechecked live and fixture performance

| Ten-minute profile comparison | P1 mean CPU | Candidate mean CPU | Candidate peak rolling CPU | Candidate peak RSS |
|---|---:|---:|---:|---:|
| Transcript and redaction fixes | 1.023% | 1.068% | 3.803% | 86.45 MB |
| Board and SSE caching added | 1.307% | 0.982% | 3.230% | 86.75 MB |

The same live folders were read by paired processes with one SSE subscriber and 601
one-second resource samples per build. In the second run both streams produced 194 later
state frames, a 9,701 B peak, 76 feed entries without duplicates, and a board-consistent
work link. The first run captured three transitions to ended on each build. The live-mode
fixtures exercised an actual silence expiry and an in-flight ID-prefixed worker linked
to the matching plan. No running worker with a matching project item was observed in
the follow-up live window.

Dense demo later frames peaked at 28,945 B. The 30-second P1 fixture replay had a peak
working set of 68,915,200 B versus 69,664,768 B (+1.09%). Sequential launches measured
177.68 ms for P1 and 291.38 ms for the candidate (+113.70 ms). Seven interleaved launches
per build, with the same input and 10 ms retry interval, measured 324.55 ms and 420.40 ms
(+95.86 ms), within the 100 ms tolerance. Both launch results are retained.

### Rechecked hook

All timed batches delivered 60 posts and both hook commands stayed silent and exited 0.
The first three revised `--hooks` batches measured +30.70, +49.42 and +29.97 ms p95.
Four later batches measured +86.23, +46.97, +31.18 and +35.94 ms. All exceeded the +15 ms gate.
The fixture replay's embedded batch measured +59.15 ms.

In a paired diagnostic, prior and revised p95 were 123.87 and 88.98 ms against a
bare-Node p95 of 89.80 ms. The other diagnostic batches varied. An empty ES module
alone added 12.29 and 20.53 ms across two control batches. Timing through the process
exit event or until stdio closed produced near-identical values. Hook entry to the
receiver measured 8–15 ms p95 across diagnostics. The direct-FD variant failed the
Windows held-open-stdin test and was discarded.

The revised staged build passed 88 self-checks, 68 Node tests, 15 Edge layouts, a real
Activity reconnect, six mount cycles and deployment rollback using disposable settings.
All 28 revised screenshots were reviewed. The architecture PLAN header now passes
lint. The same six existing findings elsewhere remain under the workflow migration.

Logs and fixture screenshots for this follow-up are under
`C:/Users/armen/AppData/Local/Temp/hud-p10-fix-5b3a9e5b7e4b41858bceddd310fa7e8d`.

## Final verification

The memory fix limits cached string size and total cached characters. Short display
summaries detach from large backing strings after redaction. A synthetic workload with
160 unique commands retained 96,734,056 B in the prior heap and 712,288 B after the fix.
The previous ten-minute SSE-only comparison hit 1.362% mean CPU and 150.70 MB RSS.
The final SSE-only run used the memory-bounded build for 599.997 s.

| Metric | P1 | Candidate |
|---|---:|---:|
| Live mean single-core CPU | 0.883% | 0.617% |
| Live peak rolling 30-second CPU | 1.511% | 1.094% |
| Live peak RSS | 90.32 MB | 87.75 MB |
| Largest live later state frame | 10,979 B | 10,979 B |
| SSE feed entries | 59 | 59 |

Both streams delivered feed entries without duplicates and had a sampled link consistent
with its board. The earlier live run observed three expiries per build. Fixture tests
checked timed expiry, resumption and the in-flight ID-prefixed worker's plan.

- [x] `node hud.mjs selftest` passed 89 checks. `node --test tests/` passed all 68 on
  the memory-bounded build. After changing only the CLI import scheduling, all 15
  focused CLI, runtime, public contract and stream tests passed. Edge then passed all
  15 layouts and six mount cycles, with 28 screenshots. Architecture plan lint is clean.
- [x] Dense demo's largest later frame was 29,014 B. The final fixture comparison measured
  67,723,264 B peak RSS at P1 and 68,648,960 B on the candidate (+1.37%). After the
  HTTP and runtime imports were started concurrently, sequential candidate startup was
  234.67 ms (+88.66 ms vs P1). The latest seven-run paired recheck measured 238.01 ms at
  P1 and 233.23 ms on the candidate. An earlier paired run on the same code measured
  a +119.47 ms difference during a slower launch period.
- [x] The standalone hook's 30-run gate passed at +10.41 ms p95 over bare Node.
  The three p95 values were 58.23 ms bare, 67.53 ms legacy and 68.65 ms standalone.
  The receiver got all 60 posts and both entry points stayed silent and exited 0.
  The two additional dedicated batches measured +16.33 and +20.75 ms. A fixture batch
  measured −10.02 ms and the post-CLI retest's embedded batch measured +51.59 ms.
  The separate held-open stdin and response tests passed with the 400 ms budget.
- [x] The ten-minute live run passed the 1% mean CPU and 150 MB RSS limits with
  `HUD_NO_AUTOINSTALL=1`, candidate port 7790 and an OS-assigned P1 port.
- [x] Activity rendered against fixture frames and real SSE. It reseeded after a
  real dense-demo restart. Staged deployment and rollback exercised alternate working
  directories and byte-exact fixture settings restoration.
  [Architecture guide](../../../ARCHITECTURE.md)

The final evidence includes the passing 30-run hook gate required by the plan.
Repeated Windows launches still vary, as the additional measurements show. The six
repository lint findings outside this plan belong to the workflow migration. The
[owner checks](../../../checks.md) list the production task and LAN verification.
