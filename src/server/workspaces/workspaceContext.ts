import type { ProjectService } from "../projects/projectService.js";
import type { Project, Workspace } from "../types.js";
import type { WorkspaceService } from "./workspaceService.js";

export interface WorkspaceContext {
  project: Project;
  workspace: Workspace;
  root: string;
}

export async function resolveWorkspaceContext(projects: ProjectService, workspaces: WorkspaceService, projectId: string, workspaceId: string): Promise<WorkspaceContext> {
  const project = await projects.requireProject(projectId);
  const workspace = (await workspaces.list(project)).find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  return { project, workspace, root: workspace.path };
}
