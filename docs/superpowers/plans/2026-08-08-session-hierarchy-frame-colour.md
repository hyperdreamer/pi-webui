# Session Hierarchy Frame Colour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the danger-red session/project family frame border with a neutral
`--pi-hierarchy-border` token, and add a level-2 guide rail for sub-sessions and
their children.

**Architecture:** One new theme token defined in five places, then per-component
CSS and a `nested` class derived from the `cappedDepth` value each component
already computes. The rail is a `::before` on each row's inner surface element, so
no DOM structure, projection, ordering, folding, or reorder logic changes.

**Tech Stack:** TypeScript, Lit 3 (`css`/`html` tagged templates, shadow DOM),
Vitest with jsdom.

## Global Constraints

- Do not add runtime dependencies.
- Do not change `groupRows`, row projections, ordering, folding, or reorder
  behaviour in any component. This work is presentation-only.
- Do not change the depth cap. `const cappedDepth = Math.min(row.depth, 2)` stays
  exactly as it is in every component.
- The new token's exact name is `--pi-hierarchy-border`.
- Exact token values, which are contrast-verified and must not be substituted:
  PI WEBUI Classic `#5c6b80`, PI WEBUI Dark `#5a6aa8`, PI WEBUI Light `#8a7b64`,
  E-Ink Color Paper `#6f6047`, and `src/client/index.html` `#5c6b80`.
- The rail rule must target the row's inner surface element (`.action-main` or
  `.project-main`), never `.action-row::before`. On `.action-row` the rail is
  painted over by the inner element's opaque background and is invisible.
- Run `npm test -- --run <file>` for a single file. Never run the full suite
  concurrently with other heavy jobs; it is timing sensitive.
- Commit with Conventional Commit style.

## Task 1: Add the `--pi-hierarchy-border` theme token

**Implementer tier:** Fast

**Files:**

- Modify: `src/client/src/plugins/types.ts:278-313`
- Modify: `src/client/src/theme.ts:28-63`
- Modify: `src/client/src/plugins/themes/index.ts`
- Modify: `src/client/index.html:12-51`
- Modify: `src/client/src/theme.test.ts:5-41`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: the CSS custom property name `--pi-hierarchy-border`, available as a
  member of the `ThemeToken` union, present in the `THEME_TOKENS` array, and
  defined by all four theme token objects plus the bootstrap `:root` block.

Because `ThemeTokens = Record<ThemeToken, string>` and every theme object ends in
`satisfies ThemeTokens`, adding the union member makes `npm run typecheck` fail
until all four theme objects and the `theme.test.ts` fixture define it. That
failing typecheck is this task's red phase.

- [ ] **Step 1: Add the union member**

In `src/client/src/plugins/types.ts`, in the `ThemeToken` union, add the new member
on the line immediately after `| "--pi-border-muted"`:

```ts
  | "--pi-hierarchy-border"
```

- [ ] **Step 2: Confirm typecheck now fails**

Run: `npm run typecheck`

Expected: FAIL. Errors report that the four objects in
`src/client/src/plugins/themes/index.ts` and the `tokens` fixture in
`src/client/src/theme.test.ts` do not satisfy `ThemeTokens`, naming
`--pi-hierarchy-border` as the missing property.

- [ ] **Step 3: Add the token to the THEME_TOKENS array**

In `src/client/src/theme.ts`, in the `THEME_TOKENS` array, add this line
immediately after `"--pi-border-muted",`:

```ts
  "--pi-hierarchy-border",
```

- [ ] **Step 4: Add the token to all four theme objects**

In `src/client/src/plugins/themes/index.ts`, add one line to each of the four
objects, immediately after that object's own `"--pi-border-muted"` line. The value
differs per object and must be exactly as given.

In `classicTokens`:

```ts
  "--pi-hierarchy-border": "#5c6b80",
```

In `piWebUiDarkTokens`:

```ts
  "--pi-hierarchy-border": "#5a6aa8",
```

In `piWebUiLightTokens`:

```ts
  "--pi-hierarchy-border": "#8a7b64",
```

