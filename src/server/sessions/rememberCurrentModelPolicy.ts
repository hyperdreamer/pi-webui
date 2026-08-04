import type { StarterModelPolicyPreference } from "../../shared/apiTypes.js";
import type { CreationSourceInspection } from "./sessionCreationSource.js";
import type { SessionModelPolicyInspection } from "./sessionModelPolicy.js";
import type { SessionRouteLookup } from "./sessionService.js";
import type { StarterModelPolicyPreferenceStore } from "./starterModelPolicyPreferenceStore.js";

export interface ConfirmedPolicySnapshot {
  cwd: string;
  creationSource: CreationSourceInspection;
  persisted: boolean;
  rootEligibility:
    | { kind: "eligible" }
    | { kind: "ineligible"; reason: string };
  modelPolicy: SessionModelPolicyInspection;
  transitionInFlight: boolean;
}

export interface RememberCurrentModelPolicyDependencies {
  loadSnapshot(session: SessionRouteLookup): Promise<ConfirmedPolicySnapshot>;
  preferenceStore: Pick<StarterModelPolicyPreferenceStore, "replace">;
}

export class RememberCurrentModelPolicyConflictError extends Error {}

export class RememberCurrentModelPolicyCommand {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RememberCurrentModelPolicyDependencies) {}

  remember(session: SessionRouteLookup): Promise<StarterModelPolicyPreference> {
    return this.exclusive(async () => {
      const snapshot = await this.deps.loadSnapshot(session);
      const preference = confirmedPreference(snapshot);
      await this.deps.preferenceStore.replace(snapshot.cwd, {
        kind: "full",
        preference,
      });
      return clonePreference(preference);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function confirmedPreference(snapshot: ConfirmedPolicySnapshot): StarterModelPolicyPreference {
  if (!snapshot.persisted) {
    throw new RememberCurrentModelPolicyConflictError(
      "Cannot remember a session before its transcript is durably persisted",
    );
  }
  if (snapshot.creationSource.kind !== "valid") {
    throw new RememberCurrentModelPolicyConflictError(
      "Only sessions created from SESSIONS + can be remembered",
    );
  }
  if (snapshot.rootEligibility.kind !== "eligible") {
    throw new RememberCurrentModelPolicyConflictError(
      `Only a durable top-level root created from SESSIONS + can be remembered (${snapshot.rootEligibility.reason})`,
    );
  }
  if (snapshot.transitionInFlight) {
    throw new RememberCurrentModelPolicyConflictError(
      "Cannot remember the session model policy while a policy mutation is in progress",
    );
  }
  if (snapshot.modelPolicy.kind !== "persisted") {
    throw new RememberCurrentModelPolicyConflictError(
      "Cannot remember a session without a valid persisted model policy",
    );
  }
  return clonePreference(snapshot.modelPolicy.policy);
}

function clonePreference(preference: StarterModelPolicyPreference): StarterModelPolicyPreference {
  const exact = {
    model: {
      provider: preference.exact.model.provider,
      id: preference.exact.model.id,
    },
    thinkingLevel: preference.exact.thinkingLevel,
  };
  return preference.tier === undefined
    ? { mode: preference.mode, exact }
    : { mode: preference.mode, exact, tier: preference.tier };
}
