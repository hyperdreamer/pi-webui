# Lightweight fallback for SESSIONS `+` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the complete-policy SESSIONS `+` path cannot resolve its remembered model policy, substitute the machine's configured `utilityModels.lightweight` tuple as the session's exact policy, remember it, and surface the substitution with a contingent pre-start warning plus a post-start notice.

**Architecture:** The session daemon splits `initializeCompleteSessionModelPolicy` into a resolve phase that either returns the requested plan or a lightweight substitution built by a new pure helper, with two new typed resolution errors bounding the fallback catch. A new `inspect` method on the utility resolver reports why no lightweight candidate exists. The client gains one pure start-decision module, a capability-gated projection that softens the pre-start block into an untruncated warning, a discriminated confirmed-event union carrying the creation's requested policy into a write context that drives draft adoption, and status-derived substitution detection that publishes a `policy-fallback` notice.

**Tech Stack:** TypeScript (ES2022), Node, Vitest, Lit, Pi coding-agent SDK, repository-specific session model-policy plumbing.

## Global Constraints

- Capability key `sessions.modelPolicyLightweightFallback` with the value string `"sessions.modelPolicyLightweightFallback"`; advertised by both `web` and `sessiond`, effective only when both advertise it, and gating the client only — the daemon substitutes unconditionally on the complete-policy plus path.
- Canonical model tiers, ascending: `economy`, `fast`, `standard`, `advanced`, `capable`, `frontier`. A Tiered fallback preserves the remembered canonical tier; the substituted policy is always `mode: "exact"`.
- Only recognized typed resolution failures are fallback-eligible; refresh failures, persistence, verification, programming errors, and every failure after the resolve phase propagate untouched. At most one substitution per creation, and a candidate that fails session-scoped re-validation is final with no second candidate.
- The contingent pre-start warning clause is exactly `The session may start with the Lightweight utility model.`; the post-start notice text is exactly `Session started with the Lightweight utility model (${provider}/${id}) because the remembered model was unavailable.`
- The confirmed-write failure warning is exactly `Could not remember this model policy for future sessions.`; the legacy non-selection warning stays exactly `Could not remember this model policy; this session will still use it.`
- Every lightweight fallback error message contains both `utilityModels.lightweight` and `Settings → Utility models`.
- The resolver's automatic `minimal`-then-`off` rule applies only when a utility slot's `thinkingLevel` is unset; an explicitly configured level unsupported by the model yields no candidate, and the session service never clamps or substitutes a level.
- `README.md` is not edited. Configuration behavior lives in `docs/config.md`, mirrored in `docs/config.html`; troubleshooting lives in `docs/faq.html`; Markdown and HTML claims must stay identical.
- The release record is one minor Changeset at `.changeset/plus-lightweight-fallback.md`; do not edit `CHANGELOG.md`, do not bump versions, and do not run `npm publish` locally.
- Run commands from the repository root. Per-change checks are `npm test -- --run <test-file>`, `npm run typecheck`, `npm run lint`, and `npx knip`; cross-cutting completion is `npm run verify:fast`.
- Every new exported symbol must be consumed by production code in this change; no no-op references and no blanket Knip ignores.

## Task 1: Typed tier resolution errors

**Lane:** server-resolution

**Implementer tier:** Fast

**Files:**

- Modify: `src/server/sessions/modelTierRegistry.ts:1-16` (add the exported error class above `ResolvedTier`)
- Modify: `src/server/sessions/modelTierRegistry.ts:72-96` (`createModelTierRegistry().resolve` throws)
- Modify: `src/server/sessions/modelTierRegistry.ts:127-156` (`resolveTier` throws)
- Test: `src/server/sessions/modelTierRegistry.test.ts:1-2` (import) and `:152-188` (new describe block)

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: `TierResolutionError`, an exported `Error` subclass with `name === "TierResolutionError"`, thrown by every `resolveTier` failure and by `createModelTierRegistry(...).resolve` for configuration and defensive failures. Messages are unchanged. `validateLadder` continues to catch and report `{ valid: false, reason }` instead of throwing.

- [ ] **Step 1: Write the failing test**

Extend the import at the top of `src/server/sessions/modelTierRegistry.test.ts` to:

```ts
import { describe, expect, it, vi } from "vitest";
import { MODEL_TIERS, TierResolutionError, createModelTierRegistry, resolveTier, validateLadder, type ModelTierLadder, type ModelTierRegistryConfig, type TierResolutionDeps } from "./modelTierRegistry.js";
```

Append this block at the end of the file:

```ts
describe("TierResolutionError", () => {
  it("is thrown for every resolveTier failure", () => {
    expect(() => resolveTier("turbo", ladder(), deps)).toThrow(TierResolutionError);

    const incomplete: Partial<ModelTierLadder> = { ...ladder() };
    delete incomplete.capable;
    expect(() => resolveTier("capable", incomplete, deps)).toThrow(TierResolutionError);

    expect(() => resolveTier(
      "capable",
      ladder({ capable: { model: { provider: "acme", id: "ghost" }, thinkingLevel: "high" } }),
      deps,
    )).toThrow(TierResolutionError);

    expect(() => resolveTier(
      "advanced",
      ladder({ advanced: { model: { provider: "acme", id: "large" }, thinkingLevel: "turbo" } }),
      deps,
    )).toThrow(TierResolutionError);

    expect(() => resolveTier(
      "fast",
      ladder({ fast: { model: { provider: "acme", id: "small" }, thinkingLevel: "high" } }),
      deps,
    )).toThrow(TierResolutionError);
  });

  it("is thrown for configuration failures", () => {
    const invalid = createModelTierRegistry<AvailableModel>({
      loadConfig: () => ({ modelTiersError: "bad ladder" }),
      models: availableModels,
      supportedThinkingLevels,
    });
    expect(() => invalid.resolve("economy")).toThrow(TierResolutionError);
    expect(() => invalid.resolve("economy")).toThrow("model tier configuration is invalid: bad ladder");

    const missing = createModelTierRegistry<AvailableModel>({
      loadConfig: () => ({}),
      models: availableModels,
      supportedThinkingLevels,
    });
    expect(() => missing.resolve("economy")).toThrow(TierResolutionError);
    expect(() => missing.resolve("economy")).toThrow("model tier configuration is missing");
  });

  it("is thrown for the defensive re-lookup after resolveTier", () => {
    const models = availableModels();
    const registry = createModelTierRegistry<AvailableModel>({
      loadConfig: () => ({ modelTiers: ladder() }),
      models: () => models,
      supportedThinkingLevels: (model) => {
        // Simulate the runtime catalog dropping the resolved model between
        // resolveTier's ladder lookup and the registry's defensive re-lookup.
        models.splice(0, models.length, ...availableModels().filter((candidate) => candidate.id !== "large"));
        return supportedThinkingLevels(model);
      },
    });

    expect(() => registry.resolve("advanced")).toThrow(TierResolutionError);
    expect(() => registry.resolve("advanced")).toThrow("tier advanced names unavailable model acme/large");
  });

  it("keeps validateLadder reporting instead of throwing for a broken ladder", () => {
    const incomplete: Partial<ModelTierLadder> = { ...ladder() };
    delete incomplete.capable;

    expect(() => validateLadder(incomplete, deps)).not.toThrow();
    expect(validateLadder(incomplete, deps).valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/sessions/modelTierRegistry.test.ts`
Expected: FAIL, `TierResolutionError is not a constructor` or an import error.

- [ ] **Step 3: Write the minimal implementation**

Add this class near the top of `src/server/sessions/modelTierRegistry.ts`, above `ResolvedTier`:

```ts
/**
 * A recognized tier-resolution failure. Everything else thrown while planning a
 * policy is an infrastructure or programming error and must never trigger the
 * lightweight fallback.
 */
export class TierResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierResolutionError";
  }
}
```

Replace the eight `throw new Error(...)` statements in `createModelTierRegistry().resolve` and `resolveTier` with `throw new TierResolutionError(...)`, keeping every message byte-identical:

```ts
throw new TierResolutionError(`model tier configuration is invalid: ${config.modelTiersError}`);
throw new TierResolutionError("model tier configuration is missing");
throw new TierResolutionError(`tier ${tier} names unavailable model ${resolved.model.provider}/${resolved.model.id}`);
throw new TierResolutionError(`unknown tier: ${tier}`);
throw new TierResolutionError(`tier ${tier} has no ladder entry`);
throw new TierResolutionError(`tier ${tier} names unavailable model ${describeModel(entry.model)}`);
throw new TierResolutionError(`tier ${tier} names unknown thinking level ${entry.thinkingLevel}`);
throw new TierResolutionError(
  `tier ${tier} names thinking level ${entry.thinkingLevel}, unsupported by ${describeModel(entry.model)}`,
);
```

`validateLadder` is unchanged; it already catches `Error` and returns `{ valid: false, reason: error.message }`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/sessions/modelTierRegistry.test.ts`
Expected: PASS, all `describe("TierResolutionError")` cases plus the existing 13 cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/modelTierRegistry.ts src/server/sessions/modelTierRegistry.test.ts
git commit -m "feat(sessions): add typed tier resolution errors"
```

## Task 2: Typed session policy resolution errors

**Lane:** server-resolution

**Implementer tier:** Fast

**Files:**

- Modify: `src/server/sessions/sessionModelPolicy.ts:1-12` (add the exported error class)
- Modify: `src/server/sessions/piSessionService.ts:6085-6102` (`resolveAvailableExactSelection` throws)
- Test: `src/server/sessions/piSessionService.modelPolicy.test.ts:1-45` (import), `:1540-1548` and `:1884-1892` (instance assertions), and a new test appended after `:1548`

**Interfaces:**

- Consumes: nothing; independent of Task 1.
- Produces: `SessionModelPolicyResolutionError`, an exported `Error` subclass with `name === "SessionModelPolicyResolutionError"`, thrown by `PiSessionService.resolveAvailableExactSelection` for its three validation arms: `Model not found: ${provider}/${id}`, `Unknown thinking level ${level} for ${provider}/${id}`, and `Thinking level ${level} is unsupported by ${provider}/${id}`. The leading `await session.modelRuntime.refresh({ allowNetwork: false })` stays outside the typed arms and propagates untouched.

- [ ] **Step 1: Write the failing test**

Add the import to `src/server/sessions/piSessionService.modelPolicy.test.ts` beside the existing `./sessionModelPolicy.js` import:

```ts
import {
  inspectSessionModelPolicy,
  SessionModelPolicyResolutionError,
  SESSION_MODEL_POLICY_CUSTOM_TYPE,
} from "./sessionModelPolicy.js";
```

Change the rejection assertions in the two existing `setModelPolicy` unsupported-level tests so the promise is captured and asserted twice. In `"rejects a tier whose thinking level the incoming model does not support before any setter runs"` (around line 1540) replace:

```ts
    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow(/unsupported by openai\/gpt-advanced/iu);
```

with:

```ts
    const rejection = harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" });
    await expect(rejection).rejects.toThrow(/unsupported by openai\/gpt-advanced/iu);
    await expect(rejection).rejects.toBeInstanceOf(SessionModelPolicyResolutionError);
```

Apply the same replacement in the second unsupported-level test (around line 1884), keeping that test's own surrounding assertions.

Append this new test after the first unsupported-level test:

```ts
  it("rejects an unavailable exact policy with a typed resolution error", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()] });
    await harness.service.status(ref());
    harness.calls.length = 0;

    const rejection = harness.service.setModelPolicy(ref(), {
      mode: "exact",
      exact: {
        model: { provider: "retired", id: "unavailable" },
        thinkingLevel: "medium",
      },
    });

    await expect(rejection).rejects.toThrow(/Model not found: retired\/unavailable/u);
    await expect(rejection).rejects.toBeInstanceOf(SessionModelPolicyResolutionError);
    expect(harness.calls).toEqual([]);
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts -t "typed resolution error"`
Expected: FAIL, `SessionModelPolicyResolutionError` is not exported / the rejection is not an instance.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/server/sessions/sessionModelPolicy.ts`, after the imports and before `SessionModelPolicyInspection`:

```ts
/**
 * A recognized session-scoped policy resolution failure: the exact target is
 * structurally valid but cannot be bound to the current runtime catalog. Only
 * these arm the lightweight fallback; a runtime refresh failure does not.
 */
export class SessionModelPolicyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionModelPolicyResolutionError";
  }
}
```

In `src/server/sessions/piSessionService.ts`, replace the three validation throws inside `resolveAvailableExactSelection` with the typed error, keeping messages identical:

```ts
    if (model === undefined) throw new SessionModelPolicyResolutionError(`Model not found: ${described}`);
    if (!isKnownThinkingLevel(selection.thinkingLevel)) {
      throw new SessionModelPolicyResolutionError(
        `Unknown thinking level ${selection.thinkingLevel} for ${described}`
      );
    }
    if (!runtimeThinkingLevels(model).includes(selection.thinkingLevel)) {
      throw new SessionModelPolicyResolutionError(
        `Thinking level ${selection.thinkingLevel} is unsupported by ${described}`
      );
    }
```

Add `SessionModelPolicyResolutionError` to the existing `./sessionModelPolicy.js` import block in `piSessionService.ts`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts`
Expected: PASS, with the two instance assertions and the new test.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/sessionModelPolicy.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.modelPolicy.test.ts
git commit -m "feat(sessions): add typed session policy resolution errors"
```

## Task 3: Utility resolver inspection diagnostics

**Lane:** server-resolution

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/utilityModelResolver.ts:18-50` (types and interface), `:52-115` (implementation)
- Test: `src/server/sessions/utilityModelResolver.test.ts:1-14` (import) and a new describe block
- Modify: `src/server/sessions/utilityModelResolver.test.ts:208-215`, `:260-268` (the two fallback-runner literals)
- Modify: `src/server/sessions/utilityModelExtension.test.ts:463-472` (`resolverFor`)
- Modify: `src/server/sessions/piSessionService.promptQueue.test.ts:110-118`, `:143-150`, `:175-182`, `:210-218`, `:238-245`, `:261-268`, `:300-308`, `:325-340`, `:355-395`
- Modify: `src/server/sessions/piSessionService.rateLimits.test.ts:65-72`, `:143-152`
- Modify: `src/server/speechInput/speechInputPolishingService.test.ts:235-242`, `:270-282`
- Modify: `src/server/speechInput/speechInputPolishingService.rateLimits.test.ts:38-41`

**Interfaces:**

- Consumes: nothing; independent of Tasks 1, 2, 4, 5.
- Produces: `UtilityModelUnavailableReason = "slot-unset" | "config-invalid" | "model-unavailable" | "thinking-level-unsupported" | "resolution-failed"`; `UtilityModelUnavailable = { reason: UtilityModelUnavailableReason; detail?: string }`; `UtilityModelInspection<TModel> = { candidates: readonly ResolvedUtilityModel<TModel>[]; unavailable?: UtilityModelUnavailable }`; `UtilityModelResolver<TModel>.inspect(task): Promise<UtilityModelInspection<TModel>>` (required) with `configuredCandidates(task)` still returning `inspect(task).candidates`.

- [ ] **Step 1: Write the failing test**

Add an `inspect` describe block to `src/server/sessions/utilityModelResolver.test.ts` inside the existing `describe("utility model resolver", ...)`:

```ts
  it("reports candidates identically to configuredCandidates", async () => {
    const { resolver } = createHarness({
      utilityModels: { lightweight: { provider: "acme", id: "small" } },
    });

    await expect((await resolver.inspect("lightweight")).candidates)
      .toEqual(await resolver.configuredCandidates("lightweight"));
  });

  it("reports an unset slot", async () => {
    const empty = createHarness({});
    const emptyModels = createHarness({ utilityModels: {} });

    await expect(empty.resolver.inspect("lightweight")).resolves.toEqual({
      candidates: [],
      unavailable: { reason: "slot-unset" },
    });
    await expect(emptyModels.resolver.inspect("lightweight")).resolves.toEqual({
      candidates: [],
      unavailable: { reason: "slot-unset" },
    });
  });

  it("reports an invalid utility configuration with its detail", async () => {
    const { resolver } = createHarness({
      utilityModelsError: "utilityModels.lightweight.id is required",
    });

    await expect(resolver.inspect("lightweight")).resolves.toEqual({
      candidates: [],
      unavailable: {
        reason: "config-invalid",
        detail: "utilityModels.lightweight.id is required",
      },
    });
  });

  it("reports a configured model missing from the catalog", async () => {
    const { resolver } = createHarness({
      utilityModels: { lightweight: { provider: "acme", id: "retired" } },
    });

    await expect(resolver.inspect("lightweight")).resolves.toEqual({
      candidates: [],
      unavailable: { reason: "model-unavailable", detail: "acme/retired" },
    });
  });

  it("reports an explicitly configured level the model does not support", async () => {
    const { resolver } = createHarness(
      {
        utilityModels: {
          lightweight: { provider: "acme", id: "small", thinkingLevel: "max" },
        },
      },
      { thinkingLevelsForModel: () => ["off", "minimal"] },
    );

    await expect(resolver.inspect("lightweight")).resolves.toEqual({
      candidates: [],
      unavailable: { reason: "thinking-level-unsupported", detail: "max" },
    });
  });

  it("reports a resolution failure and logs it without throwing", async () => {
    const error = new Error("catalog unavailable");
    const logger = { info: vi.fn() };
    const resolver = createUtilityModelResolver({
      loadConfig: () => ({
        utilityModels: { lightweight: { provider: "acme", id: "small" } },
      }),
      modelRuntime: {
        refresh: () => Promise.reject(error),
        getAvailableSnapshot: () => [lightweight],
      },
      thinkingLevelsForModel: () => supportedThinkingLevels,
      logger,
    });

    await expect(resolver.inspect("lightweight")).resolves.toEqual({
      candidates: [],
      unavailable: { reason: "resolution-failed", detail: "catalog unavailable" },
    });
    expect(logger.info).toHaveBeenCalledWith(
      { err: error, task: "lightweight" },
      "utility model resolution failed",
    );
  });

  it("reports a config load failure as resolution-failed", async () => {
    const { resolver } = createHarness(
      {},
      { loadConfigError: new Error("config unavailable") },
    );

    await expect(resolver.inspect("lightweight")).resolves.toEqual({
      candidates: [],
      unavailable: { reason: "resolution-failed", detail: "config unavailable" },
    });
  });

  it("omits unavailable when a candidate resolves", async () => {
    const { resolver } = createHarness({
      utilityModels: { lightweight: { provider: "acme", id: "small" } },
    });

    const inspection = await resolver.inspect("lightweight");
    expect(inspection.candidates).toHaveLength(1);
    expect(Object.hasOwn(inspection, "unavailable")).toBe(false);
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts`
Expected: FAIL, `resolver.inspect is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `src/server/sessions/utilityModelResolver.ts`, add the exported types above the interface and make `inspect` required:

```ts
export type UtilityModelUnavailableReason =
  | "slot-unset"
  | "config-invalid"
  | "model-unavailable"
  | "thinking-level-unsupported"
  | "resolution-failed";

