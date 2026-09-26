# Technical Specification: Model Catalog Refresh After a Models-Dialog Save

**Date:** 2026-09-26
**Status:** Approved (user sign-off, 2026-09-26); spec review clean (round 2, zero blockers; four documentation corrections applied)
**Related design document:** `docs/superpowers/specs/2026-09-26-model-catalog-refresh-after-save-design.md` (sha256 `4be8eb7a77cd6b8dbb23122aca0edb3be9b850922a9e3b8a693d4938c5b4f600`, committed at `5e656a7`)
**Target package:** `@hyperdreamer/pi-webui`
**Change class:** user-visible patch (bug fix; adds no capability, API surface, or configuration)
**Operation class:** client-only. Only files loaded by the web/API + Vite UI development process change, so the autoreloading `pi-webui-ui-dev.service` path applies. No session-daemon restart, protocol change, or data migration.
**Delivery target:** `refs/heads/main` @ `13d4c52c7597160317fa7bdcc9504518f92006f0`; verified against integration worktree HEAD `5e656a7`.

Every `file:line` reference below was verified by reading the file at worktree HEAD `5e656a7`. The only production file edited is `src/client/src/components/PiWebUiApp.ts`.

---

## 1. Scope

### 1.1 What changes

1. **Wire the existing dialog callback.** `PiWebUiApp.ts:4863` renders `<models-config-dialog>` with `.machine`, `.onClose`, and `.onConfigureAuth` but no `.onSaved`. Append `.onSaved=${() => { this.handleModelsConfigSaved(); }}`. `ModelsConfigDialog` is unchanged: it already declares `onSaved?: () => void` (`ModelsConfigDialog.ts:77`) and invokes it only after a successful save and only while the saved machine is still the dialog's machine (`ModelsConfigDialog.ts:554`, `:564`).
2. **Extract the shared publish tail.** Move the publish body of `handleModelTiersSaved` (`PiWebUiApp.ts:2139-2152`) into `private publishMachineModelTierCatalog(machineId: string, catalog: ModelTierSettingsResponse): void` and call it from both `handleModelTiersSaved` and the success branch of `performModelTierCatalogLoad` (which publishes inline today at `:2079-2081`).
3. **Extract the shared policy revalidation.** Move `handleModelTiersSaved`'s trailing statement (`:2150-2151`) into `private revalidateActiveModelPolicyAfterTierCatalogChange(): void` and call it from both `handleModelTiersSaved` and the new save handler, the latter only after a successful publish.
4. **Add the save handler.** `private handleModelsConfigSaved(): void` starts `private async refreshModelTierCatalogAfterModelsSave(): Promise<void>`, which re-reads the selected machine's tier catalog through the existing `modelTiersApi.settings(machineId)` request and publishes it.
5. **Guard-scope parameter and boolean result.** `loadModelTierCatalog` and `performModelTierCatalogLoad` gain a `"machine" | "machine-workspace"` guard-scope parameter; `loadModelTierCatalog` and the `modelTierCatalogLoad` in-flight handle carry `Promise<boolean>` (true only when that request published). The save-triggered refresh is the only machine-scoped caller.
6. **Tests.** One dialog-wiring test in `PiWebUiApp.modelsConfig.test.ts` and a new refresh/revalidation/edge-case block in `PiWebUiApp.sessionModelPolicy.test.ts` (section 6).
7. **Changeset.** One patch fragment for `@hyperdreamer/pi-webui` (section 7). `CHANGELOG.md` is not edited.

### 1.2 In scope (explicit)

- Binding `.onSaved` and the new handler exactly as specified.
- The shared publish and revalidate helpers and their two callers each.
- The guard-scope parameter and boolean result, with the default `"machine-workspace"` preserving every existing caller's behavior byte-for-byte.
- The starter-draft completion that already runs inside the publish tail, so the same refresh covers the policy-enabled starter composer.
- Regression, failure, retry, supersession, machine-switch, workspace-switch, starter, interleaving, removal, and boolean-result tests.
- The single Changeset fragment.

### 1.3 Out of scope (explicit non-goals)

- No server, sessiond, protocol, or browser-API-contract change; no new endpoint, field, parameter, or capability.
- No auth login/logout trigger (needs a new dedicated `AuthController` completion contract).
- No external `models.json` freshness, watcher, polling, or realtime push.
- No UI change: no new dialog, toast, retry button, or visual treatment. The existing dialog saved message and the existing composer catalog-error channel are reused.
- No automatic substitution or repair of a removed model; a removed selection stays visibly selected until the user repairs it.
- No reload of `starterSessionDefaults` for legacy peers without `sessions.modelPolicyStarterSelection`.
- No `README.md` or `docs/` change and no `CHANGELOG.md` edit.
- No unrelated refactoring of catalog, policy, or starter code.

---

## 2. Behavior contract

| Situation | Before | After |
| --- | --- | --- |
| Models-dialog save succeeds; a policy composer is showing | Cached catalog stays stale; the picker lists the new model but `pickModel` refuses it (`PiWebUiApp.ts:3864`) and tier rows/draft readiness stay stale | `modelTiersApi.settings(selectedMachineId)` is re-read and published; the model is selectable and applicable immediately; the active session policy is re-read once |
| Models-dialog save succeeds; start screen (no session) | Stale catalog | Catalog refreshed and published; no policy re-read; the starter draft completes from the refreshed catalog when `starterSessionDefaults` is present |
| Models-dialog save succeeds; selected session archived | Stale catalog | Catalog refreshed and published; no policy re-read because an archived selection has no status (`sessionController.ts:446-447`, `:453-458`) |
| Tier-ladder save (Settings → Model tiers) | Publishes + revalidates | Unchanged; shares the same helpers and still revalidates only for the selected machine |
| Catalog GET fails after a successful save | n/a | Save remains successful and reported by the dialog; previous catalog stays published; `modelTierCatalogError` carries the request failure; no policy re-read; the in-flight handle is released |
| A newer catalog load or ladder save publishes mid-flight | n/a | Newer publish wins; the older response neither republishes nor revalidates |
| Machine switches mid-refresh | n/a | Response dropped by the machine + sequence guard; the switch's own reset and load win |
| Workspace switches mid-refresh | n/a | The save-triggered refresh still publishes (the catalog is machine-global); publish-time starter completion no-ops because `starterSessionDefaults` was reset; the new workspace's defaults load completes its draft from the refreshed catalog |

