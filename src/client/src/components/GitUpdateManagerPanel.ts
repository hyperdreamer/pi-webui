import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gitApi, type GitDiffResponse, type GitStatusResponse, type Workspace } from "../api";
import { gitStatusIndicator, gitStatusLabel, gitUpdateChangePath, gitUpdateChanges, type GitUpdateChange } from "../gitUpdateManagerChanges";
import {
  fitTerminalModalBounds as fitGitUpdateManagerBounds,
  moveTerminalModal as moveGitUpdateManagerPanel,
  resizeTerminalModal as resizeGitUpdateManagerPanel,
  type TerminalModalBounds as GitUpdateManagerPanelBounds,
  type TerminalModalViewport as GitUpdateManagerPanelViewport,
} from "../terminalModalGeometry";

export type GitUpdateManagerApi = Pick<typeof gitApi, "gitDiff" | "gitStatus">;

interface GitUpdateManagerPointerInteraction {
  operation: "move" | "resize";
  pointerId: number;
  target: HTMLElement;
  startClientX: number;
  startClientY: number;
  bounds: GitUpdateManagerPanelBounds;
}

interface GitUpdateManagerPointerEvent {
  button: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

@customElement("git-update-manager-panel")
export class GitUpdateManagerPanel extends LitElement {
  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onStatusChange?: (status: GitStatusResponse) => void;
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property() machineId = "local";
  @property({ attribute: false }) api: GitUpdateManagerApi = gitApi;

  @state() private status: GitStatusResponse | undefined;
  @state() private selectedChange: GitUpdateChange | undefined;
  @state() private selectedDiff: GitDiffResponse | undefined;
  @state() private loadingStatus = false;
  @state() private loadingDiff = false;
  @state() private error = "";
  @state() private bounds: GitUpdateManagerPanelBounds | undefined;
  private pointerInteraction: GitUpdateManagerPointerInteraction | undefined;
  private statusRequest = 0;
  private diffRequest = 0;
  private workspaceScope: string | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
    this.ensureWorkspaceScope();
  }

  protected override willUpdate(): void {
    this.ensureWorkspaceScope();
  }

  override disconnectedCallback(): void {
    this.finishPointerInteraction();
    this.statusRequest += 1;
    this.diffRequest += 1;
    window.removeEventListener("resize", this.onViewportResize);
    super.disconnectedCallback();
  }

  readonly refresh = async (): Promise<void> => {
    const workspace = this.workspace;
    if (workspace === undefined) return;
    const machineId = this.machineId;
    const selectedChangeId = this.selectedChange?.id;
    const request = ++this.statusRequest;
    this.diffRequest += 1;
    this.status = undefined;
    this.selectedDiff = undefined;
    this.loadingStatus = true;
    this.loadingDiff = false;
    this.error = "";

    try {
      const status = await this.api.gitStatus(workspace.projectId, workspace.id, machineId);
      if (request !== this.statusRequest || !this.isCurrentWorkspace(workspace, machineId)) return;
      this.status = status;
      this.loadingStatus = false;
      this.onStatusChange?.(status);
      const selectedChange = selectedChangeId === undefined ? undefined : findChange(status, selectedChangeId);
      this.selectedChange = selectedChange;
      if (selectedChange !== undefined) await this.loadDiff(selectedChange, workspace, machineId);
    } catch (error) {
      if (request !== this.statusRequest || !this.isCurrentWorkspace(workspace, machineId)) return;
      this.status = undefined;
      this.selectedChange = undefined;
      this.selectedDiff = undefined;
      this.loadingStatus = false;
      this.error = errorMessage(error);
    }
  };

  override render(): TemplateResult {
    return html`
      <div class="git-update-manager-backdrop" role="dialog" aria-modal="true" aria-label="Git Update Manager">
        <section class=${this.bounds === undefined ? "git-update-manager-frame" : "git-update-manager-frame git-update-manager-frame-positioned"} style=${this.frameStyle()}>
          <header class="git-update-manager-header">
            <span
              class="git-update-manager-drag-handle"
              @pointerdown=${this.handleMovePointerDown}
              @pointermove=${this.handlePointerMove}
              @pointerup=${this.handlePointerUp}
              @pointercancel=${this.handlePointerCancel}
            >Git Update Manager</span>
            <button type="button" class="git-update-manager-refresh" @click=${this.refresh} ?disabled=${this.loadingStatus} aria-label="Refresh changes">Refresh</button>
            <button type="button" @click=${this.close} aria-label="Close Git Update Manager">×</button>
          </header>
          ${this.error === "" ? null : html`<p class="git-update-manager-error" role="alert">${this.error}</p>`}
          <div class="git-update-manager-workspace">
            <section class="git-update-manager-entries" aria-label="Git changes">
              ${this.renderChangeList()}
            </section>
            <section class="git-update-manager-preview" aria-label="Git diff">
              ${this.renderDiffPreview()}
            </section>
          </div>
          <div
            class="git-update-manager-resize-handle"
            title="Drag to resize Git Update Manager"
            aria-hidden="true"
            @pointerdown=${this.handleResizePointerDown}
            @pointermove=${this.handlePointerMove}
            @pointerup=${this.handlePointerUp}
            @pointercancel=${this.handlePointerCancel}
          ></div>
        </section>
      </div>
    `;
  }

