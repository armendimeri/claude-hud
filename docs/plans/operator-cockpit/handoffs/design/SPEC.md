# Cockpit screen layouts (P1-01 design study)

Consumers: P2 (scene), P3 (inspector), P7 (shell). Everything here is built from `docs/DESIGN.md` and `src/web/styles/foundation.css` tokens and drawn from the frozen P1 fixtures `snapshots.sparse` and `snapshots.dense` (`tests/fixtures/cockpit/public.mjs`, unchanged). Displayed timers ("0:42") and the long title are example strings; the fixture clock is fixed.

Regenerate with `node docs/plans/operator-cockpit/handoffs/design/build.mjs` then `node docs/plans/operator-cockpit/handoffs/design/render.mjs` (Edge, throwaway profile). The frames in `frames/` are real DOM, so P2/P3 can read exact box values from them. `layout.json` has every rectangle and node position. `audit.json` has the last audit run.

## Frames

Each frame has three images in `images/`: `<name>.png`, `<name>.annotated.png` (numbered callouts, keyed by the legend below) and `<name>.gray.png` (colour removed).

| Frame | Viewport | Shows |
|---|---|---|
| `sparse-1440` | 1440 x 900 | Two projects (Ledger: waiting parent, running child, completed session; Reports: one working session), counts, inspector closed. |
| `sparse-1440-inspector` | 1440 x 900 | Same scene, inspector open at 400 px. Scene rectangle shrinks to 976 px, nodes stay in their rectangle slots. |
| `dense-1440` | 1440 x 900 | 24 sessions, four projects, Ledger expanded, three others collapsed with "+4 idle". Selected long-titled session, 3 labels hidden, compact strip, expanded inspector (480 px, observed-only). |
| `sparse-1024` | 1024 x 768 | Map cannot fit scene plus 400 px inspector, so the inspector overlays the right of the scene. Attention row and exit stay. |
| `dense-1024` | 1024 x 768 | Dense overlay case, 440 px inspector. |
| `discreet-1440` | 1440 x 900 | Discreet display: aliases, counts and statuses only. |
| `fallback-1440` | 1440 x 900 | WebGL unavailable: project list in place of the canvas, reconnecting bar, history unavailable. |
| `narrow-1-waiting` | 390 x 844 | Waiting: collapsed project nodes, the waiting session kept individual, attention row with Inspect. |
| `narrow-2-inspect` | 390 x 844 | Inspection: full-width sheet with Back to map, selected node still visible above it. |
| `narrow-3-exit` | 390 x 844 | Exit while discreet: Return to dashboard and reveal details / Stay discreet. |

## Bands and dimensions (CSS px)

Read top down. Page padding is 24 at 1440, 16 at 1024, 12 at 390. Gaps between bands are 8. All heights are fixed so the scene rectangle is the only flexible band.

| Band | 1440 x 900 | 1024 x 768 | 390 x 844 |
|---|---|---|---|
| Top bar | y16 h56 | y16 h56 | y12 h56 |
| Counts summary | in top bar | in top bar | y76 h28 |
| Reconnect bar (optional) | h48 | h48 | h48 |
| Attention row | y80 h48 | y80 h48 | y112 h72 |
| Scene rectangle | y136 h696, w1392 (976 with inspector) | y136 h564, w992 | y192 h588, w366 |
| Activity strip (compact) | y840 h44 | y708 h44 | y788 h44 |
| Inspector | side, 400 (480 expanded) | overlay, 400-440 | sheet below a 112 px map peek |

Inspector mode rule: side by side when `sceneWidth - inspectorWidth - 16 >= 640`; overlay on the scene's right edge when the scene is at least 600 wide but not enough for both; a sheet below 600 px viewport width. The overlay is opaque (`--deep`); the side panel is `--deep` at 97%. Expanded (480) is used only when the remaining map is at least 800 wide.

## Anchoring when the panel width changes

The scene owns one rectangle. Project cluster centres are fixed fractions (u, v) of that rectangle, and slot angles are fixed per member order. Opening the inspector changes the rectangle, never the fractions, so nothing flies. Ring radius is `min(k * rectWidth, cap)`; that is why a node near a ring edge shifts a few pixels when the radius clamps differ.

