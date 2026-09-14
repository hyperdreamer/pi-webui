# Technical Specification: Collapsed Event-Group Bottom Corner

**Date:** 2026-09-15
**Status:** Approved for implementation (approved design; spec drafted in `pm-run-20260915-013111-47219abd`)
**Issue:** <https://github.com/hyperdreamer/pi-webui/issues/12>
**Related design document:** `docs/superpowers/specs/2026-09-15-issue-12-event-group-corner-design.md`
**Target package:** `@hyperdreamer/pi-webui`
**Change class:** user-visible patch (client CSS fix)
**Operation class:** client-only. `src/server/sessiond.ts`, session-runtime ownership, and the session daemon protocol are untouched, so no manual `pi-webui-sessiond.service` restart is required.
**Delivery target:** `refs/heads/main` @ `c7b7a559f0d07133a53eedd2ea7f2a8da1772cde`

---

## 1. Scope

### 1.1 The defect

`ChatView` renders a run of technical chat events as a collapsible `<details>`:

- `src/client/src/components/ChatView.ts:1250` — `<details class=${chatMessageGroupClassName(defaultOpen)} ... ?open=${open} ...>`
- `src/client/src/components/ChatView.ts:169-171` — `chatMessageGroupClassName()`, which yields
  `msg event-group` for a non-live group and `msg event-group live` for the live tail.

The argument of `chatMessageGroupClassName` is the **live-tail flag**, not the open state. The caller passes
`live` (`src/client/src/components/ChatView.ts:712`), and the `open` attribute is controlled separately by
`?open=${open}`. A live group that the user collapses therefore keeps the `live` class **and** has no `open`
attribute. The fix keys on `:not([open])`, never on the class.

The relevant rules in `chatStyles` (`src/client/src/components/shared.ts`):

| line | rule |
| --- | --- |
| 599 | `.msg { max-width: 100%; min-width: 0; box-sizing: border-box; margin: 0 0 14px; padding: 12px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); overflow: visible; }` |
| 607 | `.msg.event-group { padding: 0; border-color: var(--pi-border); background: var(--pi-bg); color: var(--pi-muted); }` |
| 609 | `.msg.event-group > summary { position: sticky; top: -26px; z-index: 5; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 9px 9px 0 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); color: var(--pi-muted); }` |
| 610 | `.msg.event-group.live > summary { border-bottom-color: var(--pi-success-border); background: var(--pi-success-bg); color: var(--pi-success); }` |

The container rounds its **bottom** corners at `10px`; the summary declares square bottom corners
(`border-radius: 9px 9px 0 0`) and a straight full-width 1px `border-bottom`. When the group is **collapsed**
the summary is the only visible child, so that straight line sits directly on top of the container's rounded
bottom border and overhangs it by roughly the radius at each corner — in a different colour token. Because
`.msg` uses `overflow: visible`, nothing clips the overhang.

Measured evidence from the design phase (real `chatStyles`, real theme tokens, DPR 2, Classic, bottom-left
corner, device pixels; crop origin = `details.x - 4`, `details.bottom - 8`):

| device row | painted run |
| --- | --- |
| 11 | `#0d1117 [0-47]` — group interior (`--pi-bg`) |
| 12–13 | `#0d1117 [0-9]` \| **`#21262d [10-47]`** — summary `--pi-border-muted` starts at the inner edge |
| 14 | `#0d1117 [0-18]` \| … \| `#30363d [21-47]` — container `--pi-border` straight run begins ~10px in |
| 16+ | `#0d1117 [0-47]` — below the group |

The muted line begins 1px from the outer edge while the container's border only becomes straight ~10 CSS px
in, so ~9 CSS px of the line has no border beneath it. Mirrored on the right corner. The summary's bottom edge
is exactly 1px above the container's bottom edge (two stacked 1px lines).

Theme tokens (`src/client/src/plugins/themes/index.ts`):

| theme | `--pi-border` | `--pi-border-muted` | geometry present | visible colour mismatch |
| --- | --- | --- | --- | --- |
| PI WEBUI Classic (`classicTokens`, lines 9-10) | `#30363d` | `#21262d` | yes | yes |
| PI WEBUI Light (`piWebUiLightTokens`, lines 87-88) | `#c9bca8` | `#d8cdbc` | yes | yes |
| E-Ink Color Paper (`einkColorPaperTokens`, lines 133-134) | `#c9bca8` | `#d8cdbc` | yes | yes |
| PI WEBUI Dark (`piWebUiDarkTokens`, lines 48-49) | `#26304f` | `#26304f` | yes | no (identical colours) |

PI WEBUI Dark hides only the colour mismatch, not the geometry: its two stacked identical 1px lines render a
doubled **2px** bottom edge, visibly heavier than its 1px top and side borders. The fix therefore also
normalises Dark's collapsed bottom edge to 1px; this is a visible (if subtle) improvement in every theme.

