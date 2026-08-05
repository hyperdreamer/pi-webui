# Utility Model Thinking Levels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select one request-local thinking level for each machine-scoped Lightweight and Context utility model while preserving utility fallback chains and active-session model/thinking/default state.

**Architecture:** Extend each optional utility model reference into a backward-compatible binding whose omitted `thinkingLevel` means lowercase `auto`. Advance the strict settings contract to version 2 with Pi-reported per-model levels while keeping version 1 readable by new clients, resolve configured bindings into model-plus-effective-level descriptors at operation time, and pass those descriptors only into utility request construction. Extend the existing Utility models panel with dynamic thinking selectors; do not add another settings category or per-operation controls.

**Tech Stack:** TypeScript, Fastify, Lit, Vitest/jsdom, Pi model runtime and coding-agent summarization helpers, Changesets.

## Global Constraints

- Node.js 22.19.0 is the version floor; do not use newer-only APIs.
- Add no runtime dependencies.
- Keep Utility models separate from Model tiers.
- Each Utility models row has one thinking control: Lightweight applies to titles and branch summaries; Context applies to compaction and context summaries.
- Display the omission-based choice exactly as lowercase `auto`; never persist `"auto"` or `"automatic"` as `thinkingLevel`.
- Derive explicit options from Pi's supported levels for the selected model, including `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` when reported.
- Selecting a different model resets that row to `auto`; never carry an explicit level across model changes.
- A known explicit level that is no longer supported invalidates only that utility slot; do not silently coerce it to `auto` or a neighbouring level.
- Titles and branch summaries use Lightweight, then Pi's active-session fallback; compaction uses Context, then Lightweight, then Pi's active-session fallback.
- Each configured candidate uses its own row's level; active-session fallback keeps its existing request behavior and never inherits utility thinking intent.
- Never call `setModel`, `setThinkingLevel`, `setDefaultModelAndProvider`, or otherwise mutate the active session model, session thinking level, model policy, or Pi's remembered defaults for utility work.
- Persist settings machine-globally in `$PI_WEBUI_CONFIG` / `~/.config/pi-webui/config.json`, target the selected machine, and preserve model-only utility bindings without migration.
- Keep utility settings contract version 1 readable by the new browser as `auto`-only; emit and strictly parse version 2 for explicit thinking support.
- Application-owned client paths remain application-relative, encode dynamic machine IDs, and resolve exactly once through the existing `request()` boundary.
- Follow test-first development: add a failing focused test, run it and observe the expected failure, then add the minimum production code.
- Update the existing patch Changeset `.changeset/add-utility-model-settings.md`; keep exactly one utility-model Changeset and do not edit `CHANGELOG.md`.
- Keep `README.md` unchanged; synchronize canonical user guidance in `docs/config.md` and `docs/config.html`.
- Do not automatically restart `pi-webui-sessiond.service`; report that a manual daemon restart is required because daemon-loaded code changes.

## Task 1: Extend the persisted utility binding domain

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:82-125`
- Modify: `src/config.ts:207-380`
- Test: `src/config.test.ts:120-210`
- Test: `src/server/sessions/utilityModelSettingsRoutes.test.ts:1-20,154-166`
- Test: `src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts:1-25`
- Test: `src/client/src/components/SettingsDialog.utilitymodels.test.ts:1-30`

**Interfaces:**

- Consumes: `ThinkingLevel` and `isKnownThinkingLevel(value: string): value is ThinkingLevel` from `src/shared/thinkingLevels.ts`; existing `TierModelRef = { provider: string; id: string }`.
- Produces: `UtilityModelBinding`, backward-compatible `UtilityModelSettings` / `UtilityModelSettingsUpdate`, strict version 1/version 2 utility response types, and the union aliases below in `src/shared/apiTypes.ts`.
- Preserves: `parseUtilityModelsConfig(value: unknown, path: string): UtilityModelSettings` and `replacePiWebUiUtilityModels(utilityModels, options)` names and non-blocking `utilityModelsError` load behavior.

- [ ] **Step 1: Write failing binding parser and persistence tests**

Extend `src/config.test.ts` with cases that prove an explicit level round-trips while omission remains `auto`:

```ts
const utilityModels = {
  lightweight: { provider: "acme", id: "small", thinkingLevel: "low" },
  context: { provider: "acme", id: "large" },
} satisfies UtilityModelSettings;

savePiWebUiConfig({ utilityModels }, testOptions());
expect(loadPiWebUiConfig(testOptions()).config.utilityModels).toEqual(utilityModels);
```

Prove `replacePiWebUiUtilityModels()` preserves an explicit `max` value, removes a slot omitted from the replacement, and preserves unrelated top-level fields. Add table cases asserting rejection of `thinkingLevel: "auto"`, `thinkingLevel: "turbo"`, empty/non-string levels, and any key other than `provider`, `id`, and `thinkingLevel`. Add an external-file case showing an invalid level becomes `loaded.utilityModelsError`, leaves other valid config readable, and does not block ordinary config loading.

- [ ] **Step 2: Run the config tests and confirm the red phase**

Run: `npm test -- --run src/config.test.ts`

Expected: FAIL because `thinkingLevel` is currently rejected as an unknown utility model-reference key.

- [ ] **Step 3: Add the shared binding and versioned response contracts**

Import `ThinkingLevel` as a type from `./thinkingLevels.js`. Replace the current utility types with this shape:

```ts
export interface UtilityModelBinding extends TierModelRef {
  thinkingLevel?: ThinkingLevel;
}

export interface UtilityModelSettings {
  lightweight?: UtilityModelBinding;
  context?: UtilityModelBinding;
}

export type UtilityModelSettingsUpdate = Partial<
  Record<UtilityModelSlot, UtilityModelBinding | null>
>;

