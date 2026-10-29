---
name: apple-design
description: Design rules for any UI work in the owner's web projects - Apple's approach to interface design and fluid, physical motion, translated for the web, under the project's own docs/design-system.md, which wins. Use before writing, changing or reviewing markup, CSS, layout, tokens, typography, dialogs, tables, navigation, empty states or animation, and for gesture-driven UI, springs, drag/swipe/sheet interactions, momentum and interruptible transitions, materials and depth, reduced motion, and the design foundations (feedback, spatial consistency, restraint).
---

# Apple Design

How Apple builds interfaces that stop feeling like a computer and start feeling like an extension of you. This knowledge comes from Apple's WWDC design talks — chiefly *Designing Fluid Interfaces* (WWDC 2018) — distilled and translated into the web platform (CSS, Pointer Events, `requestAnimationFrame`, spring libraries like Motion/Framer Motion).

The through-line: **an interface feels alive when motion starts from the current on-screen value, inherits the user's velocity, projects momentum forward, and can be grabbed and reversed at any instant.** Springs are the tool that makes all of this natural, because they are inherently interruptible and velocity-aware.

## Before anything: the project's design system

1. Read the project's `docs/design-system.md` in full before the first markup or CSS change of a task, and any file it names. Its tokens, components, page anatomy and definition of done are binding: **where it differs from this skill, it wins.**
2. This skill names tokens generically (`--canvas`, `--surface`, `--line`, shadow tokens). Use the project's own tokens.
3. If the project has no `docs/design-system.md`, say so in your report and match the pages next to yours.

## The Core Idea

> "When we align the interface to the way we think and move, something magical happens — it stops feeling like a computer and starts feeling like a seamless extension of us."

An interface is fluid when it behaves like the physical world: things respond instantly, move continuously, carry momentum, resist at boundaries, and can be redirected mid-motion. Everything below is a way to get closer to that.

Apple frames design as serving four human needs: **safety/predictability, understanding, achievement, and joy.** Every rule here serves one of them.

## 0. Performance rules — these override everything below

These rules keep motion smooth in WebViews (Android WebView on cheap phones and tablets, WebView2, WKWebView) and on touch devices, where techniques that look fine in desktop Chrome freeze or stutter. They were found by measuring on real phones. **If an idea later in this skill conflicts with a rule here, the rule wins**, unless the project's `docs/design-system.md` relaxes it (a desktop-only back office may allow what a phone app can't). If a design really seems to need a banned technique, ask the owner first, and test it with a flick on the slowest target device before shipping.

