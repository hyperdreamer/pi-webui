# Composer Model Policy Cascading Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the session model policy panel's deferred Save button with
completion-triggered application, and give every unconfigured state a
deterministic seed so a first-run install renders an actionable form instead of
nothing.

**Architecture:** All decision logic stays in the pure module
`sessionModelPolicyDraft.ts`, which gains a completion predicate and a
resolution-chain seeder. `SessionModelPolicyControl.ts` becomes thin glue that
calls those helpers and fires an apply when the draft completes, with Exact-mode
applies coalesced behind an injected timer. `PiWebUiApp.ts` stops requiring
machine defaults before rendering the starter control.

**Tech Stack:** TypeScript, Lit 3 (reactive properties, shadow DOM), Vitest with
jsdom.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-composer-model-policy-cascading-selection-design.md`.
- No silent model, tier, or thinking-level substitution or clamping anywhere. An incomplete tuple must yield `undefined` from `sessionModelPolicyUpdateFromDraft`, never a guessed value.
- Never put a backtick inside a Lit ``css`` template literal. It terminates the template and produces an oxc `PARSE_ERROR`.
- Pure logic goes in `sessionModelPolicyDraft.ts`. Lit components are thin glue: no policy decisions in render methods.
- Do not add runtime dependencies. Do not add request timeouts to `src/client/src/api/http.ts`; that is a separate tracked follow-up.
- Do not modify `src/server/**`. This slice is client-only.
- Inject timers as constructor-style properties with a default, following the existing `scheduleOverloadResync` pattern in `sessionController.ts`. Never call `setTimeout` directly in a component method under test.
- Run focused tests with `npx vitest run <path>`. Run the full suite with `HOME=$(mktemp -d) npm run verify`; the single `src/server/terminals/terminalService.test.ts` PTY timeout under the real `HOME` is environmental, and Knip's eight configuration hints are pre-existing.
- Commit after each task with a Conventional Commits subject under 70 characters.
- Do not add a Changeset in any task except the final docs task, which owns the single release note.

## Task 1: Draft completion predicate

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/sessionModelPolicyDraft.ts:63-82`
- Test: `src/client/src/components/sessionModelPolicyDraft.test.ts`

**Interfaces:**

- Consumes: existing `sessionModelPolicyUpdateFromDraft(draft: SessionModelPolicyDraft, catalog: ModelTierSettingsResponse): SessionModelPolicyUpdate | undefined`, and `SessionModelPolicyDraft = { mode: "exact" | "tiered"; exact: ExactModelSelection; tier?: ModelTier }`.
- Produces: `isDraftReadyToApply(draft: SessionModelPolicyDraft, catalog: ModelTierSettingsResponse | undefined): boolean`, true only when `sessionModelPolicyUpdateFromDraft` would return a defined update.

- [ ] **Step 1: Write the failing test**

Append to `src/client/src/components/sessionModelPolicyDraft.test.ts`. That file already defines `validCatalog()`, `defaultModelOption` (`openai/gpt-default`, thinking levels `low`/`medium`/`high`), and `repairModelOption` (`openai/gpt-repair`, levels `off`/`low`). Use those fixtures. The catalog contains **no** `anthropic` models, so any draft naming one is invalid regardless of thinking level.

The matrix must include at least one Exact draft that is genuinely **ready**, or the whole test is vacuous: a predicate hardcoded to reject every Exact draft would pass it. After implementing, temporarily add `if (draft.mode === "exact") return false;` to your implementation and confirm at least one test fails. Remove the mutation before committing.

```ts
describe("isDraftReadyToApply", () => {
  it("is false when the catalog has not loaded", () => {
    // Valid against validCatalog(), so this isolates catalog absence rather than
    // also failing on an invalid selection.
    const draft = modelPolicyDraftFromPolicy({ mode: "exact", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" } });
    expect(isDraftReadyToApply(draft, undefined)).toBe(false);
    expect(isDraftReadyToApply(draft, validCatalog())).toBe(true);
  });

  it("is false for an exact draft whose thinking level was cleared by a model change", () => {
    const catalog = validCatalog();
    const draft = modelPolicyDraftFromPolicy({ mode: "exact", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "" } });
    expect(isDraftReadyToApply(draft, catalog)).toBe(false);
  });

  it("is false for a tiered draft with no tier chosen", () => {
    const catalog = validCatalog();
    const draft: SessionModelPolicyDraft = { mode: "tiered", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } };
    expect(isDraftReadyToApply(draft, catalog)).toBe(false);
  });

  it("agrees with sessionModelPolicyUpdateFromDraft on every input", () => {
    const catalog = validCatalog();
    const drafts: SessionModelPolicyDraft[] = [
      // Ready. Without this row the matrix proves nothing about Exact mode.
      { mode: "exact", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" } },
      // Not ready: level cleared by a model change.
      { mode: "exact", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "" } },
      // Not ready: model absent from the catalog.
      { mode: "exact", exact: { model: { provider: "openai", id: "not-in-catalog" }, thinkingLevel: "medium" } },
      // Ready: a level the repair model does support.
      { mode: "exact", exact: { model: { ...repairModelOption.model }, thinkingLevel: "low" } },
      // Not ready: a level the repair model does not support.
      { mode: "exact", exact: { model: { ...repairModelOption.model }, thinkingLevel: "high" } },
      { mode: "exact", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } },
      { mode: "tiered", exact: { model: { provider: "", id: "" }, thinkingLevel: "" }, tier: "standard" },
      { mode: "tiered", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } },
    ];
    for (const draft of drafts) {
      expect(isDraftReadyToApply(draft, catalog)).toBe(sessionModelPolicyUpdateFromDraft(draft, catalog) !== undefined);
    }
  });
});
```

Add `isDraftReadyToApply` to the existing import from `./sessionModelPolicyDraft` in that test file.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/sessionModelPolicyDraft.test.ts`
Expected: FAIL, `isDraftReadyToApply is not a function` or a TypeScript error that it is not exported.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/client/src/components/sessionModelPolicyDraft.ts`, directly after `sessionModelPolicyUpdateFromDraft`:

```ts
/**
 * Whether this draft forms a complete, applicable tuple. Delegates to
 * `sessionModelPolicyUpdateFromDraft` so completion can never disagree with what
 * would actually be submitted.
 */
