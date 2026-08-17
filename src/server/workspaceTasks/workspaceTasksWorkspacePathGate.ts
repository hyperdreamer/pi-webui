import type { WorkspaceCatalogAddress } from "../../shared/apiTypes.js";
import { isWorkspaceTasksPath } from "./workspaceTasksWorkspaceFile.js";
import type { WorkspaceTasksMutationAuthorizer, WorkspaceTasksMoveWriteIntent } from "./workspaceTasksErrors.js";
import type { WorkspaceTasksWorkspaceMutationCoordinator } from "./workspaceTasksWorkspaceCatalogAdapter.js";

const GENERIC_WORKSPACE_EXPECTED_REVISION = "workspace-explorer";
const EMPTY_CATALOG = { version: 1 as const, tasks: [] };

/**
 * Serializes explorer operations that target the fixed workspace task file with
 * the same per-workspace authority used by the task adapter.
 */
export class WorkspaceTasksWorkspacePathGate {
  private readonly workspaceMutations: WorkspaceTasksWorkspaceMutationCoordinator;

  constructor(
    private readonly authorizer: WorkspaceTasksMutationAuthorizer,
    workspaceMutations?: WorkspaceTasksWorkspaceMutationCoordinator,
  ) {
    if (workspaceMutations !== undefined) {
      this.workspaceMutations = workspaceMutations;
    } else if (isWorkspaceMutationCoordinator(authorizer)) {
      this.workspaceMutations = authorizer;
    } else {
      throw new Error("Workspace task path gate requires a workspace mutation coordinator");
    }
  }

  async run<T>(
    address: WorkspaceCatalogAddress,
    normalizedTargets: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!normalizedTargets.some((target) => isWorkspaceTasksPath(target))) return operation();

    await this.authorizer.reconcileGlobalMoveClaim({ scope: "workspace", address });
    return this.workspaceMutations.run(address, async () => {
      this.authorizer.assertWorkspaceMutationAllowed(address, workspaceMutationIntent(address));
      return operation();
    });
  }
}

function workspaceMutationIntent(address: WorkspaceCatalogAddress): Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }> {
  return {
    scope: "workspace",
    address,
    expectedRevision: GENERIC_WORKSPACE_EXPECTED_REVISION,
    config: EMPTY_CATALOG,
  };
}

function isWorkspaceMutationCoordinator(
  value: WorkspaceTasksMutationAuthorizer,
): value is WorkspaceTasksMutationAuthorizer & WorkspaceTasksWorkspaceMutationCoordinator {
  return "run" in value && typeof value.run === "function";
}
