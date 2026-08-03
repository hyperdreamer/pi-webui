# Session Group Toggle Hit Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session-family expand/collapse controls easier to click in both the navigation sidebar and expanded Sessions browser.

**Architecture:** Keep the existing semantic buttons, Lit event wiring, and component ownership unchanged. Enlarge each component-local disclosure button to a stable `24px` square and apply the pinned-session star's hover surface, border-equivalent, and scale feedback, with focused CSS-contract tests proving both views stay aligned.

**Tech Stack:** TypeScript, Lit, CSS tagged templates, Vitest, Changesets.

## Global Constraints

- Node.js 22.19.0 is the version floor; do not use APIs newer than that.
- No new runtime dependencies.
- Both `SessionList` and `SessionBrowserDialog` must use a real `24px` square disclosure-button hit target while keeping the arrow glyph compact.
- Preserve the existing title, `aria-label`, `aria-expanded`, click propagation guard, folding behavior, and focus-visible outline.
- Use `background: var(--pi-surface)`, `box-shadow: 0 0 0 1px var(--pi-border)`, and `transform: scale(1.25)` for disclosure-button hover feedback in both components.
- Keep the styles component-local; do not introduce a shared style abstraction for two declarations.
- Do not change controllers, session-tree projection, APIs, persistence, server code, session daemon code, configuration, or URL behavior.
- Add a patch Changeset for the user-visible improvement; do not edit `CHANGELOG.md` directly.

## Task 1: Enlarge both session disclosure controls

**Implementer tier:** Economy

**Files:**

- Modify: `src/client/src/components/SessionList.test.ts:194-232`
- Modify: `src/client/src/components/SessionList.ts:702-704`
- Modify: `src/client/src/components/SessionBrowserDialog.test.ts:27-173`
- Modify: `src/client/src/components/SessionBrowserDialog.ts:213-215`
- Create: `.changeset/easier-session-disclosure-targets.md`

**Interfaces:**

- Consumes: `SessionList.styles` and `SessionBrowserDialog.styles`, each a Lit `CSSResultGroup`; existing `.session-group-toggle` and `.session-group-toggle:hover` component-local CSS rules; existing `sessionListStyles(): string` test helper.
- Produces: no new exported TypeScript API. Both `.session-group-toggle` rules provide `width: 24px`, `min-width: 24px`, and `height: 24px`; both hover rules provide `background: var(--pi-surface)`, `box-shadow: 0 0 0 1px var(--pi-border)`, and `transform: scale(1.25)`.

- [ ] **Step 1: Add the failing sidebar style-contract test**

Inside the existing `describe("linked session group disclosure", ...)` block in `SessionList.test.ts`, add this test without changing the existing pinned-star tests:

```ts
it("gives disclosure buttons a larger hit target and pinned-star hover feedback", () => {
  const styles = sessionListStyles();

  expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*width:\s*24px;/);
  expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*min-width:\s*24px;/);
  expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*height:\s*24px;/);
  expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*background:\s*var\(--pi-surface\);/);
  expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--pi-border\);/);
  expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*transform:\s*scale\(1\.25\);/);
});
```

- [ ] **Step 2: Add the failing expanded-browser style-contract test**

Add this test inside the existing `describe("SessionBrowserDialog", ...)` block in `SessionBrowserDialog.test.ts`:

```ts
it("gives disclosure buttons a larger hit target and pinned-star hover feedback", () => {
  const styles = sessionBrowserDialogStyles();

  expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*width:\s*24px;/);
  expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*min-width:\s*24px;/);
  expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*height:\s*24px;/);
  expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*background:\s*var\(--pi-surface\);/);
  expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--pi-border\);/);
  expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*transform:\s*scale\(1\.25\);/);
});
```

Append this file-local helper after the `describe` block:

```ts
function sessionBrowserDialogStyles(): string {
  const styles = SessionBrowserDialog.styles;
  const styleResults = Array.isArray(styles) ? styles : [styles];
  return styleResults.map((style) => style.cssText).join("\n");
}
```

- [ ] **Step 3: Run the focused tests and confirm the red phase**

Run:

```bash
npm test -- --run src/client/src/components/SessionList.test.ts src/client/src/components/SessionBrowserDialog.test.ts
```

Expected: FAIL in both newly added tests because the current rules use `18px`, omit the hover box shadow and transform, and use `var(--pi-surface-hover)` rather than `var(--pi-surface)`. Confirm existing behavioral tests still run; do not proceed if either new test passes against the old CSS.

- [ ] **Step 4: Apply the minimal sidebar CSS change**

Replace only the two `SessionList.ts` disclosure rules with:

```css
.session-group-toggle { flex: 0 0 auto; display: grid; place-items: center; width: 24px; min-width: 24px; height: 24px; margin: 0; border: 0; border-radius: 4px; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; line-height: 1; }
.session-group-toggle:hover { background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); color: var(--pi-text); transform: scale(1.25); }
```

Leave `.session-group-toggle:focus-visible` and `renderSessionGroupToggle()` unchanged.

- [ ] **Step 5: Apply the minimal expanded-browser CSS change**

Replace only the two `SessionBrowserDialog.ts` disclosure rules with:

```css
.session-group-toggle { flex: 0 0 auto; display: inline-grid; place-items: center; width: 24px; min-width: 24px; height: 24px; margin: 0 5px 0 0; border: 0; border-radius: 4px; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; line-height: 1; vertical-align: text-bottom; cursor: pointer; }
.session-group-toggle:hover { background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); color: var(--pi-text); transform: scale(1.25); }
```

Leave `.session-group-toggle:focus-visible` and `renderSessionGroupToggle()` unchanged.

- [ ] **Step 6: Run the focused tests and confirm the green phase**

Run:

```bash
npm test -- --run src/client/src/components/SessionList.test.ts src/client/src/components/SessionBrowserDialog.test.ts
```

Expected: PASS for both test files, including the two new CSS-contract tests and all existing disclosure behavior tests.

- [ ] **Step 7: Add the release-note fragment**

Create `.changeset/easier-session-disclosure-targets.md` with exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Make session-family expand and collapse controls easier to click in both session views.
```

- [ ] **Step 8: Run focused static verification**

Run:

```bash
npm run typecheck
npx eslint src/client/src/components/SessionList.ts src/client/src/components/SessionList.test.ts src/client/src/components/SessionBrowserDialog.ts src/client/src/components/SessionBrowserDialog.test.ts
git diff --check
```

Expected: all commands exit 0 with no TypeScript, ESLint, or whitespace errors.

- [ ] **Step 9: Inspect the scoped diff**

Run:

```bash
git diff -- src/client/src/components/SessionList.ts src/client/src/components/SessionList.test.ts src/client/src/components/SessionBrowserDialog.ts src/client/src/components/SessionBrowserDialog.test.ts .changeset/easier-session-disclosure-targets.md
```

Confirm the diff contains only the two style-contract tests, the new dialog test helper, the four CSS rule replacements, and the patch Changeset. Confirm no Lit markup, accessible attributes, click handlers, focus-visible rules, or folding logic changed.

- [ ] **Step 10: Run full verification**

Run:

```bash
npm run verify
```

Expected: typecheck, ESLint, Knip, and the complete Vitest suite all pass.

- [ ] **Step 11: Commit**

```bash
git add src/client/src/components/SessionList.ts src/client/src/components/SessionList.test.ts src/client/src/components/SessionBrowserDialog.ts src/client/src/components/SessionBrowserDialog.test.ts .changeset/easier-session-disclosure-targets.md
git commit -m "feat(client): enlarge session disclosure targets"
```