---

## 3. Exact implementation

All production edits are in `src/client/src/components/PiWebUiApp.ts`.

### 3.1 Guard-scope type and in-flight handle type

Add a module-scope type alias (name and union are pinned; exact placement is not behavior-bearing — put it next to `activePolicyComposerScope` at `:4934` or with the other module-level helper types):

```ts
type ModelTierCatalogLoadGuard = "machine" | "machine-workspace";
```

The union is required instead of a `workspaceId === undefined` test because an undefined selected workspace is legitimate; an explicit scope keeps the save variant from silently dropping the workspace check from other paths.

Change the `modelTierCatalogLoad` handle field at `:507-511`:

```ts
  private modelTierCatalogLoad: {
    machineId: string;
    workspaceId: string | undefined;
    promise: Promise<boolean>;
  } | undefined;
```

`modelTierCatalogMachineId` (`:503`) and `modelTierCatalogSeq` (`:505`) are unchanged.

### 3.2 `loadModelTierCatalog` — guard parameter and boolean result

Replace `:2052-2062` with:

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

Notes:

- The default `"machine-workspace"` preserves every existing caller (`ensureModelTierCatalog`, and direct test loads) unchanged.
- `workspaceId` is still captured for handle sharing; it is consulted by the guard only when `guard === "machine-workspace"`.
- The clear-on-settle logic is unchanged, including the rejection branch, so a failed request never leaves a stale handle behind.

### 3.3 `performModelTierCatalogLoad`

Replace `:2064-2088` with:

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
      this.publishMachineModelTierCatalog(machineId, catalog);
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

Behavior preserved from today's inline code:

- The request clears `modelTierCatalogError` at start (`:2075` today) and sets `errorMessage(error)` only for a current failure (`:2084` today).
- On success, `publishMachineModelTierCatalog` bumps `modelTierCatalogSeq`, so the `finally` loading check is a no-op and the publish's own `modelTierCatalogLoading = false` stands. This is equivalent to today's inline publish at `:2079-2081` plus the `finally` at `:2086`.
- A superseded response returns `false` before mutating anything.

### 3.4 `ensureModelTierCatalog`

Replace `:2090-2098` with:

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

Then change the single dependent annotation at `:2188`, inside `prepareActiveModelPolicyDraft`:

```ts
    const loads: Promise<unknown>[] = [];
```

The return type is forced: the method returns the shared handle's `Promise<boolean>` directly, so it cannot stay `Promise<void>`. `Promise<unknown>[]` is required rather than a void-bearing union: `Promise<boolean | void>[]` fails the repository's strict ESLint rule `@typescript-eslint/no-invalid-void-type` (`(Promise<boolean> | Promise<void>)[]` would lint but is needlessly indirect). All other call sites (`:1495`, `:2172`, `:3105`, `:4198`, `:4228`, `:4248`) use `await` or `void` and compile unchanged. The early return means "a catalog for the selected machine is already published"; no caller consumes that boolean, so it carries no behavior.

### 3.5 `publishMachineModelTierCatalog`

Insert after `resetModelTierCatalogForMachineChange` (`:2128`) and before `handleModelTiersSaved` (`:2139`), moving and adapting the existing publish JSDoc:

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

This is exactly the body currently in `handleModelTiersSaved` (`:2140-2147`), including the selected-machine guard and the starter-draft completion (`completeStarterModelPolicyFromActiveTier`, `:2154`).

### 3.6 `revalidateActiveModelPolicyAfterTierCatalogChange`

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

This is the trailing body currently in `handleModelTiersSaved` (`:2148-2151`), comment included. `activePolicyComposerScope` is defined at `:4934-4938`.

### 3.7 `handleModelTiersSaved`

Replace `:2139-2152` with:

```ts
  private handleModelTiersSaved(machineId: string, response: ModelTierSettingsResponse): void {
    if (selectedMachineId(this.state) !== machineId) return;
    this.publishMachineModelTierCatalog(machineId, response);
    this.revalidateActiveModelPolicyAfterTierCatalogChange();
  }
```

The leading guard is deliberately retained even though `publishMachineModelTierCatalog` repeats it. The publish helper returns `void`, so the handler's own guard is what keeps revalidation gated on an actual publish. Without it, a ladder save for a machine the user is not viewing would newly re-read the active session policy — a behavior change this fix must not make (see section 10, item 2).

### 3.8 New save handler and refresh

Insert immediately after `handleModelTiersSaved`:

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

`loadModelTierCatalog`, not `ensureModelTierCatalog`, is deliberately used: refreshing an already-published cache is the point of the change. The `"machine"` guard is deliberately narrower than the default and is the only caller that omits the workspace check (section 4.5).

### 3.9 Template binding

Replace the single line at `:4863`.

Before:

```ts
        ${this.modelsConfigDialogOpen ? html`<models-config-dialog .machine=${state.selectedMachine} .onClose=${() => { this.modelsConfigDialogOpen = false; }} .onConfigureAuth=${() => { void this.auth.openLogin(); }}></models-config-dialog>` : null}
```

After (append the `.onSaved` binding only):

