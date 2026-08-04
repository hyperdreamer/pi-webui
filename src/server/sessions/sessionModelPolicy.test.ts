import { describe, expect, it } from "vitest";
import type { ExactModelSelection, SessionModelPolicy } from "../../shared/apiTypes.js";
import {
  SESSION_MODEL_POLICY_CUSTOM_TYPE,
  inspectSessionModelPolicy,
  planSessionModelPolicyInitialization,
  planSessionModelPolicyUpdate,
  serializeSessionModelPolicy,
} from "./sessionModelPolicy.js";

function policyEntry(data: unknown): unknown {
  return { type: "custom", customType: SESSION_MODEL_POLICY_CUSTOM_TYPE, data };
}

const fallback: ExactModelSelection = {
  model: { provider: "openai", id: "gpt-default" },
  thinkingLevel: "medium",
};

function exactPolicy(overrides: { model?: Partial<ExactModelSelection["model"]>; thinkingLevel?: string } = {}): SessionModelPolicy {
  return {
    mode: "exact",
    exact: {
      model: { ...fallback.model, ...overrides.model },
      thinkingLevel: overrides.thinkingLevel ?? fallback.thinkingLevel,
    },
  };
}

describe("session model policy domain", () => {
  describe("inspectSessionModelPolicy", () => {
    it("uses the legacy exact fallback when no policy entry exists", () => {
      expect(inspectSessionModelPolicy([], fallback)).toEqual({
        kind: "legacy",
        policy: { mode: "exact", exact: fallback },
      });
    });

    it("uses the newest matching policy entry and ignores non-policy entries", () => {
      const older = exactPolicy({ model: { id: "gpt-older" } });
      const newer = exactPolicy({ model: { id: "gpt-newer" }, thinkingLevel: "high" });

      expect(inspectSessionModelPolicy([
        { type: "message", message: "not a policy" },
        policyEntry(serializeSessionModelPolicy(older)),
        { type: "custom", customType: "other.custom", data: { version: 1 } },
        policyEntry(serializeSessionModelPolicy(newer)),
      ], fallback)).toEqual({ kind: "persisted", policy: newer });
    });

    it("does not revive an older valid policy after the newest policy entry is invalid", () => {
      expect(inspectSessionModelPolicy([
        policyEntry(serializeSessionModelPolicy({ mode: "exact", exact: fallback })),
        policyEntry({ version: 99 }),
      ], fallback)).toMatchObject({ kind: "invalid" });
    });

    it("rejects a tiered policy without a canonical tier", () => {
      const result = inspectSessionModelPolicy([
        policyEntry({
          version: 1,
          mode: "tiered",
          exact: serializeSessionModelPolicy(exactPolicy())["exact"],
        }),
      ], fallback);

      expect(result).toMatchObject({ kind: "invalid" });
    });

    it.each([
      ["an unknown data key", { ...serializeSessionModelPolicy(exactPolicy()), future: true }],
      ["a blank provider", { ...serializeSessionModelPolicy(exactPolicy()), exact: { model: { provider: "   ", id: "gpt" }, thinkingLevel: "medium" } }],
      ["a blank model id", { ...serializeSessionModelPolicy(exactPolicy()), exact: { model: { provider: "openai", id: "" }, thinkingLevel: "medium" } }],
      ["a blank thinking level", { ...serializeSessionModelPolicy(exactPolicy()), exact: { model: { provider: "openai", id: "gpt" }, thinkingLevel: "" } }],
      ["an unsupported mode", { ...serializeSessionModelPolicy(exactPolicy()), mode: "automatic" }],
    ] as const)("rejects %s", (_description, data) => {
      expect(inspectSessionModelPolicy([policyEntry(data)], fallback)).toMatchObject({ kind: "invalid" });
    });
  });

  describe("serializeSessionModelPolicy", () => {
    it("writes the strict version-one policy shape", () => {
      expect(serializeSessionModelPolicy({ mode: "tiered", exact: fallback, tier: "advanced" })).toEqual({
        version: 1,
        mode: "tiered",
        exact: {
          model: { provider: "openai", id: "gpt-default" },
          thinkingLevel: "medium",
        },
        tier: "advanced",
      });
      expect(serializeSessionModelPolicy({ mode: "exact", exact: fallback })).toEqual({
        version: 1,
        mode: "exact",
        exact: {
          model: { provider: "openai", id: "gpt-default" },
          thinkingLevel: "medium",
        },
      });
    });

    it("clones nested caller-owned policy data", () => {
      const policy = exactPolicy({ model: { id: "gpt-original" } });
      const serialized = serializeSessionModelPolicy(policy);

      policy.exact.model.id = "gpt-mutated-after-serialization";
      policy.exact.thinkingLevel = "high";
      expect(serialized["exact"]).toEqual({ model: { provider: "openai", id: "gpt-original" }, thinkingLevel: "medium" });
    });
  });

  describe("planSessionModelPolicyInitialization", () => {
    it("clones a complete Exact policy without resolving its inactive tier", () => {
      const policy: SessionModelPolicy = {
        mode: "exact",
        exact: {
          model: { provider: "openai", id: "gpt-exact" },
          thinkingLevel: "high",
        },
        tier: "frontier",
      };

      const plan = planSessionModelPolicyInitialization(policy, () => {
        throw new Error("inactive tier must not be resolved");
      });

      expect(plan).toEqual({ policy, target: policy.exact });
      expect(plan.policy).not.toBe(policy);
      expect(plan.policy.exact).not.toBe(policy.exact);
      expect(plan.policy.exact.model).not.toBe(policy.exact.model);
      expect(plan.target).not.toBe(policy.exact);
      expect(plan.target.model).not.toBe(policy.exact.model);
    });

    it("retains an unavailable inactive Exact tuple and resolves only the active canonical tier", () => {
      const standardSelection: ExactModelSelection = {
        model: { provider: "openai", id: "gpt-standard" },
        thinkingLevel: "medium",
      };
      const resolveCalls: string[] = [];

      const plan = planSessionModelPolicyInitialization({
        mode: "tiered",
        exact: {
          model: { provider: "retired", id: "remembered" },
          thinkingLevel: "retired-level",
        },
        tier: "standard",
      }, (tier) => {
        resolveCalls.push(tier);
        return standardSelection;
      });

      expect(plan).toEqual({
        policy: {
          mode: "tiered",
          exact: {
            model: { provider: "retired", id: "remembered" },
            thinkingLevel: "retired-level",
          },
          tier: "standard",
        },
        target: standardSelection,
      });
      expect(resolveCalls).toEqual(["standard"]);
      expect(plan.target).not.toBe(standardSelection);
      expect(plan.target.model).not.toBe(standardSelection.model);
    });
  });

  describe("planSessionModelPolicyUpdate", () => {
    it("preserves the remembered exact branch when entering Tiered mode", () => {
      const plan = planSessionModelPolicyUpdate(
        { mode: "exact", exact: fallback },
        { mode: "tiered", tier: "advanced" },
        (tier) => ({ model: { provider: "openai", id: `gpt-${tier}` }, thinkingLevel: "high" }),
      );
      expect(plan).toEqual({
        policy: { mode: "tiered", exact: fallback, tier: "advanced" },
        target: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
      });
    });

    it("preserves the remembered exact branch when changing Tiered mode", () => {
      const current: SessionModelPolicy = { mode: "tiered", exact: fallback, tier: "standard" };
      const plan = planSessionModelPolicyUpdate(
        current,
        { mode: "tiered", tier: "frontier" },
        (tier) => ({ model: { provider: "openai", id: `gpt-${tier}` }, thinkingLevel: "high" }),
      );

      expect(plan.policy).toEqual({ mode: "tiered", exact: fallback, tier: "frontier" });
      expect(plan.target).toEqual({ model: { provider: "openai", id: "gpt-frontier" }, thinkingLevel: "high" });
    });

    it("preserves the remembered tier when applying an Exact update", () => {
      const current: SessionModelPolicy = { mode: "tiered", exact: fallback, tier: "advanced" };
      const exact: ExactModelSelection = {
        model: { provider: "anthropic", id: "claude-sonnet" },
        thinkingLevel: "low",
      };

      expect(planSessionModelPolicyUpdate(current, { mode: "exact", exact }, () => {
        throw new Error("resolver must not run for an Exact update");
      })).toEqual({
        policy: { mode: "exact", exact, tier: "advanced" },
        target: exact,
      });
    });

    it("propagates a Tiered resolver failure without a fallback", () => {
      const failure = new Error("advanced tier is unavailable");
      let calls = 0;

      expect(() => planSessionModelPolicyUpdate(
        { mode: "exact", exact: fallback },
        { mode: "tiered", tier: "advanced" },
        () => {
          calls += 1;
          throw failure;
        },
      )).toThrow(failure);
      expect(calls).toBe(1);
    });
  });
});
