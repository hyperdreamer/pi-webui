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
