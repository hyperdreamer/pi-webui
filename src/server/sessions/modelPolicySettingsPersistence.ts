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
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    typeof candidate["getGlobalSettings"] === "function" &&
    typeof candidate["setDefaultProvider"] === "function" &&
    typeof candidate["setDefaultModel"] === "function" &&
    typeof candidate["setDefaultThinkingLevel"] === "function" &&
    typeof candidate["flush"] === "function" &&
    typeof candidate["drainErrors"] === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalThinkingLevel(value: unknown): ClientThinkingLevel | undefined {
  return typeof value === "string" && isKnownThinkingLevel(value) ? value : undefined;
}
