import { workspacesApi as defaultApi, type Project, type Workspace } from "../api";
import { isWorkspaceActivityActive } from "../../../shared/activity";
import { projectOwnsWorkspacePath } from "../workspaceActivity";
import { selectedMachineId, type GetState, type SetState } from "./types";

export interface ProjectActivityOwnershipFailure {
  machineId: string;
  projectId: string;
  error: unknown;
}

export interface ProjectActivityOwnershipCoordinatorDependencies {
  api?: Pick<typeof defaultApi, "workspaces">;
  onError?: (failure: ProjectActivityOwnershipFailure) => void;
}

interface ProjectTopologySnapshot {
  id: string;
  path: string;
  startingWorkspaces: Workspace[] | undefined;
}

interface OwnershipPass {
  machineGeneration: number;
  projectTopologyGeneration: number;
  machineId: string;
  projects: ProjectTopologySnapshot[];
  cwdActivations: Map<string, number>;
  trailingRequested: boolean;
  promise: Promise<void>;
}

/**
 * Hydrates only project-to-workspace topology needed to attribute active CWDs.
 * Selection and navigation remain owned by their existing controllers.
 */
export class ProjectActivityOwnershipCoordinator {
  private readonly api: Pick<typeof defaultApi, "workspaces">;
  private readonly onError: ((failure: ProjectActivityOwnershipFailure) => void) | undefined;
  private machineGeneration = 0;
  private activityMachineGeneration = -1;
  private projectTopologyGeneration = 0;
  private nextCwdActivation = 0;
  private observedActiveCwds = new Set<string>();
  private readonly cwdActivations = new Map<string, number>();
  private readonly attemptedCwdActivations = new Map<string, number>();
  private activePass: OwnershipPass | undefined;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    deps: ProjectActivityOwnershipCoordinatorDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
    this.onError = deps.onError;
  }

  handleActivityApplied(machineId: string): Promise<void> {
    if (selectedMachineId(this.getState()) !== machineId) return Promise.resolve();
    this.activityMachineGeneration = this.machineGeneration;
    return this.reconcile(machineId);
  }

  handleProjectsApplied(machineId: string): Promise<void> {
    if (selectedMachineId(this.getState()) !== machineId) return Promise.resolve();
    this.projectTopologyGeneration += 1;
    this.attemptedCwdActivations.clear();
    this.activePass = undefined;
    if (this.activityMachineGeneration !== this.machineGeneration) return Promise.resolve();
    return this.reconcile(machineId);
  }

  handleSelectedMachineChanged(): void {
    this.machineGeneration += 1;
    this.projectTopologyGeneration += 1;
    this.observedActiveCwds.clear();
    this.cwdActivations.clear();
    this.attemptedCwdActivations.clear();
    this.activePass = undefined;
  }

  private reconcile(machineId: string): Promise<void> {
    const state = this.getState();
    if (selectedMachineId(state) !== machineId) return Promise.resolve();

    const activeCwdActivations = this.syncActiveCwds(state);
    const unknownCwdActivations = new Map([...activeCwdActivations].filter(([cwd, activation]) =>
      !projectOwnsCwd(state.projects, state.workspacesByProjectId, cwd)
      && this.attemptedCwdActivations.get(cwd) !== activation));

    const activePass = this.activePass;
    if (activePass !== undefined) {
      if (activePass.machineGeneration !== this.machineGeneration
        || activePass.projectTopologyGeneration !== this.projectTopologyGeneration
        || [...unknownCwdActivations].some(([cwd, activation]) => activePass.cwdActivations.get(cwd) !== activation)) {
        activePass.trailingRequested = true;
      }
      return activePass.promise;
    }

    if (unknownCwdActivations.size === 0 || state.projects.length === 0) return Promise.resolve();

    const pass: OwnershipPass = {
      machineGeneration: this.machineGeneration,
      projectTopologyGeneration: this.projectTopologyGeneration,
      machineId,
      projects: state.projects.map((project) => ({
        id: project.id,
        path: project.path,
        startingWorkspaces: state.workspacesByProjectId[project.id],
      })),
      cwdActivations: unknownCwdActivations,
      trailingRequested: false,
      promise: Promise.resolve(),
    };
    this.activePass = pass;
    pass.promise = this.runPass(pass);
    return pass.promise;
  }

  private async runPass(pass: OwnershipPass): Promise<void> {
    await Promise.all(pass.projects.map(async (project) => {
      try {
        const workspaces = await this.api.workspaces(project.id, pass.machineId);
        this.applyProjectWorkspaces(pass, project, workspaces);
      } catch (error) {
        if (this.isPassScopeCurrent(pass)) this.reportError({ machineId: pass.machineId, projectId: project.id, error });
      }
    }));

    if (this.activePass !== pass) return;

    const state = this.getState();
    const activeCwdActivations = this.syncActiveCwds(state);
    for (const [cwd, activation] of pass.cwdActivations) {
      if (activeCwdActivations.get(cwd) === activation
        && !projectOwnsCwd(state.projects, state.workspacesByProjectId, cwd)) {
        this.attemptedCwdActivations.set(cwd, activation);
      }
    }

    const runTrailingPass = pass.trailingRequested;
    this.activePass = undefined;
    if (runTrailingPass) await this.reconcile(selectedMachineId(this.getState()));
  }

  private applyProjectWorkspaces(pass: OwnershipPass, project: ProjectTopologySnapshot, workspaces: Workspace[]): void {
    if (this.activePass !== pass || !this.isPassScopeCurrent(pass)) return;
    const state = this.getState();
    const currentProject = state.projects.find((candidate) => candidate.id === project.id);
    if (currentProject?.path !== project.path) return;
    if (state.workspacesByProjectId[project.id] !== project.startingWorkspaces) return;

    this.setState({
      workspacesByProjectId: {
        ...state.workspacesByProjectId,
        [project.id]: workspaces,
      },
    });
  }

  private isPassScopeCurrent(pass: OwnershipPass): boolean {
    return pass.machineGeneration === this.machineGeneration
      && pass.projectTopologyGeneration === this.projectTopologyGeneration
      && selectedMachineId(this.getState()) === pass.machineId;
  }

  private syncActiveCwds(state: ReturnType<GetState>): Map<string, number> {
    const activeCwds = new Set(Object.values(state.workspaceActivities)
      .filter(isWorkspaceActivityActive)
      .map((activity) => activity.cwd));

    for (const cwd of this.observedActiveCwds) {
      if (activeCwds.has(cwd)) continue;
      this.cwdActivations.delete(cwd);
      this.attemptedCwdActivations.delete(cwd);
    }
    for (const cwd of activeCwds) {
      if (this.observedActiveCwds.has(cwd)) continue;
      this.nextCwdActivation += 1;
      this.cwdActivations.set(cwd, this.nextCwdActivation);
      this.attemptedCwdActivations.delete(cwd);
    }
    this.observedActiveCwds = activeCwds;

    return new Map([...activeCwds].map((cwd) => [cwd, this.cwdActivations.get(cwd) ?? 0]));
  }

  private reportError(failure: ProjectActivityOwnershipFailure): void {
    if (this.onError === undefined) return;
    try {
      this.onError(failure);
    } catch {
      // Error reporting must not turn background ownership discovery into an unhandled rejection.
    }
  }
}

function projectOwnsCwd(projects: Project[], workspacesByProjectId: Record<string, Workspace[]>, cwd: string): boolean {
  return projects.some((project) => projectOwnsWorkspacePath(project, workspacesByProjectId[project.id] ?? [], cwd));
}
