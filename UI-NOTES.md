# UI refresh — what changed

A styling pass over the admin panel. **No logic, no data flow, no behaviour was
touched**: `app.js` is byte-for-byte unchanged, no class name was renamed or
removed, and no element was moved in the DOM. Everything below is `style.css`
plus two one-line edits in `index.html` (both listed at the end).

---

## The shape of the change

| | Before | After |
|---|---|---|
| Desktop ≥960px | Top bar + horizontal tab strip, content floating under it | Top bar + **left nav rail**, one content column |
| Tablet 721–959px | Same strip, clipped at six labels | Same strip, edge fade so it reads as scrollable |
| Phone ≤720px | Top bar + bottom nav + FAB | Same — tightened, retargeted, re-spaced |
| Content width | 1100px, and **no gutter at all** on two of the tabs | One 1180px column, every tab |
| Tables | Flat, grey header row | Card container, sticky-looking header, aligned numeric columns |
| Cards | `class="card"` had no rule outside the phone media query | A real surface: border, radius, elevation |

The panel is still the same panel. Same six tabs, same order, same buttons,
same dialogs, same one-question-at-a-time inspector flow.

## What's new, screen by screen

**Login** — split card: brand panel on one side, form on the other. Full-width
"Sign in" on a phone, brand banner above the form.

**Shell** — frosted top bar with the signed-in account as a pill; nav rail with
mask-drawn icons (the emoji in the markup is still there and still the
accessible label — it is just swapped for an SVG mask so the whole rail keeps
one icon language). Each page opens with the same icon in a tinted tile.

**Catalog** — filters sit in their own surface with the primary action pushed
right. The model table got column widths, a green-tinted "Variants" action, a
quiet red "Delete", and the expanded variant panel now reads as one block
instead of a card inside a row.

**Orders** — live status as a dot-and-label pill per state (`placed`,
`agent_assigned`, `inspection`, `paid`, `declined`); the assignment dropdown is
deliberately quieter than the status one, since only one of them is the
decision; order references no longer wrap mid-code.

**Pricing rules** — each rule is a card with a header rule, the money preview as
a pill beside the percentage, and move/delete buttons riding the bottom of the
row. The "worst case" line is a note, not a paragraph.

**Inspection checklist** — the outer wrapper card steps back so the page reads
as a list of questions; the answer counter is a legible `1/2` pill; the clean
answer row keeps its green.

**Staff** — form and inspector list side by side on a wide screen, stacked on a
phone.

**Order sheet** — the steps became a segmented row, the totals block got a rule
and a larger figure, and on a phone the sheet takes the whole screen (as
before) with a fade on the step row to show it scrolls.

**Inspector's own screen** — the flow was already good; it inherits the new
tokens, and the step bar, answer buttons and price pills were re-spaced for a
thumb.

---

## Bugs fixed on the way

Found by running the panel against a mock Firebase and screenshotting every
screen at 1440 / 860 / 390px, admin and inspector:

1. **`#tab-staff`, `#tab-checklist` and `#tab-inspector` sit outside
   `<main class="content">`**, so they never picked up its gutter or max-width —
   both tabs ran edge-to-edge on a desktop screen. They now get the identical
   box (`padding`, `max-width`, centred).
2. **`.card` had no styling outside the `max-width: 720px` block**, so the Staff
   and Checklist cards were invisible on a desktop.
3. **A blank `MANAGE` rail** on the inspector's desktop screen: their tab
   buttons are removed from the DOM, but the empty `<nav class="tabs">` is not.
4. **Horizontal overflow on the pricing tab at 390px**: a `<input>` in a flex
   row refuses to shrink below its intrinsic width, pushing the row 65px past
   the viewport (and, on a real phone, letting the whole page pan sideways).
5. **The mobile search icon sat on top of the placeholder** — the mobile input
   padding override beat the `padding-left` that reserves room for it.
6. **The answer counter rendered as `1` above `/2`** (a grid container puts the
   number and its denominator on separate rows).
7. **A sticky filter toolbar ate a third of the phone screen.** It is three
   filter rows tall; it now scrolls with the page, and the catalog controls are
   laid out as Brand | Series, Show | Refresh, then a full-width primary action.
8. Two greys failed contrast at 12px (`--text-tertiary` was ~3.2:1 on white);
   both are now over 4.5:1.

---

## Design tokens

One scale now, at the top of `style.css`, replacing a decade of one-off values:

- **Green** — the app's own `#32CD32` is a fill colour, so the primary is a
  slightly deeper `#1FBF4B` with **dark ink on top** (`#0B3D1D`, ~5.4:1) rather
  than white (~2:1). Same reasoning the file already documented.
- **Neutrals** — cool and low-chroma, so the green is the only thing that shouts.
- **Radii** 8 / 10 / 12 / 16 / 20 / pill; **elevation** as two soft layers;
  **motion** on one easing curve, with `prefers-reduced-motion` honoured.
- **Icons** — six section icons + search/chevron/empty-state, drawn once as
  masks so they inherit `currentColor`.