export interface UtilityModelUnavailable {
  reason: UtilityModelUnavailableReason;
  detail?: string;
}

export interface UtilityModelInspection<TModel extends UtilityModelIdentity> {
  candidates: readonly ResolvedUtilityModel<TModel>[];
  unavailable?: UtilityModelUnavailable;
}

export interface UtilityModelResolver<TModel extends UtilityModelIdentity> {
  inspect(task: UtilityModelTask): Promise<UtilityModelInspection<TModel>>;
  configuredCandidates(task: UtilityModelTask): Promise<readonly ResolvedUtilityModel<TModel>[]>;
}
```

Rewrite `createUtilityModelResolver` so the existing body becomes `inspect` and `configuredCandidates` wraps it. The reason order is: caught refresh/loadConfig/snapshot failure; then `config-invalid`; then `slot-unset` for the whole config; then per-slot failures in `taskSlots[task]` order; then the defensive `resolution-failed`. `unavailable` is present iff there are no candidates.

```ts
export function createUtilityModelResolver<
  TModel extends UtilityModelIdentity,
>(
  deps: UtilityModelResolverDependencies<TModel>,
): UtilityModelResolver<TModel> {
  const inspect = async (
    task: UtilityModelTask,
  ): Promise<UtilityModelInspection<TModel>> => {
    try {
      await deps.modelRuntime.refresh({ allowNetwork: false });
      const config = deps.loadConfig();
      if (config.utilityModelsError !== undefined) {
        return {
          candidates: [],
          unavailable: {
            reason: "config-invalid",
            detail: config.utilityModelsError,
          },
        };
      }
      if (config.utilityModels === undefined) {
        return { candidates: [], unavailable: { reason: "slot-unset" } };
      }

      const available = deps.modelRuntime.getAvailableSnapshot();
      const candidates: ResolvedUtilityModel<TModel>[] = [];
      const seen = new Set<string>();
      let slotFailure: UtilityModelUnavailable | undefined;
      for (const slot of taskSlots[task]) {
        const reference = config.utilityModels[slot];
        if (reference === undefined) {
          slotFailure ??= { reason: "slot-unset" };
          continue;
        }
        const candidate = available.find(
          (model) =>
            model.provider === reference.provider && model.id === reference.id,
        );
        if (candidate === undefined) {
          slotFailure ??= {
            reason: "model-unavailable",
            detail: `${reference.provider}/${reference.id}`,
          };
          continue;
        }
        const thinkingLevel = effectiveThinkingLevel(
          reference,
          deps.thinkingLevelsForModel(candidate),
        );
        if (thinkingLevel === undefined) {
          // `effectiveThinkingLevel` only returns undefined for an explicitly
          // configured level the model does not support.
          slotFailure ??= {
            reason: "thinking-level-unsupported",
            detail: reference.thinkingLevel ?? "",
          };
          continue;
        }
        const resolved = { model: candidate, thinkingLevel, slot };
        const key = attemptKey(resolved);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(resolved);
      }
      if (candidates.length > 0) return { candidates };
      return {
        candidates: [],
        unavailable: slotFailure ?? { reason: "resolution-failed" },
      };
    } catch (error) {
      logNoThrow(
        deps.logger,
        { err: error, task },
        "utility model resolution failed",
      );
      return {
        candidates: [],
        unavailable: {
          reason: "resolution-failed",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };

  return {
    inspect,
    configuredCandidates: async (task) => (await inspect(task)).candidates,
  };
}
```

`effectiveThinkingLevel`, `attemptKey`, `runWithUtilityModelFallback`, and `logNoThrow` stay byte-identical.

- [ ] **Step 4: Extend every existing resolver literal to the two-method interface**

These edits are forced by the now-required `inspect` member. Use a delegating helper per file so each fake's `configuredCandidates` behaviour is unchanged.

In `src/server/sessions/utilityModelExtension.test.ts`, replace `resolverFor` with:

```ts
function resolverFor(
  candidates: Partial<
    Record<"lightweight" | "context", readonly ResolvedUtilityModel<Model<Api>>[]>
  >,
) {
  const configuredCandidates = vi.fn((task: "lightweight" | "context") =>
    Promise.resolve(candidates[task] ?? []),
  );
  return {
    inspect: async (task: "lightweight" | "context") => ({
      candidates: await configuredCandidates(task),
    }),
    configuredCandidates,
  };
}
```

In `src/server/sessions/utilityModelResolver.test.ts`, extend both `UtilityModelResolver<FakeModel>` literals (the fallback-runner tests) with `inspect` mirroring their candidates:

```ts
    const resolver: UtilityModelResolver<FakeModel> = {
      inspect: vi.fn(() => Promise.resolve({ candidates: configured })),
      configuredCandidates: vi.fn(() => Promise.resolve(configured)),
    };
```

```ts
    const resolver: UtilityModelResolver<FakeModel> = {
      inspect: vi.fn(() => Promise.resolve({ candidates: [configured] })),
      configuredCandidates: vi.fn(() => Promise.resolve([configured])),
    };
```

In `src/server/sessions/piSessionService.promptQueue.test.ts`, add this helper after `deferred<T>()`:

```ts
function utilityResolverFor(
  candidates: readonly ResolvedUtilityModel<ReturnType<typeof testModel>>[],
) {
  return {
    inspect: vi.fn().mockResolvedValue({ candidates }),
    configuredCandidates: vi.fn().mockResolvedValue(candidates),
  };
}
```

Then replace the resolver literals:
- `utilityModelResolver: { configuredCandidates: vi.fn().mockResolvedValue([utilityCandidate(lightweightModel, "high")]) },` becomes `utilityModelResolver: utilityResolverFor([utilityCandidate(lightweightModel, "high")]),`
- each `utilityModelResolver: { configuredCandidates: vi.fn().mockResolvedValue([]) },` becomes `utilityModelResolver: utilityResolverFor([]),`
- in the relay-handoff test, replace `const configuredCandidates = vi.fn(() => Promise.resolve([utilityCandidate(testModel(), "minimal")]));` with `const resolver = utilityResolverFor([utilityCandidate(testModel(), "minimal")]);`, replace `utilityModelResolver: { configuredCandidates },` with `utilityModelResolver: resolver,`, and replace `expect(configuredCandidates).not.toHaveBeenCalled();` with `expect(resolver.configuredCandidates).not.toHaveBeenCalled();`
- in the runtime-factory test, replace `const configuredCandidates = vi.fn().mockResolvedValue([utilityCandidate(utilityModel, "high")]);` with `const resolver = utilityResolverFor([utilityCandidate(utilityModel, "high")]);`, replace the `{ configuredCandidates }` argument passed to `createDefaultRuntimeFactory` with `resolver,`, and replace both `expect(configuredCandidates)...` assertions with `expect(resolver.configuredCandidates)...`

In `src/server/sessions/piSessionService.rateLimits.test.ts`, add the mirroring `inspect` member to both literals:

```ts
      {
        inspect: vi.fn().mockResolvedValue({ candidates: [] }),
        configuredCandidates: vi.fn().mockResolvedValue([]),
      },
```

```ts
      {
        inspect: vi.fn().mockResolvedValue({
          candidates: [{ model: candidate, thinkingLevel: "high", slot: "lightweight" }],
        }),
        configuredCandidates: vi.fn().mockResolvedValue([
          { model: candidate, thinkingLevel: "high", slot: "lightweight" },
        ]),
      },
```

In `src/server/speechInput/speechInputPolishingService.test.ts`, add `inspect` to the inline literal and the harness:

```ts
    const resolver: UtilityModelResolver<Model<Api>> = {
      inspect: vi.fn(() => Promise.resolve({ candidates: [candidate(firstModel)] })),
      configuredCandidates: vi.fn(() => Promise.resolve([candidate(firstModel)])),
    };
```

```ts
  const configuredCandidates = vi.fn(() => Promise.resolve(candidates));
  const resolver: UtilityModelResolver<Model<Api>> = {
    inspect: vi.fn(() => Promise.resolve({ candidates })),
    configuredCandidates,
  };
```

In `src/server/speechInput/speechInputPolishingService.rateLimits.test.ts`, replace `candidateResolver()` with:

```ts
function candidateResolver() {
  return {
    inspect: vi.fn().mockResolvedValue({
      candidates: [{ model, thinkingLevel: "off", slot: "lightweight" }],
    }),
    configuredCandidates: vi.fn().mockResolvedValue([
      { model, thinkingLevel: "off", slot: "lightweight" },
    ]),
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts src/server/sessions/utilityModelExtension.test.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/piSessionService.rateLimits.test.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingService.rateLimits.test.ts`
Expected: PASS, with the new inspection cases and unchanged existing assertions.

Run: `npm run typecheck`
Expected: PASS, no missing `inspect` member anywhere.

- [ ] **Step 6: Commit**

```bash
git add src/server/sessions/utilityModelResolver.ts src/server/sessions/utilityModelResolver.test.ts src/server/sessions/utilityModelExtension.test.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/piSessionService.rateLimits.test.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingService.rateLimits.test.ts
git commit -m "feat(utility): report why a utility model slot produced no candidate"
```

## Task 4: Pure substituted-policy and error builders

**Lane:** server-resolution

**Implementer tier:** Fast

**Files:**

- Create: `src/server/sessions/sessionModelPolicyFallback.ts`
- Test: `src/server/sessions/sessionModelPolicyFallback.test.ts` (new)

**Interfaces:**

- Consumes: `SessionModelPolicyPlan` from `./sessionModelPolicy.js` (existing) and `UtilityModelUnavailable` from `./utilityModelResolver.js` (Task 3).
- Produces: `fallbackSessionModelPolicy(requested: SessionModelPolicy, candidate: { provider: string; id: string; thinkingLevel: string }): SessionModelPolicyPlan` and `initialPolicyUnavailableError(requested: SessionModelPolicy, cause: unknown, unavailable: UtilityModelUnavailable | undefined): Error` (retains `Error.cause`).

- [ ] **Step 1: Write the failing test**

Create `src/server/sessions/sessionModelPolicyFallback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SessionModelPolicy } from "../../shared/apiTypes.js";
import {
  fallbackSessionModelPolicy,
  initialPolicyUnavailableError,
} from "./sessionModelPolicyFallback.js";
import type { UtilityModelUnavailable } from "./utilityModelResolver.js";

const REQUESTED_TIERED: SessionModelPolicy = {
  mode: "tiered",
  exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
  tier: "advanced",
};
const REQUESTED_EXACT: SessionModelPolicy = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
};
const CANDIDATE = { provider: "acme", id: "small", thinkingLevel: "minimal" };

const CLAUSE_CASES: readonly (readonly [UtilityModelUnavailable | undefined, string])[] = [
  [undefined, "the lightweight model is not available to this session"],
  [{ reason: "slot-unset" }, "no lightweight model is configured"],
  [{ reason: "config-invalid" }, "the utility model configuration is invalid"],
  [{ reason: "model-unavailable" }, "its configured model is unavailable"],
  [{ reason: "thinking-level-unsupported" }, "its configured thinking level is unsupported"],
  [{ reason: "resolution-failed" }, "the lightweight model could not be resolved"],
];

describe("fallbackSessionModelPolicy", () => {
  it("builds an exact lightweight plan and preserves a canonical tier", () => {
    const plan = fallbackSessionModelPolicy(REQUESTED_TIERED, CANDIDATE);

    expect(plan).toEqual({
      policy: {
        mode: "exact",
        exact: { model: { provider: "acme", id: "small" }, thinkingLevel: "minimal" },
        tier: "advanced",
      },
      target: { model: { provider: "acme", id: "small" }, thinkingLevel: "minimal" },
    });
    expect(plan.policy.exact).not.toBe(plan.target);
    expect(plan.policy.exact.model).not.toBe(plan.target.model);
  });

  it("omits the tier when the requested policy had none", () => {
    const plan = fallbackSessionModelPolicy(REQUESTED_EXACT, CANDIDATE);

    expect("tier" in plan.policy).toBe(false);
    expect(plan.policy).toEqual({
      mode: "exact",
      exact: { model: { provider: "acme", id: "small" }, thinkingLevel: "minimal" },
    });
  });

  it("does not mutate the requested policy", () => {
    fallbackSessionModelPolicy(REQUESTED_TIERED, CANDIDATE);

    expect(REQUESTED_TIERED).toEqual({
      mode: "tiered",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
      tier: "advanced",
    });
  });
});

describe("initialPolicyUnavailableError", () => {
  it("names the original cause, the lightweight clause, and the configuration location", () => {
    const cause = new Error("tier advanced names unavailable model openai/gpt-retired");

    for (const [unavailable, clause] of CLAUSE_CASES) {
      const error = initialPolicyUnavailableError(REQUESTED_TIERED, cause, unavailable);
      expect(error.message).toContain(cause.message);
      expect(error.message).toContain(clause);
      expect(error.message).toContain("utilityModels.lightweight");
      expect(error.message).toContain("Settings → Utility models");
    }
  });

  it("appends a non-empty detail and omits an empty one", () => {
    const cause = new Error("boom");

    for (const reason of [
      "config-invalid",
      "model-unavailable",
      "thinking-level-unsupported",
      "resolution-failed",
    ] as const) {
      expect(initialPolicyUnavailableError(REQUESTED_TIERED, cause, { reason, detail: "why" }).message)
        .toContain("(why)");
    }
    expect(initialPolicyUnavailableError(REQUESTED_TIERED, cause, { reason: "config-invalid", detail: "" }).message)
      .not.toContain("()");
    expect(initialPolicyUnavailableError(REQUESTED_TIERED, cause, { reason: "slot-unset" }).message)
      .not.toContain("()");
  });

  it("retains the cause and stringifies a non-Error cause", () => {
    const cause = new Error("boom");
    expect(initialPolicyUnavailableError(REQUESTED_TIERED, cause, undefined).cause).toBe(cause);
    expect(initialPolicyUnavailableError(REQUESTED_TIERED, "literal failure", undefined).message)
      .toContain("literal failure");
  });

  it("describes a tiered or exact requested policy", () => {
    const cause = new Error("boom");
    expect(initialPolicyUnavailableError(REQUESTED_TIERED, cause, undefined).message).toContain("(tier advanced)");
    expect(initialPolicyUnavailableError(REQUESTED_EXACT, cause, undefined).message)
      .toContain("(openai/gpt-default at thinking level medium)");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/sessions/sessionModelPolicyFallback.test.ts`
Expected: FAIL, `Cannot find module './sessionModelPolicyFallback.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/server/sessions/sessionModelPolicyFallback.ts`:

```ts
import type {
  ExactModelSelection,
  SessionModelPolicy,
} from "../../shared/apiTypes.js";
import type { SessionModelPolicyPlan } from "./sessionModelPolicy.js";
import type { UtilityModelUnavailable } from "./utilityModelResolver.js";

/**
 * Build the substituted exact policy and its defensive re-validation target
 * from the resolved lightweight candidate. Pure: neither argument is mutated,
 * and the target is a separate clone so it never aliases `policy.exact`.
 */
export function fallbackSessionModelPolicy(
  requested: SessionModelPolicy,
  candidate: { provider: string; id: string; thinkingLevel: string },
): SessionModelPolicyPlan {
  const exact: ExactModelSelection = {
    model: { provider: candidate.provider, id: candidate.id },
    thinkingLevel: candidate.thinkingLevel,
  };
  return {
    policy: {
      mode: "exact",
      exact,
      ...(requested.tier === undefined ? {} : { tier: requested.tier }),
    },
    target: { model: { ...exact.model }, thinkingLevel: exact.thinkingLevel },
  };
}

/**
 * The single explicit failure when the lightweight slot cannot start the
 * session. It names the requested policy, the original recognized failure, the
 * precise lightweight reason, and where the slot is configured.
 */
export function initialPolicyUnavailableError(
  requested: SessionModelPolicy,
  cause: unknown,
  unavailable: UtilityModelUnavailable | undefined,
): Error {
  const original = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Could not start the session with the remembered model policy (${describeRequestedPolicy(requested)}): ${original} The lightweight utility model fallback is unavailable because ${unavailableClause(unavailable)}. Configure utilityModels.lightweight in Settings → Utility models.`,
    { cause },
  );
}

function describeRequestedPolicy(requested: SessionModelPolicy): string {
  if (requested.mode === "exact") {
    return `${requested.exact.model.provider}/${requested.exact.model.id} at thinking level ${requested.exact.thinkingLevel}`;
  }
  return requested.tier === undefined ? "Tiered mode" : `tier ${requested.tier}`;
}

function unavailableClause(unavailable: UtilityModelUnavailable | undefined): string {
  if (unavailable === undefined) return "the lightweight model is not available to this session";
  const clause = UNAVAILABLE_CLAUSES[unavailable.reason];
  const detail = unavailable.detail;
  return detail === undefined || detail === "" ? clause : `${clause} (${detail})`;
}

const UNAVAILABLE_CLAUSES: Record<UtilityModelUnavailable["reason"], string> = {
  "slot-unset": "no lightweight model is configured",
  "config-invalid": "the utility model configuration is invalid",
  "model-unavailable": "its configured model is unavailable",
  "thinking-level-unsupported": "its configured thinking level is unsupported",
  "resolution-failed": "the lightweight model could not be resolved",
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/sessions/sessionModelPolicyFallback.test.ts`
Expected: PASS, all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/sessionModelPolicyFallback.ts src/server/sessions/sessionModelPolicyFallback.test.ts
git commit -m "feat(sessions): add pure lightweight fallback builders"
```

## Task 5: Server resolve split and fallback orchestration

**Lane:** server-resolution

**Implementer tier:** Capable

**Files:**

- Modify: `src/server/sessions/piSessionService.ts:165-176` (tier import), `:186-193` (policy import), `:194-200` (helper import), a new method immediately before `:5673`, and `initializeCompleteSessionModelPolicy` `:5673-5737`
- Test: `src/server/sessions/piSessionService.modelPolicy.test.ts:1-45` (imports), `:53-99` (harness options), `:291-306` (refresh proxy), `:358-366` (tier stub), `:415-453` (service deps), `:455-482` (harness return), `:823-868` (recast), and new cases appended after `:868`

**Interfaces:**

- Consumes: `TierResolutionError` (Task 1), `SessionModelPolicyResolutionError` (Task 2), `UtilityModelResolver.inspect` and `UtilityModelUnavailable` (Task 3), `fallbackSessionModelPolicy` and `initialPolicyUnavailableError` (Task 4).
- Produces: private `resolveInitialSessionModelPolicy(session: PiAgentSession, requested: SessionModelPolicy): Promise<{ plan: SessionModelPolicyPlan; resolved: { model: AgentModel; selection: ExactModelSelection }; fallback?: { requestedPolicy: SessionModelPolicy; reason: string } }>`. `initializeCompleteSessionModelPolicy` consumes it, logs one info record on substitution with fields `{ sessionId, cwd, requestedPolicy, fallbackPolicy, reason }` and message `session model policy fell back to the lightweight utility model`, then applies the returned bound `resolved` through the unchanged post-resolution sequence.

- [ ] **Step 1: Extend the test harness and write the failing tests**

In `src/server/sessions/piSessionService.modelPolicy.test.ts`, extend the imports:

```ts
import type {
  ExactModelSelection,
  ModelTier,
  SessionModelPolicy,
  StarterModelPolicyPreference,
} from "../../shared/apiTypes.js";
import {
  PiSessionService,
  type PiAgentSession,
  type PiSessionLogger,
  type PiSessionRuntime,
  type PiSessionServiceDependencies,
} from "./piSessionService.js";
import {
  runtimeThinkingLevels,
  TierResolutionError,
  type LadderValidation,
} from "./modelTierRegistry.js";
import type {
  ResolvedUtilityModel,
  UtilityModelUnavailable,
} from "./utilityModelResolver.js";
```

Add the new fixtures beside `ADVANCED_SELECTION`:

```ts
const LIGHTWEIGHT_SELECTION: ExactModelSelection = {
  model: { provider: "openai", id: "gpt-basic" },
  thinkingLevel: "off",
};
const LIGHTWEIGHT_CANDIDATE = {
  model: runtimeModel("openai", "gpt-basic", false),
  thinkingLevel: "off" as const,
};

const LIGHTWEIGHT_REASON_CASES: [string, UtilityModelUnavailable | undefined, string][] = [
  ["undefined", undefined, "the lightweight model is not available to this session"],
  ["slot-unset", { reason: "slot-unset" }, "no lightweight model is configured"],
  ["config-invalid", { reason: "config-invalid", detail: "bad ladder" }, "the utility model configuration is invalid"],
  ["model-unavailable", { reason: "model-unavailable", detail: "acme/retired" }, "its configured model is unavailable"],
  ["thinking-level-unsupported", { reason: "thinking-level-unsupported", detail: "max" }, "its configured thinking level is unsupported"],
  ["resolution-failed", { reason: "resolution-failed", detail: "catalog offline" }, "the lightweight model could not be resolved"],
];

type ResolverFake = NonNullable<PiSessionServiceDependencies["utilityModelResolver"]> & {
  inspect: ReturnType<typeof vi.fn>;
  configuredCandidates: ReturnType<typeof vi.fn>;
};

function fallbackResolver(input: {
  candidates?: readonly {
    model: NonNullable<PiAgentSession["model"]>;
    thinkingLevel: ThinkingLevel;
  }[];
  unavailable?: UtilityModelUnavailable;
}): ResolverFake {
  const candidates = (input.candidates ?? []).map((candidate) => ({
    model: candidate.model,
    thinkingLevel: candidate.thinkingLevel,
    slot: "lightweight" as const,
  }));
  return {
    inspect: vi.fn().mockResolvedValue({
      candidates,
      ...(input.unavailable === undefined ? {} : { unavailable: input.unavailable }),
    }),
    configuredCandidates: vi.fn().mockResolvedValue(candidates),
  };
}
```

Add the harness options and wire them into `createModelPolicyHarness`:

```ts
  /** Injected utility resolver; defaults to an empty-candidate fake. */
  utilityModelResolver?: NonNullable<PiSessionServiceDependencies["utilityModelResolver"]>;
  /** Throw a plain Error from the tier stub instead of a TierResolutionError. */
  plainTierError?: boolean;
  /** Reject the next intercepted `refresh`, consulting the callback each time. */
  failModelRuntimeRefresh?: () => Error | undefined;
  logger?: PiSessionLogger;
```

Replace the refresh proxy with:

```ts
  const refreshHook = options.onModelRuntimeRefresh;
  const failRefresh = options.failModelRuntimeRefresh;
  // Delegating wrapper: only `refresh` is intercepted, every other ModelRuntime
  // read still goes to the real runtime (bound to it, so pi's own internals keep
  // working).
  const modelRuntime = (refreshHook === undefined && failRefresh === undefined)
    ? testModelRuntime
    : new Proxy(testModelRuntime, {
        get(target, property, receiver): unknown {
          if (property !== "refresh") return Reflect.get(target, property, receiver);
          return async (...args: Parameters<typeof testModelRuntime.refresh>) => {
            const failure = failRefresh?.();
            if (failure !== undefined) throw failure;
            const result = await testModelRuntime.refresh(...args);
            refreshHook?.();
            return result;
          };
        },
      });
```

Replace the tier registry stub with:

```ts
  const resolve = vi.fn((tier: ModelTier) => {
    const model = scopedModels.find(({ model: candidate }) => candidate.provider === tierTarget.model.provider
      && candidate.id === tierTarget.model.id)?.model;
    if (model === undefined) {
      if (options.plainTierError === true) {
        throw new Error(`tier ${tier} names unavailable model`);
      }
      throw new TierResolutionError(`tier ${tier} names unavailable model`);
    }
    return { tier, model, thinkingLevel: tierTarget.thinkingLevel };
  });
```

Add the resolver fake and logger before the service is constructed, pass them into the deps, and return them:

```ts
  const defaultUtilityModelResolver: NonNullable<PiSessionServiceDependencies["utilityModelResolver"]> = {
    inspect: async () => ({ candidates: [], unavailable: { reason: "slot-unset" } }),
    configuredCandidates: async () => [],
  };
  const utilityModelResolver = options.utilityModelResolver ?? defaultUtilityModelResolver;
  const logger: PiSessionLogger = options.logger ?? { info: vi.fn() };
```

```ts
    modelRuntime: testModelRuntime,
    utilityModelResolver,
    logger,
```

Insert those two lines beside `modelRuntime: testModelRuntime,` in the existing `new PiSessionService(hub, { ... })` call; every other dependency stays unchanged. Add `logger` and `utilityModelResolver` to the harness's returned object.

Recast the two existing plus-rejection tests. Replace `it("cleans up an unseen plus root when its active Exact selection is unavailable", ...)` with:

```ts
  it("starts a plus root on the lightweight utility model when the active Exact selection is unavailable", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      utilityModelResolver: fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] }),
    });
    const requestedPolicy: SessionModelPolicy = {
      mode: "exact",
      exact: {
        model: { provider: "retired", id: "unavailable" },
        thinkingLevel: "medium",
      },
      tier: "standard",
    };

    await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: requestedPolicy,
    });

    expect(harness.appendCustomEntry).toHaveBeenCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: LIGHTWEIGHT_SELECTION,
      tier: "standard",
    });
    expect(harness.calls).toContain("setModel:openai/gpt-basic");
    expect(harness.calls).toContain("setThinkingLevel:off");
    expect(harness.calls).toContain(`appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`);
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(true);
    expect(harness.service.activeCount()).toBe(1);
    expect(harness.fake.calls.abort).toBe(0);
    expect(harness.fake.calls.dispose).toBe(0);
    expect(harness.logger.info).toHaveBeenCalledWith(
      {
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        requestedPolicy,
        fallbackPolicy: { mode: "exact", exact: LIGHTWEIGHT_SELECTION, tier: "standard" },
        reason: "Model not found: retired/unavailable",
      },
      "session model policy fell back to the lightweight utility model",
    );
  });
```

Replace `it("cleans up an unseen plus root when its active Tiered selection cannot resolve", ...)` with:

```ts
  it("starts a plus root on the lightweight utility model when its active Tiered selection cannot resolve", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      tierTarget: {
        model: { provider: "retired", id: "unavailable-tier-target" },
        thinkingLevel: "high",
      },
      utilityModelResolver: fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] }),
    });
    const requestedPolicy: SessionModelPolicy = {
      mode: "tiered",
      exact: DEFAULT_SELECTION,
      tier: "advanced",
    };

    await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: requestedPolicy,
    });

    expect(harness.resolve).toHaveBeenCalledOnce();
    expect(harness.appendCustomEntry).toHaveBeenCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: LIGHTWEIGHT_SELECTION,
      tier: "advanced",
    });
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "tier advanced names unavailable model" }),
      "session model policy fell back to the lightweight utility model",
    );
  });
```

Immediately after the Tiered recast, add the moved rejection tests:

```ts
  it("cleans up an unseen plus root when no lightweight candidate resolves for an Exact request", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      utilityModelResolver: fallbackResolver({
        candidates: [],
        unavailable: { reason: "model-unavailable", detail: "retired/unavailable" },
      }),
    });

    const rejection = harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: {
          model: { provider: "retired", id: "unavailable" },
          thinkingLevel: "medium",
        },
        tier: "standard",
      },
    });

    await expect(rejection).rejects.toThrow(/Model not found: retired\/unavailable/u);
    await expect(rejection).rejects.toThrow(/its configured model is unavailable \(retired\/unavailable\)/u);
    await expect(rejection).rejects.toThrow(/utilityModels\.lightweight/u);
    await expect(rejection).rejects.toThrow(/Settings → Utility models/u);

    expect(harness.calls).toEqual([]);
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it("cleans up an unseen plus root when no lightweight candidate resolves for a Tiered request", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      tierTarget: {
        model: { provider: "retired", id: "unavailable-tier-target" },
        thinkingLevel: "high",
      },
      utilityModelResolver: fallbackResolver({
        candidates: [],
        unavailable: { reason: "slot-unset" },
      }),
    });

    const rejection = harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "tiered",
        exact: DEFAULT_SELECTION,
        tier: "advanced",
      },
    });

    await expect(rejection).rejects.toThrow(/tier advanced names unavailable model/u);
    await expect(rejection).rejects.toThrow(/no lightweight model is configured/u);
    await expect(rejection).rejects.toThrow(/utilityModels\.lightweight/u);
    await expect(rejection).rejects.toThrow(/Settings → Utility models/u);

    expect(harness.resolve).toHaveBeenCalledOnce();
    expect(harness.calls).toEqual([]);
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });
```

Then append the remaining new cases after those two tests:

```ts
  it("falls back when the precise Exact thinking level is unsupported", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      utilityModelResolver: fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] }),
    });

    await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "minimal" },
      },
    });

    expect(harness.appendCustomEntry).toHaveBeenCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: LIGHTWEIGHT_SELECTION,
    });
  });

  it("reports the lightweight slot reason for an unsupported-level request with no candidate", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      utilityModelResolver: fallbackResolver({
        candidates: [],
        unavailable: { reason: "thinking-level-unsupported", detail: "max" },
      }),
    });

    const rejection = harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "minimal" },
      },
    });

    await expect(rejection).rejects.toThrow(/Thinking level minimal is unsupported by openai\/gpt-basic/u);
    await expect(rejection).rejects.toThrow(/its configured thinking level is unsupported \(max\)/u);
  });

  it("omits the tier when a fallback requested policy had none", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      utilityModelResolver: fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] }),
    });

    await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: { model: { provider: "retired", id: "unavailable" }, thinkingLevel: "medium" },
      },
    });

    expect(harness.appendCustomEntry).toHaveBeenCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: LIGHTWEIGHT_SELECTION,
    });
  });

  it("does not fall back when the requested policy resolves", async () => {
    const resolver = fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] });
    const harness = createModelPolicyHarness({ existing: false, utilityModelResolver: resolver });

    await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: { mode: "exact", exact: DEFAULT_SELECTION },
    });

    expect(resolver.inspect).not.toHaveBeenCalled();
    expect(harness.appendCustomEntry).toHaveBeenCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: DEFAULT_SELECTION,
    });
    expect(harness.logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "session model policy fell back to the lightweight utility model",
    );
  });

  it("does not fall back on a plain tier error with a recognized message", async () => {
    const resolver = fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] });
    const harness = createModelPolicyHarness({
      existing: false,
      plainTierError: true,
      tierTarget: {
        model: { provider: "retired", id: "unavailable-tier-target" },
        thinkingLevel: "high",
      },
      utilityModelResolver: resolver,
    });

    const rejection = harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: { mode: "tiered", exact: DEFAULT_SELECTION, tier: "advanced" },
    });

    await expect(rejection).rejects.toThrow("tier advanced names unavailable model");
    expect(resolver.inspect).not.toHaveBeenCalled();
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
  });

  it("does not fall back when the model runtime refresh fails", async () => {
    const refreshError = new Error("catalog refresh failed");
    const resolver = fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] });
    const harness = createModelPolicyHarness({
      existing: false,
      failModelRuntimeRefresh: () => refreshError,
      utilityModelResolver: resolver,
    });

    const rejection = harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: { model: { provider: "retired", id: "unavailable" }, thinkingLevel: "medium" },
      },
    });

    await expect(rejection).rejects.toBe(refreshError);
    expect(resolver.inspect).not.toHaveBeenCalled();
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
  });

  it("propagates a fallback re-validation refresh failure untouched", async () => {
    const refreshError = new Error("fallback refresh failed");
    let inspected = false;
    const resolver = fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] });
    resolver.inspect.mockImplementation(async () => {
      inspected = true;
      return { candidates: [LIGHTWEIGHT_CANDIDATE] };
    });
    const harness = createModelPolicyHarness({
      existing: false,
      failModelRuntimeRefresh: () => (inspected ? refreshError : undefined),
      utilityModelResolver: resolver,
    });

    const rejection = harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: { model: { provider: "retired", id: "unavailable" }, thinkingLevel: "medium" },
      },
    });

    let caught: unknown;
    await rejection.catch((error: unknown) => { caught = error; });
    expect(caught).toBe(refreshError);
    expect(caught instanceof Error ? caught.message.includes("utilityModels.lightweight") : true).toBe(false);
    expect(caught instanceof Error ? caught.cause : "sentinel").toBeUndefined();
    expect(resolver.inspect).toHaveBeenCalledOnce();
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it("does not attempt a second candidate when the first fails re-validation", async () => {
    const resolver = fallbackResolver({
      candidates: [{ model: runtimeModel("openai", "gpt-retired"), thinkingLevel: "off" }],
    });
    const harness = createModelPolicyHarness({ existing: false, utilityModelResolver: resolver });

    const rejection = harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: { model: { provider: "retired", id: "unavailable" }, thinkingLevel: "medium" },
      },
    });

    await expect(rejection).rejects.toThrow(/Model not found: retired\/unavailable/u);
    await expect(rejection).rejects.toThrow(/the lightweight model is not available to this session/u);
    expect(resolver.inspect).toHaveBeenCalledOnce();
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it.each(LIGHTWEIGHT_REASON_CASES)(
    "fails explicitly with the %s lightweight reason",
    async (_label, unavailable, clause) => {
      const harness = createModelPolicyHarness({
        existing: false,
        utilityModelResolver: fallbackResolver({
          candidates: [],
          ...(unavailable === undefined ? {} : { unavailable }),
        }),
      });

      const rejection = harness.service.start(TEST_CWD, {
        creationSource: "session-list-plus",
        initialModelPolicy: {
          mode: "exact",
          exact: { model: { provider: "retired", id: "unavailable" }, thinkingLevel: "medium" },
        },
      });

      await expect(rejection).rejects.toThrow(/Model not found: retired\/unavailable/u);
      await expect(rejection).rejects.toThrow(clause);
      await expect(rejection).rejects.toThrow(/utilityModels\.lightweight/u);
      await expect(rejection).rejects.toThrow(/Settings → Utility models/u);
      expect(harness.fake.calls.abort).toBe(1);
      expect(harness.fake.calls.dispose).toBe(1);
      expect(harness.commitInitialEntries).not.toHaveBeenCalled();
      expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
    },
  );

  it("remembers the substituted policy", async () => {
    const preferenceStore = { replace: vi.fn(() => Promise.resolve()) };
    const harness = createModelPolicyHarness({
      existing: false,
      tierTarget: {
        model: { provider: "retired", id: "unavailable-tier-target" },
        thinkingLevel: "high",
      },
      utilityModelResolver: fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] }),
      preferenceStore,
    });

    const created = await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: { mode: "tiered", exact: DEFAULT_SELECTION, tier: "advanced" },
    });

    await expect(harness.service.rememberCurrentModelPolicy(sessionRef(created.id, TEST_CWD)))
      .resolves.toEqual({ mode: "exact", exact: LIGHTWEIGHT_SELECTION, tier: "advanced" });
    expect(preferenceStore.replace).toHaveBeenCalledWith(TEST_CWD, {
      kind: "full",
      preference: { mode: "exact", exact: LIGHTWEIGHT_SELECTION, tier: "advanced" },
    });
  });

  it("does not consult the fallback for a runtime-default or legacy start", async () => {
    const runtimeDefault = fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] });
    const runtimeDefaultHarness = createModelPolicyHarness({
      existing: false,
      utilityModelResolver: runtimeDefault,
    });
    await runtimeDefaultHarness.service.start(TEST_CWD);

    expect(runtimeDefault.inspect).not.toHaveBeenCalled();
    expect(runtimeDefaultHarness.appendCustomEntry).toHaveBeenCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: DEFAULT_SELECTION,
    });

    const legacy = fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] });
    const legacyHarness = createModelPolicyHarness({ existing: false, utilityModelResolver: legacy });
    await legacyHarness.service.start(TEST_CWD, {
      modelPolicy: { mode: "tiered", tier: "advanced" },
    });

    expect(legacy.inspect).not.toHaveBeenCalled();
  });

  it("does not consult the fallback for spawn-session or tracked-subsession roots", async () => {
    const resolver = fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] });
    const spawned = createModelPolicyHarness({
      existing: false,
      spawnTargetCwd: "/workspace-feature",
      utilityModelResolver: resolver,
    });
    const tracked = createModelPolicyHarness({
      existing: false,
      spawnTargetCwd: "/workspace-feature",
      utilityModelResolver: resolver,
    });

    await spawned.service.spawnSession({
      spawningCwd: TEST_CWD,
      prompt: "continue",
      cwd: "/workspace-feature",
    });
    await tracked.service.spawnSubsession({
      spawningCwd: TEST_CWD,
      parentSessionId: "parent-session",
      parentSessionFile: undefined,
      prompt: "continue tracked",
      cwd: "/workspace-feature",
    });

    expect(resolver.inspect).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts -t "lightweight"`
Expected: FAIL: fallback starts currently reject with the requested policy error.

- [ ] **Step 3: Write the implementation**

In `src/server/sessions/piSessionService.ts`, add `TierResolutionError` to the `./modelTierRegistry.js` import block and `SessionModelPolicyResolutionError` plus `type SessionModelPolicyPlan` to the `./sessionModelPolicy.js` import block. Add:

```ts
import {
  fallbackSessionModelPolicy,
  initialPolicyUnavailableError,
} from "./sessionModelPolicyFallback.js";
```

Add the resolve method immediately before `initializeCompleteSessionModelPolicy`:

```ts
  /**
   * Resolve the requested complete policy, substituting the machine's
   * configured lightweight utility tuple when — and only when — the active
   * target fails with a recognized typed resolution error. A failure after the
   * resolve phase is never fallback-eligible.
   */
  private async resolveInitialSessionModelPolicy(
    session: PiAgentSession,
    requested: SessionModelPolicy
  ): Promise<{
    plan: SessionModelPolicyPlan;
    resolved: { model: AgentModel; selection: ExactModelSelection };
    fallback?: { requestedPolicy: SessionModelPolicy; reason: string };
  }> {
    // One pre-plan refresh makes tier planning and exact validation read the
    // same snapshot. A refresh failure propagates untouched.
    await session.modelRuntime.refresh({ allowNetwork: false });
    try {
      const requestedPlan = planSessionModelPolicyInitialization(
        requested,
        (tier) => {
          const resolved = this.modelTierRegistry.resolve(tier);
          return {
            model: { provider: resolved.model.provider, id: resolved.model.id },
            thinkingLevel: resolved.thinkingLevel,
          };
        }
      );
      const resolved = await this.resolveAvailableExactSelection(
        session,
        requestedPlan.target
      );
      return { plan: requestedPlan, resolved };
    } catch (error: unknown) {
      if (
        !(error instanceof TierResolutionError) &&
        !(error instanceof SessionModelPolicyResolutionError)
      ) {
        throw error;
      }
      const inspection = await this.utilityModelResolver.inspect("lightweight");
      const candidate = inspection.candidates[0];
      if (candidate === undefined) {
        throw initialPolicyUnavailableError(
          requested,
          error,
          inspection.unavailable
        );
      }
      const fallbackPlan = fallbackSessionModelPolicy(requested, {
        provider: candidate.model.provider,
        id: candidate.model.id,
        thinkingLevel: candidate.thinkingLevel,
      });
      try {
        const fallbackResolved = await this.resolveAvailableExactSelection(
          session,
          fallbackPlan.target
        );
        return {
          plan: fallbackPlan,
          resolved: fallbackResolved,
          fallback: {
            requestedPolicy: requested,
            reason: error instanceof Error ? error.message : String(error),
          },
        };
      } catch (fallbackError: unknown) {
        if (!(fallbackError instanceof SessionModelPolicyResolutionError)) {
          throw fallbackError;
        }
        throw initialPolicyUnavailableError(requested, error, undefined);
      }
    }
  }
```

Rewrite the start of `initializeCompleteSessionModelPolicy` through the settings settle so the resolve phase is delegated and the fallback is logged once:

```ts
  private async initializeCompleteSessionModelPolicy(
    session: PiAgentSession,
    policy: SessionModelPolicy,
    source: SessionCreationSource
  ): Promise<CompleteModelPolicyInitialization> {
    const { plan, resolved, fallback } =
      await this.resolveInitialSessionModelPolicy(session, policy);
    if (fallback !== undefined) {
      this.logger.info(
        {
          sessionId: session.sessionId,
          cwd: session.sessionManager.getCwd(),
          requestedPolicy: fallback.requestedPolicy,
          fallbackPolicy: plan.policy,
          reason: fallback.reason,
        },
        "session model policy fell back to the lightweight utility model"
      );
    }
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
    try {
      await this.runSessionModelPolicyMutation(
        session,
        "initialize the session model policy",
        async () => {
          await this.applyExactSelection(session, resolved);
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
          await this.commitAndVerifyInitialSessionEntries(
            session,
            plan.policy
          );
        }
      );
      this.inspectAndCacheSessionModelPolicy(session);
      return initialization;
    } catch (error: unknown) {
      const rollbackFailures =
        await this.rollbackCompleteSessionInitialization(
          session,
          initialization
        );
      throw completeInitializationFailure(error, rollbackFailures);
    }
  }
```

`resolveAvailableExactSelection` keeps its own leading refresh and typed throws from Task 2.

- [ ] **Step 4: Run the server suite and the repository checks**

Run: `npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts`
Expected: PASS, the two recast fallback tests, both moved rejection tests, and all new cases.

Run: `npm test -- --run src/server/sessions/sessionModelPolicyFallback.test.ts src/server/sessions/modelTierRegistry.test.ts src/server/sessions/utilityModelResolver.test.ts`
Expected: PASS.

Run: `npm run typecheck && npx eslint src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.modelPolicy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.modelPolicy.test.ts
git commit -m "feat(sessions): fall back to the lightweight utility model on the plus path"
```

## Task 6: Lightweight fallback capability

**Lane:** capability

**Implementer tier:** Fast

**Files:**

- Modify: `src/shared/apiTypes.ts:91-116` (append the capability key)
- Modify: `src/shared/capabilities.ts:10-80` (both runtime lists and the effective requirements)
- Test: `src/shared/capabilities.test.ts:290-298` (append a new test)

**Interfaces:**

- Consumes: nothing; independent of every other lane.
- Produces: `PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback = "sessions.modelPolicyLightweightFallback"`, present in `WEB_RUNTIME_CAPABILITIES` and `SESSIOND_RUNTIME_CAPABILITIES` after `sessionsModelPolicyStarterSelection`, and in `EFFECTIVE_CAPABILITY_REQUIREMENTS` as `["web", "sessiond"]`.

- [ ] **Step 1: Write the failing test**

Append to `src/shared/capabilities.test.ts`:

```ts
  it("requires web and session daemon support for the lightweight model policy fallback capability", () => {
    const lightweightFallback = PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback;
    expect(lightweightFallback).toBe("sessions.modelPolicyLightweightFallback");
    expect(WEB_RUNTIME_CAPABILITIES).toContain(lightweightFallback);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(lightweightFallback);
    expect(parseKnownPiWebUiCapabilities([lightweightFallback, "future.capability"]))
      .toEqual([lightweightFallback]);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [lightweightFallback] },
      sessiond: { available: false, capabilities: [] },
    })).not.toContain(lightweightFallback);
    expect(effectivePiWebUiCapabilities({
      web: { available: false, capabilities: [] },
      sessiond: { available: true, capabilities: [lightweightFallback] },
    })).not.toContain(lightweightFallback);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [lightweightFallback] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(lightweightFallback);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [lightweightFallback] },
      sessiond: { available: true, capabilities: [lightweightFallback] },
    })).toContain(lightweightFallback);
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/shared/capabilities.test.ts`
Expected: FAIL, `sessionsModelPolicyLightweightFallback` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/shared/apiTypes.ts`, append the key as the last member of `PI_WEBUI_CAPABILITIES`:

```ts
  sessionsModelPolicyLightweightFallback: "sessions.modelPolicyLightweightFallback",
```

In `src/shared/capabilities.ts`, add `PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback,` after `PI_WEBUI_CAPABILITIES.sessionsModelPolicyStarterSelection,` in both `WEB_RUNTIME_CAPABILITIES` and `SESSIOND_RUNTIME_CAPABILITIES`, and add after the starter-selection entry of `EFFECTIVE_CAPABILITY_REQUIREMENTS`:

```ts
  [PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback]: ["web", "sessiond"],
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/shared/capabilities.test.ts`
Expected: PASS, all capability tests.

Run: `npm run typecheck && npx eslint src/shared/capabilities.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/apiTypes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts
git commit -m "feat(capabilities): advertise the lightweight model policy fallback"
```

## Task 7: Starter policy structural predicate and start decision

**Lane:** client-decision

**Implementer tier:** Standard

**Files:**

- Create: `src/client/src/components/starterPolicyStartDecision.ts`
- Modify: `src/client/src/components/sessionModelPolicyDraft.ts:338-346` (export the two syntax helpers)
- Test: `src/client/src/components/starterPolicyStartDecision.test.ts` (new)

**Interfaces:**

- Consumes: `evaluateStarterModelPolicyDraft`, `isCanonicalTier`, `isSyntacticallyCompleteExactSelection`, `type SessionModelPolicyDraft` from `./sessionModelPolicyDraft`; `ModelTierSettingsResponse`, `StarterModelPolicyPreference` from `../../../shared/apiTypes`.
- Produces: `STARTER_POLICY_FALLBACK_WARNING_CLAUSE = "The session may start with the Lightweight utility model."`; `isStructurallyCompleteStarterPolicy(draft): boolean`; `starterModelPolicyPreference(draft): StarterModelPolicyPreference` (deep clone, throws `Cannot build a complete starter model policy from an incomplete draft`); `StarterStartDecision = { kind: "ready" } | { kind: "fallback"; requested: StarterModelPolicyPreference; warning?: string } | { kind: "blocked"; reason: string }`; `starterStartDecision(input: { draft; catalog; fallbackSupported; catalogUnavailableReason }): StarterStartDecision | undefined`.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/components/starterPolicyStartDecision.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  ModelTier,
  ModelTierLadder,
  ModelTierModelOption,
  ModelTierSettingsResponse,
} from "../../../shared/apiTypes";
import {
  isStructurallyCompleteStarterPolicy,
  starterModelPolicyPreference,
  starterStartDecision,
  STARTER_POLICY_FALLBACK_WARNING_CLAUSE,
} from "./starterPolicyStartDecision";

const defaultModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-default" },
  name: "Default",
  thinkingLevels: ["low", "medium", "high"],
};
const repairModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-repair" },
  name: "Repair",
  thinkingLevels: ["off", "low"],
};

function validCatalog(): ModelTierSettingsResponse {
  const ladder: ModelTierLadder = {
    economy: { model: { ...defaultModelOption.model }, thinkingLevel: "low" },
    fast: { model: { ...defaultModelOption.model }, thinkingLevel: "low" },
    standard: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    advanced: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    capable: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
    frontier: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
  };
  return {
    contractVersion: 1,
    ladder,
    models: [defaultModelOption, repairModelOption],
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

const COMPLETE_EXACT = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
} as const;
const UNAVAILABLE_EXACT = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "retired" }, thinkingLevel: "medium" },
} as const;
const UNSUPPORTED_LEVEL = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "gpt-repair" }, thinkingLevel: "high" },
} as const;
const COMPLETE_TIERED = {
  mode: "tiered",
  exact: COMPLETE_EXACT.exact,
  tier: "standard",
} as const;
const INCOMPLETE_EXACT = {
  mode: "exact",
  exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
} as const;
const INCOMPLETE_TIERED = { mode: "tiered", exact: COMPLETE_EXACT.exact } as const;

const LOADING_REASON = "Loading model policy choices";

describe("isStructurallyCompleteStarterPolicy", () => {
  it("accepts complete exact and tiered drafts", () => {
    expect(isStructurallyCompleteStarterPolicy(COMPLETE_EXACT)).toBe(true);
    expect(isStructurallyCompleteStarterPolicy(COMPLETE_TIERED)).toBe(true);
  });

  it("rejects blank fields and tiered drafts without a canonical tier", () => {
    expect(isStructurallyCompleteStarterPolicy({
      mode: "exact",
      exact: { model: { provider: "", id: "gpt-default" }, thinkingLevel: "medium" },
    })).toBe(false);
    expect(isStructurallyCompleteStarterPolicy({
      mode: "exact",
      exact: { model: { provider: "openai", id: "" }, thinkingLevel: "medium" },
    })).toBe(false);
    expect(isStructurallyCompleteStarterPolicy({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "" },
    })).toBe(false);
    expect(isStructurallyCompleteStarterPolicy(INCOMPLETE_TIERED)).toBe(false);
    expect(isStructurallyCompleteStarterPolicy({ ...COMPLETE_TIERED, tier: "nonsense" as ModelTier })).toBe(false);
  });
});

describe("starterModelPolicyPreference", () => {
  it("returns a complete deep clone", () => {
    const preference = starterModelPolicyPreference(COMPLETE_TIERED);

    expect(preference).toEqual({
      mode: "tiered",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
      tier: "standard",
    });
    preference.exact.model.id = "mutated";
    expect(COMPLETE_TIERED.exact.model.id).toBe("gpt-default");
  });

  it("throws for an incomplete draft", () => {
    expect(() => starterModelPolicyPreference(INCOMPLETE_EXACT)).toThrow(
      "Cannot build a complete starter model policy from an incomplete draft",
    );
  });
});

describe("starterStartDecision", () => {
  const catalog = validCatalog();

  it("returns undefined while the draft is loading", () => {
    expect(starterStartDecision({
      draft: undefined,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toBeUndefined();
  });

  it("blocks an incomplete draft with the caller reason when the catalog is unavailable", () => {
    expect(starterStartDecision({
      draft: INCOMPLETE_EXACT,
      catalog: undefined,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "blocked", reason: LOADING_REASON });
  });

  it("blocks an incomplete draft with the evaluator reason when the catalog is present", () => {
    expect(starterStartDecision({
      draft: INCOMPLETE_EXACT,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({
      kind: "blocked",
      reason: "Choose a provider, model, and thinking level before starting",
    });
    expect(starterStartDecision({
      draft: INCOMPLETE_TIERED,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "blocked", reason: "Selected model tier is unavailable" });
  });

  it("falls back without a warning when the catalog is unavailable and the capability is present", () => {
    const decision = starterStartDecision({
      draft: COMPLETE_EXACT,
      catalog: undefined,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    });

    expect(decision).toEqual({
      kind: "fallback",
      requested: starterModelPolicyPreference(COMPLETE_EXACT),
    });
    expect(decision === undefined ? true : Object.hasOwn(decision, "warning")).toBe(false);
  });

  it("blocks a complete draft when the catalog is unavailable and the capability is absent", () => {
    expect(starterStartDecision({
      draft: COMPLETE_EXACT,
      catalog: undefined,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "blocked", reason: LOADING_REASON });
  });

  it("readies a complete draft the catalog accepts", () => {
    expect(starterStartDecision({
      draft: COMPLETE_EXACT,
      catalog,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "ready" });
    expect(starterStartDecision({
      draft: COMPLETE_TIERED,
      catalog,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "ready" });
  });

  it("falls back with the live reason and the contingent clause when the catalog blocks", () => {
    expect(starterStartDecision({
      draft: UNAVAILABLE_EXACT,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({
      kind: "fallback",
      requested: starterModelPolicyPreference(UNAVAILABLE_EXACT),
      warning: `Selected provider/model is unavailable. ${STARTER_POLICY_FALLBACK_WARNING_CLAUSE}`,
    });

    const unsupported = starterStartDecision({
      draft: UNSUPPORTED_LEVEL,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    });
    expect(unsupported?.kind === "fallback" ? unsupported.warning : undefined).toBe(
      `Selected thinking level is unsupported by the selected model. ${STARTER_POLICY_FALLBACK_WARNING_CLAUSE}`,
    );
  });

  it("blocks with the evaluator reason when the catalog blocks and the capability is absent", () => {
    expect(starterStartDecision({
      draft: UNAVAILABLE_EXACT,
      catalog,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "blocked", reason: "Selected provider/model is unavailable" });
    expect(starterStartDecision({
      draft: UNSUPPORTED_LEVEL,
      catalog,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({
      kind: "blocked",
      reason: "Selected thinking level is unsupported by the selected model",
    });
  });

  it("falls back for an unsupported level when the catalog is unavailable and the capability is present", () => {
    expect(starterStartDecision({
      draft: UNSUPPORTED_LEVEL,
      catalog: undefined,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })?.kind).toBe("fallback");
  });

  it("never falls back for an incomplete draft", () => {
    for (const draft of [INCOMPLETE_EXACT, INCOMPLETE_TIERED]) {
      expect(starterStartDecision({
        draft,
        catalog,
        fallbackSupported: true,
        catalogUnavailableReason: LOADING_REASON,
      })?.kind).toBe("blocked");
      expect(starterStartDecision({
        draft,
        catalog: undefined,
        fallbackSupported: true,
        catalogUnavailableReason: LOADING_REASON,
      })?.kind).toBe("blocked");
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/starterPolicyStartDecision.test.ts`
Expected: FAIL, `Cannot find module './starterPolicyStartDecision'`.

- [ ] **Step 3: Write the minimal implementation**

In `src/client/src/components/sessionModelPolicyDraft.ts`, add `export` to the two syntax helpers (bodies unchanged):

```ts
export function isSyntacticallyCompleteExactSelection(exact: ExactModelSelection): boolean {
```

```ts
export function isCanonicalTier(tier: ModelTier | undefined): tier is ModelTier {
```

Create `src/client/src/components/starterPolicyStartDecision.ts`:

```ts
import type {
  ModelTierSettingsResponse,
  StarterModelPolicyPreference,
} from "../../../shared/apiTypes";
import {
  evaluateStarterModelPolicyDraft,
  isCanonicalTier,
  isSyntacticallyCompleteExactSelection,
  type SessionModelPolicyDraft,
} from "./sessionModelPolicyDraft";

export const STARTER_POLICY_FALLBACK_WARNING_CLAUSE =
  "The session may start with the Lightweight utility model.";

/**
 * The client-side completeness contract the server request parser enforces for
 * the fields a draft can carry: non-blank Exact provider/id/thinking in both
 * modes, plus a canonical tier while Tiered is active.
 */
export function isStructurallyCompleteStarterPolicy(
  draft: SessionModelPolicyDraft,
): boolean {
  return isSyntacticallyCompleteExactSelection(draft.exact)
    && (draft.mode === "exact" || isCanonicalTier(draft.tier));
}

export function starterModelPolicyPreference(
  draft: SessionModelPolicyDraft,
): StarterModelPolicyPreference {
  if (!isStructurallyCompleteStarterPolicy(draft)) {
    throw new Error("Cannot build a complete starter model policy from an incomplete draft");
  }
  return {
    mode: draft.mode,
    exact: {
      model: { ...draft.exact.model },
      thinkingLevel: draft.exact.thinkingLevel,
    },
    ...(draft.tier === undefined ? {} : { tier: draft.tier }),
  };
}

export type StarterStartDecision =
  | { kind: "ready" }
  | { kind: "fallback"; requested: StarterModelPolicyPreference; warning?: string }
  | { kind: "blocked"; reason: string };

export function starterStartDecision(input: {
  draft: SessionModelPolicyDraft | undefined;
  catalog: ModelTierSettingsResponse | undefined;
  fallbackSupported: boolean;
  catalogUnavailableReason: string;
}): StarterStartDecision | undefined {
  const { draft, catalog, fallbackSupported, catalogUnavailableReason } = input;
  if (draft === undefined) return undefined;

  if (!isStructurallyCompleteStarterPolicy(draft)) {
    if (catalog === undefined) {
      return { kind: "blocked", reason: catalogUnavailableReason };
    }
    const evaluation = evaluateStarterModelPolicyDraft(draft, catalog);
    if (evaluation.kind === "blocked") {
      return { kind: "blocked", reason: evaluation.reason };
    }
    // Defensive: the predicate is strictly weaker than the evaluator, so an
    // incomplete draft cannot evaluate ready.
    return {
      kind: "blocked",
      reason: "Choose a provider, model, and thinking level before starting",
    };
  }

  const requested = starterModelPolicyPreference(draft);
  if (catalog === undefined) {
    return fallbackSupported
      ? { kind: "fallback", requested }
      : { kind: "blocked", reason: catalogUnavailableReason };
  }

  const evaluation = evaluateStarterModelPolicyDraft(draft, catalog);
  if (evaluation.kind === "ready") return { kind: "ready" };
  if (!fallbackSupported) return { kind: "blocked", reason: evaluation.reason };
  return {
    kind: "fallback",
    requested,
    warning: `${evaluation.reason}. ${STARTER_POLICY_FALLBACK_WARNING_CLAUSE}`,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/starterPolicyStartDecision.test.ts src/client/src/components/sessionModelPolicyDraft.test.ts`
Expected: PASS, all new cases plus the unchanged draft suite.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/starterPolicyStartDecision.ts src/client/src/components/starterPolicyStartDecision.test.ts src/client/src/components/sessionModelPolicyDraft.ts
git commit -m "feat(starter): decide ready, fallback, or blocked before a plus start"
```

## Task 8: Untruncated warning rendering

**Lane:** client-render

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/SessionModelPolicyControl.ts:14-30` (property), `:39-64` (render), `:172-183` (CSS)
- Modify: `src/client/src/components/PromptEditor.ts:60-70` (property), `:431-439` (binding)
- Test: `src/client/src/components/SessionModelPolicyControl.test.ts:1-60` and appended cases
- Test: `src/client/src/components/PromptEditor.sessionConfiguration.test.ts:95-130` (new case), `:408-418` (accessor type), and appended `shouldUpdate` coverage

**Interfaces:**

- Consumes: nothing; independent of every other lane.
- Produces: `SessionModelPolicyControl.warning: string` (property) rendering an always-present `<span class="policy-warning" role="status">` line and suppressing `.policy-diagnostic` when the warning is non-blank; `PromptEditor.modelPolicyWarning: string` forwarded to `.warning` on `<session-model-policy-control>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/client/src/components/SessionModelPolicyControl.test.ts`:

```ts
  it("renders an untruncated role=status warning instead of the compact diagnostic", async () => {
    const warning = "Selected provider/model is unavailable. The session may start with the Lightweight utility model.";
    const control = await mountControl((component) => {
      component.status = {
        ...exactStatus(),
        blockedReason: "Selected provider/model is unavailable",
      };
      component.warning = warning;
    });

    const warningLine = shadowRoot(control).querySelector<HTMLElement>(".policy-warning");
    if (warningLine === null) throw new Error("Expected the policy warning line");
    expect(warningLine.getAttribute("role")).toBe("status");
    expect(warningLine.textContent).toBe(warning);
    expect(shadowRoot(control).querySelector(".policy-diagnostic")).toBeNull();
  });

  it("suppresses the ladder diagnostic under a warning", async () => {
    const warning = "Selected model tier is unavailable. The session may start with the Lightweight utility model.";
    const control = await mountControl((component) => {
      component.status = { ...tieredStatus(), ladderValid: false };
      component.warning = warning;
    });

    expect(shadowRoot(control).querySelector(".policy-diagnostic")).toBeNull();
    expect(shadowRoot(control).querySelector<HTMLElement>(".policy-warning")?.textContent).toBe(warning);
  });

  it("keeps the compact diagnostic when there is no warning", async () => {
    const control = await mountControl((component) => {
      component.status = {
        ...exactStatus(),
        blockedReason: "Selected provider/model is unavailable",
      };
      component.warning = "";
    });

    expect(shadowRoot(control).querySelector(".policy-diagnostic")?.textContent)
      .toBe("Selected provider/model is unavailable");
    expect(shadowRoot(control).querySelector<HTMLElement>(".policy-warning")?.textContent).toBe("");
  });

  it("keeps the warning style rule untruncated", () => {
    const rule = componentStyleRule(".policy-warning");

    expect(rule.whiteSpace).toBe("normal");
    expect(["", "initial"]).toContain(rule.textOverflow);
    expect(rule.getPropertyValue("overflow")).not.toBe("hidden");
  });
```

In `src/client/src/components/PromptEditor.sessionConfiguration.test.ts`, add `warning: string;` to `RenderedPolicyControl`, then append this test inside the main describe:

```ts
  it("forwards the warning to the policy control", () => {
    const editor = new PromptEditor();
    editor.status = sessionStatus(tieredPolicyStatus);
    editor.modelPolicyWarning = "Policy warning";
    editor.modelPolicyStatus = tieredPolicyStatus;

    const control = renderedPolicyControl(renderCompactStatusElement(editor));
    expect(control.warning).toBe("Policy warning");
    expect(control.status).toBe(tieredPolicyStatus);

    const blank = new PromptEditor();
    blank.status = sessionStatus(tieredPolicyStatus);
    expect(renderedPolicyControl(renderCompactStatusElement(blank)).warning).toBe("");
  });

  it("re-renders for a warning-only property change", () => {
    const editor = new PromptEditor();
    editor.status = sessionStatus(tieredPolicyStatus);

    const changed: PropertyValues<PromptEditor> = new Map();
    changed.set("modelPolicyWarning", "Policy warning");

    expect(changeRequiresRender(editor, changed)).toBe(true);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts`
Expected: FAIL, no `.policy-warning` element and no `warning` property.

- [ ] **Step 3: Write the implementation**

In `SessionModelPolicyControl.ts`, add the property beside `status`:

```ts
  @property() warning = "";
```

In `render()`, replace the diagnostic computation and output:

```ts
    const warningText = this.warning.trim() === "" ? undefined : this.warning;
    const compactDiagnostic = warningText === undefined ? this.compactDiagnostic(policyStatus) : undefined;
```

```ts
      <span class="policy-warning" role="status">${warningText ?? ""}</span>
      ${compactDiagnostic === undefined ? null : html`<span class="policy-diagnostic" title=${compactDiagnostic}>${compactDiagnostic}</span>`}
```

Add beside `.policy-diagnostic` in the static styles:

```css
    .policy-warning { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; color: var(--pi-muted); font-size: 11px; line-height: 1.3; }
```

In `PromptEditor.ts`, add the property beside `modelPolicyError`:

```ts
  @property() modelPolicyWarning = "";
```

Pass it to the control:

```ts
            .warning=${this.modelPolicyWarning}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts`
Expected: PASS, the four new control cases and the two new editor cases.

Run: `npm run typecheck && npx eslint src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/PromptEditor.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/PromptEditor.ts src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
git commit -m "feat(composer): render an untruncated role=status policy warning"
```

## Task 9: `policy-fallback` starter notice kind

**Lane:** client-notice

**Implementer tier:** Fast

**Files:**

- Modify: `src/client/src/components/starterNotice.ts:9-25` (kind), `:41-55` (factory)
- Test: `src/client/src/components/starterNotice.test.ts:1-20` and appended cases

**Interfaces:**

- Consumes: nothing; independent of every other lane.
- Produces: `StarterNoticeKind` includes `"policy-fallback"`; `starterPolicyFallbackNotice(message: string, scope: StarterNoticeScope): StarterNotice` returns `{ kind: "policy-fallback", message, scope }`. `starterNoticeVisibleText` returns the captured message and ignores the live blocked reason; `shouldRetainStarterNotice` retains it in scope.

- [ ] **Step 1: Write the failing test**

Add `starterPolicyFallbackNotice` to the import in `src/client/src/components/starterNotice.test.ts` and append:

```ts
describe("starterPolicyFallbackNotice", () => {
  it("captures the model text under its own kind", () => {
    expect(starterPolicyFallbackNotice("Session started with the Lightweight utility model (openai/gpt-basic).", scope))
      .toEqual({
        kind: "policy-fallback",
        message: "Session started with the Lightweight utility model (openai/gpt-basic).",
        scope,
      });
  });

  it("reads its captured message and ignores a live reason", () => {
    const notice = starterPolicyFallbackNotice("Session started with the lightweight model.", scope);
    expect(starterNoticeVisibleText(notice, scope, "Choose a valid model tier")).toBe("Session started with the lightweight model.");
  });

  it("is retained in scope and dropped out of scope", () => {
    const notice = starterPolicyFallbackNotice("Session started with the lightweight model.", scope);
    expect(shouldRetainStarterNotice(notice, scope, undefined)).toBe(true);
    expect(shouldRetainStarterNotice(notice, otherWorkspace, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/starterNotice.test.ts`
Expected: FAIL, `starterPolicyFallbackNotice` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/client/src/components/starterNotice.ts`:

```ts
export type StarterNoticeKind = "policy-blocked" | "start-failed" | "defaults-failed" | "policy-fallback";
```

```ts
/**
 * A policy fallback describes a past creation event with no live source to
 * re-read: the session already started on the substituted model.
 */
export function starterPolicyFallbackNotice(
  message: string,
  scope: StarterNoticeScope,
): StarterNotice {
  return { kind: "policy-fallback", message, scope };
}
```

No change to `starterNoticeVisibleText` or `shouldRetainStarterNotice`: the new kind is captured text, so it returns `notice.message` and is retained while in scope.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/components/starterNotice.test.ts`
Expected: PASS, all existing and three new cases.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/starterNotice.ts src/client/src/components/starterNotice.test.ts
git commit -m "feat(starter): add the policy-fallback notice kind"
```

## Task 10: Starter projection, warning binding, and capability-gated start

**Lane:** client-app

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:1-30` (import), `:2530-2580` (`startSessionAndOpenChat`), `:2895-2905` (prompt-editor bindings), `:2938-3030` (`starterModelPolicyInputs`, `starterModelPolicyBlocksStart`), `:3083-3105` (`starterModelPolicyFallbackPreference`), `:4136-4185` (`handleStartSessionPrompt`), `:4945-4970` (module capability helper)
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts:150-270` (fixtures), `:2510-2560` (helpers), and appended cases

**Interfaces:**

- Consumes: `starterStartDecision` and `type StarterStartDecision` (Task 7); `PromptEditor.modelPolicyWarning` (Task 8); `PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback` (Task 6).
- Produces: `starterModelPolicyInputs()` returning `{ status, response, decision?, warning? }` where a fallback decision omits `status.blockedReason`; `starterModelPolicyBlocksStart(): boolean`; `starterModelPolicyFallbackPreference(): StarterModelPolicyPreference | undefined`; a private `starterModelPolicyLightweightFallbackSupported(machineId?)`; and both start paths dispatching the complete fallback preference.

- [ ] **Step 1: Write the failing tests**

In `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`, add the fixture after `fullPreferenceCapableStarterState()`:

```ts
function lightweightFallbackStarterState(): AppState {
  return {
    ...starterState(),
    machineRuntimes: {
      local: machineRuntime([
        PI_WEBUI_CAPABILITIES.sessionsModelPolicy,
        PI_WEBUI_CAPABILITIES.sessionsModelPolicyDefaults,
        PI_WEBUI_CAPABILITIES.sessionsModelPolicyStarterSelection,
        PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback,
      ], "local"),
    },
  };
}

const lightweightFallbackUnavailableExact: SessionModelPolicy = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "retired" }, thinkingLevel: "medium" },
};
const lightweightFallbackIncompleteExact: SessionModelPolicy = {
  mode: "exact",
  exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
};
```

Add the helper beside `starterPlusModelPolicyInitializer`:

```ts
function starterModelPolicyBlocksStart(app: PiWebUiApp): boolean {
  const method: unknown = Reflect.get(app, "starterModelPolicyBlocksStart");
  if (typeof method !== "function") throw new Error("PiWebUiApp.starterModelPolicyBlocksStart is not callable");
  const value: unknown = Reflect.apply(method, app, []);
  if (typeof value !== "boolean") throw new Error("PiWebUiApp.starterModelPolicyBlocksStart did not return a boolean");
  return value;
}
```

Append these tests inside `describe("PiWebUiApp starter policy blocking and diagnostics", ...)`:

```ts
  it("shows the contingent warning and keeps Start enabled when the remembered model is unavailable", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    setAppState(app, lightweightFallbackStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    setStarterModelPolicy(app, lightweightFallbackUnavailableExact);
    setModelTierCatalog(app, validCatalog(), "local");

    const editor = promptEditorTemplate(app);
    expect(templateValueAfterMarker(editor, ".modelPolicyWarning="))
      .toBe("Selected provider/model is unavailable. The session may start with the Lightweight utility model.");
    expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(false);
    expect(starterModelPolicyBlocksStart(app)).toBe(false);
  });

  it("renders no warning and starts server-authoritatively when the catalog is unavailable", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2());
    vi.spyOn(modelTiersApi, "settings").mockRejectedValue(new Error("catalog offline"));
    const startPlus = vi.spyOn(sessionController(app), "startPlusSession").mockResolvedValue(false);
    stubComposerFocus(app);
    setAppState(app, lightweightFallbackStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    setStarterModelPolicy(app, completeDefaultPolicy);

    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyWarning=")).toBe("");
    expect(starterModelPolicyBlocksStart(app)).toBe(false);

    await startSessionAndOpenChat(app);

    expect(startPlus).toHaveBeenCalledWith(completeDefaultPolicy);
  });

  it("starts the fallback preference from the prompt path", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2());
    vi.spyOn(modelTiersApi, "settings").mockRejectedValue(new Error("catalog offline"));
    const startPlus = vi.spyOn(sessionController(app), "startPlusSessionWithPrompt").mockResolvedValue(false);
    stubComposerFocus(app);
    setAppState(app, lightweightFallbackStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    setStarterModelPolicy(app, completeDefaultPolicy);

    startSessionPrompt(app, "hello");

    expect(startPlus).toHaveBeenCalledWith(
      "hello",
      undefined,
      undefined,
      "inline",
      completeDefaultPolicy,
      expect.any(Function),
    );
  });

  it("still blocks an incomplete draft with the fallback capability present", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    const startPlus = vi.spyOn(sessionController(app), "startPlusSession").mockResolvedValue(false);
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    const startPlusWithPrompt = vi.spyOn(sessionController(app), "startPlusSessionWithPrompt").mockResolvedValue(false);
    stubComposerFocus(app);
    setAppState(app, lightweightFallbackStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    setStarterModelPolicy(app, lightweightFallbackIncompleteExact);
    setModelTierCatalog(app, validCatalog(), "local");

    expect(starterModelPolicyBlocksStart(app)).toBe(true);

    await startSessionAndOpenChat(app);
    startSessionPrompt(app, "do not start");

    expect(start).not.toHaveBeenCalled();
    expect(startPlus).not.toHaveBeenCalled();
    expect(startWithPrompt).not.toHaveBeenCalled();
    expect(startPlusWithPrompt).not.toHaveBeenCalled();
    expect(templateText(renderApp(app)))
      .toContain("Choose a provider, model, and thinking level before starting");
  });

  it("still blocks when the fallback capability is absent", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaultsV2").mockResolvedValue(starterDefaultsV2());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    setAppState(app, fullPreferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    setStarterModelPolicy(app, lightweightFallbackUnavailableExact);
    setModelTierCatalog(app, validCatalog(), "local");

    expect(starterModelPolicyBlocksStart(app)).toBe(true);
    const status = policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus="));
    expect(status.blockedReason).toBe("Selected provider/model is unavailable");
  });

  it("drops a retained policy-blocked notice in the fallback state", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();

    await startSessionAndOpenChat(app);
    expect(starterNotice(app)?.kind).toBe("policy-blocked");

    // The fallback capability arrives on the selected machine while the
    // remembered tier stays unusable, so the decision becomes fallback and the
    // projected status drops `blockedReason`.
    setAppState(app, lightweightFallbackStarterState());
    runWillUpdate(app);

    expect(starterNotice(app)).toBeUndefined();
    expect(templateText(renderApp(app))).not.toContain("Choose a valid model tier before starting");
  });

  it("still refuses a legacy blocked start without the starter-selection capability", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    stubComposerFocus(app);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    setStarterModelPolicy(app, lightweightFallbackUnavailableExact);
    setModelTierCatalog(app, validCatalog(), "local");

    expect(policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus=")).blockedReason)
      .toBe("Choose a model and thinking level before starting");
    expect(starterModelPolicyBlocksStart(app)).toBe(true);

    await startSessionAndOpenChat(app);
    startSessionPrompt(app, "do not start");

    expect(start).not.toHaveBeenCalled();
    expect(startWithPrompt).not.toHaveBeenCalled();
    expect(templateText(renderApp(app))).toContain("Choose a model and thinking level before starting");
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: FAIL, `starterModelPolicyLightweightFallbackSupported` is not callable and the warning binding is missing.

- [ ] **Step 3: Write the implementation**

Add `starterStartDecision` and its type to `PiWebUiApp.ts`:

```ts
import { starterStartDecision, type StarterStartDecision } from "./starterPolicyStartDecision";
```

Add the unavailable-text helper and rewrite the selection-capable branch of `starterModelPolicyInputs()`:

```ts
  private modelTierCatalogUnavailableReason(): string {
    return this.modelTierCatalogError === ""
      ? "Loading model policy choices"
      : this.modelTierCatalogError;
  }

  private starterModelPolicyInputs():
    | {
        status: ClientSessionModelPolicyStatus;
        response: SessionModelPolicyResponse;
        decision?: StarterStartDecision;
        warning?: string;
      }
    | undefined {
    const defaults = this.starterSessionDefaults;
    const policy = this.starterModelPolicy;
    if (defaults === undefined || policy === undefined || !this.sessionModelPolicySupported()) return undefined;
    const catalog = this.selectedMachineModelTierCatalog();
    if (this.starterModelPolicySelectionSupported()) {
      const decision = starterStartDecision({
        draft: policy,
        catalog,
        fallbackSupported: this.starterModelPolicyLightweightFallbackSupported(),
        catalogUnavailableReason: this.modelTierCatalogUnavailableReason(),
      });
      if (decision === undefined) return undefined;
      const evaluation: StarterModelPolicyEvaluation = catalog === undefined
        ? { kind: "blocked", reason: this.modelTierCatalogUnavailableReason() }
        : evaluateStarterModelPolicyDraft(policy, catalog);
      const status: ClientSessionModelPolicyStatus = {
        mode: policy.mode,
        ...(policy.tier === undefined ? {} : { tier: policy.tier }),
        resolved: evaluation.kind === "ready" ? evaluation.resolved : policy.exact,
        ladderValid: catalog?.valid ?? true,
        ...(decision.kind === "blocked" ? { blockedReason: decision.reason } : {}),
      };
      return {
        status,
        response: {
          contractVersion: 1,
          policy,
          session: {
            sessionId: "starter",
            isStreaming: false,
            isCompacting: false,
            isBashRunning: false,
            pendingMessageCount: 0,
            queuedMessages: [],
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: 0,
            ...(defaults.model === undefined ? {} : { model: defaults.model }),
            thinkingLevel: defaults.thinkingLevel,
            modelPolicy: status,
          },
        },
        decision,
        ...(decision.kind === "fallback" && decision.warning !== undefined
          ? { warning: decision.warning }
          : {}),
      };
    }
    const selectedTier = policy.tier;
```

Everything from `const selectedTier = policy.tier;` through the end of the method stays byte-identical.

Replace `starterModelPolicyBlocksStart()` and add the fallback preference accessor:

```ts
  private starterModelPolicyBlocksStart(): boolean {
    const inputs = this.starterModelPolicyInputs();
    if (inputs === undefined) return false;
    return inputs.decision !== undefined
      ? inputs.decision.kind === "blocked"
      : inputs.status.blockedReason !== undefined;
  }

  private starterModelPolicyFallbackPreference(): StarterModelPolicyPreference | undefined {
    const decision = this.starterModelPolicyInputs()?.decision;
    return decision?.kind === "fallback" ? decision.requested : undefined;
  }
```

Add the capability helper beside `starterModelPolicySelectionSupported`:

```ts
  private starterModelPolicyLightweightFallbackSupported(machineId = selectedMachineId(this.state)): boolean {
    return lightweightModelPolicyFallbackSupportedForState(this.state, machineId);
  }
```

and beside `starterModelPolicySelectionSupportedForState`:

```ts
function lightweightModelPolicyFallbackSupportedForState(
  state: Pick<AppState, "machineRuntimes">,
  machineId: string,
): boolean {
  const runtime = state.machineRuntimes[machineId];
  return runtime?.ok === true
    && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback);
}
```

Update `startSessionAndOpenChat()`:

```ts
    let usePlusStart = this.starterModelPolicySelectionSupported(startMachineId);
    let decision = this.starterModelPolicyInputs()?.decision;
    let plusInitializer = this.starterPlusModelPolicyInitializer();
    if (
      usePlusStart
      && plusInitializer === undefined
      && decision?.kind !== "fallback"
      && (this.starterModelPolicy === undefined || this.selectedMachineModelTierCatalog() === undefined)
    ) {
      await this.loadMissingStarterPlusModelPolicyInputs(
        workspace,
        startMachineId,
        startSelectionGeneration,
      );
      if (!shouldComplete() || this.starterModelPolicySelectionGeneration !== startSelectionGeneration) return;
      usePlusStart = this.starterModelPolicySelectionSupported(startMachineId);
      decision = this.starterModelPolicyInputs()?.decision;
      plusInitializer = this.starterPlusModelPolicyInitializer();
    }
    if (this.starterModelPolicyBlocksStart()) {
      const scope = this.starterNoticeScope();
      if (shouldComplete() && scope !== undefined) this.publishStarterNotice(starterPolicyBlockedNotice(scope));
      return;
    }
    if (usePlusStart && plusInitializer === undefined) {
      plusInitializer = this.starterModelPolicyFallbackPreference();
    }
    if (usePlusStart && plusInitializer === undefined) return;
```

(The remaining body from `this.starterNotice = undefined;` onward is unchanged.)

Update the prompt path in `handleStartSessionPrompt`:

```ts
    if (this.starterModelPolicyBlocksStart()) {
      const scope = this.starterNoticeScope();
      if (scope !== undefined) this.publishStarterNotice(starterPolicyBlockedNotice(scope));
      return;
    }
    this.starterNotice = undefined;
```

Keep the existing capture of `workspaceId`, `startMachineId`, `workTarget`, and `starterModelPolicy` immediately after `this.starterNotice = undefined;`, then add:

```ts
    const decision = this.starterModelPolicyInputs()?.decision;
    const plusInitializer = decision?.kind === "fallback"
      ? decision.requested
      : this.starterPlusModelPolicyInitializer();
    const usePlusStart = this.starterModelPolicySelectionSupported(startMachineId);
    if (usePlusStart && plusInitializer === undefined) return;
```

Add the warning binding to the `<prompt-editor>` start-screen element, after `.modelPolicyError=${this.starterModelPolicyError()}`:

```ts
 .modelPolicyWarning=${policy?.warning ?? ""}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: PASS, the seven new cases plus all existing cases.

Run: `npm run typecheck && npx eslint src/client/src/components/PiWebUiApp.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "feat(starter): gate the plus block on the lightweight fallback capability"
```

## Task 11: Confirmed event union, write context, and guarded adoption

**Lane:** client-app

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/controllers/sessionController.ts:68-92` (event union and deps), `:324-356` (creation publish), `:1240-1268` (save publish)
- Modify: `src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.ts:1-155` (context-aware writer)
- Modify: `src/client/src/components/PiWebUiApp.ts:28` (event type import), `:139` (warning constant), `:465-485` (writer wiring), `:1959-1990` (`handleStarterModelPolicyConfirmed` plus the adoption handler)
- Test: `src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts` (mechanical updates plus three new cases)
- Test: `src/client/src/controllers/sessionController.pendingStarts.test.ts:332-479` (creation arm)
- Test: `src/client/src/controllers/sessionController.modelPolicy.test.ts:199-220` (save arm)
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts:1490-1790` (recasts and adoption cases)

**Interfaces:**

- Consumes: Task 10's committed `PiWebUiApp.ts` state (`starterModelPolicy`, `starterModelPolicySelectionGeneration`, `confirmedStarterModelPolicyUiScope`); `sameStarterModelPolicyDraft` and `modelPolicyDraftFromPolicy` (already in the app).
- Produces: `StarterModelPolicyConfirmedEvent` as a discriminated union on `reason` (`"creation"` with `requestedPolicy`, `"policy-save"` with `policy`); `ConfirmedPreferenceWriteContext`; `ConfirmedStarterModelPolicyPreferenceWriter.write(scope, session, context): Promise<void>` with `onRemembered(scope, preference, context)`; immediate save-path adoption and draft-equality-guarded creation adoption.

- [ ] **Step 1: Write the failing tests**

In `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`, recast the seven direct `confirmStarterPolicy(...)` calls:

- In `"queues one policy-free remember after a confirmed plus creation and retains the policy in memory"`, add `setStarterModelPolicy(app, completeDefaultPolicy);` before the call and replace the call with:

```ts
    confirmStarterPolicy(app, { reason: "creation", machineId: "local", session, requestedPolicy: completeDefaultPolicy });
```

- In `"keeps confirmation successful when remember fails, then clears the warning on a later success"`, seed the draft with `setStarterModelPolicy(app, completeDefaultPolicy);` and replace both calls with the same creation-arm call shown above; replace the assertion text `"Could not remember this model policy; this session still uses it."` with `"Could not remember this model policy for future sessions."`
- In `"does not publish another same-workspace session's write failure"`, seed `setStarterModelPolicy(app, completeDefaultPolicy);`, change the selected-session call to the creation arm with `requestedPolicy: completeDefaultPolicy`, and change the other-session call to:

```ts
    confirmStarterPolicy(app, {
      reason: "creation",
      machineId: "local",
      session: otherSession,
      requestedPolicy: {
        mode: "tiered",
        tier: "advanced",
        exact: { model: { ...advancedModelOption.model }, thinkingLevel: "high" },
      },
    });
```

- In `"does not let another same-workspace session's successful write clear the current diagnostic"`, change both calls to the creation arm with `requestedPolicy: completeDefaultPolicy`.

Append these adoption cases inside `describe("PiWebUiApp confirmed starter policy writeback", ...)`:

```ts
  it("adopts the confirmed preference only when the draft is unchanged", async () => {
    const app = createApp();
    const session = plusCreatedSession();
    const requestedPolicy: StarterModelPolicyPreference = {
      mode: "tiered",
      tier: "advanced",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    };
    const confirmedPreference: StarterModelPolicyPreference = {
      mode: "exact",
      tier: "advanced",
      exact: { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "off" },
    };
    const remember = vi.spyOn(sessionsApi, "rememberCurrentModelPolicy").mockResolvedValue(confirmedPreference);
    setAppState(app, activeState({
      sessions: [session],
      selectedSession: session,
      machineRuntimes: fullPreferenceCapableStarterState().machineRuntimes,
    }));
    setStarterModelPolicy(app, requestedPolicy);

    confirmStarterPolicy(app, { reason: "creation", machineId: "local", session, requestedPolicy });

    await vi.waitFor(() => { expect(starterModelPolicy(app)).toEqual(confirmedPreference); });

    const edited: SessionModelPolicy = {
      mode: "exact",
      tier: "advanced",
      exact: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    };
    setStarterModelPolicy(app, edited);
    confirmStarterPolicy(app, { reason: "creation", machineId: "local", session, requestedPolicy });

    await vi.waitFor(() => { expect(remember).toHaveBeenCalledTimes(2); });
    await flush();
    expect(starterModelPolicy(app)).toEqual(edited);
  });
```

The existing `"remembers a server-confirmed policy mutation only for a plus-created root"` test already exercises `reason: "policy-save"` through the real emitter; keep its immediate-adoption assertion.

In `confirmedStarterModelPolicyPreferenceWriter.test.ts`, add the imports and a `saveContext`, switch every `deferred<unknown>()` to `deferred<StarterModelPolicyPreference>()`, resolve them with `fullStarterModelPolicyPreference` instead of `undefined`, pass the context as the third `write` argument, and append:

```ts
  it("reports each processed batch through onRemembered with its own context", async () => {
    const first = deferred<StarterModelPolicyPreference>();
    const second = deferred<StarterModelPolicyPreference>();
    const remember = vi.fn<ConfirmedStarterModelPolicyPreferenceWriterDependencies["remember"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const remembered: { preference: StarterModelPolicyPreference; context: ConfirmedPreferenceWriteContext }[] = [];
    const writer = new ConfirmedStarterModelPolicyPreferenceWriter({
      remember,
      onRemembered: (_scope, preference, context) => { remembered.push({ preference, context }); },
    });
    const scope = { machineId: "remote-a", cwd: "/repo" };
    const creationContext: ConfirmedPreferenceWriteContext = {
      reason: "creation",
      requestedPolicy: fullStarterModelPolicyPreference,
    };
    const createdPreference: StarterModelPolicyPreference = {
      mode: "exact",
      exact: { model: { provider: "acme", id: "small" }, thinkingLevel: "minimal" },
    };

    const creationWrite = writer.write(scope, { ...oldSession, id: "session-a" }, creationContext);
    const saveWrite = writer.write(scope, { ...oldSession, id: "session-b" }, { reason: "policy-save" });
    first.resolve(createdPreference);
    second.resolve(fullStarterModelPolicyPreference);
    await Promise.all([creationWrite, saveWrite]);

    expect(remembered).toEqual([
      { preference: createdPreference, context: creationContext },
      { preference: fullStarterModelPolicyPreference, context: { reason: "policy-save" } },
    ]);
  });

  it("coalesces the newest context for a queued batch", async () => {
    const first = deferred<StarterModelPolicyPreference>();
    const queued = deferred<StarterModelPolicyPreference>();
    const remember = vi.fn<ConfirmedStarterModelPolicyPreferenceWriterDependencies["remember"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(queued.promise);
    const contexts: ConfirmedPreferenceWriteContext[] = [];
    const writer = new ConfirmedStarterModelPolicyPreferenceWriter({
      remember,
      onRemembered: (_scope, _preference, context) => { contexts.push(context); },
    });
    const scope = { machineId: "remote-a", cwd: "/repo" };
    const superseded: StarterModelPolicyPreference = {
      mode: "exact",
      exact: { model: { provider: "acme", id: "retired" }, thinkingLevel: "medium" },
    };

    const firstWrite = writer.write(scope, { ...oldSession, id: "session-a" }, {
      reason: "creation",
      requestedPolicy: fullStarterModelPolicyPreference,
    });
    writer.write(scope, { ...oldSession, id: "session-b" }, {
      reason: "creation",
      requestedPolicy: superseded,
    });
    const newestWrite = writer.write(scope, { ...oldSession, id: "session-c" }, { reason: "policy-save" });
    first.resolve(fullStarterModelPolicyPreference);
    await vi.waitFor(() => { expect(remember).toHaveBeenCalledTimes(2); });
    queued.resolve(fullStarterModelPolicyPreference);
    await Promise.all([firstWrite, newestWrite]);

    expect(contexts).toEqual([
      { reason: "creation", requestedPolicy: fullStarterModelPolicyPreference },
      { reason: "policy-save" },
    ]);
  });

  it("contains onRemembered observer throws", async () => {
    const remember = vi.fn<ConfirmedStarterModelPolicyPreferenceWriterDependencies["remember"]>()
      .mockResolvedValue(fullStarterModelPolicyPreference);
    const onRemembered = vi.fn(() => { throw new Error("observer failed"); });
    const writer = new ConfirmedStarterModelPolicyPreferenceWriter({ remember, onRemembered });
    const scope = { machineId: "remote-a", cwd: "/repo" };

    await expect(writer.write(scope, { ...oldSession, id: "session-a" }, saveContext)).resolves.toBeUndefined();
    await expect(writer.write(scope, { ...oldSession, id: "session-b" }, saveContext)).resolves.toBeUndefined();
    await vi.waitFor(() => { expect(writer.snapshot(scope)).toEqual({ saving: false }); });

    expect(remember).toHaveBeenCalledTimes(2);
  });
```

In `sessionController.pendingStarts.test.ts`, change each confirmation assertion to the creation arm:

```ts
    expect(confirmation.reason).toBe("creation");
    expect(confirmation.requestedPolicy).toEqual(fullStarterModelPolicyPreference);
    expect(confirmation.requestedPolicy).toBe(requestedPolicy);
```

```ts
    expect(onStarterModelPolicyConfirmed).toHaveBeenCalledWith({
      reason: "creation",
      machineId: "local",
      session: started,
      requestedPolicy: fullStarterModelPolicyPreference,
    });
```

In `sessionController.modelPolicy.test.ts`, change the save confirmation to:

```ts
    expect(onStarterModelPolicyConfirmed).toHaveBeenCalledWith({
      reason: "policy-save",
      machineId: "remote",
      session: plusSession,
      policy: confirmedPolicy,
    });
    const event = onStarterModelPolicyConfirmed.mock.calls[0]?.[0];
    if (event === undefined || event.reason !== "policy-save") {
      throw new Error("Expected a confirmed starter policy save event");
    }
    expect(event.policy).not.toBe(confirmedPolicy);
    expect(event.policy).not.toBe(optimistic);
    expect(event.policy.exact).not.toBe(confirmedPolicy.exact);
    expect(event.policy.exact.model).not.toBe(confirmedPolicy.exact.model);
    event.policy.exact.model.id = "mutated-by-observer";
    expect(confirmedPolicy.exact.model.id).toBe("gpt-advanced");
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: FAIL, the union member and the third `write` argument do not exist.

- [ ] **Step 3: Write the implementation**

In `sessionController.ts`, replace the event interface:

```ts
export type StarterModelPolicyConfirmedEvent =
  | {
      reason: "creation";
      machineId: string;
      session: SessionInfo;
      requestedPolicy: StarterModelPolicyPreference;
    }
  | {
      reason: "policy-save";
      machineId: string;
      session: SessionInfo;
      policy: StarterModelPolicyPreference;
    };
```

Change the creation publish in `startSessionRequest`:

```ts
        this.publishStarterModelPolicyConfirmed({
          reason: "creation",
          machineId,
          session: { ...session },
          requestedPolicy: pending.request.initialModelPolicy,
        });
```

Change the save publish in `saveModelPolicy`:

```ts
          this.publishStarterModelPolicyConfirmed({
            reason: "policy-save",
            machineId,
            session: { ...sessionInfo },
            policy: cloneStarterModelPolicyPreference(response.policy),
          });
```

In `confirmedStarterModelPolicyPreferenceWriter.ts`, import `type StarterModelPolicyPreference` from `../../../shared/apiTypes`, then add the context type and extend the dependencies:

```ts
export type ConfirmedPreferenceWriteContext =
  | { reason: "creation"; requestedPolicy: StarterModelPolicyPreference }
  | { reason: "policy-save" };

export interface ConfirmedStarterModelPolicyPreferenceWriterDependencies {
  remember(
    scope: StarterModelPolicyPreferenceWriteScope,
    session: SessionInfo,
  ): Promise<StarterModelPolicyPreference>;
  onRemembered?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    preference: StarterModelPolicyPreference,
    context: ConfirmedPreferenceWriteContext,
  ) => void;
  onStateChange?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    snapshot: StarterModelPolicyPreferenceWriteSnapshot,
  ) => void;
}
```

Change `PendingConfirmedPreferenceWrite` to `{ session, context, completions }`; make `write` accept and clone the context on every call (newest wins); and change `runWorker`:

```ts
  write(
    scope: StarterModelPolicyPreferenceWriteScope,
    session: SessionInfo,
    context: ConfirmedPreferenceWriteContext,
  ): Promise<void> {
    const state = this.stateFor(scope);
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
    if (resolveCompletion === undefined) {
      throw new Error("Confirmed preference write completion was not initialized");
    }

    if (state.pending === undefined) {
      state.pending = { session: cloneSession(session), context: cloneContext(context), completions: [resolveCompletion] };
    } else {
      state.pending.session = cloneSession(session);
      state.pending.context = cloneContext(context);
      state.pending.completions.push(resolveCompletion);
    }
    if (state.worker === undefined) this.startWorker(state);
    this.publish(state);
    return completion;
  }
```

```ts
      try {
        const remembered = await this.deps.remember(cloneScope(state.scope), pending.session);
        state.error = undefined;
        this.reportRemembered(state, remembered, pending.context);
      } catch (error) {
        state.error = String(error);
      }
```

```ts
  private reportRemembered(
    state: ConfirmedPreferenceWriteState,
    preference: StarterModelPolicyPreference,
    context: ConfirmedPreferenceWriteContext,
  ): void {
    try {
      this.deps.onRemembered?.(cloneScope(state.scope), preference, context);
    } catch {
      // Observation must not interrupt confirmed preference persistence.
    }
  }
```

```ts
function cloneContext(context: ConfirmedPreferenceWriteContext): ConfirmedPreferenceWriteContext {
  return context.reason === "creation"
    ? { reason: "creation", requestedPolicy: clonePreference(context.requestedPolicy) }
    : { reason: "policy-save" };
}

function clonePreference(preference: StarterModelPolicyPreference): StarterModelPolicyPreference {
  return {
    mode: preference.mode,
    exact: {
      model: { ...preference.exact.model },
      thinkingLevel: preference.exact.thinkingLevel,
    },
    ...(preference.tier === undefined ? {} : { tier: preference.tier }),
  };
}
```

In `PiWebUiApp.ts`, change the warning constant, import `type ConfirmedPreferenceWriteContext`, add the `onRemembered` wiring, and update the confirmed handler:

```ts
const CONFIRMED_STARTER_MODEL_POLICY_WARNING = "Could not remember this model policy for future sessions.";
```

```ts
import { ConfirmedStarterModelPolicyPreferenceWriter, type ConfirmedPreferenceWriteContext } from "../controllers/confirmedStarterModelPolicyPreferenceWriter";
```

```ts
  private readonly confirmedStarterModelPolicyPreferenceWriter = new ConfirmedStarterModelPolicyPreferenceWriter({
    remember: (scope, session) => sessionsApi.rememberCurrentModelPolicy(session, scope.machineId),
    onRemembered: (scope, preference, context) => {
      this.handleConfirmedStarterModelPolicyRemembered(scope, preference, context);
    },
    onStateChange: (scope, snapshot) => {
      if (!this.starterModelPolicyPreferenceScopeMatchesCurrentSelection(scope)) return;
      if (this.confirmedStarterModelPolicyUiGeneration === this.starterModelPolicySelectionGeneration) {
        if (!snapshot.saving && snapshot.error === undefined) this.starterModelPolicyPreferenceReadError = "";
        this.requestUpdate();
      }
    },
  });
```

```ts
  private handleStarterModelPolicyConfirmed(event: StarterModelPolicyConfirmedEvent): void {
    const scope: StarterModelPolicyPreferenceWriteScope = {
      machineId: event.machineId,
      cwd: event.session.cwd,
    };
    const scopeMatchesCurrentSelection = this.starterModelPolicyPreferenceScopeMatchesCurrentSelection(scope);
    if (
      scopeMatchesCurrentSelection
      && this.state.selectedSession?.id === event.session.id
      && this.state.selectedSession.cwd === event.session.cwd
    ) {
      if (event.reason === "policy-save") {
        this.starterModelPolicy = modelPolicyDraftFromPolicy(event.policy);
      }
      this.starterModelPolicyPreferenceReadError = "";
      this.confirmedStarterModelPolicyUiScope = scope;
      this.confirmedStarterModelPolicyUiGeneration = this.starterModelPolicySelectionGeneration;
    } else if (
      scopeMatchesCurrentSelection
      && (
        this.confirmedStarterModelPolicyUiScope !== undefined
        || this.confirmedStarterModelPolicyUiGeneration !== undefined
      )
    ) {
      // The writer is workspace-scoped, so a confirmation for another session
      // would otherwise publish its outcome through the current session's owner.
      this.confirmedStarterModelPolicyUiScope = undefined;
      this.confirmedStarterModelPolicyUiGeneration = undefined;
      this.requestUpdate();
    }
    void this.confirmedStarterModelPolicyPreferenceWriter.write(
      scope,
      event.session,
      event.reason === "creation"
        ? { reason: "creation", requestedPolicy: event.requestedPolicy }
        : { reason: "policy-save" },
    );
  }

  private handleConfirmedStarterModelPolicyRemembered(
    scope: StarterModelPolicyPreferenceWriteScope,
    preference: StarterModelPolicyPreference,
    context: ConfirmedPreferenceWriteContext,
  ): void {
    if (context.reason === "policy-save") return;
    if (!this.starterModelPolicyPreferenceScopeMatchesCurrentSelection(scope)) return;
    const draft = this.starterModelPolicy;
    if (draft === undefined) return;
    if (!sameStarterModelPolicyDraft(draft, modelPolicyDraftFromPolicy(context.requestedPolicy))) return;
    this.starterModelPolicy = modelPolicyDraftFromPolicy(preference);
    this.confirmedStarterModelPolicyUiScope = scope;
    this.confirmedStarterModelPolicyUiGeneration = this.starterModelPolicySelectionGeneration;
    this.requestUpdate();
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.modelPolicy.test.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: PASS, with the write-context, observer-throw, coalescing, adoption, and recast cases.

Run: `npm run typecheck && npx eslint src/client/src/controllers/sessionController.ts src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.ts src/client/src/components/PiWebUiApp.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/controllers/sessionController.ts src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.ts src/client/src/components/PiWebUiApp.ts src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.modelPolicy.test.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "feat(starter): carry the creation request into confirmed preference adoption"
```

## Task 12: Status-derived substitution detection and notice

**Lane:** client-app

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/controllers/sessionController.ts:70-95` (substitution event), `:230-245` (check map), `:260-285` (deps and dispose), a new capture/compare block near `:1327`, `:1718-1745` (`resolvePendingSessionStart` capture), `:1877-1905` (`applyCreatedSession` capture), `:1908-1925` (`applyStatus` hook)
- Modify: `src/client/src/components/PiWebUiApp.ts:10` (notice import), `:28` (event import), `:266-278` (deps), a new handler after `:1990`
- Test: `src/client/src/controllers/sessionController.starterPolicySubstitution.test.ts` (new)
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts` (case 7, helper, and `isStarterNotice` kind)

**Interfaces:**

- Consumes: `starterPolicyFallbackNotice` (Task 9); Task 11's committed `sessionController.ts` and `PiWebUiApp.ts`; `sameExactSelection` from `../components/sessionModelPolicyDraft` (existing).
- Produces: `SessionControllerDependencies.onStarterModelPolicySubstitution?: (event: StarterModelPolicySubstitutionEvent) => void` where `StarterModelPolicySubstitutionEvent = { machineId: string; session: SessionInfo; requestedPolicy: StarterModelPolicyPreference; confirmed: { mode: SessionModelPolicyMode; resolved: ExactModelSelection } }`; idempotent capture from both correlation points; one-shot comparison on the first applied status carrying `modelPolicy`.

- [ ] **Step 1: Write the failing controller test**

Create `src/client/src/controllers/sessionController.starterPolicySubstitution.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type {
  ClientSessionModelPolicyStatus,
  StarterModelPolicyPreference,
} from "../../../shared/apiTypes";
import { initialAppState } from "../appState";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import {
  defaultApi,
  deferred,
  emptyPage,
  FakeSocket,
  fullStarterModelPolicyPreference,
  oldSession,
  runPendingAnimationFrames,
  sessionLookupId,
  status,
  workspace,
  type AppState,
  type SessionInfo,
  type SessionStatus,
} from "./sessionController.testSupport";

const REQUESTED_EXACT: StarterModelPolicyPreference = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
};
const SUBSTITUTED_POLICY: ClientSessionModelPolicyStatus = {
  mode: "exact",
  resolved: { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "off" },
  ladderValid: true,
};

function startedSession(): SessionInfo {
  return { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl", creationSource: "session-list-plus" };
}

function substitutedStatus(sessionId: string): SessionStatus {
  return {
    ...status(sessionId),
    modelPolicy: {
      mode: "exact",
      resolved: {
        model: { provider: "openai", id: "gpt-basic" },
        thinkingLevel: "off",
      },
      ladderValid: true,
    },
  };
}

function exactStatus(sessionId: string, selection: StarterModelPolicyPreference["exact"], mode: "exact" | "tiered" = "exact"): SessionStatus {
  return {
    ...status(sessionId),
    modelPolicy: { mode, resolved: { model: { ...selection.model }, thinkingLevel: selection.thinkingLevel }, ladderValid: true },
  };
}

function applySessionStatus(controller: SessionController, value: SessionStatus): void {
  const method: unknown = Reflect.get(controller, "applyStatus");
  if (typeof method !== "function") throw new Error("SessionController.applyStatus is not callable");
  Reflect.apply(method, controller, [value]);
}

function substitutionHarness(
  apiOverrides: Partial<typeof defaultApi>,
  onStarterModelPolicySubstitution: NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]> = () => undefined,
): {
  controller: SessionController;
  state: () => AppState;
} {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
  const api: typeof defaultApi = {
    ...defaultApi,
    messages: () => Promise.resolve(emptyPage),
    status: (session) => Promise.resolve(status(sessionLookupId(session))),
    streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    ...apiOverrides,
  };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket(), onStarterModelPolicySubstitution },
  );
  return { controller, state: () => state };
}

describe("SessionController starter policy substitution detection", () => {
  it("emits one event for a different exact tuple", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);

    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).toHaveBeenCalledOnce();
    const event = substitution.mock.calls[0]?.[0];
    if (event === undefined) throw new Error("Expected a substitution event");
    expect(event.machineId).toBe("local");
    expect(event.session).toEqual(started);
    expect(event.session).not.toBe(started);
    expect(event.requestedPolicy).toEqual(REQUESTED_EXACT);
    expect(event.requestedPolicy).not.toBe(REQUESTED_EXACT);
    expect(event.confirmed).toEqual({
      mode: "exact",
      resolved: { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "off" },
    });
  });

  it("consumes a matching exact status so a later substitution emits nothing", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, exactStatus(started.id, REQUESTED_EXACT.exact));
    expect(substitution).not.toHaveBeenCalled();

    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).not.toHaveBeenCalled();
  });

  it("emits one event for a tiered request that persisted exact", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(fullStarterModelPolicyPreference);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).toHaveBeenCalledOnce();
  });

  it("does not emit for a tiered status", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(fullStarterModelPolicyPreference);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, {
      ...status(started.id),
      modelPolicy: {
        mode: "tiered",
        tier: "advanced",
        resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
        ladderValid: true,
      },
    });

    expect(substitution).not.toHaveBeenCalled();
  });

  it("reconciles a status applied before the HTTP response resolves", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();

    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).not.toHaveBeenCalled();

    startRequest.resolve(started);
    await start;

    expect(substitution).toHaveBeenCalledOnce();
  });

  it("waits for a buffered status to be applied", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();

    harness.controller.applyGlobalEvent({ type: "status.update", status: substitutedStatus(started.id) });
    startRequest.resolve(started);
    await start;

    expect(substitution).not.toHaveBeenCalled();

    runPendingAnimationFrames();
    expect(substitution).toHaveBeenCalledOnce();
  });

  it("stays pending until a status carries a model policy", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, status(started.id));
    expect(substitution).not.toHaveBeenCalled();

    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).toHaveBeenCalledOnce();
  });

  it("never captures a discarded pending start", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({
      startPlusSession: () => startRequest.promise,
      stop: () => Promise.resolve({ stopped: true }),
    }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const selected = harness.state().selectedSession;
    if (selected === undefined) throw new Error("Expected a pending session row");
    await harness.controller.deleteCachedNewSession(selected);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).not.toHaveBeenCalled();
  });

  it("never captures a legacy start with plus provenance", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const started = startedSession();
    const harness = substitutionHarness({ startSession: () => Promise.resolve(started) }, substitution);

    await harness.controller.startSession();
    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).not.toHaveBeenCalled();
  });

  it("captures once when the broadcast precedes the HTTP response", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const started = startedSession();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({
      startPlusSession: () => {
        harness.controller.applyGlobalEvent({ type: "session.created", session: started });
        return startRequest.promise;
      },
    }, substitution);

    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).toHaveBeenCalledOnce();

    startRequest.resolve(started);
    await start;
    harness.controller.applyGlobalEvent({ type: "session.created", session: started });
    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).toHaveBeenCalledOnce();
  });

  it("does not capture a session outside the pending start's cwd", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const started = startedSession();
    const other = { ...started, cwd: "/other" };
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);

    harness.controller.applyGlobalEvent({ type: "session.created", session: other });
    startRequest.resolve(started);
    await start;
    applySessionStatus(harness.controller, substitutedStatus(other.id));

    expect(substitution).not.toHaveBeenCalled();
  });

  it("treats a same-model different-level status as a substitution", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, {
      ...status(started.id),
      modelPolicy: {
        mode: "exact",
        resolved: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "off" },
        ladderValid: true,
      },
    });

    expect(substitution).toHaveBeenCalledOnce();
    expect(substitution.mock.calls[0]?.[0].confirmed.resolved).toEqual({
      model: { provider: "openai", id: "gpt-default" },
      thinkingLevel: "off",
    });
  });

  it("emits exactly one event when both capture points and a second status race", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const started = startedSession();

    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    harness.controller.applyGlobalEvent({ type: "session.created", session: started });
    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).toHaveBeenCalledOnce();

    startRequest.resolve(started);
    await start;
    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/controllers/sessionController.starterPolicySubstitution.test.ts`
Expected: FAIL, `onStarterModelPolicySubstitution` is not called.

- [ ] **Step 3: Write the implementation**

In `sessionController.ts`, import `sameExactSelection` from `../components/sessionModelPolicyDraft` and `type ExactModelSelection`, `type SessionModelPolicyMode` from `../../../shared/apiTypes`. Add the event interface beside `StarterModelPolicyConfirmedEvent`:

```ts
export interface StarterModelPolicySubstitutionEvent {
  machineId: string;
  session: SessionInfo;
  requestedPolicy: StarterModelPolicyPreference;
  confirmed: { mode: SessionModelPolicyMode; resolved: ExactModelSelection };
}
```

Add to `SessionControllerDependencies`:

```ts
  onStarterModelPolicySubstitution?: (event: StarterModelPolicySubstitutionEvent) => void;
