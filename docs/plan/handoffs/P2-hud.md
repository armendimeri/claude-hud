# P2 `hud` handoff

**Date:** 2026-10-29 to 30 (two sessions) · **State:** handed-off · **Model / effort used:** Opus 5.5 / xhigh ·
**Next:** P3 `review`

## Summary

- The HUD page (`/`) and the component gallery (`/design`) are built inside `hud.mjs`, from one stylesheet
  (`HUD_CSS`) and one client library (`hudClient()`).
  - On the page:
    - the top bar and the needs-you banner;
    - the arc reactor and vitals;
    - sessions as cards, compact rows or a live network;
    - plan graphs, the feed, and the reconnecting and down states.
  - The network shows who started whom:
    - nodes sized by tokens, context rings with their numbers;
    - flowing edges, return pulses, packets for tool calls;
    - a radar.
  - Sound, voice and notifications work. The boot sequence works. An EFFECTS toggle switches the ambient motion off.
- `docs/DESIGN.md` is complete: direction, tokens, type, space, motion layers, sound and voice, the components as
  built (§8) and the measurements of the final build (§9).
- Three critique rounds are done and their findings fixed. Rounds 2 and 3 used a measurement harness and an
  independent critic agent.
- The README has the hero image and a usage section. The final screenshots are in `docs/screenshots/`.
- **The user added two design decisions during the phase:**
  - **D14:** full cinematic motion, with an EFFECTS toggle that turns off everything not driven by data (PLAN §6.8).
  - **A refinement of D14:** the background must stay quiet ("too much going on, can't see clearly anything"). The
    life goes into the network, the reactor and the alerts.
- **Exit gate:** all six items are met (table below).

## Exit gate