| Layout | Cluster | u | v | Ring rx |
|---|---|---|---|---|
| sparse | Ledger | 0.30 | 0.52 | min(0.19 W, 210) |
| sparse | Reports | 0.76 | 0.50 | none (single node) |
| dense | Ledger (expanded) | 0.30 | 0.56 | min(0.175 W, 175) |
| dense | Reports / Imports / Invoices (collapsed) | 0.76 | 0.19 / 0.50 / 0.81 | min(0.085 W, 175) |

Check from `layout.json`: Reports' node is at u = 0.76 in both `sparse-1440` (x 1057.9 of 1392) and `sparse-1440-inspector` (x 741.8 of 976). Ring ry is 0.5 x rx; child nodes sit 76 px (sparse) or 64 px (dense) below their parent. Node size is 44 (sparse) or 36 (dense) for sessions, 32 (sparse) or 26 (dense) for subagents, 30 for the idle satellite, 52 for a narrow project hexagon.

Overlay case: if the selected node would sit under the inspector (x > uncovered width - 60), pan the scene horizontally so it centres in the uncovered rectangle. The generator implements this, but no frame needed it (`pan` is 0 in both 1024 frames because the selected node was already clear), so the pan itself is unverified; the audit rule `selected-node-hidden` fails any frame that leaves the selection covered. Nodes under an overlay are covered, not removed; they stay reachable from the attention row, the accessible list and keyboard roving. Sheet case (narrow): the map is panned vertically so the selected node sits 56 px below the top of the scene, inside the 112 px peek strip.

## Annotation legend

Numbers are in the `*.annotated.png` images; not every number appears in every frame.

| # | Element | Rule |
|---|---|---|
| 1 | Exit control | "Dashboard" with back arrow (narrow: "Exit"). 44 high, always visible, first tab stop. |
| 2 | Project scope | 44 high field. Shows "All projects" or the scoped project; narrow shows "All". |
| 3 | Counts | Sessions, working (amber), needs you (red), subagents (violet). Mono 18 numbers, label 11. Narrow: one summary line. |
| 4 | Discreet toggle | 44 high, `aria-pressed`. Pressed is filled arc, not colour alone: the icon changes to eye-off. |
| 5 | Attention row | Oldest waiting session: word NEEDS YOU, project, title (truncates, max 200), reason, timer, Inspect (44). A "+n more" pill follows the existing banner rule when several wait; it is not drawn because the fixtures have one waiting session. Always reachable even if its node label is hidden. |
| 6 | Connection | LIVE with dot, or RECONNECTING with warning glyph. |
| 7 | Scene rectangle | The only flexible band. Fallback list replaces it when WebGL is unavailable. |
| 8 | Project label | Name plus counts. Always drawn; never covered by node labels. |
| 11 | Hidden-label note | "n labels hidden" with list glyph. Only drawn when labels were suppressed. |
| 13 | Activity strip | Compact: one line, the latest completion or latest tool. Activity button (44) opens the feed. |
| 14 | Inspector | Header (chips, close 44, title 2-line clamp, status), Activity, Conversation, composer. |
| 15 | Question card | Red-edged. Question text above choices; choices are 44 high; Send answer disabled until a choice is selected. |
| 16 | Composer | 64 px textarea plus Send (44). Disabled with a reason when the session is observed-only. |
| 17 | Close / Back | Icon close (side, overlay). "Back to map" 44 high (sheet). Returns focus to the opener. |

## Node hierarchy, status vocabulary and hit areas

Hierarchy: project cluster (ellipse platform, name, counts) > session node (hexagon) > subagent node (smaller hexagon joined to its parent by a thin violet line) > idle satellite ("+n", dashed). Narrow replaces a collapsed cluster with one project hexagon showing its count.

| State | Word | Glyph (always inside the hexagon) | Outline | Token |
|---|---|---|---|---|
| Waiting for the operator | NEEDS YOU | warning triangle with mark | double outline, heavy stroke, glow | `--alert` |
| Working | WORKING | open ring (spinner) | single | `--amber` |
| Idle parent with running child | AGENTS WORKING | small hexagon | single | `--agent` |
| Subagent running | WORKING | open ring, smaller node | single | `--agent` |
| Finished (90 s) | DONE | check | single | `--ok` |
| Idle | IDLE | small ring | single | `--arc` |
| Ended | ENDED | dash | dashed | `--ink-3` |
| Idle satellite | IDLE | "+n" | dashed, no fill | `--arc` |

