import { api, type Project, type Workspace } from "../api";
import { queryNamespace, setNamespacedQueryKey } from "../namespacedQueryArgs";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";

const GIT_ROUTE_NAMESPACE = queryNamespace("core:workspace.git");

interface GitRefreshOptions {
  reportError?: boolean;
}

export class GitController {
  private pollTimer: number | undefined;
  private pollingScope: string | undefined;
  private statusRequest = 0;
  private diffRequest = 0;

  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly updateUrl: UpdateUrl) {}

  dispose(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.pollingScope = undefined;
    this.statusRequest += 1;
    this.diffRequest += 1;
  }

  async refreshGit(options: GitRefreshOptions = {}): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    const machineId = selectedMachineId(this.getState());
    const request = ++this.statusRequest;
    this.diffRequest += 1;
    try {
      const status = await api.gitStatus(project.id, workspace.id, machineId);
      if (request !== this.statusRequest || !this.isCurrentWorkspace(project, workspace, machineId)) return;
      this.setState({ gitStatus: status, gitStale: false, ...(options.reportError === false ? {} : { error: "" }) });
      const selectedDiffPath = this.getState().selectedDiffPath;
      if (selectedDiffPath !== undefined) {
        if (status.files.some((file) => file.path === selectedDiffPath)) await this.refreshDiff(selectedDiffPath, options);
        else {
          this.setState({ selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined });
          setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", undefined, { replace: true });
        }
      }
    } catch (error) {
      if (request !== this.statusRequest || !this.isCurrentWorkspace(project, workspace, machineId)) return;
      if (options.reportError !== false) this.setState({ error: String(error) });
    }
  }

  async selectDiff(path: string): Promise<void> {
    this.setState({ selectedDiffPath: path, selectedDiff: undefined, selectedStagedDiff: undefined, workspaceTool: "core:workspace.git", mainView: this.getState().mainView === "chat" ? "chat" : "core:workspace.git" });
    setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", path);
    this.updateUrl({ replace: true });
    await this.refreshDiff(path);
  }

  async restoreDiff(path: string): Promise<void> {
    this.setState({ selectedDiffPath: path, selectedDiff: undefined, selectedStagedDiff: undefined });
    await this.refreshDiff(path);
  }

  async refreshDiff(path: string, options: GitRefreshOptions = {}): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    const machineId = selectedMachineId(this.getState());
    const request = ++this.diffRequest;
    try {
      const [selectedDiff, selectedStagedDiff] = await Promise.all([
        api.gitDiff(project.id, workspace.id, { path }, machineId),
        api.gitDiff(project.id, workspace.id, { path, staged: true }, machineId),
      ]);
      if (request !== this.diffRequest || !this.isCurrentWorkspace(project, workspace, machineId)) return;
      this.setState({ selectedDiff, selectedStagedDiff, ...(options.reportError === false ? {} : { error: "" }) });
    } catch (error) {
      if (request !== this.diffRequest || !this.isCurrentWorkspace(project, workspace, machineId)) return;
      if (options.reportError !== false) this.setState({ error: String(error) });
    }
  }

  updatePolling(): void {
    const scope = this.currentPollingScope();
    if (scope === this.pollingScope && this.pollTimer !== undefined) return;
    this.dispose();
    if (scope === undefined) return;
    this.pollingScope = scope;
    void this.refreshGit({ reportError: false });
    this.pollTimer = window.setInterval(() => { void this.refreshGit({ reportError: false }); }, 8000);
  }

  private currentPollingScope(): string | undefined {
    const state = this.getState();
    if (state.selectedProject === undefined || state.selectedWorkspace?.isGitRepo !== true) return undefined;
    return JSON.stringify([selectedMachineId(state), state.selectedProject.id, state.selectedWorkspace.id]);
  }

  private isCurrentWorkspace(project: Project, workspace: Workspace, machineId: string): boolean {
    const state = this.getState();
    return selectedMachineId(state) === machineId
      && state.selectedProject?.id === project.id
      && state.selectedWorkspace?.id === workspace.id
      && state.selectedWorkspace.projectId === workspace.projectId;
  }
}
