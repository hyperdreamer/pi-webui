import { api as defaultApi, type Project, type SessionInfo, type Workspace } from "../api";
import { resetWorkspaceScopedState } from "../appState";
import { mergeCachedNewSessions } from "../cachedNewSessions";
import { machineProjectKey } from "../machineKeys";
import { selectedMachineId, type GetState, type RouteTarget, type SetState, type UpdateUrl } from "./types";
import type { ProjectCatalogSnapshot } from "./projectCatalogController";
import type { SessionController } from "./sessionController";
import { InMemoryWorkspaceSelectionMemory, selectPreferredWorkspace, type WorkspaceSelectionMemory } from "./workspaceSelection";

export interface WorkspaceControllerDependencies {
  api?: Pick<typeof defaultApi, "sessions" | "workspaces">;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

export class WorkspaceController {
  private readonly api: Pick<typeof defaultApi, "sessions" | "workspaces">;
  private readonly onBackgroundError: WorkspaceControllerDependencies["onBackgroundError"];
  private readonly unhydratedWorkspaceKeys = new Set<string>();
  private projectSessionsRequest = 0;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessions: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession">,
    private readonly workspaceSelection: WorkspaceSelectionMemory = new InMemoryWorkspaceSelectionMemory(),
    deps: WorkspaceControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
    this.onBackgroundError = deps.onBackgroundError;
  }

