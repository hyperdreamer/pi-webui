# Checked Pi Model-Default Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plus-root model-policy initialization detect Pi's swallowed settings-write failures and either durably restore the prior Pi model defaults or report an explicit incomplete rollback.

**Architecture:** Extract Pi `SettingsManager` queue and error-channel semantics into one focused server module that settles writes, inspects `drainErrors()`, and reapplies a captured snapshot with bounded retries. Then reorder complete initialization so target default writes are proven durable before any transcript record is committed, and cover both layers with real `SettingsManager.fromStorage()` regressions.

**Tech Stack:** TypeScript, Node.js, the Pi SDK `SettingsManager`, Vitest.

## Global Constraints

- Implement the approved design in `docs/superpowers/specs/2026-08-05-checked-pi-model-defaults-persistence-design.md`; the controlling feature design is `docs/superpowers/specs/2026-08-03-plus-session-model-policy-preference-design.md`. Do not edit either specification.
- Never treat `SettingsManager.flush()` resolution as proof of durable persistence; `drainErrors()` is the only Pi persistence-error channel.
- Restoration makes at most 3 complete attempts, each reapplying provider, model, and thinking defaults, with no delay between attempts.
- Persistent restoration failure must surface as an `AggregateError` retaining every Pi settings error; never claim durable restoration that did not happen.
- Preserve existing unpublished-root cleanup: failed creation leaves no transcript, no active session, no status event, no `session.created` event, and no preference writeback.
- Add no runtime dependency, no new npm package, no second settings or preference store, and no direct writes to Pi settings files.
- Import Pi only from `@earendil-works/pi-coding-agent`; never deep-import `dist/` paths, and never import Pi types that the package root does not export.
- Change no shared, HTTP, federation, capability, browser, or persisted-file contract, and change no client code.
- Keep `README.md`, `CHANGELOG.md`, `docs/config.md`, `docs/config.html`, package versions, and lockfile versions unchanged, and add no new Changeset; `.changeset/remember-plus-session-model-policy.md` remains the only release note.
- Use red-green TDD: write the test, run it, confirm it fails for the expected reason, then implement.
- Every new export must have a production consumer in the same task so whole-project Knip stays clean.
- Assert durable state by parsing storage content, not only `getGlobalSettings()` or `flush()` call counts.
- Make storage-failure injection deterministic by counting writes inside the storage double; never toggle a failure flag from test code after an async call has started, because the queued writes run later on the microtask queue.
- `SettingsManager.fromStorage()` calls `withLock` while constructing, so a storage double must let those construction reads succeed.
- The changed code is loaded by the session daemon, so the final handoff must state that `pi-webui-sessiond.service` needs a manual restart.

## Task 1: Checked settings-persistence module

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/sessions/modelPolicySettingsPersistence.ts`
- Create: `src/server/sessions/modelPolicySettingsPersistence.test.ts`
- Modify: `src/server/sessions/piSessionService.ts:214-296`
- Modify: `src/server/sessions/piSessionService.ts:445-470`
- Modify: `src/server/sessions/piSessionService.ts:5495-5585`

**Interfaces:**

- Consumes: `isKnownThinkingLevel(value: string): boolean` from `../../shared/thinkingLevels.js`, and `ClientThinkingLevel` from `../types.js`.
- Consumes: the installed Pi `SettingsManager` from `@earendil-works/pi-coding-agent`, whose relevant members are `getGlobalSettings()`, `setDefaultProvider(provider: string)`, `setDefaultModel(modelId: string)`, `setDefaultThinkingLevel(level: ThinkingLevel)`, `flush(): Promise<void>`, and `drainErrors(): { scope: "global" | "project"; error: Error }[]`. `SettingsManager.fromStorage(storage)` accepts `{ withLock(scope, fn) }`; that storage type is not exported from the package root, so pass an object literal and let contextual typing infer the parameters.
- Produces: `interface ModelPolicySettingsSnapshot { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: ClientThinkingLevel }`.
- Produces: `interface ModelPolicySettingsPersistence` declaring `getGlobalSettings()`, `setDefaultProvider(provider: string | undefined)`, `setDefaultModel(modelId: string | undefined)`, `setDefaultThinkingLevel(level: ClientThinkingLevel | undefined)`, `flush(): Promise<void>`, and `drainErrors(): readonly { scope: string; error: Error }[]`. Declare every member in method syntax so Pi's narrower setter parameters stay assignable through method bivariance.
- Produces: `MAX_MODEL_POLICY_SETTINGS_RESTORE_ATTEMPTS = 3`.
- Produces: `modelPolicySettingsPersistence(candidate: unknown): ModelPolicySettingsPersistence`, `captureModelPolicySettings(settings: ModelPolicySettingsPersistence): ModelPolicySettingsSnapshot`, `settleModelPolicySettings(settings: ModelPolicySettingsPersistence, phase: string): Promise<void>`, and `restoreModelPolicySettings(settings: ModelPolicySettingsPersistence, snapshot: ModelPolicySettingsSnapshot): Promise<void>`.

- [ ] **Step 1: Write the failing module test**

Create `src/server/sessions/modelPolicySettingsPersistence.test.ts`. The storage double records durable JSON and fails a fixed number of upcoming writes, so no assertion depends on flag timing.

```ts
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  captureModelPolicySettings,
  modelPolicySettingsPersistence,
  restoreModelPolicySettings,
  settleModelPolicySettings,
} from "./modelPolicySettingsPersistence.js";

