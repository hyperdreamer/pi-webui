import type { PiWebUiConfigValues } from "../../shared/apiTypes.js";
import { parseWorkspaceTasksConfig, serializeWorkspaceTasksConfig, type WorkspaceTasksConfig } from "../../shared/workspaceTasks.js";
import type { PiWebUiConfigService } from "../configRoutes.js";
import type {
  WorkspaceTasksMutationAuthorizer,
  WorkspaceTasksMoveWriteIntent,
} from "./workspaceTasksErrors.js";
import { WorkspaceTasksMoveRecoveryPendingError } from "./workspaceTasksMoveRegistry.js";

const WORKSPACE_TASKS_PLUGIN_ID = "workspace-tasks";
const GLOBAL_TASKS_SETTING = "globalTasks";
const GENERIC_CONFIG_EXPECTED_REVISION = "generic-config";

/**
 * Adds the move registry boundary to first-party generic config mutations.
 * The async reconciliation runs before coordinator entry; the synchronous
 * assertion runs from the coordinator's mutation callback immediately before
 * the underlying config service can publish the next projection.
 */
export class WorkspaceTasksGlobalMutationGate {
  constructor(private readonly authorizer: WorkspaceTasksMutationAuthorizer) {}

  decorate(config: PiWebUiConfigService): PiWebUiConfigService {
    return {
      read: () => config.read(),
      write: (next) => this.mutateAfterReconciliation(config, () => next),
      update: (mutate) => this.mutateAfterReconciliation(config, mutate),
    };
  }

  private async mutateAfterReconciliation(
    config: PiWebUiConfigService,
    mutate: (current: PiWebUiConfigValues) => PiWebUiConfigValues,
  ) {
    let recoveryError: WorkspaceTasksMoveRecoveryPendingError | undefined;
    try {
      await this.authorizer.reconcileGlobalMoveClaim({ scope: "global" });
    } catch (error) {
      if (!(error instanceof WorkspaceTasksMoveRecoveryPendingError)) throw error;
      recoveryError = error;
    }

    return config.update((current) => {
      const beforeProjection = globalTaskProjection(current);
      const next = mutate(current);
      if (beforeProjection === globalTaskProjection(next)) return next;
      if (recoveryError !== undefined) throw recoveryError;
      this.authorizer.assertGlobalMutationAllowed(globalMutationIntent(next));
      return next;
    });
  }
}

function globalMutationIntent(config: PiWebUiConfigValues): Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }> {
  return {
    scope: "global",
    expectedRevision: GENERIC_CONFIG_EXPECTED_REVISION,
    config: parsedGlobalTaskCatalog(config),
  };
}

function globalTaskProjection(config: PiWebUiConfigValues): string {
  const raw = config.plugins?.[WORKSPACE_TASKS_PLUGIN_ID]?.settings?.[GLOBAL_TASKS_SETTING];
  const parsed = parseWorkspaceTasksConfig(raw === undefined ? emptyCatalog() : raw);
  if (parsed.ok) return serializeWorkspaceTasksConfig(parsed.config);
  return `invalid:${serializedUnknownValue(raw)}`;
}

function parsedGlobalTaskCatalog(config: PiWebUiConfigValues): WorkspaceTasksConfig {
  const raw = config.plugins?.[WORKSPACE_TASKS_PLUGIN_ID]?.settings?.[GLOBAL_TASKS_SETTING];
  const parsed = parseWorkspaceTasksConfig(raw === undefined ? emptyCatalog() : raw);
  return parsed.ok ? parsed.config : emptyCatalog();
}

function emptyCatalog(): WorkspaceTasksConfig {
  return { version: 1, tasks: [] };
}

function serializedUnknownValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "unserializable";
  }
}
