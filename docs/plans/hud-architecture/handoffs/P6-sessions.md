# P6 `sessions` handoff

**Date:** 2026-11-26 · **State:** handed-off · **Model / effort used:** Codex (GPT-6, session setting) ·
**Next:** P7

## Summary

Claude registry entries, Claude transcripts, Codex rollouts and hook POSTs have separate input adapters.
The runtime composes them with instance-local session and subagent state. The shared tail reader handles partial
UTF-8 lines and restarts at byte zero when a file is truncated or replaced.

## Exit gate

- [x] Registry/hook/Claude/Codex tests pass for reused PIDs, resumes, quiet and vanished sessions, subagent parenting,
  partially written input, transcript rotation, and no raw output in public data.
  The CLI self-test and all 61 Node tests passed on Node v22.12.0. The Codex test replaces a rollout with a
  larger file after the reader has buffered a partial record. It verifies that the replacement's model and
  usage are published, the prior tool state clears and the replacement's tool output stays private.
  [Hook tests](../../../../tests/hooks.test.mjs) · [Codex tests](../../../../tests/codex.test.mjs)
- [x] A before/after replay gives matching public sessions and token totals. On the P1 fixture workload,
  median time to the first full frame and peak RSS meet the phase tolerances against a fresh P1 run.
  Replayed the same fixture files and four hook timestamps through P5 at `252af2e` and P6. Deep equality
  passed at baseline, during a redacted tool call, and after Stop. It covered all 24 public sessions and
  6,144 usage records. The daily total was 6,144 input, 10,240 output and zero cached tokens.

`node tests/tools/stream-size.mjs --baseline` ran with temporary profiles, OS-assigned loopback ports,
`HUD_NO_AUTOINSTALL=1`, Node v22.12.0 and the same Windows execution permissions for both builds.

| Measurement | Original P1 record | P1 at `5c1a51c`, rerun | P6 | P6 versus P1 rerun |
|---|---:|---:|---:|---:|
| Median launch to first full frame, seven cold starts | 175.21 ms | 237.12 ms | 288.18 ms | +51.06 ms, within 100 ms |
| Peak RSS, process lifetime | 60,063,744 B | 68,091,904 B | 69,259,264 B | +1.71%, within 10% |
| Largest later SSE state frame | 19,336 B | 19,336 B | 19,336 B | 0 B |

Both P6 results exceed the original P1 record's absolute limits. The same-session replay controls for
the higher baseline readings. The read path audit found one cursor and one in-flight reader per file.
An overlapping request asks that reader to check again at its current offset. Buffered fragments are
released at the next newline or file reset.

Edge opened all 15 layouts across two checks. The full smoke run passed Cards, Network, the design gallery
and kiosk. One Network focus timeout also reproduced on archived P5 and passed on the P6 rerun. The
rerun then reached Activity before its stylesheet applied. A focused follow-up in the temporary copy
waited for the computed grid style. All four Activity layouts, the first-frame gate, stream lifecycle
and live fallback passed. Phone widths were emulated.

A live fixture HUD on Lane A port 7791 served both providers through `/api/state` and released the listener after teardown.

## Files changed

| File | Change |
|---|---|
| `hud.mjs`, `src/app/runtime.mjs` | Compose sources with domain state, wire watches into the runtime lifetime, and apply session inputs alongside existing board and publication rules. |
| `src/sources/tail-reader.mjs` | Share incremental byte reads, file identity, retry flags and partial-line buffering. |
| `src/sources/claude-registry.mjs`, `src/platform/windows-process.mjs` | Decode registry rows, check exact Windows FILETIMEs and query parent process IDs. |
| `src/sources/claude-transcripts.mjs`, `src/sources/codex-rollouts.mjs` | Discover and decode provider files through focused callbacks. |
| `src/sources/hooks.mjs` | Trim prompt fields before recording and dispatch hook events in arrival order. |
| `src/domain/{sessions,subagents,models,tools}.mjs` | Own session and subagent lifecycle state, provider and token helpers, and tool precedence. |
| `tests/codex.test.mjs` | Exercise rotation to a larger rollout while an old partial line is buffered. |
| `docs/plans/hud-architecture/STATUS.md`, `docs/status.md` | Record the P6 review state and next work. |

## Contract as built

- The P5 runtime interfaces still supply the same public snapshots and writer responses.
- `createTailReader({ task, signal, onChange, createInfo })` gives the adapters `open(file, onLine, onReset)`,
  `find(file)`, `read(tail)` and `values()`. A tail carries decoded info and an optional session owner.
- `createClaudeRegistry({ roots, hostname, lifetime, processLookup, reconcile })` supplies bounded registry
  facts through `reconcile(rows)`. The process lookup returns decimal FILETIME strings and a process-parent map.
- Claude transcript callbacks hand off tools, timestamp activity, prompt references and subagent file
  observations. Codex callbacks hand off normalized metadata, activity, status and tool observations.
- The P7 board code still reads retained IDs and file touches from session, subagent and tail info. Daily
  tokens are summed from each tail's `info.byDay`.

## Deviations from the plan

None.

## Decisions taken

- Compare resource measurements against an archive of the original P1 commit rerun in this session.
  Keep the original P1 numbers for P10 and release review.
- Treat a device and inode change as replacement even when the new file is larger. Check the open file's
  identity and length before seeking so a replacement between path lookup and open cannot reuse the old offset.

## Known issues

The filesystem may allow a same-file truncate and regrow to the previous size between observations. The
reader detects observed size reductions and file identity changes. The sustained live RSS and CPU release
checks belong to P10.

## Out-of-scope findings

The existing smoke harness can reach the Activity layout assertion before the Activity stylesheet applies.
The Network focus wait failed intermittently on both P5 and P6. These browser checks are in P8's scope.

The archival baseline and the standalone-hook timing gate are recorded in the P1 handoff. P9 and P10
own the hook and live-release verification. [P1 handoff](P1-baseline.md)

## Changes to earlier items

Accepted P5 after all 12 runtime, stream and public contract checks passed and committed it as `252af2e`.
[P5 review](P5-runtime.md#review)

## Lasting knowledge

Keep the reader's byte offset, file identity and unfinished UTF-8 fragments together. For Windows registry
liveness, compare decimal FILETIME strings exactly and accept legacy rows without a usable creation time.
The associated regressions are in the Node suite. P10 should carry these rules into the architecture guide.

## Next agent

Start with `hud.mjs` composition and `src/app/runtime.mjs`. Keep the Claude prompt-reference and file-touch
callbacks connected while moving board code. Review P6 using `node --test tests/codex.test.mjs tests/hooks.test.mjs`
with `HUD_NO_AUTOINSTALL=1`. Lane A uses port 7791.

## Review

Accepted on 2026-11-26 by P7. Ran the requested Codex and hook gate with HUD_NO_AUTOINSTALL=1 on Node v22.12.0. All 25 checks passed, including exact Windows PID identity, larger rollout replacement with a buffered partial record, restart, and hook ordering.
