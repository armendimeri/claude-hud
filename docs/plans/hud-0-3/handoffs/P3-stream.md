# P3 `stream` handoff

**Date:** 2026-11-25 · **State:** handed-off · **Model / effort used:** Opus 5.5 / high ·
**Next:** P4

## Summary

The stream starts each connection with the full state (`full: true`), then sends `state` without `plans` and `feed`,
and a `plans` event only when the boards' JSON changed. The page keeps the last plans and feed, counts the "Working"
chip itself, and rebuilds need rows and run chips only when their text changed. With `--demo=dense` a later `state`
went from 36.8 KB to 24.2 KB on average. `tests/tools/stream-size.mjs` measures it.

## Exit gate

- [x] `node hud.mjs selftest` ends with "all checks passed".
  ```
  $ node hud.mjs selftest
  ...
  pass  install: removeOurs keeps other hooks

  all checks passed
  ```
- [x] `node --test tests/` reports 0 failed: **25 passed** (22 from before, 3 new in `tests/stream.test.mjs`).
  ```
  $ node --test tests/
  ✔ Claude and Codex coexist, update incrementally, and survive restart (6145.8565ms)
  ✔ hook events drive the session state (158.4998ms)
  ✔ HUD_RECORD writes each accepted event, redacted, and nothing when unset (391.0855ms)
  ✔ truthful sessions: placeholders, settle time and the waiting parent (33737.7694ms)
  ▶ the stream sends plans and feed only when they change
    ✔ the first state has plans and feed; later ones have neither; a board edit gives one plans event (2221.6796ms)
    ✔ after restart(), the first message of a new connection is complete again (130.8722ms)
  ✔ the stream sends plans and feed only when they change (2488.7164ms)
  ℹ tests 25
  ℹ pass 25
  ℹ fail 0
  ```
  The new test fails against the code from before P3 (a copy of the old `hud.mjs` and the new test in
  `.hud-tmp/p3-neg/`): `AssertionError: plans no longer carry working (the page counts it)`.
