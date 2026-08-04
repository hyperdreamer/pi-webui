# Utility Model Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add selected-machine Utility models settings that route titles and branch summaries through a lightweight model and compaction through a context-first fallback chain without changing the active session model.

**Architecture:** Persist two optional exact model references in PI WEBUI's machine-global config and expose them through a strict versioned daemon API. A resolver reads the current config and authenticated catalog at operation time; automatic titles invoke it directly, while a hidden inline Pi extension intercepts branch-summary and compaction hooks and calls Pi's exported summarization helpers with configured utility models. The Settings UI consumes the new machine-targeted contract in a category separate from Model tiers.

**Tech Stack:** TypeScript, Fastify, Lit, Vitest, Pi coding-agent SDK extension hooks, Changesets.

## Global Constraints

- Node.js 22.19.0 is the version floor; do not use newer-only APIs.
- Add no runtime dependencies.
- Keep Utility models as a separate Settings category from Model tiers.
- Title generation and branch summaries use lightweight, then the active session model.
- Compaction uses context, then lightweight, then the active session model.
- Unset, malformed, unavailable, unauthenticated, or failed utility candidates must advance through that fallback order; both settings unset must preserve current behavior.
- Never call `setModel`, `setDefaultModelAndProvider`, or otherwise mutate the active session model, thinking level, or Pi's remembered default for a utility call.
- Persist utility models machine-globally in `$PI_WEBUI_CONFIG` / `~/.config/pi-webui/config.json`, and target the selected machine in Settings.
- Application-owned client paths remain application-relative, encode dynamic machine IDs, and resolve exactly once through the existing `request()` boundary.
- Follow test-first development: add a failing focused test, run it and observe the expected failure, then add the minimum production code.
- Add a patch Changeset for `@hyperdreamer/pi-webui`; do not edit `CHANGELOG.md`.
- Keep `README.md` concise; canonical configuration documentation belongs in both `docs/config.md` and `docs/config.html`.

## Task 1: Add the utility-model configuration domain

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:1-180`
- Modify: `src/config.ts:1-310`
- Modify: `src/config.test.ts:1-135`

**Interfaces:**

- Consumes: existing `TierModelRef = { provider: string; id: string }` from `src/shared/apiTypes.ts`.
- Produces: `UTILITY_MODEL_SLOTS`, `UtilityModelSlot`, `UtilityModelSettings`, `UtilityModelSettingsUpdate`, `UtilityModelOption`, `UtilityModelSlotValidation`, and `UtilityModelSettingsResponse` in `src/shared/apiTypes.ts` with the exact signatures below.
- Produces: `parseUtilityModelsConfig(value: unknown, path: string): UtilityModelSettings` and `replacePiWebUiUtilityModels(utilityModels: UtilityModelSettings, options?: LoadOptions): LoadedPiWebUiConfig` in `src/config.ts`.
- Extends: `PiWebUiConfigValues` with `utilityModels?: UtilityModelSettings` and `LoadedPiWebUiConfig` with `utilityModelsError?: string`.

- [ ] **Step 1: Write failing config persistence and parser tests**

Add focused cases to `src/config.test.ts` that prove:

```ts
const utilityModels = {
  lightweight: { provider: "acme", id: "small" },
  context: { provider: "acme", id: "large" },
};

savePiWebUiConfig({ utilityModels }, testOptions());
expect(loadPiWebUiConfig(testOptions()).config.utilityModels).toEqual(utilityModels);
```

Also assert that `replacePiWebUiUtilityModels({ context: utilityModels.context }, testOptions())` removes the old lightweight slot while preserving unrelated top-level fields; malformed external values such as `{ utilityModels: { lightweight: { provider: "acme" } } }` produce `loaded.utilityModelsError` without blocking other valid config; unrelated saves preserve malformed raw utility config; unknown slot keys, unknown model-reference keys, empty provider, and empty id are rejected.

- [ ] **Step 2: Run the config test and confirm the red phase**

Run: `npm test -- --run src/config.test.ts`

Expected: FAIL because `utilityModels`, `replacePiWebUiUtilityModels`, and utility config error reporting do not exist.

- [ ] **Step 3: Add the exact shared contract**

Insert after `TierModelRef` in `src/shared/apiTypes.ts`:

```ts
export const UTILITY_MODEL_SLOTS = ["lightweight", "context"] as const;
export type UtilityModelSlot = (typeof UTILITY_MODEL_SLOTS)[number];

export interface UtilityModelSettings {
  lightweight?: TierModelRef;
  context?: TierModelRef;
}