| # | Gate item | Result | Evidence |
|---|---|---|---|
| 1 | §6.7: three critique rounds written up, round 1 and the final screenshots kept, every checklist item true | ✅ | Round 1: 9 images in [P2-round1/](P2-round1/). Round 2: [P2-round2/](P2-round2/). Round 3: below, with evidence in [P2-round3/](P2-round3/) ([measurements.txt](P2-round3/measurements.txt), before images, hover and pin after). Final screenshots: 12 images in [`docs/screenshots/`](../../screenshots/) (demo, 24-session demo and `/design` at 1440×900, 1024×768 and 390×844; the cards and rows views at 1440; the hero). The checklist is re-checked item by item below. |
| 2 | `/design` shows every component in every state, incl. network, context meter, externals | ✅ | 11 sections. Round 3 added: a card launched from another session's shell ("Started by …" chip), all six feed tags, and the "more below" bar in a scrolling panel. No page errors; the only console error is the deliberate broken-panel specimen. No page overflow at any of the 3 sizes (before round 3 it overflowed at 1024 and 390). |
| 3 | Network seen live with a real session that starts a subagent: appears, dashes flow, return pulse, size grows | ✅ real | Round 2, unchanged ([log](P2-round2/live-subagent-log.txt), 5 screenshots `live-subagent-*`). A Haiku subagent started by the previous P2 session: it appeared at 2.9 s, its flow ran, it grew 64 → 68 px, and the return pulse played when it finished. |
| 4 | Live update without reload with real sessions; stopping and starting the server shows reconnecting, then recovers | ✅ real | `reconnect2.mjs` started its own live HUD on 7786 and watched the real sessions of this PC ([log](P2-round3/reconnect/log.txt), 5 screenshots `P2-round3/reconnect/*`). On the final build: a new feed line (this session's own Bash call) arrived without a reload 5 s after load. The server was then killed: `reconnecting` (amber, last state dimmed) for 9 s, then `down` (red, "HUD server not answering") held steadily. After the restart: `live` in 2.1 s, with the state rebuilt. **Bug found and fixed:** `down` used to flicker back to `reconnecting` on every failed retry, and timed from the last state received, which can be minutes old on a healthy stream. |
| 5 | Needs-you banner, reactor alert, a notification when the tab is hidden, voice and sound | ✅ headless | Round 2, unchanged ([alerts.json](P2-round2/alerts.json), [screenshot](P2-round2/alerts-needs-you.png)): 4 notifications shown by Edge, 5 utterances, 26 Web Audio tones, the reactor in alert, the banner shown. Audio was muted for the test, so no person has heard it. |
| 6 | `docs/DESIGN.md` documents tokens, type, motion rules and components as built | ✅ | §1–7 as before. §8 now lists the components as built (what each shows, its states, its motion layer). §9 has the round 3 numbers. §4 records the grid exceptions found by the audit. |

### §6.7 checklist, re-checked on the final build

| Item | Status | Evidence |
|---|---|---|
| Three questions answered within 2 s, for 1 session and for 24 | ✅ | **Q1:** the banner (with "+n more"), a red reactor, red nodes and rows, the Need you vital, at 1, 5 and 24 sessions. **Q2:** the reactor number; amber and violet nodes with spinners. At 24 sessions, crowded nodes now carry a short title ([dense-network-1440x900](../../screenshots/dense-network-1440x900.png); before: one title among 24). Cards and rows say what is out of sight ("4 more below · 2 busy · 1 idle · 1 ended"); before, a busy session was hidden without a word. **Q3:** LAST DONE is always in the feed header and is filled from the state at load (live: the critic subagent, "23m ago"); the finished count matches the green nodes. |
| Nothing decorative without information; glow only on live things | replaced by D14 | Ambient layer allowed (§6.8); glow stays on live and alert things. The critic: pass. Background unchanged (quiet, as the user asked). |
| 4 px grid; consistent spacing | ✅ | Computed-style audit (`grid.mjs`) of every element on the demo, cards and network: every padding, margin and gap is a multiple of 4, except centring (auto margins, a centred icon), the wordmark's letter-spacing compensation, and 2 px optical nudges. All recorded in DESIGN.md §4. The 6 px icon gaps and 10 px pill padding it found were moved to 8 and 12. Panel bottoms now line up at 1440 (the left panel stretches). |
| Type scale and families only; tabular numbers | ✅ | Same audit: the font sizes used are 11, 13, 15, 18, 24 and 56 only; the families are Orbitron, Rajdhani, Inter and JetBrains Mono only. Odometer digits have fixed-width slots. |
| No text overflows at 3 sizes; truncation has a tooltip | ✅ | 18 viewport and 10 full-page captures: no page-level overflow anywhere, `/design` included. **Truncations fixed:** the "Started by" chip pushed its card wider with a long launcher title; tooltips were added to the feed project, the card project label, the banner project, the "more below" summary, the LAST DONE placeholder and the panel error. **Left untipped:** network node labels (the node's hover card has the full text) and the gallery's own type samples. |
| Status never by colour alone | ✅ | A glyph, a word and a colour on cards, rows, tags and banners. Network: the glyph in the node centre. Plan graph: `partial` now has a badge mark (pause bars), so it is no longer colour only. |
| Smooth motion; idle CPU < 5% | ✅ | **Live page, 30 s with no input:** main thread 0.3% with effects on and with effects off; whole machine 0.73% / 0.67%. **Frames:** 119.4 fps, p99 8.5 ms on the demo; 118.8 on the 24-session demo; 119.5 on live. No long tasks. **Under constant simulated activity** (not idle): demo 6.8% / 5.5% of the main thread and 1.3% / 1.1% of the machine; 24-session demo 7.9% / 1.6%. Details in [measurements.txt](P2-round3/measurements.txt). |
| Reduced motion checked (emulated) | ✅ | `motion.mjs --rm` on the demo and live: `html.rm`, effects off, 0 infinite animations. Animation-frame callbacks: 0/s at rest; the demo's renders cost 2/s. |
| Contrast of body and secondary text ≥ 4.5:1 | ✅ | `contrast.mjs` on 6 pages: all pass. Only the label-only `--ink-3` measures 3.69:1, which §2 allows. **Fixed:** the provider letter on ended network nodes was 4.43:1, with a worst pixel of 2.64. |
| Network: who started whom at a glance for 3 levels; the busiest agent is the biggest | ✅ | Subagents now stay next to their parent. Before, a 3-level tree fanned out over 140° and its running chain landed under another project's session. Sessions keep their place when they change state. Size is a square-root scale over a 3× range: two agents with near-equal tokens look near-equal, and the biggest token count is the biggest node ([hero](../../screenshots/hero-network.png)). |
| Numbers next to every bar and ring; provider never by colour alone | ✅ | A ring is drawn only together with its number. Provider: a lettered tag (A / B), a worded badge, and a dashed outline for Bedrock. The critic: pass. |
| Hero screenshot for the README, network with a subagent tree | ✅ | [`docs/screenshots/hero-network.png`](../../screenshots/hero-network.png), at the top of the README. It shows the demo network: Coordinator → Explore → general-purpose with 3 finished subagents, two sessions needing you, plans, and LAST DONE filled. Taken by `hero.mjs` once a subagent had finished, with nothing hovered and no counter mid-roll. |

## Critique rounds

### Round 1 (first build; images in [P2-round1/](P2-round1/))

1. **Q1 undermined by its own banner.** It floated over the Sessions and Plans headers, hiding the view switch.
   With three waiting it covered half the screen, and each row wrapped onto two lines (a grid-column mismatch).
2. **Network clutter.**
   - Floating "A" badge squares.
   - Heavy doughnut bands for project groups.
   - A radar wedge that reads as a glitch in a still.
   - Node labels colliding with project labels.
3. **Overflow.**
   - 1440: the vitals were cut under the externals panel.
   - 1024: a sticky feed covered the bottom of every panel.
   - 390: the top bar ran off-screen and the Sessions header clipped.
4. **Detail.**
   - In subagent rows, the context % overlapped "RUNNING 0:51".
   - The card chip row clipped its last chip.
   - The feed header repeated the newest line.
   - There was a favicon 404.

All fixed in round 1 (in-flow one-line banners, thin project arcs, labels outward, a two-row top bar at < 600 px,
phone order, compact vitals, and so on).

### Round 2 (harness numbers, my review, an independent critic agent)

Measured:
- **No page overflow at any size.** The missing truncation tooltips were added.
- **Idle CPU was too high at first.** The first build cost 9.1% (effects on) / 5.4% (off) of the renderer main
  thread, with 120 layouts a second. Switching techniques off one at a time showed the cause: SVG
  `stroke-dashoffset` loops (flows and the plan pulse) run on the main thread every frame. These are now HTML strips
  and overlays animating `transform`, which brought the main thread to 0.2–0.3%.
- **Contrast.** 8 styles were under 4.5:1. Informative text moved to `--ink-2`. Ended cards no longer fade the whole
  card to 45%, which had put their text at 2.5–3.8:1.
- **Boot bug.** The hex grid flashed at full brightness during the boot. That is the frame the user saw; it is fixed.

The critique, most severe first. All of it is fixed unless marked:
1. **Network node faces.**
   - The provider letter dominated while the status was a tiny badge.
   - The size range was squeezed.
   - A needs-you node could be the smallest.
   - Rings had no numbers.
   - A live subagent stayed at the minimum size.
2. **1440×900 didn't fit.**
   - The left column scrolled.
   - Each banner pushed the page down 48 px.
   - The feed took 184 px.
   - Cards showed 2 of 5 sessions (round 3 answered this with the "more below" bar).
3. **Compact rows** had their provider and "current tool" columns swapped below a 720 px panel width.
4. **Network labels.**
   - Titles appeared and vanished between frames.
   - Project labels ran through nodes.
   - The hub label collided with node labels.
   - The tooltip covered the path it highlighted.
5. **The 2-second test at 24 sessions.** "What just finished" drowned in TOOL lines, and "live" meant two different
   counts.
6. **Rolling numbers** looked broken in stills; they now roll at most every 1.5 s.
7. **The radar** was cut by the panel's rectangle.
8. **Type:** sizes used but not documented; line boxes off the grid.
9. **Ambient timing.** The heartbeat reached a 1.2 s cycle, and it beat against the alert.
10. **Phone:** banners lost the project and the reason; the vitals filled the first screen.
11. **Cinematic quality** read as "a polished dark dashboard". **Not taken:** the critic's advice to make the
    background more visible, because the user asked for a quieter one. Added instead in the network: depth rings with
    ticks, a circular radar, packets along edges for tool calls, and glow on live nodes.
12. **Gallery gaps:** boot replay, a dimmed reconnecting state, pinned, path highlight, satellite, launched-by,
    focus ring, truncation tooltip; the empty vitals showed impossible numbers. All added, except an EFFECTS on/off
    pair: the header toggle flips the whole gallery.

### Round 3 (the final build; gate 4, the harness, an independent critic agent)

**How:** 18 viewport captures (6 targets × 3 sizes), 10 full-page captures, the gallery in 7 slices, and hover, pin
and keyboard captures. The critic agent got only the images and PLAN §6, plus the user's quiet-background decision.
Then contrast, motion (`--rm` too), CPU and frames. Before images: [P2-round3/before/](P2-round3/before/).

**Found by measuring:**
- The reconnect `down` bug (gate 4 above).
- The ended-node provider letter at 4.43:1.
- `/design` overflowing at 1024 and 390.
- The "Started by" chip overflowing its card.
- Untipped truncations, and 6 px spacing off the grid.

**The critique, most severe first.** Each finding is followed by what was done. All are fixed unless marked.

1. **Cards at 1440 hid running work.** 2 of 5 cards showed, and a busy session was out of sight without a word.
   Rows showed 16 of 24, the 17th cut in half. The externals panel and 2 of 3 plan boards were also out of sight.
   - **Done:** a "more below" bar for each scrolling panel (sessions, rows, plans, left column). It shows the count
     and the states or projects; a click scrolls there. A card counts as hidden once less than 48 px of it shows.
2. **The 3-level tree broke apart.** Within a minute the running chain sat under another project's session, about
   200 px from its parent, and sessions moved between frames.
   - **Done:** children fan out only as far as they need (about 64 px of ring per leaf, a finished leaf counting
     half), and session order no longer depends on state.
   - **Done:** a parent keeps its 3 newest finished subagents; older ones fold into a numbered satellite. Before,
     this happened only above 40 nodes.
3. **The 24-session network couldn't say what was running.** One title showed; the rest were bare percentages or
   "model · ctx · tokens" lines with no owner.
   - **Done:** crowded nodes get a short title (18 characters) with context and tokens. The ownerless model line is
     gone in crowded mode.
   - **Done:** windows under 600 px with more than 8 open sessions default to rows (only when the user hasn't picked
     a view).
4. **"What just finished" had no stable place.** LAST DONE appeared only after a finish arrived while the page was
   open, and the collapse chevron jumped when it did.
   - **Done:** LAST DONE is always there, filled from the state at load, with "Nothing has finished yet" otherwise.
     The chevron is fixed at the right.
   - **Done:** the finished count uses the same sessions as the network.
5. **Rows couldn't be told apart.** Titles were cut at about 16 characters, the reason read "Permis…", and ended
   rows read "× en…".
   - **Done:** the title column is wider. The reason has a short form ("Allow Bash", "Question"). Idle and ended
     rows say "for 17m" and "5m ago" instead of repeating the status. Under 720 px the needs-you timer drops (the
     banner and card keep it).
6. **The externals panel was missing at 1440.** It was below the reactor in a scrolling column.
   - **Done:** the left column's "more below" bar names it. Not done: moving the panel itself, because there is no
     room at 900 px tall, and D12 is off by default.
7. **The plans panel showed 1 of 3 boards with no count.**
   - **Done:** the bar says "2 more below · 1 needs you · TourCMS, WasteManagement2".
8. **Network labels collided.** The project arc label ran through the Coordinator's label; at 1024 and 390 it hit
   the hub label and the provider tags.
   - **Done:** node labels are placed first, and project names go on a stretch of arc clear of nodes (plus their
     glyphs) and labels. Otherwise the name is left out and is in the node's card. The cost: the busiest project's
     name sometimes doesn't show.
9. **Hover and pin covered the alert.** The docked card hid the red node, the pinned card let text behind it show
   through, and subagent titles were cut to "Explore Ma…".
   - **Done:** both dock in a corner or side that covers no needs-you node.
   - **Done:** floating panels are at 97%, up from 94%.
   - **Done:** the pinned card uses the narrow card layout (model column dropped), so titles get the room.
10. **Gallery text overflowed.** The truncation sample didn't truncate, and the gallery top bar clipped at 390.
    - **Done:** both fixed.
11. **390 wrapping.** LAST DONE wrapped onto two lines, and the banner cut the project before the reason.
    - **Done:** the tags and times don't wrap, and the banner uses the short reason.
12. **Plan graph polish.**
    - Ids over 4 characters touched the hex. **Done:** a bigger shape for them.
    - `partial` was colour only. **Done:** a badge mark (pause bars).
    - Ids looked under 11 px. **No change:** they are 11 px (Rajdhani, a small x-height).
    - "Q-9" read as "0-9". **No change:** it is the letter O (owner input `O-9`).
    - The HISTORY-UI label sat between connectors. **Not taken:** low impact.
    - FIDIACRM chunks have no agent names. **No change:** the board has none.
13. **Vitals copy.**
    - "sessions · 2 plans too" truncated. **Done:** now "sessions + 2 plans".
    - "0 in progress" next to a BUILDING chip, and PLANNED with a phase in progress. **No change:** the chip shows
      the state the board itself declares, and the count comes from the phases. Both are true to their sources.
14. **Polish.**
    - "D2 D2 …": **done**, a question or decision text no longer repeats the id it starts with.
    - Uneven panel bottoms at 1440: **done**, the left panel stretches.
    - An empty left column at 1024: **done**, it is sticky, with its own scroll and "more below" bar.
    - A digit caught mid-roll: **not taken**. A roll is 300 ms at most every 1.5 s; a fade mask would add a
      compositing layer per digit.
    - The "HUD" ticker tag: **kept**. It marks the boot's SYSTEMS ONLINE line, which §6.5 asks for.
    - The idle reactor's 0: **not taken**. It is the Orbitron zero.

**Gallery gaps the critic found:**
- **Added:** a card with "Started by", the six feed tags, and the "more below" bar.
- **Not taken:**
  - a visual stack of banners: one row with "+n more" is a round 1 decision;
  - stills of the boot: there is a Replay button;
  - reconnecting together with the amber light: the light and the bar are both in the gallery, side by side.

**Also changed in round 3:** the demo labels its hub `STARK-01` instead of the real machine name, so screenshots in
this repo (it will be pushed) carry no machine name.

## Files changed

| File | What |
|---|---|
| `hud.mjs` | **The page section replaces the placeholder** (about 2,400 → 5,300 lines): `HUD_FONTS`, `HUD_CSS`, `hudClient()`, `pageMain()`, `designMain()`, `hudPage()`. The HTML is built lazily (`pageHtml()` / `designHtml()`), so `node hud.mjs hook` never pays for it. **Engine:** `host` (`os.hostname()`) is added to both snapshots for the network hub, `handle()` serves `pageHtml()` / `designHtml()`, and the demo's host is `STARK-01`. `selftest` passes. |
| `docs/DESIGN.md` | New: the full design reference, §1–9. |
| `README.md` | The hero image replaces the "still the engine's plain JSON view" note. New section "Using the page". The other session's Bedrock edits are kept. |
| `docs/screenshots/` | New: 12 final images (`hero-network.png`, `demo-network-*`, `dense-network-*`, `dense-rows-*`, `demo-cards-1440x900.png`, `design-*`). All from `--demo` and `/design`, with no real session titles and no machine name. |
| `docs/plan/PLAN.md` | §6.8 added (D14, alive). |
| `docs/plan/STATUS.md` | P1 `accepted`, D14 added, P2 claimed, `partial`, resumed, `handed-off`, log lines. |
| `docs/plan/handoffs/P2-round1/`, `P2-round2/`, `P2-round3/` | Evidence: images, the live-subagent log, `alerts.json`, the reconnect log and screenshots, `measurements.txt`. |

Outside the repository:
- the memory note `hud-background-must-stay-quiet` (user preference);
- harness and scripts in `%TEMP%\hud-p2\` (below).

`~/.claude/settings.json` is byte-identical to its state at the start of this phase (`41f8f984…`) and has no hooks.
No HUD server is running, and no node process of this phase is left. Hook forwarder on the final file: p95 82 ms
with the HUD stopped and 75 ms with it running, 50 of 50 calls exit 0, no output.

## Deviations and decisions taken

- **Client code** is plain functions inlined with `Function.prototype.toString`, not hand-escaped template strings.
  It is still one file with no build step, and Node checks its syntax.
- **`host` was added to the state** (PLAN §6.4 labels the hub with the machine name, but the state didn't carry it).
  The demo uses `STARK-01`.
- **Banners sit in the page flow**, one row with a "+n more" pill, instead of floating over the panels. A floating
  banner hid the panel headers.
- **ENDED is not the whole card at 45%** (§6.4), because that failed contrast. An ended card collapses to its
  header, title, when it ended and a one-line summary. Ended network nodes dim their shape, not the label or the
  provider letter.
- **Informative text and controls use `--ink-2`.** `--ink-3` stays for pure labels.
- **Floating panels are `--deep` at 97%**, not 94% (§6.2 says "a stronger glow"; at 94% the text behind showed
  through).
- **Network:**
  - the status glyph sits in the centre and the provider is a lettered tag on the rim;
  - labels avoid each other, the nodes and the hub, and keep last frame's placement while it fits;
  - a context ring is drawn only together with its number;
  - size is `rMin + (rMax − rMin) · √(tokens / max)` over a 3× range, and a needs-you node gets a size floor;
  - sessions are ordered by start time inside their project, never by state;
  - children fan out only as far as they need;
  - project names are placed after node labels, and only where they fit;
  - floating cards dock away from needs-you nodes;
  - **finished subagents fold beyond 3 per parent** (PLAN §6.4 folds them only above 40 nodes; this keeps a tree next
    to its parent, like the cards' "+n earlier finished");
  - **windows under 600 px with more than 8 open sessions default to rows** (§6.4 says network whenever a subagent
    exists; that is unreadable at that width). Only the default changes: the switch is remembered and `?view=`
    overrides it.
- **"More below" bar** in scrolling panels: not in PLAN §6.4. It answers "what is running" when a panel can't show
  everything (§6.3 asks for one composed screen at 1440).
- **No infinite animation on SVG internals** (performance; DESIGN.md §9).
- **Feed:**
  - 3 lines tall;
  - a session's next tool call updates its line (×n) instead of adding one;
  - LAST DONE is always in the header, from the feed or the state.
- **Reactor and header wording:** the reactor says "Agents working", the sessions header "N open". Heartbeat
  4–8 s; none during an alert.
- **Sound:** none for tool calls, which are too frequent. Tones for needs-you, subagent start and finish, session
  start and end, plan changes, and all idle.
- **Boot** belongs to the ambient layer: off with EFFECTS off or reduced motion.
- **`?view=cards|network`** in the URL picks the view until the switch is used.
- **Reconnect timing:** `reconnecting` for 10 s after the stream is lost, then `down`. The "last update" age is
  shown, but it doesn't decide the state.

## Known issues

- **Network:**
  - in the launched-by specimen, the double-line edge passes through the hub when the two sessions are opposite each
    other;
  - label widths are estimated from character counts;
  - at 390 px the 24-session network is still crowded when picked by hand (rows are the default there);
  - the busiest project's name is sometimes left out for lack of a free stretch of arc.
- **Plan graph:** an agent label can sit between two connectors (HISTORY-UI in the dense demo). Not tested with a
  real 30-node chunk board.
- **Busy simulations cost more** than the idle live page: 5.5–7.9% of the main thread (1.1–1.6% of the machine)
  under `--demo` / `--demo=dense`. Most of it is style recalculation from about 4 renders a second and a packet
  animation per tool call. Within the 5% idle budget at rest; not optimised further.
- **One frames run** on the demo showed 5 long animation frames (53–83 ms) with no script and 0 ms blocking. The
  frame start was delayed outside the page, and two re-runs were clean (119 fps, max 8.5 / 16.7 ms).
- **Not heard or seen by a person:** voice and sound are proven by calls and events only. Notifications ran under a
  simulated hidden tab (headless).
- **A rolling counter** can be caught mid-roll in a still.

## Tooling (outside the repo; not a dependency of `hud.mjs`)

- **Browser:** `playwright-core` 1.64 in `%TEMP%\hud-p2\pw\` (no browsers downloaded), driving the installed Edge 156
  headless on the hardware GPU (NVIDIA RTX 3080 Ti through ANGLE/D3D11). If `%TEMP%` was cleaned, run
  `npm install --ignore-scripts playwright-core@1` in a new empty folder and point `HUD_PW` at its `node_modules`.
- **Scripts** in `%TEMP%\hud-p2\scripts\`:
  - the harness: `shoot.mjs` (screenshots at 3 sizes and an overflow audit; `--full`, `--viewports`), `cpu.mjs`
    (`--css <file>` injects CSS for A/B tests), `frames.mjs`, `motion.mjs`, `contrast.mjs`;
  - round 3: `grid.mjs` (the spacing and type audit), `hero.mjs` (the README image), `reconnect2.mjs` (gate 4, a
    stream-state sample every second), `hookbench.mjs` (forwarder timing), `probe3.mjs` (text and errors on a page),
    `final.sh` (the whole round, captures then measurements in sequence);
  - earlier: `quick.mjs`, `slices.mjs`, `interact.mjs` (hover, pin, keyboard), `livesub2.mjs` (records a live
    subagent), `alerts.mjs`, `boot.mjs`, `reconnect.mjs`, `patch.mjs`;
  - `restart.sh` (servers: 7783 demo, 7784 dense, 7785 live).
- **Traps:**
  - floating network nodes never pass `element.hover()`'s stability check, so use `page.mouse.move` on the box
    centre;
  - `recordVideo` needs an ffmpeg download (not used);
  - `name=url` arguments must be split at the first `=`;
  - `hud.mjs` has mixed CRLF / LF line endings, so multi-line exact-string patches miss; patch one line at a time;
  - `.gal-sec .pc { overflow: visible }` also reaches panels nested in a gallery specimen, so a specimen that must
    scroll sets its own `overflow`.

## Lasting knowledge (where it goes)

- **In `docs/DESIGN.md` now:**
  - tokens, type and space, with the grid exceptions;
  - the motion layers and "no infinite SVG-internal animation";
  - the components as built (§8) and the measurements (§9);
  - the background stays a faint texture;
  - dimming a whole element takes its text contrast down with it.
- **In `README.md` now:** how to use the page (views, network reading, toggles, the gallery).
- **Still owed from P1, for P3 (README or DESIGN.md):**
  - transcript formats;
  - the `meta.json` fields;
  - background subagents close on `finished: true`;
  - `claude -p` registers a pid;
  - a brand-new subagent shows "model unknown, provider Unknown" until its first assistant line arrives.

## Next agent: start here

**P3 `review`** (Opus 5.5 / high):
1. **Read** PLAN §6–8, `docs/DESIGN.md`, this handoff, and the user's memory note on a quiet background (don't ask
   for a busier one).
2. **Check P2:**
   - `node hud.mjs selftest`;
   - `node hud.mjs --demo`, then look at `/` and `/design` at 1440, 1024 and 390;
   - the screenshots in `docs/screenshots/`.

   The harness above can re-measure anything. Then write the design review in the Review section below. Anything
   below the bar → bounce P2 with a specific list.
3. **Then your own scope:** PLAN §8 end to end (it needs `install`; uninstall at the end), `autostart` on and off,
   the final README (the hero and usage section are in; the P1 knowledge above is still owed), then delete
   `docs/plan/`. `docs/DESIGN.md` and `docs/screenshots/` stay.

## Review

Filled in by the checker.