- [x] Items that touch the page: `node tests/browser-smoke.mjs` passes (exit 0, 10 `pass` lines, 9 screenshots).
  ```
  $ node tests/browser-smoke.mjs; echo "smoke exit=$?"
  pass network at 1440x900: no runtime exception, no horizontal page scroll
  ... (network, cards, design × 1440x900, 1024x768, 390x844)
  pass browser runtime; 9 screenshots:
  smoke exit=0
  ```
  Looked at: `.hud-tmp/smoke-network-1440x900.png` (network, plans with the FidiaCRM card's WORKING chip, feed),
  `.hud-tmp/smoke-cards-390x844.png` (phone cards, no sideways scroll), `.hud-tmp/p3-shots/smoke-network-390x844.png`
  (plans panel below the network with WORKING and NEEDS YOU), `.hud-tmp/p3-shots/p3-reconnect-1440x900.png` (the page
  after the HUD it was on restarted: "UP 8S", LIVE, plans and a new feed).
- [x] `README.md` and `docs/DESIGN.md` say what the code now does. README: the Commands block
  (`tests/tools/stream-size.mjs`), the Routes paragraph (what the stream sends, `full: true`, 24 KB from 37 KB), and
  "Using the page" (what the plan's Working chip counts). `docs/DESIGN.md` is outside P3's scope and says nothing
  about the stream or the plan card's Working chip, so nothing in it became wrong (see Out-of-scope findings).
- [x] Test: the first `state` has `plans` and `feed`; later ones have neither; a board edit gives one `plans` event.
  `tests/stream.test.mjs`, first subtest above: the first message is a `state` with `full: true`, plans (1 board) and
  feed; three or more later states (hook events change the session) have no `plans`, no `feed`, no `full`; no
  `plans` event before the edit; rewriting the board gives exactly one `plans` event (counted 1.5 s after the next
  state), with P1 `in-progress`, and the board's feed line arrives as an `event`.
- [x] Test: after `restart()`, the page's next first message is complete again (checked through the stream). Second
  subtest: after `hud.restart()` a new `/api/stream` connection's first message is a `state` with `full: true`, the
  board (P1 `in-progress`), the feed and the session. The page side was also seen in a browser: the scratch check
  below restarts its demo HUD while the page is open, and 6 s later the page reads LIVE with 6 `.plan` elements and
  40 feed lines (`P3 cards at 1440x900 6 s after a HUD restart: {"live":true,"plans":6,"feed":40}`).
- [x] `tests/tools/stream-size.mjs` against `--demo=dense` for 30 s: the average later `state` is **24.2 KB** (max
  24.3), from **36.8 KB** (max 44.6) before the change.
  ```
  before (hud.mjs at the start of P3, same tool):
  $ node tests/tools/stream-size.mjs --demo=dense --seconds=30
  event           count   avg KB   max KB  total KB   per s   KB/s
  event             100      0.2      0.2      18.3    3.33    0.6
  state (first)       1     28.2     28.2      28.2    0.03    0.9
  state (later)      29     36.8     44.6    1067.8    0.97   35.6
  all               130                      1114.4           37.1

  after:
  $ node tests/tools/stream-size.mjs --demo=dense --seconds=30
  event           count   avg KB   max KB  total KB   per s   KB/s
  event              81      0.2      0.2      15.0    2.70    0.5
  plans               1      1.4      1.4       1.4    0.03    0.0
  state (first)       1     28.8     28.8      28.8    0.03    1.0
  state (later)      29     24.2     24.3     701.1    0.97   23.4
  all               112                       746.4           24.9
  ```
  The dense demo has one board, so most of what is left is its 24 sessions. Before, the later state grew with the
  feed (up to 200 lines); now it doesn't.
- [x] Smoke test: plans and feed are still on the page 10 s after load, in both views. `tests/browser-smoke.mjs` is
  outside P3's scope, so this ran in a scratch copy of it (`.hud-tmp/p3-stream-check.mjs`, ignored by git) with the
  extra checks: 10 s after load, plan cards, feed lines and a Working chip; a board change that comes only as a
  `plans` event is drawn; a HUD restart while the page is open.
  ```
  $ node .hud-tmp/p3-stream-check.mjs
    P3 network at 1440x900 after 10 s: {"plans":6,"feed":10,"working":3,"nodes":98}
    P3 network at 390x844 after 10 s: {"plans":6,"feed":27,"working":3,"nodes":99}
    P3 cards at 1440x900 after 10 s: {"plans":6,"feed":36,"working":3,"nodes":99}
    P3 cards at 1440x900 6 s after a HUD restart: {"live":true,"plans":6,"feed":40}
    P3 cards at 390x844 after 10 s: {"plans":6,"feed":23,"working":3,"nodes":99}
    P3 cards at 390x844 board change: api P1:handed-off P2:todo P3:todo P4:todo -> P1:accepted P2:in-progress P3:in-progress P4:todo; page P1:accepted P2:in-progress P3:in-progress P4:todo
  pass browser runtime; 10 screenshots:
  exit=0
  ```
  (`.plans .plan` counts 6 for the demo's 3 boards both before and after P3; the same check against the old code
  found 6 too, and 0 Working chips, because the demo's plans never had `working`.)

After all runs: port 7777 `/api/health` → `{"ok":true,"uptime":5205492,"sessions":7,"version":"0.2.0"}`; the only
`hud.mjs` process is the owner's 65024 (started 20:27:59, `--lan`); 0 headless Edge with an `edge-profile-` folder;
0 `hud-test-*` temp folders.

## Files changed

| File | New / changed | What |
|---|---|---|
| `hud.mjs` | changed | Engine: `snapshot` drops `working` from plans; `lastPlansBody` and new `sendPlans`; `scheduleState` sends `plans` on change and `state` without `plans` and `feed`; `openStream` sends the full state with `full: true` (and first brings the clients already connected up to date). Page: `planCard().update(p, working)` with need-row and run-chip signatures; `createHud` `renderPlans` counts Working by project; `render` keeps the drawn plans and feed when a state has none and syncs the ticker once per feed array; `pageMain` keeps plans and feed, replaces them on a `full` state, handles `plans`. |
| `tests/stream.test.mjs` | new | "the stream sends plans and feed only when they change", 2 subtests. |
| `tests/tools/stream-size.mjs` | new | Reads a HUD's stream (a URL, or its own `--demo[=dense]` HUD) for `--seconds` and prints count, size and rate per event. |
| `README.md` | changed | Commands (the tool), Routes (the stream), Using the page (the Working chip). |

## Contract as built

- Stream as PLAN §4.4, plus: the first `state` of every connection has `full: true`; later ones have no `full`, no
  `plans`, no `feed`. `/api/state` has no `full`.
- `plans` event data: `{ plans: [...] }`, the same plan objects as `/api/state`'s `plans`. Sent when
  `JSON.stringify(plans)` differs from the last plans sent to (or connected with) every client; it goes before the
  `state` of the same push.
- `plans[n].working` is gone. The page's count: sessions of the project with `status` busy or needs-you, or not
  ended with `agentsRunning > 0`. P4 replaces it with `board.plans[planKey].active`: change `working(p)` in
  `renderPlans`.
- `planCard().update(p, working = 0)`. The `/design` gallery calls `update(p)` with its fixtures, unchanged.
- `createHud().render(st)` accepts a state without `plans` or `feed` and keeps the ones it drew. `tick.sync` runs
  only when `st.feed` is a different array from the last one synced.
- `makeDemo` needed no change: the demo's snapshot goes through the same `scheduleState` and `openStream`.

## Deviations from the plan

- The smoke-test box was checked with a scratch copy of the smoke test, not by changing `tests/browser-smoke.mjs`
  (not in P3's scope). The unchanged smoke test also passes.
- "Mark the first message of a connection": the server marks it (`full: true`), rather than the page guessing from
  `onopen`, because EventSource reconnects by itself without calling `connect()`.

## Decisions taken

- **The Working chip** also counts a session that is idle while its subagents run ("Agents working", D6), as §7 says;
  before, the server counted busy and needs-you only. Codex roots count through their `agentsRunning`.
- **A `plans` event re-renders** the last state with the new plans at once (so a phase change is drawn and announced
  even when no `state` follows). That render moves the last state's `now` and `uptime` on by the time since it
  arrived, so the clock's server offset doesn't jump.
- **A client that connects while the boards changed** since the last push: `openStream` first sends `plans` to the
  clients already connected, so the next push compares against what every client has and the new client gets no
  repeat.
- **The kept feed is not replayed.** The page renders later states with the kept feed for anything that reads
  `st.feed`, but the ticker syncs once per array. Re-syncing an old feed would re-insert old lines once the ticker's
  `seen` set clears at 2000 entries.
- **stream-size.mjs** only reads a stream; with no URL it starts its own demo HUD on a free port, so running it
  can't touch the owner's HUD by accident.

## Known issues

- The demo's 3 boards give 6 `.plans .plan` elements in the DOM. It was the same before P3 and is unrelated to the
  stream. Not looked into.
- The dense demo's first `state` (28.8 KB) is bigger than a later one (24.2 KB) because it carries the plans and feed.
  That's expected: it is sent once per connection.

## Out-of-scope findings

- `tests/browser-smoke.mjs`: add the 10-second plans-and-feed check (and the board-change and reconnect checks) from
  `.hud-tmp/p3-stream-check.mjs`. P5, P6 or P7 have that file in scope. The scratch script is in the ignored
  `.hud-tmp/`, so copy the idea, not the file.
- `docs/DESIGN.md` §8 has no paragraph on the plan card's chips (Working, Needs you, state). P5 has DESIGN.md in
  scope and changes the plan card, so it could add one.

## Changes to earlier items

None.

## Lasting knowledge

- The stream has two kinds of `state`: the full one at connect (`full: true`) and the light one after. Anything new
  that must reach a page only once a connection (or rarely) goes in its own event, like `plans`, not in the light
  `state`. Written in the comment above `clients` in `hud.mjs`.
- Page code that re-renders without a new `state` must not pass an old `now` to `render`: `syncClock` would shift
  the clock. Written in `pageMain`'s `plans` handler.
- `node tests/tools/stream-size.mjs --demo=dense` is the quick measure of the push size; the plan's Verification
  (§16) runs it against a HUD on port 7790 with a URL.

## Next agent: start here

- Read the comment above `clients` in `hud.mjs`, then `pageMain`, then `tests/stream.test.mjs`.
- P4 adds `state.board`: it is part of the light `state`, so keep it small (only items with an agent or a mark,
  §4.3). Swap the page's `working(p)` in `renderPlans` for `board.plans[planKey].active`.
- `node hud.mjs selftest`, `node --test tests/` (about 45 s), `node tests/browser-smoke.mjs`,
  `node tests/tools/stream-size.mjs --demo=dense --seconds=30`.

## Owner checks

- After restarting the live HUD, open it on the phone or TV over the network: plans and the feed stay on screen, and
  a board change (an agent setting its row) shows within a second or two.
- Run `node tests/tools/stream-size.mjs http://127.0.0.1:7777 --seconds=60` against the live HUD (it only reads) and
  see the later `state` average well under the 175 KB measured on 2026-11-25. P3 did not run it against port 7777.
- With several boards open, the plan cards no longer flicker their question rows and run chips on every update.

## Review

- 2026-11-25 · coordinator · **accepted**. Checked: `node hud.mjs selftest` all checks passed; `node --test tests/` 25 pass / 0 fail; `node tests/browser-smoke.mjs` 10 pass lines; `git status` shows only P3-scope files. Re-ran two gate boxes independently: (1) `stream-size.mjs --demo=dense --seconds=30`: later `state` 29 messages, avg 24.1 KB, max 24.2 KB (under 30 KB); (2) `.hud-tmp/p3-stream-check.mjs` exit 0: plans and feed on the page after 10 s, and a board change drawn from a `plans` event alone. The demo's plans payload is small (1.4 KB), so the figure with the owner's 14 boards stays an owner check. Port 7777 /api/health 200 after.