  private ensureWorkspaceScope(): void {
    const scope = workspaceScope(this.workspace, this.machineId);
    if (scope === this.workspaceScope) return;
    this.workspaceScope = scope;
    this.statusRequest += 1;
    this.diffRequest += 1;
    this.status = undefined;
    this.selectedChange = undefined;
    this.selectedDiff = undefined;
    this.loadingStatus = false;
    this.loadingDiff = false;
    this.error = "";
    if (scope !== undefined && this.isConnected) void this.refresh();
  }

  private renderChangeList(): TemplateResult {
    if (this.loadingStatus) return html`<p class="git-update-manager-empty">Loading changes…</p>`;
    const status = this.status;
    if (status === undefined) return html`<p class="git-update-manager-empty">Refresh to load Git changes.</p>`;
    if (!status.isGitRepo) return html`<p class="git-update-manager-empty">This workspace is not a Git repository.</p>`;

    const changes = gitUpdateChanges(status.files);
    if (changes.staged.length === 0 && changes.unstaged.length === 0) return html`<p class="git-update-manager-empty">No Git changes.</p>`;
    return html`
      ${this.renderChangeGroup("staged", changes.staged)}
      ${this.renderChangeGroup("unstaged", changes.unstaged)}
    `;
  }

  private renderChangeGroup(scope: "staged" | "unstaged", changes: readonly GitUpdateChange[]): TemplateResult | null {
    if (changes.length === 0) return null;
    const label = scopeLabel(scope);
    return html`
      <section class="git-update-manager-change-group" aria-label=${`${label} changes`}>
        <h2>${label} (${String(changes.length)})</h2>
        ${changes.map((change) => this.renderChange(change))}
      </section>
    `;
  }

  private renderChange(change: GitUpdateChange): TemplateResult {
    const selected = this.selectedChange?.id === change.id;
    const path = gitUpdateChangePath(change);
    const statusLabel = gitStatusLabel(change.state);
    const scope = scopeLabel(change.scope);
    return html`
      <button
        type="button"
        class=${`git-update-manager-entry ${selected ? "selected" : ""}`}
        aria-pressed=${selected ? "true" : "false"}
        aria-label=${`${scope} ${statusLabel}: ${path}`}
        @click=${() => { this.selectChange(change); }}
      >
        <span class=${`git-update-manager-status status-${change.state}`} title=${statusLabel} aria-hidden="true">${gitStatusIndicator(change.state)}</span>
        <span class="git-update-manager-path">${path}</span>
        <span class="git-update-manager-scope">${scope}</span>
      </button>
    `;
  }

  private renderDiffPreview(): TemplateResult {
    const change = this.selectedChange;
    if (change === undefined) return html`<p class="git-update-manager-empty">Select a Git change to review.</p>`;
    if (this.error !== "") return html`<p class="git-update-manager-empty">Could not load ${gitUpdateChangePath(change)}.</p>`;
    if (this.loadingDiff || this.selectedDiff === undefined) return html`<p class="git-update-manager-empty">Loading ${gitUpdateChangePath(change)}…</p>`;
    const diff = this.selectedDiff;
    loadUnifiedDiffViewer();
    return html`
      <header class="git-update-manager-diff-header">
        <strong>${gitUpdateChangePath(change)}</strong>
        <small>${scopeLabel(change.scope)} · ${gitStatusLabel(change.state)}${diff.truncated ? " · truncated" : ""}</small>
      </header>
      <unified-diff-viewer .diff=${diff.diff}></unified-diff-viewer>
    `;
  }

  private readonly selectChange = (change: GitUpdateChange): void => {
    const workspace = this.workspace;
    if (workspace === undefined) return;
    const machineId = this.machineId;
    this.selectedChange = change;
    this.selectedDiff = undefined;
    this.error = "";
    void this.loadDiff(change, workspace, machineId);
  };

