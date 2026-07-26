import { api as defaultApi, type Project, type SessionInfo, type Workspace } from "../api";
import { resetWorkspaceScopedState } from "../appState";
import { mergeCachedNewSessions } from "../cachedNewSessions";
import { machineProjectKey } from "../machineKeys";
import { selectedMachineId, type GetState, type RouteTarget, type SetState, type UpdateUrl } from "./types";
import type { SessionController } from "./sessionController";
import { InMemoryWorkspaceSelectionMemory, selectPreferredWorkspace, type WorkspaceSelectionMemory } from "./workspaceSelection";

export interface WorkspaceControllerDependencies {
  api?: Pick<typeof defaultApi, "sessions" | "workspaces">;
}

export class WorkspaceController {
  private readonly api: Pick<typeof defaultApi, "sessions" | "workspaces">;
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
      this.setState({ workspaces, workspacesByProjectId: { ...this.getState().workspacesByProjectId, [project.id]: workspaces }, isLoadingWorkspaces: false });
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

  async refreshProjectWorkspaces(projectId: string): Promise<Workspace[]> {
    const project = this.getState().projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("Project not found");
    const workspaces = await this.api.workspaces(project.id, selectedMachineId(this.getState()));
    this.applyProjectWorkspaces(project.id, workspaces);
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

  private applyProjectWorkspaces(projectId: string, workspaces: Workspace[]): void {
    const state = this.getState();
    const workspacesByProjectId = { ...state.workspacesByProjectId, [projectId]: workspaces };
    if (state.selectedProject?.id === projectId) this.setState({ workspaces, workspacesByProjectId });
    else this.setState({ workspacesByProjectId });
  }
}

export function canDeleteWorkspace(workspace: Workspace | undefined): boolean {
  return workspace !== undefined && workspace.isGitWorktree && !workspace.isMain;
}

function selectFallbackWorkspace(workspaces: Workspace[]): Workspace | undefined {
  return workspaces.find((workspace) => workspace.isMain) ?? workspaces[0];
}

function uniqueSessionsByPath(sessions: readonly SessionInfo[]): SessionInfo[] {
  const byPath = new Map<string, SessionInfo>();
  for (const session of sessions) byPath.set(session.path, session);
  return [...byPath.values()];
}