1. **No scroll-driven animations.** Never use `animation-timeline: scroll()` / `view()`, `scroll-timeline`, `view-timeline` or `animation-range`, and no JS `scroll` listeners that restyle the page on every scroll event. *Why:* while one runs, Android WebView does not draw a flicked scroll. The page freezes for the whole fling, then jumps to its end. *Instead:* a static edge, or none.
2. **No blur on anything content scrolls under.** No `backdrop-filter` or `filter: blur()` on sticky or fixed bars, headers, table heads, pinned cells or floating toolbars. *Why:* the blur is redone on every scrolled frame and every animation frame. *Instead:* a solid or near-solid token background (the project's canvas or surface token). Blur is allowed only on desktop (`@media (pointer: fine)`), on at most one surface per screen, and never under `@media (pointer: coarse)`.
3. **No endless animations.** No `animation-iteration-count: infinite` on anything that stays on screen: no pulsing or breathing status dots, no drifting backgrounds, no looping glows. *Why:* in Android WebView any running animation makes the whole screen redraw every frame; an endless one does that for as long as the page is open. *Instead:* show status with colour, an icon and a label. A spinner or skeleton shimmer is allowed only while data is actually loading, and must be removed from the DOM when it arrives.
4. **Animate only `transform` and `opacity`, briefly, in response to an action.** Keep it to about 300 ms at most. Never animate `box-shadow`, blur radius, `filter`, `width`/`height`, `top`/`left`, `background-position` or colours on large areas. *Why:* every animation frame redraws the whole screen. A 180 ms tap bounce costs about 14 frames. Fewer and shorter animations are better.
5. **No `background-attachment: fixed`.** A fixed backdrop is a `position: fixed` layer of its own. *Why:* Chromium cannot scroll a fixed background on the GPU, so it repaints the whole screen on every scrolled frame.
6. **No styled scrollbars on touch devices.** `scrollbar-color`, `scrollbar-width: thin` and `::-webkit-scrollbar*` styling go only inside `@media (pointer: fine)`. Hiding a scrollbar (`scrollbar-width: none`) is fine. *Why:* a styled scrollbar is repainted on the main thread on every scrolled frame.
7. **Never take over scrolling.** Don't reimplement scrolling, momentum, snapping or overscroll in JS. Don't add `touchstart`, `touchmove`, `touchend` or `wheel` listeners that aren't `{ passive: true }`, above all on `window` or `document`. Don't call `preventDefault()` on touch events to steal a scroll, and don't use `touch-action: none` on anything that scrolls. *Why:* a non-passive `touchend` makes every fling wait for the page's main thread before it can start. The native fling already does §6's momentum projection, better than JS can. *Instead:* springs, velocity handoff and rubber-banding (§3–§9) are for elements the user **drags** (sheets, cards, sliders, swipe-to-act rows), never for a page or a list.
8. **`will-change` only while something moves.** Set it when a gesture or animation starts and remove it when it ends. Never leave it in static CSS. *Why:* each one keeps a GPU layer alive for as long as the element exists.

**How to check:** on a real phone (Android first, where it is slowest), flick a long screen up and down. It must keep moving after the finger lifts and slow down smoothly, with no pause and no jump on the next touch. Scrolling with the finger down proves nothing. DevTools' `Input.synthesizeScrollGesture` suppresses the fling unless you pass `preventFling: false`. The emulator draws every app at about 12 frames a second and does not show these freezes; use a real phone.

## 1. Response — kill latency

The moment lag appears, the feeling of directness "falls off a cliff." Response is the foundation everything else is built on.

- **Respond on pointer-down, not on release.** Highlight a button the instant it's pressed. Waiting for `click`/touch-up to show feedback feels dead.
- **Be vigilant about every latency.** Audit debounces, artificial timers, transition waits, and the ~300ms tap delay. Anything on the input path that isn't essential is a regression.
- **Feedback must be continuous *during* the interaction, not just at the end.** For a drag, slider, or drawer, update the UI 1:1 with the pointer the whole way through — never animate only when the gesture completes.

```css
/* Feedback lives on the press, and it's instant */
.button:active {
  transform: scale(0.97);
  transition: transform 100ms ease-out;
}
```

## 2. Direct manipulation — 1:1 tracking

> "Touch and content should move together."

When the user drags something, it must stay glued to the finger — and respect the offset from *where they grabbed it*. Snapping to the element's center on grab breaks the illusion immediately.

- Use Pointer Events with `setPointerCapture` so tracking continues even when the pointer leaves the element's bounds. Put `touch-action: none` (or `pan-x` / `pan-y`) on the dragged element only, never on a scroll container or the page (rule 0.7).
- Track a short **velocity/position history** (last few `pointermove` events), not just the current point — you'll need velocity at release.

```js
el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  const grabOffset = e.clientY - el.getBoundingClientRect().top; // respect where they grabbed
  // ...track position + timestamp history for velocity
});
```

## 3. Interruptibility — the single most important principle

> "The thought and the gesture happen in parallel."

Every animation must be interruptible and redirectable at any moment. A user must be able to grab a moving element mid-flight and reverse it without waiting for the animation to finish. A closing modal the user grabs again should follow the finger — not finish closing first, then reopen.

- **Never lock out input during a transition.**
- **Always animate from the *presentation* (current) value, never the target value.** On interrupt, read the element's live on-screen transform and start the new animation from there. Starting from the logical/target value causes a visible jump.
- **Avoid CSS transitions and `@keyframes` for anything gesture-driven** — they can't be smoothly grabbed and reversed mid-flight. Springs animate from the current value by default, which is exactly what interruption needs.
- **When a gesture reverses, blend velocity — don't hard-cut it.** Replacing one animation with another at a reversal creates a velocity discontinuity, a "brick wall." Spring libraries that carry velocity through a re-target avoid it. (This is what iOS's *additive animations* do natively; on the web, choose a spring library that re-targets from the current velocity.)
- **Decompose 2D motion into independent X and Y springs.** A single spring on a 2D distance desyncs when X and Y have different velocities.

## 4. Behavior over animation — use springs

> "Think of animation as a conversation between you and the object, not something prescribed by the interface."

