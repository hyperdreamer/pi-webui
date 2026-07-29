# Sparkle Broom Cleanup Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current cleanup SVG with the approved outlined angled broom and two sparkle accents, without changing cleanup behavior or control geometry.

**Architecture:** Keep the change local to `SessionList.renderCleanupButton()`. The existing button, label, callback, CSS sizing, and cleanup flow remain unchanged; only the SVG paths and stable visual-semantic class names change. A focused component-boundary test guards the approved broom-plus-two-sparkles structure alongside existing cleanup behavior coverage.

**Tech Stack:** TypeScript 6, Lit 3, Vitest 4, ESLint, npm, Changesets.

## Global Constraints

- Change only the cleanup SVG artwork and its focused regression coverage; do not change cleanup behavior, `title`, `aria-label`, unavailable messaging, callback wiring, button geometry, search behavior, or session runtime ownership.
- Use an outlined angled broom handle and bristle head with exactly two small outlined four-point sparkle accents above the bristles.
- Retain the existing 24×24 view box, 15 px rendered icon size, `currentColor` stroke, and rounded line treatment.
- Keep the SVG hidden from assistive technology; the existing button labels remain the accessible cleanup description.
- Do not add APIs, server routes, daemon behavior, persistence, configuration, URL state, dependencies, or a new Changeset fragment. The existing unconsumed `.changeset/sessions-sidebar-search.md` already records this user-visible cleanup control.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/client/src/components/SessionList.ts` | Render the approved broom-plus-two-sparkles SVG inside the existing cleanup button. |
| `src/client/src/components/SessionList.test.ts` | Prove the rendered cleanup control exposes one broom structure and exactly two sparkle accents while preserving the existing callback and accessible-label coverage. |

### Task 1: Render and protect the approved sparkle-broom icon

**Files:**
- Modify: `src/client/src/components/SessionList.ts:270-275`
- Modify: `src/client/src/components/SessionList.test.ts:368-382`

**Interfaces:**
- Consumes the existing private `renderCleanupButton()` contract: it returns the cleanup button with its current `title`, `aria-label`, and `onCleanup` callback wiring.
- Produces stable SVG class hooks: `cleanup-broom` for the broom body and `cleanup-sparkle` on each sparkle path.
- Does not change public component properties, callbacks, CSS selectors, or API contracts.

- [ ] **Step 1: Write the failing visual-structure regression test**

Extend the existing `"keeps cleanup callable through a labelled icon-only broom button"` test in `SessionList.test.ts` after its `cleanup-icon` assertion:

```ts
const cleanupMarkup = templateText(list.render());
expect(cleanupMarkup).toContain('class="cleanup-broom"');
expect(cleanupMarkup.match(/class="cleanup-sparkle"/g)).toHaveLength(2);
```

This is a proportionate component-boundary assertion: the user-approved visual contract is exactly the SVG structure, while the surrounding test already proves the observable cleanup callback and accessible text remain intact.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- --run src/client/src/components/SessionList.test.ts
```

Expected: FAIL in the updated cleanup-icon test because the current SVG has neither a `cleanup-broom` class nor two `cleanup-sparkle` paths.

- [ ] **Step 3: Replace only the cleanup SVG paths**

In `SessionList.renderCleanupButton()`, retain the existing `<button>` markup and replace only its nested SVG with this outline artwork:

```ts
${svg`<svg class="cleanup-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="cleanup-broom" d="M4 3 12.2 13.8"></path>
  <path class="cleanup-broom" d="m10.7 12.8 2.8 2.1"></path>
  <path class="cleanup-broom" d="M11 13.5c-1.4 1.1-1.5 2.9-.7 4.4.8 1.5 1.2 2.6.8 3.6 1.9.2 3.5-.1 4.6-1.1 1.2.2 2.4-.1 3.3-.8 1.4-.1 2.4-.9 2.9-1.9-3.7-.5-6.4-2.5-8.5-5.2Z"></path>
  <path class="cleanup-broom" d="M12 18.5v2.4"></path>
  <path class="cleanup-broom" d="M14.6 18.8v2"></path>
  <path class="cleanup-broom" d="M17.2 18.7v1.5"></path>
  <path class="cleanup-sparkle" d="m17.5 2 .55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55Z"></path>
  <path class="cleanup-sparkle" d="m20 7 .4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4Z"></path>
</svg>`}
```

Do not add fill, stroke, size, or accessibility attributes to individual paths: the existing `.cleanup-icon` CSS and SVG-level attributes already supply the approved outline styling and assistive-technology behavior.

- [ ] **Step 4: Run focused tests, typecheck, and lint**

Run:

```bash
npm test -- --run src/client/src/components/SessionList.test.ts
npm run typecheck
npx eslint src/client/src/components/SessionList.ts src/client/src/components/SessionList.test.ts
```

Expected: all commands pass. The updated test confirms the SVG contains exactly two sparkle paths; existing assertions confirm the button remains icon-only, labelled, callable, and capable of exposing the unavailable message.

- [ ] **Step 5: Run the branch verification and Changeset status checks**

Run:

```bash
npm run changelog:status
npm run verify
git diff --check
git status --short
```

Expected: the existing `@hyperdreamer/pi-webui` patch Changeset remains detected; typecheck, lint, Knip, and Vitest pass; whitespace validation is clean; and only the two planned source/test files are uncommitted.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/client/src/components/SessionList.ts src/client/src/components/SessionList.test.ts
git commit -m "fix(sessions): add sparkle broom cleanup icon"
```

- [ ] **Step 7: Record the clean branch state**

Run:

```bash
git status --short --branch
git log --oneline -3
```

Expected: `feature/sparkle-broom-icon` is clean and contains the design refinement followed by the focused icon implementation commit.