const PRIOR = {
  defaultProvider: "old",
  defaultModel: "old-model",
  defaultThinkingLevel: "low",
};

function createSettings(initial: Record<string, unknown>) {
  const state = { durable: JSON.stringify(initial), failures: 0, writes: 0 };
  // fromStorage() reads through withLock while constructing, so failures start
  // at zero and the test arms them afterwards.
  const manager = SettingsManager.fromStorage({
    withLock(scope, fn) {
      if (scope !== "global") return;
      state.writes += 1;
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error("simulated settings write failure");
      }
      const next = fn(state.durable);
      if (next !== undefined) state.durable = next;
    },
  });
  return {
    settings: modelPolicySettingsPersistence(manager),
    durable: () => JSON.parse(state.durable) as Record<string, unknown>,
    failNextWrites: (count: number) => { state.failures = count; },
    writes: () => state.writes,
  };
}

describe("modelPolicySettingsPersistence", () => {
  it("rejects a settings manager without the persistence error channel", () => {
    expect(() =>
      modelPolicySettingsPersistence({
        getGlobalSettings: () => ({}),
        setDefaultProvider: () => undefined,
        setDefaultModel: () => undefined,
        setDefaultThinkingLevel: () => undefined,
        flush: () => Promise.resolve(),
      })
    ).toThrow(/settings persistence/iu);
  });

  it("captures only well-formed prior defaults", () => {
    const harness = createSettings({ ...PRIOR, defaultThinkingLevel: "bogus" });

    expect(captureModelPolicySettings(harness.settings)).toEqual({
      defaultProvider: "old",
      defaultModel: "old-model",
    });
  });

  it("reports a queued write failure that flush alone hides", async () => {
    const harness = createSettings(PRIOR);
    harness.failNextWrites(1);
    harness.settings.setDefaultProvider("new");

    await expect(
      settleModelPolicySettings(harness.settings, "while applying initial model defaults")
    ).rejects.toThrow(/not durably persisted while applying initial model defaults/u);
    expect(harness.durable()).toMatchObject({ defaultProvider: "old" });
  });

  it("settles cleanly when every queued write persisted", async () => {
    const harness = createSettings(PRIOR);
    harness.settings.setDefaultProvider("new");

    await expect(
      settleModelPolicySettings(harness.settings, "before initialization")
    ).resolves.toBeUndefined();
    expect(harness.durable()).toMatchObject({ defaultProvider: "new" });
  });

  it("restores durable defaults after a failed first attempt", async () => {
    const harness = createSettings(PRIOR);
    const snapshot = captureModelPolicySettings(harness.settings);
    harness.settings.setDefaultProvider("new");
    harness.settings.setDefaultModel("new-model");
    harness.settings.setDefaultThinkingLevel("high");
    await settleModelPolicySettings(harness.settings, "target");
    harness.failNextWrites(3);

    await expect(
      restoreModelPolicySettings(harness.settings, snapshot)
    ).resolves.toBeUndefined();
    expect(harness.durable()).toMatchObject(PRIOR);
  });

  it("restores an absent prior thinking default as absent", async () => {
    const harness = createSettings({ defaultProvider: "old", defaultModel: "old-model" });
    const snapshot = captureModelPolicySettings(harness.settings);
    harness.settings.setDefaultThinkingLevel("high");
    await settleModelPolicySettings(harness.settings, "target");

    await restoreModelPolicySettings(harness.settings, snapshot);

    expect(harness.durable()).not.toHaveProperty("defaultThinkingLevel");
  });

  it("aggregates every settings error after three failed restore attempts", async () => {
    const harness = createSettings(PRIOR);
    const snapshot = captureModelPolicySettings(harness.settings);
    harness.settings.setDefaultProvider("new");
    await settleModelPolicySettings(harness.settings, "target");
    const writesBefore = harness.writes();
    harness.failNextWrites(Number.MAX_SAFE_INTEGER);

    const failure = await restoreModelPolicySettings(harness.settings, snapshot)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toMatch(/not durably restored/u);
    expect((failure as AggregateError).errors).toHaveLength(9);
    expect(harness.writes() - writesBefore).toBe(9);
    expect(harness.durable()).toMatchObject({ defaultProvider: "new" });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/sessions/modelPolicySettingsPersistence.test.ts`

Expected: FAIL, `Cannot find module './modelPolicySettingsPersistence.js'`.

- [ ] **Step 3: Implement the module**

Create `src/server/sessions/modelPolicySettingsPersistence.ts`:

```ts
import { isKnownThinkingLevel } from "../../shared/thinkingLevels.js";
import type { ClientThinkingLevel } from "../types.js";

/** Complete restore attempts before an incomplete rollback is reported. */
export const MAX_MODEL_POLICY_SETTINGS_RESTORE_ATTEMPTS = 3;

export interface ModelPolicySettingsSnapshot {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ClientThinkingLevel;
}

/**
 * Narrow view of Pi's `SettingsManager`. `drainErrors()` is required: Pi catches
 * queued write failures and resolves `flush()` anyway, so the error channel is
 * the only proof that a default write reached storage. Members use method syntax
 * so Pi's narrower setter parameters stay assignable.
 */
export interface ModelPolicySettingsPersistence {
  getGlobalSettings(): {
    defaultProvider?: unknown;
    defaultModel?: unknown;
    defaultThinkingLevel?: unknown;
  };
  setDefaultProvider(provider: string | undefined): void;
  setDefaultModel(modelId: string | undefined): void;
  setDefaultThinkingLevel(level: ClientThinkingLevel | undefined): void;
  flush(): Promise<void>;
  drainErrors(): readonly { scope: string; error: Error }[];
}

export function modelPolicySettingsPersistence(
  candidate: unknown
): ModelPolicySettingsPersistence {
  if (!isModelPolicySettingsPersistence(candidate)) {
    throw new Error(
      "Cannot initialize a complete session policy without checked model-default settings persistence support"
    );
  }
  return candidate;
}

export function captureModelPolicySettings(
  settings: ModelPolicySettingsPersistence
): ModelPolicySettingsSnapshot {
  const global = settings.getGlobalSettings();
  const defaultProvider = optionalString(global.defaultProvider);
  const defaultModel = optionalString(global.defaultModel);
  const defaultThinkingLevel = optionalThinkingLevel(global.defaultThinkingLevel);
  return {
    ...(defaultProvider === undefined ? {} : { defaultProvider }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
  };
}

/** Settle queued writes and fail when Pi recorded a persistence error. */
export async function settleModelPolicySettings(
  settings: ModelPolicySettingsPersistence,
  phase: string
): Promise<void> {
  const failures = await settleAttempt(settings);
  if (failures.length === 0) return;
  throw new AggregateError(
    failures,
    `Pi model defaults were not durably persisted ${phase}: ${describe(failures)}`
  );
}

/**
 * Reapply the whole snapshot until storage confirms it. Every attempt rewrites
 * all three fields, so a partially durable attempt still converges to one
 * consistent prior tuple.
 */
export async function restoreModelPolicySettings(
  settings: ModelPolicySettingsPersistence,
  snapshot: ModelPolicySettingsSnapshot
): Promise<void> {
  const failures: Error[] = [];
  for (
    let attempt = 1;
    attempt <= MAX_MODEL_POLICY_SETTINGS_RESTORE_ATTEMPTS;
    attempt += 1
  ) {
    settings.setDefaultProvider(snapshot.defaultProvider);
    settings.setDefaultModel(snapshot.defaultModel);
    settings.setDefaultThinkingLevel(snapshot.defaultThinkingLevel);
    const attemptFailures = await settleAttempt(settings);
    if (attemptFailures.length === 0) return;
    failures.push(...attemptFailures);
  }
  throw new AggregateError(
    failures,
    `Pi model defaults were not durably restored: ${describe(failures)}`
  );
}

async function settleAttempt(
  settings: ModelPolicySettingsPersistence
): Promise<Error[]> {
  const failures: Error[] = [];
  try {
    await settings.flush();
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }
  for (const recorded of settings.drainErrors()) {
    failures.push(
      new Error(`${recorded.scope} settings: ${recorded.error.message}`)
    );
  }
  return failures;
}

function describe(failures: readonly Error[]): string {
  return failures.map((failure) => failure.message).join("; ");
}

function isModelPolicySettingsPersistence(
  value: unknown
): value is ModelPolicySettingsPersistence {
  if (typeof value !== "object" || value === null) return false;
  const candidate: Record<string, unknown> = value as Record<string, unknown>;
  return (
    typeof candidate["getGlobalSettings"] === "function" &&
    typeof candidate["setDefaultProvider"] === "function" &&
    typeof candidate["setDefaultModel"] === "function" &&
    typeof candidate["setDefaultThinkingLevel"] === "function" &&
    typeof candidate["flush"] === "function" &&
    typeof candidate["drainErrors"] === "function"
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalThinkingLevel(value: unknown): ClientThinkingLevel | undefined {
  return typeof value === "string" && isKnownThinkingLevel(value) ? value : undefined;
}
```

- [ ] **Step 4: Consume the module from the session service**

In `src/server/sessions/piSessionService.ts`, delete the local `modelPolicySettingsAdapter`, `isModelPolicySettingsAdapter`, `captureModelPolicySettings`, `restoreModelPolicySettings`, `optionalString`, and `optionalThinkingLevel` functions, and delete the local `ModelPolicySettingsSnapshot` and `ModelPolicySettingsAdapter` interfaces. Import the replacements:

```ts
import {
  captureModelPolicySettings,
  modelPolicySettingsPersistence,
  restoreModelPolicySettings,
  settleModelPolicySettings,
  type ModelPolicySettingsSnapshot,
} from "./modelPolicySettingsPersistence.js";
```

Keep `CompleteModelPolicyInitialization` shaped as `{ previousSelection: ExactModelSelection; previousSettings: ModelPolicySettingsSnapshot }`.

In `initializeCompleteSessionModelPolicy`, resolve the checked persistence once and settle prior writes before the runtime tuple changes:

```ts
    const settings = modelPolicySettingsPersistence(session.settingsManager);
    await settleModelPolicySettings(
      settings,
      "before complete session initialization"
    );
    this.assertModelPolicyMutationIdle(
      session,
      "initialize the session model policy"
    );
    const initialization: CompleteModelPolicyInitialization = {
      previousSelection: this.exactSelectionFromSession(session),
      previousSettings: captureModelPolicySettings(settings),
    };
```

Replace the trailing `await modelPolicySettingsAdapter(session).flush();` with:

```ts
      await settleModelPolicySettings(
        settings,
        "after complete session initialization"
      );
```

In `rollbackCompleteSessionInitialization`, route durable restoration through the bounded helper. Keep it after `restoreExactSelection` so the runtime setters' own queued default writes are included in the first settle:

```ts
    try {
      await restoreModelPolicySettings(
        modelPolicySettingsPersistence(session.settingsManager),
        initialization.previousSettings
      );
    } catch (error: unknown) {
      failures.push(normalizeError(error));
    }
```

- [ ] **Step 5: Run focused tests and static checks**

Run: `npm test -- --run src/server/sessions/modelPolicySettingsPersistence.test.ts src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/piSessionService.lifecycle.test.ts src/server/sessions/piSessionService.warnings.test.ts`

Run: `npm run typecheck`

Run: `npx knip`

Expected: PASS; the module owns Pi settings semantics, existing lifecycle behavior is unchanged, and no export is unused.

- [ ] **Step 6: Commit**

```bash
git add src/server/sessions/modelPolicySettingsPersistence.ts src/server/sessions/modelPolicySettingsPersistence.test.ts src/server/sessions/piSessionService.ts
git commit -m "refactor(model-policy): check Pi settings persistence errors"
```

## Task 2: Prove target defaults before committing records

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/piSessionService.ts:5495-5560`
- Modify: `src/server/sessions/piSessionService.modelPolicy.test.ts:42-70`
- Modify: `src/server/sessions/piSessionService.modelPolicy.test.ts:140-200`
- Modify: `src/server/sessions/piSessionService.modelPolicy.test.ts:390-420`
- Modify: `src/server/sessions/piSessionService.modelPolicy.test.ts:860-915`

**Interfaces:**

- Consumes: `settleModelPolicySettings(settings: ModelPolicySettingsPersistence, phase: string): Promise<void>`, `restoreModelPolicySettings(settings: ModelPolicySettingsPersistence, snapshot: ModelPolicySettingsSnapshot): Promise<void>`, `captureModelPolicySettings(settings: ModelPolicySettingsPersistence): ModelPolicySettingsSnapshot`, and `modelPolicySettingsPersistence(candidate: unknown): ModelPolicySettingsPersistence` from Task 1's `./modelPolicySettingsPersistence.js`.
- Consumes: the existing harness factory `createModelPolicyHarness(options: ModelPolicyHarnessOptions)` in `piSessionService.modelPolicy.test.ts`, which already returns `calls`, `operations`, `fake`, `hub`, `service`, `settingsManager`, `settingsFlush`, and `durableTranscriptPresent()`, and already supports `failCreationSourceAppend`, `failDurableCommit`, `silentlyDropModelPolicyAppend`, and `emitInitializerEvents`. Its `setModel` mock calls `settingsManager.setDefaultModelAndProvider(...)`, so runtime restoration also enqueues a settings write.
- Consumes: the existing test constants `DEFAULT_SELECTION` (`openai/gpt-default` at `medium`) and `ADVANCED_SELECTION` (`openai/gpt-advanced` at `high`) already declared in that file; both models are in `DEFAULT_SCOPED_MODELS` with `reasoning: true`, so `high` is supported.
- Produces: harness options `settingsWriteFailure?: "target" | "restore"` and `restoreWriteFailures?: number`, plus harness accessors `durableSettings(): Record<string, unknown>` and `settingsWrites(): number`, backed by `SettingsManager.fromStorage()`.
- Produces: no new production export; the change is initialization ordering inside `PiSessionService`.

- [ ] **Step 1: Write the failing lifecycle tests**

In `piSessionService.modelPolicy.test.ts`, add to `ModelPolicyHarnessOptions`:

```ts
  settingsWriteFailure?: "target" | "restore";
  /** Fail only the first N settings writes after rollback begins. */
  restoreWriteFailures?: number;
```

These tests initialize with the existing `ADVANCED_SELECTION` constant rather than `DEFAULT_SELECTION`, so applying the target actually changes the Pi defaults away from the captured snapshot. Do not add a new selection constant.

Declare the settings state near the top of the harness body, **above** `appendCustomEntry`, because that mock flips the phase. Construction reads must succeed, so the phase starts at `"construct"`:

```ts
  const settingsState = {
    durable: JSON.stringify({
      defaultProvider: DEFAULT_SELECTION.model.provider,
      defaultModel: DEFAULT_SELECTION.model.id,
      defaultThinkingLevel: "medium",
    }),
    phase: "construct" as "construct" | "target" | "restore",
    writes: 0,
    restoreWrites: 0,
  };
```

Replace the `SettingsManager.inMemory({...})` construction with real storage, then open the target phase. Keep the existing `vi.spyOn(settingsManager, "flush")` line that follows:

```ts
  const settingsManager = SettingsManager.fromStorage({
    withLock(scope, fn) {
      if (scope !== "global") return;
      settingsState.writes += 1;
      if (settingsState.phase === "restore") settingsState.restoreWrites += 1;
      const failing =
        (settingsState.phase === "target" && options.settingsWriteFailure === "target") ||
        (settingsState.phase === "restore" &&
          (options.settingsWriteFailure === "restore" ||
            settingsState.restoreWrites <= (options.restoreWriteFailures ?? 0)));
      if (failing) throw new Error("simulated settings write failure");
      const next = fn(settingsState.durable);
      if (next !== undefined) settingsState.durable = next;
    },
  });
  settingsState.phase = "target";
```

Rollback restores the runtime tuple before durable settings, so the phase must flip when the failing step throws, not during cleanup. In the `appendCustomEntry` mock's creation-source failure branch:

```ts
    if (customType === SESSION_CREATION_SOURCE_CUSTOM_TYPE && options.failCreationSourceAppend === true) {
      settingsState.phase = "restore";
      throw new Error("creation source persistence failed");
    }
```

Add the accessors to the harness return object:

```ts
    durableSettings: () => JSON.parse(settingsState.durable) as Record<string, unknown>,
    settingsWrites: () => settingsState.writes,
```

Add these cases to the `describe` block holding the plus-root initialization tests:

```ts
  it("rejects a plus root when target default writes are not durable", async () => {
    const preferenceStore = { replace: vi.fn(() => Promise.resolve()) };
    const harness = createModelPolicyHarness({
      existing: false,
      preferenceStore,
      settingsWriteFailure: "target",
    });

    await expect(
      harness.service.start(TEST_CWD, {
        creationSource: "session-list-plus",
        initialModelPolicy: { mode: "exact", exact: ADVANCED_SELECTION },
      })
    ).rejects.toThrow(/not durably persisted while applying initial model defaults/u);

    expect(harness.calls).not.toContain(`appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`);
    expect(harness.durableTranscriptPresent()).toBe(false);
    expect(harness.service.activeCount()).toBe(0);
    expect(preferenceStore.replace).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it("recovers durable Pi defaults when restoration storage fails transiently", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      failCreationSourceAppend: true,
      restoreWriteFailures: 5,
    });

    await expect(
      harness.service.start(TEST_CWD, {
        creationSource: "session-list-plus",
        initialModelPolicy: { mode: "exact", exact: ADVANCED_SELECTION },
      })
    ).rejects.toThrow("creation source persistence failed");

    expect(harness.durableSettings()).toMatchObject({
      defaultProvider: DEFAULT_SELECTION.model.provider,
      defaultModel: DEFAULT_SELECTION.model.id,
      defaultThinkingLevel: "medium",
    });
    expect(harness.fake.session.model).toMatchObject(DEFAULT_SELECTION.model);
    expect(harness.durableTranscriptPresent()).toBe(false);
    expect(harness.service.activeCount()).toBe(0);
  });

  it("reports an incomplete rollback when restoration never persists", async () => {
    const preferenceStore = { replace: vi.fn(() => Promise.resolve()) };
    const harness = createModelPolicyHarness({
      existing: false,
      failCreationSourceAppend: true,
      preferenceStore,
      settingsWriteFailure: "restore",
    });

    const failure = await harness.service
      .start(TEST_CWD, {
        creationSource: "session-list-plus",
        initialModelPolicy: { mode: "exact", exact: ADVANCED_SELECTION },
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toMatch(/rollback was incomplete/u);
    expect(
      (failure as AggregateError).errors.some((error: Error) => /not durably restored/u.test(error.message))
    ).toBe(true);
    expect(harness.durableSettings()).toMatchObject({
      defaultModel: ADVANCED_SELECTION.model.id,
    });
    expect(harness.durableTranscriptPresent()).toBe(false);
    expect(harness.service.activeCount()).toBe(0);
    expect(preferenceStore.replace).not.toHaveBeenCalled();
    expect(harness.hub.sessionEvents.some(({ event }) => event.type === "status.update")).toBe(false);
  });
```

The transient case fails the first 5 rollback writes, which covers the runtime restore write plus a full three-field attempt regardless of whether the thinking level also changed. Later attempts rewrite all three fields, so durable state converges to the prior tuple within the 3-attempt bound.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts`

Expected: FAIL. The target case still appends policy records because nothing checks target persistence before them, and the two restore cases report rollback as successful.

- [ ] **Step 3: Reorder complete initialization**

In `initializeCompleteSessionModelPolicy`, settle the target default writes inside the serialized mutation, immediately after the runtime tuple is verified and before any transcript record is appended:

```ts
      await this.runSessionModelPolicyMutation(
        session,
        "initialize the session model policy",
        async () => {
          await this.applyExactSelection(session, target);
          // Pi queues global default writes behind its setters and swallows their
          // storage failures, so prove durability before any transcript record
          // exists: everything after this point must be reversible.
          await settleModelPolicySettings(
            settings,
            "while applying initial model defaults"
          );
          this.appendSessionModelPolicy(session, plan.policy);
          this.verifyPersistedSessionModelPolicy(session, plan.policy);
          this.appendSessionCreationSource(session, source);
          await this.commitAndVerifyInitialSessionEntries(session, plan.policy);
        }
      );
```

Remove the `"after complete session initialization"` settle that Task 1 left after the mutation. `applyExactSelection` is the only step that writes Pi defaults, and the settle above now proves those writes.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/modelPolicySettingsPersistence.test.ts src/server/sessions/piSessionService.lifecycle.test.ts src/server/sessions/rememberCurrentModelPolicy.test.ts src/server/sessions/piSessionManagerGateway.test.ts`

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm run verify`

Expected: PASS. A failed plus root either restores durable Pi defaults or reports an explicit incomplete rollback, and leaves no transcript, active session, or published event.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.modelPolicy.test.ts
git commit -m "fix(model-policy): prove initial Pi defaults before commit"
```
