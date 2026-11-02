import { api, type GitDiffResponse, type GitStatusResponse, type Project, type Workspace } from "../api";
import { LOCAL_MACHINE_ID } from "../machineKeys";
import { queryNamespace, setNamespacedQueryKey } from "../namespacedQueryArgs";
import { runBackgroundRead, type ReadIntent } from "./backgroundRead";
import { isLoadCancellation, LoadCancelledError } from "./cancellableLoadScope";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";

const GIT_ROUTE_NAMESPACE = queryNamespace("core:workspace.git");
const GIT_POLL_INTERVAL_MS = 8_000;

interface GitRefreshOptions {
  reportError?: boolean;
}

interface SelectedGitTarget {
  project: Project;
  workspace: Workspace;
  machineId: string;
}

interface GitBackgroundPass {
  controller: AbortController;
}

export class GitController {
  private pollTimer: number | undefined;
  private pollingScope: string | undefined;
  private statusRequest = 0;
  private diffRequest = 0;
  private backgroundPass: GitBackgroundPass | undefined;
  private foregroundPending = 0;

  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly updateUrl: UpdateUrl) {}

  dispose(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.pollingScope = undefined;
    this.cancelBackgroundPass();
    this.statusRequest += 1;
    this.diffRequest += 1;
  }

  /** Explicit and manual Git reads are foreground work: they keep the machine budget. */
  async refreshGit(options: GitRefreshOptions = {}): Promise<void> {
    await this.loadSelectedGit("foreground", options);
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
    const target = this.selectedTarget();
    if (target === undefined) return;
    await this.runForegroundRead(() => this.loadDiff(target, path, undefined, options));
  }

  updatePolling(): void {
    const scope = this.currentPollingScope();
    if (scope === this.pollingScope && this.pollTimer !== undefined) return;
    this.dispose();
    if (scope === undefined) return;
    this.pollingScope = scope;
    this.pollGit();
    this.pollTimer = window.setInterval(() => { this.pollGit(); }, GIT_POLL_INTERVAL_MS);
  }

  private pollGit(): void {
    // A manual read owns the workspace state while it runs, so a poll tick is
    // deferred rather than started beside it.
    if (this.foregroundPending > 0) return;
    void this.loadSelectedGit("background", { reportError: false });
  }

  private async loadSelectedGit(intent: ReadIntent, options: GitRefreshOptions): Promise<void> {
    const target = this.selectedTarget();
    if (target === undefined) return;
    if (intent === "foreground") {
      await this.runForegroundRead(() => this.loadGitStatus(target, undefined, options));
      return;
    }
    if (target.machineId === LOCAL_MACHINE_ID) {
      // The local machine keeps the plain read path: no budget and no bow-out.
      await this.loadGitStatus(target, undefined, options);
      return;
    }
    await this.runBackgroundPass(target, options);
  }

  /**
   * One background scope covers a polled status read and the selected diff it
   * makes consequential, so both bow out on the same deadline.
   */
  private async runBackgroundPass(target: SelectedGitTarget, options: GitRefreshOptions): Promise<void> {
    const pass: GitBackgroundPass = { controller: new AbortController() };
    this.backgroundPass = pass;
    try {
      await runBackgroundRead(
        target.machineId,
        (signal) => this.loadGitStatus(target, signal, options),
        pass.controller.signal,
      );
    } catch (error) {
      // Only the deadline bow-out and a foreground supersession reach here;
      // `loadGitStatus` reports genuine read failures with its caller's option.
      if (!isLoadCancellation(error)) throw error;
    } finally {
      if (this.backgroundPass === pass) this.backgroundPass = undefined;
    }
  }

  private async runForegroundRead(read: () => Promise<void>): Promise<void> {
    this.cancelBackgroundPass();
    this.foregroundPending += 1;
    try {
      await read();
    } finally {
      this.foregroundPending -= 1;
    }
  }

  private cancelBackgroundPass(): void {
    const pass = this.backgroundPass;
    if (pass === undefined) return;
    this.backgroundPass = undefined;
    pass.controller.abort(new LoadCancelledError("Git background read superseded by a foreground read"));
  }

  private async loadGitStatus(
    target: SelectedGitTarget,
    signal: AbortSignal | undefined,
    options: GitRefreshOptions,
  ): Promise<void> {
    const { project, workspace, machineId } = target;
    const request = ++this.statusRequest;
    this.diffRequest += 1;
    try {
      const status = await this.readStatus(target, signal);
      if (request !== this.statusRequest || !this.isCurrentWorkspace(project, workspace, machineId)) return;
      this.setState({ gitStatus: status, gitStale: false, ...(options.reportError === false ? {} : { error: "" }) });
      const selectedDiffPath = this.getState().selectedDiffPath;
      if (selectedDiffPath === undefined) return;
      if (status.files.some((file) => file.path === selectedDiffPath)) {
        await this.loadDiff(target, selectedDiffPath, signal, options);
        return;
      }
      this.setState({ selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined });
      setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", undefined, { replace: true });
    } catch (error) {
      if (isLoadCancellation(error)) return;
      if (request !== this.statusRequest || !this.isCurrentWorkspace(project, workspace, machineId)) return;
      if (options.reportError !== false) this.setState({ error: String(error) });
    }
  }

  private async loadDiff(
    target: SelectedGitTarget,
    path: string,
    signal: AbortSignal | undefined,
    options: GitRefreshOptions,
  ): Promise<void> {
    const { project, workspace, machineId } = target;
    const request = ++this.diffRequest;
    try {
      const [selectedDiff, selectedStagedDiff] = await Promise.all([
        this.readDiff(target, { path }, signal),
        this.readDiff(target, { path, staged: true }, signal),
      ]);
      if (request !== this.diffRequest || !this.isCurrentWorkspace(project, workspace, machineId)) return;
      this.setState({ selectedDiff, selectedStagedDiff, ...(options.reportError === false ? {} : { error: "" }) });
    } catch (error) {
      if (isLoadCancellation(error)) return;
      if (request !== this.diffRequest || !this.isCurrentWorkspace(project, workspace, machineId)) return;
      if (options.reportError !== false) this.setState({ error: String(error) });
    }
  }

  private readStatus(target: SelectedGitTarget, signal: AbortSignal | undefined): Promise<GitStatusResponse> {
    const { project, workspace, machineId } = target;
    if (signal === undefined) return api.gitStatus(project.id, workspace.id, machineId);
    return api.gitStatus(project.id, workspace.id, machineId, signal);
  }

  private readDiff(
    target: SelectedGitTarget,
    options: { path: string; staged?: boolean },
    signal: AbortSignal | undefined,
  ): Promise<GitDiffResponse> {
    const { project, workspace, machineId } = target;
    if (signal === undefined) return api.gitDiff(project.id, workspace.id, options, machineId);
    return api.gitDiff(project.id, workspace.id, options, machineId, signal);
  }

  private selectedTarget(): SelectedGitTarget | undefined {
    const state = this.getState();
    const project = state.selectedProject;
    const workspace = state.selectedWorkspace;
    if (project === undefined || workspace === undefined) return undefined;
    return { project, workspace, machineId: selectedMachineId(state) };
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
