import { createHash } from "node:crypto";
import type {
  GlobalWorkspaceTasksResponse,
  ReplaceGlobalWorkspaceTasksRequest,
  ReplaceWorkspaceTasksRequest,
  WorkspaceCatalogAddress,
  WorkspaceTasksCatalogResponse,
} from "../../shared/apiTypes.js";
import { serializeWorkspaceTasksConfig, type WorkspaceTask, type WorkspaceTasksConfig } from "../../shared/workspaceTasks.js";
import type { PiWebUiConfigMutationCoordinator } from "../../configMutationCoordinator.js";
import type {
  WorkspaceTasksCatalogWriteOptions,
  WorkspaceTasksMutationAuthorizer,
  WorkspaceTasksMoveWriteIntent,
} from "./workspaceTasksErrors.js";
import type { WorkspaceTasksGlobalCatalogAdapter } from "./workspaceTasksGlobalCatalogAdapter.js";
import type {
  WorkspaceTasksWorkspaceCatalogAdapter,
  WorkspaceTasksWorkspaceFilePublicationHooks,
  WorkspaceTasksWorkspaceFileRead,
  WorkspaceTasksWorkspaceFileResolver,
  WorkspaceTasksWorkspaceMutationCoordinator,
} from "./workspaceTasksWorkspaceCatalogAdapter.js";

export const TEST_ADDRESS: WorkspaceCatalogAddress = { projectId: "project", workspaceId: "workspace" };

export class ControlledGlobalCatalogAdapter implements WorkspaceTasksGlobalCatalogAdapter {
  response: GlobalWorkspaceTasksResponse = loadedGlobal(emptyCatalog());
  readFailure: Error | undefined;
  writeFailure: ControlledWriteFailure | undefined;
  readonly replaceCalls: ReplaceGlobalWorkspaceTasksRequest[] = [];
  readonly writeOptions: WorkspaceTasksCatalogWriteOptions[] = [];
  readonly intents: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>[] = [];
  writes = 0;
  authorizer: WorkspaceTasksMutationAuthorizer | undefined;

  read(): Promise<GlobalWorkspaceTasksResponse> {
    if (this.readFailure !== undefined) return Promise.reject(this.readFailure);
    return Promise.resolve(this.response);
  }

  async replace(
    input: ReplaceGlobalWorkspaceTasksRequest,
    options: WorkspaceTasksCatalogWriteOptions = {},
  ): Promise<GlobalWorkspaceTasksResponse> {
    this.replaceCalls.push(input);
    this.writeOptions.push(options);
    await this.authorizer?.reconcileGlobalMoveClaim({ scope: "global" }, options.permit);
    if (this.response.kind === "invalid") throw new Error("invalid global catalog");
    if (this.response.revision !== input.expectedRevision) throw new Error("revision conflict");
    const intent = { scope: "global" as const, expectedRevision: input.expectedRevision, config: input.config };
    this.intents.push(intent);
    this.authorizer?.assertGlobalMutationAllowed(intent, options.permit);
    if (serializeWorkspaceTasksConfig(this.response.config) === serializeWorkspaceTasksConfig(input.config)) {
      return this.response;
    }

    if (this.writeFailure?.phase === "before-publication") throw this.writeFailure.error;
    this.writes += 1;
    const published = this.writeFailure?.published !== false;
    if (published) this.response = loadedGlobal(input.config);
    options.onWriteAcknowledged?.();
    if (this.writeFailure?.phase === "after-acknowledged") throw this.writeFailure.error;
    if (this.writeFailure?.phase === "unknown") {
      options.onWriteOutcomeUnknown?.();
      throw this.writeFailure.error;
    }
    return this.response;
  }
}

