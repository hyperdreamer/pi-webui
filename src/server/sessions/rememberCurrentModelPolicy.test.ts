import { describe, expect, it, vi } from "vitest";
import type { StarterModelPolicyPreference } from "../../shared/apiTypes.js";
import type { CreationSourceInspection } from "./sessionCreationSource.js";
import type { SessionModelPolicyInspection } from "./sessionModelPolicy.js";
import {
  RememberCurrentModelPolicyCommand,
  type ConfirmedPolicySnapshot,
} from "./rememberCurrentModelPolicy.js";

const EXACT_POLICY = {
  mode: "exact",
  exact: {
    model: { provider: "openai", id: "gpt-exact" },
    thinkingLevel: "high",
  },
  tier: "advanced",
} as const;

const TIERED_POLICY = {
  mode: "tiered",
  exact: {
    model: { provider: "anthropic", id: "claude-exact" },
    thinkingLevel: "medium",
  },
  tier: "frontier",
} as const;

function eligibleSnapshot(
  policy: StarterModelPolicyPreference = EXACT_POLICY,
): ConfirmedPolicySnapshot {
  return {
    cwd: "/workspace",
    creationSource: { kind: "valid", source: "session-list-plus" },
    modelPolicy: { kind: "persisted", policy },
    transitionInFlight: false,
  };
}

function createHarness(snapshot: ConfirmedPolicySnapshot = eligibleSnapshot()) {
  const loadSnapshot = vi.fn(() => Promise.resolve(snapshot));
  const preferenceStore = {
    replace: vi.fn(() => Promise.resolve()),
  };
  const command = new RememberCurrentModelPolicyCommand({
    loadSnapshot,
    preferenceStore,
  });
  return { command, loadSnapshot, preferenceStore };
}

describe("RememberCurrentModelPolicyCommand", () => {
  it.each([
    ["Exact", EXACT_POLICY],
    ["Tiered", TIERED_POLICY],
  ] as const)("writes and returns the confirmed persisted %s policy", async (_label, policy) => {
    const harness = createHarness(eligibleSnapshot(policy));

    const remembered = await harness.command.remember({ id: "session-1", cwd: "/workspace" });

    expect(remembered).toEqual(policy);
    expect(remembered).not.toBe(policy);
    expect(remembered.exact).not.toBe(policy.exact);
    expect(remembered.exact.model).not.toBe(policy.exact.model);
    expect(harness.preferenceStore.replace).toHaveBeenCalledOnce();
    expect(harness.preferenceStore.replace).toHaveBeenCalledWith("/workspace", {
      kind: "full",
      preference: policy,
    });
  });

  it.each([
    ["an absent source", { kind: "absent" }],
    ["a malformed source", { kind: "invalid", reason: "creation source data must be an object" }],
    ["an invalid newest source", { kind: "invalid", reason: "unsupported creation source version" }],
  ] as const)("rejects %s", async (_label, creationSource) => {
    const harness = createHarness({
      ...eligibleSnapshot(),
      creationSource: creationSource satisfies CreationSourceInspection,
    });

    await expect(harness.command.remember("session-1")).rejects.toThrow(/SESSIONS \+/u);
    expect(harness.preferenceStore.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["an absent persisted policy", { kind: "legacy", policy: EXACT_POLICY }],
    ["a legacy fallback policy", { kind: "legacy", policy: TIERED_POLICY }],
    [
      "a malformed newest policy",
      { kind: "invalid", reason: "unsupported policy version", fallback: EXACT_POLICY },
    ],
  ] as const)("rejects %s", async (_label, modelPolicy) => {
    const harness = createHarness({
      ...eligibleSnapshot(),
      modelPolicy: modelPolicy satisfies SessionModelPolicyInspection,
    });

    await expect(harness.command.remember("session-1")).rejects.toThrow(/persisted model policy/u);
    expect(harness.preferenceStore.replace).not.toHaveBeenCalled();
  });

  it("rejects a transient policy mutation", async () => {
    const harness = createHarness({ ...eligibleSnapshot(), transitionInFlight: true });

    await expect(harness.command.remember("session-1")).rejects.toThrow(/in progress/u);
    expect(harness.preferenceStore.replace).not.toHaveBeenCalled();
  });

  it("serializes snapshot reads with preference writes so delayed calls use execution-time truth", async () => {
    let snapshot = eligibleSnapshot(EXACT_POLICY);
    let releaseFirst: (() => void) | undefined;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reads = 0;
    const loadSnapshot = vi.fn(async () => {
      reads += 1;
      if (reads === 1) await firstReadGate;
      return snapshot;
    });
    const writes: StarterModelPolicyPreference[] = [];
    const preferenceStore = {
      replace: vi.fn((_cwd: string, write: { kind: "full"; preference: StarterModelPolicyPreference }) => {
        writes.push(write.preference);
        return Promise.resolve();
      }),
    };
    const command = new RememberCurrentModelPolicyCommand({ loadSnapshot, preferenceStore });

    const first = command.remember("session-1");
    await vi.waitFor(() => { expect(loadSnapshot).toHaveBeenCalledOnce(); });
    const second = command.remember("session-1");
    snapshot = eligibleSnapshot(TIERED_POLICY);
    releaseFirst?.();

    await expect(first).resolves.toEqual(TIERED_POLICY);
    await expect(second).resolves.toEqual(TIERED_POLICY);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(writes).toEqual([TIERED_POLICY, TIERED_POLICY]);
    expect(writes.at(-1)).toEqual(TIERED_POLICY);
  });

  it("continues the command queue after a preference save rejects", async () => {
    const snapshot = eligibleSnapshot(TIERED_POLICY);
    const loadSnapshot = vi.fn(() => Promise.resolve(snapshot));
    const preferenceStore = {
      replace: vi.fn()
        .mockRejectedValueOnce(new Error("preference store unavailable"))
        .mockResolvedValueOnce(undefined),
    };
    const command = new RememberCurrentModelPolicyCommand({ loadSnapshot, preferenceStore });

    await expect(command.remember("session-1")).rejects.toThrow("preference store unavailable");
    await expect(command.remember("session-1")).resolves.toEqual(TIERED_POLICY);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(preferenceStore.replace).toHaveBeenCalledTimes(2);
  });
});
