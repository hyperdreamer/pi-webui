# Collapsed event group bottom-corner leak — Design

- **Status:** Approved (design), pending design review
- **Date:** 2026-09-15
- **Issue:** <https://github.com/hyperdreamer/pi-webui/issues/12>
- **PM run:** `pm-run-20260915-013111-47219abd`
- **Topic slug:** `issue-12-event-group-corner`
- **Delivery target:** `refs/heads/main` @ `c7b7a559f0d07133a53eedd2ea7f2a8da1772cde`

## Background

`ChatView` renders a run of technical chat events as a collapsible `<details>`:

- `src/client/src/components/ChatView.ts:1250` — the `<details class="msg event-group">` element
- `src/client/src/components/ChatView.ts:168-171` — `chatMessageGroupClassName()`, which yields
  `msg event-group` for a non-live group and `msg event-group live` for the live tail. Its argument is the
  **live-tail flag**, not the open state: a live group the user collapses keeps the `live` class *and* has
  no `open` attribute, which is why the fix keys on `:not([open])` and not on the class.

The relevant styles live in `chatStyles` (`src/client/src/components/shared.ts:508`):

```css
/* shared.ts:599 */
.msg { … padding: 12px; border: 1px solid var(--pi-border); border-radius: 10px;
       background: var(--pi-surface); overflow: visible; }

/* shared.ts:607 */
.msg.event-group { padding: 0; border-color: var(--pi-border); background: var(--pi-bg); … }

/* shared.ts:609 */
.msg.event-group > summary { … border-radius: 9px 9px 0 0;
       border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); … }

/* shared.ts:610 */
.msg.event-group.live > summary { border-bottom-color: var(--pi-success-border); … }
```

The container rounds its **bottom** corners at `10px`; the summary declares square bottom corners and a
straight full-width 1px `border-bottom`. When the group is **collapsed** the summary is the only visible
child, so that straight line sits directly on top of the container's rounded bottom border and overhangs
it by roughly the radius at each corner — in a different colour token.

Because `.msg` uses `overflow: visible`, nothing clips the overhang.

### Measured evidence (real `chatStyles`, real theme tokens, DPR 2)

Classic, bottom-left corner, device pixels (crop origin = `details.x - 4`, `details.bottom - 8`):

| device row | painted run |
| --- | --- |
| 11 | `#0d1117 [0-47]` — group interior (`--pi-bg`) |
| 12–13 | `#0d1117 [0-9]` \| **`#21262d [10-47]`** — summary `--pi-border-muted` starts at the inner edge |
| 14 | `#0d1117 [0-18]` \| … \| `#30363d [21-47]` — container `--pi-border` straight run begins ~10px in |
| 16+ | `#0d1117 [0-47]` — below the group |

The muted line begins 1px from the outer edge while the container's border only becomes straight ~10px in,
so ~9 CSS px of the line has no border beneath it. Mirrored on the right corner. Confirmed independently
from the live DOM: summary `border-radius: 9px 9px 0 0` (computed `9px/0px`), container `10px`,
container `overflow: visible`, and `summary.bottom` exactly 1px above `details.bottom` — two stacked 1px lines.

### Why PI WEBUI Dark hides it

| theme | `--pi-border` | `--pi-border-muted` | separate lines visible? |
| --- | --- | --- | --- |
| Classic (`themes/index.ts:9-10`) | `#30363d` | `#21262d` | yes |
| PI WEBUI Light (`:87-88`) | `#c9bca8` | `#d8cdbc` | yes |
| E-Ink Color Paper (`:133-134`) | `#c9bca8` | `#d8cdbc` | yes |
| PI WEBUI Dark (`:48-49`) | `#26304f` | `#26304f` | no — identical colours |

The leak is geometrically present in **all** themes. Verified: in Dark the summary and container border
rows are both `#26304f`.

Dark hides the *colour mismatch* only, not the geometry. Because the two 1px lines stack directly, Dark's
collapsed group renders a **2px**-thick bottom edge — visibly heavier than its 1px top and side borders.
Removing the separator therefore also normalises Dark's bottom edge to 1px; the fix is a visible (if
subtle) improvement in every theme, not only the three with mismatched tokens.

## Goals

1. A collapsed event group shows a closed, rounded bottom border in **every** theme, independent of the
   relationship between `--pi-border` and `--pi-border-muted`.