  clearSelection(options?: { updateUrl?: boolean | undefined }) {
    this.projectSessionsRequest += 1;
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: undefined, selectedWorkspace: undefined, workspaces: [], isLoadingWorkspaces: false, ...resetWorkspaceScopedState() });
    if (options?.updateUrl !== false) this.updateUrl();
  }

  forgetProject(projectId: string): void {
    this.workspaceSelection.forgetProject(machineProjectKey(selectedMachineId(this.getState()), projectId));
    const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([candidate]) => candidate !== projectId));
    this.setState({ workspacesByProjectId });
  }

  async selectProject(project: Project, target?: RouteTarget) {
    this.projectSessionsRequest += 1;
    const machineId = selectedMachineId(this.getState());
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: project, selectedWorkspace: undefined, workspaces: [], isLoadingWorkspaces: true, ...resetWorkspaceScopedState() });
    try {
      const workspaces = await this.api.workspaces(project.id, machineId);
      if (selectedMachineId(this.getState()) !== machineId || this.getState().selectedProject?.id !== project.id) return;
      this.applyProjectWorkspaceProjection(project, workspaces, machineId);
      this.setState({ isLoadingWorkspaces: false });
      const workspace = selectPreferredWorkspace(workspaces, { targetWorkspaceId: target?.workspaceId, latestWorkspaceId: this.workspaceSelection.latestWorkspaceId(machineProjectKey(machineId, project.id)) });
      if (workspace) await this.selectWorkspace(workspace, { sessionId: target?.sessionId, updateUrl: target?.updateUrl });
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId && this.getState().selectedProject?.id === project.id) this.setState({ error: String(error), isLoadingWorkspaces: false });
    }
  }

  async selectWorkspace(workspace: Workspace, target?: { sessionId?: string | undefined; updateUrl?: boolean | undefined }) {
    const projectSessionsRequest = ++this.projectSessionsRequest;
    const machineId = selectedMachineId(this.getState());
    this.workspaceSelection.rememberWorkspace({ ...workspace, projectId: machineProjectKey(machineId, workspace.projectId) });
    this.sessions.clearActiveSession();
    this.setState({ selectedWorkspace: workspace, isLoadingWorkspaces: false, ...resetWorkspaceScopedState(), isLoadingSessions: true });
    try {
      const sessions = mergeCachedNewSessions(workspace.path, await this.api.sessions(workspace.path, machineId), machineId);
      if (selectedMachineId(this.getState()) !== machineId || this.getState().selectedWorkspace?.id !== workspace.id || this.getState().selectedProject?.id !== workspace.projectId) return;
      this.setState({ sessions, projectSessions: sessions, isLoadingSessions: false });
      void this.refreshProjectSessions(projectSessionsRequest, workspace, sessions, machineId);
      const session = this.sessions.preferredSession(workspace.path, sessions, target?.sessionId);
      if (session) await this.sessions.selectSession(session, { updateUrl: target?.updateUrl });
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId && this.getState().selectedWorkspace?.id === workspace.id) this.setState({ error: String(error), isLoadingSessions: false });
    }
  }

  private async refreshProjectSessions(request: number, workspace: Workspace, currentSessions: SessionInfo[], machineId: string): Promise<void> {
    const state = this.getState();
    const projectWorkspaces = state.workspaces.filter((candidate) => candidate.projectId === workspace.projectId);
    if (!projectWorkspaces.some((candidate) => candidate.id === workspace.id)) projectWorkspaces.unshift(workspace);

    try {
      const sessionLists = await Promise.all(projectWorkspaces.map(async (candidate) => {
        if (candidate.id === workspace.id) return currentSessions;
        return mergeCachedNewSessions(candidate.path, await this.api.sessions(candidate.path, machineId), machineId);
      }));
      if (request !== this.projectSessionsRequest
        || selectedMachineId(this.getState()) !== machineId
        || this.getState().selectedProject?.id !== workspace.projectId
        || this.getState().selectedWorkspace?.id !== workspace.id) return;
      this.setState({ projectSessions: uniqueSessionsByPath(sessionLists.flat()) });
    } catch {
      // Cross-workspace grouping is an enhancement; preserve the current
      // workspace's already-loaded sessions if a sibling cannot be listed.
    }
  }

  async reconcileProjectCatalog(snapshot: ProjectCatalogSnapshot): Promise<void> {
    if (!this.isProjectCatalogScopeCurrent(snapshot.machineId, snapshot.project)) return;

    const { added, selectedWorkspaceRemoved } = this.applyProjectWorkspaceProjection(snapshot.project, snapshot.workspaces, snapshot.machineId);
    if (this.getState().selectedProject?.id !== snapshot.project.id) return;

    for (const workspace of added) this.unhydratedWorkspaceKeys.add(workspaceHydrationKey(snapshot.machineId, snapshot.project.id, workspace));
    const workspacesToHydrate = uniqueWorkspacesByKey(snapshot.workspaces.filter((workspace) => (
      this.unhydratedWorkspaceKeys.has(workspaceHydrationKey(snapshot.machineId, snapshot.project.id, workspace))
    )));
    await this.hydrateDiscoveredWorkspaceSessions(snapshot.project, workspacesToHydrate, snapshot.machineId);
    if (!this.isProjectCatalogScopeCurrent(snapshot.machineId, snapshot.project)) return;

    const selectedWorkspace = this.getState().selectedWorkspace;
    if (!selectedWorkspaceRemoved
      || this.getState().selectedProject?.id !== snapshot.project.id
      || selectedWorkspace === undefined
      || workspaceStillExists(selectedWorkspace, snapshot.workspaces)) return;

    const fallback = selectFallbackWorkspace(snapshot.workspaces);
    if (fallback === undefined) {
      this.clearSelection();
      return;
    }

    await this.selectWorkspace(fallback);
    if (!this.isProjectCatalogScopeCurrent(snapshot.machineId, snapshot.project)) return;
  }

  async refreshProjectWorkspaces(projectId: string): Promise<Workspace[]> {
    const state = this.getState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("Project not found");
    const machineId = selectedMachineId(state);
    const workspaces = await this.api.workspaces(project.id, machineId);
    await this.reconcileProjectCatalog({ machineId, project, workspaces });
    return workspaces;
  }

  async refreshAfterWorkspaceDeleted(projectId: string, workspaceId: string): Promise<void> {
    const workspaces = await this.refreshProjectWorkspaces(projectId);
    const state = this.getState();
    if (state.selectedProject?.id !== projectId || state.selectedWorkspace?.id !== workspaceId) return;

    const fallback = selectFallbackWorkspace(workspaces);
    if (fallback !== undefined) await this.selectWorkspace(fallback);
    else this.clearSelection();
  }

  private applyProjectWorkspaceProjection(
    project: Project,
    workspaces: Workspace[],
    machineId: string,
  ): { added: Workspace[]; selectedWorkspaceRemoved: boolean } {
    const state = this.getState();
    const selectedProject = state.selectedProject?.id === project.id;
    const oldWorkspaces = state.workspacesByProjectId[project.id]
      ?? (selectedProject ? state.workspaces : []);
    const oldWorkspaceIdentities = new Set(oldWorkspaces.map(workspaceIdentity));
    const added = workspaces.filter((workspace) => !oldWorkspaceIdentities.has(workspaceIdentity(workspace)));
    const workspacePaths = new Set(workspaces.map((workspace) => workspace.path));
    const workspaceKeys = new Set(workspaces.map((workspace) => workspaceHydrationKey(machineId, project.id, workspace)));
    for (const key of this.unhydratedWorkspaceKeys) {
      if (isWorkspaceKeyForProject(key, machineId, project.id) && !workspaceKeys.has(key)) this.unhydratedWorkspaceKeys.delete(key);
    }

    const selectedWorkspace = selectedProject ? state.selectedWorkspace : undefined;
    const refreshedSelectedWorkspace = selectedWorkspace === undefined
      ? undefined
      : workspaces.find((workspace) => workspaceIdentity(workspace) === workspaceIdentity(selectedWorkspace));
    const selectedWorkspaceRemoved = selectedWorkspace !== undefined && refreshedSelectedWorkspace === undefined;
    const workspacesByProjectId = { ...state.workspacesByProjectId, [project.id]: workspaces };
    this.setState({
      workspacesByProjectId,
      ...(selectedProject ? { workspaces } : {}),
      ...(refreshedSelectedWorkspace === undefined ? {} : { selectedWorkspace: refreshedSelectedWorkspace }),
      ...(selectedProject ? { projectSessions: state.projectSessions.filter((session) => workspacePaths.has(session.cwd)) } : {}),
    });
    return { added, selectedWorkspaceRemoved };
  }

  private async hydrateDiscoveredWorkspaceSessions(
    project: Project,
    workspacesToHydrate: Workspace[],
    machineId: string,
  ): Promise<void> {
    if (workspacesToHydrate.length === 0 || !this.isProjectCatalogScopeCurrent(machineId, project)) return;

    const results = await Promise.allSettled(workspacesToHydrate.map(async (workspace) => {
      const sessions = await this.api.sessions(workspace.path, machineId);
      if (!this.isWorkspaceCurrentForProject(project, workspace, machineId)) return undefined;
      return { workspace, sessions: mergeCachedNewSessions(workspace.path, sessions, machineId) };
    }));
    if (!this.isProjectCatalogScopeCurrent(machineId, project)) return;

    const hydratedSessions: SessionInfo[] = [];
    for (const [index, result] of results.entries()) {
      const workspace = workspacesToHydrate[index];
      if (workspace === undefined) continue;
      if (result.status === "rejected") {
        this.reportBackgroundError("reconcile discovered workspace sessions", result.reason);
        continue;
      }
      if (result.value === undefined) continue;
      this.unhydratedWorkspaceKeys.delete(workspaceHydrationKey(machineId, project.id, workspace));
      hydratedSessions.push(...result.value.sessions);
    }
    if (hydratedSessions.length === 0) return;

    const state = this.getState();
    if (!this.isProjectCatalogScopeCurrent(machineId, project) || state.selectedProject?.id !== project.id) return;
    const workspaces = state.workspacesByProjectId[project.id] ?? state.workspaces;
    const workspacePaths = new Set(workspaces.map((workspace) => workspace.path));
    const currentProjectSessions = state.projectSessions.filter((session) => workspacePaths.has(session.cwd));
    this.setState({
      projectSessions: uniqueSessionsByPath([
        ...hydratedSessions.filter((session) => workspacePaths.has(session.cwd)),
        ...currentProjectSessions,
      ]),
    });
  }

  private isProjectCatalogScopeCurrent(machineId: string, project: Project): boolean {
    const state = this.getState();
    const currentProject = state.projects.find((candidate) => candidate.id === project.id);
    return selectedMachineId(state) === machineId && currentProject?.path === project.path;
  }

  private isWorkspaceCurrentForProject(project: Project, workspace: Workspace, machineId: string): boolean {
    if (!this.isProjectCatalogScopeCurrent(machineId, project)) return false;
    const state = this.getState();
    const workspaces = state.workspacesByProjectId[project.id]
      ?? (state.selectedProject?.id === project.id ? state.workspaces : []);
    return workspaceStillExists(workspace, workspaces);
  }

  private reportBackgroundError(operation: string, error: unknown): void {
    if (this.onBackgroundError === undefined) return;
    try {
      this.onBackgroundError(operation, error);
    } catch {
      // Reporting must not disrupt background reconciliation or its retry state.
    }
  }
}