In `einkColorPaperTokens`:

```ts
  "--pi-hierarchy-border": "#6f6047",
```

- [ ] **Step 5: Add the token to the test fixture**

In `src/client/src/theme.test.ts`, in the `tokens` fixture, add this line
immediately after the `"--pi-border-muted": "#000000",` line. The fixture uses
`#000000` for every token by design; do not use a real colour here:

```ts
  "--pi-hierarchy-border": "#000000",
```

- [ ] **Step 6: Add the token to the pre-JavaScript bootstrap block**

In `src/client/index.html`, inside the `:root` block in the inline `<style>`, add
this line immediately after the `--pi-border-muted: #21262d;` line. That block
mirrors the Classic theme, so it takes the Classic value:

```css
        --pi-hierarchy-border: #5c6b80;
```

- [ ] **Step 7: Confirm typecheck passes**

Run: `npm run typecheck`

Expected: PASS, exit 0, no output beyond the npm banner.

- [ ] **Step 8: Confirm the theme tests still pass**

Run: `npm test -- --run src/client/src/theme.test.ts`

Expected: PASS. All tests in the file pass.

- [ ] **Step 9: Commit**

```bash
git add src/client/src/plugins/types.ts src/client/src/theme.ts src/client/src/plugins/themes/index.ts src/client/src/theme.test.ts src/client/index.html
git commit -m "feat: add --pi-hierarchy-border theme token"
```