Provider is a 14 px rim tag: A (Anthropic) solid, B (Bedrock) dashed, O (OpenAI), as in `docs/DESIGN.md`. Selection is four 12 px corner brackets in `--arc` around a 60 px square plus an underlined label. Discreet display removes provider tags and models. The study draws nodes at a fixed size per kind; depth scaling is left to P2.

Hit areas: every node carries a 44 x 44 transparent circle (`data-primary`) centred on it, regardless of drawn size. Where two nodes are closer than 44 px the hit circles are clipped at the midpoint; the accessible list (one 48 px row per node) is the guaranteed 44 px path. The audit found zero node pairs closer than 44 px in the ten frames, so clipping is not exercised yet; P2 must test it in its dense case.

Primary actions at 44 x 44 or larger: Exit, project scope, Discreet, Inspect, Retry, close/back, choices, Send answer, Send, Activity, list rows (48), exit-sheet buttons. The audit measured them (counts below).

## Labels

A node label is two lines on a dark plate (1 px by 4 px padding): title (Inter 13/600, max width 176, one line, ellipsis, full title in `title` and the accessible name) and status (glyph, word in Rajdhani 11 +0.14em, timer in mono 11). Candidates, in order: right, left, below, above, four diagonals, then right/left/below/above at +30 px. The plate must not touch another node's circle (radius + 5, selection 32), another label, a project label or the scene edge. First free candidate wins.

Suppression priority (placed first, kept first): selected, needs you, working with a tool, finished in the last 90 s, subagent, working, idle; satellites are never labelled because their count is inside. Ties keep list order. A suppressed label is replaced by the "n labels hidden" note; the node keeps its glyph and gets its title on hover, focus and in the list. A waiting node must always keep its label: the generator throws when it cannot place it, and the attention row names it regardless. P2 should surface this as a failing layout test.

Cluster rule: idle sessions of an unexpanded project collapse to one "+n" satellite, working and waiting sessions stay individual. An expanded project keeps its camera and shows all members (Ledger in the dense frames).

## Focus order, selection and keys

Tab order: 1 Exit, 2 project scope, 3 Discreet, 4 Inspect in the attention row, 5 the scene (one tab stop, roving arrows), 6 the inspector when open (heading first, then close, choices, Send, conversation), 7 activity strip. In the sheet the Back control is the first stop inside the sheet. Opening the inspector moves focus to its heading; closing it (Escape, close, Back) returns focus to the opener. Escape closes the innermost surface first, then clears project focus.

Inside the scene: arrows move between nodes in the stable list order (project, then session start order, so a status change never reorders it); Enter selects and opens the inspector; Home and End jump to the first and last node. In the composer, global shortcuts are suspended; Enter inserts a newline, Ctrl/Cmd+Enter or Send submits.

Selection outline: 4 corner brackets plus underlined label, so the selection is visible without colour. Focus outline is the existing `:focus-visible` 2 px `--arc`, offset 2.

## Reduced motion and GPU fallback

Reduced motion: no infinite animation anywhere. The spinner glyph is a static open ring and the word WORKING carries the state; the needs-you glow is a static `drop-shadow`; the camera does not fly on update; the done pulse is a plain fade. Colours still convey status because every state has a word and a distinct glyph.

GPU fallback (`fallback-1440`): when WebGL is unavailable or the context is lost, the scene rectangle shows a banner ("3D view unavailable · Showing the project list. Selecting, inspecting and exiting still work.") with Retry 3D (44), then the project list: group header with counts, one 48 px row per session (status glyph, word, timer, title, tool, provider, chevron). The selected row has a 2 px outline. While reconnecting the list is dimmed to 50% and desaturated, as in the dashboard, and Inspect, answer choices and Send are disabled. Retry creates one canvas.

## Example strings

| Case | Text | Where it wraps or truncates |
|---|---|---|
| Blocked question | "Which date should the export use?" with choices "Today" and "Month end" | Attention row: `Question · ...` one line with ellipsis. Inspector: wraps freely, 15/600. |
| Active tool | "Read · export.mjs" with timer "2.0s" | Mono 11 in strips and labels, 13 in the inspector; one line, ellipsis, full text in the title. |
| Disconnected source | "Source disconnected · showing last known state from 12s ago. This is not an empty conversation." and bar "Reconnecting · Last update 12s ago · showing last known state · live actions paused" | Bar is one line. The inspector note wraps. |
| Long session title | "Reconcile the quarterly invoice export totals against the ledger before the audit review on Friday" | Node label: one line, 26 characters then ellipsis. Attention row: single line, max 200 px. Inspector: two-line clamp with the full title in `title`; `overflow-wrap: anywhere`. |
| Observed only | "Follow-up unavailable · observed only" | Disabled composer; Send is disabled and keeps the 44 px size. |
| Discreet | Aliases "Project 1", "Session 1", "Agent 2"; reason text becomes "Waiting for you" | Tab-local aliases by entity, never by title. |

