import { api as defaultApi } from "../api";
import { selectedMachineId, type GetState, type SetState } from "./types";
import type { WorkspaceController } from "./workspaceController";

const DEFAULT_PROJECT_PATH = "~/workspace";

export interface ProjectControllerDependencies {
  api?: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject">;
  onProjectsApplied?: (machineId: string) => void;
}

export class ProjectController {
  private readonly api: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject">;
  private readonly onProjectsApplied: ((machineId: string) => void) | undefined;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly workspaces: Pick<WorkspaceController, "selectProject" | "forgetProject" | "clearSelection">,
    deps: ProjectControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
    this.onProjectsApplied = deps.onProjectsApplied;
  }

  async loadProjects() {
    const machineId = selectedMachineId(this.getState());
    this.setState({ error: "", isLoadingProjects: true });
    try {
      let projects = await this.api.projects(machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      let defaultProject: typeof projects[number] | undefined;
      if (projects.length === 0) {
        defaultProject = await this.api.addProject(DEFAULT_PROJECT_PATH, undefined, true, machineId);
        if (selectedMachineId(this.getState()) !== machineId) return;
        projects = [defaultProject];
      }
      const projectIds = new Set(projects.map((project) => project.id));
      const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([projectId]) => projectIds.has(projectId)));
      const selectedProject = this.getState().selectedProject;
      const selectedProjectPathChanged = selectedProject !== undefined
        && projects.some((project) => project.id === selectedProject.id && project.path !== selectedProject.path);
      this.setState({ projects, workspacesByProjectId });
      if (selectedProjectPathChanged) this.workspaces.clearSelection();
      this.onProjectsApplied?.(machineId);
      if (defaultProject !== undefined) await this.workspaces.selectProject(defaultProject);
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    } finally {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ isLoadingProjects: false });
    }
  }

  async addProject(path: string, create?: boolean) {
    if (path.trim() === "") return;
    const machineId = selectedMachineId(this.getState());
    try {
      const project = await this.api.addProject(path.trim(), undefined, create, machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      const projects = this.getState().projects;
      this.setState({ projects: [...projects.filter((p) => p.id !== project.id), project], projectDialogOpen: false });
      this.onProjectsApplied?.(machineId);
      await this.workspaces.selectProject(project);
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    }
  }

  async closeProject(projectId: string) {
    const machineId = selectedMachineId(this.getState());
    try {
      await this.api.closeProject(projectId, machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      this.workspaces.forgetProject(projectId);
      const state = this.getState();
      this.setState({ projects: state.projects.filter((p) => p.id !== projectId) });
      this.onProjectsApplied?.(machineId);
      if (state.selectedProject?.id === projectId) this.workspaces.clearSelection();
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    }
  }
}