2. No change to the expanded/open appearance.
3. No change to the sticky `<summary>` behaviour (`position: sticky; top: -26px`).
4. `.msg` keeps `overflow: visible`.

## Non-goals

- Re-tiering or equalising `--pi-border` / `--pi-border-muted`. The intended hierarchy between separators
  and borders stays; the fix must not depend on the two tokens being equal.
- `overflow: hidden` on `.msg` (see Rejected alternatives).
- Sibling surfaces. `.msg-header` (`shared.ts:656`) also uses `9px 9px 0 0` plus a bottom border, but no
  leak occurs because of geometry, not child ordering: `.msg` has `padding: 12px` (`shared.ts:599`) and
  `.msg-header` has `margin-bottom: 8px` (`shared.ts:656`), so its bottom border always sits at least 20px
  above the container's bottom edge. `.part:is(details)` (`shared.ts:693`) uses a border-*top*. Verified by
  inspection: `.msg.event-group > summary` is the only instance of the pattern.

## Selected approach — remove the separator while collapsed

Append one rule to `chatStyles`, immediately after `shared.ts:610` so it sits with the neighbouring
summary rules:

```css
/* A collapsed group has no body, so the summary separator has nothing to
   separate. Dropping it also stops its straight 1px line from overhanging the
   rounded container border at the bottom corners. */
.msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }
```

### Concentric radius

`9px` is the container's **inner** radius, not the outer one: `.msg` is `border-radius: 10px` with a 1px
border, so its inner edge curves at 9px. This is the same value the summary already uses for its top
corners, where the nesting is already correct. Rounding the bottom to 9px makes the bottom corners
concentric with the container exactly as the top corners already are.

### Why `border-bottom: 0` rather than re-colouring the separator

`border-bottom: 0` sets the border **width**, and `shared.ts:609` is the only rule in `chatStyles` that
sets a border width on this element, so no *existing* rule ordering can resurrect the line:

| rule | specificity | touches |
| --- | --- | --- |
| `shared.ts:609` `.msg.event-group > summary` | `0,2,1` | `border-bottom` (width 1px + colour) |
| `shared.ts:610` `.msg.event-group.live > summary` | `0,3,1` | `border-bottom-color` only |
| new `.msg.event-group:not([open]) > summary` | `0,3,1` | `border-bottom` (width 0) |

The new rule outranks `:609` on specificity and ties `:610`, which only ever sets colour — so width 0 wins
in every ordering of the rules that exist today. This matters because the property is only verifiable by
declaration in a jsdom test (see Test strategy): a width-based fix is proved by the test, whereas an
order-dependent colour fix could regress silently. A *future* equal-or-higher-specificity rule could still
re-set the width; only verification step 4's Chromium probe proves the rendered result.

### Live groups

For a collapsed `live` group, `:610`'s `border-bottom-color: var(--pi-success-border)` becomes inert at
width 0. The summary's `--pi-success-bg` background matches `.msg.event-group.live`'s background, so the
rounded corners reveal no artefact. A collapsed live group therefore closes correctly too.

## Rejected alternatives

**A. Height-stable invisible separator** — `border-bottom-color: transparent; border-radius: 9px;`.
Fixes the corner (verified pixel-clean, height unchanged at 38px), but ties `:610` at `0,3,1` and so is
correct only while it stays *after* it. A contract test can assert the declaration but cannot catch a
future reorder that reintroduces the defect. It also exists solely to preserve a single pixel.

**C. The issue's fix 2** — `border-bottom-color: var(--pi-border);`. Removes the colour clash but leaves the
geometry: the line still runs to the inner edge, so the corner reads as a squared-off notch rather than a
rounded corner. This contradicts the issue's own stated expectation that the corners "look closed/rounded",
and it makes every theme look the way Dark already does.

**D. `overflow: hidden` on `.msg.event-group`** — the issue reporter rejected this, and it is confirmed
wrong. It does clip the overhang, but it makes the group the sticky containment scrollport and disables the
sticky header. Measured on a tall **open** live group scrolled 160px, summary top relative to the visible
chat top:

| variant | summary top | meaning |
| --- | --- | --- |
| baseline | `0 px` | pinned — sticky works |
| `overflow: hidden` | `-133 px` | scrolls away with the group — sticky disabled |

## Visual mockup decision

Three variants were rendered from the real `chatStyles` with the real bundled theme tokens at DPR 2 and
magnified 7× nearest-neighbour for side-by-side comparison, together with the measured height and
declaration values reported above. The user was shown the options and **explicitly selected Option B**
(remove the separator while collapsed).

