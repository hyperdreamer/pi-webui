import { api as defaultApi } from "../api";
import type { Project } from "../api";
import { selectedMachineId, type GetState, type SetState } from "./types";
import type { WorkspaceController } from "./workspaceController";

const DEFAULT_PROJECT_PATH = "~/workspace";

export interface ProjectControllerDependencies {
  api?: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "closeProjectTree" | "pinProject" | "unpinProject">;
  onProjectsApplied?: (machineId: string) => void;
}

export class ProjectController {
  private readonly api: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "closeProjectTree" | "pinProject" | "unpinProject">;
  private readonly onProjectsApplied: ((machineId: string) => void) | undefined;
  private projectCatalogOperationSequence = 0;
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
    const sequence = ++this.projectCatalogOperationSequence;
    this.setState({ error: "", isLoadingProjects: true });
    try {
      let projects = await this.api.projects(machineId);
      if (!this.isCurrentProjectCatalogOperation(machineId, sequence)) return;
      let defaultProject: typeof projects[number] | undefined;
      if (projects.length === 0) {
        defaultProject = await this.api.addProject(DEFAULT_PROJECT_PATH, undefined, true, machineId);
        if (!this.isCurrentProjectCatalogOperation(machineId, sequence)) return;
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
      if (this.isCurrentProjectCatalogOperation(machineId, sequence)) this.setState({ error: String(error) });
    } finally {
      if (this.isCurrentProjectCatalogOperation(machineId, sequence)) this.setState({ isLoadingProjects: false });
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

  /**
   * Close a project family. The response is authoritative: the catalog may have
   * changed since the confirmation dialog rendered, so reconcile against the
   * ids the server actually removed rather than a locally computed subtree.
   *
   * The close participates in the catalog-operation ordering: it supersedes any
   * in-flight load or pin mutation (and clears the loading state they owned), so
   * an older response can no longer republish the pre-close catalog. When the
   * close response is itself superseded, fall back to a fresh load, which is
   * guaranteed to reflect the completed close on the server.
   */
  async closeProjectTree(projectId: string): Promise<void> {
    const machineId = selectedMachineId(this.getState());
    const sequence = ++this.projectCatalogOperationSequence;
    // The close supersedes any in-flight load, so its finalizer no longer clears loading.
    this.setState({ isLoadingProjects: false });
    try {
      const { closedProjectIds } = await this.api.closeProjectTree(projectId, machineId);
      if (!this.isCurrentProjectCatalogOperation(machineId, sequence)) {
        if (selectedMachineId(this.getState()) === machineId) await this.loadProjects();
        return;
      }
      for (const closedProjectId of closedProjectIds) this.workspaces.forgetProject(closedProjectId);
      const state = this.getState();
      const closedIdSet = new Set(closedProjectIds);
      this.setState({ projects: state.projects.filter((project) => !closedIdSet.has(project.id)) });
      this.onProjectsApplied?.(machineId);
      if (state.selectedProject !== undefined && closedIdSet.has(state.selectedProject.id)) this.workspaces.clearSelection();
    } catch (error) {
      if (this.isCurrentProjectCatalogOperation(machineId, sequence)) this.setState({ error: String(error) });
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
    const sequence = ++this.projectCatalogOperationSequence;
    // The intent supersedes any in-flight load, so its finalizer no longer clears loading.
    this.setState({ isLoadingProjects: false });
    const mutationOrder = (this.latestPinMutationOrderByMachine.get(machineId) ?? 0) + 1;
    this.latestPinMutationOrderByMachine.set(machineId, mutationOrder);
    const previous = this.pinMutationQueueByMachine.get(machineId);
    const operation = previous === undefined
      ? this.runPinChange(machineId, sequence, mutationOrder, mutate)
      : previous.catch(() => undefined).then(async () => {
        await this.runPinChange(machineId, sequence, mutationOrder, mutate);
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
    sequence: number,
    mutationOrder: number,
    mutate: (machineId: string) => Promise<Project[]>,
  ): Promise<void> {
    try {
      const projects = await mutate(machineId);
      if (!this.isLatestPinMutation(machineId, mutationOrder)) return;
      if (this.isCurrentProjectCatalogOperation(machineId, sequence)) {
        this.setState({ projects });
      } else if (selectedMachineId(this.getState()) === machineId) {
        await this.loadProjects();
      }
    } catch (error) {
      if (this.isCurrentPinMutation(machineId, sequence, mutationOrder)) this.setState({ error: String(error) });
    }
  }

  private isCurrentProjectCatalogOperation(machineId: string, sequence: number): boolean {
    return selectedMachineId(this.getState()) === machineId && this.projectCatalogOperationSequence === sequence;
  }

  private isLatestPinMutation(machineId: string, mutationOrder: number): boolean {
    return this.latestPinMutationOrderByMachine.get(machineId) === mutationOrder;
  }

  private isCurrentPinMutation(machineId: string, sequence: number, mutationOrder: number): boolean {
    return this.isCurrentProjectCatalogOperation(machineId, sequence) && this.isLatestPinMutation(machineId, mutationOrder);
  }

  private cleanupPinMutationQueue(machineId: string, mutationOrder: number, operation: Promise<void>): void {
    if (this.pinMutationQueueByMachine.get(machineId) !== operation) return;
    this.pinMutationQueueByMachine.delete(machineId);
    if (this.latestPinMutationOrderByMachine.get(machineId) === mutationOrder) {
      this.latestPinMutationOrderByMachine.delete(machineId);
    }
  }
}
