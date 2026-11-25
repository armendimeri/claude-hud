# P1 `harness` handoff

**Date:** 2026-11-25 · **State:** handed-off · **Model / effort used:** Opus 5.5 / medium ·
**Next:** P2

## Summary

`tests/helpers.mjs` starts a HUD over temp folders on an OS-given port and gives every later item `state`, `until`,
`post`, `stream`, `restart`. `tests/hooks.test.mjs` replays hook events; `tests/codex.test.mjs` now uses the helpers.
`browser-smoke.mjs` runs its own `--demo` HUD at three sizes (9 screenshots). `HUD_RECORD=<file>` records hook events.

## Exit gate

- [x] `node hud.mjs selftest` ends with "all checks passed".
  ```
  $ node hud.mjs selftest
  ...
  all checks passed
  ```
- [x] `node --test tests/` reports 0 failed: **14 passed** (8 in codex.test.mjs, 6 in hooks.test.mjs).
  ```
  $ node --test tests/
  ✔ Claude and Codex coexist, update incrementally, and survive restart (4108.157ms)
  ✔ hook events drive the session state (94.771ms)
  ✔ HUD_RECORD writes each accepted event, redacted, and nothing when unset (327.9875ms)
  ℹ tests 14
  ℹ pass 14
  ℹ fail 0
  ```
  `node --test` with no argument gives the same 14 / 14 / 0.
- [x] Items that touch the page: P1 doesn't change the page, but the smoke test was run and the screenshots looked
  at (below).
- [x] `README.md` says what the code now does: the Commands block (`node --test tests/`, `node tests/browser-smoke.mjs`),
  the "What it reads" row for hook events, and a paragraph at the end of "The hooks" for `HUD_RECORD`.
  `docs/DESIGN.md` is not touched: nothing visible changed.
- [x] `tests/codex.test.mjs` uses `startHud` and still has its 8 subtests passing.
  `startHud({ start: false })`, files written, then `hud.restart()`; `hud.restart()` again for the restart subtest.
  ```
  $ node --test tests/codex.test.mjs
    ✔ source identity, parent tree, cumulative tokens and privacy
    ✔ conversations and subagents from long ago are not shown as just ended
    ✔ HTTP, SSE and generated browser scripts
    ✔ split UTF-8 lines, tool output discard, questions and turn completion
    ✔ expired session resumes and a newly created rollout is discovered
    ✔ usage survives a server restart without duplication
    ✔ truncated rollouts reset usage and model without losing attachment
  ✔ Claude and Codex coexist, update incrementally, and survive restart
  ℹ tests 8   ℹ pass 8   ℹ fail 0
  ```
  (8 = the 7 subtests plus their parent test, the same count as before the change.)
- [x] `tests/hooks.test.mjs` has the four cases of §5, passing.
  ```
  ▶ hook events drive the session state
    ✔ a PreToolUse sets the current tool
    ✔ Stop clears the current tool
    ✔ a Notification with permission_prompt gives needs-you
    ✔ an Agent call with SubagentStart and SubagentStop gives one finished subagent
  ✔ hook events drive the session state
  ✔ HUD_RECORD writes each accepted event, redacted, and nothing when unset
  ```
- [x] `node tests/browser-smoke.mjs` with no argument starts and stops its own demo HUD and writes 9 screenshots.
  ```
  $ node tests/browser-smoke.mjs
  pass network at 1440x900: no runtime exception, no horizontal page scroll
  ... (9 pass lines: network, cards, design × 1440x900, 1024x768, 390x844)
  pass browser runtime; 9 screenshots:
    .hud-tmp\smoke-network-1440x900.png   .hud-tmp\smoke-network-1024x768.png   .hud-tmp\smoke-network-390x844.png
    .hud-tmp\smoke-cards-1440x900.png     .hud-tmp\smoke-cards-1024x768.png     .hud-tmp\smoke-cards-390x844.png
    .hud-tmp\smoke-design-1440x900.png    .hud-tmp\smoke-design-1024x768.png    .hud-tmp\smoke-design-390x844.png
  exit=0
  ```
  Looked at: `smoke-network-1440x900.png` (demo network, plans, feed), `smoke-cards-390x844.png` (phone cards,
  needs-you banner), `smoke-design-1024x768.png` (gallery colour tokens). Afterwards no `hud.mjs` child, no headless
  Edge with an `edge-profile-` folder, and no `hud-test-*` temp folder is left (see the last box).