export function isDraftReadyToApply(
  draft: SessionModelPolicyDraft,
  catalog: ModelTierSettingsResponse | undefined,
): boolean {
  if (catalog === undefined) return false;
  return sessionModelPolicyUpdateFromDraft(draft, catalog) !== undefined;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/client/src/components/sessionModelPolicyDraft.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/sessionModelPolicyDraft.ts src/client/src/components/sessionModelPolicyDraft.test.ts
git commit -m "feat(client): add a model policy draft completion predicate"
```

## Task 2: Resolution-chain draft seeding

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/sessionModelPolicyDraft.ts:18-24`
- Test: `src/client/src/components/sessionModelPolicyDraft.test.ts`

**Interfaces:**

- Consumes: `SessionModelPolicyDraft`, `modelPolicyDraftFromPolicy(policy: SessionModelPolicy): SessionModelPolicyDraft`, and `isDraftReadyToApply` from Task 1.
- Produces: `seedModelPolicyDraft(input: DraftSeedInput): SessionModelPolicyDraft` and the exported type `DraftSeedInput = { policy?: SessionModelPolicy; liveResolved?: ExactModelSelection; catalog?: ModelTierSettingsResponse }`.

Chain order, from the spec. Cases 1-4 pick the exact tuple; case 5 then applies independently when the draft is Tiered with no tier.

1. `policy` defined: return `modelPolicyDraftFromPolicy(policy)`.
2. `policy` undefined, `liveResolved` defined: Exact draft from `liveResolved`.
3. Not distinguishable inside this pure function; the caller passes machine defaults as `liveResolved`.
4. Neither defined: Exact draft with empty provider, empty id, empty thinking level.
5. Resulting draft is Tiered with `tier === undefined` and `catalog.rows.standard.valid` is true: set `tier: "standard"`.

- [ ] **Step 1: Write the failing test**

```ts
describe("seedModelPolicyDraft", () => {
  it("restores a persisted policy including a remembered tier in exact mode", () => {
    const policy: SessionModelPolicy = { mode: "exact", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" }, tier: "fast" };
    expect(seedModelPolicyDraft({ policy })).toEqual({ mode: "exact", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" }, tier: "fast" });
  });

  it("falls back to the live resolved tuple when nothing is persisted", () => {
    const liveResolved = { model: { ...repairModelOption.model }, thinkingLevel: "low" };
    expect(seedModelPolicyDraft({ liveResolved })).toEqual({ mode: "exact", exact: liveResolved });
  });

  it("seeds an empty exact draft when there is no policy and no live tuple", () => {
    expect(seedModelPolicyDraft({})).toEqual({ mode: "exact", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } });
  });

  it("pre-selects standard for a tiered policy with no tier when that row is valid", () => {
    const catalog = validCatalog();
    const policy: SessionModelPolicy = { mode: "tiered", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } };
    expect(seedModelPolicyDraft({ policy, catalog }).tier).toBe("standard");
  });

  it("leaves the tier unset when the standard row is invalid", () => {
    const catalog = validCatalog();
    catalog.rows.standard = { valid: false, reason: "Standard is not configured" };
    const policy: SessionModelPolicy = { mode: "tiered", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } };
    expect(seedModelPolicyDraft({ policy, catalog }).tier).toBeUndefined();
  });

  it("does not overwrite a tier the persisted policy already chose", () => {
    const catalog = validCatalog();
    const policy: SessionModelPolicy = { mode: "tiered", exact: { model: { provider: "", id: "" }, thinkingLevel: "" }, tier: "frontier" };
    expect(seedModelPolicyDraft({ policy, catalog }).tier).toBe("frontier");
  });

  it("does not pre-select a tier for an exact draft", () => {
    const catalog = validCatalog();
    expect(seedModelPolicyDraft({ catalog }).tier).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/sessionModelPolicyDraft.test.ts`
Expected: FAIL, `seedModelPolicyDraft is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/client/src/components/sessionModelPolicyDraft.ts`:

```ts
export interface DraftSeedInput {
  /** Newest persisted policy, when one exists and parsed. */
  policy?: SessionModelPolicy;
  /** Tuple the runtime confirmed, or a starter's machine defaults. */
  liveResolved?: ExactModelSelection;
  catalog?: ModelTierSettingsResponse;
}

/**
 * Deterministic draft seed. Every branch is explainable and none invents a
 * model: an absent policy and absent live tuple produce empty selections that
 * `isDraftReadyToApply` rejects, so nothing can be applied until the user picks.
 */
export function seedModelPolicyDraft(input: DraftSeedInput): SessionModelPolicyDraft {
  const base = baseDraft(input);
  if (base.mode !== "tiered" || base.tier !== undefined) return base;
  const rows = input.catalog?.rows;
  if (rows === undefined || !Object.hasOwn(rows, "standard") || !rows.standard.valid) return base;
  return { ...base, tier: "standard" };
}

function baseDraft(input: DraftSeedInput): SessionModelPolicyDraft {
  if (input.policy !== undefined) return modelPolicyDraftFromPolicy(input.policy);
  const live = input.liveResolved;
  if (live !== undefined) return { mode: "exact", exact: cloneExactSelection(live) };
  return { mode: "exact", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/client/src/components/sessionModelPolicyDraft.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/sessionModelPolicyDraft.ts src/client/src/components/sessionModelPolicyDraft.test.ts
git commit -m "feat(client): seed model policy drafts from a resolution chain"
```

## Task 3: Completion-triggered apply in the control

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/SessionModelPolicyControl.ts:49-62`
- Modify: `src/client/src/components/SessionModelPolicyControl.ts:316-357`
- Test: `src/client/src/components/SessionModelPolicyControl.test.ts`

**Interfaces:**

- Consumes: `isDraftReadyToApply(draft, catalog)` from Task 1; existing `sessionModelPolicyUpdateFromDraft(draft, catalog)`, `selectDraftExact(draft)`, `selectDraftTier(draft, tier)`, `updateDraftExactModel(draft, option)`, `updateDraftExactThinking(draft, level)`; existing properties `onSave?: (update: SessionModelPolicyUpdate) => void`, `catalog?: ModelTierSettingsResponse`, `saving`, `loading`, `editable`; existing private `canMutate(): boolean`.
- Produces: a new public property `scheduleApply?: (run: () => void, delayMs: number) => () => void` defaulting to a `setTimeout` wrapper, and a private `applyIfReady(immediate: boolean): void`. Removes the `.policy-save` and `.policy-cancel` buttons from `renderForm`.

Behavior: Tiered tier selection applies immediately. Exact model and thinking changes apply coalesced with a 400 ms trailing delay. A pending coalesced apply is cancelled on close and on disconnect. `applyIfReady` does nothing unless `canMutate()` and `isDraftReadyToApply` both hold.

- [ ] **Step 1: Write the failing test**

Add to `src/client/src/components/SessionModelPolicyControl.test.ts`. Use the file's existing `mountControl` helper and its catalog/status fixtures.

```ts
describe("completion-triggered apply", () => {
  function controlledScheduler() {
    const pending: (() => void)[] = [];
    const schedule = (run: () => void) => { pending.push(run); return () => { const i = pending.indexOf(run); if (i >= 0) pending.splice(i, 1); }; };
    return { schedule, flush: () => { const runs = pending.splice(0); for (const run of runs) run(); }, get size() { return pending.length; } };
  }

  it("applies immediately when a tier is selected", async () => {
    const saves: SessionModelPolicyUpdate[] = [];
    const control = await mountControl((element) => {
      element.status = tieredStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.onSave = (update) => { saves.push(update); };
    });
    await openPanel(control);

    await choose(control, "policy-tier", "frontier");

    expect(saves).toEqual([{ mode: "tiered", tier: "frontier" }]);
  });

  it("does not apply when an exact model change clears the thinking level", async () => {
    const saves: SessionModelPolicyUpdate[] = [];
    const scheduler = controlledScheduler();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.scheduleApply = scheduler.schedule;
      element.onSave = (update) => { saves.push(update); };
    });
    await openPanel(control);

    // A model whose supported levels exclude the current level clears it.
    await choose(control, "policy-exact-model", modelKeyWithoutMedium());
    scheduler.flush();

    expect(saves).toEqual([]);
  });

  it("applies once the exact thinking level completes the tuple", async () => {
    const saves: SessionModelPolicyUpdate[] = [];
    const scheduler = controlledScheduler();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.scheduleApply = scheduler.schedule;
      element.onSave = (update) => { saves.push(update); };
    });
    await openPanel(control);

    await choose(control, "policy-exact-model", modelKeyWithoutMedium());
    await choose(control, "policy-exact-thinking", levelsFor(modelKeyWithoutMedium())[0]);
    scheduler.flush();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.mode).toBe("exact");
  });

  it("coalesces rapid exact edits into a single apply", async () => {
    const saves: SessionModelPolicyUpdate[] = [];
    const scheduler = controlledScheduler();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.scheduleApply = scheduler.schedule;
      element.onSave = (update) => { saves.push(update); };
    });
    await openPanel(control);

    for (const level of levelsFor(modelKeyWithoutMedium())) {
      await choose(control, "policy-exact-thinking", level);
    }
    expect(scheduler.size).toBe(1);
    scheduler.flush();

    expect(saves).toHaveLength(1);
  });

  it("cancels a pending apply when the panel closes", async () => {
    const saves: SessionModelPolicyUpdate[] = [];
    const scheduler = controlledScheduler();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.scheduleApply = scheduler.schedule;
      element.onSave = (update) => { saves.push(update); };
    });
    await openPanel(control);

    await choose(control, "policy-exact-thinking", levelsFor(modelKeyWithoutMedium())[0]);
    await closePanel(control);
    scheduler.flush();

    expect(saves).toEqual([]);
  });

  it("no longer renders Save or Cancel", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
    });
    await openPanel(control);

    expect(shadowRoot(control).querySelector(".policy-save")).toBeNull();
    expect(shadowRoot(control).querySelector(".policy-cancel")).toBeNull();
  });
});
```

This file already defines `mountControl(configure)`, `openPanel(control)`, `choose(control, id, value)` (which takes a bare element id, sets the value, dispatches a bubbling composed `change`, and awaits `updateComplete`), `field(control, id)`, `shadowRoot(control)`, `trigger(control)`, `exactStatus()`, `tieredStatus()`, and `exactResponse(exact?)`. Reuse all of them; do not redefine.

Add only these three helpers beside the new describe block:

```ts
async function closePanel(control: SessionModelPolicyControl): Promise<void> {
  shadowRoot(control).querySelector<HTMLButtonElement>(".policy-close")?.click();
  await control.updateComplete;
}

