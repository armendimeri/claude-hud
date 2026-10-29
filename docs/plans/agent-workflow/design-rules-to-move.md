# Design rules to move into projects (for P3-02 and P3-04)

P1 merged the three `apple-design` copies into `workflow/skills/apple-design/SKILL.md`. That skill is generic and reads each project's `docs/design-system.md` first, which wins. The project-specific parts below were taken out of the shared skill and belong in those projects' design-system files. This file is deleted with the plan.

The user-level `apple-design` is **not installed yet**: a personal skill overrides a project skill of the same name, so the kit installs it only once ImPOS-Maui and FidiaCRM have dropped their own copies (`node workflow/kit.mjs install apple-design`, at the end of P3-04, or in P4).

## ImPOS-Maui (P3-02): into a new `docs/design-system.md`

- **The performance rules (skill section 0) are strict here, never relaxed.** The original wording of the targets:

  > ImPOS runs in Android WebView (often on cheap phones and tablets), WebView2 on Windows and WKWebView on iOS. Several techniques that look fine in desktop Chrome freeze or stutter there. Every rule below was found by measuring, on a phone or the emulator (`docs/performance/BACKLOG.md`). **If an idea later in this skill conflicts with a rule here, the rule wins.** If a design really seems to need a banned technique, ask the owner first, and test it with a flick on an Android phone before shipping.

- **Tokens:** `--pos-canvas`, `--pos-surface`, `--pos-line`, `--pos-shadow-*` in `wwwroot/css/tokens.css`. The skill's generic `--canvas`, `--surface` and `--line` mean these.
- **The fixed backdrop** is `html::before` in `wwwroot/css/tokens.css` (skill rule 0.5).
- **The evidence behind each rule** (`docs/performance/BACKLOG.md`):

| Rule | What | Backlog evidence |
|---|---|---|
| 0.1 | No scroll-driven animations. | B-35, Galaxy S23 |
| 0.2 | No blur on anything content scrolls under. | B-28, B-31 |
| 0.3 | No endless animations. | B-31 |
| 0.4 | Animate only `transform` and `opacity`, briefly, in response to an action. | B-31 |
| 0.5 | No `background-attachment: fixed`. | B-24 era, ~300 repaints per six swipes |
| 0.6 | No styled scrollbars on touch devices. | B-24: 162–170 repaints per scroll test, 0 without |
| 0.7 | Never take over scrolling. | B-36 |
| 0.8 | `will-change` only while something moves. |  |

- **Removed from the shared skill:** the "Initial Response" block (a canned reply on first use). FidiaCRM had already dropped it.

## FidiaCRM (P3-04): into `docs/design-system.md` (today `Documentation/Implementation/DESIGN-SYSTEM.md`)

The FidiaCRM copy was the ImPOS copy plus this addendum, and a description that asked for the skill before *any* UI work in the repo (Razor markup, CSS, layout, tokens, dialogs, tables, navigation, page headers, empty states, Syncfusion theme overrides). The shared skill's description now says the same for every project. Put the addendum at the top of FidiaCRM's design system, with its paths updated after the `Documentation/` → `docs/` rename:

> ## FidiaCRM addendum (read first in this repo)
> 
> In FidiaCRM the visual direction, orange accent, page anatomy, navigation UX and definition of done are fixed by `Documentation/Implementation/DESIGN-SYSTEM.md`. **Read it in full before the first markup or CSS change of a task**; it is binding for every view, new or existing, and it applies on top of this skill (section 0 still wins). A view is not done when the gates pass (`powershell -File Documentation/Implementation/design-gates.ps1`): it must be rendered and looked at.
> 
> This skill was written for ImPOS: where it names `--pos-*` tokens or ImPOS files, use `FidiaCRM.Web/wwwroot/css/tokens.css` instead. Syncfusion only where `Documentation/BlazorMigrationPlan.md` section 6.2 allows it; everything else is hand-built HTML/CSS.

FidiaCRM's `CLAUDE.md` "Design" section repeats parts of this. Keep it in one place: the design system. CLAUDE.md links to it.

## TourCMS (P3-01)

`docs/skills/apple-design/skill.md` is the original version, from before the performance rules, and was never loaded (wrong folder, lowercase file name). Delete it. TourCMS has nothing project-specific to move.