export type UtilityModelSettingsUpdate = Partial<
  Record<UtilityModelSlot, TierModelRef | null>
>;

export interface UtilityModelOption {
  model: TierModelRef;
  name?: string;
}

export interface UtilityModelSlotValidation {
  valid: boolean;
  reason?: string;
}

export interface UtilityModelSettingsResponse {
  contractVersion: 1;
  settings: UtilityModelSettings;
  models: UtilityModelOption[];
  slots: Record<UtilityModelSlot, UtilityModelSlotValidation>;
  valid: boolean;
  configError?: string;
}
```

Add `utilityModels?: UtilityModelSettings` to `PiWebUiConfigValues` with a machine-global comment.

- [ ] **Step 4: Implement strict non-blocking config parsing and replacement**

Extend `LoadedPiWebUiConfig` and the internal `ParsedPiWebUiConfig` with `utilityModelsError?: string`. Parse `utilityModels` in the same non-blocking style as `modelTiers` when loading an external file, but keep `savePiWebUiConfig` strict.

Implement `parseUtilityModelsConfig` with these rules:

```ts
if (!isRecord(value)) {
  throw new Error(`PI WEBUI config utilityModels must be an object: ${path}`);
}
const unknownKey = Object.keys(value).find(
  (key) => key !== "lightweight" && key !== "context",
);
if (unknownKey !== undefined) {
  throw new Error(
    `PI WEBUI config utilityModels contains unknown key ${JSON.stringify(unknownKey)}: ${path}`,
  );
}
```

Parse each present slot as an exact `{ provider, id }` object with no unknown keys and non-empty strings. An empty object is valid and means all utility classes fall back. Add `utilityModels` to `piWebUiConfigRecord`, make a normalized utility value replace the raw existing `utilityModels` field in `savePiWebUiConfig`, and add:

```ts
export function replacePiWebUiUtilityModels(
  utilityModels: UtilityModelSettings,
  options: LoadOptions = {},
): LoadedPiWebUiConfig {
  const loaded = loadPiWebUiConfig(options);
  return savePiWebUiConfig({ ...loaded.config, utilityModels }, options);
}
```

Reuse one exact model-reference parser for both the new utility refs and the nested `modelTiers.*.model` refs so provider/id validation stays identical.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- --run src/config.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the configuration domain**

```bash
git add src/shared/apiTypes.ts src/config.ts src/config.test.ts
git commit -m "feat(config): add utility model settings"
```

## Task 2: Expose machine-targeted utility-model settings

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/sessions/utilityModelSettingsService.ts`
- Create: `src/server/sessions/utilityModelSettingsService.test.ts`
- Create: `src/server/sessions/utilityModelSettingsRoutes.ts`
- Create: `src/server/sessions/utilityModelSettingsRoutes.test.ts`
- Modify: `src/server/sessiond.ts:1-135`
- Modify: `src/server/sessiond/sessionProxyRoutes.ts:45-65`
- Modify: `src/server/sessiond/sessionProxyRoutes.test.ts:50-95`
- Modify: `src/shared/apiTypes.ts:1-150`
- Modify: `src/shared/capabilities.ts:1-75`
- Modify: `src/shared/capabilities.test.ts:1-55`
- Modify: `src/shared/federatedRoutes.ts:15-35`
- Modify: `src/client/src/api/parsers.ts:1320-1455`
- Modify: `src/client/src/api/parsers.test.ts:985-1025,1100-1145`
- Modify: `src/client/src/api/clients.ts:1-50,175-205,430-455`
- Modify: `src/client/src/api/clients.test.ts:1-6,185-210,870-925`
- Modify: `src/client/src/api.ts:1-3`

**Interfaces:**

- Consumes: all Task 1 utility-model types; `parseUtilityModelsConfig`; `replacePiWebUiUtilityModels`.
- Produces: `UtilityModelSettingsService` with `inspect(): Promise<UtilityModelSettingsResponse>` and `update(patch: UtilityModelSettingsUpdate): Promise<UtilityModelSettingsResponse>`.
- Produces: daemon `GET /utility-models` and `PUT /utility-models`; PUT body is exactly `{ settings: UtilityModelSettingsUpdate }`.
- Produces: capability `PI_WEBUI_CAPABILITIES.utilityModelSettings = "settings.utilityModels"` requiring both web and sessiond components.
- Produces: client `utilityModelsApi.settings(machineId?)` and `utilityModelsApi.save(update, machineId?)`.

- [ ] **Step 1: Write failing service and route tests**

Create service tests modeled on `modelTierSettingsService.test.ts`. Cover all observable behavior:

```ts
expect(await service.inspect()).toEqual({
  contractVersion: 1,
  settings: {
    lightweight: { provider: "acme", id: "small" },
    context: { provider: "acme", id: "large" },
  },
  models: [
    { model: { provider: "acme", id: "small" }, name: "Acme Small" },
    { model: { provider: "acme", id: "large" }, name: "Acme Large" },
  ],
  slots: { lightweight: { valid: true }, context: { valid: true } },
  valid: true,
});
```

Assert empty settings are valid; stale configured refs remain in `settings` and invalidate only their slot; config parse errors return `configError`, empty settings, and invalid rows; `update({ context: ref })` preserves the existing lightweight ref; `update({ lightweight: null })` clears only lightweight; unavailable replacement refs reject before saving; inspection and update refresh with `{ allowNetwork: false }`.

Create route tests proving GET passthrough, PUT normalization of exact refs and null clears, rejection of unknown request fields/slot fields/model fields/missing `settings`, service errors mapped to 400, and the two federated route entries.

- [ ] **Step 2: Run the new server tests and confirm they fail**

Run: `npm test -- --run src/server/sessions/utilityModelSettingsService.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement the service boundary**

Create these public dependency contracts in `utilityModelSettingsService.ts`:

```ts
export interface UtilityModelSettingsConfig {
  utilityModels?: UtilityModelSettings;
  utilityModelsError?: string;
}

export interface UtilityModelSettingsModel {
  provider: string;
  id: string;
  name?: string;
}

export interface UtilityModelSettingsModelRuntime<TModel extends UtilityModelSettingsModel> {
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  getAvailableSnapshot(): readonly TModel[];
}

export interface UtilityModelSettingsService {
  inspect(): Promise<UtilityModelSettingsResponse>;
  update(patch: UtilityModelSettingsUpdate): Promise<UtilityModelSettingsResponse>;
}
```

`createUtilityModelSettingsService` must refresh once per inspection snapshot, project model options without thinking levels, and validate only configured refs. For updates, load the current valid settings (or `{}` when malformed), apply each own patch key, delete null slots, validate the entire result against one refreshed snapshot, call `saveConfig({ utilityModels: next })`, then return a confirmed post-save inspection. Use slot-specific messages such as `lightweight utility model acme/ghost is unavailable`.

- [ ] **Step 4: Implement strict Fastify routes and daemon wiring**

Create `registerUtilityModelSettingsRoutes(app, service, prefix = "")`. Reject non-object bodies, anything other than the single `settings` field, unknown slot names, and malformed refs. Preserve own-property nulls in the update object so clear differs from omitted/preserve.

In `sessiond.ts`, define one `loadUtilityModelConfig` closure using `loadPiWebUiConfig({ env: daemonEnvironment })`; create the service with `auth.runtime`; save through `replacePiWebUiUtilityModels(..., { env: daemonEnvironment })`; include `utilityModels` in the startup runtime object and register its routes. Add `/utility-models` to the local session proxy and both GET/PUT specs to `FEDERATED_HTTP_ROUTES`.

- [ ] **Step 5: Add capability and proxy regression coverage**

Add the capability constant and place it in `WEB_RUNTIME_CAPABILITIES`, `SESSIOND_RUNTIME_CAPABILITIES`, and `EFFECTIVE_CAPABILITY_REQUIREMENTS` with both components required. Extend capability tests exactly as for `settings.modelTiers`. Add a proxy test expecting:

```ts
expect(daemon.requests).toEqual([
  { method: "GET", path: "/utility-models", body: undefined },
  {
    method: "PUT",
    path: "/utility-models",
    body: { settings: { lightweight: null, context: { provider: "acme", id: "large" } } },
  },
]);
```

Run: `npm test -- --run src/shared/capabilities.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/sessions/utilityModelSettingsService.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts`

Expected: PASS.

- [ ] **Step 6: Write failing client parser and path tests**

Add parser cases for a valid response, empty settings, stale settings, malformed provider/id, unknown slot maps, malformed validation rows, and contract version 2. Add client tests proving an encoded selected-machine path and PUT body `{ settings: update }` at an application-relative boundary.

Run: `npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts`

Expected: FAIL because the parser and client do not exist.

- [ ] **Step 7: Implement the strict client contract**

Add `parseUtilityModelSettingsResponse(value)` beside the model-tier parser. Require contract version 1, exact optional `lightweight`/`context` keys in `settings`, exact model refs, model options with optional names, and both validation rows in `slots`. Do not silently discard malformed fields.

Add:

```ts
function utilityModelsPath(machineId = "local"): string {
  return `${machinePrefix(machineId)}/utility-models`;
}

