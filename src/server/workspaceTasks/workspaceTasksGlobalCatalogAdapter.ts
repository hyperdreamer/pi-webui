import { createHash } from "node:crypto";
import type { PiWebUiConfigMutationCoordinator } from "../../configMutationCoordinator.js";
import type {
  GlobalWorkspaceTasksResponse,
  PiWebUiConfigValues,
  ReplaceGlobalWorkspaceTasksRequest,
} from "../../shared/apiTypes.js";
import {
  assertWorkspaceTasksCatalogSize,
  parseWorkspaceTasksConfig,
  serializeWorkspaceTasksConfig,
  type WorkspaceTasksConfig,
} from "../../shared/workspaceTasks.js";
import {
  WorkspaceTasksInvalidCatalogError,
  WorkspaceTasksRevisionConflictError,
  WorkspaceTasksUnavailableError,
  WorkspaceTasksUnknownOutcomeError,
  type WorkspaceTasksCatalogWriteOptions,
  type WorkspaceTasksMutationAuthorizer,
  type WorkspaceTasksMoveWriteIntent,
} from "./workspaceTasksErrors.js";

const WORKSPACE_TASKS_PLUGIN_ID = "workspace-tasks";
const GLOBAL_TASKS_SETTING = "globalTasks";
const INVALID_GLOBAL_CATALOG_MESSAGE = "Global workspace tasks configuration is invalid.";
const INVALID_GLOBAL_CATALOG_HINT = "Repair the global workspace task catalog, then refresh.";

export interface WorkspaceTasksGlobalCatalogAdapter {
  read(): Promise<GlobalWorkspaceTasksResponse>;
  replace(
    input: ReplaceGlobalWorkspaceTasksRequest,
    options?: WorkspaceTasksCatalogWriteOptions,
  ): Promise<GlobalWorkspaceTasksResponse>;
}

export interface WorkspaceTasksGlobalCatalogAdapterOptions {
  coordinator: PiWebUiConfigMutationCoordinator;
  authorizer: WorkspaceTasksMutationAuthorizer;
}

interface LoadedGlobalCatalog {
  config: WorkspaceTasksConfig;
  canonical: string;
  revision: string;
}

type GlobalCatalogProjection =
  | { kind: "loaded"; value: LoadedGlobalCatalog }
  | { kind: "invalid"; detail: string };

/**
 * Coordinates every machine-global task read and replace through the shared
 * config mutation authority. It only owns the globalTasks projection; all
 * other config values are copied through untouched.
 */
export function createWorkspaceTasksGlobalCatalogAdapter(
  options: WorkspaceTasksGlobalCatalogAdapterOptions,
): WorkspaceTasksGlobalCatalogAdapter {
  const { coordinator, authorizer } = options;

  return {
    async read(): Promise<GlobalWorkspaceTasksResponse> {
      try {
        return responseFromProjection(projectGlobalCatalog((await coordinator.read()).loaded.config));
      } catch {
        throw new WorkspaceTasksUnavailableError();
      }
    },

    async replace(
      input: ReplaceGlobalWorkspaceTasksRequest,
      writeOptions?: WorkspaceTasksCatalogWriteOptions,
    ): Promise<GlobalWorkspaceTasksResponse> {
      const proposed = canonicalizeCatalog(input.config);
      await authorizer.reconcileGlobalMoveClaim({ scope: "global" }, writeOptions?.permit);

      let current: LoadedGlobalCatalog | undefined;
      let intent: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }> | undefined;
      let authorizationError: unknown;
      const publication = { attempted: false, saved: false };

      try {
        const committed = await coordinator.mutate((before) => {
          const projected = projectGlobalCatalog(before.loaded.config);
          if (projected.kind === "invalid") throw new WorkspaceTasksInvalidCatalogError(projected.detail);
          current = projected.value;
          if (input.expectedRevision !== current.revision) throw new WorkspaceTasksRevisionConflictError();

          intent = {
            scope: "global",
            expectedRevision: input.expectedRevision,
            config: proposed.config,
          };
          return replaceGlobalCatalog(before.loaded.config, proposed.config);
        }, {
          shouldSave: () => {
            if (current === undefined || intent === undefined) {
              throw new Error("Global workspace task mutation did not establish a catalog intent");
            }
            if (current.canonical === proposed.canonical) return false;
            try {
              authorizer.assertGlobalMutationAllowed(intent, writeOptions?.permit);
            } catch (error) {
              authorizationError = error;
              throw error;
            }
            return true;
          },
          onPublicationAttempt: () => {
            publication.attempted = true;
          },
          onSaved: () => {
            publication.saved = true;
            invokeNonThrowing(writeOptions?.onWriteAcknowledged);
          },
        });
        const response = responseFromProjection(projectGlobalCatalog(committed.loaded.config));
        if (response.kind === "invalid") throw new WorkspaceTasksInvalidCatalogError(response.detail);
        return response;
      } catch (error) {
        if (error === authorizationError) throw error;
        if (error instanceof WorkspaceTasksInvalidCatalogError || error instanceof WorkspaceTasksRevisionConflictError) {
          throw error;
        }
        if (publication.attempted && !publication.saved) {
          invokeNonThrowing(writeOptions?.onWriteOutcomeUnknown);
          throw new WorkspaceTasksUnknownOutcomeError();
        }
        throw new WorkspaceTasksUnavailableError();
      }
    },
  };
}

