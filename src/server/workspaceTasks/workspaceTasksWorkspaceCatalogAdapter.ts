import type {
  ReplaceWorkspaceTasksRequest,
  WorkspaceCatalogAddress,
  WorkspaceTasksCatalogResponse,
} from "../../shared/apiTypes.js";
import {
  TASKS_CONFIG_PATH,
  assertWorkspaceTasksCatalogSize,
  parseWorkspaceTasksConfig,
  parseWorkspaceTasksConfigText,
  serializeWorkspaceTasksConfig,
  type WorkspaceTasksConfig,
} from "../../shared/workspaceTasks.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceService } from "../workspaces/workspaceService.js";
import { resolveWorkspaceContext } from "../workspaces/workspaceContext.js";
import {
  WorkspaceTasksInvalidCatalogError,
  WorkspaceTasksRevisionConflictError,
  WorkspaceTasksUnavailableError,
  WorkspaceTasksUnknownOutcomeError,
  type WorkspaceTasksCatalogWriteOptions,
  type WorkspaceTasksMoveWriteIntent,
  type WorkspaceTasksMutationAuthorizer,
} from "./workspaceTasksErrors.js";
import {
  type WorkspaceTasksWorkspaceFilePublicationHooks,
  type WorkspaceTasksWorkspaceFileRead,
  type WorkspaceTasksWorkspaceFileResolver,
} from "./workspaceTasksWorkspaceFile.js";

export type {
  WorkspaceTasksNormalizedFileMove,
  WorkspaceTasksWorkspaceFilePublicationHooks,
  WorkspaceTasksWorkspaceFileRead,
  WorkspaceTasksWorkspaceFileResolver,
} from "./workspaceTasksWorkspaceFile.js";

export interface WorkspaceTasksWorkspaceMutationCoordinator {
  run<T>(address: WorkspaceCatalogAddress, operation: () => Promise<T>): Promise<T>;
}

export interface WorkspaceTasksWorkspaceCatalogAdapter {
  read(address: WorkspaceCatalogAddress): Promise<WorkspaceTasksCatalogResponse>;
  replace(
    address: WorkspaceCatalogAddress,
    input: ReplaceWorkspaceTasksRequest,
    options?: WorkspaceTasksCatalogWriteOptions,
  ): Promise<WorkspaceTasksCatalogResponse>;
}

export interface WorkspaceTasksWorkspaceCatalogAdapterOptions {
  files: WorkspaceTasksWorkspaceFileResolver;
  authorizer: WorkspaceTasksMutationAuthorizer;
  workspaceMutations: WorkspaceTasksWorkspaceMutationCoordinator;
  /** Optional identity validation for compositions that already own services. */
  projects?: ProjectService;
  workspaces?: WorkspaceService;
}

interface LoadedWorkspaceCatalog {
  kind: "loaded";
  config: WorkspaceTasksConfig;
  canonical: string;
  bytes: Buffer;
  revision: string;
}

type WorkspaceCatalogProjection =
  | LoadedWorkspaceCatalog
  | { kind: "missing"; revision: string }
  | { kind: "invalid"; detail: string };

const MISSING_MESSAGE = "No workspace tasks configured here.";
const MISSING_HINT = `${TASKS_CONFIG_PATH} is optional. Create it in this workspace if you want custom tasks.`;
const INVALID_MESSAGE = "Workspace tasks configuration is invalid.";
const INVALID_HINT = `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`;
const UNAVAILABLE_MESSAGE = "Could not load workspace tasks.";
const UNAVAILABLE_HINT = `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`;