/** A catalog model key whose supported levels exclude "medium", so selecting it clears the level. */
function modelKeyWithoutMedium(): string {
  const option = validCatalog().models.find((candidate) => !candidate.thinkingLevels.includes("medium"));
  if (option === undefined) throw new Error("Fixture needs a model that does not support medium");
  return `${option.model.provider}/${option.model.id}`;
}

function levelsFor(modelKey: string): string[] {
  const option = validCatalog().models.find((candidate) => `${candidate.model.provider}/${candidate.model.id}` === modelKey);
  if (option === undefined) throw new Error(`No fixture model for ${modelKey}`);
  return [...option.thinkingLevels];
}
```

If `validCatalog()` has no model lacking `medium`, add one to that fixture rather than weakening the test. Confirm the key format matches the control's `modelKey()` helper before relying on it.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`
Expected: FAIL. The tier test fails because no apply fires without Save; the Save/Cancel test fails because both buttons still render.

- [ ] **Step 3: Write the minimal implementation**

In `SessionModelPolicyControl.ts` add the injected scheduler beside the existing properties:

```ts
  /** Trailing-delay scheduler for coalesced exact applies. Injected for tests. */
  @property({ attribute: false }) scheduleApply: (run: () => void, delayMs: number) => () => void =
    (run, delayMs) => { const timer = globalThis.setTimeout(run, delayMs); return () => { globalThis.clearTimeout(timer); }; };
```