```ts
        ${this.modelsConfigDialogOpen ? html`<models-config-dialog .machine=${state.selectedMachine} .onClose=${() => { this.modelsConfigDialogOpen = false; }} .onConfigureAuth=${() => { void this.auth.openLogin(); }} .onSaved=${() => { this.handleModelsConfigSaved(); }}></models-config-dialog>` : null}
```

`ModelsConfigDialog` (`.ts` and its tests) is unchanged.

### 3.10 Files that require no change

- `src/client/src/components/ModelsConfigDialog.ts` — the existing `onSaved?: () => void` contract (`:77`) and its post-success, still-selected-machine invocation (`:554`, `:564`) are exactly what the app needs.
- `src/client/src/components/sessionModelPolicyDraft.ts` — `updateDraftExactModel` (`:137-151`) and `isDraftReadyToApply` (`:192-198`) already fail closed for a catalog that lacks the draft's model.
- `src/server/models/modelsConfigService.ts` (`refreshAfterSave`, `:275`) and `src/server/sessions/modelTierSettingsService.ts` (`refreshedSnapshot`, `:70`) already make the server current immediately after a save; the bug is client cache invalidation only.
- `src/server/sessiond.ts`, `src/shared/apiTypes.ts`, `src/shared/capabilities.ts`, `src/client/src/api/*`, `.pi-webui/config.json`, and the package/config files — no API contract, capability, or configuration change.

---

## 4. State transitions and invariants

### 4.1 Publish transitions

| Trigger | Guard | Effect |
| --- | --- | --- |
| `handleModelsConfigSaved` → machine-scoped load resolves | `selectedMachineId === machineId` and `seq === modelTierCatalogSeq` | `modelTierCatalogMachineId = machineId`; `modelTierCatalog = catalog`; `modelTierCatalogError = ""`; `modelTierCatalogSeq += 1`; `modelTierCatalogLoad = undefined`; `modelTierCatalogLoading = false`; starter-draft completion; then revalidate if a policy composer is showing |
| `handleModelTiersSaved` → handler guard passes | `selectedMachineId === machineId` (handler) and the publish guard | Same publish effect; then revalidate unconditionally through `revalidateActiveModelPolicyAfterTierCatalogChange` |
| Default load resolves | `seq` newest and machine + workspace unchanged | Same publish effect (no handler-level revalidation; loads never revalidate, as today) |
| Load request fails | `isCurrent()` | No publish; `modelTierCatalogError = errorMessage(error)`; `modelTierCatalogLoading = false` when the sequence is still current; handle cleared on settle |
| Load superseded | `isCurrent()` false | No publish, no error mutation; the newer request owns the state and the handle |

### 4.2 Invariants

1. At most one `modelTierCatalogLoad` handle exists; only the newest issued load owns it, and it is cleared on settle.
2. `modelTierCatalogMachineId` and `modelTierCatalog` always belong to the same machine; `selectedMachineModelTierCatalog()` (`:2164-2167`) is undefined unless both match the current selection.
3. `modelTierCatalogError` is only written by a current load's start/`catch`, by a publish (clear), by the two resets (clear), or by the picker refusals in `pickModel`/`pickThinking`.
4. Revalidation runs exactly once per successful save-triggered publish and exactly once per successful selected-machine ladder save; never on failure or supersession.
5. Every publish bumps `modelTierCatalogSeq` before yielding, so no request that was current before the publish can publish after it.
6. Starter-draft completion runs exactly once per publish, inside `publishMachineModelTierCatalog`, and only when `starterSessionDefaults` and the starter draft both exist.

### 4.3 Failure

The machine-scoped load clears the previous error at request start (`:2075`), then on failure sets `modelTierCatalogError = errorMessage(error)` and resolves `false`. The save-triggered refresh therefore: publishes nothing, keeps the previous `modelTierCatalog`/`modelTierCatalogMachineId`, exposes the failure through the existing catalog diagnostic, and skips revalidation. It never rejects into the dialog: `ModelsConfigDialog` calls `onSaved?.()` synchronously after `setSavedMessage(...)` (`:563-564`), and `handleModelsConfigSaved` voids the async work, so the save's success report is untouched and `state.error` is not used.

### 4.4 Supersession

A newer `loadModelTierCatalog` or a ladder-save publish bumps `modelTierCatalogSeq`, so an older in-flight response fails `isCurrent()` and resolves `false` without publishing or revalidating. The older request's `finally` also skips the loading flag because its sequence is no longer current; the newer owner controls the flag.

### 4.5 Machine-scoped save refresh (the one deliberate guard difference)

The tier catalog is machine-global: `modelTierSettingsService` derives it from the machine's config plus a fresh runtime snapshot, and it does not vary by workspace. A workspace switch does not clear the published catalog (`resetStarterModelPolicyForScopeChange`, `:2107-2114`, clears only the error), and `ensureModelTierCatalog` no-ops on a still-published catalog (`:2090-2097`), so no later request is guaranteed to repair a refresh that a workspace switch discarded. Publishing across a workspace switch is safe because `handleWorkspaceChange` clears `starterSessionDefaults` (`:1426`) and the starter draft (`:1427`), so publish-time completion no-ops and the new workspace's defaults load completes its own draft from the refreshed catalog. Existing load paths keep the default machine + workspace guard; only the save-triggered refresh is machine-scoped.

### 4.6 Machine switch

`handleMachineChange` calls `resetStarterModelPolicyForScopeChange` and `resetModelTierCatalogForMachineChange` (`:1668-1669`). The latter (`:2121-2128`) bumps the sequence, drops the handle, and clears catalog, machine id, loading flag, and error. An in-flight save-triggered refresh resolves `false` by both the machine check and the sequence check; the new machine's own load publishes instead.

### 4.7 No session and start screen