- [x] With `HUD_RECORD` set, one posted event gives one JSON line with secrets masked; unset, no file is written.
  A throwaway script over two helper HUDs (one with `HUD_RECORD=<dir>/events.jsonl`, one without):
  ```
  set:   POST -> 204
  unset: POST -> 204
  set:   lines = 1
  set:   line  = {"session_id":"proof-1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"tu-1","tool_input":{"command":"deploy --token ••• api_key=•••"},"cwd":"C:\\Users\\armen\\AppData\\Local\\Temp\\hud-test-smrtCf"}
  unset: files = []
  ```
  The same is asserted in `tests/hooks.test.mjs` (Bearer and `--password` masked, a bad body is refused and not
  recorded, no `.jsonl` anywhere in the unset HUD's folder).
- [x] After the tests, port 7777 still answers and no extra `hud.mjs` process is left.
  ```
  7777 /api/health -> 200 {"ok":true,"uptime":3062835,"sessions":5,"version":"0.2.0"}

  ProcessId CreationDate        CommandLine
  --------- ------------        -----------
      65024 25.11.2026 20:27:59 "C:\Program Files\nodejs\node.exe" C:\Users\armen\source\repos\armendimeri\claude-hud\hud.mjs --lan

  msedge headless left: 0
  temp hud-test-* folders left: 0
  ```
  65024 is the owner's live HUD (same process before and after the tests).

## Files changed

| File | New / changed | What |
|---|---|---|
| `tests/helpers.mjs` | new | §4.5: `startHud`, `transcript`, `registry`, `board`, `said`, plus `freePort`, `pause`, `script`. |
| `tests/hooks.test.mjs` | new | The four hook cases, and `HUD_RECORD` on and off. |
| `tests/run-all.mjs` | new | Loads every `tests/*.test.mjs`; what `node --test tests/` runs (see Decisions). |
| `tests/package.json` | new | `"main": "run-all.mjs"`, so `node --test tests/` resolves to it. |
| `tests/codex.test.mjs` | changed | Its own spawn, port and polling code replaced by `startHud`; SSE check through `hud.stream()`. Assertions unchanged. |
| `tests/browser-smoke.mjs` | changed | Its own `--demo` HUD via `startHud`, 3 routes × 3 sizes, a failure per page on exception or sideways scroll, 9 screenshots. No URL argument any more. |
| `hud.mjs` | changed | `handle()`: `HUD_RECORD`. `HELP`: a line for it. |
| `README.md` | changed | Commands, "What it reads" row, `HUD_RECORD` paragraph under "The hooks". |

`.gitignore` already ignores `.hud-tmp/`; not changed.

## Contract as built

As PLAN §4.5, with these additions (all optional, nothing in §4.5 removed or renamed):

```
startHud({ demo = false, env = {}, start = true })
  demo: true | 'dense'                       -> hud.mjs --demo | --demo=dense
  env:  object | (dir) => object             overrides; HUD_RECORD defaults to '' (off)
  start: false                               nothing runs until hud.restart()
→ { base, port, dir, claude, codex, extraCodex, child,
    state(), until(predicate, ms = 20000), post(event) → HTTP status,
    stream() → { headers, events: [{ event, data }], next(predicate?, ms = 20000) → { event, data }, close() },
    stop(), restart(), stderr() → string, close() }      // close = stop + delete dir; call it from t.after
transcript(hud, sessionId, lines, { project = 'p' })  → file   // appends; lines are objects or JSON strings
registry(hud, sessionId, { pid, file = `${pid}.json`, ...fields }) → file   // cwd = hud.dir, status 'idle' by default
board(hud, slug, markdown) → <hud.dir>/docs/plans/<slug>/STATUS.md
said(sessionId, at = now, extra) → one assistant JSON line ending in \n (at: Date, epoch ms or ISO string)
freePort(), pause(ms), script (absolute path of hud.mjs)
```

Folders: `dir` is HOME/USERPROFILE; `dir/claude` (with `sessions/`, `projects/`) is `CLAUDE_CONFIG_DIR`;
`dir/codex` is `CODEX_HOME`; `dir/extra-codex` (with `sessions/`) is `HUD_CODEX_DIRS`. `startHud` returns once
`/api/health` answers (or `restart()` does). `HUD_RECORD`: a line per accepted `/event` body (valid JSON, after the
host, loopback, origin and content-type checks), `JSON.stringify(redactDeep(body))`, appended synchronously before
`onHook`; also in `--demo`. A write error goes to stderr and the event is still handled.

## Deviations from the plan

- `browser-smoke.mjs` no longer takes a URL (PLAN: "instead of taking a URL").
- Extra helper fields listed above (`start`, `env` as a function, `extraCodex`, `child`, `stderr`, `close`,
  `file` in `registry`, `project` in `transcript`): the Codex test needs files in place before the HUD starts, a
  HUD_RECORD path inside its own temp folder, and two registry files with the same pid.

## Decisions taken

- **`node --test tests/` on this PC.** Node here is v26.7.0 (not 22). It takes a folder argument as a module path,
  so at the baseline `node --test tests/` failed with "Cannot find module '…\tests'" before any test ran. The plan's
  gate command is kept working by `tests/package.json` (`main: run-all.mjs`) and `tests/run-all.mjs`, which imports
  every `*.test.mjs`. `node --test` (no argument) still finds the same files by itself and never runs `run-all.mjs`.
  Every test file is now run in one process under `node --test tests/`; each test still has its own HUD and port.
- The browser smoke's text check accepts "Codex" or "gpt-" (the cards view shows the demo Codex session by its
  model, not the word), keeps the LIVE (SSE) check and the visible-geometry check for network and cards; `/design`
  is checked for having rendered.
