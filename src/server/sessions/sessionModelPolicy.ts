import {
  MODEL_TIERS,
  type ExactModelSelection,
  type ModelTier,
  type SessionModelPolicy,
  type SessionModelPolicyUpdate,
} from "../../shared/apiTypes.js";

export const SESSION_MODEL_POLICY_CUSTOM_TYPE = "pi-webui.model-policy";

export type SessionModelPolicyInspection =
  | { kind: "legacy"; policy: SessionModelPolicy }
  | { kind: "persisted"; policy: SessionModelPolicy }
  | { kind: "invalid"; reason: string; fallback: SessionModelPolicy };

export interface SessionModelPolicyPlan {
  policy: SessionModelPolicy;
  target: ExactModelSelection;
}

export function inspectSessionModelPolicy(
  entries: readonly unknown[],
  fallback: ExactModelSelection,
): SessionModelPolicyInspection {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isPolicyEntry(entry)) continue;

    try {
      return { kind: "persisted", policy: parsePolicyData(entry["data"]) };
    } catch (error) {
      return {
        kind: "invalid",
        reason: error instanceof Error ? error.message : String(error),
        fallback: exactPolicy(fallback),
      };
    }
  }

  return { kind: "legacy", policy: exactPolicy(fallback) };
}

export function serializeSessionModelPolicy(policy: SessionModelPolicy): Record<string, unknown> {
  return {
    version: 1,
    mode: policy.mode,
    exact: {
      model: { provider: policy.exact.model.provider, id: policy.exact.model.id },
      thinkingLevel: policy.exact.thinkingLevel,
    },
    ...(policy.tier === undefined ? {} : { tier: policy.tier }),
  };
}

export function planSessionModelPolicyInitialization(
  policy: SessionModelPolicy,
  resolveTier: (tier: ModelTier) => ExactModelSelection,
): SessionModelPolicyPlan {
  const cloned = cloneSessionModelPolicy(policy);
  if (cloned.mode === "exact") {
    return {
      policy: cloned,
      target: cloneExactModelSelection(cloned.exact),
    };
  }
  if (cloned.tier === undefined) {
    throw new Error("tiered policy is missing a canonical tier");
  }
  return {
    policy: cloned,
    target: cloneExactModelSelection(resolveTier(cloned.tier)),
  };
}

export function planSessionModelPolicyUpdate(
  current: SessionModelPolicy,
  update: SessionModelPolicyUpdate,
  resolveTier: (tier: ModelTier) => ExactModelSelection,
): SessionModelPolicyPlan {
  if (update.mode === "exact") {
    const exact = cloneExactModelSelection(update.exact);
    return {
      policy: {
        mode: "exact",
        exact,
        ...(current.tier === undefined ? {} : { tier: current.tier }),
      },
      target: cloneExactModelSelection(exact),
    };
  }

  return {
    policy: { mode: "tiered", exact: cloneExactModelSelection(current.exact), tier: update.tier },
    target: cloneExactModelSelection(resolveTier(update.tier)),
  };
}

function isPolicyEntry(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value["type"] === "custom" && value["customType"] === SESSION_MODEL_POLICY_CUSTOM_TYPE;
}

function parsePolicyData(value: unknown): SessionModelPolicy {
  const record = requireRecord(value, "policy data");
  assertOnlyKeys(record, ["version", "mode", "exact", "tier"]);
  if (record["version"] !== 1) throw new Error("unsupported policy version");

  const mode = record["mode"];
  if (mode !== "exact" && mode !== "tiered") throw new Error("invalid policy mode");

  const exact = parseExactModelSelection(record["exact"]);
  const hasTier = Object.prototype.hasOwnProperty.call(record, "tier");
  if (!hasTier) {
    if (mode === "tiered") throw new Error("tiered policy is missing a canonical tier");
    return { mode, exact };
  }

  const tier = record["tier"];
  if (!isCanonicalModelTier(tier)) throw new Error("policy tier is not canonical");
  return { mode, exact, tier };
}

function parseExactModelSelection(value: unknown): ExactModelSelection {
  const record = requireRecord(value, "exact selection");
  assertOnlyKeys(record, ["model", "thinkingLevel"]);
  return {
    model: parseModelReference(record["model"]),
    thinkingLevel: nonBlankString(record["thinkingLevel"], "thinking level"),
  };
}

function parseModelReference(value: unknown): { provider: string; id: string } {
  const record = requireRecord(value, "model reference");
  assertOnlyKeys(record, ["provider", "id"]);
  return {
    provider: nonBlankString(record["provider"], "provider"),
    id: nonBlankString(record["id"], "model id"),
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) throw new Error(`unknown policy data key: ${unknownKey}`);
}

function nonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-blank string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && MODEL_TIERS.some((tier) => tier === value);
}

function exactPolicy(exact: ExactModelSelection): SessionModelPolicy {
  return { mode: "exact", exact: cloneExactModelSelection(exact) };
}

function cloneSessionModelPolicy(policy: SessionModelPolicy): SessionModelPolicy {
  return {
    mode: policy.mode,
    exact: cloneExactModelSelection(policy.exact),
    ...(policy.tier === undefined ? {} : { tier: policy.tier }),
  };
}

function cloneExactModelSelection(selection: ExactModelSelection): ExactModelSelection {
  return {
    model: { provider: selection.model.provider, id: selection.model.id },
    thinkingLevel: selection.thinkingLevel,
  };
}