export const utilityModelsApi = {
  settings: (machineId = "local") =>
    request(utilityModelsPath(machineId), parseUtilityModelSettingsResponse),
  save: (settings: UtilityModelSettingsUpdate, machineId = "local") =>
    request(utilityModelsPath(machineId), parseUtilityModelSettingsResponse, {
      method: "PUT",
      body: JSON.stringify({ settings }),
    }),
};
```

Export it from `src/client/src/api.ts` and the aggregate API object.

- [ ] **Step 8: Run all Task 2 tests and typecheck**

Run: `npm test -- --run src/server/sessions/utilityModelSettingsService.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/shared/capabilities.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit the machine API**

```bash
git add src/server/sessions/utilityModelSettingsService.ts src/server/sessions/utilityModelSettingsService.test.ts src/server/sessions/utilityModelSettingsRoutes.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/server/sessiond.ts src/server/sessiond/sessionProxyRoutes.ts src/server/sessiond/sessionProxyRoutes.test.ts src/shared/apiTypes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts src/shared/federatedRoutes.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts
git commit -m "feat(settings): expose utility model configuration"
```

## Task 3: Build utility-model resolution and Pi summarization handlers

**Implementer tier:** Capable

**Files:**

- Create: `src/server/sessions/utilityModelResolver.ts`
- Create: `src/server/sessions/utilityModelResolver.test.ts`
- Create: `src/server/sessions/utilityModelExtension.ts`
- Create: `src/server/sessions/utilityModelExtension.test.ts`

**Interfaces:**

- Consumes: `UtilityModelSettings`, `UtilityModelSlot`, and exact provider/id refs from Task 1.
- Produces: `UtilityModelTask = "lightweight" | "context"`.
- Produces: `UtilityModelResolver<TModel>.configuredCandidates(task): Promise<readonly TModel[]>` and `createUtilityModelResolver(deps)`.
- Produces: `runWithUtilityModelFallback(resolver, task, activeModel, run, onFailure?): Promise<TResult | undefined>` for title work.
- Produces: `UtilityModelExtensionRuntimeRefs`, `createUtilityModelHandlers(deps)`, and hidden `createUtilityModelExtension(deps): InlineExtension`.

- [ ] **Step 1: Write failing resolver tests**

Use small fake model objects containing `provider`, `id`, `name`, `reasoning`, `contextWindow`, and `maxTokens`. Prove:

- lightweight returns only the configured lightweight model;
- context returns context then lightweight;
- duplicate provider/id candidates are deduplicated in first-seen order;
- absent, malformed, stale, and refresh-failing config yields no configured candidates;
- refresh uses `{ allowNetwork: false }` on every operation so current settings/catalog are observed;
- `runWithUtilityModelFallback` tries configured candidates then the active model, treats thrown errors and `undefined` results as failures, deduplicates an active model already configured, and never mutates a model object.

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts`

Expected: FAIL because the resolver module is absent.

- [ ] **Step 2: Implement the resolver and generic fallback runner**

Use these contracts:

```ts
export type UtilityModelTask = "lightweight" | "context";

export interface UtilityModelIdentity {
  provider: string;
  id: string;
}

export interface UtilityModelResolver<TModel extends UtilityModelIdentity> {
  configuredCandidates(task: UtilityModelTask): Promise<readonly TModel[]>;
}
```

`createUtilityModelResolver` receives injected `loadConfig`, a runtime with `refresh` and `getAvailableSnapshot`, and an optional logger. The slot order is `["lightweight"]` or `["context", "lightweight"]`. Resolve only exact refs in the current available snapshot; catch and log load/refresh failures at this fallback boundary and return `[]`.

`runWithUtilityModelFallback` appends the active model when present, deduplicates by provider/id, invokes candidates sequentially, returns the first non-undefined result, and invokes `onFailure(model, error)` for thrown calls while continuing.

- [ ] **Step 3: Run resolver tests**

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts`

Expected: PASS.

- [ ] **Step 4: Write failing branch-summary and compaction handler tests**

Test `createUtilityModelHandlers` directly with injected fake `generateBranchSummary` and `compact` functions. Cover:

- a requested non-empty branch summary uses only the lightweight configured candidate and returns summary text, `{ readFiles, modifiedFiles }`, and usage;
- no requested summary, no entries, no configured model, missing runtime refs, or a failed lightweight call returns `undefined`, allowing Pi's active-session default handler to run;
- compaction tries context, then lightweight after a throw, and returns the lightweight compaction result;
- all configured compaction failures return `undefined`, allowing Pi's active-session compaction;
- abort stops candidate iteration and returns `{ cancel: true }`;
- auth `apiKey`, normalized non-null headers, provider env, abort signal, custom instructions, Pi retry settings, branch reserve tokens, the current session stream function, and minimal supported utility thinking are passed to Pi's helpers;
- handler execution reads `ctx.model` but never calls any model mutation API;
- the inline extension is named `pi-webui-utility-models`, hidden, and registers exactly `session_before_tree` and `session_before_compact`.

Run: `npm test -- --run src/server/sessions/utilityModelExtension.test.ts`

Expected: FAIL because the extension module is absent.

- [ ] **Step 5: Implement the hidden inline extension**

Define refs that are assigned by the session factory after services/session creation:

```ts
export interface UtilityModelExtensionRuntimeRefs {
  streamFunction?: StreamFn;
  settingsManager?: Pick<
    AgentSessionServices["settingsManager"],
    "getBranchSummarySettings" | "getRetrySettings"
  >;
}
```

For each configured candidate, call `modelRuntime.getAuth(model)` best-effort and pass `apiKey`, headers with null deletion markers removed, and `env` when available. Wrap the session stream function per candidate so reasoning models receive `reasoning: "minimal"` when `runtimeThinkingLevels(model)` supports it; otherwise pass `"off"` to `compact` and do not force a reasoning option.

Branch handling must call Pi's exported `generateBranchSummary(event.preparation.entriesToSummarize, options)`, treat `error`, missing summary, throws, and aborted calls as non-success, and return:

```ts
{
  summary: {
    summary: result.summary,
    details: {
      readFiles: result.readFiles ?? [],
      modifiedFiles: result.modifiedFiles ?? [],
    },
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  },
}
```

Compaction handling must call Pi's exported `compact` with event preparation/custom instructions/signal, candidate auth, minimal thinking, current stream function, provider env, and retry settings. Log candidate failures with task and provider/id, then try the next configured candidate. Returning `undefined` is the intentional final fallback to Pi's built-in active-session-model path.

- [ ] **Step 6: Run Task 3 tests and typecheck**

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts src/server/sessions/utilityModelExtension.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the runtime core**

```bash
git add src/server/sessions/utilityModelResolver.ts src/server/sessions/utilityModelResolver.test.ts src/server/sessions/utilityModelExtension.ts src/server/sessions/utilityModelExtension.test.ts
git commit -m "feat(sessions): route utility summarization models"
```

## Task 4: Integrate utility routing into sessions and titles

**Implementer tier:** Capable

**Files:**

- Modify: `src/server/sessions/piSessionService.ts:1-180,430-610,890-940,977-1245,4670-4720`
- Modify: `src/server/sessions/piSessionService.promptQueue.test.ts:1-145`
- Modify: `src/server/sessions/piSessionService.testSupport.ts:35-115,190-235`
- Modify: `src/server/sessiond.ts:55-115`

**Interfaces:**

- Consumes: `UtilityModelResolver<AgentModel>`, `createUtilityModelResolver`, `runWithUtilityModelFallback`, `UtilityModelExtensionRuntimeRefs`, and `createUtilityModelExtension` from Task 3.
- Consumes: the `loadUtilityModelConfig` closure and utility settings service established in Task 2.
- Extends: `PiSessionServiceDependencies` with optional `utilityModelResolver?: UtilityModelResolver<AgentModel>`.
- Produces: test-visible `createDefaultRuntimeFactory(...)` with an optional injected SDK adapter containing `createServices: typeof createAgentSessionServices` and `createFromServices: typeof createAgentSessionFromServices`; production defaults to the real SDK functions.
- Preserves: existing `PiAgentSession.agent.streamFunction`, `session.model`, `session.thinkingLevel`, and Pi default-model persistence behavior.

- [ ] **Step 1: Write failing automatic-title fallback tests**

Extend the existing first-prompt naming test with injected resolvers. Add cases that prove:

```ts
utilityModelResolver: {
  configuredCandidates: vi.fn().mockResolvedValue([lightweightModel]),
}
```

causes the first title stream call to receive `lightweightModel`, while `fake.session.model` remains the original active model. Add a stream function that returns an error/undefined for lightweight and a valid title for the active model; assert call order `[lightweightModel, activeModel]` and the resulting title. Add a resolver returning `[]` and assert the existing one-call active-model behavior. Keep the existing deterministic relay title path free of all model calls.

Run: `npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts`