export function canDeleteWorkspace(workspace: Workspace | undefined): boolean {
  return workspace !== undefined && workspace.isGitWorktree && !workspace.isMain;
}

function selectFallbackWorkspace(workspaces: Workspace[]): Workspace | undefined {
  return workspaces.find((workspace) => workspace.isMain) ?? workspaces[0];
}

function workspaceIdentity(workspace: Workspace): string {
  return JSON.stringify([workspace.id, workspace.path]);
}

function workspaceHydrationKey(machineId: string, projectId: string, workspace: Workspace): string {
  return JSON.stringify([machineId, projectId, workspace.id, workspace.path]);
}

function isWorkspaceKeyForProject(key: string, machineId: string, projectId: string): boolean {
  return key.startsWith(`${JSON.stringify([machineId, projectId]).slice(0, -1)},`);
}

function uniqueWorkspacesByKey(workspaces: readonly Workspace[]): Workspace[] {
  const workspacesByKey = new Map<string, Workspace>();
  for (const workspace of workspaces) workspacesByKey.set(workspaceIdentity(workspace), workspace);
  return [...workspacesByKey.values()];
}

function workspaceStillExists(workspace: Workspace, workspaces: readonly Workspace[]): boolean {
  const identity = workspaceIdentity(workspace);
  return workspaces.some((candidate) => workspaceIdentity(candidate) === identity);
}

function uniqueSessionsByPath(sessions: readonly SessionInfo[]): SessionInfo[] {
  const byPath = new Map<string, SessionInfo>();
  for (const session of sessions) byPath.set(session.path, session);
  return [...byPath.values()];
}