A pre-scripted, fixed-duration animation can't respond to new input. A spring can — new input just changes the target, and the motion stays continuous. Reach for springs for anything a user can touch.

Apple deliberately replaced the physics triplet (mass/stiffness/damping) with two designer-friendly parameters. Think in these:

- **Damping ratio** — controls overshoot. `1.0` = critically damped, no bounce, smooth settle. `< 1.0` = overshoots and oscillates. Lower = bouncier.
- **Response** — how quickly the value reaches the target, in seconds. Lower = snappier. **This is not "duration"** — a spring has no fixed duration; its settle time emerges from the parameters.

**Defaults:**
- Start most UI at **damping `1.0`** (critically damped) — graceful and non-distracting.
- Add bounce (**damping ~`0.8`**) **only when the gesture itself carried momentum** (a flick, a throw, a drag release). Overshoot on a menu that just faded in feels wrong; overshoot on a card you flicked feels right.

**Concrete values Apple ships:**

| Interaction | Damping | Response |
| --- | --- | --- |
| Move / reposition (e.g. PiP) | `1.0` | `0.4` |
| Rotation | `0.8` | `0.4` |
| Drawer / sheet | `0.8` | `0.3` |

**Web mapping (Motion / Framer Motion):** the `bounce` + `duration` spring API maps closely to Apple's damping + response. A safe house style is `damping: 1.0` springs everywhere by default; reserve bounce for momentum-driven, physical interactions.

```js
import { animate } from 'motion';

// Critically damped default (no overshoot)
animate(el, { y: 0 }, { type: 'spring', bounce: 0, duration: 0.4 });

// Momentum interaction — a little bounce, only because a flick preceded it
animate(el, { y: target }, { type: 'spring', bounce: 0.2, duration: 0.4 });
```

## 5. Velocity handoff — the seam between drag and animation

When a gesture ends, the animation must **continue at the finger's exact velocity**, so there's no visible seam between dragging and animating. This is the detail that most separates "fluid" from "fine."

Pass the pointer's release velocity as the spring's initial velocity. Some spring APIs want **relative** velocity — normalize it by the remaining distance to the target:

```
relativeVelocity = gestureVelocity / (targetValue − currentValue)
```

Example: element at `y=50`, target `y=150` (100px to go), finger moving 50px/s → initial spring velocity = `50 / 100 = 0.5`. Framer Motion / Motion take absolute px/s velocity directly (`velocity` option), so you usually hand it the raw value.

## 6. Momentum projection — animate to where the gesture is *going*

> "Take a small input and make a big output."

Don't snap to the nearest boundary from the *release point*. Use velocity to **project the resting position** — exactly like scroll deceleration — then snap to the target nearest that projected point. This is what makes a flick feel like it throws the element.

This is for elements the user drags and throws (a sheet, a card, a carousel page). Scrolling a page or a list already does this natively. Never reimplement it for scrolling (rule 0.7).

Apple's exact projection function (from the *Designing Fluid Interfaces* sample code):

```js
// decelerationRate ≈ 0.998 for normal scroll feel; 0.99 for snappier
function project(initialVelocity /* px/s */, decelerationRate = 0.998) {
  return (initialVelocity / 1000) * decelerationRate / (1 - decelerationRate);
}

const projectedEndpoint = currentPosition + project(releaseVelocity);
const target = nearestSnapPoint(projectedEndpoint);   // choose target from the projection
animateSpringTo(target, { velocity: releaseVelocity }); // then hand off velocity (§5)
```

Note: the physics-textbook `v²/(2·decel)` is *not* what Apple ships — use the exponential-decay form above. This is the standard behavior in good bottom-sheets and carousels (Vaul, Embla).

## 7. Spatial consistency — symmetric paths, anchored origins

> "If something disappears one way, we expect it to emerge from where it came."

- **Enter and exit along the same path.** A panel that slides in from the right must dismiss to the right. In-from-right / out-the-bottom feels disconnected and confusing.
- **Anchor interactions to their source.** A menu, popover, or sheet should originate from the element that triggered it — set `transform-origin` to the trigger, so the spatial relationship between button and content is obvious. (This is the same origin-awareness point as popovers scaling from their trigger, not their center.)
- **Mirror the easing on reversible transitions** so the outbound path matches the return path (use inverse cubic-bézier control points for the two directions).

