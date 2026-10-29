# Claude HUD design system

The permanent design reference for the page at `/` and the component gallery at `/design`. Both are built from the
same CSS and components inside `hud.mjs` (`HUD_CSS`, `hudClient()`), so `/design` is the source of truth for how
each component looks in each state. If this file and `/design` disagree, `/design` shows what was built: fix this
file.

## 1. Direction

A **holographic tactical display**: translucent glass panels over deep space navy, lit by arc-reactor cyan. It is
cinematic in the spirit of film UI, with the discipline of a premium product dashboard.

The page must answer three questions within two seconds, in this order:
1. **Does anything need me?** Red is used for this and nothing else, and it is the only fast, bright motion.
2. **What is running?** Amber (sessions working), violet (subagents), and the live number in the reactor.
3. **What just finished?** Green, briefly: a check that glows for 1.5 s, a pulse travelling back to the parent,
   a `DONE` line in the ticker.

It is meant to look **alive** at rest (decision D14). Motion comes in three layers:

| Layer | What it is | Examples | Off when |
|---|---|---|---|
| 1. Ambient | Not driven by data. Slow (4–12 s cycles), dim, never red. | Reactor rotation and heartbeat, radar sweep, floating nodes, grid shimmer, parallax, drifting particles, panel-edge flicker, glitch on entry, the boot sequence | **EFFECTS** toggle off, or `prefers-reduced-motion` |
| 2. Data | Moves because something happened or is happening. | Sparks for tool calls, flowing dashes to running children, the return pulse, rolling counters, filling rings, the busy scan line, spinners, ticker lines | Never (reduced motion turns it into plain fades) |
| 3. Alert | Needs you, blocked, bounced. | Red breathing (1.6 s), the banner sliding down, the reactor turning red | Never (reduced motion keeps the colour, stops the breathing) |

Layer 2 follows the calm rule: at most three kinds of continuously moving things besides the reactor (flowing
edges or scan lines, spinners, the plan pulse), and at most three flowing edges at once.

## 2. Colour

Each colour has one job. Status is never shown by colour alone: there is always a word and a shape too.

| Token | Value | Job |
|---|---|---|
| `--void` | `#04070d` | Page background |
| `--deep` | `#08111c` | Panel base, tooltip base |
| `--glass` | `rgba(16, 34, 52, .55)` | Panel fill, with `backdrop-filter: blur(14px)` |
| `--arc` | `#29e6ff` | Live, primary, focus |
| `--arc-35` / `--arc-15` / `--arc-06` | `--arc` at 35 / 15 / 6% | Borders and glows / fills / faint washes |
| `--line` | `--arc` at 22% | Hairline borders (1 px) |
| `--amber` | `#ffb547` | Working (busy), waiting |
| `--alert` | `#ff4d5e` | Needs you, blocked, bounced |
| `--ok` | `#4dffa6` | Done, handed off, accepted |
| `--agent` | `#b28cff` | Subagents |
| `--ink` | `#d6f3ff` | Text |
| `--ink-2` | `--ink` at 68% | Secondary text |
| `--ink-3` | `--ink` at 42% | Labels only, never body text |

Contrast is measured, not guessed. The measured ratios are in §9.

## 3. Type

| Role | Family | Weights | Sizes |
|---|---|---|---|
| Display: wordmark, the reactor number, panel titles | Orbitron | 500, 700 | 13 (panel titles, +0.2em), 18, 24, 34, 56 |
| Labels: uppercase, letter-spacing +0.14em | Rajdhani | 600, 700 | 11, 13 |
| Body | Inter | 400, 600 | 11 (network node titles only), 13, 15 |
| Numbers, tool summaries, the ticker: tabular figures | JetBrains Mono | 400, 600 | 11, 13, 15, 18, 24 |

- The scale is 11 / 13 / 15 / 18 / 24 / 34 / 56 px, nothing else.
- Fonts load from Google Fonts with `display=swap`. Offline fallbacks: `system-ui` for Orbitron, Rajdhani and Inter;
  `Consolas` for JetBrains Mono.
- Numbers use `font-variant-numeric: tabular-nums` and reserve their width (`min-width` in `ch`), so they never
  jump while they change.

## 4. Space, shape, depth