```

Add the check type near `SuppressedCreatedSession` and the state field beside `pendingSessionStarts`:

```ts
interface StarterPolicySubstitutionCheck {
  machineId: string;
  session: SessionInfo;
  requestedPolicy: StarterModelPolicyPreference;
  /** Set once an applied status has decided the check; never re-armed. */
  observed: boolean;
}
```

```ts
  private readonly starterModelPolicySubstitutionChecks = new Map<string, StarterPolicySubstitutionCheck>();
```

Assign the callback in the constructor beside `this.onStarterModelPolicyConfirmed = deps.onStarterModelPolicyConfirmed;`:

```ts
    this.onStarterModelPolicySubstitution = deps.onStarterModelPolicySubstitution;
```

Declare the field beside `private readonly onStarterModelPolicyConfirmed`.

Add the capture, lookup, comparison, and publication methods beside `publishStarterModelPolicyConfirmed`:

```ts
  private captureStarterModelPolicySubstitution(
    session: SessionInfo,
    machineId: string,
    requestedPolicy: StarterModelPolicyPreference,
  ): void {
    if (this.starterModelPolicySubstitutionChecks.has(session.id)) return;
    const check: StarterPolicySubstitutionCheck = {
      machineId,
      session: { ...session },
      requestedPolicy: cloneStarterModelPolicyPreference(requestedPolicy),
      observed: false,
    };
    this.starterModelPolicySubstitutionChecks.set(session.id, check);
    const stored = this.getState().sessionStatuses[session.id];
    if (stored !== undefined) this.runStarterPolicySubstitutionCheck(session.id, stored);
  }

  private plusPendingStartPolicy(cwd: string, machineId: string): StarterModelPolicyPreference | undefined {
    for (const pending of this.pendingSessionStarts.values()) {
      if (
        pending.cwd === cwd
        && pending.machineId === machineId
        && !pending.discarded
        && pending.request.kind === "plus"
      ) {
        return pending.request.initialModelPolicy;
      }
    }
    return undefined;
  }

  private runStarterPolicySubstitutionCheck(sessionId: string, status: SessionStatus): void {
    const check = this.starterModelPolicySubstitutionChecks.get(sessionId);
    if (check === undefined || check.observed) return;
    const modelPolicy = status.modelPolicy;
    if (modelPolicy === undefined) return;
    check.observed = true;
    const requested = check.requestedPolicy;
    const substituted = requested.mode === "exact"
      ? modelPolicy.mode !== "exact" || !sameExactSelection(modelPolicy.resolved, requested.exact)
      : modelPolicy.mode === "exact";
    if (!substituted) return;
    const event: StarterModelPolicySubstitutionEvent = {
      machineId: check.machineId,
      session: { ...check.session },
      requestedPolicy: cloneStarterModelPolicyPreference(requested),
      confirmed: {
        mode: modelPolicy.mode,
        resolved: {
          model: { ...modelPolicy.resolved.model },
          thinkingLevel: modelPolicy.resolved.thinkingLevel,
        },
      },
    };
    try {
      this.onStarterModelPolicySubstitution?.(event);
    } catch {
      // Substitution reporting is observational and must not block session work.
    }
  }