  private async loadDiff(change: GitUpdateChange, workspace: Workspace, machineId: string): Promise<void> {
    const request = ++this.diffRequest;
    this.loadingDiff = true;
    try {
      const diff = await this.api.gitDiff(workspace.projectId, workspace.id, { path: change.path, staged: change.scope === "staged" }, machineId);
      if (request !== this.diffRequest || !this.isCurrentWorkspace(workspace, machineId) || this.selectedChange?.id !== change.id) return;
      this.selectedDiff = diff;
      this.loadingDiff = false;
      this.error = "";
    } catch (error) {
      if (request !== this.diffRequest || !this.isCurrentWorkspace(workspace, machineId) || this.selectedChange?.id !== change.id) return;
      this.selectedDiff = undefined;
      this.loadingDiff = false;
      this.error = errorMessage(error);
    }
  }

  private readonly onViewportResize = (): void => {
    if (this.bounds === undefined) return;
    this.bounds = fitGitUpdateManagerBounds(this.bounds, this.viewport());
  };

  private readonly handleMovePointerDown = (event: GitUpdateManagerPointerEvent): void => {
    this.startPointerInteraction("move", event);
  };

  private readonly handleResizePointerDown = (event: GitUpdateManagerPointerEvent): void => {
    this.startPointerInteraction("resize", event);
  };

