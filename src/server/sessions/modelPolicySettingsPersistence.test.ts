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
    durable: (): unknown => JSON.parse(state.durable),
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
    if (!(failure instanceof AggregateError)) {
      throw new Error("expected an aggregate settings restore error");
    }
    expect(failure.message).toMatch(/not durably restored/u);
    expect(failure.errors).toHaveLength(9);
    expect(harness.writes() - writesBefore).toBe(9);
    expect(harness.durable()).toMatchObject({ defaultProvider: "new" });
  });
});