function responseFromProjection(projection: GlobalCatalogProjection): GlobalWorkspaceTasksResponse {
  if (projection.kind === "invalid") {
    return {
      kind: "invalid",
      message: INVALID_GLOBAL_CATALOG_MESSAGE,
      hint: INVALID_GLOBAL_CATALOG_HINT,
      detail: projection.detail,
    };
  }
  return {
    kind: "loaded",
    config: projection.value.config,
    revision: projection.value.revision,
  };
}

function projectGlobalCatalog(config: PiWebUiConfigValues): GlobalCatalogProjection {
  const raw = config.plugins?.[WORKSPACE_TASKS_PLUGIN_ID]?.settings?.[GLOBAL_TASKS_SETTING];
  const parsed = parseWorkspaceTasksConfig(raw === undefined ? emptyCatalog() : raw);
  if (!parsed.ok) return { kind: "invalid", detail: parsed.error };
  try {
    assertWorkspaceTasksCatalogSize(parsed.config);
  } catch (error) {
    return { kind: "invalid", detail: errorMessage(error) };
  }
  return { kind: "loaded", value: loadedCatalog(parsed.config) };
}

function canonicalizeCatalog(value: WorkspaceTasksConfig): LoadedGlobalCatalog {
  const parsed = parseWorkspaceTasksConfig(value);
  if (!parsed.ok) throw new WorkspaceTasksInvalidCatalogError(parsed.error);
  try {
    assertWorkspaceTasksCatalogSize(parsed.config);
  } catch (error) {
    throw new WorkspaceTasksInvalidCatalogError(errorMessage(error));
  }
  return loadedCatalog(parsed.config);
}

function loadedCatalog(config: WorkspaceTasksConfig): LoadedGlobalCatalog {
  const canonical = serializeWorkspaceTasksConfig(config);
  return {
    config,
    canonical,
    revision: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

function replaceGlobalCatalog(config: PiWebUiConfigValues, globalTasks: WorkspaceTasksConfig): PiWebUiConfigValues {
  const plugins = config.plugins ?? {};
  const currentPlugin = plugins[WORKSPACE_TASKS_PLUGIN_ID];
  const currentSettings = currentPlugin?.settings;
  return {
    ...config,
    plugins: {
      ...plugins,
      [WORKSPACE_TASKS_PLUGIN_ID]: {
        ...(currentPlugin ?? {}),
        settings: {
          ...(currentSettings ?? {}),
          [GLOBAL_TASKS_SETTING]: globalTasks,
        },
      },
    },
  };
}

function emptyCatalog(): WorkspaceTasksConfig {
  return { version: 1, tasks: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invokeNonThrowing(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Move-state callbacks observe persistence and never alter its outcome.
  }
}