## 8. Hint in the direction of the gesture

Humans predict a final state from a trajectory. Intermediate motion should telegraph where things are going — Control Center modules "grow up and out toward your finger." Make the in-between frames point at the outcome, not just interpolate blindly to it.

## 9. Rubber-banding — soft boundaries

At an edge, resist progressively instead of stopping hard. A hard stop reads as "frozen"; continuous resistance reads as "responsive, but there's nothing more here." Apply damping that increases the further past the boundary the user drags.

Only for dragged elements, such as a sheet pulled past its top. The platform already rubber-bands scroll areas; never fake it on a page or a list (rule 0.7).

```js
// The further past the bound, the less the element follows — real things slow before they stop
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
```

## 10. Gesture design details (the "feel" checklist)

- **Tap:** highlight on touch-*down* (instant), commit on touch-*up*. Add ~10px of hysteresis/hit padding around the target, and allow cancel-by-dragging-away and back.
- **Drag/swipe:** require a small movement threshold (hysteresis, ~10px) before committing to a direction, then track 1:1.
- **Detect all plausible gestures in parallel from the first move**, then confidently cancel the losers once intent is clear. Avoid recognizers that only report a *final* state (`swipeleft`-type events) — they throw away the continuous tracking you need for feedback.
- **Minimize disambiguation delays.** Double-tap detection unavoidably delays single taps; only pay that cost where double-tap truly exists.

## 11. Frame-level smoothness

Smoothness is about *what's in the frames*, not just the frame rate.

- Keep the per-frame positional change below the perception threshold to avoid strobing.
- Don't add motion blur. A `filter: blur()` on moving content is redone on every frame (rule 0.2); a short, well-eased `transform` reads fast enough.
- `requestAnimationFrame` is the web's display-synced clock (Apple uses `CADisplayLink`). Animate only compositor-friendly properties — `transform` and `opacity` (rule 0.4). Set `will-change` when the motion starts and remove it when it ends (rule 0.8).
- In a WebView, and on low-end devices, every animation frame redraws the whole screen, so the smoothest frame is often the one you don't draw. Prefer fewer, shorter animations to many small ones.

## 12. Materials & depth — translucency conveys hierarchy

Apple uses translucent materials as a floating functional layer that brings structure without stealing focus. The *structure* matters more than the translucency: get layering from tone, a hairline and a shadow, and treat real blur as a desktop-only extra (rule 0.2).