  private readonly handlePointerMove = (event: GitUpdateManagerPointerEvent): void => {
    const interaction = this.pointerInteraction;
    if (interaction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = { x: event.clientX - interaction.startClientX, y: event.clientY - interaction.startClientY };
    this.bounds = interaction.operation === "move"
      ? moveGitUpdateManagerPanel(interaction.bounds, delta, this.viewport())
      : resizeGitUpdateManagerPanel(interaction.bounds, delta, this.viewport());
  };

  private readonly handlePointerUp = (event: GitUpdateManagerPointerEvent): void => {
    if (this.pointerInteraction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.finishPointerInteraction();
  };

  private readonly handlePointerCancel = (event: GitUpdateManagerPointerEvent): void => {
    if (this.pointerInteraction?.pointerId !== event.pointerId) return;
    this.finishPointerInteraction();
  };

  private startPointerInteraction(operation: GitUpdateManagerPointerInteraction["operation"], event: GitUpdateManagerPointerEvent): void {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const frame = target.closest(".git-update-manager-frame");
    if (!(frame instanceof HTMLElement)) return;

    event.preventDefault();
    event.stopPropagation();
    const bounds = fitGitUpdateManagerBounds(this.boundsFromFrame(frame), this.viewport());
    target.setPointerCapture(event.pointerId);
    this.bounds = bounds;
    this.pointerInteraction = {
      operation,
      pointerId: event.pointerId,
      target,
      startClientX: event.clientX,
      startClientY: event.clientY,
      bounds,
    };
  }

  private boundsFromFrame(frame: HTMLElement): GitUpdateManagerPanelBounds {
    const { left, top, width, height } = frame.getBoundingClientRect();
    return { left, top, width, height };
  }

  private viewport(): GitUpdateManagerPanelViewport {
    if (typeof window === "undefined") return { width: 0, height: 0 };
    return { width: window.innerWidth, height: window.innerHeight };
  }

  private frameStyle(): string {
    const bounds = this.bounds;
    const geometry = bounds === undefined ? "" : `left: ${String(bounds.left)}px; top: ${String(bounds.top)}px; width: ${String(bounds.width)}px; height: ${String(bounds.height)}px;`;
    return geometry;
  }

  private finishPointerInteraction(): void {
    const interaction = this.pointerInteraction;
    if (interaction === undefined) return;
    try {
      interaction.target.releasePointerCapture(interaction.pointerId);
    } catch {
      // Pointer capture may already be gone after a browser cancellation.
    }
    this.pointerInteraction = undefined;
  }

  private readonly close = (): void => {
    this.finishPointerInteraction();
    this.onClose?.();
  };

  private isCurrentWorkspace(workspace: Workspace, machineId: string): boolean {
    return this.workspace?.id === workspace.id && this.workspace.projectId === workspace.projectId && this.machineId === machineId;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 80; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .git-update-manager-backdrop { width: 100%; height: 100dvh; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, .48); }
    .git-update-manager-frame { position: relative; display: flex; flex-direction: column; width: min(calc(100vw - 32px), 1280px); height: min(calc(100vh - 32px), 880px); overflow: hidden; border: 1px solid var(--pi-border); border-radius: 14px; background: var(--pi-bg); box-shadow: 0 20px 64px var(--pi-shadow-strong); }
    .git-update-manager-frame-positioned { position: fixed; }
    .git-update-manager-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--pi-border); background: var(--pi-surface); font-weight: 600; }
    .git-update-manager-header button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text); padding: 5px 8px; font: inherit; cursor: pointer; }
    .git-update-manager-header button:disabled { cursor: wait; opacity: .65; }
    .git-update-manager-drag-handle { flex: 1 1 auto; align-self: stretch; min-width: 0; display: flex; align-items: center; cursor: move; touch-action: none; -webkit-user-select: none; user-select: none; }
    .git-update-manager-error { flex: 0 0 auto; margin: 0; border-bottom: 1px solid var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 10%, transparent); color: var(--pi-danger); padding: 8px 10px; line-height: 1.35; overflow-wrap: anywhere; }
    .git-update-manager-workspace { flex: 1 1 auto; display: grid; grid-template-columns: minmax(220px, 36%) minmax(0, 1fr); min-height: 0; }
    .git-update-manager-entries { min-width: 0; overflow: auto; padding: 10px; border-right: 1px solid var(--pi-border); }
    .git-update-manager-change-group + .git-update-manager-change-group { margin-top: 14px; }
    .git-update-manager-change-group h2 { margin: 0 0 5px; color: var(--pi-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .git-update-manager-entry { display: grid; grid-template-columns: 2ch minmax(0, 1fr) auto; width: 100%; align-items: center; gap: 7px; border: 0; border-radius: 6px; background: transparent; color: inherit; padding: 6px 7px; font: inherit; text-align: left; cursor: pointer; }
    .git-update-manager-entry:hover, .git-update-manager-entry.selected { background: color-mix(in srgb, var(--pi-accent) 14%, transparent); }
    .git-update-manager-status { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; text-align: center; }
    .status-modified, .status-renamed, .status-copied { color: var(--pi-accent); }
    .status-added, .status-untracked { color: var(--pi-success); }
    .status-deleted, .status-conflicted { color: var(--pi-danger); }
    .git-update-manager-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .git-update-manager-scope { border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); padding: 1px 5px; font-size: 11px; }
    .git-update-manager-preview { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }
    .git-update-manager-preview unified-diff-viewer { flex: 1 1 auto; min-height: 0; }
    .git-update-manager-diff-header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--pi-border); background: var(--pi-surface); }
    .git-update-manager-diff-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .git-update-manager-diff-header small { flex: 0 0 auto; color: var(--pi-muted); }
    .git-update-manager-empty { margin: 0; padding: 12px; color: var(--pi-muted); }
    .git-update-manager-resize-handle { position: absolute; right: 0; bottom: 0; z-index: 1; width: 20px; height: 20px; cursor: nwse-resize; touch-action: none; }
    .git-update-manager-resize-handle::after { content: ""; position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px; border-right: 2px solid var(--pi-muted); border-bottom: 2px solid var(--pi-muted); opacity: .7; }
    .git-update-manager-resize-handle:hover::after { border-color: var(--pi-text); opacity: 1; }
    @media (max-width: 760px) {
      .git-update-manager-backdrop { padding: 0; }
      .git-update-manager-frame { width: 100%; height: 100%; border: 0; border-radius: 0; }
      .git-update-manager-frame-positioned { position: relative; }
      .git-update-manager-drag-handle { cursor: default; }
      .git-update-manager-workspace { grid-template-columns: 1fr; grid-template-rows: minmax(190px, 40%) minmax(0, 1fr); }
      .git-update-manager-entries { border-right: 0; border-bottom: 1px solid var(--pi-border); }
    }
  `;
}

function loadUnifiedDiffViewer(): void {
  void import("./UnifiedDiffViewer");
}

function findChange(status: GitStatusResponse, id: string): GitUpdateChange | undefined {
  const changes = gitUpdateChanges(status.files);
  return [...changes.staged, ...changes.unstaged].find((change) => change.id === id);
}

function scopeLabel(scope: GitUpdateChange["scope"]): "Staged" | "Unstaged" {
  return scope === "staged" ? "Staged" : "Unstaged";
}

function workspaceScope(workspace: Workspace | undefined, machineId: string): string | undefined {
  return workspace === undefined ? undefined : JSON.stringify([machineId, workspace.projectId, workspace.id]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
