import {
  createDevelopmentNativeServicePlan,
  nativeServicePrerequisiteNeedsPathAdvice,
  resolveProductionNativeServicePlan,
  validateNativeServicePlan,
  type DevelopmentNativeServicePlanInput,
  type NativeServiceAuthoritativeProbe,
  type NativeServicePlan,
  type NativeServicePlanDependencies,
  type NativeServicePlanFailure,
  type NativeServicePlanValidationFailure,
  type ProductionNativeServicePlanInput,
} from "./servicePlan.js";

export type NativeServiceInstallCandidate =
  | { mode: "production"; input: ProductionNativeServicePlanInput }
  | { mode: "development"; input: DevelopmentNativeServicePlanInput };

export interface NativeServiceInstallDependencies extends NativeServicePlanDependencies {
  probe: NativeServiceAuthoritativeProbe;
  writeInitialConfig(): Promise<void>;
  replaceServices(plan: NativeServicePlan): Promise<void>;
}

export type NativeServiceInstallFailure =
  | { kind: "plan-resolution"; failures: readonly NativeServicePlanFailure[] }
  | { kind: "plan-validation"; failures: readonly NativeServicePlanValidationFailure[] };

export type NativeServiceInstallResult =
  | { ok: true; plan: NativeServicePlan }
  | { ok: false; failure: NativeServiceInstallFailure };

export function nativeServiceInstallFailureNeedsPathAdvice(failure: NativeServiceInstallFailure): boolean {
  if (failure.kind === "plan-resolution") {
    return failure.failures.every((item) => item.kind === "executable-unavailable")
      && failure.failures.length > 0;
  }
  return failure.failures.some((item) =>
    item.kind === "prerequisite-unsatisfied"
    && nativeServicePrerequisiteNeedsPathAdvice(item.prerequisite));
}

/**
 * Keeps preflight effects ahead of durable install effects. The authoritative
 * probes may create bounded temporary artifacts, but they must clean those up
 * before this function writes config or replaces existing services.
 */
export async function installNativeServiceCandidate(
  candidate: NativeServiceInstallCandidate,
  dependencies: NativeServiceInstallDependencies,
): Promise<NativeServiceInstallResult> {
  let plan: NativeServicePlan;
  if (candidate.mode === "production") {
    const resolution = await resolveProductionNativeServicePlan(candidate.input, dependencies);
    if (!resolution.ok) {
      return { ok: false, failure: { kind: "plan-resolution", failures: resolution.failures } };
    }
    plan = resolution.plan;
  } else {
    plan = createDevelopmentNativeServicePlan(candidate.input);
  }

  const validation = await validateNativeServicePlan(plan, dependencies.probe);
  if (!validation.ok) {
    return { ok: false, failure: { kind: "plan-validation", failures: validation.failures } };
  }

  await dependencies.writeInitialConfig();
  await dependencies.replaceServices(plan);
  return { ok: true, plan };
}