- **Space:** a 4 px grid. Panel padding 20 px. Gaps 16 px inside a column, 24 px between page regions on wide
  screens. An icon or glyph sits 8 px from its word (4 px inside a chip).
  - **Allowed off the grid:** centring (auto margins, an absolutely centred icon), the wordmark's letter-spacing
    compensation, and 2 px optical nudges: an icon aligned to a 20 px line, the 4 px flow strip centred on its edge,
    the segmented control's inset, the token split line under its bar. A computed-style audit of the page finds
    nothing else.
- **Shape:** panels have 12 px cut corners (top left and bottom right) drawn with `clip-path`, a 1 px hairline that
  follows the cut, and 2 px corner brackets in `--arc` at 60%. Chips and toggles are pills. One component never
  mixes rounded and cut corners.
- **Depth:** three layers only.
  1. **Background:** a hex grid at 4%, a radial vignette, scanlines at 3%; with effects on, also the shimmer band,
     the particles and parallax.
  2. **Panels:** glass, an inner glow, `0 0 40px` of `--arc` at 6%.
  3. **Floating:** tooltips, the node card and the pinned card: `--deep` at 97% (at 94% the text behind showed
     through), a stronger glow, a 1 px `--arc-35` border. The needs-you banner sits in the page flow, not over the
     panels.

## 5. Icons

Inline SVG drawn for this project, on a 24-unit grid with a **1.5 px stroke** (`vector-effect:
non-scaling-stroke`), round caps and joins, no fills. No icon fonts, no emoji. The set: terminal, file, edit,
search, web, agent, plan, bell, voice, sound, effects, tool, network, cards, branch, check, alert, close, pin,
chevron, clock.

Tool names map to icons: `Bash` / `PowerShell` → terminal; `Read` → file; `Edit` / `Write` / `NotebookEdit` →
edit; `Grep` / `Glob` → search; `WebFetch` / `WebSearch` → web; `Agent` / `Task` → agent; `TodoWrite` /
`ExitPlanMode` → plan; anything else → tool.

## 6. Motion

- Durations 150–400 ms for state changes; easing `cubic-bezier(.2, .8, .2, 1)`.
- Only `transform`, `opacity`, `stroke-dashoffset` and `filter` animate. Never layout.
- A card enters by scaling from 0.98 with a fade (220 ms). A status colour cross-fades (300 ms). A card leaving
  collapses (200 ms).
- **Boot**, once per page load, at most 1.6 s, skipped by any click or key, skipped entirely with effects off or
  reduced motion: the grid fades in, the reactor rings draw on, the panels unfold from their corner brackets 60 ms
  apart, the numbers count up from 0, and "SYSTEMS ONLINE" types into the ticker.
- **Reduced motion:** rotation, scanning, dashes, the ambient layer and the boot are off; state changes are plain
  fades; alerts keep their colour without breathing.

## 7. Sound and voice

Both off by default, toggled in the top bar, remembered in the browser.
- **Sound:** synthesized with Web Audio, each under 120 ms, a different pitch per event type, at most one every
  300 ms.
