import { api as defaultApi } from "../api";
import type { Project } from "../api";
import { selectedMachineId, type GetState, type SetState } from "./types";
import type { WorkspaceController } from "./workspaceController";

const DEFAULT_PROJECT_PATH = "~/workspace";

export interface ProjectControllerDependencies {
  api?: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "pinProject" | "unpinProject">;
  onProjectsApplied?: (machineId: string) => void;
}

export class ProjectController {
  private readonly api: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "pinProject" | "unpinProject">;
  private readonly onProjectsApplied: ((machineId: string) => void) | undefined;
  private projectCatalogGeneration = 0;
  private readonly pinMutationQueueByMachine = new Map<string, Promise<void>>();
  private readonly latestPinMutationOrderByMachine = new Map<string, number>();

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
    const generation = ++this.projectCatalogGeneration;
    this.setState({ error: "", isLoadingProjects: true });
    try {
      let projects = await this.api.projects(machineId);
      if (!this.isCurrentProjectCatalog(machineId, generation)) return;
      let defaultProject: typeof projects[number] | undefined;
      if (projects.length === 0) {
        defaultProject = await this.api.addProject(DEFAULT_PROJECT_PATH, undefined, true, machineId);
        if (!this.isCurrentProjectCatalog(machineId, generation)) return;
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
      if (this.isCurrentProjectCatalog(machineId, generation)) this.setState({ error: String(error) });
    } finally {
      if (this.isCurrentProjectCatalog(machineId, generation)) this.setState({ isLoadingProjects: false });
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

  async pinProject(projectId: string): Promise<void> {
    await this.applyPinChange(projectId, (machineId) => this.api.pinProject(projectId, machineId));
  }

  async unpinProject(projectId: string): Promise<void> {
    await this.applyPinChange(projectId, (machineId) => this.api.unpinProject(projectId, machineId));
  }

  /**
   * The server owns project order, so the whole returned list replaces state.
   * `onProjectsApplied` is deliberately not called: the project set is
   * unchanged, so activity ownership does not need to re-resolve.
   */
  private async applyPinChange(projectId: string, mutate: (machineId: string) => Promise<Project[]>): Promise<void> {
    const machineId = selectedMachineId(this.getState());
    const generation = this.projectCatalogGeneration;
    const mutationOrder = (this.latestPinMutationOrderByMachine.get(machineId) ?? 0) + 1;
    this.latestPinMutationOrderByMachine.set(machineId, mutationOrder);
    const previous = this.pinMutationQueueByMachine.get(machineId);
    const operation = previous === undefined
      ? this.runPinChange(machineId, generation, mutationOrder, mutate)
      : previous.catch(() => undefined).then(async () => {
        await this.runPinChange(machineId, generation, mutationOrder, mutate);
      });
    this.pinMutationQueueByMachine.set(machineId, operation);

    try {
      await operation;
    } finally {
      this.cleanupPinMutationQueue(machineId, mutationOrder, operation);
    }
  }

  private async runPinChange(
    machineId: string,
    generation: number,
    mutationOrder: number,
    mutate: (machineId: string) => Promise<Project[]>,
  ): Promise<void> {
    try {
      const projects = await mutate(machineId);
      if (!this.isLatestPinMutation(machineId, mutationOrder)) return;
      if (this.isCurrentProjectCatalog(machineId, generation)) {
        this.setState({ projects });
      } else if (selectedMachineId(this.getState()) === machineId) {
        await this.loadProjects();
      }
    } catch (error) {
      if (this.isCurrentPinMutation(machineId, generation, mutationOrder)) this.setState({ error: String(error) });
    }
  }

  private isCurrentProjectCatalog(machineId: string, generation: number): boolean {
    return selectedMachineId(this.getState()) === machineId && this.projectCatalogGeneration === generation;
  }

  private isLatestPinMutation(machineId: string, mutationOrder: number): boolean {
    return this.latestPinMutationOrderByMachine.get(machineId) === mutationOrder;
  }

  private isCurrentPinMutation(machineId: string, generation: number, mutationOrder: number): boolean {
    return this.isCurrentProjectCatalog(machineId, generation) && this.isLatestPinMutation(machineId, mutationOrder);
  }

  private cleanupPinMutationQueue(machineId: string, mutationOrder: number, operation: Promise<void>): void {
    if (this.pinMutationQueueByMachine.get(machineId) !== operation) return;
    this.pinMutationQueueByMachine.delete(machineId);
    if (this.latestPinMutationOrderByMachine.get(machineId) === mutationOrder) {
      this.latestPinMutationOrderByMachine.delete(machineId);
    }
  }
}