The refresh always publishes the machine catalog; it does not require a selected session. The publish-time starter completion runs only when `starterSessionDefaults` and the starter draft exist (typically after the start screen's defaults load). Revalidation is skipped because `state.status` is undefined, so `activePolicyComposerScope` (`:4934-4938`) returns undefined.

### 4.8 Archived session

`SessionController.selectSession` sets `status: undefined` for an archived session (`sessionController.ts:446-447`) and takes the archived early-return branch (`:453-458`). With no `status.modelPolicy`, `activePolicyComposerScope` is undefined and revalidation is skipped (pinned by test B12). The catalog is still published, and a later selection of a live session uses the fresh catalog.

### 4.9 Dialog save whose machine is no longer selected

`ModelsConfigDialog.saveConfig` captures `machineId` before the request and returns without calling `onSaved` when `machineId !== this.machineId()` after it settles (`ModelsConfigDialog.ts:554`, `:564`), and it applies save failures only while the machine still matches. So the app handler is normally not invoked at all. If it were invoked defensively, it refreshes the *currently selected* machine's catalog (a machine-global, fresh read); it never refreshes or republishes the stale dialog machine's catalog.

### 4.10 Overlapping loads

`modelTierCatalogSeq` keeps the newest request. A save-triggered load cannot republish after a newer load or after a ladder save, and neither superseded path revalidates.

### 4.11 Removed model

The fresh catalog is published as-is; nothing substitutes the draft's model. `pickModel` refuses the removed model (`:3859-3866`) and `pickStarterModel` declines (`:3928`), and `isDraftReadyToApply` (`sessionModelPolicyDraft.ts:192`) is false because the catalog no longer contains the tuple. The user repairs the selection explicitly.

### 4.12 Legacy peers

No capability gate guards the refresh. For a peer whose tier-catalog endpoint is unavailable, the GET failure is contained in `modelTierCatalogError`; no legacy control consumes that field, and the save remains successful. Active sessions without `sessions.modelPolicy` keep live `listModels()` + `setModel()` (`pickModel`, `:3852-3855`); starters without `sessions.modelPolicyStarterSelection` keep `starterSessionDefaults.models` (`pickStarterModel`, `:3932`). Their behavior is unchanged.

---

## 5. Error behavior and diagnostics

### 5.1 Existing fields and their writers

| Field | Written by | Cleared by | Rendered at |
| --- | --- | --- | --- |
| `modelTierCatalogError` (state, `PiWebUiApp.ts:490`) | `performModelTierCatalogLoad` start `:2075` (clear) and `catch` `:2084`; `pickModel` `:3864`; `pickThinking` `:4053` | `publishMachineModelTierCatalog`; `resetStarterModelPolicyForScopeChange` `:2113`; `resetModelTierCatalogForMachineChange` `:2127` | Starter composer `starterModelPolicyError()` `:3032-3036`; active composer `activeModelPolicyInputs` `:4564`, `:4593` |
| `state.modelPolicyError` (SessionController) | Policy load/save responses and failures | Selection change and policy reads | Active composer error, same two lines |
| Dialog `error` / `savedMessage` (ModelsConfigDialog) | Dialog save failure / success | Dialog save start | Dialog itself; unchanged by this fix |

### 5.2 Precedence

- **Starter composer** (`starterModelPolicyError`, `:3032-3036`): `modelTierCatalogError` first, then the confirmed-writer warning (`CONFIRMED_STARTER_MODEL_POLICY_WARNING`), then `starterModelPolicyPreferenceReadError`.
- **Active composer** (`activeModelPolicyInputs`, `:4553-4565` and `:4590-4593`): `state.modelPolicyError ?? this.modelTierCatalogError`. A policy transport error outranks the catalog error (the reason is documented at `:4550-4552`).
- **Picker refusals**: `Model <provider>/<id> is unavailable in the model policy catalog` (`:3864`, set only when a catalog exists) and `Thinking level <value> is unsupported by <provider>/<id>` (`:4053`). `pickStarterModel` refuses silently (`:3928`); this fix removes the stale-catalog cause of that refusal but adds no new message.

### 5.3 Failure matrix

| Situation | Behavior |
| --- | --- |
| Models save fails | `onSaved` is not called; the dialog's existing failure handling is unchanged |
| Catalog GET fails after a successful save | Save remains successful and reported; previous catalog remains published; `modelTierCatalogError` carries `errorMessage(error)` from the existing failure path; no partial publish; policy revalidation is skipped so a new policy read cannot replace the catalog diagnostic; the handler never rejects into the dialog; `state.error` is untouched |
| Machine switches mid-flight | The machine + sequence guard drops the response; the switch's own reset and load win |
| Workspace switches mid-flight | The save-triggered refresh is machine-scoped and still publishes; the switch neither discards the refresh the save requested nor lets another machine's response publish |
| Overlapping catalog loads | `modelTierCatalogSeq` keeps the newest; a save-triggered load cannot republish after a newer load or a ladder save |
| Model removed by the save | The fresh catalog makes the draft fail `isDraftReadyToApply` and the picker refuse; no silent substitution, no automatic repair |

---

## 6. Test matrix

Two Vitest files are edited; no new test harness is introduced. Both are node-environment component-boundary suites. Existing helpers referenced below live in `PiWebUiApp.sessionModelPolicy.test.ts` (`deferred` at `:2917`, `flush` at `:2941`, `manualTimers` at `:2534`, `validCatalog` at `:89`, `policyCapableActiveApp` at `:2559`, `activeState` at `:269`, `fullPreferenceCapableStarterState` at `:256`).

### 6.0 New fixtures and helpers

**`PiWebUiApp.sessionModelPolicy.test.ts`** — add these fixtures next to the existing model-option fixtures:

```ts
const newModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-new" },
  name: "New",
  // The draft's current thinking level must be present: `updateDraftExactModel`
  // blanks an unsupported level (`sessionModelPolicyDraft.ts:137-151`), and the
  // starter-path test below depends on "medium" surviving the pick.
  thinkingLevels: ["low", "medium", "high"],
};

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

Add this helper (mirrors `invokeModelTiersSaved` at `:2743`, which opens settings and uses the real render wiring):

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

Update two existing helpers:

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

function isPromiseOfBoolean(value: unknown): value is Promise<boolean> {
  return value instanceof Promise;
}
```

Keep `isPromise` (`:2913`) unchanged for the `Promise<void>` helpers. All existing `loadModelTierCatalog`/`ensureModelTierCatalog` call sites in the file compile unchanged (they `await` or ignore the result).

**`PiWebUiApp.modelsConfig.test.ts`** — add `vi.restoreAllMocks()` before `vi.unstubAllGlobals()` in the existing `afterEach` (the new test creates a spy), convert the type-only `../api` import to `import { modelTiersApi, type Machine, type ModelTierSettingsResponse, type Project } from "../api";` (a value cannot be added to a type-only import, and `ModelTierSettingsResponse` is already re-exported from `../api`), and add:

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

function invokeModelsConfigOnSaved(app: PiWebUiApp): void {
  const dialog = findTemplateContaining(renderApp(app), "<models-config-dialog");
  if (dialog === undefined) throw new Error("PiWebUiApp did not render models-config-dialog");
  const callback: unknown = templateValueAfterMarker(dialog, ".onSaved=");
  if (typeof callback !== "function") throw new Error("models-config-dialog did not bind onSaved");
  Reflect.apply(callback, undefined, []);
}
```

### 6.1 Wiring — `PiWebUiApp.modelsConfig.test.ts`

New describe `PiWebUiApp models config save wiring`:

**W1 `it("binds the Models dialog onSaved callback to a refresh of the selected machine's tier catalog")`**

- **Setup:** `createApp()`; `setAppState(app, { ...initialAppState(), selectedMachine: remoteMachine })`; `vi.spyOn(modelTiersApi, "settings").mockResolvedValue(wiringCatalog())`; `Reflect.set(app, "modelsConfigDialogOpen", true)`.
- **Control point:** render and read `.onSaved=` from the `<models-config-dialog>` sub-template; assert it is a function; invoke it.
- **Assertion:** `expect(settings).toHaveBeenCalledOnce(); expect(settings).toHaveBeenCalledWith("remote-a");` — the machine-scoped load starts synchronously inside the handler, so no flush is required. Fails with `Expected template marker .onSaved=` before the binding exists.

### 6.2 Load-result booleans — `PiWebUiApp.sessionModelPolicy.test.ts`

New describe `PiWebUiApp model tier catalog load result` (place after the existing `PiWebUiApp model tier catalog stale guards` block at `:559-648`):

**A1 `it("returns true from the request that published the catalog")`**
- Setup: `createApp()`; `setAppState(app, starterState())`; `vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog())`.
- Control: `await expect(loadModelTierCatalog(app, "local")).resolves.toBe(true)`.
- Assertion: result is `true` and `modelTierCatalog(app)` equals `validCatalog()`.

**A2 `it("returns false from a failed request and keeps the failure visible")`**
- Setup: `createApp()`; `setAppState(app, starterState())`; settings rejects `new Error("catalog offline")`.
- Control: `await expect(loadModelTierCatalog(app, "local")).resolves.toBe(false)`.
- Assertion: result is `false`; `modelTierCatalog(app)` is undefined; `modelTierCatalogError(app)` contains `"catalog offline"`; `modelTierCatalogLoading(app)` is `false`.

**A3 `it("returns false from a request superseded by a newer load")`**
- Setup: `createApp()`; `setAppState(app, starterState())`; `const slow = deferred<ModelTierSettingsResponse>();` settings `.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(validCatalog())`.
- Control: `const first = loadModelTierCatalog(app, "local"); await loadModelTierCatalog(app, "local"); slow.resolve({ ...validCatalog(), valid: false, configError: "stale" });`
- Assertion: `await expect(first).resolves.toBe(false)`; `modelTierCatalog(app)` equals `validCatalog()`; `modelTierCatalogLoading(app)` is `false`.

### 6.3 Save refresh — `PiWebUiApp.sessionModelPolicy.test.ts`

New describe `PiWebUiApp models config save catalog refresh` (place after the `PiWebUiApp model tier catalog save publish` block at `:649-745`):

**B1 (regression, reported bug) `it("makes a newly saved model selectable through the active policy picker without a reload")`**
- **Setup:** `const timers = manualTimers(); const app = policyCapableActiveApp(timers);` (published catalog is the stale `validCatalog()`, which lacks `gpt-new`); `const settings = vi.spyOn(modelTiersApi, "settings").mockResolvedValue(catalogWithNewModel());`; `const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();`
- **Control:** `invokeModelsConfigSaved(app); await flush();` then `await pickModel(app, "openai/gpt-new"); await timers.runAll();`
- **Assertion:** `settings` called with `remoteMachine.id`; `modelTierCatalog(app)` equals `catalogWithNewModel()`; `saveModelPolicy` called once with `{ mode: "exact", exact: { model: { provider: "openai", id: "gpt-new" }, thinkingLevel: "medium" } }`; `modelTierCatalogError(app)` is `""`. Without the refresh, `pickModel` instead records the unavailable-model error and never calls the writer.

**B2 `it("re-reads the active session policy once after a save-triggered refresh publishes")`**
- **Setup:** `const app = policyCapableActiveApp();` `const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();` settings resolves `catalogWithNewModel()`.
- **Control:** `invokeModelsConfigSaved(app); await flush();`
- **Assertion:** `expect(loadModelPolicy).toHaveBeenCalledTimes(1);`

**B3 `it("does not re-read the session policy when no policy composer is showing")`**
- **Setup:** `createApp()`; `setAppState(app, starterState())` (no `status`); spy `loadModelPolicy`; settings resolves `catalogWithNewModel()`.
- **Control:** `invokeModelsConfigSaved(app); await flush();`
- **Assertion:** `loadModelPolicy` not called; `modelTierCatalog(app)` equals `catalogWithNewModel()` (refresh still happened).

**B4 `it("keeps the previous catalog and skips policy revalidation when the save-triggered refresh fails")`**
- **Setup:** `const app = policyCapableActiveApp();` spy `loadModelPolicy`; settings `mockRejectedValue(new Error("catalog offline"))`.
- **Control:** `invokeModelsConfigSaved(app); await flush();`
- **Assertion:** `modelTierCatalog(app)` still equals `validCatalog()`; `modelTierCatalogError(app)` contains `"catalog offline"`; `modelTierCatalogLoading(app)` is `false`; `loadModelPolicy` not called; `appState(app).error` is `""` (the failure never reaches the app error channel).

**B5 `it("releases a failed save-triggered load so ensure issues a fresh request")`**
- **Setup:** `const app = policyCapableActiveApp();` then clear the published projection with `Reflect.set(app, "modelTierCatalog", undefined)`; spy `loadModelPolicy`; settings `.mockRejectedValueOnce(new Error("catalog offline")).mockResolvedValueOnce(catalogWithNewModel())`.
- **Control:** `invokeModelsConfigSaved(app); await flush();` then `const retried = await ensureModelTierCatalog(app, remoteMachine.id);`
- **Assertion:** after the failure `modelTierCatalog(app)` is undefined, `modelTierCatalogError(app)` contains `"catalog offline"`, and `loadModelPolicy` was not called; after `ensure`, `settings` was called twice, `retried` is `true`, `modelTierCatalog(app)` equals `catalogWithNewModel()`, and `modelTierCatalogError(app)` is `""`.

**B6 `it("drops a save-triggered refresh whose machine is no longer selected")`**
- **Setup:** `createApp()`; `setAppState(app, starterState())` (local selected); `const pending = deferred<ModelTierSettingsResponse>();` settings `.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(catalogWithNewModel())`; spy `loadModelPolicy`.
- **Control (deferred point 1):** `invokeModelsConfigSaved(app);` (local machine-scoped load in flight; assert `settings` called with `"local"`). Then switch selection without the app's machine-change hook: `setAppState(app, activeState({ selectedMachine: remoteMachine, machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.sessionsModelPolicy]) }, modelPolicy: exactPolicyResponse(), availableThinkingLevels: ["off", "low", "medium", "high"] }));` then `pending.resolve(validCatalog()); await flush();`
- **Assertion:** `modelTierCatalog(app)` is undefined; `loadModelPolicy` not called. Then `await loadModelTierCatalog(app, remoteMachine.id);` and assert `modelTierCatalog(app)` equals `catalogWithNewModel()` and `loadModelPolicy` is still not called (the new machine's own load wins).

**B7 `it("publishes a save-triggered refresh across a workspace switch and completes the new workspace's starter draft from it")`**
- **Setup:** `const app = createApp();` `const saveLoad = deferred<ModelTierSettingsResponse>();` settings `mockReturnValue(saveLoad.promise)`; `vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2WithoutResolvedModel())`; `setAppState(app, { ...fullPreferenceCapableStarterState(), workspaces: [mainWorkspace, featureWorkspace] });` `setModelTierCatalog(app, validCatalog(), "local");` (stale, so the first defaults load does not fetch) `await loadStarterSessionDefaults(app, mainWorkspace);`
- **Control (deferred point):** `invokeModelsConfigSaved(app);` (machine-scoped load in flight) then switch workspace exactly as the existing reset test does: capture `previous = appState(app)`, `stubWorkspaceChangeSideEffects(app)`, `setRouteRestoreInProgress(app)`, `setAppState(app, { ...previous, selectedWorkspace: featureWorkspace, workspaces: [mainWorkspace, featureWorkspace] })`, `handleWorkspaceChange(app, previous, next)`. Then `saveLoad.resolve(catalogWithNewStandardModel()); await flush();`
- **Assertion:** `modelTierCatalog(app)` equals `catalogWithNewStandardModel()` (published despite the switch); `starterModelPolicy(app)` is undefined (publish-time completion no-opped because the switch reset the defaults). Then `await loadStarterSessionDefaults(app, featureWorkspace);` and assert `starterModelPolicy(app)` equals `{ mode: "tiered", tier: "standard", exact: { model: { provider: "openai", id: "gpt-new" }, thinkingLevel: "medium" } }` — which proves the fresh standard ladder was used, since the stale one resolved `gpt-default`. `settings` was called once.

**B8 (starter path) `it("makes a newly saved model selectable for a full-capability starter draft")`**
- **Setup:** `createApp()`; `vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2());` settings resolves `catalogWithNewModel()`; `setAppState(app, fullPreferenceCapableStarterState());` `setModelTierCatalog(app, validCatalog(), "local");` `await loadStarterSessionDefaults(app, mainWorkspace);` (draft is tiered/standard with exact `gpt-default`/`medium`).
- **Control:** `invokeModelsConfigSaved(app); await flush();` then `await pickStarterModel(app, "openai/gpt-new");`
- **Assertion:** `modelTierCatalog(app)` equals `catalogWithNewModel()`; `starterModelPolicy(app)` equals `{ mode: "tiered", tier: "standard", exact: { model: { provider: "openai", id: "gpt-new" }, thinkingLevel: "medium" } }`. **Fixture requirement:** `newModelOption.thinkingLevels` must include the draft's current level `"medium"`; with a fixture that omits it, `updateDraftExactModel` would blank the thinking level and the assertion would have to assert `""` instead — the fixture exists specifically to keep the level meaningful.

**B9 `it("lets a ladder save that publishes mid-flight win over an older save-triggered refresh")`**
- **Setup:** `const app = policyCapableActiveApp();` `const saveLoad = deferred<ModelTierSettingsResponse>();` settings `.mockReturnValueOnce(saveLoad.promise)`; spy `loadModelPolicy`; `const ladderCatalog: ModelTierSettingsResponse = { ...validCatalog(), configError: "ladder publish" };`
- **Control (deferred point):** `invokeModelsConfigSaved(app);` then `invokeModelTiersSaved(app, remoteMachine.id, ladderCatalog);` then `saveLoad.resolve(catalogWithNewModel()); await flush();`
- **Assertion:** `modelTierCatalog(app)` equals `ladderCatalog` (the stale save response did not republish); `modelTierCatalogError(app)` is `""`; `modelTierCatalogLoading(app)` is `false`; `loadModelPolicy` called exactly once (only for the ladder save).

**B10 `it("makes a removed model fail closed after a save-triggered refresh without substituting a selection")`**
- **Setup:** `const timers = manualTimers(); const app = policyCapableActiveApp(timers);` settings resolves `catalogWithoutDefaultModel()`; `const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();`
- **Control:** `invokeModelsConfigSaved(app); await flush();` then `await pickModel(app, "openai/gpt-default"); await timers.runAll();`
- **Assertion:** `modelTierCatalog(app)` equals `catalogWithoutDefaultModel()`; `saveModelPolicy` not called; `modelTierCatalogError(app)` equals `"Model openai/gpt-default is unavailable in the model policy catalog"`; `timers.size()` is `0` (no apply was scheduled); `promptEditorStatus(promptEditorTemplate(app)).model` equals `{ provider: "openai", id: "gpt-default" }` (the draft is unchanged, proving no substitution and the `isDraftReadyToApply` false state).

**B11 (shared-path guard regression) `it("does not re-read the session policy for a ladder save of a machine the user is not viewing")`**
- **Setup:** `const app = policyCapableActiveApp();` `const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue();`
- **Control:** `invokeModelTiersSaved(app, "remote-other", validCatalog());`
- **Assertion:** `modelTierCatalog(app)` still equals `validCatalog()`; `loadModelPolicy` not called. This pins the retained handler guard in section 3.7.

**B12 `it("publishes the refreshed catalog without a policy re-read for an archived selected session")`**
- **Setup:** `createApp()`; `setAppState(app, activeState({ status: undefined, selectedSession: { ...activeSession(), archived: true } }))`; spy `loadModelPolicy`; settings resolves `catalogWithNewModel()`.
- **Control:** `invokeModelsConfigSaved(app); await flush();`
- **Assertion:** `modelTierCatalog(app)` equals `catalogWithNewModel()`; `loadModelPolicy` not called (an archived selection has no policy status, so `activePolicyComposerScope` is undefined). Pins the section 2 and 4.8 archived-session contract row.

### 6.4 Existing tests that must stay green (no edits)

- `PiWebUiApp.sessionModelPolicy.test.ts` → `describe("PiWebUiApp model tier catalog stale guards")` (`:559-648`): workspace/machine stale guard, newer-response wins, failure visibility, and the fresh V2 load after a workspace change.
- `PiWebUiApp.sessionModelPolicy.test.ts` → `describe("PiWebUiApp model tier catalog save publish")` (`:649-745`): selected-machine ladder publish, in-flight loss to a save, other-machine save isolation, one policy re-read, no re-read without a policy composer, and starter completion from a ladder save.
- The rest of the `sessionModelPolicy` suite and the `PiWebUiApp.modelsConfig` suite.

### 6.5 Falsifiability (mutations)

Each pin must fail under exactly one single-file mutation; run the focused suite per mutation and revert before continuing.

| Pin | Single-file mutation | Required failure |
| --- | --- | --- |
| W1 binding | Remove `.onSaved=` from `PiWebUiApp.ts:4863` | W1 fails with `Expected template marker .onSaved=` |
| B1 refresh | Delete the `loadModelTierCatalog` call from `refreshModelTierCatalogAfterModelsSave` | B1's `modelTierCatalog` assertion fails and `pickModel` refuses instead of writing |
| A1-A3 / B5 boolean | Make `performModelTierCatalogLoad` return `Promise<void>` | Typecheck fails; boolean assertions fail |
| B2/B9 revalidation | Delete `revalidateActiveModelPolicyAfterTierCatalogChange` from `refreshModelTierCatalogAfterModelsSave` | B2 fails (not called); B9 still passes (ladder path) |
| B4/B9 failure gating | Drop `if (published)` and always revalidate | B4 and B9 fail (`loadModelPolicy` called on failure/supersession) |
| B4 no partial publish | Publish in the `catch` branch | B4's previous-catalog assertion fails |
| B7 machine scope | Make `performModelTierCatalogLoad` always check the workspace | B7 fails (no publish after the workspace switch) |
| B9 supersession | Remove the `modelTierCatalogSeq` bump from `publishMachineModelTierCatalog` | B9's catalog assertion fails (the stale response republishes) |
| B10 no substitution | Substitute or auto-repair the draft on a missing model | B10's `timers.size()`/draft-model assertions fail |
| B11 handler guard | Remove `handleModelTiersSaved`'s leading selected-machine guard | B11 fails (`loadModelPolicy` called) |

### 6.6 Checks to run

Focused first, then broad:

1. `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.modelsConfig.test.ts`
2. `npm run typecheck`
3. `npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.modelsConfig.test.ts`
4. `npm run verify:fast`

The PM runs `npm run verify` (serial profile) before the final audit, per `.agents/skills/testing-guide/SKILL.md`.

---

## 7. Changeset

**Decision: one `patch` fragment.** This is a backward-compatible user-visible bug fix (the new model becomes usable without a reload); it adds no new capability, option, or API surface, so `patch` is correct under `.agents/skills/changeset-changelog/SKILL.md`.

**Path:** `.changeset/model-catalog-refresh-after-save.md` (kebab-case; `.changeset/` currently contains only `config.json`, so the name is unique).

Exact contents (body is a single unwrapped line, matching the generated changelog convention; end the file with a trailing newline):

```md
---
"@hyperdreamer/pi-webui": patch
---

