# Model Catalog Refresh After a Models-Dialog Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-read and publish the selected machine's model tier catalog after a
successful Settings → Models save, and re-read the active session policy when a
policy composer is showing, so a newly added model is selectable in the current
session without reloading the page.

**Architecture:** All production edits are in
`src/client/src/components/PiWebUiApp.ts`. The catalog load path gains a
`"machine" | "machine-workspace"` guard scope and a `Promise<boolean>` result
(`true` only when that request published); the ladder-save publish and policy
revalidation tail becomes two shared private helpers used by both the load path
and the ladder-save handler; the Models dialog's existing `onSaved` callback is
bound to a new machine-scoped refresh that publishes through those helpers and
revalidates only after a successful publish. `ModelsConfigDialog`, the server,
the API contract, and configuration are unchanged.

**Tech Stack:** TypeScript (strict), Lit component templates, Vitest
(node-environment component-boundary suites with TemplateResult inspection),
ESLint, knip, Changesets, npm, Git.

## Global Constraints

- Allowed files (and only these): modify `src/client/src/components/PiWebUiApp.ts`, `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`, and `src/client/src/components/PiWebUiApp.modelsConfig.test.ts`; create `.changeset/model-catalog-refresh-after-save.md`. Do not modify `src/client/src/components/ModelsConfigDialog.ts`, `src/client/src/components/sessionModelPolicyDraft.ts`, any `src/server/**` file (including `src/server/sessiond.ts`), `src/shared/apiTypes.ts`, any `src/client/src/api/**` file, `.pi-webui/config.json`, `package.json`, `README.md`, any `docs/**` file, or `CHANGELOG.md`.
- The change is client-only: no server, sessiond, protocol, browser-API-contract, endpoint, field, parameter, or capability change; no session-daemon restart and no data migration.
- No new dependencies, endpoints, fields, parameters, capabilities, or configuration keys; the refresh reuses `modelTiersApi.settings(machineId)` exactly as the existing catalog loads do.
- No UI change: no new dialog, toast, retry button, or visual treatment; reuse the existing dialog saved message and the existing `modelTierCatalogError` diagnostic.
- No automatic substitution or repair of a removed model; a removed selection stays visibly selected until the user repairs it.
- `loadModelTierCatalog`'s default guard stays `"machine-workspace"`, preserving every existing caller byte-for-byte; only the save-triggered refresh passes `"machine"`.
- `CHANGELOG.md` is not edited; exactly one `patch` Changeset is created at `.changeset/model-catalog-refresh-after-save.md` with the pinned body from Task 3.
- Run focused tests with `npm test -- --run <test-file>`, types with `npm run typecheck`, lint with `npx eslint <changed-files>`, and the completion gate with `npm run verify:fast`; the PM runs `npm run verify` (serial profile) before the final audit.

## Task 1: Report whether a catalog load published

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:507-511`
- Modify: `src/client/src/components/PiWebUiApp.ts:2052-2062`
- Modify: `src/client/src/components/PiWebUiApp.ts:2064-2088`
- Modify: `src/client/src/components/PiWebUiApp.ts:2090-2098`
- Modify: `src/client/src/components/PiWebUiApp.ts:2188`
- Modify: `src/client/src/components/PiWebUiApp.ts:4934` (insert the guard type alias immediately before `function activePolicyComposerScope`)
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts:2722-2741`
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts:2913-2915`
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts` (insert the new describe immediately before `describe("PiWebUiApp model tier catalog save publish"`)

**Interfaces:**

- Consumes: `modelTiersApi.settings(machineId: string): Promise<ModelTierSettingsResponse>` from the existing `../api` client; `selectedMachineId(state: Pick<AppState, "selectedMachine">): string` from `../controllers/types`; `activePolicyComposerScope(state: AppState): string | undefined` (module scope, `PiWebUiApp.ts:4934`); `this.completeStarterModelPolicyFromActiveTier(): void` (`PiWebUiApp.ts:2154`); `this.sessions.loadModelPolicy()`; `ModelTierSettingsResponse` from `../../../shared/apiTypes`.
- Produces: `type ModelTierCatalogLoadGuard = "machine" | "machine-workspace";`; `private modelTierCatalogLoad: { machineId: string; workspaceId: string | undefined; promise: Promise<boolean> } | undefined;`; `private loadModelTierCatalog(machineId: string, guard?: ModelTierCatalogLoadGuard): Promise<boolean>` (default `"machine-workspace"`, resolves `true` only when that request published); `private async performModelTierCatalogLoad(machineId: string, workspaceId: string | undefined, seq: number, guard: ModelTierCatalogLoadGuard): Promise<boolean>`; `private ensureModelTierCatalog(machineId: string): Promise<boolean>`.

