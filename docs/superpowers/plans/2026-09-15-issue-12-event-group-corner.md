# Collapsed Event-Group Bottom Corner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the collapsed event-group bottom corners by removing the inert summary separator while collapsed, pinned by three CSS-contract assertions and one patch changeset.

**Architecture:** Append one rule to `chatStyles` in `src/client/src/components/shared.ts` that drops the summary's bottom border and rounds its bottom corners whenever the event-group `<details>` has no `open` attribute, then pin that rule and the two existing separator rules with exact-string assertions in `src/client/src/components/shared.test.ts`. No runtime code, component markup, or API changes.

**Tech Stack:** TypeScript, Lit `css` template styles, Vitest, ESLint, Changesets, npm, Git.

## Global Constraints

- If the tests are written before the production rule (red phase), the focused command must fail on assertion 1 (`.msg.event-group:not([open]) > summary …` absent) while assertions 2 and 3 pass; record that red output, then insert the rule and re-run to green.
- Exact strings, not substrings: the asserted strings are the exact rule texts produced by Lit's `cssText` for the rules at `shared.ts:609`, `shared.ts:610`, and the new rule; asserting the complete rule string keeps the selector, `border-bottom: 0`, `border-radius: 9px`, and the declaration order all load-bearing. Add no helper.
- Comments are stripped before asserting, because Lit's `cssText` retains them: a rule that is textually present but wrapped in `/* … */` would satisfy a raw `toContain` while being completely inert.
- Modify only `src/client/src/components/shared.ts`, `src/client/src/components/shared.test.ts`, and the new `.changeset/issue-12-event-group-corner.md`; no change to any other rule, selector, declaration, token, theme, or component, and no README or `docs/` change.

## Task 1: Close collapsed event-group bottom corners

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/shared.ts:609-611`
- Modify: `src/client/src/components/shared.test.ts:73-73`
- Create: `.changeset/issue-12-event-group-corner.md`

**Interfaces:**

- Consumes: nothing; this is the only task and it touches no existing export, signature, or state.
- Produces: the `chatStyles` contract `.msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }`, three exact-string assertions in `src/client/src/components/shared.test.ts`, and the patch changeset `.changeset/issue-12-event-group-corner.md`.

- [ ] **Step 1: Append the three failing contract tests**

Append this complete block to `src/client/src/components/shared.test.ts` after the final `});` that closes `describe("terminal modal header")` (currently line 73, the end of the file). Change no import and no existing test.

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

- [ ] **Step 2: Run the focused test and confirm the red phase fails for the right reason**

```bash
npm test -- --run src/client/src/components/shared.test.ts
```

Expected: FAIL on exactly one new assertion, `closes the summary bottom when the group is collapsed, so its separator cannot overhang the rounded container border`, because `.msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }` is absent. The other two new assertions pass because they pin rules that already exist. At the time of writing the run reports 1 failed and 9 passed (the 7 pre-existing tests plus the 2 passing new assertions). Confirm the failure message names the missing `.msg.event-group:not([open])` string and is not an import, syntax, fixture, or environment error, then record the red output.

- [ ] **Step 3: Append the collapsed-corner rule to `chatStyles`**

In `src/client/src/components/shared.ts`, insert between these two existing anchor rules, which must not change:

```css
  .msg.event-group.live > summary { border-bottom-color: var(--pi-success-border); background: var(--pi-success-bg); color: var(--pi-success); }
```

```css
  .msg.event-group > summary .label { margin: 0; }
```

Insert these four lines between the two anchors, preserving the two-space block indentation and the five-space comment continuation indentation:

```css
  /* A collapsed group has no body, so the summary separator has nothing to
     separate. Dropping it also stops its straight 1px line from overhanging the
     rounded container border at the bottom corners. */
  .msg.event-group:not([open]) > summary { border-bottom: 0; border-radius: 9px; }
```

Make no other edit in this file.

- [ ] **Step 4: Run the focused test and confirm it passes**

```bash
npm test -- --run src/client/src/components/shared.test.ts
```

Expected: PASS with no failures, 10 tests at the time of writing, including the three assertions in `describe("event group collapsed corner")`. The file has 5 `describe` blocks and 7 tests before this change; after it, 6 `describe` blocks and 10 tests. These counts are orientation recorded at plan time, not a guarantee a reviewer must match exactly; the binding expectation is PASS with no failures.

- [ ] **Step 5: Run typecheck and targeted ESLint**

```bash
npm run typecheck
npx eslint src/client/src/components/shared.ts src/client/src/components/shared.test.ts
```

Expected: both commands exit 0 with no diagnostics. The change adds CSS text and test assertions only; no type surface changes.

- [ ] **Step 6: Create the patch changeset**

Create `.changeset/issue-12-event-group-corner.md` with exactly this content, including the trailing newline:

```md
---
"@hyperdreamer/pi-webui": patch
---

Fix collapsed event groups so their bottom corners close cleanly in every theme instead of letting the summary separator leak past the rounded container border.
```

Keep the front matter `"@hyperdreamer/pi-webui": patch` and the single body paragraph exactly as shown; add no second changeset.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/shared.ts src/client/src/components/shared.test.ts .changeset/issue-12-event-group-corner.md
git commit -m "fix(client): close collapsed event-group bottom corners"
git show --stat --oneline HEAD
```

Expected: one commit containing exactly the three files listed above and no others.
