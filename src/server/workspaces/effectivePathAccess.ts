import type { PiWebUiPathAccessConfig } from "../../shared/apiTypes.js";
import type { PiWebUiConfigService } from "../configRoutes.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceContext } from "./workspaceContext.js";
import type { WorkspaceService } from "./workspaceService.js";
import { cwdPathsEqual } from "../workingDirectory.js";
import { loadEffectiveProjectPathAccess } from "./projectPiWebUiConfig.js";

export async function pathAccessForWorkspaceContext(context: WorkspaceContext, config: Pick<PiWebUiConfigService, "read"> | undefined): Promise<PiWebUiPathAccessConfig | undefined> {
  if (config === undefined) return undefined;
  const response = await config.read();
  return loadEffectiveProjectPathAccess(context.project.path, response.effectiveConfig);
}

export async function pathAccessForCwd(cwd: string, projects: ProjectService, workspaces: WorkspaceService, config: Pick<PiWebUiConfigService, "read"> | undefined): Promise<PiWebUiPathAccessConfig | undefined> {
  if (config === undefined) return undefined;
  const response = await config.read();
  const projectPath = await projectPathForWorkspaceCwd(cwd, projects, workspaces);
  if (projectPath === undefined) return response.effectiveConfig.pathAccess;
  return loadEffectiveProjectPathAccess(projectPath, response.effectiveConfig);
}

async function projectPathForWorkspaceCwd(cwd: string, projects: ProjectService, workspaces: WorkspaceService): Promise<string | undefined> {
  for (const project of await projects.list()) {
    if (cwdPathsEqual(project.path, cwd)) return project.path;
    if ((await workspaces.list(project)).some((workspace) => cwdPathsEqual(workspace.path, cwd))) return project.path;
  }
  return undefined;
}