export function createWorkspaceTasksWorkspaceCatalogAdapter(
  options: WorkspaceTasksWorkspaceCatalogAdapterOptions,
): WorkspaceTasksWorkspaceCatalogAdapter {
  const { files, authorizer, workspaceMutations } = options;

  return {
    async read(address): Promise<WorkspaceTasksCatalogResponse> {
      try {
        await validateAddress(address);
        return responseFromProjection(await readProjection(address));
      } catch {
        return unavailableResponse();
      }
    },

    async replace(address, input, writeOptions): Promise<WorkspaceTasksCatalogResponse> {
      await validateAddress(address);
      await authorizer.reconcileGlobalMoveClaim({ scope: "workspace", address }, writeOptions?.permit);

      let authorizationError: unknown;
      const publication = { attempted: false, acknowledged: false };
      try {
        return await workspaceMutations.run(address, async () => {
          const current = await readProjection(address);
          if (current.kind === "invalid") throw new WorkspaceTasksInvalidCatalogError(current.detail);
          if (input.expectedRevision !== current.revision) throw new WorkspaceTasksRevisionConflictError();

          const proposed = canonicalizeCatalog(input.config);
          if (current.kind === "loaded" && current.canonical === proposed.canonical) {
            return responseFromProjection(current);
          }

          const intent: Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }> = {
            scope: "workspace",
            address,
            expectedRevision: input.expectedRevision,
            config: proposed.config,
          };
          try {
            authorizer.assertWorkspaceMutationAllowed(address, intent, writeOptions?.permit);
          } catch (error) {
            authorizationError = error;
            throw error;
          }

          const hooks: WorkspaceTasksWorkspaceFilePublicationHooks = {
            onPublicationAttempt: () => {
              publication.attempted = true;
            },
            onPublished: () => {
              publication.acknowledged = true;
              invokeNonThrowing(writeOptions?.onWriteAcknowledged);
            },
          };
          await files.publishCatalog(address, Buffer.from(proposed.canonical, "utf8"), hooks);

          const verified = await readProjection(address);
          if (verified.kind !== "loaded" || !verified.bytes.equals(Buffer.from(proposed.canonical, "utf8"))) {
            throw new WorkspaceTasksUnknownOutcomeError();
          }
          return responseFromProjection(verified);
        });
      } catch (error) {
        if (error === authorizationError) throw error;
        if (error instanceof WorkspaceTasksInvalidCatalogError
          || error instanceof WorkspaceTasksRevisionConflictError
          || error instanceof WorkspaceTasksUnknownOutcomeError) {
          if (error instanceof WorkspaceTasksUnknownOutcomeError) {
            invokeNonThrowing(writeOptions?.onWriteOutcomeUnknown);
          }
          throw error;
        }
        if (publication.attempted) {
          invokeNonThrowing(writeOptions?.onWriteOutcomeUnknown);
          throw new WorkspaceTasksUnknownOutcomeError();
        }
        throw new WorkspaceTasksUnavailableError();
      }
    },
  };

  async function validateAddress(address: WorkspaceCatalogAddress): Promise<void> {
    if (options.projects === undefined || options.workspaces === undefined) return;
    // The file resolver repeats this check before touching the fixed path. The
    // adapter check keeps route identity failures outside the mutation queue.
    await resolveWorkspaceContext(options.projects, options.workspaces, address.projectId, address.workspaceId);
  }

  async function readProjection(address: WorkspaceCatalogAddress): Promise<WorkspaceCatalogProjection> {
    let source: WorkspaceTasksWorkspaceFileRead;
    try {
      source = await files.readCatalog(address);
    } catch {
      throw new WorkspaceTasksUnavailableError();
    }
    if (source.kind === "missing") return source;
    if (source.bytes.includes(0)) throw new WorkspaceTasksUnavailableError();

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    } catch {
      throw new WorkspaceTasksUnavailableError();
    }
    const parsed = parseWorkspaceTasksConfigText(text);
    if (!parsed.ok) return { kind: "invalid", detail: parsed.error };
    try {
      assertWorkspaceTasksCatalogSize(parsed.config);
    } catch (error) {
      return { kind: "invalid", detail: errorMessage(error) };
    }
    return {
      kind: "loaded",
      config: parsed.config,
      canonical: serializeWorkspaceTasksConfig(parsed.config),
      bytes: source.bytes,
      revision: source.revision,
    };
  }

  function canonicalizeCatalog(value: WorkspaceTasksConfig): { config: WorkspaceTasksConfig; canonical: string } {
    const parsed = parseWorkspaceTasksConfig(value);
    if (!parsed.ok) throw new WorkspaceTasksInvalidCatalogError(parsed.error);
    try {
      assertWorkspaceTasksCatalogSize(parsed.config);
    } catch (error) {
      throw new WorkspaceTasksInvalidCatalogError(errorMessage(error));
    }
    return { config: parsed.config, canonical: serializeWorkspaceTasksConfig(parsed.config) };
  }
}

function responseFromProjection(projection: WorkspaceCatalogProjection): WorkspaceTasksCatalogResponse {
  if (projection.kind === "missing") {
    return { kind: "missing", message: MISSING_MESSAGE, hint: MISSING_HINT, revision: projection.revision };
  }
  if (projection.kind === "invalid") {
    return { kind: "invalid", message: INVALID_MESSAGE, hint: INVALID_HINT, detail: projection.detail };
  }
  return { kind: "loaded", config: projection.config, revision: projection.revision };
}

function unavailableResponse(): WorkspaceTasksCatalogResponse {
  return { kind: "unavailable", message: UNAVAILABLE_MESSAGE, hint: UNAVAILABLE_HINT };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invokeNonThrowing(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Lifecycle observers must not change the persistence outcome.
  }
}