Expected: FAIL because `PiSessionServiceDependencies` and title generation do not use a utility resolver.

- [ ] **Step 2: Integrate the resolver into automatic title generation**

Store an injected resolver on `PiSessionService`; when absent, create one from `loadPiWebUiConfig()` and `modelRuntime` so direct service construction preserves production behavior. Replace the one-model title call with:

```ts
void runWithUtilityModelFallback(
  this.utilityModelResolver,
  "lightweight",
  session.model,
  (candidate) =>
    generateShortSessionName(session.agent.streamFunction, candidate, firstMessage),
  (candidate, error) => {
    this.logger.info(
      {
        provider: candidate.provider,
        modelId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "utility title model failed",
    );
  },
).then((name) => {
  this.applyGeneratedSessionName(session, name ?? fallbackSessionName(firstMessage));
});
```

The runner must own thrown-call fallback so this promise settles unless the final bookkeeping itself fails. Do not read or write Pi default settings here.

- [ ] **Step 3: Run title tests**

Run: `npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts`

Expected: PASS.

- [ ] **Step 4: Write a failing runtime-factory wiring test through an injected SDK adapter**

Export `createDefaultRuntimeFactory` for focused module testing and add a final optional adapter dependency shaped exactly as:

```ts
interface PiWebUiAgentSessionSdk {
  createServices: typeof createAgentSessionServices;
  createFromServices: typeof createAgentSessionFromServices;
}
```

In `piSessionService.promptQueue.test.ts`, inject `createServices` and `createFromServices` spies. Have `createServices` return a typed fake `AgentSessionServices` with a fake settings manager; have `createFromServices` return a fake result whose session has a known `agent.streamFunction`. Invoke the returned runtime factory and assert:

- `createServices` receives one hidden inline extension named `pi-webui-utility-models` in `resourceLoaderOptions.extensionFactories`;
- the same returned services object is passed to `createFromServices`;
- the runtime result preserves the created session and services;
- neither spy observes a `setModel` or default-model mutation.

Run: `npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts`

Expected: FAIL because the default factory is not exported, accepts no SDK adapter or utility resolver, and installs no inline extension.

- [ ] **Step 5: Install the extension in each default runtime without changing model state**

Add the optional SDK adapter as the final `createDefaultRuntimeFactory` dependency, defaulting to `{ createServices: createAgentSessionServices, createFromServices: createAgentSessionFromServices }`. Use those adapter methods in the factory so the test exercises the real orchestration without booting a real SDK session.

Extend `createDefaultRuntimeFactory` to accept the resolver and logger. For each invocation, allocate one `UtilityModelExtensionRuntimeRefs` object and pass:

```ts
resourceLoaderOptions: {
  extensionFactories: [
    createUtilityModelExtension({
      resolver: utilityModelResolver,
      modelRuntime,
      runtimeRefs,
      logger,
    }),
  ],
},
```

into `createAgentSessionServices`. Immediately after services resolve, assign `runtimeRefs.settingsManager = services.settingsManager`; immediately after `createAgentSessionFromServices` resolves, assign `runtimeRefs.streamFunction = result.session.agent.streamFunction`. The extension factory closes over the object, so handlers see current refs without changing `result.session.model`.

In `sessiond.ts`, create one resolver with the daemon-environment-aware `loadUtilityModelConfig` closure and `auth.runtime`, pass it to `PiSessionService`, and reuse the same config loader for the settings service. This makes setting changes visible to existing sessions on the next utility operation.

- [ ] **Step 6: Run runtime and regression tests**

Run: `npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/utilityModelResolver.test.ts src/server/sessions/utilityModelExtension.test.ts src/server/sessions/piSessionService.lifecycle.test.ts src/server/sessions/piSessionService.tree.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit session integration**

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/piSessionService.testSupport.ts src/server/sessiond.ts
git commit -m "feat(sessions): apply utility models to internal tasks"
```