`.msg > .msg-header` (`shared.ts:656`) uses the same `9px 9px 0 0` + bottom-border pattern but does not leak.
The reason is padding/margin geometry, not child ordering: `.msg` has `padding: 12px` (`shared.ts:599`) and
`.msg-header` has `margin-bottom: 8px` (`shared.ts:656`), so its bottom border always sits at least 20 CSS px
above the container's bottom edge. `.part:is(details)` (`shared.ts:693`) uses a border-**top**.
`.msg.event-group > summary` is the only instance of the leaking pattern.

### 1.2 In scope

- Add exactly one CSS rule to `chatStyles` in `src/client/src/components/shared.ts` (section 2).
- Add three CSS-contract assertions to `src/client/src/components/shared.test.ts` (section 3).
- Add the patch changeset `.changeset/issue-12-event-group-corner.md` (section 5).
- Produce the DPR-2 Chromium probe evidence with the harness in Appendix A (section 7, step 4).

### 1.3 Out of scope (explicit non-goals)

- No change to any other rule, selector, declaration, token, theme, or component.
- No re-tiering, equalising, or otherwise changing `--pi-border` / `--pi-border-muted`. The intended
  hierarchy between separators and borders stays; the fix must not depend on the two tokens being equal.
- No `overflow: hidden` on `.msg`. It clips the overhang but makes the group the sticky containment
  scrollport and disables the sticky summary (measured: on a tall open live group scrolled 160px, the summary
  top moves from `0 px` pinned to `-133 px`).
- No colour-only fix (`border-bottom-color: var(--pi-border)`). It removes the colour clash but leaves the
  straight line running to the inner edge, so the corner reads as a squared-off notch, not a closed rounded
  corner.
- No change to the expanded/open appearance, the sticky summary behaviour, `chatMessageGroupClassName`, the
  `live` class, or any rendered markup.
- No README or `docs/` change. This is a client-only CSS patch; the changeset is the user-facing
  communication, and there is no documentation surface to update.
- No dependency, build configuration, server, or session-daemon change.

---

## 2. Exact implementation

### 2.1 File and insertion point

File: `src/client/src/components/shared.ts`.

Insert into the `chatStyles` template (opens at line 508, closes at line 838) immediately after the
`.msg.event-group.live > summary` rule and immediately before the `.msg.event-group > summary .label` rule.
The anchors are textual; line numbers are orientation only (they shift by 4 after the insertion).

Anchor before (line 610), do not modify:

```
  .msg.event-group.live > summary { border-bottom-color: var(--pi-success-border); background: var(--pi-success-bg); color: var(--pi-success); }
```

Anchor after (line 611), do not modify:

```
  .msg.event-group > summary .label { margin: 0; }
```

### 2.2 The literal rule to insert

Insert these four lines between the two anchors, with the two-space block indentation and the five-space
comment continuation indentation used elsewhere in `shared.ts` (see the multi-line comment at
`shared.ts:920-923`):

```css
  /* A collapsed group has no body, so the summary separator has nothing to
     separate. Dropping it also stops its straight 1px line from overhanging the
     rounded container border at the bottom corners. */
  .msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }
```

No other edit is made in this file.

### 2.3 Why this works: the cascade

`border-bottom: 0` sets the border **width**. The complete set of rules that can affect this element's
bottom border:

| rule | selector | specificity | effect on `border-bottom` |
| --- | --- | --- | --- |
| `shared.ts:609` | `.msg.event-group > summary` | `0,2,1` | width `1px` + colour `var(--pi-border-muted)` |
| `shared.ts:610` | `.msg.event-group.live > summary` | `0,3,1` | colour only (`border-bottom-color`) |
| new rule | `.msg.event-group:not([open]) > summary` | `0,3,1` | width `0` (`border-bottom: 0`) |

`:not([open])` contributes the specificity of its argument `[open]` (one class-level component), giving the
new rule `0,3,1`. It outranks line 609 and ties line 610, which only ever sets colour, so width `0` wins in
every relative ordering of the rules that exist today. No other declaration in `chatStyles` sets
`border-bottom` or `border-bottom-width` on this element: `summary { cursor: pointer; color: var(--pi-muted); }`
(`shared.ts:698`) and `.msg.event-group > summary .label { margin: 0; }` (`shared.ts:611`) do not touch a
border. A *future* equal-or-higher-specificity rule could still re-set the width; only the Chromium probe
(verification step 4) proves the rendered result.

### 2.4 Why `border-bottom: 0` and why `border-radius: 9px`

- A colour-only fix would have to tie line 610's specificity and stay after it, so it would be correct only
  while it stayed later in the block; a future reorder would silently reintroduce the defect. A width change
  is provable by declaration from an exact-string contract test (section 3).
- `9px` is the container's **inner** radius, not its outer one: `.msg` is `border-radius: 10px` with a 1px
  border, so its inner edge curves at 9px. This is the same value the summary already uses for its top
  corners, where the nesting is already correct. Rounding the bottom to 9px makes the bottom corners
  concentric with the container exactly as the top corners already are.
- Both declarations are load-bearing. With `.msg { overflow: visible }`, a square bottom corner paints the
  summary's background and separator over the container's rounded border ring once the top border is removed;
  a coloured line alone cannot close the corner.