## Task 2: Shared rail rule and SessionList frame colour

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/shared.ts:430-502`
- Modify: `src/client/src/components/SessionList.ts:463`
- Modify: `src/client/src/components/SessionList.ts:483`
- Modify: `src/client/src/components/SessionList.ts:1112`
- Modify: `src/client/src/components/SessionList.crossWorkspace.test.ts:12-18`

**Interfaces:**

- Consumes: the CSS custom property `--pi-hierarchy-border` from Task 1, defined by
  every theme and by the bootstrap `:root` block.
- Produces: the `nested` CSS class contract, applied to a `.action-row` when that
  row's `cappedDepth` is `>= 2`, plus the shared rail rule in `listStyles` that
  `ProjectList` and `SessionBrowserDialog` rely on in Task 3.

`listStyles` is exported from `src/client/src/components/shared.ts` and already owns
`.action-row` and `.action-main`. The rail rule for `.action-main` therefore lives
there once, rather than being copied into three components. `listStyles` does not
define `.session-family-frame`; each component defines its own. A descendant
selector still matches across separate `css` blocks because Lit applies all of a
component's style sheets to the same shadow root.

A comment at `ProjectList.ts:310` says the family-frame rules are kept local
"because listStyles is shared more widely". Placing the rail in `listStyles` does
not contradict that. The rail only paints on a row carrying the `nested` class,
which is emitted by exactly the four components in this plan, so a wider consumer
of `listStyles` inherits an inert rule and no visual change. Keep the frame rules
local as they are; do not move them into `listStyles`, and do not copy the rail
rule into the three components that already inherit it.

- [ ] **Step 1: Update the existing style assertion to the new expectation**

`SessionList.crossWorkspace.test.ts` currently pins the danger border, so it is the
failing test for this task. Replace the whole `it("styles parent families with a
solid red rectangular frame", ...)` block, lines 12 to 18, with this:

```ts
  it("styles parent families with a solid neutral rectangular frame", () => {
    const styles = sessionListStyles();

    expect(styles).toMatch(/\.session-family-frame\s*\{[^}]*border:\s*1px solid var\(--pi-hierarchy-border\);/);
    expect(styles).not.toContain(".session-family-frame::before");
    expect(styles).toMatch(/\.session-family-frame\s*\{[^}]*border-radius:\s*10px;/);
  });

  it("draws the nested guide rail on the row surface, not the row box", () => {
    const styles = sessionListStyles();

    expect(styles).toMatch(/\.action-row\.nested \.action-main::before\s*\{[^}]*background:\s*var\(--pi-hierarchy-border\);/);
    expect(styles).not.toContain(".action-row.nested::before");
  });

  it("marks a row at the capped depth as nested", () => {
    const parent = session("parent", "/workspace");
    const child = session("child", "/workspace", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", "/workspace", { parentSessionPath: child.path });
    const list = new SessionList();
    list.sessions = [parent, child, grandchild];
    const rows = sessionRowsForCurrentTree([parent, child, grandchild], { currentWorkspacePath: "/workspace" });
    const grandchildRow = rows.find((row) => row.session.id === "grandchild");
    if (grandchildRow === undefined) throw new Error("grandchild row missing");
    const parentRow = rows.find((row) => row.session.id === "parent");
    if (parentRow === undefined) throw new Error("parent row missing");

    expect(renderedRowClasses(list, grandchildRow)).toContain("nested");
    expect(renderedRowClasses(list, parentRow)).not.toContain("nested");
  });
```

- [ ] **Step 2: Add the row-class helper to that test file**

Append this helper beside the existing `sessionListStyles` helper near the bottom of
`SessionList.crossWorkspace.test.ts`. `renderSession` takes eight arguments; the
trailing ones are the defaults used for a plain non-reorder render.

```ts
/**
 * Session rows render inside a map over row groups, so templateText cannot reach
 * a single row through render(). This uses the component's own per-row seam,
 * matching the pattern already used by this component's other row tests.
 */
function renderedRowClasses(list: SessionList, row: unknown): string {
  const method: unknown = Reflect.get(list, "renderSession");
  if (typeof method !== "function") throw new Error("SessionList.renderSession is not callable");
  const rendered: unknown = Reflect.apply(method, list, [row, 0, "current", [], [], [], false, false]);
  if (!isTemplateResult(rendered)) throw new Error("SessionList.renderSession did not return a template");
  return templateText(rendered);
}
```

Add `isTemplateResult` to the existing import from `../templateInspection.testSupport`
so that line reads:

```ts
import { findOptionalTemplateEventHandlerAfterMarker, isTemplateResult, templateText } from "../templateInspection.testSupport";
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/SessionList.crossWorkspace.test.ts`

Expected: FAIL. The neutral-frame test fails because the border is still
`var(--pi-danger)`, the rail test fails because no `.nested` rule exists, and the
nested-class test fails because no row carries the class.

- [ ] **Step 4: Add the shared rail rule to listStyles**

In `src/client/src/components/shared.ts`, inside the `listStyles` template, add
these three lines immediately after the existing `.action-main { ... }` line:

```css
  .action-row.nested .action-main::before { content: ""; position: absolute; top: -5px; bottom: -5px; left: calc((var(--depth, 0) - 1) * 16px + 16px); width: 2px; background: var(--pi-hierarchy-border); pointer-events: none; }
  .session-family-frame > .action-row.nested:last-child .action-main::before { bottom: 50%; }
```

The rail sits on `.action-main::before` because `.action-main` is a later-painting
positioned sibling with an opaque background; a rail on `.action-row::before` is
covered by it and is invisible except in the inter-row gaps.

- [ ] **Step 5: Change the SessionList frame border to the new token**

In `src/client/src/components/SessionList.ts` line 1112, in the
`.session-family-frame` rule, change `border: 1px solid var(--pi-danger);` to:

```css
border: 1px solid var(--pi-hierarchy-border);
```

Leave every other property in that rule unchanged.

- [ ] **Step 6: Apply the nested class to SessionList rows**

In `src/client/src/components/SessionList.ts`, the row's class attribute is line
483 and already interpolates several conditional classes. Append one more
conditional immediately before the closing double quote of that attribute value,
after the `${indicatorKind === "unread" ? "unread" : ""}` interpolation:

```ts
 ${cappedDepth >= 2 ? "nested" : ""}
```

`cappedDepth` is already in scope from line 463. Do not change line 463.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/components/SessionList.crossWorkspace.test.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 8: Run the other SessionList suites**

Run: `npm test -- --run src/client/src/components/SessionList.test.ts src/client/src/components/SessionList.reorder.test.ts`

Expected: PASS. These prove no behaviour moved; the reorder suite in particular
covers the `data-session-reorder-path` structure this task must not disturb.

- [ ] **Step 9: Typecheck and lint the changed files**

Run: `npm run typecheck && npx eslint src/client/src/components/shared.ts src/client/src/components/SessionList.ts src/client/src/components/SessionList.crossWorkspace.test.ts`

Expected: both PASS with no errors.

- [ ] **Step 10: Commit**

```bash
git add src/client/src/components/shared.ts src/client/src/components/SessionList.ts src/client/src/components/SessionList.crossWorkspace.test.ts
git commit -m "feat: neutral session family frame with nested guide rail"
```

## Task 3: ProjectList and SessionBrowserDialog

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/ProjectList.ts:144`
- Modify: `src/client/src/components/ProjectList.ts:311`
- Modify: `src/client/src/components/SessionBrowserDialog.ts:111`
- Modify: `src/client/src/components/SessionBrowserDialog.ts:224`
- Modify: `src/client/src/components/ProjectList.hierarchy.test.ts`
- Modify: `src/client/src/components/SessionBrowserDialog.test.ts`

**Interfaces:**

- Consumes: `--pi-hierarchy-border` from Task 1, and from Task 2 the `nested` class
  contract plus the shared rail rules already present in `listStyles`
  (`.action-row.nested .action-main::before` and the `:last-child` variant). Both
  components import `listStyles` from `./shared`, so neither adds a rail rule.
- Produces: nothing consumed by a later task.

Both components render their row's inner element as `.action-main` and already
compute `const cappedDepth = Math.min(row.depth, 2)`, so only the frame border and
the class need changing.

- [ ] **Step 1: Write the failing ProjectList test**

In `src/client/src/components/ProjectList.hierarchy.test.ts`, inside the
`describe("project list hierarchy rendering", ...)` block, add this test
immediately after the existing `it("caps visual indentation at two levels", ...)`
test. It reuses that test's `deep` fixture shape and the file's existing `renderRow`
and `rowFor` helpers:

```ts
  it("marks a row at the capped depth as nested", () => {
    const deep: Project[] = [
      { id: "a", name: "A", path: "/a", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "b", name: "B", path: "/a/b", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "c", name: "C", path: "/a/b/c", createdAt: "2026-08-07T00:00:00.000Z" },
    ];
    const list = new ProjectList();
    list.projects = deep;

    expect(templateText(renderRow(list, rowFor(deep, "c", ["a", "b"])))).toContain("nested");
    expect(templateText(renderRow(list, rowFor(deep, "b", ["a"])))).not.toContain("nested");
  });

  it("frames project families with the neutral hierarchy border", () => {
    const styles = [ProjectList.styles].flat().map((style) => String(Reflect.get(style, "cssText") ?? "")).join("\n");

    expect(styles).toMatch(/\.session-family-frame\s*\{[^}]*border:\s*1px solid var\(--pi-hierarchy-border\);/);
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --run src/client/src/components/ProjectList.hierarchy.test.ts`

Expected: FAIL. The nested test fails because no row carries the class; the frame
test fails because the border is still `var(--pi-danger)`.

- [ ] **Step 3: Change the ProjectList frame border**

In `src/client/src/components/ProjectList.ts` line 311, in the
`.session-family-frame` rule, change `border: 1px solid var(--pi-danger);` to:

```css
border: 1px solid var(--pi-hierarchy-border);
```

- [ ] **Step 4: Apply the nested class to ProjectList rows**

In `src/client/src/components/ProjectList.ts`, line 144 currently reads:

```ts
        class=${`action-row ${this.selected?.id === project.id ? "selected" : ""}`}
```

Change it to:

```ts
        class=${`action-row ${this.selected?.id === project.id ? "selected" : ""} ${cappedDepth >= 2 ? "nested" : ""}`}
```

`cappedDepth` is already in scope from line 141. Do not change line 141.

- [ ] **Step 5: Confirm the ProjectList tests pass**

Run: `npm test -- --run src/client/src/components/ProjectList.hierarchy.test.ts src/client/src/components/ProjectList.statistics.test.ts src/client/src/components/ProjectList.test.ts`

Expected: PASS, all three files.

- [ ] **Step 6: Write the failing SessionBrowserDialog test**

In `src/client/src/components/SessionBrowserDialog.test.ts`, add this test inside
the file's top-level `describe` block. It asserts the style contract only, because
this component's rows render through a directive that `templateText` cannot reach:

```ts
  it("frames session families with the neutral hierarchy border", () => {
    const styles = [SessionBrowserDialog.styles].flat().map((style) => String(Reflect.get(style, "cssText") ?? "")).join("\n");

    expect(styles).toMatch(/\.session-family-frame\s*\{[^}]*border:\s*1px solid var\(--pi-hierarchy-border\);/);
  });
```

If `SessionBrowserDialog` is not already imported in that file, add it:

```ts
import { SessionBrowserDialog } from "./SessionBrowserDialog";
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `npm test -- --run src/client/src/components/SessionBrowserDialog.test.ts`

Expected: FAIL, because the border is still `var(--pi-danger)`.

- [ ] **Step 8: Change the SessionBrowserDialog frame border and row class**

In `src/client/src/components/SessionBrowserDialog.ts` line 224, in the
`.session-family-frame` rule, change `border: 1px solid var(--pi-danger);` to:

```css
border: 1px solid var(--pi-hierarchy-border);
```

Then line 111 currently reads:

```ts
        class=${`action-row session-browser-row ${this.selected?.id === session.id ? "selected" : ""}`}
```

Change it to:

```ts
        class=${`action-row session-browser-row ${this.selected?.id === session.id ? "selected" : ""} ${cappedDepth >= 2 ? "nested" : ""}`}
```

`cappedDepth` is already in scope from line 108. Do not change line 108.

- [ ] **Step 9: Confirm the SessionBrowserDialog tests pass**

Run: `npm test -- --run src/client/src/components/SessionBrowserDialog.test.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 10: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/client/src/components/ProjectList.ts src/client/src/components/SessionBrowserDialog.ts src/client/src/components/ProjectList.hierarchy.test.ts src/client/src/components/SessionBrowserDialog.test.ts`

Expected: both PASS with no errors.

- [ ] **Step 11: Commit**

```bash
git add src/client/src/components/ProjectList.ts src/client/src/components/SessionBrowserDialog.ts src/client/src/components/ProjectList.hierarchy.test.ts src/client/src/components/SessionBrowserDialog.test.ts
git commit -m "feat: apply neutral hierarchy frame to project and session browser lists"
```

## Task 4: ProjectBrowserDialog

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/ProjectBrowserDialog.ts:181`
- Modify: `src/client/src/components/ProjectBrowserDialog.ts:382`
- Modify: `src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`

**Interfaces:**

- Consumes: `--pi-hierarchy-border` from Task 1, and the `nested` class contract
  from Task 2, meaning a row whose `cappedDepth` is `>= 2` carries `nested`.
- Produces: nothing consumed by a later task.

This component is the exception in two ways: it does **not** import `listStyles`, so
it cannot inherit the shared rail rule, and its inner surface element is
`.project-main`, not `.action-main`. It therefore needs its own rail rule written
against `.project-main`. This mirrors the component's pre-existing duplication of
the `.session-family-frame` rule; do not refactor that duplication here.

- [ ] **Step 1: Write the failing test**

In `src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`, add these
tests inside the file's top-level `describe` block:

```ts
  it("frames project families with the neutral hierarchy border", () => {
    const styles = [ProjectBrowserDialog.styles].flat().map((style) => String(Reflect.get(style, "cssText") ?? "")).join("\n");

    expect(styles).toMatch(/\.session-family-frame\s*\{[^}]*border:\s*1px solid var\(--pi-hierarchy-border\);/);
  });

  it("draws the nested guide rail on the project row surface", () => {
    const styles = [ProjectBrowserDialog.styles].flat().map((style) => String(Reflect.get(style, "cssText") ?? "")).join("\n");

    expect(styles).toMatch(/\.project-row\.nested \.project-main::before\s*\{[^}]*background:\s*var\(--pi-hierarchy-border\);/);
    expect(styles).not.toContain(".project-row.nested::before");
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`

Expected: FAIL. The frame test fails on the `var(--pi-danger)` border; the rail test
fails because no `.nested` rule exists in this component.

- [ ] **Step 3: Change the frame border and add the component's own rail rule**

In `src/client/src/components/ProjectBrowserDialog.ts` line 382, in the
`.session-family-frame` rule, change `border: 1px solid var(--pi-danger);` to:

```css
border: 1px solid var(--pi-hierarchy-border);
```

Then add these two lines immediately after that `.session-family-frame` rule's
closing brace. Note `.project-main`, not `.action-main`:

```css
    .project-row.nested .project-main::before { content: ""; position: absolute; top: -5px; bottom: -5px; left: calc((var(--depth, 0) - 1) * 16px + 16px); width: 2px; background: var(--pi-hierarchy-border); pointer-events: none; }
    .session-family-frame > .project-row.nested:last-child .project-main::before { bottom: 50%; }
```

- [ ] **Step 4: Apply the nested class**

Line 181 currently reads:

```ts
        class=${`project-row action-row ${this.selected?.id === project.id ? "selected" : ""}`}
```

Change it to:

```ts
        class=${`project-row action-row ${this.selected?.id === project.id ? "selected" : ""} ${cappedDepth >= 2 ? "nested" : ""}`}
```

`cappedDepth` is already in scope from line 178. Do not change line 178.

- [ ] **Step 5: Confirm the tests pass**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts src/client/src/components/ProjectBrowserDialog.test.ts src/client/src/components/ProjectBrowserDialog.statistics.test.ts`

Expected: PASS, all three files.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/client/src/components/ProjectBrowserDialog.ts src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`

Expected: both PASS with no errors.

- [ ] **Step 7: Verify no danger-coloured frame border remains**

Run: `grep -rn "session-family-frame {" src/ | grep "pi-danger"`

Expected: no output and exit status 1, meaning no component still draws the frame
in the danger colour.

- [ ] **Step 8: Commit**

```bash
git add src/client/src/components/ProjectBrowserDialog.ts src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts
git commit -m "feat: apply neutral hierarchy frame and rail to project browser dialog"
```

## Task 5: Changeset and full verification

**Implementer tier:** Fast

**Files:**

- Create: `.changeset/session-hierarchy-frame-colour.md`

**Interfaces:**

- Consumes: the completed changes from Tasks 1 through 4. Nothing new in code.
- Produces: the release-note fragment for this change.

This repo uses Changesets, and `CHANGELOG.md` is generated at release time. Do not
edit `CHANGELOG.md`. The package name is `@hyperdreamer/pi-webui`, and this repo
uses `patch` for all non-breaking changes regardless of feature size.

- [ ] **Step 1: Create the changeset**

Create `.changeset/session-hierarchy-frame-colour.md` with exactly this content:

```md
---
"@hyperdreamer/pi-webui": patch
---

Show session and project families with a neutral hierarchy frame instead of the error-red border, and add a guide rail that groups a nested session with its children.
```

- [ ] **Step 2: Confirm the changeset is recognised**

Run: `npm run changelog:status`

Expected: exit 0, reporting a pending patch bump for `@hyperdreamer/pi-webui`.

- [ ] **Step 3: Run the full verification suite**

Run: `npm run verify`

Expected: PASS. `typecheck`, `lint`, `knip`, and the full Vitest suite all succeed.
The suite is timing sensitive, so do not run anything else heavy at the same time.
If a test times out, re-run that file alone before concluding anything about it.

- [ ] **Step 4: Commit**

```bash
git add .changeset/session-hierarchy-frame-colour.md
git commit -m "docs: add changeset for neutral hierarchy frame"
```