- **Build nav, toolbars and sheets as distinct layers**: a solid or near-solid token background a step off the canvas, a hairline edge and a soft shadow. On desktop (`@media (pointer: fine)`) a bar *may* use `backdrop-filter`, on one surface per screen at most. On touch devices it is always solid.
- **Material weight encodes hierarchy:** darker/heavier materials separate structural regions (sidebars); lighter materials draw attention to interactive elements (buttons). **Never stack a light translucent surface on another** — legibility collapses.
- **Bigger surfaces should read as thicker:** a deeper shadow and a stronger tone step than small chips, not more blur. Use the project's shadow tokens, and keep big soft shadows for a few raised surfaces, not every row of a long list.
- **Dim to focus, separate to keep flow.** A modal task pairs the surface with a dimming scrim and pushes the background back/down. A parallel, non-blocking panel uses offset and a tone step *without* a scrim so the flow isn't broken. For stacked sheets, progressively dim each parent layer.
- **Keep text legible on every material.** Don't use flat gray text on a tinted or translucent surface: use higher contrast, slightly heavier weight and a small letter-spacing bump. Put colour on a solid layer, not on a translucent foreground.
- **Edges, not effects, where content meets chrome.** A sticky header gets a static hairline (the project's hairline token) and at most a small static shadow, or no edge at all. Never fade it in with the scroll (rule 0.1) or blur what passes under it (rule 0.2).
- **Arrive with opacity and scale.** For sheets and popovers, animate `opacity` and `transform: scale()` together on enter and exit, briefly (rule 0.4). Never animate the blur radius.

```css
.toolbar {
  background: var(--canvas);                 /* solid by default: phones, tablets, touch terminals */
  border-bottom: 1px solid var(--line);      /* a static edge, never a scroll-driven fade */
}
@media (pointer: fine) {
  .toolbar {                                     /* desktop only, and only on one bar per screen */
    background: color-mix(in srgb, var(--canvas) 72%, transparent);
    backdrop-filter: blur(20px) saturate(180%);
  }
}
```

## 13. Multimodal feedback — motion + sound + haptics

Three rules for combining senses (from *Designing Audio-Haptic Experiences*):

1. **Causality** — it must be obvious what caused the feedback. Trigger it on the actual causal event (the toggle flipping, the item snapping home), and match its character to the action's physicality.
2. **Harmony** — the visual, the sound, and the haptic must fire on the **same frame**. Latency between them destroys the illusion. Don't let a CSS transition lag the audio/haptic (Vibration API).
3. **Utility** — add feedback only where it earns its place. Reserve haptics/sound for meaningful moments (success, error, commit, snap). Over-feedback trains users to ignore all of it.

## 14. Reduced motion & accessibility

Reduced motion doesn't mean *no* feedback — it means a gentler, non-vestibular equivalent. Respond to three independent signals and bake them into your components:

- **`prefers-reduced-motion: reduce`** — replace slides/springs/parallax with short opacity **cross-fades or static transitions**. Drop elastic/overshoot. Keep opacity/color changes that aid comprehension.
- **`prefers-reduced-transparency: reduce`** — make any remaining translucent surface solid: raise background opacity, drop the blur.
- **`prefers-contrast: more`** — near-solid backgrounds with a defined, contrasting border.

Also: no full-viewport moving backgrounds and no looping animations, apart from a loading indicator while data loads (rule 0.3), and avoid abrupt brightness jumps (ease dark↔light theme changes). Make large moving objects semi-transparent while they travel, and fade big surfaces out during a large reposition and back in once settled.

```css
@media (prefers-reduced-motion: reduce) {
  .sheet { transition: opacity 200ms ease; transform: none !important; }
}
@media (prefers-reduced-transparency: reduce) {
  .toolbar { background: white; backdrop-filter: none; }
}
```

## 15. Typography — optical sizing, tracking, leading

Apple designs type to change shape with size; the same discipline applies on the web. (From *The Details of UI Typography*, WWDC 2020.)

- **Tracking (letter-spacing) is size-specific — never one value for all sizes.** Large display text wants *negative* tracking (letters read too far apart as they grow); small text wants slightly *positive* tracking for legibility. A fixed `letter-spacing` is wrong somewhere. Tighten headings, leave body near `0`.
- **Leading (line-height) tracks size inversely.** Tight on large headings, looser on body copy. Increase it for scripts with tall ascenders/descenders; tighten it for dense, information-heavy UI.
- **Build hierarchy from weight + size + leading as a set,** not size alone. Emphasize with weight — it adds presence without taking more space.
- **Respect the user's text-size setting** (Dynamic Type). Scale layout *with* the text — spacing in `rem`/`em`, not fixed px — so a larger font doesn't break the layout.
- **Default to the platform's system font** before a custom face; it already ships optical sizing, tracking tables, and legibility tuning. Override only with a reason.

```css
:root { font: 100%/1.5 system-ui, sans-serif; } /* body: system font, comfortable leading */

.display {
  font-size: clamp(2rem, 5vw, 4rem);
  line-height: 1.05;        /* tight leading for large text */
  letter-spacing: -0.02em;  /* negative tracking as it grows */
  font-optical-sizing: auto;
}
```

## 16. Design foundations — the eight principles

The motion and craft above serve Apple's eight design principles (*Principles of Great Design*, WWDC 2026). Use these as the names you reason with:

1. **Purpose.** Make with intention; decide what *not* to build. Every feature asks for the user's time, attention, and trust — spend that budget only where it pays off.
2. **Agency.** Keep people in control: offer choices, don't force a single path. Back it with forgiveness — easy undo for slips, a confirmation dialog only for genuinely destructive, irreversible actions (use sparingly; overusing it trains people to click through).
3. **Responsibility.** Act in the user's interest. Privacy: ask at the right moment, only for what's needed, transparently. Safety: anticipate misuse and harm — especially with AI (an allergy-aware recipe app must not suggest a harmful ingredient). Add previews, confirmations, disclaimers; cut a feature whose risk outweighs its value.
4. **Familiarity.** Build on what people already know. Use metaphors that are neither too literal nor too abstract (a trash can means delete), and honor their physics. Be consistent: things that look the same must behave the same and live in the same place (close is always top-left on macOS) so people can predict what happens next. Only break a familiar pattern if you can prove it's better — then test it, don't assume.
5. **Flexibility.** Design for different contexts, devices, and the full range of abilities. Adapt to the platform (iPhone = quick touch; desktop = deep workflows with precise pointer control) and to the situation. Design inclusively (age, language, expertise, accessibility). When no single layout fits everyone, let people personalize — rearrange controls, hide what they don't use.
6. **Simplicity — not minimalism.** Strip the unnecessary so the core purpose shines; burying everything in one place looks minimal but isn't simple. Be concise (plain language, no jargon, fewer steps) and clear (use hierarchy — order, spacing, contrast — so the most important thing is the most obvious). Every element earns its place; sometimes *adding* context simplifies (a video scrubber that shows time remaining). Show the common path first, advanced options one level deeper.
7. **Craft.** Uncompromising attention to detail builds trust. Beautiful typography, colors that adapt to light/dark, clear iconography, and responsive animations that give immediate, natural feedback. Nothing is random — every spacing, timing, and alignment value is a deliberate choice you can defend. Jittery scroll, misaligned icons, and layouts that break on rotation read as carelessness. Craft needs iteration and longevity — keep evolving the design as features and hardware change.
8. **Delight.** The result of getting the other seven right, not confetti tacked on top. Decide the emotion you want people to feel (calm, confident, excited) and reinforce it in every decision.

Tactical rules that serve these:

- **Feedback comes in four kinds:** status, completion, warning, error. Confirm meaningful actions, expose ongoing status, warn before problems, validate inline (not on submit).
- **Wayfinding.** Every screen should answer: Where am I? Where can I go? What's there? How do I get out? Never trap the user.
- **Grouping & mapping.** Proximity implies relationship; place a control near what it affects and arrange controls to mirror what they change. If you need a label to explain a control, the mapping is weak.
- **Direct, specific labels beat safe generic ones.** Name nav items for their contents ("Progress", "Library"), not vague umbrellas ("Home"). Specificity creates predictability.

## 17. Process

- **Prototype interactively — an interactive demo is worth "a million static designs."** You discover the interface by building and playing with it; a working prototype also sets a concrete bar that prevents a mediocre final implementation.
- **Design interaction and visuals together.** "You shouldn't be able to tell where one ends and the other begins." Motion is not a layer added after the pixels.
- **Test with real people in real context**, and review motion with fresh eyes — play it in slow motion / frame-by-frame to catch what's invisible at full speed.

## Quick Reference

| Need | Technique | Concrete value |
| --- | --- | --- |
| Default UI spring | Critically damped, no overshoot | `damping 1.0`, `response 0.3–0.4` |
| Momentum / flick spring | Under-damped, slight bounce | `damping ~0.8`, `response 0.3–0.4` |
| Gesture → spring velocity | Hand off release velocity | `gestureVelocity / (target − current)` if normalized |
| Flick landing point | Project momentum | `current + (v/1000)·d/(1−d)`, `d ≈ 0.998` |
| Interrupt cleanly | Start from presentation (live) value | read the on-screen transform |
| Avoid reversal "brick wall" | Carry velocity through re-target | spring that blends velocity |
| Reversible transition | Mirror the easing curve | inverse cubic-bézier |
| Decide reverse vs. commit | Use velocity **sign**, not position | at release |
| 1:1 drag | Pointer Events + capture | respect the grab offset |
| Feedback | On pointer-down, continuous | never only at the end |
| Boundary (dragged elements only) | Rubber-band, don't hard-stop | progressive resistance |
| Chrome over scrolling content | Solid token background + static hairline | blur on desktop only, one surface (rule 0.2) |
| Scroll edge | Static hairline or nothing | never `animation-timeline` (rule 0.1) |
| Status that stays on screen | Colour + icon + label | never an endless pulse (rule 0.3) |
| What may animate | `transform`, `opacity` | ≤ ~300 ms, on an action (rule 0.4) |
| Scrolling and flinging | Native only, passive listeners | never reimplemented in JS (rule 0.7) |
| Scrollbars | Native on touch | styled only in `(pointer: fine)` (rule 0.6) |
| Type tracking | Size-specific, never fixed | tighten large text (`-0.02em`), body near `0` |
| Reduced motion | Cross-fade, not slide/spring | `@media (prefers-reduced-motion)` |