Tokens used: colours `--void --deep --glass --arc --arc-35 --arc-15 --arc-06 --line --amber --alert --ok --agent --ink --ink-2 --ink-3`; fonts `--f-display --f-label --f-body --f-mono`; type sizes 11, 13, 15, 18 only (the audit fails any other computed size); space on the 4 px grid (8 band gaps, 12 or 16 padding, 20 panel padding); panels use `.cutbox`, `.panel`, `.pb`, `.chip`, `.stag`, `.ic`/`.gl` from foundation.css. Status text on `--deep`: ink 16.37, `--ink-2` 7.91, alert 5.85, amber 10.79, ok 14.6, agent 7.3, arc 12.51; `--ink-3` 3.69 is labels only, as DESIGN.md allows; alert text on the red-tinted attention row is 5.46.

## Colour-removed check

`*.gray.png` apply `filter: grayscale(1)` to the page. Reading the dense and sparse grays:

- Needs-you is identifiable by the triangle glyph, the double heavy outline, the word NEEDS YOU and its place in the attention row.
- Working is an open ring plus the word WORKING; finished is a check plus DONE; idle is a small ring plus IDLE; running subagent is a smaller hexagon with a ring on a violet line.
- Unlabelled nodes (suppressed labels) remain distinguishable by glyph and outline alone, but only needs-you, working and finished differ at a glance; idle and working are close at small sizes, so the label or list is the reliable reader. This is a known limit, not a failure.
- All counts, statuses and the discreet state read the same without colour.

## Discreet display check

`discreet-1440` and `narrow-3-exit` contain none of the strings Ledger, Reports, Imports, Invoices, Export, Check totals, export.mjs, Which date, Review export, Synthetic, Reconcile in any text, attribute or accessible name (audit rule `discreet-leak`: 11 strings on the desktop frame, 10 on the narrow one). The inspector is closed; the exit sheet offers the two contract choices.

## Click and keyboard walkthrough for P2 and P3

1. Open the cockpit from the dashboard (`sparse-1440`). Focus lands on the cockpit heading; Tab reaches Exit, project scope, Discreet, Inspect.
2. Activate Inspect (or click or press Enter on the waiting node). Selection ring appears on that node, the scene rectangle shrinks to 976 (side) with no node moving relative to its slot, and the inspector opens with focus on its heading (`sparse-1440-inspector`).
3. In the inspector choose "Month end" (choice shows a check and 2 px outline), press Send answer. Send is disabled until a choice exists. Do not close on send.
4. Escape closes the inspector and returns focus to the node. A second Escape clears project scope.
5. At 1024 (`sparse-1024`, `dense-1024`) the same steps overlay the inspector; the selected node stays in the uncovered area and Exit and Inspect never move.
6. At 390 (`narrow-1-waiting` to `narrow-2-inspect`): tap Inspect; the sheet slides over the map leaving the selected node visible in a 112 px peek; Back to map closes it and restores the map.
7. Toggle Discreet (`discreet-1440`): the inspector closes, names become aliases, provider tags disappear. Press Exit while discreet (`narrow-3-exit`): choose Return to dashboard and reveal details or Stay discreet.
8. Lose WebGL (`fallback-1440`): the list replaces the canvas, selection and the inspector still work, Retry 3D restores one canvas.

## Evidence and limits

- Audit (`audit.json`, Edge headless, software rendering): every frame passes page overflow, clipped text, truncation tips, the type scale, control and container text overflow, 44 px primary targets (9 to 23 per frame), label collisions, selected node visibility, inspector and scene separation, node accessible names, and the discreet leak check.
- Fonts: Orbitron, Rajdhani, Inter and JetBrains Mono were not loaded (no network). System faces were used, so label widths differ a little from the live HUD. The label placer uses a width estimate with margin; the audit measured the real boxes.
- These are static compositions of DOM and SVG, not the 3D scene. Perspective, camera, glow and the real node density come from P2.
- Not reviewed by taste; the coordinator can accept on the checks.