### 2.5 Live groups

For a collapsed `live` group, line 610's `border-bottom-color: var(--pi-success-border)` becomes inert at
width 0. The summary's `background: var(--pi-success-bg)` (line 610) matches `.msg.event-group.live`'s
background (line 608), so the rounded corners reveal no artefact. A collapsed live group closes correctly
too, and the rule never keys on the `live` class.

---

## 3. Test additions

### 3.1 Convention and location

- File: `src/client/src/components/shared.test.ts`.
- Append at the **end of the file**, after the final line (line 73, the `});` that closes
  `describe("terminal modal header")`).
- No import change: `chatStyles` is already imported at line 2
  (`import { appStyles, chatStyles, promptEditorStyles } from "./shared";`).
- Convention: exact-string `expect(styles).toContain("…")` assertions against `chatStyles.cssText`, copied
  from the existing `describe("chatStyles skill presentation")` block (lines 4-15). Add no helper.
- Before: 5 `describe` blocks, 7 `it` cases. After: 6 `describe` blocks, 10 `it` cases.

### 3.2 Exact code to append

```ts
describe("event group collapsed corner", () => {
  // Comments are stripped before asserting: Lit's `cssText` retains comments, so a
  // commented-out rule would still satisfy a raw `toContain` and these tests would
  // pass while the fix was inert.
  const cssWithoutComments = (): string => chatStyles.cssText.replace(/\/\*[\s\S]*?\*\//g, "");

  // Exact strings, not substrings: `border-radius: 9px` alone is also satisfied by
  // the buggy `9px 9px 0 0`, and with `.msg { overflow: visible }` a square bottom
  // corner paints over the container's rounded border ring.
  it("closes the summary bottom when the group is collapsed, so its separator cannot overhang the rounded container border", () => {
    expect(cssWithoutComments()).toContain(".msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }");
  });

  // Bound to the selector but scoped to the two load-bearing declarations, so an
  // unrelated edit to this rule (top, z-index, gap, padding, background, colour)
  // does not fail a test that is about the bottom separator.
  it("keeps the open separator at the container's inner radius with its muted 1px bottom border", () => {
    expect(cssWithoutComments()).toMatch(/\.msg\.event-group > summary \{[^}]*border-radius: 9px 9px 0 0;[^}]*border-bottom: 1px solid var\(--pi-border-muted\);[^}]*\}/);
  });

  it("keeps the live open separator's success border colour", () => {
    expect(cssWithoutComments()).toContain(".msg.event-group.live > summary { border-bottom-color: var(--pi-success-border); background: var(--pi-success-bg); color: var(--pi-success); }");
  });
});
```

The three asserted strings are the exact rule texts produced by Lit's `cssText` for the rules at
`shared.ts:609`, `shared.ts:610`, and the new rule, without the two-space block indentation (the whitespace
before each rule is not part of the string). The new rule's comment is a separate preceding line, so it does
not break the `toContain` lookup.

### 3.3 Why an exact string, not a substring

A substring assertion such as `toContain("border-radius: 9px")` would also be satisfied by the buggy base
value `border-radius: 9px 9px 0 0`. Because `.msg { overflow: visible }` (`shared.ts:599`), the summary's
square bottom corner and its straight separator would paint over the container's rounded border ring at the
bottom corners while that substring test stayed green. Asserting the complete rule string keeps the selector,
`border-bottom: 0`, `border-radius: 9px`, and the declaration order all load-bearing, so the fix cannot
silently degrade to the exact defect being removed.

Assertions 1 and 3 use whole-rule exact strings, which is safe because those rules are short and every
declaration in them is load-bearing. Assertion 2 covers an 11-declaration rule, so it is instead bound to the
selector and scoped to the two declarations the regression is about; pinning the whole line there would fail
on an unrelated edit to `top: -26px`, `z-index`, `gap`, or `padding` and report it as a separator regression.

Comments are stripped before asserting, because Lit's `cssText` retains them: a rule that is textually
present but wrapped in `/* … */` would satisfy a raw `toContain` while being completely inert.

### 3.4 Do not reuse `cssDeclarationBlock` from `ChatView.hostSpeech.test.ts`

`src/client/src/components/ChatView.hostSpeech.test.ts:74-80` defines a file-local
`cssDeclarationBlock(cssText, selector)`. It **must not** be reused or copied here. Its loop
`cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)` captures everything since the previous `}` into `match[1]`,
including any preceding comment, and then runs `match[1].split(",").map((part) => part.trim())`. Lit's
`cssText` retains comments (verified empirically), and the new rule carries an explanatory comment, so the captured
selector text for that rule begins with the comment and never equals `.msg.event-group:not([open]) > summary`.
The helper returns `undefined` for the commented rule, so any assertion built on it would either throw or
assert nothing. This design therefore uses the existing exact-string convention of `shared.test.ts` and adds
no helper.

---

## 4. Falsifiability (required)

Each assertion must fail for the concrete mutations below. "Revert the rule" means deleting the inserted
rule; "change the radius" means editing the declaration; "drop the base separator" means editing
`shared.ts:609`.