Add a private field `private cancelPendingApply: (() => void) | undefined;` and the constant `const EXACT_APPLY_DELAY_MS = 400;` at module scope.

Replace the body of `save()` with `applyIfReady`, and route the change handlers through it:

```ts
  /**
   * Apply when the draft forms a complete tuple, and only then. An exact model
   * change deliberately clears an unsupported thinking level, so the tuple is
   * incomplete at that instant and must not be submitted.
   */
  private applyIfReady(immediate: boolean): void {
    this.cancelPendingApply?.();
    this.cancelPendingApply = undefined;
    const draft = this.draft;
    const catalog = this.catalog;
    if (draft === undefined || catalog === undefined || !this.canMutate()) return;
    if (!isDraftReadyToApply(draft, catalog)) return;
    const update = sessionModelPolicyUpdateFromDraft(draft, catalog);
    if (update === undefined) return;
    if (immediate) {
      this.onSave?.(update);
      return;
    }
    this.cancelPendingApply = this.scheduleApply(() => {
      this.cancelPendingApply = undefined;
      this.onSave?.(update);
    }, EXACT_APPLY_DELAY_MS);
  }
```

Call `this.applyIfReady(true)` at the end of `changeTier` and `changeMode`. Call `this.applyIfReady(false)` at the end of `changeExactModel` and `changeExactThinking`. In `close()`, before `this.draft = draftForResponse(this.response);`, add `this.cancelPendingApply?.(); this.cancelPendingApply = undefined;`. In `disconnectedCallback()`, add the same two lines before `super.disconnectedCallback()`.

