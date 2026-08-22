# Lift LaTeX Formula Count Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Render every admitted small LaTeX formula in a settled message rather than stopping after eight formulas.

**Architecture:** Keep pre-render admission responsible for bounded TeX source and structural safety. Move math-output accounting to a post-render helper that records actual fragment length, preserving the 32,000-character fragment cap and 256,000-character accepted-output cap without reserving that maximum for every formula.

**Tech Stack:** TypeScript, Marked, KaTeX adapter seam, Vitest, Changesets.

## Global Constraints

- Work only in `src/client/src/formatting/latexMath.ts`, `src/client/src/formatting/latexMath.test.ts`, and one new `.changeset/*.md` file.
- Do not change Markdown delimiter grammar, protected-token behavior, KaTeX options, cache semantics, `FormattedText`, host speech, the composer, or any server/session code.
- Remove the fixed per-message formula-count gate; retain `MAX_FORMULA_BODY_UNITS = 512`, `MAX_MESSAGE_SOURCE_UNITS = 4_096`, brace/control-sequence/alignment limits, `maxExpand = 1_000`, `maxSize = 100`, `trust = false`, and literal-source fallback.
- Preserve a 32,000-character maximum rendered fragment and a 256,000-character maximum cumulative accepted math output. An overflowing fragment or cumulative output must preserve the current formula as literal source and close later math admission.
- Use test-driven development: run the new regression while red before editing production code, then run it green before broader checks.
- Add a patch Changeset for `@hyperdreamer/pi-webui`; do not edit `CHANGELOG.md`.

## Task 1: Account for Actual Math Output Instead of Formula Slots

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/formatting/latexMath.ts:6-40,684-741`
- Modify: `src/client/src/formatting/latexMath.test.ts:289-344`
- Create: `.changeset/lift-latex-formula-count-limit.md`

**Interfaces:**

- Consumes: `renderLatexMarkdown(source: string, renderMath: LatexRenderToString): string` and its render-local `MathRenderContext`.
- Produces: the same public formatter API, with no fixed formula-count cutoff and literal fallback when actual rendered output exceeds either output bound.
- Produces: a patch Changeset for `@hyperdreamer/pi-webui` stating that formatted messages render all formulas that fit the safety budgets.

- [ ] **Step 1: Add failing behavior regressions**

In `src/client/src/formatting/latexMath.test.ts`, replace the existing `caps formulas and aggregate source admission` test with these tests immediately before `closes later admission after an oversized rendered fragment`:

```ts
  it("renders small formulas beyond the former per-message count limit", () => {
    const adapter = recordingAdapter();
    const formulas = Array.from({ length: 20 }, (_, index) => `x${String(index)}`);
    const source = formulas.map((formula) => `$${formula}$`).join(" ");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(formulas);
    expect(html).not.toContain("$x8$");
    expect(html).not.toContain("$x19$");
  });

  it("caps aggregate TeX source admission without a formula-count limit", () => {
    const adapter = recordingAdapter();
    const source = Array.from({ length: 9 }, () => `$${"x".repeat(512)}$`).join(" ");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(8);
    expect(html).toContain(`$${"x".repeat(512)}$`);
  });

  it("closes later admission after actual aggregate rendered-output overflow", () => {
    const adapter = recordingAdapter("x".repeat(32_000));
    const formulas = Array.from({ length: 10 }, (_, index) => `x${String(index)}`);
    const source = formulas.map((formula) => `$${formula}$`).join(" ");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(formulas.slice(0, 9));
    expect(html).toContain("$x8$");
    expect(html).toContain("$x9$");
  });
```

- [ ] **Step 2: Run the regression and confirm the expected red state**

Run:

```bash
npm run test:serial -- --run src/client/src/formatting/latexMath.test.ts
```

Expected: the first test fails because the current formatter calls the adapter for only `x0` through `x7`; the aggregate-output test also demonstrates that the ninth candidate is rejected before rendering.

- [ ] **Step 3: Implement actual-output admission**

In `src/client/src/formatting/latexMath.ts`:

1. Replace `MAX_RESERVED_OUTPUT_UNITS` and `RESERVED_OUTPUT_PER_FORMULA` with constants named `MAX_MATH_OUTPUT_UNITS = 256_000` and `MAX_FORMULA_OUTPUT_UNITS = 32_000`.
2. Remove `MAX_FORMULA_COUNT` and `formulaCount` from `MathRenderContext` and from its initialization.
3. Keep `admitFormula(tex, context)` as the pre-render gate, but remove its formula-count and output-reservation checks. It must still reject closed admission, an overlong formula body, aggregate TeX source overflow, and unsafe structure; only then increment `context.mathSourceUnits`.
4. Add this post-render helper next to `admitFormula`:

```ts
function admitRenderedOutput(rendered: string, context: MathRenderContext): boolean {
  if (rendered.length > MAX_FORMULA_OUTPUT_UNITS
    || context.mathOutputUnits + rendered.length > MAX_MATH_OUTPUT_UNITS) {
    context.outputAdmissionClosed = true;
    return false;
  }
  context.mathOutputUnits += rendered.length;
  return true;
}
```

5. In `renderLatexToken`, call `admitRenderedOutput(rendered, context)` immediately after a successful `renderMath` call. When it returns `false`, return `literalForMathToken(mathToken)`; otherwise emit the existing inline or display wrapper.
6. Leave renderer-exception behavior unchanged: it falls back to literal source without closing unrelated later admission.

- [ ] **Step 4: Create the release note**

Create `.changeset/lift-latex-formula-count-limit.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Render all LaTeX formulas in a formatted message that fit the existing safety budgets, instead of stopping after eight formulas.
```

- [ ] **Step 5: Run focused green verification**

Run:

```bash
npm run test:serial -- --run src/client/src/formatting/latexMath.test.ts src/client/src/formatting/markdown.test.ts src/client/src/hostSpeechText.test.ts
npm run typecheck
npx eslint src/client/src/formatting/latexMath.ts src/client/src/formatting/latexMath.test.ts
npm run changelog:status
git diff --check
```

Expected: formatter, Markdown, and host-speech tests pass; TypeScript and scoped ESLint pass; Changesets report the existing minor feature plus this patch fix; no whitespace errors appear.

- [ ] **Step 6: Run release-level verification**

Run:

```bash
npm run verify
npm run build
npm audit --omit=dev --json
npm pack --dry-run --ignore-scripts --json
```

Expected: the full serial suite, production build, and production dependency audit pass. Inspect package JSON to confirm the package remains valid; delete only temporary command output created outside the worktree.

- [ ] **Step 7: Commit the task**

```bash
git add src/client/src/formatting/latexMath.ts src/client/src/formatting/latexMath.test.ts .changeset/lift-latex-formula-count-limit.md
git commit -m "fix(formatting): lift LaTeX formula count limit"
```