- `HUD_RECORD` records in `--demo` too (the event is accepted there, only ignored).

## Known issues

- `redactDeep` treats a real `tool_use_id` (`toolu_01…`, a 24-character run with digits) as a key and masks it, so a
  recording of real events loses the pairing of PreToolUse and PostToolUse. Made-up ids in tests are short and
  survive. See Out-of-scope findings.

## Out-of-scope findings

- Recording: to replay real recordings, `tool_use_id`, `session_id` and `agent_id` need to survive redaction
  (add them to `NO_REDACT`, or record with a redaction that keeps id fields). `NO_REDACT` is outside P1's scope.
- `docs/plans/hud-0-3` assumes Node 22; this PC runs Node 26.7.0. Nothing else broke.
- Network view at 1440×900 (demo): the legend line "RUNNING · LAUNCHED BY" at the bottom of the session panel
  overlaps the label of the lowest subagent ("GENERAL-PURPOSE", "haiku 5.5 · 7.6k") in `smoke-network-1440x900.png`.
  Page work (P5 to P7) may want to look.

## Changes to earlier items

None.

## Lasting knowledge

- Every integration test starts its HUD with `startHud` from `tests/helpers.mjs`: free port from the OS, temp
  folders, `HUD_NO_AUTOINSTALL=1`, `HUD_LAN=0`, stopped by its own child handle. `post` can only reach that HUD.
  Belongs in the README's test lines (done) and should outlive the plan.
- `node --test tests/` works on Node 26 only through `tests/package.json` + `tests/run-all.mjs`. Don't delete them,
  and name new test files `*.test.mjs` so both commands pick them up.

## Owner checks

- Nothing visible changed in P1. Optionally glance at the 9 screenshots in `.hud-tmp/smoke-*.png`.
- To record real hook events for later tests, the HUD that receives them (the one on port 7777) has to be started
  with `HUD_RECORD=<file>`; agents never restart it, so that is yours to do when you want it. Mind the id masking
  under Known issues.

## Next agent: start here

- Read `tests/helpers.mjs` (top comment of `startHud`) and `tests/hooks.test.mjs` for the pattern:
  `const hud = await startHud(); t.after(() => hud.close()); await hud.post({ session_id, hook_event_name, cwd: hud.dir, ... }); await hud.until(s => ...)`.
- A session made only by hooks shows in `/api/state` today (`lastHookAt`). P2's D7 ("appears after 8 seconds or at
  its first work") will touch that; the hook tests send `UserPromptSubmit` or `PreToolUse` first, which is work.
- Run: `node hud.mjs selftest`, `node --test tests/`, `node tests/browser-smoke.mjs` (Edge, about 30 s).

## Review

- 2026-11-25 · coordinator · **accepted**. Checked: `node hud.mjs selftest` all checks passed; `node --test tests/` 14 pass / 0 fail; `node tests/browser-smoke.mjs` 9 passes, screenshots cards-390x844 and network-1440x900 looked at; `git status` shows only P1-scope files; the `hud.mjs` diff is only `handle` and `HELP`. Re-ran two gate boxes independently: HUD_RECORD on a temp HUD via `startHud` wrote 1 line per event, and the smoke run. Finding (not P1's fault, out of scope): `redactDeep` masks by text pattern only, so a plain string under a field named `api_key` (no `key=value` in the text) is recorded unmasked. Worth a look before anyone records real events. Port 7777 /api/health 200 after.