## Task 5: Add the separate Utility models Settings category

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/components/settings/SettingsUtilityModelsPanel.ts`
- Create: `src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts`
- Create: `src/client/src/components/SettingsDialog.utilitymodels.test.ts`
- Modify: `src/client/src/components/SettingsDialog.ts:1-220,350-410,500-570,625-750,790-825`
- Modify: `src/client/src/components/SettingsDialog.general.test.ts:12-22`
- Modify: `src/client/src/components/settings/settingsMachineTarget.ts:1-65`
- Modify: `src/client/src/components/settings/settingsMachineTarget.test.ts:1-90`
- Modify: `src/client/src/settingsRoute.ts:1-30`
- Modify: `src/client/src/settingsRoute.test.ts:35-50`

**Interfaces:**

- Consumes: `utilityModelsApi`, `UtilityModelSettings`, `UtilityModelSettingsUpdate`, `UtilityModelOption`, and `UtilityModelSettingsResponse` from Tasks 1-2.
- Produces: custom element `settings-utility-models-panel` with `onSave?: (update: UtilityModelSettingsUpdate) => void | Promise<void>`.
- Produces: `SettingsSection` value `utilitymodels` with aliases `utility-models` and `utilities`.
- Produces: `utilityModelSettingsSupport(target, runtime)` gated on `settings.utilityModels` for remote machines.

- [ ] **Step 1: Write failing route, capability-targeting, and panel tests**

Extend route tests:

```ts
expect(parseSettingsSection("utilitymodels")).toBe("utilitymodels");
expect(parseSettingsSection("utility-models")).toBe("utilitymodels");
expect(parseSettingsSection("utilities")).toBe("utilitymodels");
```

Extend machine-target tests to prove local support, unknown remote state before runtime verification, supported only with `PI_WEBUI_CAPABILITIES.utilityModelSettings`, and unsupported when a remote advertises generic selected-machine settings or model tiers but not utility models.

Create panel tests proving:

- the heading is `Utility models` and there are exactly two labeled rows;
- lightweight copy says `Titles and branch summaries`;
- context copy says `Compaction and context summaries`;
- empty lightweight renders `Use active session model`;
- empty context renders `Use lightweight, then active session model`;
- provider/id model options are distinct and names are shown;
- a stale configured ref remains visible as unavailable and disables save until cleared/replaced;
- clearing both sends `{ lightweight: null, context: null }` exactly once;
- support/loading/saving states disable editing and save;
- network, config, availability, and success notices use `SettingsPanelFrame`.

Run: `npm test -- --run src/client/src/settingsRoute.test.ts src/client/src/components/settings/settingsMachineTarget.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts`

Expected: FAIL because the section, support helper, and panel do not exist.

- [ ] **Step 2: Implement the focused two-selector panel**

Use unframed field rows, native selects, stable labels, and the existing `settings-panel-frame`; do not nest cards. The draft is a `UtilityModelSettings` copied from each new response. Validate each configured ref against `response.models`, while empty slots remain valid. Model keys must encode both fields without ambiguous manual splitting; use `JSON.stringify([provider, id])` for option values and look up the matching option from the catalog.

`handleSave()` emits both own keys so the server receives an explicit complete UI decision:

```ts
this.onSave?.({
  lightweight: this.draft.lightweight ?? null,
  context: this.draft.context ?? null,
});
```

Show stale options as disabled selected entries, but leave the empty fallback option enabled so users can repair by clearing.

- [ ] **Step 3: Run panel and helper tests**

Run: `npm test -- --run src/client/src/settingsRoute.test.ts src/client/src/components/settings/settingsMachineTarget.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts`

Expected: PASS.

- [ ] **Step 4: Write failing SettingsDialog machine-target tests**

Create `SettingsDialog.utilitymodels.test.ts` using `SettingsDialog.modeltiers.test.ts` conventions. Prove:

- `activeSettingsPanelTag("utilitymodels")` maps to `settings-utility-models-panel`;
- load calls `utilityModelsApi.settings("remote-a")`;
- stale load responses are ignored after machine changes;
- save calls `utilityModelsApi.save(update, "remote-a")`;
- local save merges confirmed `response.settings` into both `configResponse.config.utilityModels` and `effectiveConfig.utilityModels`, then calls `onConfigSaved`;
- remote capability absence avoids requests and shows the upgrade/restart message;
- API failures retain task-specific load/save errors;
- machine and capability transitions reset/reload utility state independently of model-tier state.

Run: `npm test -- --run src/client/src/components/SettingsDialog.utilitymodels.test.ts`

Expected: FAIL because SettingsDialog has no utility-model state or routing.

- [ ] **Step 5: Wire the category into SettingsDialog**

Import the panel and API/types. Add independent response/loading/error/request-sequence state, connected load, machine/capability reset/reload logic, a navigation item directly after Model tiers, and a render branch:

```ts
<settings-utility-models-panel
  .response=${this.utilityModelsConfigResponse}
  .loading=${this.utilityModelsLoading}
  .saving=${this.saving}
  .error=${this.utilityModelsError}
  .savedMessage=${this.savedMessage}
  .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
  .support=${this.utilityModelSettingsSupport()}
  .onReload=${() => this.loadUtilityModelsForTarget()}
  .onSave=${(update: UtilityModelSettingsUpdate) =>
    this.saveUtilityModels(update)}