- Numbers that get compared down a column are `font-variant-numeric:
  tabular-nums`.

## Two edits outside `style.css`

```diff
-  <link rel="stylesheet" href="style.css?v=8" />
+  <link rel="stylesheet" href="style.css?v=9" />
```
Cache-bust, so the deployed panel actually picks the new sheet up.

```diff
-  ...family=Poppins:wght@400;500;600&display=swap
+  ...family=Poppins:wght@400;500;600;700&display=swap
```
The new scale uses 700 for badges, the question counter and the payout figure;
without the weight the browser would fake-bold them.

## How it was verified

- **Class coverage:** every class token in `app.js` + `index.html` (229 of them,
  including the ones built inside ternaries such as `badge--status-*`,
  `job-note--plain` and `ck-opt__n--clean`) is matched by a rule in
  `style.css`. Nothing the JS templates emit is left unstyled.
- **Parse check:** 491 top-level rules, no CSS parse errors, no dropped
  declarations.
- **Screens:** login, all six tabs, the expanded variant panel, the add-model
  dialog, the order sheet (both steps), at 1440 / 860 / 390px, plus the
  inspector's pickup list and all four of its steps. No console errors.
- Tested with mocked data, so the real Firestore rules and collections were
  never touched.

## Impeccable pass (skill v4.9.1, engine 0.1.24)

Run after the first refresh, using the installed `impeccable` skill in
**Operate** mode (task surface, not a brand page). Everything below is still
`style.css` only; no markup, class name or handler moved.

### Detector before → after

`impeccable detect` on the source tree and on the rendered page (mock harness,
Chromium) went from **25 findings to 0** on the rendered pages and **1 advisory**
on the source.

| Finding | Where | Fix |
| --- | --- | --- |
| `tight-leading`-class failures: `undersized-ui-text` ×14 (10.5px table heads, 9.5px bottom-nav labels, 10px rail label) | table headers, mobile card labels, bottom nav, rail section label | new `--text-micro: 11px` token; every functional micro-label now sits on it |
| `tiny-text` (11.5px body text) | login hint | 12.5px |
| `low-contrast` 4.2:1 | `--text-tertiary` on the page ground | `#6B7785` → `#5F6B78` (5.0:1 on the ground, 5.4:1 on white) |
| `low-contrast` 3.9:1 on `:hover` | `.btn--primary:hover` | hover now *lightens* (`#2ECB67`) so the dark ink keeps 5.8:1; press darkens to `#17A63F` and switches the label to `--on-primary` (5.2:1) |
| `dark-glow` | mobile FAB shadow | zero-offset green glow → neutral two-layer shadow |
| `side-tab` ×2 | `.warning-note`, `.field-help` | coloured 3px side bars removed: the note is now a tinted panel with an authored alert glyph (mask, not an emoji), the help line a plain hairline box |
| `border-accent-on-rounded` ×2 | `.warning-note`, `.detail-row--total` | 2px accent rule dropped from the rounded note; the payout ledger rule is 1px |
| `em-dash-overuse` (advisory) | `index.html` copy | **not changed** — it is the panel's own prose, not styling; say the word and it gets a pass |

Craft-floor items the detector does not catch, also fixed: the rail's selected
tab used `inset 3px 0 0` as a coloured side bar (now a tinted pill with 600
weight), and the focus ring moved off the button green onto a dedicated
`--focus: #0E7D2C` (5.3:1 on white, 4.8:1 on the ground) so it is visible
against the green primary fill.

### Operate-mode review that the detector cannot do

- **One accent weight per screen.** On phones every row's *Variants* button was
  a saturated green block, which put six primaries under the one real primary
  ("+ Add model"). It now keeps the same soft treatment it has on desktop, so
  the accent still means "primary action, current selection, state".
- **Prose measure.** The Firebase-project note ran ~200 characters per line;
  capped at 84ch.
- **Motion.** `--fast` moved 140 → 160ms, inside the 150–250ms band.
- **State coverage** (audited, already present): hover / focus-visible / active /
  disabled on buttons, inputs and selects; disabled Save in the checklist;
  empty and error rows; stale-cache note.

### Known deviations, deliberately kept

- Six text glyphs (`+`, `↻`, `↑`, `↓`, `×`, `✓`) come from `app.js` templates and
  are still characters rather than an SVG icon set. Replacing them means
  touching markup and copy, which is out of scope here.
- The phone FAB can sit over the last row's *Delete* at some scroll positions.
  It is the standard floating-button trade-off; hiding it would change the
  flow, so it stays.
- Below 340px the bottom bar goes icon-only: six 11px labels physically cannot
  share a 320px bar (verified — "Checklist" collides with "Staff" at 320px).
  The labels stay in the DOM, so accessible names are intact.

### Numbers

- `style.css`: 493 top-level rules, 0 parse errors, 0 dropped declarations.
- Rendered pages: 22 screenshots re-taken at 1440 / 860 / 390 / 360 / 320px,
  no console errors.
- `app.js`, `index.html` markup, tab order and every handler: untouched.
