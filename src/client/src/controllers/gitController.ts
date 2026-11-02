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

interface GitForegroundWork {
  scope: string;
  pending: number;
}

export class GitController {
  private pollTimer: number | undefined;
  private pollingScope: string | undefined;
  private statusRequest = 0;
  private diffRequest = 0;
  private backgroundPass: GitBackgroundPass | undefined;
  private foregroundPending: GitForegroundWork | undefined;

  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly updateUrl: UpdateUrl) {}

  dispose(): void {
    this.stopPolling();
    this.foregroundPending = undefined;
    this.statusRequest += 1;
    this.diffRequest += 1;
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.pollingScope = undefined;
    this.cancelBackgroundPass();
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
    await this.runForegroundRead(target, () => this.loadDiff(target, path, undefined, options));
  }

  updatePolling(): void {
    const scope = this.currentPollingScope();
    if (scope === this.pollingScope && this.pollTimer !== undefined) return;
    // Workspace selection can start its foreground read before configuring
    // polling. Keep that read's publication ownership instead of discarding it
    // and then deferring its replacement behind the foreground tick gate.
    if (scope !== undefined && this.foregroundPending?.scope === scope) this.stopPolling();
    else this.dispose();
    if (scope === undefined) return;
    this.pollingScope = scope;
    this.pollGit();
    this.pollTimer = window.setInterval(() => { this.pollGit(); }, GIT_POLL_INTERVAL_MS);
  }

  private pollGit(): void {
    // A manual read owns the workspace state while it runs, so a poll tick is
    // deferred rather than started beside it.
    const foreground = this.foregroundPending;
    if (foreground !== undefined && foreground.scope === this.currentPollingScope()) return;
    void this.loadSelectedGit("background", { reportError: false });
  }

  private async loadSelectedGit(intent: ReadIntent, options: GitRefreshOptions): Promise<void> {
    const target = this.selectedTarget();
    if (target === undefined) return;
    if (intent === "foreground") {
      await this.runForegroundRead(target, () => this.loadGitStatus(target, undefined, options));
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
        (signal) => this.loadGitStatus(target, signal, options, pass),
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

  private async runForegroundRead(target: SelectedGitTarget, read: () => Promise<void>): Promise<void> {
    this.cancelBackgroundPass();
    const scope = gitTargetScope(target);
    const foreground = this.foregroundPending?.scope === scope ? this.foregroundPending : { scope, pending: 0 };
    this.foregroundPending = foreground;
    foreground.pending += 1;
    try {
      await read();
    } finally {
      foreground.pending -= 1;
      // Disposed or abandoned work may finish after a newer scope owns the
      // gate. Its finally must never release that newer foreground owner.
      if (this.foregroundPending === foreground && foreground.pending === 0) this.foregroundPending = undefined;
    }
  }

  private cancelBackgroundPass(): void {
    const pass = this.backgroundPass;
    if (pass === undefined) return;
    // Clearing the active pass invalidates its already-queued continuations: a
    // read that settled before this abort still refuses to publish.
    this.backgroundPass = undefined;
    pass.controller.abort(new LoadCancelledError("Git background read superseded by a foreground read"));
  }

  private async loadGitStatus(
    target: SelectedGitTarget,
    signal: AbortSignal | undefined,
    options: GitRefreshOptions,
    pass?: GitBackgroundPass,
  ): Promise<void> {
    const request = ++this.statusRequest;
    this.diffRequest += 1;
    try {
      const status = await this.readStatus(target, signal);
      if (!this.ownsStatus(request, pass, target, signal)) return;
      this.setState({ gitStatus: status, gitStale: false, ...(options.reportError === false ? {} : { error: "" }) });
      const selectedDiffPath = this.getState().selectedDiffPath;
      if (selectedDiffPath === undefined) return;
      if (status.files.some((file) => file.path === selectedDiffPath)) {
        await this.loadDiff(target, selectedDiffPath, signal, options, pass);
        return;
      }
      this.setState({ selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined });
      setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", undefined, { replace: true });
    } catch (error) {
      if (isLoadCancellation(error)) return;
      if (!this.ownsStatus(request, pass, target, signal)) return;
      if (options.reportError !== false) this.setState({ error: String(error) });
    }
  }

  private async loadDiff(
    target: SelectedGitTarget,
    path: string,
    signal: AbortSignal | undefined,
    options: GitRefreshOptions,
    pass?: GitBackgroundPass,
  ): Promise<void> {
    const request = ++this.diffRequest;
    try {
      const [selectedDiff, selectedStagedDiff] = await Promise.all([
        this.readDiff(target, { path }, signal),
        this.readDiff(target, { path, staged: true }, signal),
      ]);
      if (!this.ownsDiff(request, pass, target, signal)) return;
      this.setState({ selectedDiff, selectedStagedDiff, ...(options.reportError === false ? {} : { error: "" }) });
    } catch (error) {
      if (isLoadCancellation(error)) return;
      if (!this.ownsDiff(request, pass, target, signal)) return;
      if (options.reportError !== false) this.setState({ error: String(error) });
    }
  }

  /**
   * A settled status read may publish only while it still owns the state: its
   * request is the newest one, its workspace is still selected, its transport
   * signal is live, and any background pass that started it is still current.
   */
  private ownsStatus(
    request: number,
    pass: GitBackgroundPass | undefined,
    target: SelectedGitTarget,
    signal: AbortSignal | undefined,
  ): boolean {
    return request === this.statusRequest && this.ownsTarget(pass, target, signal);
  }

  /** The diff variant of {@link ownsStatus}: a superseded diff publishes nothing. */
  private ownsDiff(
    request: number,
    pass: GitBackgroundPass | undefined,
    target: SelectedGitTarget,
    signal: AbortSignal | undefined,
  ): boolean {
    return request === this.diffRequest && this.ownsTarget(pass, target, signal);
  }

  private ownsTarget(
    pass: GitBackgroundPass | undefined,
    target: SelectedGitTarget,
    signal: AbortSignal | undefined,
  ): boolean {
    // A foreground read cancels the pass without awaiting its continuations, so
    // a pass that settled after the cancel must not publish or start more work.
    if (pass !== undefined && (this.backgroundPass !== pass || pass.controller.signal.aborted)) return false;
    if (signal?.aborted === true) return false;
    const { project, workspace, machineId } = target;
    return this.isCurrentWorkspace(project, workspace, machineId);
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
    const target = this.selectedTarget();
    if (target?.workspace.isGitRepo !== true) return undefined;
    return gitTargetScope(target);
  }

  private isCurrentWorkspace(project: Project, workspace: Workspace, machineId: string): boolean {
    const state = this.getState();
    return selectedMachineId(state) === machineId
      && state.selectedProject?.id === project.id
      && state.selectedWorkspace?.id === workspace.id
      && state.selectedWorkspace.projectId === workspace.projectId;
  }
}

function gitTargetScope(target: SelectedGitTarget): string {
  return JSON.stringify([target.machineId, target.project.id, target.workspace.id]);
}
