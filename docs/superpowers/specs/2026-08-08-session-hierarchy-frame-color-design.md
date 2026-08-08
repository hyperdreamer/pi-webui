# Session and Project Hierarchy Frame Colour Design

## Problem

Session and project family frames currently draw their border with
`var(--pi-danger)`, which resolves to `#ff7b72` on the default dark theme. Red is
the project's error and destructive-action colour. Using it for "these rows are a
family" makes healthy grouped sessions read as a warning.

Separately, nesting depth is communicated only by indentation, a `↳` marker, and a
`depth N` badge for depth 3+. When a family contains a sub-session that itself has
children, nothing visually ties that sub-group together.

## Goals

1. Replace the danger-coloured family frame with a neutral hierarchy colour.
2. Add a level-2 grouping cue for a sub-session and its descendants.
3. Keep selection (`--pi-accent`) visually dominant over grouping.
4. Change no behaviour: no projection, ordering, folding, reorder, or DOM
   structure changes.

## Non-goals

- Nested frames at every depth. Boxes inside boxes are visually noisy given each
  row already has its own surface.
- Per-depth colours. One hierarchy colour, applied more quietly as depth grows.
- Changing the depth cap. `--depth` stays capped at 2, so depth 3+ keeps sharing
  the depth-2 indent and relies on the existing `depth N` badge.
- Restructuring `groupRows` into a real tree. Rejected: it would touch
  `data-session-reorder-path` on the flat frame and the reorder tests that depend
  on that structure, which is disproportionate risk for a visual refinement.

## Approach

Two additive CSS changes plus one conditional class. No DOM restructuring.

### 1. New theme token `--pi-hierarchy-border`

Added to the `ThemeToken` union, the `THEME_TOKENS` array, all four theme token
objects, and the pre-JavaScript bootstrap block in `src/client/index.html`.

Because `ThemeTokens = Record<ThemeToken, string>` and each theme object uses
`satisfies ThemeTokens`, omitting the token from any theme fails `npm run
typecheck`. That is the completeness guarantee; no runtime check is needed.

Values are contrast-verified against each theme's own `--pi-surface`, targeting
the WCAG 1.4.11 non-text 3:1 threshold:

| Theme | Value | Contrast vs surface |
| --- | --- | --- |
| PI WEBUI Classic | `#5c6b80` | 3.19:1 on `#161b22` |
| PI WEBUI Dark | `#5a6aa8` | 3.51:1 on `#101527` |
| PI WEBUI Light | `#8a7b64` | 3.93:1 on `#fff9ee` |
| E-Ink Color Paper | `#6f6047` | 5.79:1 on `#ffff87` |

`src/client/index.html` mirrors the Classic values, so it gets `#5c6b80`.

### 2. Frame border uses the new token

In all four components carrying a `.session-family-frame` rule, `border: 1px solid
var(--pi-danger)` becomes `border: 1px solid var(--pi-hierarchy-border)`. Every
other property of that rule is unchanged.

### 3. Level-2 rail

Rows at capped depth ≥ 2 receive a `nested` class. The rail is drawn as a
pseudo-element on the row's **inner surface element**, not the row itself:

```css
.action-row.nested .action-main::before {
  content: ""; position: absolute; top: -5px; bottom: -5px;
  left: calc((var(--depth, 0) - 1) * 16px + 16px);
  width: 2px; background: var(--pi-hierarchy-border); pointer-events: none;
}
.session-family-frame > .action-row.nested:last-child .action-main::before { bottom: 50%; }
```

**The inner element is load-bearing and was verified empirically.** Attaching the
rail to `.action-row::before` renders it almost invisible: `.action-main` is a
later-painting positioned sibling with an opaque `background: var(--pi-surface)`,
so it covers the rail everywhere except the 8px inter-row gaps. A headless
Chromium probe measured 44 coloured pixels where a working rail needs ~200.
Moving it to the inner element's `::before` paints it above that background and
produced a continuous 199px rail spanning the depth 2/3/4 rows.

The `top`/`bottom` of `-5px` bridges the 4px row margin inside a frame so
consecutive rails join into one line. `bottom: 50%` on the final row stops the
rail at that row's centre instead of dangling past the last child.

## Affected surfaces

Four components render `.session-family-frame`:

| Component | Inner element | Style location |
| --- | --- | --- |
| `SessionList` | `.action-main` | `listStyles` + own block |
| `ProjectList` | `.action-main` | `listStyles` + own block |
| `SessionBrowserDialog` | `.action-main` | `listStyles` + own block |
| `ProjectBrowserDialog` | `.project-main` | own block only |

`SessionList`, `ProjectList`, and `SessionBrowserDialog` all import `listStyles`
from `components/shared.ts`, which already owns `.action-row` and `.action-main`.
The rail rule for `.action-main` therefore lives once in `listStyles` rather than
being copied three times.

`ProjectBrowserDialog` does not import `listStyles` and uses `.project-main`, so it
needs its own copy of the rail rule. This is a pre-existing duplication in that
component, not new duplication introduced here.

## Class assignment

Each component already computes `const cappedDepth = Math.min(row.depth, 2)` and
sets `style="--depth:${cappedDepth}"`. The `nested` class is derived from the same
value at these sites:

- `SessionList.ts:463` / class attribute at `:483`
- `ProjectList.ts:141` / class attribute at `:144`
- `ProjectBrowserDialog.ts:178` / class attribute at `:181`
- `SessionBrowserDialog.ts:108` / class attribute at `:111`

## Accessibility

The rail and frame are decorative grouping cues, redundant with indentation, the
`↳` marker, the disclosure toggle's `aria-expanded`, and the `depth N` badge. No
ARIA changes. Contrast still targets 3:1 so the cue is perceivable rather than
merely decorative. `pointer-events: none` keeps the rail out of hit-testing.

## Testing

Per the testing guide, prefer the narrowest layer that proves the behaviour.

- Token completeness is proven by `npm run typecheck` via `satisfies ThemeTokens`.
- Component tests assert the `nested` class appears on rows at capped depth ≥ 2
  and is absent below that, in each of the four components. This is the
  behavioural contract; the CSS itself is not unit-testable in jsdom, which
  computes no layout.
- Existing hierarchy and reorder suites must keep passing unchanged, which is the
  evidence that no behaviour moved.

No CSS-geometry assertions in jsdom. The rail's visual correctness was established
by the Chromium probe during design and does not need re-proving per commit.

## Risks

| Risk | Mitigation |
| --- | --- |
| A theme misses the token | `satisfies ThemeTokens` fails typecheck |
| Rail invisible behind row surface | Rule targets inner element; verified by probe |
| Rail collides with row content | Sits in the indent gutter left of content |
| Selection cue weakened | Rail stops at the selected row's accent border |
| Reorder behaviour disturbed | No DOM or projection change; reorder suites re-run |