export interface UtilityModelOptionV1 {
  model: TierModelRef;
  name?: string;
}

export interface UtilityModelOptionV2 extends UtilityModelOptionV1 {
  thinkingLevels: ThinkingLevel[];
}

export type UtilityModelOption = UtilityModelOptionV1 | UtilityModelOptionV2;

interface UtilityModelSettingsResponseFields {
  settings: UtilityModelSettings;
  slots: Record<UtilityModelSlot, UtilityModelSlotValidation>;
  valid: boolean;
  configError?: string;
}

export interface UtilityModelSettingsResponseV1
  extends UtilityModelSettingsResponseFields {
  contractVersion: 1;
  models: UtilityModelOptionV1[];
}

export interface UtilityModelSettingsResponseV2
  extends UtilityModelSettingsResponseFields {
  contractVersion: 2;
  models: UtilityModelOptionV2[];
}

export type UtilityModelSettingsResponse =
  | UtilityModelSettingsResponseV1
  | UtilityModelSettingsResponseV2;
```

Keep `UtilityModelSettingsResponseFields` unexported unless another production module requires it. Existing version 1 fixtures remain structurally valid; model-only bindings satisfy `UtilityModelBinding` because `thinkingLevel` is optional.

Immediately update the three existing helper functions declared as `response(overrides: Partial<UtilityModelSettingsResponse>)` / `snapshot(...)` in `utilityModelSettingsRoutes.test.ts`, `SettingsUtilityModelsPanel.test.ts`, and `SettingsDialog.utilitymodels.test.ts` to import and use `UtilityModelSettingsResponseV1` for both `Partial<>` and the return type. Do not change their version 1 behavior in this task. The discriminated union otherwise allows a version 2 override to be spread over a version 1 base, which is intentionally not type-safe; Tasks 2 and 5 convert the relevant fixtures to the v2 branch.

- [ ] **Step 4: Parse exact optional thinking intent in config**

Import `isKnownThinkingLevel`. Replace utility slots' use of `parseModelReference()` with a dedicated parser:

```ts
function parseUtilityModelBinding(
  value: unknown,
  key: string,
  path: string,
): UtilityModelBinding {
  if (!isRecord(value)) {
    throw new Error(`PI WEBUI config ${key} must be an object: ${path}`);
  }
  const unknownKey = Object.keys(value).find(
    (entryKey) =>
      entryKey !== "provider" &&
      entryKey !== "id" &&
      entryKey !== "thinkingLevel",
  );
  if (unknownKey !== undefined) {
    throw new Error(
      `PI WEBUI config ${key} contains unknown key ${JSON.stringify(unknownKey)}: ${path}`,
    );
  }

  const thinkingLevel = value["thinkingLevel"];
  if (
    thinkingLevel !== undefined &&
    (typeof thinkingLevel !== "string" || !isKnownThinkingLevel(thinkingLevel))
  ) {
    throw new Error(
      `PI WEBUI config ${key}.thinkingLevel must be one of off, minimal, low, medium, high, xhigh, or max: ${path}`,
    );
  }

  return {
    provider: parseString(value["provider"], `${key}.provider`, path),
    id: parseString(value["id"], `${key}.id`, path),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}
```

Use it for `utilityModels.lightweight` and `utilityModels.context`. Do not accept a stored `auto` sentinel. Keep exact model-tier reference parsing unchanged.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- --run src/config.test.ts src/shared/thinkingLevels.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS with existing version 1 utility API and UI code still compiling against the discriminated response union.

- [ ] **Step 6: Commit the persisted binding domain**

```bash
git add src/shared/apiTypes.ts src/config.ts src/config.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts
git commit -m "feat(config): add utility model thinking bindings"
```

## Task 2: Emit and validate the version 2 daemon settings contract

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/utilityModelSettingsService.ts:1-151`
- Test: `src/server/sessions/utilityModelSettingsService.test.ts:1-228`
- Modify: `src/server/sessions/utilityModelSettingsRoutes.ts:1-68`
- Test: `src/server/sessions/utilityModelSettingsRoutes.test.ts:1-166`
- Modify: `src/server/sessiond.ts:40-140`

**Interfaces:**

- Consumes: `UtilityModelBinding`, `UtilityModelOptionV2`, `UtilityModelSettings`, `UtilityModelSettingsResponseV2`, `UtilityModelSettingsUpdate`, and `ThinkingLevel` from Task 1; `isKnownThinkingLevel` from `src/shared/thinkingLevels.ts`; `runtimeThinkingLevels(model): readonly string[]` from `src/server/sessions/modelTierRegistry.ts`.
- Extends: `UtilityModelSettingsServiceDependencies<TModel>` with `thinkingLevelsForModel(model: TModel | undefined): readonly string[]`.
- Produces: `UtilityModelSettingsService.inspect(): Promise<UtilityModelSettingsResponseV2>` and `.update(patch): Promise<UtilityModelSettingsResponseV2>`, whose model options contain known Pi-reported levels and whose per-slot validation rejects unsupported explicit levels.
- Preserves: daemon `GET /utility-models`, `PUT /utility-models`, the `{ settings: UtilityModelSettingsUpdate }` request body, serialized updates, `settings.utilityModels`, and existing federated/proxy paths.

- [ ] **Step 1: Write failing service tests for dynamic levels and slot validation**

Give the test models different reported levels, for example Small `off/minimal/low` and Large `off/low/medium/high/xhigh/max`. Add tests asserting:

```ts
expect(await harness.service.inspect()).toMatchObject({
  contractVersion: 2,
  models: [
    {
      model: { provider: "acme", id: "small" },
      name: "Acme Small",
      thinkingLevels: ["off", "minimal", "low"],
    },
    {
      model: { provider: "acme", id: "large" },
      name: "Acme Large",
      thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    },
  ],
});
```

Cover a supported explicit `max`, an omitted level on a model without `minimal`, and a persisted `minimal` on Large that invalidates only its slot with reason `context utility model acme/large does not support thinking level minimal`. Prove an update containing that unsupported tuple rejects before save, retained bindings are validated with the patch, and concurrent updates still preserve both complete bindings including their levels.

- [ ] **Step 2: Run the service test and confirm the red phase**

Run: `npm test -- --run src/server/sessions/utilityModelSettingsService.test.ts`

Expected: FAIL because the service still emits version 1, exposes no thinking levels, and validates only model availability.

- [ ] **Step 3: Implement version 2 projection and validation**

Add the injected lookup to the service dependencies. For every model option, include only known values returned for that exact model:

```ts
function supportedThinkingLevels(model: TModel): ThinkingLevel[] {
  return deps.thinkingLevelsForModel(model).filter(isKnownThinkingLevel);
}

function modelOptionFor(model: TModel): UtilityModelOptionV2 {
  return {
    model: { provider: model.provider, id: model.id },
    ...(model.name === undefined ? {} : { name: model.name }),
    thinkingLevels: supportedThinkingLevels(model),
  };
}
```

Return `contractVersion: 2` for valid, empty, stale, and malformed-config inspections. In `validationFor`, find the exact available model first. If absent, preserve the existing unavailable reason. If `configured.thinkingLevel` is defined and `supportedThinkingLevels(available)` does not include it, return:

```ts
{
  valid: false,
  reason: `${slot} utility model ${configured.provider}/${configured.id} does not support thinking level ${configured.thinkingLevel}`,
}
```

Omission is valid and means `auto`; the service does not calculate its effective runtime level. Preserve the update queue and the complete load/refresh/validate/save/confirm transaction.

- [ ] **Step 4: Add route regression coverage for explicit levels**

Add a successful PUT carrying `{ thinkingLevel: "xhigh" }`. Add invalid cases for `"auto"`, `"turbo"`, non-string values, and an extra binding key. Change route response fixtures to contract version 2 with model `thinkingLevels` arrays.

Run: `npm test -- --run src/server/sessions/utilityModelSettingsRoutes.test.ts`

Expected: PASS because the route already delegates each present binding to Task 1's strict `parseUtilityModelsConfig()` boundary. These tests pin that reuse and prevent the route from widening independently.

- [ ] **Step 5: Confirm strict route semantics without adding another parser**

Inspect `parseSettingsUpdate()` and retain its own-property and null semantics. Its call to `parseUtilityModelsConfig({ [slot]: value[slot] }, "request body settings")` must accept exact optional levels and reject `auto`, unknown levels, and extra keys before invoking the service. Do not duplicate binding parsing, add request contract fields, or add routes. Change `utilityModelSettingsRoutes.ts` only if the regression test exposes a route-owned defect.

- [ ] **Step 6: Inject Pi's live level lookup into the daemon service**

In `src/server/sessiond.ts`, add only this service dependency in this task:

```ts
const utilityModels = createUtilityModelSettingsService({
  loadConfig: loadUtilityModelConfig,
  saveConfig: ({ utilityModels: settings }) => {
    replacePiWebUiUtilityModels(settings, { env: daemonEnvironment });
  },
  modelRuntime: auth.runtime,
  thinkingLevelsForModel: runtimeThinkingLevels,
});
```

Do not restart the daemon. The resolver receives the same lookup in Task 4 when its interface changes.

- [ ] **Step 7: Run Task 2 verification**

Run: `npm test -- --run src/server/sessions/utilityModelSettingsService.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts`

Expected: PASS, including unchanged federated GET/PUT and proxy coverage.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the daemon contract**

```bash
git add src/server/sessions/utilityModelSettingsService.ts src/server/sessions/utilityModelSettingsService.test.ts src/server/sessions/utilityModelSettingsRoutes.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/server/sessiond.ts
git commit -m "feat(settings): expose utility thinking levels"
```

## Task 3: Parse version 1 and version 2 browser contracts strictly

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/api/parsers.ts:1348-1445`
- Test: `src/client/src/api/parsers.test.ts:1038-1095,1225-1254`
- Modify: `src/client/src/api/clients.ts:1-45,201-208`
- Test: `src/client/src/api/clients.test.ts:180-210`
- Modify: `src/client/src/components/SettingsDialog.ts:600-630`
- Test: `src/client/src/components/SettingsDialog.utilitymodels.test.ts:45-110`

**Interfaces:**

- Consumes: Task 1's `UtilityModelBinding`, `UtilityModelOptionV1`, `UtilityModelOptionV2`, `UtilityModelSettingsResponseV1`, `UtilityModelSettingsResponseV2`, and union `UtilityModelSettingsResponse`; `isKnownThinkingLevel(value)`.
- Produces: `parseUtilityModelSettingsResponse(value: unknown): UtilityModelSettingsResponse`, dispatching on `contractVersion` and strictly parsing that version's nested shape.
- Produces: `utilityModelsApi.save(update, contractVersion, machineId?)`, where the contract version is the currently loaded response discriminator and controls browser-boundary v1 projection without adding a request field.
- Preserves: `utilityModelsApi.settings(machineId?)`, application-relative `machines/<encoded-id>/utility-models` paths, and PUT body `{ settings: update }`.

- [ ] **Step 1: Write failing parser tests for both versions**

Keep a version 1 wire fixture with model-only settings/options and assert exact equality after parsing. Add a version 2 fixture with one explicit `thinkingLevel: "max"`, one omitted level, and complete dynamic arrays through `max`; assert exact equality.

Add strict rejection cases proving:

- version 1 rejects `thinkingLevel` in a setting and `thinkingLevels` in a model option;
- version 2 rejects a model option missing `thinkingLevels`;
- version 2 rejects `thinkingLevel: "auto"`, unknown levels, malformed arrays, and unknown nested keys;
- both versions retain exact provider/id, canonical slot maps, validation rows, top-level fields, and non-empty strings;
- contract versions other than 1 or 2 reject visibly.

- [ ] **Step 2: Run parser tests and confirm the red phase**

Run: `npm test -- --run src/client/src/api/parsers.test.ts`

Expected: FAIL because contract version 2 is currently rejected.

- [ ] **Step 3: Implement discriminated strict parsing**

Require the same exact top-level keys for both versions, then dispatch:

```ts
export function parseUtilityModelSettingsResponse(
  value: unknown,
): UtilityModelSettingsResponse {
  const record = requireObjectRecord(value, "utility model settings response");
  const unknownKey = Object.keys(record).find(
    (key) => !isUtilityModelSettingsResponseKey(key),
  );
  if (unknownKey !== undefined) {
    throw new Error(`Invalid utility model settings response field: ${unknownKey}`);
  }
  if (record["contractVersion"] === 1) {
    return parseUtilityModelSettingsResponseV1(record);
  }
  if (record["contractVersion"] === 2) {
    return parseUtilityModelSettingsResponseV2(record);
  }
  throw new Error("Invalid utility model settings contract version");
}
```

Version 1 must use exact `parseTierModelRef()` and exact model options containing only `model`/`name`. Version 2 must use a `parseUtilityModelBinding()` that permits only `provider`, `id`, and optional known `thinkingLevel`; its model option parser requires `thinkingLevels`, parses every entry as a string, narrows each with `isKnownThinkingLevel`, and permits only `model`, `name`, and `thinkingLevels`. Do not silently drop malformed or unknown values.

- [ ] **Step 4: Write failing client transport tests for explicit bindings**

Use a version 2 response fixture and this update:

```ts
const update = {
  lightweight: {
    provider: "openai",
    id: "gpt-small",
    thinkingLevel: "xhigh",
  },
  context: null,
} satisfies UtilityModelSettingsUpdate;
```

Assert the encoded selected-machine URL is unchanged. For contract version 2, assert the second request body is exactly `JSON.stringify({ settings: update })`. For contract version 1, call save with the same defensive explicit-level update and assert each non-null own binding is projected to `{ provider, id }`, null is retained, and omitted patch keys stay omitted. Add a version 1 GET response assertion proving the new parser still accepts an older remote.

Add dialog tests expecting `utilityModelsApi.save(update, loaded.contractVersion, "remote-a")` and proving no request occurs without a current utility response.

Run: `npm test -- --run src/client/src/api/clients.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts`

Expected: FAIL because the client has no contract-version argument or v1 projection and the dialog does not guard/forward its loaded response version.

- [ ] **Step 5: Make response version explicit at the browser save boundary**

Do not add a request version field. Change the client signature to:

```ts
save: (
  settings: UtilityModelSettingsUpdate,
  contractVersion: UtilityModelSettingsResponse["contractVersion"],
  machineId = "local",
) => Promise<UtilityModelSettingsResponse>;
```

For version 2, serialize `settings` unchanged. For version 1, build a fresh patch by checking each slot with `Object.prototype.hasOwnProperty.call`: preserve `null`, project every binding to `{ provider, id }`, and leave omitted slots omitted. Serialize the result as the same `{ settings }` body and keep path construction unchanged.

In `SettingsDialog.saveUtilityModels()`, capture the current response with the target. If it is absent, set `utilityModelsError` to `Utility model settings must be loaded before saving.` and return before setting `saving` or making a request. Otherwise pass its `contractVersion` plus the captured target id. Add dialog tests proving the loaded version is forwarded and a missing response does not issue a save. This closes the machine-change/stale-panel window without silently guessing a remote contract.

- [ ] **Step 6: Run Task 3 verification**

Run: `npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit browser contract compatibility**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts
git commit -m "feat(api): parse utility thinking contracts"
```

## Task 4: Apply effective thinking to isolated utility requests

**Implementer tier:** Capable

**Files:**

- Modify: `src/server/sessions/utilityModelResolver.ts:1-143`
- Test: `src/server/sessions/utilityModelResolver.test.ts:1-188`
- Modify: `src/server/sessions/utilityModelExtension.ts:1-347`
- Test: `src/server/sessions/utilityModelExtension.test.ts:1-511`
- Modify: `src/server/sessions/sessionNameGenerator.ts:1-45`
- Test: `src/server/sessions/sessionNameGenerator.test.ts:1-75`
- Modify: `src/server/sessions/piSessionService.ts:160-185,1180-1260,4833-4895`
- Test: `src/server/sessions/piSessionService.promptQueue.test.ts:70-370`
- Modify: `src/server/sessiond.ts:78-95`

**Interfaces:**

- Consumes: `UtilityModelBinding`, `UtilityModelSlot`, and `ThinkingLevel` from Task 1; `runtimeThinkingLevels(model): readonly string[]`; existing Pi `compact`, `generateBranchSummary`, auth runtime, and stream-function APIs.
- Produces: `UtilityModelAttempt<TModel>`, `ResolvedUtilityModel<TModel>`, and the revised resolver/fallback signatures below.
- Produces: `generateShortSessionName(streamFn, model, firstMessage, thinkingLevel?: ThinkingLevel): Promise<string | undefined>`, defaulting omitted `thinkingLevel` to `minimal`.
- Preserves: hidden extension name `pi-webui-utility-models`, event hooks `session_before_tree` / `session_before_compact`, abort terminality, auth lookup, retry/custom instructions, and Pi's unhandled active-session fallback.

- [ ] **Step 1: Write failing resolver tests for effective levels and tuple identity**

Replace model-only expectations with descriptors and cover these cases:

```ts
export interface UtilityModelAttempt<TModel extends UtilityModelIdentity> {
  model: TModel;
  thinkingLevel: ThinkingLevel;
}

export interface ResolvedUtilityModel<TModel extends UtilityModelIdentity>
  extends UtilityModelAttempt<TModel> {
  slot: UtilityModelSlot;
}
```

Assert omitted intent resolves to `minimal` when reported and `off` otherwise; explicit `xhigh`/`max` pass through; an unsupported explicit Context level skips only Context and still returns Lightweight; stale/malformed/refresh-failing config returns no configured attempts. Prove same provider/id plus the same effective level deduplicates first-seen, while the same provider/id with Context `max` and Lightweight `low` remains two ordered attempts.

Revise fallback-runner tests so active title behavior is supplied as `{ model: activeModel, thinkingLevel: "minimal" }`. Prove configured same-model `off` then active `minimal` are both attempted, configured same-model `minimal` deduplicates the active attempt, throws/undefined advance in order, and frozen model/attempt objects remain unchanged.

- [ ] **Step 2: Run resolver tests and confirm the red phase**

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts`

Expected: FAIL because candidates currently carry only models and deduplicate only provider/id.

- [ ] **Step 3: Implement descriptor resolution and fallback**

Change the public contracts to:

```ts
export interface UtilityModelResolver<TModel extends UtilityModelIdentity> {
  configuredCandidates(
    task: UtilityModelTask,
  ): Promise<readonly ResolvedUtilityModel<TModel>[]>;
}

export interface UtilityModelResolverDependencies<
  TModel extends UtilityModelIdentity,
> {
  loadConfig(): UtilityModelResolverConfig;
  modelRuntime: UtilityModelResolverRuntime<TModel>;
  thinkingLevelsForModel(model: TModel | undefined): readonly string[];
  logger?: UtilityModelResolverLogger;
}

export async function runWithUtilityModelFallback<
  TModel extends UtilityModelIdentity,
  TResult,
>(
  resolver: UtilityModelResolver<TModel>,
  task: UtilityModelTask,
  activeAttempt: UtilityModelAttempt<TModel> | undefined,
  run: (
    attempt: UtilityModelAttempt<TModel>,
  ) => Promise<TResult | undefined> | TResult | undefined,
  onFailure?: (
    attempt: UtilityModelAttempt<TModel>,
    error: unknown,
  ) => void,
): Promise<TResult | undefined>;
```

For each configured binding, resolve the exact catalog model, get its supported levels, and calculate:

```ts
function effectiveThinkingLevel(
  binding: UtilityModelBinding,
  supported: readonly string[],
): ThinkingLevel | undefined {
  if (binding.thinkingLevel !== undefined) {
    return supported.includes(binding.thinkingLevel)
      ? binding.thinkingLevel
      : undefined;
  }
  return supported.includes("minimal") ? "minimal" : "off";
}
```

`undefined` means skip an explicitly unsupported slot. Key configured and active attempts by `JSON.stringify([provider, id, thinkingLevel])`. Preserve config/catalog refresh and no-throw logging boundaries.

- [ ] **Step 4: Write failing title-generator request tests**

In `sessionNameGenerator.test.ts`, capture stream options and assert explicit `max` produces `reasoning: "max"`, explicit `off` omits the `reasoning` key entirely, and omitting the new argument keeps `reasoning: "minimal"` for active fallback compatibility.

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: FAIL because the generator has no per-call level and always sends `minimal`.

- [ ] **Step 5: Add request-local title thinking**

Use this signature and options construction:

```ts
export async function generateShortSessionName<TApi extends Api>(
  streamFn: StreamFn,
  model: Model<TApi>,
  firstMessage: string,
  thinkingLevel: ThinkingLevel = "minimal",
): Promise<string | undefined> {
  const stream = await streamFn(model, context, {
    maxTokens: 24,
    ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
    signal: AbortSignal.timeout(SESSION_NAME_TIMEOUT_MS),
  });
  // Preserve existing stream consumption and title cleanup.
}
```

Build `context` from the existing system prompt and first-message truncation before the call; do not alter timeout, token limit, or title cleanup.

- [ ] **Step 6: Write failing extension tests for descriptor propagation**

Change resolver fixtures to return `ResolvedUtilityModel<Model<Api>>` objects. Assert branch-summary stream wrappers inject each descriptor's explicit non-`off` level, while `off` returns the original stream function. Assert compaction receives the exact descriptor level. Add same-model Context `max` then Lightweight `low` retry coverage, level-aware failure logs, auth/call failure advance, and existing abort cancellation. Remove tests that inject `runtimeThinkingLevels` into the extension; level calculation now belongs only to the resolver.

Run: `npm test -- --run src/server/sessions/utilityModelExtension.test.ts`

Expected: FAIL because the extension still expects raw models and computes minimal/off independently.

- [ ] **Step 7: Consume descriptors in the hidden extension**

Remove `runtimeThinkingLevels` from `UtilityModelExtensionDependencies` and delete `utilityThinking()`. For every candidate use `candidate.model` for auth/helper calls and `candidate.thinkingLevel` for both `compact()` and `utilityStreamFunction()`:

```ts
function utilityStreamFunction(
  streamFunction: StreamFn,
  thinkingLevel: ThinkingLevel,
): StreamFn {
  if (thinkingLevel === "off") return streamFunction;
  return (model, context, options) => streamFunction(model, context, {
    ...options,
    reasoning: thinkingLevel,
  });
}
```

Include `slot` and `thinkingLevel` with task/provider/model id in candidate failure logs. Never include auth material. Preserve immediate `{ cancel: true }` on abort and final `undefined` so Pi owns active fallback.

- [ ] **Step 8: Write failing title integration and isolation tests**

Update injected resolver fixtures in `piSessionService.promptQueue.test.ts` to descriptors. Prove a configured Lightweight `high` title attempt sends `high`; after failure the active model sends existing `minimal`; a same-model/same-level active attempt deduplicates; a same-model/different-level active attempt remains. Assert the model object identity and `thinkingLevel: "high"` on the session remain unchanged, `setModel` and `setThinkingLevel` spies are not called, and settings-manager default provider/model setters remain untouched in the default-runtime extension test.

Run: `npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts`

Expected: FAIL because title orchestration still passes raw models.

- [ ] **Step 9: Integrate attempts into title and daemon resolution**

In `maybeGenerateSessionName`, snapshot `session.model` once and call:

```ts
void runWithUtilityModelFallback(
  this.utilityModelResolver,
  "lightweight",
  { model, thinkingLevel: "minimal" },
  (attempt) => generateShortSessionName(
    session.agent.streamFunction,
    attempt.model,
    firstMessage,
    attempt.thinkingLevel,
  ),
  (attempt, error) => {
    this.logger.info(
      {
        provider: attempt.model.provider,
        modelId: attempt.model.id,
        thinkingLevel: attempt.thinkingLevel,
        error: error instanceof Error ? error.message : String(error),
      },
      "utility title model failed",
    );
  },
);
```

Preserve deterministic titles, fallback naming, asynchronous rejection containment, and the narrowed active-model snapshot. Add `thinkingLevelsForModel: runtimeThinkingLevels` to both the default resolver in `PiSessionService` and the daemon resolver in `sessiond.ts`. Update runtime-factory test fixtures to descriptor results; do not change extension installation ownership or runtime refs.

- [ ] **Step 10: Run runtime verification**

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts src/server/sessions/sessionNameGenerator.test.ts src/server/sessions/utilityModelExtension.test.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/piSessionService.lifecycle.test.ts src/server/sessions/piSessionService.tree.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 11: Commit isolated runtime thinking**

```bash
git add src/server/sessions/utilityModelResolver.ts src/server/sessions/utilityModelResolver.test.ts src/server/sessions/utilityModelExtension.ts src/server/sessions/utilityModelExtension.test.ts src/server/sessions/sessionNameGenerator.ts src/server/sessions/sessionNameGenerator.test.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessiond.ts
git commit -m "feat(sessions): apply utility thinking levels"
```

## Task 5: Add dynamic thinking controls to Utility models Settings

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/components/settings/utilityModelSettingsDraft.ts`
- Test: `src/client/src/components/settings/utilityModelSettingsDraft.test.ts`
- Modify: `src/client/src/components/settings/SettingsUtilityModelsPanel.ts:1-239`
- Test: `src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts:1-219`
- Test: `src/client/src/components/SettingsDialog.utilitymodels.test.ts:1-188`

**Interfaces:**

- Consumes: versioned `UtilityModelSettingsResponse`, union `UtilityModelOption`, `UtilityModelOptionV2`, `UtilityModelBinding`, `UtilityModelSettings`, `UtilityModelSettingsUpdate`, `UtilityModelSlot`, `UtilityModelSlotValidation`, `ThinkingLevel`, `KNOWN_THINKING_LEVELS`, and `isKnownThinkingLevel` from Tasks 1 and 3.
- Produces: the pure utility draft API below, one model select and one thinking select per row, lowercase omission-based `auto`, dynamic version 2 options, version 1 auto-only compatibility, complete two-slot saves, and the approved responsive layout.
- Preserves: custom element `settings-utility-models-panel`, selected-machine loading/saving in `SettingsDialog`, `onSave(update)`, stale-request guards, existing capability `settings.utilityModels`, and `SettingsPanelFrame` notice ownership.

```ts
export const AUTO_UTILITY_MODEL_THINKING = "auto" as const;
export type UtilityModelDraftThinkingLevel =
  | ThinkingLevel
  | typeof AUTO_UTILITY_MODEL_THINKING;
export type UtilityModelSettingsDraft = UtilityModelSettings;
export type CompleteUtilityModelSettingsUpdate = Record<
  UtilityModelSlot,
  UtilityModelBinding | null
>;

export interface UtilityModelThinkingOption {
  value: UtilityModelDraftThinkingLevel;
  label: string;
  disabled: boolean;
}

export interface UtilityModelSettingsDraftValidation {
  valid: boolean;
  slots: Record<UtilityModelSlot, UtilityModelSlotValidation>;
}

export function utilityModelSettingsDraftFromResponse(
  response: UtilityModelSettingsResponse,
): UtilityModelSettingsDraft;
export function updateUtilityModelDraftModel(
  draft: UtilityModelSettingsDraft,
  slot: UtilityModelSlot,
  selected: UtilityModelOption | undefined,
): UtilityModelSettingsDraft;
export function updateUtilityModelDraftThinkingLevel(
  draft: UtilityModelSettingsDraft,
  slot: UtilityModelSlot,
  level: UtilityModelDraftThinkingLevel,
): UtilityModelSettingsDraft;
export function utilityModelThinkingOptions(
  response: UtilityModelSettingsResponse,
  binding: UtilityModelBinding | undefined,
): readonly UtilityModelThinkingOption[];
export function validateUtilityModelSettingsDraft(
  draft: UtilityModelSettingsDraft,
  response: UtilityModelSettingsResponse,
): UtilityModelSettingsDraftValidation;
export function utilityModelSettingsUpdateFromDraft(
  draft: UtilityModelSettingsDraft,
  response: UtilityModelSettingsResponse,
): CompleteUtilityModelSettingsUpdate | undefined;
```

- [ ] **Step 1: Write failing pure draft tests**

Create `utilityModelSettingsDraft.test.ts`. Prove response bindings are cloned; selecting any model always drops the previous explicit level; selecting lowercase `auto` removes `thinkingLevel`; selecting an explicit known level stores it. Prove version 2 options are `auto` followed by only the selected model's supported levels ordered through `KNOWN_THINKING_LEVELS`, even when the wire array is scrambled. Prove a stale explicit level appears once as `{ value: level, label: "<level> (unavailable)", disabled: true }`, invalidates only that slot, and remains repairable through `auto`.

Assert `utilityModelSettingsUpdateFromDraft()` returns both own keys with `null` for empty slots, returns `undefined` for stale model/level state, and preserves explicit levels for version 2. A version 1 response cannot create an explicit level through its disabled control; browser-boundary projection is owned and tested by Task 3.

- [ ] **Step 2: Run the draft tests and confirm the red phase**

Run: `npm test -- --run src/client/src/components/settings/utilityModelSettingsDraft.test.ts`

Expected: FAIL because the pure draft module does not exist.

- [ ] **Step 3: Implement the pure draft boundary**

Use immutable object reconstruction throughout; never mutate response options or nested bindings. `utilityModelThinkingOptions()` returns only `auto` for version 1, no model, or a stale model. For a version 2 exact model, order supported known levels with:

```ts
const supported = new Set(selectedOption.thinkingLevels);
const ordered = KNOWN_THINKING_LEVELS.filter((level) => supported.has(level));
```

Insert the stale disabled selected option after `auto` and before supported choices only when the binding has an explicit unsupported level. `updateUtilityModelDraftThinkingLevel()` ignores an explicit level when no model binding exists and rejects values outside the `auto`/known-level domain. Validation requires exact provider/id availability and support for an explicit level; omission is valid. The complete-update converter first validates, then clones each binding and emits both own slot keys; Task 3 owns version-specific wire projection.

- [ ] **Step 4: Convert panel fixtures to version 2 and write failing mounted interaction tests**

Use version 2 options whose reported arrays differ by model, including a complete `off` through `max` fixture. Add mounted jsdom tests proving:

- each row renders `Model` and `Thinking` controls with stable ids and accessible labels;
- the menu order is exactly `auto` followed by the selected model's reported levels, including `xhigh` and `max` only when present;
- when no model is selected, the thinking select is disabled and displays `auto`;
- changing a model after an explicit level resets the row to `auto` and the save payload omits `thinkingLevel`;
- selecting `max` saves it in that binding while preserving the other complete slot decision;
- a saved unsupported level renders `max (unavailable)` as disabled selected, leaves `auto` selectable, marks the row invalid, disables Save, and becomes valid after choosing `auto`;
- loading, saving, stale-model, stale-level, and unsupported-machine states disable the correct controls and Save;
- a version 1 response with `panel.targetLabel = "Lab Mac (remote machine)"` keeps model selection/clearing and Save usable, renders disabled lowercase `auto` thinking controls, and adds this `SettingsPanelFrame` info notice: `Explicit thinking levels require a newer PI WEBUI runtime on Lab Mac (remote machine). Model routing remains available.`

Use real DOM selects and `change` events; do not inspect Lit handler ordering.

- [ ] **Step 5: Run the panel tests and confirm the red phase**

Run: `npm test -- --run src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts`

Expected: FAIL because the panel renders only model selectors.

- [ ] **Step 6: Integrate the draft helper into the panel**

Drive `draft` synchronization through `utilityModelSettingsDraftFromResponse()`. `handleModelChange()` calls `updateUtilityModelDraftModel()`, so even a compatible old explicit level resets. Add a thinking change handler that accepts only `AUTO_UTILITY_MODEL_THINKING` or a string narrowed by `isKnownThinkingLevel`, then calls `updateUtilityModelDraftThinkingLevel()`. `handleSave()` calls `utilityModelSettingsUpdateFromDraft()` and invokes `onSave` only for a defined complete update. Build `canSave` from `validateUtilityModelSettingsDraft()` plus loading/saving/support state; do not duplicate the domain rules inside the Lit component.

- [ ] **Step 7: Render the approved desktop/mobile control layout**

Add an aria-hidden desktop header with `Model` and `Thinking`. Use unframed row grids with stable tracks, for example:

```css
.field-header,
.field-row {
  display: grid;
  grid-template-columns: minmax(140px, 0.6fr) minmax(220px, 1fr) minmax(120px, 140px);
  gap: 16px;
}
```

Each select also has a semantic `<label>` that is visually hidden on desktop and visible on narrow screens. At `max-width: 760px`, hide the desktop header, stack row copy/model/thinking controls, make selects full width, and keep the Save button full width. Preserve 8px control radii, existing color tokens, row dividers, stable widths, and no nested cards.

For version 2 thinking selects, render the helper's options with native value `auto`, a stale disabled selected option when needed, then only the selected model's dynamically supported levels in canonical order. Disable thinking when there is no selected model, the model is stale, editing is globally disabled, or the response is version 1. Keep stale-level controls enabled for repair when the model itself remains available, even though Save is disabled.

When `response.contractVersion === 1`, add the exact upgrade text asserted in Step 4 as a `type: "info"` frame notice. Do not treat a version 1 peer as lacking `settings.utilityModels`; contract version controls only explicit-level availability.

- [ ] **Step 8: Extend dialog tests for complete explicit bindings**

Change the normal `SettingsDialog.utilitymodels.test.ts` fixture to version 2 with level arrays. Prove selected-machine save forwards an explicit binding with contract version 2 unchanged, and local confirmed save merges the complete returned bindings including `thinkingLevel` into both `configResponse.config.utilityModels` and `effectiveConfig.utilityModels`. Keep stale-load, capability transition, response-version forwarding, missing-response guard, and task-specific error tests unchanged in behavior.

- [ ] **Step 9: Run UI verification**

Run: `npm test -- --run src/client/src/components/settings/utilityModelSettingsDraft.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts src/client/src/components/SettingsDialog.modeltiers.test.ts src/client/src/components/SettingsDialog.general.test.ts`

Expected: PASS.

Run: `npx eslint src/client/src/components/settings/utilityModelSettingsDraft.ts src/client/src/components/settings/utilityModelSettingsDraft.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 10: Verify real desktop and mobile geometry with Chromium**

Use the project procedure at `/home/henry/.pi/agent/projects-memory/pi-webui/skills/probe-narrow-lit-layout-with-chromium-cdp/SKILL.md`. Create a temporary fixture under `src/client` that imports the real panel and mounts a version 2 response containing long provider/model labels plus `xhigh`/`max`. Start Vite on an unused strict port, then use Chromium CDP device emulation at `1200x800` and `390x844`.

Record that the emulated `window.innerWidth` is exact, document and panel scroll widths do not exceed client widths, model/thinking controls and row copy have no pairwise overlap, desktop columns align across both rows, mobile controls stack with nonnegative gaps, and every visible label fits or clips within its own control. Capture screenshots for both states as transient review evidence. Stop Chromium and Vite and remove the fixture, CDP script, profiles, screenshots, and logs before staging; `git status --short` must contain only intended feature files.

- [ ] **Step 11: Commit the Settings controls**

```bash
git add src/client/src/components/settings/utilityModelSettingsDraft.ts src/client/src/components/settings/utilityModelSettingsDraft.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts
git commit -m "feat(settings): configure utility thinking levels"
```

## Task 6: Document, release-note, and verify utility thinking

**Implementer tier:** Standard

**Files:**

- Modify: `docs/config.md:60-82,233-245`
- Modify: `docs/config.html:210-235,657-673`
- Modify: `.changeset/add-utility-model-settings.md:1-5`

**Interfaces:**

- Consumes: persisted optional `utilityModels.<slot>.thinkingLevel`, lowercase `auto` omission semantics, dynamic model-supported levels, version 1/version 2 compatibility, and exact runtime fallback/isolation behavior delivered by Tasks 1-5.
- Produces: synchronized canonical Markdown/HTML configuration guidance and one updated patch release fragment for `@hyperdreamer/pi-webui`.
- Preserves: concise `README.md`, generated-only `CHANGELOG.md`, existing utility capability/path names, and exactly one utility-model Changeset.

- [ ] **Step 1: Update both canonical config examples**

Show one explicit level and one auto binding so omission is visible:

```json
"utilityModels": {
  "lightweight": {
    "provider": "anthropic",
    "id": "claude-haiku",
    "thinkingLevel": "low"
  },
  "context": {
    "provider": "anthropic",
    "id": "claude-sonnet"
  }
}
```

Keep Markdown and HTML examples structurally identical. Do not use a literal `auto` field.

- [ ] **Step 2: Synchronize Utility models behavior guidance**

In both Utility models sections explain:

- each row chooses one model and one level for every operation routed through that row;
- the UI displays lowercase `auto`, represented by omitted `thinkingLevel`;
- `auto` uses `minimal` when the exact model supports it, otherwise `off`;
- explicit options come from that selected model and may include all levels through `xhigh`/`max`;
- changing model resets to `auto`;
- a saved unsupported explicit level remains visible, blocks save, and causes that runtime slot to be skipped until repaired;
- Context-to-Lightweight fallback uses each row's own configured level;
- the active-session fallback keeps existing behavior and utility calls never change model/thinking/default state;
- version 1 remotes remain model-configurable but require an upgraded runtime for explicit levels.

Keep the existing selected-machine and immediate-next-operation statements. Leave `README.md` unchanged.

- [ ] **Step 3: Update the existing Changeset in place**

Replace only the release-note prose, preserving its patch frontmatter and filename:

```md
---
"@hyperdreamer/pi-webui": patch
---

Add Utility models settings for selecting separate models and supported thinking levels for automatic titles, branch summaries, and compaction without changing active-session model or thinking state.
```

Do not add another `.changeset` file and do not edit `CHANGELOG.md`.

- [ ] **Step 4: Run focused cross-layer verification**

Run: `git diff --check`

Expected: PASS.

Run: `npm test -- --run src/config.test.ts src/server/sessions/utilityModelSettingsService.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/server/sessions/utilityModelResolver.test.ts src/server/sessions/sessionNameGenerator.test.ts src/server/sessions/utilityModelExtension.test.ts src/server/sessions/piSessionService.promptQueue.test.ts src/client/src/components/settings/utilityModelSettingsDraft.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

Run: `npm run knip`

Expected: PASS except for any pre-existing informational configuration hints that do not change the exit status.

- [ ] **Step 5: Run publication and full-suite verification**

Run: `npm run pack:dry`

Expected: PASS and include the built package's documented/configured feature surfaces without adding dependencies.

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 6: Inspect final invariants and scope**

Confirm the feature diff contains no `README.md` or `CHANGELOG.md` change, no dependency or lockfile change, no root-relative client API path, and exactly one utility-model Changeset. Search production utility paths and confirm no call to `setModel`, `setThinkingLevel`, `setDefaultModelAndProvider`, or default-thinking persistence was added. Confirm `docs/config.md` and `docs/config.html` make the same user-visible claims. Record in the implementation report that `src/server/sessiond.ts` changed and a manual `systemctl --user restart pi-webui-sessiond.service` is required when disruption is acceptable; do not run it.

- [ ] **Step 7: Commit documentation and release note**

```bash
git add docs/config.md docs/config.html .changeset/add-utility-model-settings.md
git commit -m "docs: document utility thinking levels"
```
