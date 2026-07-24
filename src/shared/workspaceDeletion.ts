export const workspaceDeleteOperation = "workspace.delete";
export const workspaceDeleteOperationMetadataKey = "pi.operation";
export const targetWorkspaceIdMetadataKey = "target.workspaceId";
const targetWorkspacePathMetadataKey = "target.workspacePath";

export interface WorkspaceDeletionTarget {
  id: string;
  path: string;
}

export function workspaceDeletionMetadata(workspace: WorkspaceDeletionTarget): Record<string, string> {
  return {
    [workspaceDeleteOperationMetadataKey]: workspaceDeleteOperation,
    [targetWorkspaceIdMetadataKey]: workspace.id,
    [targetWorkspacePathMetadataKey]: workspace.path,
  };
}