In `renderForm`, delete the entire `<footer class="policy-actions">` element and its two buttons. Leave the `.policy-actions` CSS rules in place; they still style `.policy-retry`.

Import `isDraftReadyToApply` from `./sessionModelPolicyDraft`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/SessionModelPolicyControl.test.ts
git commit -m "feat(client): apply model policy when the draft completes"
```

## Task 4: Seed the control draft through the chain

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/SessionModelPolicyControl.ts:380-400`
- Test: `src/client/src/components/SessionModelPolicyControl.test.ts`

**Interfaces:**

- Consumes: `seedModelPolicyDraft(input: DraftSeedInput): SessionModelPolicyDraft` and `DraftSeedInput = { policy?: SessionModelPolicy; liveResolved?: ExactModelSelection; catalog?: ModelTierSettingsResponse }` from Task 2.
- Produces: `draftForResponse(response: SessionModelPolicyResponse | undefined, catalog: ModelTierSettingsResponse | undefined): SessionModelPolicyDraft | undefined`, one added parameter on the existing module-scope function.

The existing function already handles a malformed newest entry by seeding from `response.session.modelPolicy?.resolved`. Route both that path and the normal path through `seedModelPolicyDraft` so tier pre-selection applies uniformly.

- [ ] **Step 1: Write the failing test**

