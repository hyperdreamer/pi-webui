import type { PiWebUiConfigMutationCoordinator } from "../../configMutationCoordinator.js";
import type { ProjectService } from "../projects/projectService.js";
import { createWorkspaceTasksCatalogService, type WorkspaceTasksCatalogService } from "./workspaceTasksCatalogService.js";
import {
  createWorkspaceTasksGlobalCatalogAdapter,
  type WorkspaceTasksGlobalCatalogAdapter,
} from "./workspaceTasksGlobalCatalogAdapter.js";
import {
  MachineGlobalTasksMoveRegistry,
  type WorkspaceTasksWorkspaceMutationCoordinator,
} from "./workspaceTasksMoveRegistry.js";
import {
  createWorkspaceTasksWorkspaceCatalogAdapter,
  type WorkspaceTasksWorkspaceCatalogAdapter,
} from "./workspaceTasksWorkspaceCatalogAdapter.js";
import {
  createWorkspaceTasksWorkspaceFileResolver,
  type WorkspaceTasksWorkspaceFileResolver,
} from "./workspaceTasksWorkspaceFile.js";
import type {
  WorkspaceTasksMoveObservationPort,
  WorkspaceTasksMutationAuthorizer,
} from "./workspaceTasksErrors.js";
import type { WorkspaceService } from "../workspaces/workspaceService.js";

export interface WorkspaceTasksCompositionDependencies {
  configMutationCoordinator: PiWebUiConfigMutationCoordinator;
  projects: ProjectService;
  workspaces: WorkspaceService;
  factories?: Partial<WorkspaceTasksCompositionFactories>;
}

export interface WorkspaceTasksCompositionFactories {
  createRegistry(input: { observe: WorkspaceTasksMoveObservationPort }): MachineGlobalTasksMoveRegistry;
  createGlobalAdapter(input: {
    coordinator: PiWebUiConfigMutationCoordinator;
    authorizer: WorkspaceTasksMutationAuthorizer;
  }): WorkspaceTasksGlobalCatalogAdapter;
  createWorkspaceFileResolver(input: {
    projects: ProjectService;
    workspaces: WorkspaceService;
  }): WorkspaceTasksWorkspaceFileResolver;
  createWorkspaceAdapter(input: {
    projects: ProjectService;
    workspaces: WorkspaceService;
    files: WorkspaceTasksWorkspaceFileResolver;
    authorizer: WorkspaceTasksMutationAuthorizer;
    workspaceMutations: WorkspaceTasksWorkspaceMutationCoordinator;
  }): WorkspaceTasksWorkspaceCatalogAdapter;
}

export interface WorkspaceTasksComposition {
  service: WorkspaceTasksCatalogService;
  registry: MachineGlobalTasksMoveRegistry;
  workspaceMutations: WorkspaceTasksWorkspaceMutationCoordinator;
  workspaceFiles: WorkspaceTasksWorkspaceFileResolver;
  globalAdapter: WorkspaceTasksGlobalCatalogAdapter;
  workspaceAdapter: WorkspaceTasksWorkspaceCatalogAdapter;
}

export function createWorkspaceTasksComposition(
  deps: WorkspaceTasksCompositionDependencies,
): WorkspaceTasksComposition {
  const factories = deps.factories ?? {};
  // These references must exist before registry creation; its observer is called only after both assignments.
  // eslint-disable-next-line prefer-const
  let globalAdapter: WorkspaceTasksGlobalCatalogAdapter | undefined;
  // eslint-disable-next-line prefer-const
  let workspaceAdapter: WorkspaceTasksWorkspaceCatalogAdapter | undefined;

  const observationPort: WorkspaceTasksMoveObservationPort = {
    async observe(address) {
      if (globalAdapter === undefined || workspaceAdapter === undefined) {
        throw new Error("Workspace Tasks composition observers cannot run before adapter assignment");
      }
      const workspace = await workspaceAdapter.read(address);
      const global = await globalAdapter.read();
      return { workspace, global };
    },
  };

  const registry = factories.createRegistry?.({ observe: observationPort })
    ?? new MachineGlobalTasksMoveRegistry(observationPort);
  const workspaceFiles = factories.createWorkspaceFileResolver?.({
    projects: deps.projects,
    workspaces: deps.workspaces,
  }) ?? createWorkspaceTasksWorkspaceFileResolver({
    projects: deps.projects,
    workspaces: deps.workspaces,
  });
  const workspaceMutations: WorkspaceTasksWorkspaceMutationCoordinator = registry;

  globalAdapter = factories.createGlobalAdapter?.({
    coordinator: deps.configMutationCoordinator,
    authorizer: registry,
  }) ?? createWorkspaceTasksGlobalCatalogAdapter({
    coordinator: deps.configMutationCoordinator,
    authorizer: registry,
  });
  workspaceAdapter = factories.createWorkspaceAdapter?.({
    projects: deps.projects,
    workspaces: deps.workspaces,
    files: workspaceFiles,
    authorizer: registry,
    workspaceMutations,
  }) ?? createWorkspaceTasksWorkspaceCatalogAdapter({
    projects: deps.projects,
    workspaces: deps.workspaces,
    files: workspaceFiles,
    authorizer: registry,
    workspaceMutations,
  });

  const service = createWorkspaceTasksCatalogService({
    globalAdapter,
    workspaceAdapter,
    registry,
  });
  return {
    service,
    registry,
    workspaceMutations,
    workspaceFiles,
    globalAdapter,
    workspaceAdapter,
  };
}