- **Voice:** browser speech synthesis, short and butler-like ("FidiaCRM needs your approval", "Phase P3 handed
  off", "All agents idle"), queued so announcements never overlap, at most one every 4 s.
- **Notifications:** asked for on the first click of the bell. Sent only while the tab is hidden: a session needs
  you; a plan phase is blocked, bounced or handed off.

## 8. Components

As built. Each entry says what the component shows, its states, and which motion layer moves it: 1 ambient, 2 data,
3 alert (§1). `/design` shows each one in each state.

### Page

- **Layout:**
  - **≥ 1440 px:** three columns (3 / 6 / 3 of 12) over a full-width feed. The page fits one screen, and each panel
    scrolls on its own.
  - **1024–1439 px:** the left column (reactor, vitals, externals) stays in view (sticky, with its own scroll) while
    the sessions and plans stack on the right.
  - **< 900 px:** one column, and a mini reactor with the running count moves into the top bar.
  - **< 600 px:** the top bar wraps onto two rows.
- **Boot** (layer 1, at most 1.6 s, once per load): as §6.
- **States:**
  - **Live.**
  - **Empty:** "No active sessions · systems nominal" and an idle reactor.
  - **Reconnecting:** an amber blinking light, and a thin bar under the top bar with "last update 12s ago" and
    "Retry now". The last state stays, dimmed to 50% and desaturated.
  - **Down:** 10 s after the stream was lost. The light turns red and the bar says "HUD server not answering".
  - **An error in one panel:** shown in that panel only, with its message and Retry.

### Top bar

- **Left:** the wordmark with a small reactor glyph that turns (layer 1), then "Claude · *host*".
- **Centre:** the clock (tabular), the date, the uptime.
- **Chips:** DEMO, and HOOKS OFF when the hooks are not installed.
- **Stream light:** Live (cyan, steady), Reconnecting (amber, blinking 1 s), Down (red), Connecting.
- **Toggles:** EFFECTS, voice, sound and notifications. Each is a 32 px round icon button with a label and a
  tooltip; pressed shows a filled cyan ring.

### Needs-you banner

- Sits in the page flow under the top bar, never over the panels.
- **One row:** the NEEDS YOU glyph and word, project, title, reason, time waiting, and a dismiss control (until that
  session asks again). A click goes to the session.
- **Several waiting:** the oldest shows, and a "+n more" pill expands the list.
- **Motion:** it slides down in 320 ms on arrival, and the red left edge breathes on a 1.6 s cycle (layer 3).
- **Narrow:** under 900 px the title is dropped. Under 600 px the reason is shortened ("Allow Bash", "Question").

### Arc reactor and vitals

- **Reactor** (232 px; 200 px on screens under 960 px tall):
  - the outer ring has one segment per open session, coloured by state, needs-you first;
  - the inner ring has 12 slots that fill with running subagents;
  - the centre number is the agents working (busy and needs-you sessions plus running subagents), rolling.
  - **Modes:** idle (no sessions, 50%), calm (sessions open, none working), live, alert (red, breathing 1.6 s).
  - **Layer 1:** the three rings turn at different speeds and directions. A heartbeat every 4–8 s, faster with more
    running, and none during an alert.
- **Vitals:** a label over a number, with a line under it.
  - Need you: red above 0, and "+ 2 plans" when plan boards wait too.
  - Sessions: busy · idle.
  - Subagents: running · finished. Finished counts the sessions the network draws (open ones, plus ended ones for
    15 minutes).
  - Plans: in progress, of the total.
  - Tokens today: in · out · write, and cache read counted apart.
  - Account limits: the 5-hour and weekly bars with their percent and reset time, hidden when Claude Code has cached
    none.
- **Odometers:** the digits roll (300 ms, at most every 1.5 s) in fixed-width slots, so numbers never jump.

### Externals (D12)

Shown only when there are rows. Each row: the provider badge, the app or model, the tokens, the time window ("INGEST
… to 23:25"), and a DELAYED tag on CloudWatch rows. A failing source shows one error line.

### Session card (up to 8 open sessions)

- **Header:** project, branch, age, tool count, status tag.
- **Title:** Inter 15/600, truncating with a tooltip. Next to it, the chips: model · effort, the provider badge
  (ANTHROPIC solid, BEDROCK dashed) and "Started by …" (click goes to that session).
- **Now line:** one of:
  - the current tool's icon, name, summary and timer;
  - the needs-you reason in red with its timer;
  - "Working between tools";
  - "Idle for 17m";
  - "Just finished", in green for 90 s.
- **Meters:**
  - tokens: output, cache write and input segments, the number, and "incl. subagents";
  - cache read, kept apart;
  - context: amber from 70%, red from 90%, "—" when the window is unknown, "used of window".
- **Subagent rows:** below.
- **States:**
  - busy: an amber scan line runs along the top edge (layer 2);
  - needs you: a red frame and a breathing inner glow (layer 3);
  - idle;
  - ended: collapsed to its header, title and a one-line summary, and sorted last.
- **Motion:**
  - enter: scale from 0.98 with a 220 ms fade, plus a short glitch (layer 1);
  - state change: a 300 ms cross-fade;
  - reorder: slides into place (FLIP, 300 ms).
- **Narrow:** under 560 px the model column and the age drop. Under 380 px the subagent tokens drop.

### Subagent rows

- **One row:** a glyph (a spinning ring while running, a check when done), the type in violet and the
  description, model, tokens, context %, and "Running 2:14" or "Done".
- **Indenting:** by depth, 20 px per level with an elbow line, for 3 levels. Deeper ones fold into "+n more, deeper".
- **Folding:** finished ones beyond the newest 4 fold into "+n earlier finished".
- **Finish:** the ring closes into a check that glows green for 1.5 s.

### Compact rows (more than 8 open sessions)

- **One 32 px line:**
  - status tag;
  - project;
  - title (the widest column);
  - provider letter (A, B dashed, ?);
  - what it is doing: the tool and summary, the short needs-you reason, "for 17m" when idle, "5m ago" when ended;
  - tokens;
  - context %;
  - "+n" running subagents.
- **Needs you:** a red tint and a breathing left edge.
- **Narrow:** under 720 px the model column and the needs-you timer drop (the banner and the card keep it). Under
  480 px only status, title, tokens and context remain.

### More below

- **What it is:** a slim bar at the bottom of a panel that scrolls (sessions, plans, the left column). It says what
  is out of sight.
  - Sessions: "3 MORE BELOW · 1 busy · 1 idle · 1 ended", each state as a word in its colour.
  - Plans: how many need you, and the projects.
  - Left column: the panel names.
- **Out of sight:** a card counts once less than about 48 px of it shows.
- **Click:** scrolls the first hidden item up.
- **Behaviour:** it takes no space and hides at the end of the list. It has no motion, and repaints only on scroll,
  resize and render.

### Network: who started whom

- **Layout:** a radial tree.
  - The hub is in the centre, labelled with the machine name (and "· *project*" when there is only one).
  - Sessions sit on the inner ring, grouped by project, in start order, so a change of state never moves a node.
  - Each group has a faint arc with end ticks, and its project name along the arc where there is room.
  - Subagents go on outer rings, one per depth. They fan out only as far as they need, about 64 px of ring per leaf
    (a finished leaf counts half), so a tree stays next to its parent.
  - On a crowded ring every other session steps outwards.
  - The depth rings with tick marks are the radar scope.
- **Node face:** a hexagon.
  - The status glyph is in the centre, the same one as on the cards.
  - The context ring is drawn only together with its number.
  - The provider letter is a tag on the rim.
  - Size = tokens, on a square-root scale over a 3× range. A needs-you node is never in the bottom 60% of sizes.
- **Node states:**
  - busy: amber, with a spinner;
  - needs you: red, with a breathing glow (layer 3);
  - idle: cyan;
  - ended: dashed and dimmed, with the letter still readable;
  - running subagent: violet, with a spinner;
  - finished subagent: green, at 80%;
  - satellite: "+n" finished subagents, dashed; a click expands it.
- **Labels:** the title (or subagent type) and "model · context · tokens".
  - They sit on the side away from the hub.
  - They never cover another node, another label, the hub or the panel edge.
  - They keep last frame's place while it still fits.
  - **When crowded** (more than 12 nodes, or nodes under 70 px apart): a short title (18 characters) with "context ·
    tokens", or only the context number.
  - Project names are placed after the node labels. A project name that finds no free stretch of arc is left to the
    node cards.
- **Edges:**
  - spokes run from the hub to each session, tinted by state;
  - parent → child edges are thin violet lines;
  - "launched by" is a double line, with no flow.
- **Motion, layer 2:**
  - dots flow along the edges to running children (the 3 newest only);
  - on each tool call a packet runs down the edge and the node ripples;
  - when a subagent finishes, a bright pulse travels from the child to its parent and the check glows;
  - nodes slide to new places in 450 ms.
- **Motion, layer 1:** the radar sweeps every 8 s and each node pings as it passes; the nodes float.
- **Interaction:**
  - **Hover or focus:** lights the path to the hub. The node's card docks in a corner that covers neither the node
    nor anything that needs you.
  - **Click:** pins the node: a full session card with "Show in cards" and "Unpin", on the side away from needs-you
    nodes.
  - **Keys:** the arrow keys move between nodes, Enter pins, Escape unpins.
- **Density:** a parent keeps its 3 newest finished subagents in view, and older ones fold into a satellite. Above
  40 nodes every finished one folds.
- **Legend:** along the bottom, from 560 px wide.
- **Empty:** the hub and "No active sessions · systems nominal".
- **Default view:** the network when any open session has subagents, the cards otherwise. Windows under 600 px wide
  with more than 8 open sessions get the cards. The switch is remembered, and `?view=` overrides it.

### Plan graph

- **One card per board:**
  - **Header:** the project, a NEEDS YOU chip, the state the board itself declares, and "done / total".
  - **Then:** the title, the graph, the questions and decisions waiting (2 lines each), the runs as chips, and the
    last log line.
- **Graph:**
  - laid out from "waits for", left to right when it fits, top to bottom when not, with circuit-style elbow edges;
  - a hexagon per phase (a diamond for an owner input), with the id inside (a bigger shape for ids over 4
    characters) and the agent below.
- **Badges:** a check for accepted or done, an arrow for handed off, "!" for blocked, a return arrow for bounced, and
  pause bars for partial.
- **States:** todo is dashed. In progress is cyan, with a pulse and flowing edges (layer 2).
- **Hover or focus a node:** a card with the state, agent, model, since, waits for and notes.
- **Order of boards:** those needing you first, then those in progress, then by project.

### Feed

- **Three lines** in mono: the time, a tag, the project and the text.
  - Tags: TOOL (cyan), AGENT (violet), NEEDS YOU (red), DONE (green), PLAN (ink), SESSION (ink-2).
- **Motion:** the newest line slides in at the top (300 ms).
- **Updates:** the same session's next tool call updates its line (×n).
- **Hover:** pauses the feed ("Paused · n new").
- **Header:**
  - LAST DONE: the newest finish, from the feed or from the state, or "Nothing has finished yet";
  - the collapse chevron, always at the right.
- **Collapsed:** one line with the newest event.
- **Accessibility:** `aria-live="polite"`.

### Floating layer

- **What:** tooltips (from `data-tip`; with `data-tip-if="trunc"` only when the text is truncated), the network
  node card, and the pinned card.
- **Look:** `--deep` at 97%, a 1 px `--arc-35` border, a stronger glow, and cut corners.

## 9. Measurements

Measured on the final P2 build (round 3) with Playwright driving headless Edge 156 on the hardware GPU (RTX 3080 Ti,
120 Hz).

- **Overflow:** no page-level horizontal overflow on any page (demo, 24-session demo, `/design`, live) at 1440×900,
  1024×768 or 390×844. Every truncation has a tooltip, or (network node labels) a hover card.
- **Contrast**, against the real pixels behind each text style: every body and secondary text style is at least
  4.5:1. The only style below is the `--ink-3` label, at 3.69:1 (worst pixel 3.65), which §2 allows for labels only.
  Interactive text and controls use `--ink-2` (about 7.4–7.7:1). Dimming a whole element with `opacity` takes its text
  down with it: an ended node dims its shape, not its provider letter.
- **Idle CPU**, live page at 1440×900, 30 s with no input:

  | Effects | Renderer main thread | Whole browser (one core) | Whole machine (32 threads) |
  |---|---|---|---|
  | Off | 0.3% | 21% | 0.67% |
  | On | 0.3% | 23% | 0.73% |

  Almost all of it is GPU compositing at 120 Hz; a 60 Hz screen does roughly half the frames. Under constant
  simulated activity (`--demo` pushes state about 4 times a second) the main thread is busier: 5.5% / 6.8% (effects
  off / on), 7.9% for the 24-session demo, 1.1–1.6% of the machine. The first P2 build measured 5.4–9.1% on the main
  thread *at rest*, with 120 layouts a second, caused by SVG `stroke-dashoffset` loops (flows and the plan pulse).
  Rule since then: **no infinite animation on SVG internals**; continuous motion is an HTML element animating
  `transform` or `opacity` (flows are strips of dots that slide, the plan pulse is an overlay).
- **Frames:** 119 fps, p99 8.5 ms, no long tasks, on the demo, the 24-session demo and the live page.
- **Motion inventory:** no animation touches anything but `transform`, `opacity`, `stroke-dashoffset` and
  `filter`. With reduced motion nothing runs an infinite animation. At rest nothing runs an animation-frame
  callback; the "more below" bar repaints in one frame after a render, and only then.