Refresh the model policy catalog after saving models in Settings so a newly added model can be selected in the current session without reloading the page.
```

`CHANGELOG.md` is not edited; release notes are generated from this fragment at release prep.

---

## 8. Commit plan

One implementer-sized commit; the PM commits after review. Conventional Commit style:

```text
fix(client): refresh the model tier catalog after a models-config save

Publish the selected machine's tier catalog after a successful Models-dialog
save and revalidate the active session policy when a policy composer is
showing, so a newly added model is usable without a page reload.
```

Files in the commit:

- `src/client/src/components/PiWebUiApp.ts`
- `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
- `src/client/src/components/PiWebUiApp.modelsConfig.test.ts`
- `.changeset/model-catalog-refresh-after-save.md`

No `CHANGELOG.md`, design-document, documentation, package, or server-file edits. No commit or push by the implementer when running under the PM workflow; the PM owns the commit.

---

## 9. Compatibility and rollback

- **Client-only.** The production change is in `src/client/src/components/PiWebUiApp.ts`; the web/API + Vite UI development service (`pi-webui-ui-dev.service`) autoreloads it. Per `AGENTS.md`, no manual `pi-webui-sessiond.service` restart is needed.
- **No browser API contract change.** The refresh reuses `modelTiersApi.settings(machineId)` exactly as the existing catalog loads do; no endpoint, field, header, or capability is added. The tier-catalog endpoint already returns a fresh runtime snapshot (`modelTierSettingsService.ts:70`) and the Models save already refreshes the shared `ModelRuntime` (`modelsConfigService.ts:275`), so the server is current when the browser re-reads.
- **Legacy peers.** Peers without `sessions.modelPolicy` keep live `listModels()`/`setModel()` for active sessions and `starterSessionDefaults.models` for starter defaults (section 4.12). A peer whose tier-catalog endpoint is unavailable yields a contained `modelTierCatalogError` after a save; nothing in the legacy UI consumes it and the save still succeeds. No peer needs an update for this fix to be safe.
- **Rollback.** Revert the commit (or ship a follow-up patch); the browser returns to the previous lazy cache behavior. There is no persisted state, migration, or protocol activity to undo.