| # | assertion | concrete mutation that must make it fail | how it fails |
| --- | --- | --- | --- |
| 1 | `toContain(".msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }")` | Delete the inserted rule entirely (revert) | string absent |
| 1 | same | Wrap the rule in `/* … */` so it is inert but textually present | string absent (comments are stripped before asserting) |
| 1 | same | Change `border-radius: 9px` to `border-radius: 9px 9px 0 0` (the buggy square bottom) | string absent |
| 1 | same | Change `border-radius: 9px` to `10px` or any other radius | string absent |
| 1 | same | Change `border-bottom: 0` to `border-bottom: 1px solid var(--pi-border-muted)` | string absent |
| 1 | same | Remove `border-bottom: 0; ` while keeping `border-radius: 9px` | string absent |
| 1 | same | Reorder the declarations to `{ border-radius: 9px; border-bottom: 0; }` | string absent (the assertion is deliberately order-sensitive) |
| 1 | same | Change the selector to `.msg.event-group > summary` (drop `:not([open])`) | string absent |
| 1 | same | Alter whitespace inside the braces (extra space, newline, or removed separation) | string absent |
| 2 | `toMatch(/\.msg\.event-group > summary \{[^}]*border-radius: 9px 9px 0 0;[^}]*border-bottom: 1px solid var\(--pi-border-muted\);[^}]*\}/)` | Change `9px 9px 0 0` to `9px` | no match |
| 2 | same | Drop `border-bottom: 1px solid var(--pi-border-muted);` (drop the base separator) | no match |
| 2 | same | Change the colour token to `var(--pi-border)` or any other token | no match |
| 2 | same | Delete the whole base rule | no match |
| 2 | same | Wrap the base rule in `/* … */` | no match (comments are stripped before asserting) |
| 2 | same | **Not** a failure by design: change an unrelated declaration (`top`, `z-index`, `gap`, `padding`, `background`, `color`) | still matches, so an unrelated edit does not fail a separator-regression test |
| 3 | `toContain(".msg.event-group.live > summary { border-bottom-color: var(--pi-success-border); background: var(--pi-success-bg); color: var(--pi-success); }")` | Change `border-bottom-color: var(--pi-success-border)` to `var(--pi-border-muted)` or any other token | string absent |
| 3 | same | Remove the `border-bottom-color` declaration or delete the whole live rule | string absent |

What these assertions cannot catch: a different rule elsewhere in the cascade (for example a future
equal-or-higher-specificity rule that re-sets `border-bottom-width`), and any computed or painted value.
`chatStyles.cssText` is declaration text in jsdom, not the computed cascade or shadow-DOM paint. Verification
step 4's Chromium probe is the check that catches those.

---

## 5. Changeset

Create `.changeset/issue-12-event-group-corner.md` with exactly this content (one paragraph, trailing
newline):

```
---
"@hyperdreamer/pi-webui": patch
---

Fix collapsed event groups so their bottom corners close cleanly in every theme instead of letting the summary separator leak past the rounded container border.
```

The bump type is `patch`: this is a user-visible bug fix that ships in `dist`, with no new API, option, or
behaviour beyond the fix. It matches the existing changeset convention in `.changeset/` (for example the
patch front matter used by prior releases).

---

## 6. Behaviour contract

| state | before this change | after this change |
| --- | --- | --- |
| collapsed group height | 38px: 36px summary + the container's 1px top border + 1px bottom border | **37px**: 35px summary + the same 2px of container border |
| collapsed summary height | 36px: 35px content/padding + 1px `border-bottom` | **35px**: the border is gone |
| collapsed bottom edge, PI WEBUI Classic | 1px `#21262d` (`--pi-border-muted`) sitting directly on top of 1px `#30363d` (`--pi-border`), muted line straight and overhanging the rounded corner by ~9 CSS px | a single 1px `#30363d` (`--pi-border`) line that follows the 10px outer / 9px inner rounded corner; no `--pi-border-muted` pixel at the corner |
| collapsed bottom edge, PI WEBUI Light | 1px `#d8cdbc` (`--pi-border-muted`) over 1px `#c9bca8` (`--pi-border`), same overhang | a single 1px `#c9bca8` (`--pi-border`) line, rounded corner closed |
| collapsed bottom edge, E-Ink Color Paper | same as PI WEBUI Light (identical token values) | same as PI WEBUI Light |
| collapsed bottom edge, PI WEBUI Dark | two stacked 1px `#26304f` lines (muted + container; identical colours) = a doubled **2 CSS px** bottom edge | **1 CSS px** of `#26304f`, matching the 1px top and side borders |
| expanded / open group | summary with 9px rounded top corners, square bottom corners, and a full-width 1px `--pi-border-muted` bottom separator (or `--pi-success-border` for a live group) | unchanged; the new rule does not match an open `<details>` |
| collapsed live group | `live` class retained, no `open` attribute; muted/success separator followed the same square geometry | closes with the rounded corner; `--pi-success-border` is inert at width 0, and the summary's `--pi-success-bg` matches the group background, so no artefact |
| sticky summary | `.msg.event-group > summary` is `position: sticky; top: -26px; z-index: 5`; `.msg` is `overflow: visible`, so the group is not the sticky containment scrollport | unchanged |