```

In `resolvePendingSessionStart`, after the discarded block and before `rememberCachedNewSession(session, pending.machineId);`:

```ts
    if (pending.request.kind === "plus") {
      this.captureStarterModelPolicySubstitution(session, pending.machineId, pending.request.initialModelPolicy);
    }
```

In `applyCreatedSession`, inside the `hasPendingStartFor` branch before `this.suppressedCreatedSessions.set(...)`:

```ts
      const requested = this.plusPendingStartPolicy(session.cwd, machineId);
      if (requested !== undefined) {
        this.captureStarterModelPolicySubstitution(session, machineId, requested);
      }
```

At the end of `applyStatus`, after `this.invalidateSupersededModelPolicy(status);`:

```ts
    this.runStarterPolicySubstitutionCheck(status.sessionId, status);
```

In `dispose()`, after `this.clearPendingUpdates();`:

```ts
    this.starterModelPolicySubstitutionChecks.clear();
```

In `PiWebUiApp.ts`, import the factory and event type:

```ts
import { shouldRetainStarterNotice, starterFailureNotice, starterNoticeVisibleText, starterPolicyBlockedNotice, starterPolicyFallbackNotice, type StarterNotice, type StarterNoticeScope } from "./starterNotice";
```

```ts
import { SessionController, type StarterModelPolicyConfirmedEvent, type StarterModelPolicySubstitutionEvent } from "../controllers/sessionController";
```

Wire the callback beside `onStarterModelPolicyConfirmed`:

```ts
      onStarterModelPolicySubstitution: (event) => { this.handleStarterModelPolicySubstitution(event); },