export class ControlledWorkspaceCatalogAdapter implements WorkspaceTasksWorkspaceCatalogAdapter {
  response: WorkspaceTasksCatalogResponse = missingWorkspace("workspace-missing");
  readFailure: Error | undefined;
  writeFailure: ControlledWriteFailure | undefined;
  readonly replaceCalls: { address: WorkspaceCatalogAddress; input: ReplaceWorkspaceTasksRequest }[] = [];
  readonly writeOptions: WorkspaceTasksCatalogWriteOptions[] = [];
  readonly intents: Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }>[] = [];
  writes = 0;
  authorizer: WorkspaceTasksMutationAuthorizer | undefined;
  workspaceMutations: WorkspaceTasksWorkspaceMutationCoordinator | undefined;

  read(): Promise<WorkspaceTasksCatalogResponse> {
    if (this.readFailure !== undefined) return Promise.reject(this.readFailure);
    return Promise.resolve(this.response);
  }

  async replace(
    address: WorkspaceCatalogAddress,
    input: ReplaceWorkspaceTasksRequest,
    options: WorkspaceTasksCatalogWriteOptions = {},
  ): Promise<WorkspaceTasksCatalogResponse> {
    this.replaceCalls.push({ address, input });
    this.writeOptions.push(options);
    await this.authorizer?.reconcileGlobalMoveClaim({ scope: "workspace", address }, options.permit);
    if (this.response.kind === "invalid" || this.response.kind === "unavailable") {
      throw new Error("workspace catalog is not writable");
    }
    if (this.response.revision !== input.expectedRevision) throw new Error("revision conflict");
    const intent = { scope: "workspace" as const, address, expectedRevision: input.expectedRevision, config: input.config };
    this.intents.push(intent);
    this.authorizer?.assertWorkspaceMutationAllowed(address, intent, options.permit);
    if (this.response.kind === "loaded"
      && serializeWorkspaceTasksConfig(this.response.config) === serializeWorkspaceTasksConfig(input.config)) {
      return this.response;
    }

    if (this.writeFailure?.phase === "before-publication") throw this.writeFailure.error;
    this.writes += 1;
    const published = this.writeFailure?.published !== false;
    if (published) this.response = loadedWorkspace(input.config);
    options.onWriteAcknowledged?.();
    if (this.writeFailure?.phase === "after-acknowledged") throw this.writeFailure.error;
    if (this.writeFailure?.phase === "unknown") {
      options.onWriteOutcomeUnknown?.();
      throw this.writeFailure.error;
    }
    return this.response;
  }
}

export interface ControlledWriteFailure {
  phase: "before-publication" | "after-acknowledged" | "unknown";
  published?: boolean;
  error: Error;
}

export class ControlledWorkspaceFileResolver implements WorkspaceTasksWorkspaceFileResolver {
  readonly entries = new Map<string, WorkspaceTasksWorkspaceFileRead>();

  readCatalog(address: WorkspaceCatalogAddress): Promise<WorkspaceTasksWorkspaceFileRead> {
    return Promise.resolve(this.entries.get(addressKey(address)) ?? { kind: "missing", revision: "missing" });
  }

  publishCatalog(
    address: WorkspaceCatalogAddress,
    bytes: Uint8Array,
    hooks?: WorkspaceTasksWorkspaceFilePublicationHooks,
  ): Promise<void> {
    void address;
    void bytes;
    void hooks;
    throw new Error("controlled composition does not publish through the file resolver");
  }

  writeExplorerTaskFile(): never {
    throw new Error("not used");
  }

  deleteExplorerTaskFile(): never {
    throw new Error("not used");
  }

  moveExplorerTaskFile(): never {
    throw new Error("not used");
  }
}

export class ControlledConfigCoordinator implements PiWebUiConfigMutationCoordinator {
  read(): never {
    throw new Error("controlled composition does not use the config coordinator");
  }

  mutate(): never {
    throw new Error("controlled composition does not use the config coordinator");
  }
}

export function task(id: string): WorkspaceTask {
  return { id, title: `${id} task`, command: `npm run ${id}`, confirm: false };
}

export function catalogWithTasks(...ids: string[]): WorkspaceTasksConfig {
  return { version: 1, tasks: ids.map((id) => task(id)) };
}

export function emptyCatalog(): WorkspaceTasksConfig {
  return { version: 1, tasks: [] };
}

export function loadedGlobal(config: WorkspaceTasksConfig): Extract<GlobalWorkspaceTasksResponse, { kind: "loaded" }> {
  return { kind: "loaded", config, revision: globalRevision(config) };
}

export function loadedWorkspace(config: WorkspaceTasksConfig): Extract<WorkspaceTasksCatalogResponse, { kind: "loaded" }> {
  return { kind: "loaded", config, revision: workspaceRevision(config) };
}

export function missingWorkspace(revision = "workspace-missing"): Extract<WorkspaceTasksCatalogResponse, { kind: "missing" }> {
  return { kind: "missing", message: "missing", hint: "missing", revision };
}

export function globalRevision(config: WorkspaceTasksConfig): string {
  return createHash("sha256").update(serializeWorkspaceTasksConfig(config), "utf8").digest("hex");
}

export function workspaceRevision(config: WorkspaceTasksConfig): string {
  const hash = createHash("sha256");
  hash.update("workspace-task-file:present\0", "utf8");
  hash.update(Buffer.from(serializeWorkspaceTasksConfig(config), "utf8"));
  return hash.digest("hex");
}

export function addressKey(address: WorkspaceCatalogAddress): string {
  return JSON.stringify([address.projectId, address.workspaceId]);
}