- [ ] **Step 1: Update the two catalog test helpers and add `isPromiseOfBoolean`**

In `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`, replace the
existing `loadModelTierCatalog` and `ensureModelTierCatalog` helpers (lines
2722-2741) with:

```ts
function loadModelTierCatalog(
  app: PiWebUiApp,
  machineId: string,
  guard?: "machine" | "machine-workspace",
): Promise<boolean> {
  const method: unknown = Reflect.get(app, "loadModelTierCatalog");
  if (typeof method !== "function") throw new Error("PiWebUiApp.loadModelTierCatalog is not callable");
  const result: unknown = Reflect.apply(method, app, guard === undefined ? [machineId] : [machineId, guard]);
  if (!isPromiseOfBoolean(result)) throw new Error("PiWebUiApp.loadModelTierCatalog did not return a promise");
  return result;
}

function ensureModelTierCatalog(app: PiWebUiApp, machineId: string): Promise<boolean> {
  const method: unknown = Reflect.get(app, "ensureModelTierCatalog");
  if (typeof method !== "function") throw new Error("PiWebUiApp.ensureModelTierCatalog is not callable");
  const result: unknown = Reflect.apply(method, app, [machineId]);
  if (!isPromiseOfBoolean(result)) throw new Error("PiWebUiApp.ensureModelTierCatalog did not return a promise");
  return result;
}
```

Keep `isPromise(value: unknown): value is Promise<void>` unchanged, and add this
function immediately after it:

```ts
function isPromiseOfBoolean(value: unknown): value is Promise<boolean> {
  return value instanceof Promise;
}
```

- [ ] **Step 2: Write the failing load-result tests A1-A3**

Insert this describe immediately before
`describe("PiWebUiApp model tier catalog save publish", () => {`:

```ts
describe("PiWebUiApp model tier catalog load result", () => {
  it("returns true from the request that published the catalog", async () => {
    const app = createApp();
    setAppState(app, starterState());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());

    await expect(loadModelTierCatalog(app, "local")).resolves.toBe(true);

    expect(modelTierCatalog(app)).toEqual(validCatalog());
  });

  it("returns false from a failed request and keeps the failure visible", async () => {
    const app = createApp();
    setAppState(app, starterState());
    vi.spyOn(modelTiersApi, "settings").mockRejectedValue(new Error("catalog offline"));

    await expect(loadModelTierCatalog(app, "local")).resolves.toBe(false);

    expect(modelTierCatalog(app)).toBeUndefined();
    expect(modelTierCatalogError(app)).toContain("catalog offline");
    expect(modelTierCatalogLoading(app)).toBe(false);
  });

  it("returns false from a request superseded by a newer load", async () => {
    const app = createApp();
    setAppState(app, starterState());
    const slow = deferred<ModelTierSettingsResponse>();
    vi.spyOn(modelTiersApi, "settings")
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(validCatalog());

    const first = loadModelTierCatalog(app, "local");
    await loadModelTierCatalog(app, "local");
    slow.resolve({ ...validCatalog(), valid: false, configError: "stale" });

    await expect(first).resolves.toBe(false);
    expect(modelTierCatalog(app)).toEqual(validCatalog());
    expect(modelTierCatalogLoading(app)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests and confirm A1-A3 fail**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: FAIL. The three new tests fail because the current
`loadModelTierCatalog` resolves `undefined`; the first two report
`expected undefined to be true` and `expected undefined to be false`, and the
superseded-request test reports `expected undefined to be false`. Every
pre-existing test in the file still passes.

- [ ] **Step 4: Add the guard union type**

Insert immediately before `function activePolicyComposerScope(state: AppState): string | undefined {`:

```ts
type ModelTierCatalogLoadGuard = "machine" | "machine-workspace";
```

- [ ] **Step 5: Widen the in-flight handle to `Promise<boolean>`**

Replace the `modelTierCatalogLoad` field (lines 507-511) with:

```ts
  private modelTierCatalogLoad: {
    machineId: string;
    workspaceId: string | undefined;
    promise: Promise<boolean>;
  } | undefined;
```

`modelTierCatalogMachineId` (line 503) and `modelTierCatalogSeq` (line 505) are
unchanged.

- [ ] **Step 6: Replace `loadModelTierCatalog` with the guard-aware boolean version**

Replace the existing method (lines 2052-2062) with:

```ts
  /**
   * Fetch the selected machine's tier catalog for whichever policy control is
   * open. Two independent guards protect the single shared field: the response
   * must still belong to the machine (and, unless the caller asked for the
   * machine-only scope, the workspace) it was issued for, and it must be the
   * newest issued request, so neither a machine/workspace switch nor a slow
   * earlier response can publish a catalog the user is no longer looking at.
   * The resolved boolean is true only when this request published.
   */
  private loadModelTierCatalog(
    machineId: string,
    guard: ModelTierCatalogLoadGuard = "machine-workspace",
  ): Promise<boolean> {
    const workspaceId = this.state.selectedWorkspace?.id;
    const seq = ++this.modelTierCatalogSeq;
    const promise = this.performModelTierCatalogLoad(machineId, workspaceId, seq, guard);
    this.modelTierCatalogLoad = { machineId, workspaceId, promise };
    const clear = () => {
      if (this.modelTierCatalogLoad?.promise === promise) this.modelTierCatalogLoad = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }
```

The default `"machine-workspace"` preserves every existing caller
(`ensureModelTierCatalog` and direct test loads). `workspaceId` is still captured
for handle sharing; the guard consults it only when
`guard === "machine-workspace"`. The clear-on-settle logic is unchanged,
including the rejection branch.

- [ ] **Step 7: Replace `performModelTierCatalogLoad` with the guard-aware boolean version**

Replace the existing method (lines 2064-2088) with:

```ts
  private async performModelTierCatalogLoad(
    machineId: string,
    workspaceId: string | undefined,
    seq: number,
    guard: ModelTierCatalogLoadGuard,
  ): Promise<boolean> {
    const isCurrent = () => (
      seq === this.modelTierCatalogSeq
      && selectedMachineId(this.state) === machineId
      && (guard === "machine" || this.state.selectedWorkspace?.id === workspaceId)
    );
    this.modelTierCatalogLoading = true;
    this.modelTierCatalogError = "";
    try {
      const catalog = await modelTiersApi.settings(machineId);
      if (!isCurrent()) return false;
      this.modelTierCatalogMachineId = machineId;
      this.modelTierCatalog = catalog;
      this.completeStarterModelPolicyFromActiveTier();
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      this.modelTierCatalogError = errorMessage(error);
      return false;
    } finally {
      if (seq === this.modelTierCatalogSeq) this.modelTierCatalogLoading = false;
    }
  }
```

Behavior preserved from the current inline code: the request clears
`modelTierCatalogError` at start and sets `errorMessage(error)` only for a
current failure; a superseded response returns `false` before mutating anything.

- [ ] **Step 8: Replace `ensureModelTierCatalog` and update the dependent annotation**

Replace the existing `ensureModelTierCatalog` (lines 2090-2098) with:

```ts
  private ensureModelTierCatalog(machineId: string): Promise<boolean> {
    if (this.selectedMachineModelTierCatalog() !== undefined) return Promise.resolve(true);
    const workspaceId = this.state.selectedWorkspace?.id;
    const current = this.modelTierCatalogLoad;
    if (current?.machineId === machineId && current.workspaceId === workspaceId) {
      return current.promise;
    }
    return this.loadModelTierCatalog(machineId);
  }
```

Then, inside `prepareActiveModelPolicyDraft`, change line 2188 from
`const loads: Promise<void>[] = [];` to:

```ts
    const loads: Promise<unknown>[] = [];
```

The return type is forced because the method returns the shared handle's
`Promise<boolean>` directly. `Promise<unknown>[]` is required rather than a
void-bearing union: `Promise<boolean | void>[]` fails the repository's strict
ESLint rule `@typescript-eslint/no-invalid-void-type`. All other call sites use
`await` or `void` and compile unchanged.

- [ ] **Step 9: Run the focused suite and confirm all tests pass**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: PASS. A1-A3 now resolve `true`/`false`/`false`, and the existing
stale-guard and save-publish describes stay green.

- [ ] **Step 10: Typecheck and lint the changed files**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: exit 0, no warnings.

- [ ] **Step 11: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "refactor(client): report catalog load publishes with a boolean result"
```

## Task 2: Share the catalog publish and policy revalidation paths

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:2064-2088` (success branch publishes through the new helper)
- Modify: `src/client/src/components/PiWebUiApp.ts:2121-2152` (insert both helpers after `resetModelTierCatalogForMachineChange`; replace `handleModelTiersSaved`)
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts` (insert test B11 as the final `it` in the `PiWebUiApp model tier catalog save publish` describe, immediately before `describe("PiWebUiApp starter defaults capability ordering"`)

**Interfaces:**

- Consumes: `private loadModelTierCatalog(machineId: string, guard?: ModelTierCatalogLoadGuard): Promise<boolean>` and `private async performModelTierCatalogLoad(machineId: string, workspaceId: string | undefined, seq: number, guard: ModelTierCatalogLoadGuard): Promise<boolean>` from Task 1; `selectedMachineId(state): string`; `activePolicyComposerScope(state): string | undefined`; `this.completeStarterModelPolicyFromActiveTier(): void`; `this.sessions.loadModelPolicy()`; `ModelTierSettingsResponse` from `../../../shared/apiTypes`.
- Produces: `private publishMachineModelTierCatalog(machineId: string, catalog: ModelTierSettingsResponse): void`; `private revalidateActiveModelPolicyAfterTierCatalogChange(): void`; `handleModelTiersSaved` keeps its leading selected-machine guard and now calls both helpers.

- [ ] **Step 1: Write the shared-path guard regression test B11**

Insert this test as the final `it` inside the
`PiWebUiApp model tier catalog save publish` describe, immediately before
`describe("PiWebUiApp starter defaults capability ordering", () => {`:

```ts
  it("does not re-read the session policy for a ladder save of a machine the user is not viewing", () => {
    const app = policyCapableActiveApp();
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();

    invokeModelTiersSaved(app, "remote-other", validCatalog());

    expect(modelTierCatalog(app)).toEqual(validCatalog());
    expect(loadModelPolicy).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Confirm the pin passes against the current handler**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts -t "does not re-read the session policy for a ladder save of a machine the user is not viewing"`
Expected: PASS, 1 test. This is a characterization pin for the guard that must
survive the refactor.

- [ ] **Step 3: Prove the pin is falsifiable, then restore the guard**

Temporarily delete the single line
`if (selectedMachineId(this.state) !== machineId) return;` from
`handleModelTiersSaved` and run the same command as Step 2.

Expected: FAIL, with `loadModelPolicy` called and/or the selected-machine
catalog projection unchanged.

Restore the line exactly as it was, then re-run the Step 2 command.
Expected: PASS, 1 test.

- [ ] **Step 4: Insert `publishMachineModelTierCatalog`**

Insert immediately after the closing brace of
`resetModelTierCatalogForMachineChange` and before
`private handleModelTiersSaved(`:

```ts
  /**
   * Publish a successful catalog read or ladder save as the selected machine's
   * catalog so the composer's controls update without a reload. The save
   * supersedes any load still in flight: the sequence bump retires it (it can
   * no longer publish, and its `finally` skips the loading flag, which is why
   * the flag is cleared here) and the shared load handle is dropped. A publish
   * for a machine the user is not viewing is ignored because the catalog is a
   * per-machine projection.
   */
  private publishMachineModelTierCatalog(machineId: string, catalog: ModelTierSettingsResponse): void {
    if (selectedMachineId(this.state) !== machineId) return;
    this.modelTierCatalogMachineId = machineId;
    this.modelTierCatalog = catalog;
    this.modelTierCatalogError = "";
    this.modelTierCatalogSeq += 1;
    this.modelTierCatalogLoad = undefined;
    this.modelTierCatalogLoading = false;
    this.completeStarterModelPolicyFromActiveTier();
  }
```

- [ ] **Step 5: Insert `revalidateActiveModelPolicyAfterTierCatalogChange`**

Insert directly after `publishMachineModelTierCatalog`:

```ts
  /**
   * `ladderValid` and `blockedReason` in the published session status are
   * computed server-side and stale after a tier-catalog change, so re-read the
   * active policy only when the composer is actually showing it.
   */
  private revalidateActiveModelPolicyAfterTierCatalogChange(): void {
    if (activePolicyComposerScope(this.state) !== undefined) void this.sessions.loadModelPolicy();
  }
```

- [ ] **Step 6: Replace `handleModelTiersSaved` to call both helpers**

Replace the whole method with:

```ts
  private handleModelTiersSaved(machineId: string, response: ModelTierSettingsResponse): void {
    if (selectedMachineId(this.state) !== machineId) return;
    this.publishMachineModelTierCatalog(machineId, response);
    this.revalidateActiveModelPolicyAfterTierCatalogChange();
  }
```

The leading guard is deliberately retained even though
`publishMachineModelTierCatalog` repeats it. The publish helper returns `void`,
so the handler's own guard is what keeps revalidation gated on an actual publish;
without it, a ladder save for a machine the user is not viewing would newly
re-read the active session policy.

- [ ] **Step 7: Publish through the helper from the load path**

In `performModelTierCatalogLoad`, replace the success-branch publish lines

```ts
      this.modelTierCatalogMachineId = machineId;
      this.modelTierCatalog = catalog;
      this.completeStarterModelPolicyFromActiveTier();
```

with:

```ts
      this.publishMachineModelTierCatalog(machineId, catalog);
```

- [ ] **Step 8: Run the focused suite and confirm everything passes**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: PASS. The stale-guard describe, the save-publish describe (including
B11), the load-result describe from Task 1, and every other test in the file are
green.

- [ ] **Step 9: Typecheck and lint the changed files**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: exit 0, no warnings.

- [ ] **Step 10: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "refactor(client): share the model tier catalog publish and revalidation paths"
```

## Task 3: Refresh the catalog after a Models-dialog save

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts` (the single line rendering `<models-config-dialog>`; `grep -n "models-config-dialog" src/client/src/components/PiWebUiApp.ts` must report exactly one match)
- Modify: `src/client/src/components/PiWebUiApp.ts` (insert two private methods immediately after `handleModelTiersSaved`)
- Test: `src/client/src/components/PiWebUiApp.modelsConfig.test.ts`
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
- Create: `.changeset/model-catalog-refresh-after-save.md`

**Interfaces:**

- Consumes: `private loadModelTierCatalog(machineId: string, guard?: ModelTierCatalogLoadGuard): Promise<boolean>` from Task 1; `private revalidateActiveModelPolicyAfterTierCatalogChange(): void` from Task 2; `selectedMachineId(state): string`; the existing `onSaved?: () => void` property contract on `ModelsConfigDialog` (`ModelsConfigDialog.ts:77`, invoked after a successful save while the saved machine is still selected); `modelTiersApi.settings(machineId: string): Promise<ModelTierSettingsResponse>`; `ModelTierSettingsResponse`, `ModelTierModelOption`, and `Machine` from `../../../shared/apiTypes`.
- Produces: `private handleModelsConfigSaved(): void`; `private async refreshModelTierCatalogAfterModelsSave(): Promise<void>`; the `.onSaved=${() => { this.handleModelsConfigSaved(); }}` binding on `<models-config-dialog>`.

- [ ] **Step 1: Prepare `PiWebUiApp.modelsConfig.test.ts`**

Change the `afterEach` to restore mocks before unstubbing globals:

```ts
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
```

Convert the type-only `../api` import to a value import (a value cannot be added
to a type-only import; `ModelTierSettingsResponse` and `Machine` are already
re-exported from `../api`):

```ts
import { modelTiersApi, type Machine, type ModelTierSettingsResponse, type Project } from "../api";
```

Add these fixtures immediately after the existing `project` fixture:

```ts
const remoteMachine: Machine = {
  id: "remote-a",
  name: "Remote build host",
  kind: "remote",
  baseUrl: "https://remote.example.test/",
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

function wiringCatalog(): ModelTierSettingsResponse {
  return {
    contractVersion: 1,
    models: [],
    rows: {
      economy: { valid: true },
      fast: { valid: true },
      standard: { valid: true },
      advanced: { valid: true },
      capable: { valid: true },
      frontier: { valid: true },
    },
    valid: true,
  };
}
```

Add this helper immediately after `sessionBrowserDialogTemplate`:

```ts
function invokeModelsConfigOnSaved(app: PiWebUiApp): void {
  const dialog = findTemplateContaining(renderApp(app), "<models-config-dialog");
  if (dialog === undefined) throw new Error("PiWebUiApp did not render models-config-dialog");
  const callback: unknown = templateValueAfterMarker(dialog, ".onSaved=");
  if (typeof callback !== "function") throw new Error("models-config-dialog did not bind onSaved");
  Reflect.apply(callback, undefined, []);
}
```

- [ ] **Step 2: Write the failing wiring test W1**

Insert this describe immediately before
`type RenderNavigationPanel = (this: PiWebUiApp) => TemplateResult;`:

```ts
describe("PiWebUiApp models config save wiring", () => {
  it("binds the Models dialog onSaved callback to a refresh of the selected machine's tier catalog", () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), selectedMachine: remoteMachine });
    const settings = vi.spyOn(modelTiersApi, "settings").mockResolvedValue(wiringCatalog());
    Reflect.set(app, "modelsConfigDialogOpen", true);

    const dialog = findTemplateContaining(renderApp(app), "<models-config-dialog");
    if (dialog === undefined) throw new Error("PiWebUiApp did not render models-config-dialog");
    expect(typeof templateValueAfterMarker(dialog, ".onSaved=")).toBe("function");

    invokeModelsConfigOnSaved(app);

    expect(settings).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledWith("remote-a");
  });
});
```

- [ ] **Step 3: Run the wiring test and confirm it fails**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.modelsConfig.test.ts`
Expected: FAIL with `Expected template marker .onSaved=`; the rest of the file
passes.

- [ ] **Step 4: Add the session-policy catalog fixtures**

In `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`, insert
immediately after the `repairModelOption` declaration:

```ts
const newModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-new" },
  name: "New",
  // The draft's current thinking level must be present: `updateDraftExactModel`
  // blanks an unsupported level (`sessionModelPolicyDraft.ts:137-151`), and the
  // starter-path test below depends on "medium" surviving the pick.
  thinkingLevels: ["low", "medium", "high"],
};
```

Insert these functions immediately after the `validCatalog()` function, before
`invalidTierCatalog`:

```ts
function catalogWithNewModel(): ModelTierSettingsResponse {
  const catalog = validCatalog();
  return { ...catalog, models: [...catalog.models, newModelOption] };
}

function catalogWithNewStandardModel(): ModelTierSettingsResponse {
  const catalog = catalogWithNewModel();
  return {
    ...catalog,
    ladder: { ...validLadder(), standard: { model: { provider: "openai", id: "gpt-new" }, thinkingLevel: "medium" } },
  };
}

function catalogWithoutDefaultModel(): ModelTierSettingsResponse {
  const catalog = validCatalog();
  return { ...catalog, models: catalog.models.filter((option) => option.model.id !== "gpt-default") };
}
```

- [ ] **Step 5: Add the `invokeModelsConfigSaved` helper**

Insert immediately after the `invokeModelTiersSaved` helper:

```ts
/**
 * Open the Models dialog overlay and invoke the `.onSaved=` handler bound on
 * `<models-config-dialog>`, so these tests exercise the real render wiring
 * rather than the private handler alone.
 */
function invokeModelsConfigSaved(app: PiWebUiApp): void {
  if (!Reflect.set(app, "modelsConfigDialogOpen", true)) throw new Error("Could not open the Models dialog");
  const dialog = findTemplateContaining(renderApp(app), "<models-config-dialog");
  if (dialog === undefined) throw new Error("PiWebUiApp did not render models-config-dialog");
  const callback: unknown = templateValueAfterMarker(dialog, ".onSaved=");
  if (typeof callback !== "function") throw new Error("models-config-dialog did not bind onSaved");
  Reflect.apply(callback, undefined, []);
}
```

- [ ] **Step 6: Write the failing save-refresh tests B1-B10 and B12**

Insert this describe immediately before
`describe("PiWebUiApp starter defaults capability ordering", () => {`:

```ts
describe("PiWebUiApp models config save catalog refresh", () => {
  it("makes a newly saved model selectable through the active policy picker without a reload", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const settings = vi.spyOn(modelTiersApi, "settings").mockResolvedValue(catalogWithNewModel());
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    invokeModelsConfigSaved(app);
    await flush();
    await pickModel(app, "openai/gpt-new");
    await timers.runAll();

    expect(settings).toHaveBeenCalledWith(remoteMachine.id);
    expect(modelTierCatalog(app)).toEqual(catalogWithNewModel());
    expect(saveModelPolicy).toHaveBeenCalledOnce();
    expect(saveModelPolicy).toHaveBeenCalledWith({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-new" }, thinkingLevel: "medium" },
    });
    expect(modelTierCatalogError(app)).toBe("");
  });

  it("re-reads the active session policy once after a save-triggered refresh publishes", async () => {
    const app = policyCapableActiveApp();
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(catalogWithNewModel());

    invokeModelsConfigSaved(app);
    await flush();

    expect(loadModelPolicy).toHaveBeenCalledTimes(1);
  });

  it("does not re-read the session policy when no policy composer is showing", async () => {
    const app = createApp();
    setAppState(app, starterState());
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(catalogWithNewModel());

    invokeModelsConfigSaved(app);
    await flush();

    expect(loadModelPolicy).not.toHaveBeenCalled();
    expect(modelTierCatalog(app)).toEqual(catalogWithNewModel());
  });

  it("keeps the previous catalog and skips policy revalidation when the save-triggered refresh fails", async () => {
    const app = policyCapableActiveApp();
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();
    vi.spyOn(modelTiersApi, "settings").mockRejectedValue(new Error("catalog offline"));

    invokeModelsConfigSaved(app);
    await flush();

    expect(modelTierCatalog(app)).toEqual(validCatalog());
    expect(modelTierCatalogError(app)).toContain("catalog offline");
    expect(modelTierCatalogLoading(app)).toBe(false);
    expect(loadModelPolicy).not.toHaveBeenCalled();
    expect(appState(app).error).toBe("");
  });

  it("releases a failed save-triggered load so ensure issues a fresh request", async () => {
    const app = policyCapableActiveApp();
    Reflect.set(app, "modelTierCatalog", undefined);
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();
    const settings = vi.spyOn(modelTiersApi, "settings")
      .mockRejectedValueOnce(new Error("catalog offline"))
      .mockResolvedValueOnce(catalogWithNewModel());

    invokeModelsConfigSaved(app);
    await flush();

    expect(modelTierCatalog(app)).toBeUndefined();
    expect(modelTierCatalogError(app)).toContain("catalog offline");
    expect(loadModelPolicy).not.toHaveBeenCalled();

    const retried = await ensureModelTierCatalog(app, remoteMachine.id);

    expect(settings).toHaveBeenCalledTimes(2);
    expect(retried).toBe(true);
    expect(modelTierCatalog(app)).toEqual(catalogWithNewModel());
    expect(modelTierCatalogError(app)).toBe("");
  });

  it("drops a save-triggered refresh whose machine is no longer selected", async () => {
    const app = createApp();
    setAppState(app, starterState());
    const pending = deferred<ModelTierSettingsResponse>();
    const settings = vi.spyOn(modelTiersApi, "settings")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(catalogWithNewModel());
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();

    invokeModelsConfigSaved(app);

    expect(settings).toHaveBeenCalledWith("local");

    setAppState(app, activeState({
      selectedMachine: remoteMachine,
      machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.sessionsModelPolicy]) },
      modelPolicy: exactPolicyResponse(),
      availableThinkingLevels: ["off", "low", "medium", "high"],
    }));
    pending.resolve(validCatalog());
    await flush();

    expect(modelTierCatalog(app)).toBeUndefined();
    expect(loadModelPolicy).not.toHaveBeenCalled();

    await loadModelTierCatalog(app, remoteMachine.id);

    expect(modelTierCatalog(app)).toEqual(catalogWithNewModel());
    expect(loadModelPolicy).not.toHaveBeenCalled();
  });

  it("publishes a save-triggered refresh across a workspace switch and completes the new workspace's starter draft from it", async () => {
    const app = createApp();
    const saveLoad = deferred<ModelTierSettingsResponse>();
    const settings = vi.spyOn(modelTiersApi, "settings").mockReturnValue(saveLoad.promise);
    vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2WithoutResolvedModel());
    setAppState(app, { ...fullPreferenceCapableStarterState(), workspaces: [mainWorkspace, featureWorkspace] });
    setModelTierCatalog(app, validCatalog(), "local");
    await loadStarterSessionDefaults(app, mainWorkspace);

    invokeModelsConfigSaved(app);

    const previous = appState(app);
    const next: AppState = { ...previous, selectedWorkspace: featureWorkspace, workspaces: [mainWorkspace, featureWorkspace] };
    stubWorkspaceChangeSideEffects(app);
    setRouteRestoreInProgress(app);
    setAppState(app, next);
    handleWorkspaceChange(app, previous, next);
    saveLoad.resolve(catalogWithNewStandardModel());
    await flush();

    expect(modelTierCatalog(app)).toEqual(catalogWithNewStandardModel());
    expect(starterModelPolicy(app)).toBeUndefined();

    await loadStarterSessionDefaults(app, featureWorkspace);

    expect(starterModelPolicy(app)).toEqual({
      mode: "tiered",
      tier: "standard",
      exact: { model: { provider: "openai", id: "gpt-new" }, thinkingLevel: "medium" },
    });
    expect(settings).toHaveBeenCalledOnce();
  });

  it("makes a newly saved model selectable for a full-capability starter draft", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(catalogWithNewModel());
    setAppState(app, fullPreferenceCapableStarterState());
    setModelTierCatalog(app, validCatalog(), "local");
    await loadStarterSessionDefaults(app, mainWorkspace);

    invokeModelsConfigSaved(app);
    await flush();
    await pickStarterModel(app, "openai/gpt-new");

    expect(modelTierCatalog(app)).toEqual(catalogWithNewModel());
    expect(starterModelPolicy(app)).toEqual({
      mode: "tiered",
      tier: "standard",
      exact: { model: { provider: "openai", id: "gpt-new" }, thinkingLevel: "medium" },
    });
  });

  it("lets a ladder save that publishes mid-flight win over an older save-triggered refresh", async () => {
    const app = policyCapableActiveApp();
    const saveLoad = deferred<ModelTierSettingsResponse>();
    vi.spyOn(modelTiersApi, "settings").mockReturnValueOnce(saveLoad.promise);
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();
    const ladderCatalog: ModelTierSettingsResponse = { ...validCatalog(), configError: "ladder publish" };

    invokeModelsConfigSaved(app);
    invokeModelTiersSaved(app, remoteMachine.id, ladderCatalog);
    saveLoad.resolve(catalogWithNewModel());
    await flush();

    expect(modelTierCatalog(app)).toEqual(ladderCatalog);
    expect(modelTierCatalogError(app)).toBe("");
    expect(modelTierCatalogLoading(app)).toBe(false);
    expect(loadModelPolicy).toHaveBeenCalledTimes(1);
  });

  it("makes a removed model fail closed after a save-triggered refresh without substituting a selection", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(catalogWithoutDefaultModel());
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    invokeModelsConfigSaved(app);
    await flush();
    await pickModel(app, "openai/gpt-default");
    await timers.runAll();

    expect(modelTierCatalog(app)).toEqual(catalogWithoutDefaultModel());
    expect(saveModelPolicy).not.toHaveBeenCalled();
    expect(modelTierCatalogError(app)).toBe("Model openai/gpt-default is unavailable in the model policy catalog");
    expect(timers.size()).toBe(0);
    expect(promptEditorStatus(promptEditorTemplate(app)).model).toEqual({ provider: "openai", id: "gpt-default" });
  });

  it("publishes the refreshed catalog without a policy re-read for an archived selected session", async () => {
    const app = createApp();
    setAppState(app, activeState({
      status: undefined,
      selectedSession: { ...activeSession(), archived: true },
    }));
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(catalogWithNewModel());

    invokeModelsConfigSaved(app);
    await flush();

    expect(modelTierCatalog(app)).toEqual(catalogWithNewModel());
    expect(loadModelPolicy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run the new tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: FAIL. Exactly the eleven new save-refresh tests fail with
`Expected template marker .onSaved=`; all pre-existing tests, including Task 1's
load-result tests and Task 2's B11, pass.

- [ ] **Step 8: Add the save handler and the refresh**

Insert immediately after the closing brace of `handleModelTiersSaved`:

```ts
  private handleModelsConfigSaved(): void {
    void this.refreshModelTierCatalogAfterModelsSave();
  }

  /**
   * A Models-dialog save changed this machine's `models.json`, so re-read the
   * machine-global tier catalog even when one is already published and publish
   * it as the current projection. Only a successful publish revalidates the
   * active session policy, so a failed refresh cannot mask the catalog
   * diagnostic with a policy error.
   */
  private async refreshModelTierCatalogAfterModelsSave(): Promise<void> {
    const machineId = selectedMachineId(this.state);
    const published = await this.loadModelTierCatalog(machineId, "machine");
    if (published) this.revalidateActiveModelPolicyAfterTierCatalogChange();
  }
```

`loadModelTierCatalog`, not `ensureModelTierCatalog`, is deliberately used:
refreshing an already-published cache is the point of the change. The
`"machine"` guard is deliberately narrower than the default and is the only
caller that omits the workspace check, because the tier catalog is
machine-global and a workspace switch must not discard the refresh the save
requested.

- [ ] **Step 9: Bind the Models dialog `onSaved` callback**

Find the single template line rendering `<models-config-dialog>` with
`grep -n "models-config-dialog" src/client/src/components/PiWebUiApp.ts` and
append the `.onSaved` binding so the line reads:

```ts
        ${this.modelsConfigDialogOpen ? html`<models-config-dialog .machine=${state.selectedMachine} .onClose=${() => { this.modelsConfigDialogOpen = false; }} .onConfigureAuth=${() => { void this.auth.openLogin(); }} .onSaved=${() => { this.handleModelsConfigSaved(); }}></models-config-dialog>` : null}
```

`ModelsConfigDialog` itself is unchanged: it already declares
`onSaved?: () => void` and invokes it only after a successful save and only while
the saved machine is still the dialog's machine.

- [ ] **Step 10: Create the patch Changeset**

Create `.changeset/model-catalog-refresh-after-save.md` with exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Refresh the model policy catalog after saving models in Settings so a newly added model can be selected in the current session without reloading the page.
```

End the file with a trailing newline. Do not edit `CHANGELOG.md`.

- [ ] **Step 11: Run both focused suites and confirm they pass**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.modelsConfig.test.ts`
Expected: PASS. W1, B1-B10, B12, Task 1's A1-A3, Task 2's B11, and every
pre-existing test in both files are green.

- [ ] **Step 12: Typecheck and lint the changed files**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.modelsConfig.test.ts`
Expected: exit 0, no warnings.

- [ ] **Step 13: Run the completion gate**

Run: `npm run verify:fast`
Expected: exit 0 (typecheck, lint, knip, and the fast test suite).

- [ ] **Step 14: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.modelsConfig.test.ts .changeset/model-catalog-refresh-after-save.md
git commit -m "fix(client): refresh the model tier catalog after a models-config save" -m "Publish the selected machine's tier catalog after a successful Models-dialog save and revalidate the active session policy when a policy composer is showing, so a newly added model is usable without a page reload."
```