```

Add the handler after `handleStarterModelPolicyConfirmed`:

```ts
  private handleStarterModelPolicySubstitution(event: StarterModelPolicySubstitutionEvent): void {
    const workspace = this.state.workspaces.find((candidate) => candidate.path === event.session.cwd);
    if (workspace === undefined) return;
    this.publishStarterNotice(starterPolicyFallbackNotice(
      `Session started with the Lightweight utility model (${event.confirmed.resolved.model.provider}/${event.confirmed.resolved.model.id}) because the remembered model was unavailable.`,
      { machineId: event.machineId, workspaceId: workspace.id },
    ));
  }
```

- [ ] **Step 4: Write the failing app test and update the notice guard**

In `PiWebUiApp.sessionModelPolicy.test.ts`, widen the `isStarterNotice` kind guard:

```ts
  if (kind !== "policy-blocked" && kind !== "start-failed" && kind !== "defaults-failed" && kind !== "policy-fallback") return false;
```

Add the helper beside `confirmStarterPolicy`:

```ts
function substitutionEvent(app: PiWebUiApp, event: StarterModelPolicySubstitutionEvent): void {
  const method: unknown = Reflect.get(app, "handleStarterModelPolicySubstitution");
  if (typeof method !== "function") throw new Error("PiWebUiApp.handleStarterModelPolicySubstitution is not callable");
  Reflect.apply(method, app, [event]);
}
```

Import the event type, add `const LIGHTWEIGHT_SELECTION: ExactModelSelection = { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "off" };` (and the `ExactModelSelection` type import) and `type SessionModelPolicyDraft` from `./sessionModelPolicyDraft`. Add a helper that invokes the real starter-edit path:

```ts
function setStarterModelPolicyDraft(app: PiWebUiApp, draft: SessionModelPolicyDraft): void {
  const method: unknown = Reflect.get(app, "setStarterModelPolicyDraft");
  if (typeof method !== "function") throw new Error("PiWebUiApp.setStarterModelPolicyDraft is not callable");
  Reflect.apply(method, app, [draft]);
}
```

Append this case inside the `PiWebUiApp policy-blocked starter notice` describe:

```ts
  it("publishes a policy-fallback notice naming the used model", async () => {
    const app = createApp();
    const session = plusCreatedSession();
    setAppState(app, activeState({
      sessions: [session],
      selectedSession: session,
      machineRuntimes: fullPreferenceCapableStarterState().machineRuntimes,
    }));

    substitutionEvent(app, {
      machineId: "local",
      session: plusCreatedSession(),
      requestedPolicy: completeDefaultPolicy,
      confirmed: { mode: "exact", resolved: LIGHTWEIGHT_SELECTION },
    });

    const message = "Session started with the Lightweight utility model (openai/gpt-basic) because the remembered model was unavailable.";
    expect(templateText(renderApp(app))).toContain(message);
    expect(starterNotice(app)?.kind).toBe("policy-fallback");

    // A session selection in the same workspace must not retire the notice.
    setAppState(app, {
      ...appState(app),
      sessions: [session],
      selectedSession: session,
      status: activeStatus(exactPolicyStatus()),
    });
    expect(templateText(renderApp(app))).toContain(message);

    // A starter edit retires it.
    setStarterModelPolicyDraft(app, {
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });
    expect(starterNotice(app)).toBeUndefined();
  });
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/controllers/sessionController.starterPolicySubstitution.test.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: PASS, the thirteen controller cases and the notice case.