---

## 10. Resolved implementation details

These are the decisions the approved design left open; none changes its behavior contract.

1. **Guard parameter shape** — a module-scope `type ModelTierCatalogLoadGuard = "machine" | "machine-workspace";` union alias, with `loadModelTierCatalog`'s second parameter defaulting to `"machine-workspace"` and appended last on `performModelTierCatalogLoad` (`(machineId, workspaceId, seq, guard)`). This keeps the design's explicit-enum requirement and the existing call order.
2. **`handleModelTiersSaved` keeps its leading selected-machine guard** — because `publishMachineModelTierCatalog` returns `void`, the handler's guard is what keeps revalidation gated on an actual publish and preserves today's exact ladder-save behavior for an unselected machine.
3. **`ensureModelTierCatalog` returns `Promise<boolean>`** — forced by returning the shared handle's `Promise<boolean>` directly. It keeps a direct return instead of an `async`/`.then` wrapper; the one dependent annotation `prepareActiveModelPolicyDraft`'s `loads` becomes `Promise<unknown>[]` (the void-bearing union fails `@typescript-eslint/no-invalid-void-type`; see section 3.4). Its already-published short-circuit returns `true`; no caller consumes the value.
4. **Helper placement** — `publishMachineModelTierCatalog` and `revalidateActiveModelPolicyAfterTierCatalogChange` sit between `resetModelTierCatalogForMachineChange` and `handleModelTiersSaved`; `handleModelsConfigSaved` and `refreshModelTierCatalogAfterModelsSave` directly after `handleModelTiersSaved`. The publish JSDoc moves with the publish body; the policy comment moves with the revalidation body.
5. **Binding form** — the exact `.onSaved=${() => { this.handleModelsConfigSaved(); }}` arrow matches the adjacent `.onClose`/`.onConfigureAuth` style; `handleModelsConfigSaved` is a regular method because the template arrow already binds the receiver.
6. **Test helper guards** — keep `isPromise(value): value is Promise<void>` (`PiWebUiApp.sessionModelPolicy.test.ts:2913`) unchanged and add `isPromiseOfBoolean` for the two catalog helpers, avoiding a `Promise<unknown>` ripple through `loadStarterSessionDefaults` and `callAsyncAppMethod`.
7. **Wiring-test lifetime** — the `modelsConfig` test asserts the synchronous `settings` call and does not need a flush helper; the pending publish continuation touches only the detached app instance.

---

## 11. Open questions

None. All decisions delegated by the design are resolved in section 10 without changing its behavior contract, scope, or error semantics.

---

## Appendix A. Verification summary

| Check | Command | Expected |
| --- | --- | --- |
| Focused suites | `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.modelsConfig.test.ts` | All green, including B1 (reported bug), B7 (workspace scope), and the unchanged ladder-save suite |
| Types | `npm run typecheck` | Exit 0 |
| Lint | `npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.modelsConfig.test.ts` | Exit 0 |
| Completion gate | `npm run verify:fast` | Exit 0 |
| Final gate | `npm run verify` (PM, serial profile) | Exit 0 |
