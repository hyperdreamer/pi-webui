import { describe, expect, it, vi } from "vitest";
import {
  buildModelPolicyCapability,
  MODEL_POLICY_CONTRACT_VERSION,
} from "./modelPolicyCapability.js";
import type { ExactModelSelection } from "../../shared/apiTypes.js";

const RUNTIME: ExactModelSelection = {
  model: { provider: "TokenSupply", id: "gpt-5.6-terra" },
  thinkingLevel: "max",
};
const LADDER_STANDARD: ExactModelSelection = {
  model: { provider: "TokenSupply", id: "gpt-5.6-terra" },
  thinkingLevel: "max",
};
const LADDER_FRONTIER: ExactModelSelection = {
  model: { provider: "RightCode-Anthropic", id: "claude-opus-5" },
  thinkingLevel: "max",
};

function input(
  overrides: Partial<Parameters<typeof buildModelPolicyCapability>[0]> = {}
) {
  return {
    policy: { mode: "exact" as const, exact: RUNTIME },
    currentRuntime: RUNTIME,
    ladder: { valid: true } as const,
    resolveTier: () => LADDER_STANDARD,
    ...overrides,
  };
}

describe("buildModelPolicyCapability", () => {
  it("reports the frozen contract version", () => {
    expect(buildModelPolicyCapability(input()).contractVersion).toBe(1);
    expect(MODEL_POLICY_CONTRACT_VERSION).toBe(1);
  });

  describe("conditional invariants from the capability contract", () => {
    it("Exact mode: currentTier is null and the two tuples are equal", () => {
      const result = buildModelPolicyCapability(
        input({ policy: { mode: "exact", exact: RUNTIME } })
      );
      expect(result.policy.currentTier).toBeNull();
      expect(result.policy.currentRuntime).toEqual(RUNTIME);
      expect(result.policy.nextRequestResolved).toEqual(RUNTIME);
    });

    it("Exact mode permits an invalid ladder without blocking the next request", () => {
      const result = buildModelPolicyCapability(
        input({
          policy: { mode: "exact", exact: RUNTIME },
          ladder: {
            valid: false,
            reason: "tier fast names unavailable model acme/gone",
          },
          resolveTier: () => {
            throw new Error("must not be called in exact mode");
          },
        })
      );
      expect(result.ladder.valid).toBe(false);
      expect(result.ladder.blockedReason).toBe(
        "tier fast names unavailable model acme/gone"
      );
      // The session is pinned, so its own next request is still known.
      expect(result.policy.nextRequestResolved).toEqual(RUNTIME);
    });

    it("valid tiered mode: currentTier is non-null and resolves to the ladder tuple", () => {
      const resolveTier = vi.fn(() => LADDER_FRONTIER);
      const result = buildModelPolicyCapability(
        input({
          policy: { mode: "tiered", exact: RUNTIME, tier: "frontier" },
          resolveTier,
        })
      );
      expect(result.policy.currentTier).toBe("frontier");
      expect(result.policy.nextRequestResolved).toEqual(LADDER_FRONTIER);
      expect(resolveTier).toHaveBeenCalledWith("frontier");
      expect(result.ladder.blockedReason).toBeNull();
    });

    it("invalid tiered mode: nextRequestResolved is null with an actionable reason", () => {
      const result = buildModelPolicyCapability(
        input({
          policy: { mode: "tiered", exact: RUNTIME, tier: "standard" },
          ladder: {
            valid: false,
            reason: "tier standard names unavailable model TokenSupply/gone",
          },
          resolveTier: () => {
            throw new Error(
              "tier standard names unavailable model TokenSupply/gone"
            );
          },
        })
      );
      expect(result.policy.nextRequestResolved).toBeNull();
      expect(result.ladder.blockedReason).toBe(
        "tier standard names unavailable model TokenSupply/gone"
      );
    });

    it("surfaces a policy blocked reason regardless of mode", () => {
      for (const mode of ["exact", "tiered"] as const) {
        const result = buildModelPolicyCapability(
          input({
            policy: { mode, exact: RUNTIME, tier: "standard" },
            blockedReason: "runtime restoration unproven",
          })
        );
        expect(result.policy.blockedReason).toBe(
          "runtime restoration unproven"
        );
      }
    });
  });

  it("keeps a remembered tier visible while Exact is active, without putting it in force", () => {
    // The stored policy retains the tier so switching back to Tiered restores
    // it; reporting it as `currentTier` would claim tiered dispatch is active.
    const result = buildModelPolicyCapability(
      input({ policy: { mode: "exact", exact: RUNTIME, tier: "capable" } })
    );
    expect(result.policy.rememberedTier).toBe("capable");
    expect(result.policy.currentTier).toBeNull();
  });

  it("does not resolve a tier in exact mode", () => {
    const resolveTier = vi.fn(() => LADDER_STANDARD);
    buildModelPolicyCapability(
      input({
        policy: { mode: "exact", exact: RUNTIME, tier: "capable" },
        resolveTier,
      })
    );
    expect(resolveTier).not.toHaveBeenCalled();
  });

  it("treats a malformed persisted entry as exact mode with no remembered tier", () => {
    const result = buildModelPolicyCapability(input({ policy: undefined }));
    expect(result.policy.mode).toBe("exact");
    expect(result.policy.rememberedTier).toBeNull();
    expect(result.policy.currentTier).toBeNull();
  });

  it("reports a resolution failure even when validate() called the ladder valid", () => {
    // The catalog can change between a cached validation and this resolution;
    // the actionable failure must win over the stale 'valid'.
    const result = buildModelPolicyCapability(
      input({
        policy: { mode: "tiered", exact: RUNTIME, tier: "standard" },
        ladder: { valid: true },
        resolveTier: () => {
          throw new Error(
            "tier standard names unavailable model TokenSupply/gpt-5.6-terra"
          );
        },
      })
    );
    expect(result.ladder.valid).toBe(true);
    expect(result.ladder.blockedReason).toBe(
      "tier standard names unavailable model TokenSupply/gpt-5.6-terra"
    );
    expect(result.policy.nextRequestResolved).toBeNull();
  });

  it("reports no ladder revision, since nothing tracks one", () => {
    expect(buildModelPolicyCapability(input()).ladder.revision).toBeNull();
  });

  it("advertises the tracked-dispatch contract the controller checks", () => {
    const { trackedDispatch } = buildModelPolicyCapability(input());
    expect(trackedDispatch).toEqual({
      contractVersion: 1,
      tierField: true,
      scope: "parent-session",
      canonicalInputs: ["cwd", "prompt", "tier"],
      returnsSessionId: true,
    });
  });

  it("advertises no tier slash commands, because none are implemented", () => {
    // An earlier contract draft advertised /tier-economy.../tier-frontier plus
    // /tier-up and /tier-down. No such command is registered anywhere, so
    // advertising them would promise a channel that does not exist.
    expect(JSON.stringify(buildModelPolicyCapability(input()))).not.toContain(
      "/tier-"
    );
  });
});