Run: `npm run typecheck && npx eslint src/client/src/controllers/sessionController.ts src/client/src/components/PiWebUiApp.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.starterPolicySubstitution.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "feat(starter): announce a server-confirmed lightweight substitution"
```

## Task 13: Documentation and changeset

**Lane:** docs-release

**Implementer tier:** Fast

**Files:**

- Modify: `docs/config.md:275-290` (Utility models list)
- Modify: `docs/config.html:728-748` (Utility models list)
- Modify: `docs/faq.html:98-115` (TOC) and `:317-335` (new article)
- Create: `.changeset/plus-lightweight-fallback.md`

**Interfaces:**

- Consumes: the pinned copy from Tasks 7, 9, and 11 — the contingent clause `The session may start with the Lightweight utility model.`, the notice text `Session started with the Lightweight utility model (${provider}/${id}) because the remembered model was unavailable.`, and `Could not remember this model policy for future sessions.`
- Produces: synchronized `docs/config.md` and `docs/config.html` Utility models claims, a `docs/faq.html` troubleshooting entry with id `lightweight-model-session`, and one minor Changeset.

- [ ] **Step 1: Add the configuration bullets**

Append these three bullets to the existing Utility models `<ul>` list at the end of `docs/config.md` (after the current last bullet, `- Settings target the selected machine...`):