></settings-utility-models-panel>
```

Use stale-request guards identical in semantics to Model tiers but with separate counters. Gate remote calls on `utilityModelSettingsSupport`. On successful local save, merge the confirmed full settings object and invoke `onConfigSaved`; do not merge the patch because omitted keys preserve values on the server.

Extend `SettingsPanelTag` and `activeSettingsPanelTag`. Add the new mapping to the general routing-contract test.

- [ ] **Step 6: Run all Settings tests and lint the changed UI**

Run: `npm test -- --run src/client/src/settingsRoute.test.ts src/client/src/components/settings/settingsMachineTarget.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts src/client/src/components/SettingsDialog.modeltiers.test.ts src/client/src/components/SettingsDialog.general.test.ts`

Expected: PASS.

Run: `npx eslint src/client/src/components/settings/SettingsUtilityModelsPanel.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts src/client/src/components/settings/settingsMachineTarget.ts src/client/src/settingsRoute.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the Settings UI**

```bash
git add src/client/src/components/settings/SettingsUtilityModelsPanel.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/settings/settingsMachineTarget.ts src/client/src/components/settings/settingsMachineTarget.test.ts src/client/src/settingsRoute.ts src/client/src/settingsRoute.test.ts
git commit -m "feat(settings): add utility model controls"
```

## Task 6: Document and verify utility models

**Implementer tier:** Standard

**Files:**

- Modify: `docs/config.md:35-80,111-132,221-250`
- Modify: `docs/config.html:90-110,165-230,275-315,430-490`
- Create: `.changeset/add-utility-model-settings.md`

**Interfaces:**

- Consumes: the final names `utilityModels.lightweight`, `utilityModels.context`, `settings.utilityModels`, and the exact runtime fallback chains from Tasks 1-5.
- Produces: canonical user-facing configuration documentation synchronized across Markdown and HTML.
- Produces: a patch Changeset for `@hyperdreamer/pi-webui`.

- [ ] **Step 1: Update canonical configuration documentation**

Add `utilityModels` to the immediate-apply list and selected-machine-safe global key list. Add this shape to both global config examples using exact provider/id refs:

```json
"utilityModels": {
  "lightweight": { "provider": "anthropic", "id": "claude-haiku" },
  "context": { "provider": "anthropic", "id": "claude-sonnet" }
}
```

Add a configuration-matrix row with machine-global scope, immediate next-operation application, and remote capability `settings.utilityModels`. Add a dedicated **Utility models** section explaining:

- lightweight handles automatic titles and requested branch summaries;
- context handles compaction;
- title/branch fallback is lightweight then active session model;
- compaction fallback is context then lightweight then active session model;
- empty settings preserve existing active-session behavior;
- unavailable/auth-failing/call-failing candidates advance to the next fallback;
- utility calls never change the selected session model or Pi's remembered default;
- settings target the selected machine and existing sessions read changes on their next utility operation.

Add the HTML side-navigation link and keep all claims synchronized with Markdown. Do not add this detail to `README.md`.

- [ ] **Step 2: Add the patch Changeset**

Create `.changeset/add-utility-model-settings.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Add Utility models settings so automatic titles, branch summaries, and compaction can use separate configured models without changing the active session model.
```

Do not edit `CHANGELOG.md`.

- [ ] **Step 3: Run focused and full verification**

Run: `git diff --check`

Expected: PASS with no whitespace errors.

Run: `npm test -- --run src/config.test.ts src/shared/capabilities.test.ts src/server/sessions/utilityModelSettingsService.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/server/sessions/utilityModelResolver.test.ts src/server/sessions/utilityModelExtension.test.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/settingsRoute.test.ts src/client/src/components/settings/settingsMachineTarget.test.ts src/client/src/components/settings/SettingsUtilityModelsPanel.test.ts src/client/src/components/SettingsDialog.utilitymodels.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 4: Inspect the final diff for behavior and publication scope**

Confirm `git diff --stat $(git merge-base HEAD main)..HEAD` contains no `CHANGELOG.md` change, no new dependency, no root-relative client API path, no active-session `setModel` call in utility code, both config docs, and exactly one utility-model Changeset. Confirm the package allowlist ships `dist`, `docs/config.md`, and the generated feature code after build.

- [ ] **Step 5: Commit documentation and release note**

```bash
git add docs/config.md docs/config.html .changeset/add-utility-model-settings.md
git commit -m "docs: document utility model routing"
```