```ts
describe("draft seeding", () => {
  it("pre-selects standard when a tiered response carries no tier", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
      element.response = tieredResponseWithoutTier();
      element.catalog = validCatalog();
      element.editable = true;
    });
    await openPanel(control);

    expect(shadowRoot(control).querySelector<HTMLSelectElement>("#policy-tier")?.value).toBe("standard");
  });

  it("seeds the repair form from the resolved tuple when the newest entry is malformed", async () => {
    const control = await mountControl((element) => {
      element.status = blockedStatus();
      element.response = malformedResponse();
      element.catalog = validCatalog();
      element.editable = true;
    });
    await openPanel(control);

    const model = shadowRoot(control).querySelector<HTMLSelectElement>("#policy-exact-model");
    expect(model?.value).not.toBe("");
  });
});
```

Add `tieredResponseWithoutTier()` and `malformedResponse()` fixtures beside the existing response fixtures. `tieredResponseWithoutTier()` returns a response whose `policy` is `{ mode: "tiered", exact: <any valid exact tuple> }` with no `tier`. `malformedResponse()` returns a response with `policy` omitted and `session.modelPolicy.resolved` set to a valid tuple plus a non-blank `blockedReason`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`
Expected: FAIL, the tier select's value is `""` rather than `standard`.

- [ ] **Step 3: Write the minimal implementation**

Replace `draftForResponse` in `SessionModelPolicyControl.ts`:

```ts
function draftForResponse(
  response: SessionModelPolicyResponse | undefined,
  catalog: ModelTierSettingsResponse | undefined,
): SessionModelPolicyDraft | undefined {
  if (response === undefined) return undefined;
  // A malformed newest entry has no policy to copy, so the repair form seeds from
  // the tuple the runtime actually resolved. The server's blocked reason stays
  // visible beside it.
  return seedModelPolicyDraft({
    ...(response.policy === undefined ? {} : { policy: response.policy }),
    ...(response.session.modelPolicy?.resolved === undefined ? {} : { liveResolved: response.session.modelPolicy.resolved }),
    ...(catalog === undefined ? {} : { catalog }),
  });
}
```

Update both call sites to pass the catalog: the `willUpdate`/property-change site that currently calls `draftForResponse(this.response)`, and the line in `close()`. Search for `draftForResponse(` and update every occurrence. Import `seedModelPolicyDraft` and its `DraftSeedInput` type from `./sessionModelPolicyDraft`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/SessionModelPolicyControl.test.ts
git commit -m "feat(client): seed the policy control draft through the chain"
```

## Task 5: Render the starter control without machine defaults

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:1998-2020`
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

**Interfaces:**

- Consumes: existing `starterModelPolicyInputs(): { status: ClientSessionModelPolicyStatus; response: SessionModelPolicyResponse } | undefined`, existing module-scope `starterExactSelection(defaults: SessionDefaultsResponse): ExactModelSelection | undefined`, and `SessionDefaultsResponse = { model?: SessionModel; thinkingLevel: string; models: SessionModel[]; thinkingLevels: string[] }`.
- Produces: no new exports. `starterModelPolicyInputs` stops returning `undefined` when `starterExactSelection` is `undefined`, and instead reports a `blockedReason`.

Current code returns `undefined` when `starterExactSelection(defaults) === undefined`, so the control never renders on a fresh install. Replace that early return with an empty exact tuple plus a `blockedReason`. Keep the existing Tiered `blockedReason` behavior unchanged.

Reason strings, exactly:

- Catalog `models` array is empty: `No models are configured on this machine. Add one in Models settings before starting a session.`
- Otherwise: `Choose a model and thinking level before starting`.

- [ ] **Step 1: Write the failing test**

```ts
describe("starter with no usable machine defaults", () => {
  it("renders the policy control with empty selections instead of hiding it", async () => {
    const app = starterAppWith(starterDefaults({ model: undefined, thinkingLevel: "" }), validCatalog());

    expect(starterPolicyStatus(app)).toBeDefined();
    expect(starterPolicyStatus(app)?.blockedReason).toBe("Choose a model and thinking level before starting");
  });

  it("names the real problem when the machine has no models at all", async () => {
    const catalog = validCatalog();
    catalog.models = [];
    const app = starterAppWith(starterDefaults({ model: undefined, thinkingLevel: "" }), catalog);

    expect(starterPolicyStatus(app)?.blockedReason).toBe("No models are configured on this machine. Add one in Models settings before starting a session.");
  });

  it("still seeds from machine defaults when they are usable", async () => {
    const app = starterAppWith(starterDefaults(), validCatalog());

    const status = starterPolicyStatus(app);
    expect(status?.blockedReason).toBeUndefined();
    expect(status?.resolved).toEqual({ model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" });
  });
});
```

This file already defines `createApp()`, `appState(app)`, `starterState()`, `starterDefaults(overrides?)`, `validCatalog()`, and `validLadder()`. Reuse them; do not redefine.

Follow the starter-mount pattern already used by the starter tests in this file: build the app with `createApp()`, apply `starterState()`, set the starter defaults and the machine catalog through the same private fields those tests use, then await `updateComplete`. Read one existing starter test in this file first and copy its setup exactly rather than inventing a new harness.

Add two helpers:

```ts
function starterAppWith(defaults: SessionDefaultsResponse, catalog: ModelTierSettingsResponse): PiWebUiApp {
  const app = createApp();
  setAppState(app, starterState());
  if (!Reflect.set(app, "starterSessionDefaults", defaults)) throw new Error("Could not seed starterSessionDefaults");
  if (!Reflect.set(app, "modelTierCatalog", catalog)) throw new Error("Could not seed modelTierCatalog");
  if (!Reflect.set(app, "modelTierCatalogMachineId", "local")) throw new Error("Could not seed modelTierCatalogMachineId");
  return app;
}

function starterPolicyStatus(app: PiWebUiApp): ClientSessionModelPolicyStatus | undefined {
  const inputs: unknown = Reflect.get(app, "starterModelPolicyInputs");
  if (typeof inputs !== "function") throw new Error("starterModelPolicyInputs is not callable");
  const result = (inputs as () => { status: ClientSessionModelPolicyStatus } | undefined).call(app);
  return result?.status;
}
```

Assert against `starterPolicyStatus(app)`. Calling the projection directly keeps the test on the unit under change instead of on composer DOM that other tasks also touch.

Before writing these, open the file and confirm the exact private field names the catalog helpers read (`modelTierCatalog(app)` at roughly line 1004 dereferences them). If a name differs, use the file's actual name; the seeding above must match the fields `selectedMachineModelTierCatalog()` consults, or the catalog will read as absent and the models-empty assertion will not exercise the branch.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: FAIL, the control is `null` because `starterModelPolicyInputs` returned `undefined`.

- [ ] **Step 3: Write the minimal implementation**

In `starterModelPolicyInputs()`, replace the line `if (starterExactSelection(defaults) === undefined) return undefined;` with a computed selection and reason:

```ts
    const exact = starterExactSelection(defaults);
    const catalog = this.selectedMachineModelTierCatalog();
    const unstartableReason = exact !== undefined
      ? undefined
      : (catalog !== undefined && catalog.models.length === 0
        ? "No models are configured on this machine. Add one in Models settings before starting a session."
        : "Choose a model and thinking level before starting");
```

Keep the existing `const catalog = ...` line if it already appears below; do not declare `catalog` twice. Use `exact ?? { model: { provider: "", id: "" }, thinkingLevel: "" }` wherever the function currently relies on the machine-default tuple, including the `policy.exact` value it builds and the `resolved` field. Merge `unstartableReason` into the existing `blockedReason` spread so a Tiered reason still wins when both apply:

```ts
      ...(policy.mode === "tiered" && selectedTierEntry === undefined
        ? { blockedReason: catalog?.configError ?? "Choose a valid model tier before starting" }
        : unstartableReason === undefined ? {} : { blockedReason: unstartableReason }),
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "feat(client): render the starter policy control unconfigured"
```

## Task 6: Pin catalog loading and catalog failure behavior

**Implementer tier:** Standard

**Files:**

- Test: `src/client/src/components/SessionModelPolicyControl.test.ts`

**Interfaces:**

- Consumes: existing `loading` and `catalog` properties on `SessionModelPolicyControl`; existing `exactStatus()`, `tieredStatus()`, `exactResponse(exact?)`, `mountControl(configure)`, `openPanel(control)`, `shadowRoot(control)` helpers; `validCatalog()` from Task 3's additions if it is not already present in this file.
- Produces: no exports. Test-only task.

Spec cases 6 and 7 are safety claims with no production change required; this task proves they hold and fails if a later change breaks them.

Case 6, catalog still loading: the panel must keep the live confirmed tuple visible and must not assert a configuration error. The existing implementation renders `Loading model tier settings…` rather than the literal word `Unknown`; assert the actual behavior, and assert `.policy-current` still shows the resolved tuple.

Case 7, catalog failed: a control whose `catalog` is `undefined` and `loading` is `false` must still render its trigger with the live resolved tuple, and must not render a blocked diagnostic derived from the missing catalog.

- [ ] **Step 1: Write the failing test**

```ts
describe("catalog availability", () => {
  it("keeps the live tuple visible while the catalog is loading", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = undefined;
      element.loading = true;
      element.editable = true;
    });
    await openPanel(control);

    const current = shadowRoot(control).querySelector(".policy-current")?.textContent ?? "";
    expect(current).toContain(exactStatus().resolved.model.id);
    expect(shadowRoot(control).querySelector(".policy-unavailable")?.textContent ?? "").toContain("Loading model tier settings");
  });

  it("offers recovery rather than a configuration error when the catalog failed", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = undefined;
      element.loading = false;
      element.editable = true;
    });
    await openPanel(control);

    expect(shadowRoot(control).querySelector<HTMLButtonElement>(".policy-retry")?.disabled).toBe(false);
    expect(shadowRoot(control).querySelector(".policy-row-error")).toBeNull();
  });

  it("still renders the trigger with the confirmed tuple when the catalog is absent", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = undefined;
      element.editable = true;
    });

    expect(shadowRoot(control).querySelector(".policy-trigger")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes or fails honestly**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`

These assertions describe behavior the current implementation is believed to already have, so they may pass immediately. That is an acceptable outcome for a regression-pinning task. If any assertion fails, do not weaken it: report which spec case is violated and stop, because a failure here means Tasks 3 through 5 changed a safety property.

- [ ] **Step 3: Commit**

```bash
git add src/client/src/components/SessionModelPolicyControl.test.ts
git commit -m "test(client): pin model policy catalog loading and failure"
```

## Task 7: Docs, changeset, and full verification

**Implementer tier:** Standard

**Files:**

- Modify: `docs/config.md`
- Modify: `docs/config.html`
- Create: `.changeset/composer-model-policy-cascade.md`

**Interfaces:**

- Consumes: the behavior delivered by Tasks 1-6. No code changes in this task.
- Produces: no exports.

`docs/config.md` and `docs/config.html` must be updated together and describe the same behavior; the repository treats drift between them as a defect. Find the existing session model policy section in each and update it.

- [ ] **Step 1: Update both config documents**

In the session model policy section of `docs/config.md`, replace any description of a Save button with the completion-triggered behavior: a Tiered selection applies immediately; an Exact selection applies once both a model and a supported thinking level are set, coalesced over a short delay; there is no Save button. Add that an unconfigured machine renders the control with empty selections and an explanation rather than hiding it, and that a failed tier-settings fetch does not block sending because the session's confirmed model is unchanged.

Mirror the same content in `docs/config.html`, matching the surrounding markup style. Keep the two files' statements identical in substance.

- [ ] **Step 2: Verify the two documents agree**

Run: `diff <(grep -io "applies immediately\|thinking level\|no save button\|empty selections" docs/config.md | sort -u) <(grep -io "applies immediately\|thinking level\|no save button\|empty selections" docs/config.html | sort -u)`
Expected: no output, meaning both documents mention the same key phrases.

- [ ] **Step 3: Add the changeset**

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Session model policy applies as you choose it. Picking a tier applies
immediately, and an exact model applies once a supported thinking level is set,
so the panel no longer needs a Save button. A machine with no configured model
now shows the policy control with an explanation instead of hiding it.
```

Write that to `.changeset/composer-model-policy-cascade.md`.

- [ ] **Step 4: Run full verification**

Run: `HOME=$(mktemp -d) npm run verify`
Expected: exit 0. Typecheck and ESLint clean; Knip reports only its eight pre-existing configuration hints.

- [ ] **Step 5: Commit**

```bash
git add docs/config.md docs/config.html .changeset/composer-model-policy-cascade.md
git commit -m "docs(config): document cascading model policy selection"
```