The collapsed-height reduction is 1px because the summary has no explicit `height` (height is `auto`), so its
used height already includes its border; removing the 1px bottom border removes 1px from the summary and
therefore from the group. It is not a content-box versus border-box effect. Both the container
(`box-sizing: border-box` from `.msg`, line 599) and the summary size with height `auto`.

---

## 7. Verification commands

Run these in order. All commands run from the repository root. Record the exact output.

### Step 1 — focused contract test

```
npm test -- --run src/client/src/components/shared.test.ts
```

Expected: 1 test file passed, **10 tests passed, 0 failed**, including the three assertions in
`describe("event group collapsed corner")`.

If the tests are written before the production rule (red phase), this command must fail on assertion 1
(`.msg.event-group:not([open]) > summary …` absent) while assertions 2 and 3 pass. Record that red output,
then insert the rule from section 2.2 and re-run to green.

### Step 2 — typecheck

```
npm run typecheck
```

Expected: exit code 0, no diagnostics. The change adds CSS text and test assertions only; no type surface
changes.

### Step 3 — targeted lint

```
npx eslint src/client/src/components/shared.ts src/client/src/components/shared.test.ts
```

Expected: exit code 0, no errors or warnings.

### Step 4 — DPR-2 Chromium probe

Create the probe script at `$STATE_ROOT/reports/probe-event-group-corner.mjs` with the exact content in
Appendix A, then run:

```
STATE_ROOT=/data/home/henry-arch/.local/state/pi/project-manager/runs/4074842dc9aaf003446194e3e1d1201d34aca2f4bd236012ec3be919dd6e7164/pm-run-20260915-013111-47219abd
node "$STATE_ROOT/reports/probe-event-group-corner.mjs" "$PWD" "$STATE_ROOT/reports"
```

Expected: exit code 0 and a final line `PASS: collapsed event-group bottom corner probe`. The script prints,
per theme and variant, the measured group/summary heights, `border-bottom-width`, radii, and the device-row
colour sequence at a column 32 CSS px inside the group's left edge.

Run this step only AFTER the rule from section 2.2 is inserted. Against the un-fixed tree the harness
deliberately hard-fails with `the new collapsed rule is not present in chatStyles` and exit code 1; that is
the guard working, not a probe defect. The pre-fix rendering is produced internally by the harness's own
`control` variant, which strips the rule from an in-memory copy of the stylesheet text.

The harness launches `process.env.CHROME_BIN ?? "chromium"`. Set `CHROME_BIN` when the binary is not named
`chromium` on the host (for example `CHROME_BIN=$(command -v google-chrome-stable)`); the repository's own
`scripts/capture-screenshots.mjs` searches `chromium-browser`, `chromium`, `google-chrome`, and
`google-chrome-stable` in that order.

Required observations:

- **Classic fixed**: zero `#21262d` (`--pi-border-muted`) device rows at the bottom-edge column and zero
  `#21262d` pixels anywhere in the corner crop; exactly 2 device rows (1 CSS px at DPR 2) of `#30363d`
  (`--pi-border`). Reference-host column printout (24 device rows, top to bottom):
  `#0d1117 ×14, #30363d ×2, #101010 ×8`.
- **Classic control** (the new rule removed, reproducing the pre-fix state): exactly 2 device rows of
  `#21262d` immediately above the 2 `#30363d` container rows, and `#21262d` present in the corner crop.
  Reference-host column printout: `#0d1117 ×12, #21262d ×2, #30363d ×2, #101010 ×8`. This control is what
  makes the pixel assertion falsifiable: if the control does not reproduce the muted run, the probe reports a
  failure rather than a vacuous pass. On a host whose UI-font metrics shift the summary height by a fraction,
  the interior run length shifts equally for the fixed and control variants; the binding assertions are the
  muted-row counts, the control-normalisation equality, the summary-bottom gap of 1px, and the 1px height
  delta.
- **Dark fixed**: exactly 2 device rows of `#26304f`; **Dark control**: 4 device rows (2 CSS px), i.e. the
  control is exactly 2 device rows thicker than the fixed rendering.
- **Fixed computed styles**: `border-bottom-width: 0px`, `border-bottom-left-radius: 9px`,
  `border-bottom-right-radius: 9px`, `border-top-left-radius: 9px`, container `border-radius: 10px`,
  container `overflow: visible`, summary `position: sticky` with `top: -26px`, and the summary's bottom edge
  exactly 1px above the container's bottom edge (the container's own bottom border) in both variants.
- **Height delta**: the control group and summary heights are each exactly 1 CSS px larger than the fixed
  heights (binding invariant). Expected printout on this reference host: control 38px group / 36px summary,
  fixed 37px group / 35px summary. The absolute values depend on the host's `system-ui` font metrics at 14px;
  the 1px delta, the computed styles, and the pixel patterns are the portable assertions, and the script
  prints the absolute values for the record.