```markdown
- An unusable remembered `+` policy (its active model or tier cannot resolve) starts the session in Exact mode on `lightweight`; the substituted policy becomes the workspace's remembered starter policy, so the original model returns only when the user reselects it.
- Keep `lightweight` configured and available: if it cannot resolve, `+` fails with the original resolution error plus the lightweight reason instead of starting.
- Older clients show the substitution only as the session's model; current clients also warn before the start when they can evaluate the policy and show a notice naming the used model.
```

Add the mirrored HTML list items at the end of the Utility models `<ul>` in `docs/config.html`:

```html
                <li>An unusable remembered <code>+</code> policy (its active model or tier cannot resolve) starts the session in Exact mode on <code>lightweight</code>; the substituted policy becomes the workspace's remembered starter policy, so the original model returns only when the user reselects it.</li>
                <li>Keep <code>lightweight</code> configured and available: if it cannot resolve, <code>+</code> fails with the original resolution error plus the lightweight reason instead of starting.</li>
                <li>Older clients show the substitution only as the session's model; current clients also warn before the start when they can evaluate the policy and show a notice naming the used model.</li>
```

- [ ] **Step 2: Add the FAQ entry**

Add to the FAQ table of contents in `docs/faq.html`, after `<a href="#sessions-stop">Sessions stop unexpectedly</a>`:

```html
            <a href="#lightweight-model-session">Session started on the lightweight model</a>
```

Add this article after the closing `</article>` of the `sessions-stop` entry (before `<article id="speech-input"`):

```html
            <article id="lightweight-model-session" class="faq-item">
              <h2>My session started on the lightweight model — how do I restore my model?</h2>
              <p>
                The remembered starter model for that workspace could not be resolved when the session started, so PI WEBUI
                substituted the configured <code>lightweight</code> utility model and remembered that substitution as the
                workspace's starter policy. It is not restored automatically. To get the original model back, open the
                session's model policy, choose the intended Exact model and thinking level (or repair the tier ladder and
                choose a tier), and reselect it for the next session. To fix or replace the fallback itself, use
                <strong>Settings → Utility models</strong>.
              </p>
            </article>
```

- [ ] **Step 3: Create the changeset**

Create `.changeset/plus-lightweight-fallback.md`:

```md
---
"@hyperdreamer/pi-webui": minor
---

Start SESSIONS `+` sessions on the configured lightweight utility model when the remembered model policy cannot resolve, remember that substitution, and surface it with a pre-start warning when available plus a notice naming the model actually used.
```

- [ ] **Step 4: Verify the documentation claims and changeset**

```bash
test -f .changeset/plus-lightweight-fallback.md
grep -qF "An unusable remembered" docs/config.md
grep -qF "An unusable remembered" docs/config.html
grep -qF "substituted policy becomes the workspace's remembered starter policy" docs/config.md
grep -qF "substituted policy becomes the workspace's remembered starter policy" docs/config.html
grep -qF "Older clients show the substitution only as the session's model" docs/config.md
grep -qF "Older clients show the substitution only as the session's model" docs/config.html
grep -qF 'id="lightweight-model-session"' docs/faq.html
grep -qF "Settings → Utility models" docs/faq.html
```

Expected: every command exits 0.

- [ ] **Step 5: Run the repository checks and commit**

Run: `npm run lint`
Expected: PASS.

Run: `npx knip`
Expected: PASS, no unused exports.

Run: `npm run typecheck`
Expected: PASS.

```bash
git add docs/config.md docs/config.html docs/faq.html .changeset/plus-lightweight-fallback.md
git commit -m "docs(sessions): document the lightweight plus fallback and record the minor changeset"
```

## Self-review checklist (completed during authoring)

- Spec coverage: §3.1/§3.5 resolve split and rollback → Task 5; §3.2.1 `TierResolutionError` → Task 1; §3.2.2 `SessionModelPolicyResolutionError` → Task 2; §3.3 helper module → Task 4; §3.4 resolver `inspect` and precedence → Task 3; §4.1 decision module → Task 7; §4.2 projection and start gating → Task 10; §4.3 warning properties, rendering, and CSS → Task 8; §4.4 confirmed union, writer context, and adoption guard → Task 11; §4.5 substitution detection and ordering table → Task 12; §4.6 `policy-fallback` notice and lifecycle → Tasks 9 and 12; §5 capability → Task 6; §7.1–§7.4 tests → Tasks 1–12; §8 documentation and changeset → Task 13.
- Placeholder scan: no TBD/TODO/"similar to Task N"; every test step carries real code and every command is exact.
- Type consistency: `TierResolutionError`, `SessionModelPolicyResolutionError`, `UtilityModelUnavailable`, `UtilityModelInspection`, `SessionModelPolicyPlan`, `StarterStartDecision`, `StarterModelPolicyConfirmedEvent`, `ConfirmedPreferenceWriteContext`, `StarterModelPolicySubstitutionEvent`, and `starterPolicyFallbackNotice` are named identically everywhere they appear.
- Interfaces completeness: each task after Task 1 restates every signature it consumes in its `**Interfaces:**` block, including cross-task ones.
- Grammar: exactly `## Task <N>: <Title>` headings starting at 1 with no gaps; one `**Implementer tier:**` per task; `## Global Constraints` precedes Task 1; no plain `##` inside any task body; no `---` rule at a task end.