Post-fix visual evidence is produced and archived by verification step 4.

## Behavioural delta

| state | before | after |
| --- | --- | --- |
| collapsed group height | 38px | **37px** |
| collapsed summary height | 36px | **35px** |
| collapsed bottom edge, Classic / Light / E-Ink | 1px `--pi-border-muted` stacking on 1px `--pi-border` | 1px `--pi-border` only |
| collapsed bottom edge, PI WEBUI Dark | 2px `#26304f` (two stacked identical lines) | **1px** `#26304f` |
| expanded / open group | unchanged | unchanged |

The summary's height is `auto`, so its used height already includes the 1px border regardless of
box-sizing; removing that border shortens the collapsed group by 1px. This is the honest geometry — there
is no separator when there is no body — and is imperceptible in a scrolling transcript. It is the only
intended behavioural change.

The bottom edge also changes token: with the separator gone, a collapsed group's bottom border is the
container's `--pi-border` in every theme. In Dark this additionally removes the doubled 2px edge described
above, so the collapsed group's bottom border matches its 1px top and side borders.

## Error handling

Not applicable: static CSS, no runtime paths, no data, no I/O. The one failure mode is the rule being
defeated by a future override. The contract test pins that the declaration is present in `chatStyles` and
that no *existing* rule competes with it; it cannot pin the computed cascade. Verification step 4's
Chromium probe is what proves the rendered result.

## Test strategy

Pure CSS-contract layer, which is the smallest layer that proves this behaviour. jsdom cannot compute
shadow-DOM paint, so a computed-style or rectangle assertion would be vacuous; the repo already treats
style contracts as declaration assertions — `src/client/src/components/shared.test.ts` asserts
`chatStyles.cssText` with exact rule strings for `.msg.skill`.

`ChatView.hostSpeech.test.ts` also carries a file-local `cssDeclarationBlock(cssText, selector)` helper,
but it **must not** be reused here: its `match[1].split(",").map(trim)` folds any preceding comment into
the selector text, and Lit's `cssText` retains comments, so a rule carrying the explanatory comment above
would never be found. This design therefore follows the `shared.test.ts` convention and adds no helper.

Added to `shared.test.ts` as exact-string assertions against `chatStyles.cssText`:

1. the new collapsed rule, pinned exactly: `.msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }`.
   An exact string keeps `border-bottom: 0` and `border-radius: 9px` load-bearing — a substring check for
   `border-radius: 9px` would also be satisfied by the buggy `9px 9px 0 0`, and with `.msg { overflow: visible }`
   a square bottom corner paints over the container's border ring while the test stayed green;
2. the base `.msg.event-group > summary` rule still declares `border-radius: 9px 9px 0 0` and its 1px
   `--pi-border-muted` bottom border, so the **open** separator cannot silently regress;
3. `.msg.event-group.live > summary` still declares its `--pi-border-muted`-replacing
   `border-bottom-color: var(--pi-success-border)`, so the open live separator cannot regress.

The new rule's comment is placed *above* the declaration and the assertions use exact strings, so the
comment cannot break the test lookup.

## Release note

Patch changeset (user-visible fix, ships in `dist`):

> Fix collapsed event groups so their bottom corners close cleanly in every theme instead of letting the
> summary separator leak past the rounded container border.

## Files

| file | change |
| --- | --- |
| `src/client/src/components/shared.ts` | one appended rule in `chatStyles` |
| `src/client/src/components/shared.test.ts` | CSS-contract regression test |
| `.changeset/issue-12-event-group-corner.md` | patch release note |
| `docs/superpowers/specs/2026-09-15-issue-12-event-group-corner-*.md` | design + spec |
| `docs/superpowers/plans/2026-09-15-issue-12-event-group-corner*` | plan, manifest, DOT |

## Verification plan

1. `npm test -- --run src/client/src/components/shared.test.ts`
2. `npm run typecheck`
3. `npx eslint src/client/src/components/shared.ts src/client/src/components/shared.test.ts`
4. Re-run the DPR-2 Chromium probe against the implemented rule: assert the collapsed corner contains no
   `--pi-border-muted` run, and that collapsed height is 37px with `border-radius: 9px` and
   `border-bottom-width: 0px`. Archive the magnified corner captures to `$STATE_ROOT/reports/`.
5. `npm run verify:fast` before the frontier implementation audit.