- **Archived captures**: four magnified (7×, nearest-neighbour) corner PNGs written to
  `$STATE_ROOT/reports/`: `event-group-corner-classic-fixed.png`, `event-group-corner-classic-control.png`,
  `event-group-corner-dark-fixed.png`, `event-group-corner-dark-control.png`.

### Step 5 — broad verification

```
npm run verify:fast
```

Expected: exit code 0. This runs `typecheck`, repo-wide `lint`, `knip`, and the fast Vitest suite; all pass.
Then the frontier implementation audit runs against the committed change.

---

## 8. Error handling

There is **no runtime error path**. This change adds one static CSS rule. It executes no JavaScript, reads
no data, performs no I/O, opens no network or process boundary, and adds no API, option, or persisted state.
There is nothing to validate, catch, retry, time out, or roll back, and there is no user-facing error state.

The only failure mode is the fix not taking effect at paint time:

1. the rule is absent, altered, or removed from `chatStyles`; or
2. a different rule re-sets `border-bottom-width` on the collapsed summary at equal or higher specificity in
   a later cascade position.

Which check catches it:

- Case 1 is caught by the contract assertions in `src/client/src/components/shared.test.ts` (verification
  step 1), which strip CSS comments before asserting, so a removed, altered, or comment-wrapped rule fails.
  The test pins a declaration in `chatStyles`, not the computed cascade.
- Case 2, and any other computed or painted discrepancy, is caught only by the DPR-2 Chromium probe
  (verification step 4), which asserts the computed `border-bottom-width: 0px`, the 9px bottom radii, and the
  absence of a `--pi-border-muted` run in the rendered corner, with the pre-fix control proving the pixel
  assertion is falsifiable.

---

## 9. Open questions

None.

---

## Appendix A — DPR-2 Chromium probe harness (temporary, outside the repository)

Write the file below to `$STATE_ROOT/reports/probe-event-group-corner.mjs`. It reads the real `chatStyles`
text out of `src/client/src/components/shared.ts`, renders the classic and PI WEBUI Dark token sets in a
standalone document, captures the viewport at DPR 2, and inspects both computed style and device pixels.
The `control` variant re-runs the same fixture with the new rule removed, so the muted-separator assertion is
shown to be falsifiable. Nothing is written into the repository; the fixture HTML and Chromium profile live
in an OS temp directory that the script removes after Chromium has fully exited. Teardown signals the child's
whole **process group** (`spawn(..., { detached: true })` plus `process.kill(-pid, …)`), so a `CHROME_BIN`
wrapper that backgrounds Chromium instead of exec'ing it is cleaned up too, and the removal retries to absorb
any final profile write. Only the magnified captures are archived.

```js
// Temporary DPR-2 Chromium probe for the collapsed event-group bottom corner.
// Not part of the repository. Usage:
//   node probe-event-group-corner.mjs <repo-root> <archive-dir>
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.argv[2];
const ARCHIVE = process.argv[3];
if (!REPO || !ARCHIVE) {
  console.error("usage: node probe-event-group-corner.mjs <repo-root> <archive-dir>");
  process.exit(2);
}

const CHROME = process.env.CHROME_BIN ?? "chromium";
const RULE = ".msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }";
const MUTED = { classic: "#21262d", dark: "#26304f" };

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const count = (column, colour) => column.filter((entry) => entry === colour).length;

class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const cdp = new CDP(ws);
      ws.addEventListener("open", () => resolve(cdp), { once: true });
      ws.addEventListener("error", (event) => reject(event.error ?? new Error("CDP websocket error")), { once: true });
    });
  }
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP websocket closed"));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = (params) => {
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((candidate) => candidate !== listener));
      };
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    });
  }
  close() {
    this.ws.close();
  }
  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) reject(new Error("Unable to allocate a port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function openPage(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Unable to create Chromium tab: ${response.status} ${response.statusText}`);
  const info = await response.json();
  return CDP.connect(info.webSocketDebuggerUrl);
}

async function evaluate(page, expression) {
  const response = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails !== undefined) throw new Error(`Browser evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
  return response.result?.value;
}

function fixture(cssText) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; background: #101010; }
#classic { --pi-bg: #0d1117; --pi-border: #30363d; --pi-border-muted: #21262d; --pi-muted: #8b949e; --pi-surface: #161b22; --pi-text: #e6edf3; }
#dark { --pi-bg: #070912; --pi-border: #26304f; --pi-border-muted: #26304f; --pi-muted: #aaa4bd; --pi-surface: #101527; --pi-text: #f7f4ff; }
.probe-root { font: 14px system-ui, sans-serif; padding: 24px; }
</style>
<style>${cssText}</style>
</head>
<body>
<div id="classic" class="probe-root">
  <details class="msg event-group"><summary><b class="label">events</b><span>3 events</span></summary></details>
</div>
<div id="dark" class="probe-root">
  <details class="msg event-group"><summary><b class="label">events</b><span>3 events</span></summary></details>
</div>
</body>
</html>
`;
}

async function measure(page, themeId) {
  const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const expression = `(async () => {
    const img = new Image();
    img.src = ${JSON.stringify("data:image/png;base64," + shot.data)};
    await img.decode();
    const dpr = img.naturalWidth / window.innerWidth;
    const root = document.getElementById(${JSON.stringify(themeId)});
    const group = root.querySelector("details.msg.event-group");
    const summary = group.querySelector("summary");
    const groupRect = group.getBoundingClientRect();
    const summaryRect = summary.getBoundingClientRect();
    const groupStyle = getComputedStyle(group);
    const summaryStyle = getComputedStyle(summary);
    const originX = Math.round((groupRect.left - 4) * dpr);
    const originY = Math.round((groupRect.bottom - 8) * dpr);
    const width = Math.round(40 * dpr);
    const height = Math.round(12 * dpr);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(img, originX, originY, width, height, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const hexAt = (x, y) => {
      const index = (y * width + x) * 4;
      return "#" + [pixels[index], pixels[index + 1], pixels[index + 2]].map((value) => value.toString(16).padStart(2, "0")).join("");
    };
    const rows = [];
    for (let y = 0; y < height; y += 1) {
      const runs = [];
      let start = 0;
      let previous = hexAt(0, y);
      for (let x = 1; x < width; x += 1) {
        const current = hexAt(x, y);
        if (current !== previous) {
          runs.push(previous + "[" + start + "-" + (x - 1) + "]");
          start = x;
          previous = current;
        }
      }
      runs.push(previous + "[" + start + "-" + (width - 1) + "]");
      rows.push(runs.join(" | "));
    }
    const column = [];
    const columnX = Math.round(36 * dpr);
    for (let y = 0; y < height; y += 1) column.push(hexAt(columnX, y));
    const zoom = document.createElement("canvas");
    zoom.width = width * 7;
    zoom.height = height * 7;
    const zoomContext = zoom.getContext("2d");
    zoomContext.imageSmoothingEnabled = false;
    zoomContext.drawImage(canvas, 0, 0, width, height, 0, 0, zoom.width, zoom.height);
    return {
      dpr,
      groupHeight: groupRect.height,
      summaryHeight: summaryRect.height,
      summaryBottomGap: groupRect.bottom - summaryRect.bottom,
      borderBottomWidth: summaryStyle.borderBottomWidth,
      borderBottomLeftRadius: summaryStyle.borderBottomLeftRadius,
      borderBottomRightRadius: summaryStyle.borderBottomRightRadius,
      borderTopLeftRadius: summaryStyle.borderTopLeftRadius,
      containerRadius: groupStyle.borderRadius,
      containerOverflow: groupStyle.overflow,
      summaryPosition: summaryStyle.position,
      summaryTop: summaryStyle.top,
      rows,
      column,
      zoomPng: zoom.toDataURL("image/png"),
    };
  })()`;
  return evaluate(page, expression);
}

const source = await readFile(join(REPO, "src/client/src/components/shared.ts"), "utf8");
const chatStylesText = /export const chatStyles = css`([\s\S]*?)\n`;/.exec(source)?.[1];
if (chatStylesText === undefined) throw new Error("chatStyles block not found in shared.ts");
if (!chatStylesText.includes(RULE)) throw new Error("the new collapsed rule is not present in chatStyles");
const controlCssText = chatStylesText.replace(RULE, "");

const tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-event-group-corner-"));
const debugPort = await getFreePort();
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${join(tempRoot, "chrome-profile")}`,
    "--window-size=900,400",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    "about:blank",
  ],
  // `detached: true` makes the child a process-group leader so the whole group can be
  // signalled in the `finally` block. A `CHROME_BIN` wrapper that backgrounds Chromium
  // instead of exec'ing it would otherwise survive a plain `chrome.kill(pid)`, orphaning
  // the browser long enough for it to recreate the profile directory after removal.
  { stdio: "ignore", detached: true },
);

let page;
try {
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 15_000);
  page = await openPage(debugPort);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 320, deviceScaleFactor: 2, mobile: false });

  const results = {};
  for (const themeId of ["classic", "dark"]) {
    results[themeId] = {};
    for (const [variant, cssText] of [["fixed", chatStylesText], ["control", controlCssText]]) {
      const file = join(tempRoot, `probe-${themeId}-${variant}.html`);
      await writeFile(file, fixture(cssText));
      const loaded = page.waitForEvent("Page.loadEventFired", 10_000).catch(() => undefined);
      await page.send("Page.navigate", { url: `file://${file}` });
      await loaded;
      await evaluate(page, "document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true");
      await sleep(200);
      results[themeId][variant] = await measure(page, themeId);
    }
  }

  await mkdir(ARCHIVE, { recursive: true });
  for (const themeId of ["classic", "dark"]) {
    for (const variant of ["fixed", "control"]) {
      const base64 = results[themeId][variant].zoomPng.split(",")[1];
      await writeFile(join(ARCHIVE, `event-group-corner-${themeId}-${variant}.png`), Buffer.from(base64, "base64"));
    }
  }

  const { classic, dark } = results;
  for (const [label, measured] of [
    ["classic fixed", classic.fixed],
    ["classic control", classic.control],
    ["dark fixed", dark.fixed],
    ["dark control", dark.control],
  ]) {
    console.log(`${label}: group=${measured.groupHeight}px summary=${measured.summaryHeight}px summaryBottomGap=${measured.summaryBottomGap}px border-bottom-width=${measured.borderBottomWidth} radii=${measured.borderTopLeftRadius}/${measured.borderBottomLeftRadius}/${measured.borderBottomRightRadius} dpr=${measured.dpr}`);
    console.log(`${label} column: ${measured.column.map((colour, index) => `${index}:${colour}`).join(" ")}`);
  }

  check(Math.abs(classic.control.groupHeight - classic.fixed.groupHeight - 1) < 0.01, `classic: collapsed group height delta ${classic.control.groupHeight - classic.fixed.groupHeight} is not 1px`);
  check(Math.abs(classic.control.summaryHeight - classic.fixed.summaryHeight - 1) < 0.01, `classic: collapsed summary height delta ${classic.control.summaryHeight - classic.fixed.summaryHeight} is not 1px`);
  check(Math.abs(dark.control.groupHeight - dark.fixed.groupHeight - 1) < 0.01, `dark: collapsed group height delta ${dark.control.groupHeight - dark.fixed.groupHeight} is not 1px`);

  check(classic.fixed.borderBottomWidth === "0px", `classic fixed: border-bottom-width is ${classic.fixed.borderBottomWidth}, expected 0px`);
  check(classic.fixed.borderBottomLeftRadius === "9px", `classic fixed: border-bottom-left-radius is ${classic.fixed.borderBottomLeftRadius}, expected 9px`);
  check(classic.fixed.borderBottomRightRadius === "9px", `classic fixed: border-bottom-right-radius is ${classic.fixed.borderBottomRightRadius}, expected 9px`);
  check(classic.fixed.borderTopLeftRadius === "9px", `classic fixed: border-top-left-radius is ${classic.fixed.borderTopLeftRadius}, expected 9px`);
  check(classic.fixed.containerRadius === "10px", `classic fixed: container border-radius is ${classic.fixed.containerRadius}, expected 10px`);
  check(classic.fixed.containerOverflow === "visible", `classic fixed: container overflow is ${classic.fixed.containerOverflow}, expected visible`);
  check(classic.fixed.summaryPosition === "sticky", `classic fixed: summary position is ${classic.fixed.summaryPosition}, expected sticky`);
  check(classic.fixed.summaryTop === "-26px", `classic fixed: summary top is ${classic.fixed.summaryTop}, expected -26px`);
  check(Math.abs(classic.fixed.summaryBottomGap - 1) < 0.01, `classic fixed: the summary bottom sits ${classic.fixed.summaryBottomGap}px above the container bottom, expected 1px`);
  check(Math.abs(classic.control.summaryBottomGap - 1) < 0.01, `classic control: the summary bottom sits ${classic.control.summaryBottomGap}px above the container bottom, expected 1px`);

  check(count(classic.fixed.column, MUTED.classic) === 0, `classic fixed: found ${count(classic.fixed.column, MUTED.classic)} --pi-border-muted device rows at the collapsed bottom edge, expected 0`);
  check(count(classic.control.column, MUTED.classic) === 2, `classic control: found ${count(classic.control.column, MUTED.classic)} --pi-border-muted device rows, expected 2`);
  const normalizedControl = classic.control.column.map((colour) => (colour === MUTED.classic ? "#0d1117" : colour));
  check(JSON.stringify(normalizedControl) === JSON.stringify(classic.fixed.column), "classic: the control column differs from the fixed column by more than the removed muted separator");
  check(!classic.fixed.rows.join(" | ").includes(MUTED.classic), "classic fixed: a --pi-border-muted pixel is present in the collapsed corner crop");
  check(classic.control.rows.join(" | ").includes(MUTED.classic), "classic control: the pre-fix muted separator did not reproduce, so the control does not exercise the defect");

  check(count(dark.fixed.column, MUTED.dark) === 2, `dark fixed: found ${count(dark.fixed.column, MUTED.dark)} #26304f device rows, expected 2 (1 CSS px)`);
  check(count(dark.control.column, MUTED.dark) - count(dark.fixed.column, MUTED.dark) === 2, `dark: the control bottom edge is not exactly 1 CSS px thicker than the fixed one (${count(dark.control.column, MUTED.dark)} vs ${count(dark.fixed.column, MUTED.dark)} device rows)`);

  console.log(failures.length === 0 ? "PASS: collapsed event-group bottom corner probe" : `FAIL: ${failures.length} check(s)`);
  for (const failure of failures) console.error(`- ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  page?.close();
  const signalGroup = (signal) => {
    try {
      process.kill(-chrome.pid, signal);
    } catch {
      chrome.kill(signal);
    }
  };
  signalGroup("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    chrome.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  // Escalate to the whole group, then let the retrying removal absorb any last write.
  signalGroup("SIGKILL");
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
```
