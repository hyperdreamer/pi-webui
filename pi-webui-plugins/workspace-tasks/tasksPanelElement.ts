import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import {
  TASKS_CONFIG_PATH,
  parseWorkspaceTaskRefKey,
  workspaceTaskGroupKey,
  workspaceTaskRefKey,
  type WorkspaceTask,
  type WorkspaceTaskRef,
  type WorkspaceTaskScope,
} from "@pi-webui/workspace-tasks-domain";
import { validateAndNormalizeDraft, suggestWorkspaceTaskId, type ValidateWorkspaceTaskDraftResult, type WorkspaceTaskDraft, type WorkspaceTaskDraftErrors } from "./config.js";
import { runWorkspaceTaskInTerminal } from "./taskRunner.js";

export const tasksPanelTagName = "pi-webui-workspace-tasks-panel";

interface SnapshotConfig {
  readonly version: 1;
  readonly tasks: readonly Readonly<WorkspaceTask>[];
}

type WorkspaceCatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly config: SnapshotConfig; readonly refreshing: boolean; readonly refreshError?: string }
  | { readonly kind: "missing"; readonly message: string; readonly hint: string; readonly refreshing: boolean; readonly refreshError?: string }
  | { readonly kind: "invalid"; readonly message: string; readonly hint: string; readonly detail: string }
  | { readonly kind: "unavailable"; readonly message: string; readonly hint: string; readonly detail?: string }
  | { readonly kind: "error"; readonly message: string };

type GlobalCatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly config: SnapshotConfig; readonly refreshing: boolean; readonly refreshError?: string }
  | { readonly kind: "invalid"; readonly message: string; readonly hint: string; readonly detail: string }
  | { readonly kind: "unavailable"; readonly message: string; readonly hint: string; readonly detail?: string }
  | { readonly kind: "error"; readonly message: string };

interface WorkspaceTasksPanelState {
  readonly workspace: WorkspaceCatalogState;
  readonly global: GlobalCatalogState;
  readonly move?: { readonly kind: "partial" | "unknown-outcome" | "conflict"; readonly message: string; readonly retryAllowed: boolean };
  readonly mutationGate?: { readonly scopes: readonly WorkspaceTaskScope[]; readonly message: string };
}

interface WorkspaceTasksPanelActions {
  create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void>;
  update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>;
  remove(ref: WorkspaceTaskRef): Promise<void>;
  move(ref: WorkspaceTaskRef, destinationTask: WorkspaceTask): Promise<void>;
  retryMove(): Promise<void>;
  refresh(): Promise<void>;
}

type InternalWorkspacePanelContext = WorkspacePanelContext & { readonly workspaceTasks?: { readonly state: WorkspaceTasksPanelState; readonly actions: WorkspaceTasksPanelActions } };
type PanelFilter = "all" | WorkspaceTaskScope;
type PanelMode = "view" | "add" | "edit" | "delete-confirm" | "move-confirm" | "refresh-discard-confirm";
type OperationKind = "refresh" | "mutation";

type FocusTarget =
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly ref: WorkspaceTaskRef }
  | { readonly kind: "delete"; readonly ref: WorkspaceTaskRef }
  | { readonly kind: "refresh" }
  | { readonly kind: "heading" };

interface PanelOperation {
  readonly kind: OperationKind;
  readonly scopes: readonly WorkspaceTaskScope[];
}

interface SourceStateObservation {
  lastKey: string;
  delivered: boolean;
}

interface ActionStateObservation {
  readonly sources: Readonly<Record<WorkspaceTaskScope, SourceStateObservation>>;
  readonly mutationGateKey: string | undefined;
}

interface CatalogFailure {
  readonly message: string;
}

interface PendingActionBase {
  readonly generation: number;
  readonly scopes: readonly WorkspaceTaskScope[];
  readonly observation: ActionStateObservation;
  readonly focusReturn: FocusTarget;
  settled: boolean;
}

interface PendingRefreshAction extends PendingActionBase {
  readonly kind: "refresh";
}

interface PendingSaveAction extends PendingActionBase {
  readonly kind: "save";
  readonly scope: WorkspaceTaskScope;
  readonly task: WorkspaceTask;
}

interface PendingDeleteAction extends PendingActionBase {
  readonly kind: "delete";
  readonly ref: WorkspaceTaskRef;
  readonly task: WorkspaceTask;
}

type PendingAction = PendingRefreshAction | PendingSaveAction | PendingDeleteAction;

interface EditorState {
  draft: WorkspaceTaskDraft;
  initialDraft: WorkspaceTaskDraft;
  sourceRef: WorkspaceTaskRef | undefined;
  originalIndex: number | undefined;
  focusReturn: FocusTarget;
}

interface DeleteState {
  readonly ref: WorkspaceTaskRef;
  readonly task: WorkspaceTask;
  readonly focusReturn: FocusTarget;
}

interface TaskStatus {
  readonly kind: "info" | "success" | "error";
  readonly message: string;
  readonly detail?: string;
}

export function defineTasksPanelElement(): void {
  if (typeof customElements !== "undefined" && !customElements.get(tasksPanelTagName)) {
    customElements.define(tasksPanelTagName, PiWebUiTasksPanel);
  }
}

export function tasksPanelBadge(context: WorkspacePanelContext): string | undefined {
  // The bundled contribution receives this bridge only from the core app.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const bridge = (context as InternalWorkspacePanelContext).workspaceTasks;
  if (bridge === undefined) return undefined;
  const state = bridge.state;
  if (state.move !== undefined || state.mutationGate !== undefined) return "!";
  if (catalogNeedsAttention(state.workspace) || catalogNeedsAttention(state.global)) return "!";
  return undefined;
}

// Non-browser plugin activation tests still import this module, so keep the
// custom element base safe when DOM globals are not installed.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class NoopElement {}
function noopElementConstructor(): typeof HTMLElement {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return NoopElement as unknown as typeof HTMLElement;
}
const BaseElement: typeof HTMLElement = typeof HTMLElement === "undefined" ? noopElementConstructor() : HTMLElement;

class PiWebUiTasksPanel extends BaseElement {
  private contextValue: WorkspacePanelContext | undefined;
  private stateValue: WorkspaceTasksPanelState = emptyPanelState();
  private actionsValue: WorkspaceTasksPanelActions = noOpActions();
  private filter: PanelFilter = "all";
  private mode: PanelMode = "view";
  private operation: PanelOperation | undefined;
  private editor: EditorState | undefined;
  private deleteState: DeleteState | undefined;
  private pendingRefreshFocus: FocusTarget | undefined;
  private validationErrors: WorkspaceTaskDraftErrors | undefined;
  private status: TaskStatus | undefined;
  private runningTaskKey: string | undefined;
  private pendingAction: PendingAction | undefined;
  private idManuallyEdited = false;
  private connected = false;
  private selectionGeneration = 0;
  private terminalGeneration = 0;
  private readonly expandedGroupKeys = new Set<string>();
  private moveRecoveryObserved = false;
  private readonly root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.addEventListener("keydown", (event) => {
      if (event instanceof KeyboardEvent) this.handleKeyDown(event);
    });
  }

  set context(value: WorkspacePanelContext | undefined) {
    const previousKey = contextKey(this.contextValue);
    const nextKey = contextKey(value);
    this.contextValue = value;
    if (previousKey === nextKey) {
      this.render();
      return;
    }
    this.selectionGeneration += 1;
    this.terminalGeneration += 1;
    this.operation = undefined;
    this.pendingAction = undefined;
    this.editor = undefined;
    this.deleteState = undefined;
    this.pendingRefreshFocus = undefined;
    this.validationErrors = undefined;
    this.status = undefined;
    this.runningTaskKey = undefined;
    this.mode = "view";
    this.filter = "all";
    this.idManuallyEdited = false;
    this.moveRecoveryObserved = false;
    this.render();
  }

  set workspaceTasksState(value: WorkspaceTasksPanelState) {
    const previous = this.stateValue;
    this.stateValue = value;
    this.recordPendingSourceObservations(value, previous !== value);
    if (value.move !== undefined) this.moveRecoveryObserved = true;
    this.rememberOpenGroups();
    this.pruneExpandedGroups();
    if (this.reconcilePendingAction()) return;
    if (previous.move !== undefined && value.move === undefined && this.moveRecoveryObserved && this.editor !== undefined) {
      if (this.isMoveComplete(this.editor, value)) {
        const target = this.editor.focusReturn;
        this.editor = undefined;
        this.mode = "view";
        this.validationErrors = undefined;
        this.moveRecoveryObserved = false;
        this.status = { kind: "success", message: "Task move completed." };
        this.render();
        this.focusTarget(target);
        return;
      }
      this.status = { kind: "info", message: "Move was not completed. Confirm the move again after reviewing the catalogs." };
    }
    this.render();
  }

  get workspaceTasksState(): WorkspaceTasksPanelState {
    return this.stateValue;
  }

  set workspaceTasksActions(value: WorkspaceTasksPanelActions) {
    this.actionsValue = value;
    this.render();
  }

  get workspaceTasksActions(): WorkspaceTasksPanelActions {
    return this.actionsValue;
  }

  connectedCallback(): void {
    this.connected = true;
    this.render();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.selectionGeneration += 1;
    this.terminalGeneration += 1;
    this.operation = undefined;
    this.pendingAction = undefined;
    this.runningTaskKey = undefined;
  }

  private render(): void {
    this.rememberOpenGroups();
    this.pruneExpandedGroups();
    if (this.contextValue === undefined) {
      this.root.innerHTML = `${taskStyles()}<section class="empty">Select a workspace.</section>`;
      return;
    }

    const canAdd = this.canWriteScope("workspace") || this.canWriteScope("global");
    const toolbarDisabled = this.operation !== undefined || this.mode === "refresh-discard-confirm";
    this.root.innerHTML = `
      ${taskStyles()}
      <main class="tasks-panel" data-panel-mode="${escapeAttr(this.mode)}">
        <section class="toolbar">
          <h2 data-panel-heading tabindex="-1">Workspace Tasks</h2>
          <span class="toolbar-tasks">
            ${canAdd ? `<button type="button" class="secondary" data-add-task>Add Task</button>` : ""}
            <button type="button" class="secondary" data-refresh ${toolbarDisabled ? "disabled" : ""}>Refresh</button>
            <button type="button" class="secondary" data-open-terminal>Open Terminal</button>
          </span>
        </section>
        ${this.renderStatus()}
        <section class="viewer tasks-viewer">
          ${this.renderBody()}
        </section>
      </main>
    `;
    this.bindHandlers();
  }

  private renderStatus(): string {
    const parts: string[] = [];
    const gate = this.stateValue.mutationGate;
    if (gate !== undefined) {
      parts.push(`<div class="status warning" data-mutation-gate role="status">${escapeHtml(gate.message)}</div>`);
    }
    const move = this.stateValue.move;
    if (move !== undefined) {
      const retryDisabled = !move.retryAllowed || this.operation !== undefined;
      parts.push(`<div class="status warning" data-move-state role="status">
        <strong>${escapeHtml(move.kind === "partial" ? "Move recovery pending." : move.kind === "conflict" ? "Manual resolution required." : "Move outcome needs verification.")}</strong>
        <p>${escapeHtml(move.message)}</p>
        ${move.kind === "conflict" ? `<p data-manual-resolution>Refresh the catalogs and resolve the definitions manually.</p>` : ""}
        <button type="button" class="secondary" data-retry-move ${retryDisabled ? "disabled" : ""}>Retry move</button>
      </div>`);
    }
    if (this.status !== undefined) {
      const detail = this.status.detail === undefined ? "" : `<pre class="diagnostic">${escapeHtml(this.status.detail)}</pre>`;
      parts.push(`<div class="status panel-status ${escapeAttr(this.status.kind)}" data-panel-status role="status" aria-live="polite" tabindex="-1">${escapeHtml(this.status.message)}${detail}</div>`);
    }
    return parts.join("");
  }

  private renderBody(): string {
    if (this.mode === "add" || this.mode === "edit") return this.renderEditor();
    if (this.mode === "delete-confirm") return this.renderDeleteConfirmation();
    if (this.mode === "move-confirm") return this.renderMoveConfirmation();
    if (this.mode === "refresh-discard-confirm") return this.renderRefreshDiscardConfirmation();
    return this.renderView();
  }

  private renderView(): string {
    const workspaceCount = loadedCount(this.stateValue.workspace);
    const globalCount = loadedCount(this.stateValue.global);
    return `
      <section class="scope-filters" role="group" aria-label="Task scope">
        ${this.renderFilterButton("all", "All", workspaceCount + globalCount)}
        ${this.renderFilterButton("global", "Global", globalCount)}
        ${this.renderFilterButton("workspace", "Project", workspaceCount)}
      </section>
      <p class="muted helper">Tasks run as one script in one dedicated terminal rooted at the selected workspace. Use <code>set -e</code> or <code>&amp;&amp;</code> when the script should stop after a failure.</p>
      <div class="catalog-list">
        ${this.filter === "all" || this.filter === "global" ? this.renderCatalog("global", "Global tasks", this.stateValue.global) : ""}
        ${this.filter === "all" || this.filter === "workspace" ? this.renderCatalog("workspace", "Project tasks", this.stateValue.workspace) : ""}
      </div>
    `;
  }

  private renderFilterButton(filter: PanelFilter, label: string, count: number): string {
    return `<button type="button" class="scope-filter ${this.filter === filter ? "selected" : ""}" data-filter="${filter}" aria-pressed="${this.filter === filter ? "true" : "false"}">${escapeHtml(label)} <span class="count">${String(count)}</span></button>`;
  }

  private renderCatalog(scope: WorkspaceTaskScope, heading: string, catalog: WorkspaceCatalogState | GlobalCatalogState): string {
    const label = scopeLabel(scope);
    const warning = catalog.kind === "loaded" || catalog.kind === "missing"
      ? catalog.refreshError === undefined ? "" : `<p class="status warning" data-refresh-error>${escapeHtml(catalog.refreshError)}</p>`
      : "";
    let body: string;
    if (catalog.kind === "loading") {
      body = `<p class="muted" data-catalog-loading>Loading ${escapeHtml(label)} tasks...</p>`;
    } else if (catalog.kind === "invalid" || catalog.kind === "unavailable" || catalog.kind === "error") {
      const hint = catalog.kind === "error" ? "" : `<p>${escapeHtml(catalog.hint)}</p>`;
      const detail = catalog.kind === "invalid" || catalog.kind === "unavailable" && catalog.detail !== undefined
        ? `<pre class="diagnostic">${escapeHtml(catalog.detail)}</pre>`
        : "";
      body = `<div class="status error" data-catalog-error><strong>${escapeHtml(catalog.message)}</strong>${hint}${detail}</div>`;
    } else if (catalog.kind === "missing") {
      body = `${warning}<p class="empty-state"><strong>No Project task catalog is configured.</strong><span>Create ${escapeHtml(TASKS_CONFIG_PATH)} in this workspace or add a task here.</span></p>`;
    } else if (catalog.config.tasks.length === 0) {
      body = `${warning}<p class="empty-state">No ${escapeHtml(label.toLowerCase())} tasks are defined.</p>`;
    } else {
      body = `${warning}${renderTaskGroups(scope, catalog.config.tasks, this.runningTaskKey, this.isScopeDisabled(scope), this.expandedGroupKeys)}`;
    }
    return `<section class="scope-catalog" data-catalog-scope="${scope}">
      <h3>${escapeHtml(heading)} <span class="catalog-count">${String(loadedCount(catalog))}</span></h3>
      ${body}
    </section>`;
  }

  private renderEditor(): string {
    const editor = this.editor;
    if (editor === undefined) return "";
    const targetScope: WorkspaceTaskScope = editor.draft.global ? "global" : "workspace";
    const validation = this.validateEditor();
    const errors = this.validationErrors ?? {};
    const locked = this.operation !== undefined || this.stateValue.move !== undefined || this.isScopeDisabled(targetScope);
    const canWrite = this.canWriteScope(targetScope);
    const saveDisabled = locked || !canWrite || !validation.ok;
    const heading = editor.sourceRef === undefined ? "Add Task" : "Edit Task";
    const sourceLabel = editor.sourceRef === undefined ? scopeLabel(targetScope) : scopeLabel(editor.sourceRef.scope);
    return `
      <section class="task-editor" data-task-editor>
        <div class="editor-heading"><h3>${heading}</h3><span class="scope-badge" data-scope-badge>${escapeHtml(`${sourceLabel} task`)}</span></div>
        <form class="task-form" data-task-form>
          <label for="task-title">Title <span class="required" aria-hidden="true">*</span></label>
          <input id="task-title" name="title" type="text" value="${escapeAttr(editor.draft.title)}" placeholder="Build app" data-editor-title aria-required="true"${fieldAttrs("title", errors.title, locked)}>
          ${renderFieldError("title", errors.title)}

          <label for="task-command">Command script <span class="required" aria-hidden="true">*</span></label>
          <textarea id="task-command" name="command" data-editor-command aria-required="true" aria-describedby="task-command-help${errors.command === undefined ? "" : " task-command-error"}"${errors.command === undefined ? "" : " aria-invalid=\"true\""}${locked ? " disabled" : ""}>${escapeHtml(editor.draft.command)}</textarea>
          <p id="task-command-help" class="field-help">Runs once in one terminal through the server shell. Use <code>set -e</code> or <code>&amp;&amp;</code> for fail-fast behavior.</p>
          ${renderFieldError("command", errors.command)}

          <label for="task-id">ID <span class="required" aria-hidden="true">*</span></label>
          <input id="task-id" name="id" type="text" value="${escapeAttr(editor.draft.id)}" placeholder="Auto-generated from title" data-editor-id aria-required="true"${fieldAttrs("id", errors.id, locked)}>
          ${renderFieldError("id", errors.id)}

          <label for="task-description">Description</label>
          <input id="task-description" name="description" type="text" value="${escapeAttr(editor.draft.description)}" placeholder="Optional description" data-editor-description ${locked ? "disabled" : ""}>

          <label for="task-group">Group</label>
          <input id="task-group" name="group" type="text" value="${escapeAttr(editor.draft.group)}" placeholder="Optional group name" data-editor-group ${locked ? "disabled" : ""}>

          <span class="checkbox-field">
            <input id="task-global" name="global" type="checkbox" data-editor-global ${editor.draft.global ? "checked" : ""} ${locked ? "disabled" : ""}>
            <label for="task-global">Available in all projects on this machine</label>
          </span>
          <p class="field-help" data-scope-help>Global definitions run in the currently selected workspace root. Project definitions are stored in ${escapeHtml(TASKS_CONFIG_PATH)} for this workspace.</p>

          <span class="checkbox-field">
            <input id="task-confirm" name="confirm" type="checkbox" ${editor.draft.confirm ? "checked" : ""} data-editor-confirm ${locked ? "disabled" : ""}>
            <label for="task-confirm">Require confirmation before running</label>
          </span>

          <div class="editor-actions">
            <button type="button" class="secondary" data-cancel-editor>Cancel</button>
            <button type="button" class="primary" data-save-task ${saveDisabled ? "disabled" : ""}>Save Task</button>
          </div>
        </form>
      </section>
    `;
  }

  private renderDeleteConfirmation(): string {
    const pending = this.deleteState;
    if (pending === undefined) return "";
    const label = scopeLabel(pending.ref.scope);
    return `<section class="confirmation" data-delete-confirmation>
      <div class="editor-heading"><h3>Delete Task</h3><span class="scope-badge">${escapeHtml(`${label} task`)}</span></div>
      <p>Are you sure you want to delete <strong>${escapeHtml(pending.task.title)}</strong> (${escapeHtml(label)})?</p>
      <pre class="task-script">${escapeHtml(pending.task.command)}</pre>
      <div class="editor-actions">
        <button type="button" class="secondary" data-cancel-delete>Cancel</button>
        <button type="button" class="danger" data-confirm-delete aria-label="Delete ${escapeAttr(pending.task.title)} (${escapeAttr(label)})" ${this.operation === undefined && !this.isScopeDisabled(pending.ref.scope) ? "" : "disabled"}>Delete Task</button>
      </div>
    </section>`;
  }

  private renderMoveConfirmation(): string {
    const editor = this.editor;
    if (editor?.sourceRef === undefined) return "";
    const source = scopeLabel(editor.sourceRef.scope);
    const destination = scopeLabel(editor.draft.global ? "global" : "workspace");
    const validation = this.validateEditor();
    return `<section class="confirmation" data-move-confirmation>
      <div class="editor-heading"><h3>Change Task Scope</h3><span class="scope-badge">${escapeHtml(`${source} to ${destination}`)}</span></div>
      <p>Move <strong>${escapeHtml(editor.draft.title)}</strong> from ${escapeHtml(source)} to ${escapeHtml(destination)}? The source definition will be removed.</p>
      <pre class="task-script">${escapeHtml(validation.ok ? validation.task.command : editor.draft.command)}</pre>
      <div class="editor-actions">
        <button type="button" class="secondary" data-cancel-move>Cancel</button>
        <button type="button" class="primary" data-confirm-move ${this.operation === undefined && validation.ok ? "" : "disabled"}>Confirm move</button>
      </div>
    </section>`;
  }

  private renderRefreshDiscardConfirmation(): string {
    return `<section class="confirmation" data-refresh-discard-confirmation>
      <h3>Discard draft and refresh?</h3>
      <p>Your unsaved task draft will be discarded. Refresh loads the authoritative catalogs.</p>
      <div class="editor-actions">
        <button type="button" class="secondary" data-cancel-refresh-discard>Cancel</button>
        <button type="button" class="primary" data-confirm-refresh-discard>Discard &amp; Refresh</button>
      </div>
    </section>`;
  }

  private bindHandlers(): void {
    this.root.querySelector<HTMLButtonElement>("[data-add-task]")?.addEventListener("click", () => { this.openAddTaskEditor(); });
    this.root.querySelector<HTMLButtonElement>("[data-refresh]")?.addEventListener("click", () => { void this.requestRefresh(); });
    this.root.querySelector<HTMLButtonElement>("[data-open-terminal]")?.addEventListener("click", () => { this.openWorkspaceTerminal(); });
    this.root.querySelector<HTMLButtonElement>("[data-retry-move]")?.addEventListener("click", () => { void this.retryMove(); });
    this.root.querySelector<HTMLButtonElement>("[data-cancel-editor]")?.addEventListener("click", () => { this.cancelEditor(); });
    this.root.querySelector<HTMLButtonElement>("[data-save-task]")?.addEventListener("click", () => { void this.saveTask(); });
    this.root.querySelector<HTMLButtonElement>("[data-cancel-delete]")?.addEventListener("click", () => { this.cancelDelete(); });
    this.root.querySelector<HTMLButtonElement>("[data-confirm-delete]")?.addEventListener("click", () => { void this.confirmDelete(); });
    this.root.querySelector<HTMLButtonElement>("[data-cancel-move]")?.addEventListener("click", () => { this.cancelMove(); });
    this.root.querySelector<HTMLButtonElement>("[data-confirm-move]")?.addEventListener("click", () => { void this.confirmMove(); });
    this.root.querySelector<HTMLButtonElement>("[data-cancel-refresh-discard]")?.addEventListener("click", () => { this.cancelRefreshDiscard(); });
    this.root.querySelector<HTMLButtonElement>("[data-confirm-refresh-discard]")?.addEventListener("click", () => { void this.confirmRefreshDiscard(); });

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-filter]")) {
      button.addEventListener("click", () => {
        const value = button.getAttribute("data-filter");
        if (value === "all" || value === "global" || value === "workspace") {
          this.filter = value;
          this.render();
        }
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-edit-task]")) {
      button.addEventListener("click", () => { this.openEditTaskEditor(button.getAttribute("data-edit-task")); });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-delete-task]")) {
      button.addEventListener("click", () => { this.openDeleteConfirmation(button.getAttribute("data-delete-task")); });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-run-task]")) {
      button.addEventListener("click", () => { void this.dispatchTask(button.getAttribute("data-run-task")); });
    }
    for (const details of this.root.querySelectorAll<HTMLDetailsElement>("details[data-group-key]")) {
      details.addEventListener("toggle", () => {
        const key = details.getAttribute("data-group-key");
        if (key === null) return;
        if (details.open) this.expandedGroupKeys.add(key);
        else this.expandedGroupKeys.delete(key);
      });
    }

    this.bindEditorInputs();
  }

  private bindEditorInputs(): void {
    const title = this.root.querySelector<HTMLInputElement>("[data-editor-title]");
    title?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.title = event.target.value;
      if (!this.idManuallyEdited) {
        this.editor.draft.id = suggestWorkspaceTaskId(event.target.value);
        const id = this.root.querySelector<HTMLInputElement>("[data-editor-id]");
        if (id !== null) id.value = this.editor.draft.id;
      }
      this.updateValidationInPlace();
    });
    const id = this.root.querySelector<HTMLInputElement>("[data-editor-id]");
    id?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.id = event.target.value;
      this.idManuallyEdited = true;
      this.updateValidationInPlace();
    });
    const command = this.root.querySelector<HTMLTextAreaElement>("[data-editor-command]");
    command?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLTextAreaElement) || this.editor === undefined) return;
      this.editor.draft.command = event.target.value;
      this.updateValidationInPlace();
    });
    for (const [selector, field] of [["[data-editor-description]", "description"], ["[data-editor-group]", "group"]] as const) {
      this.root.querySelector<HTMLInputElement>(selector)?.addEventListener("input", (event) => {
        if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
        this.editor.draft[field] = event.target.value;
        this.updateValidationInPlace();
      });
    }
    this.root.querySelector<HTMLInputElement>("[data-editor-global]")?.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.global = event.target.checked;
      this.updateValidationInPlace();
      const badge = this.root.querySelector<HTMLElement>("[data-scope-badge]");
      if (badge !== null) badge.textContent = `${scopeLabel(this.editor.draft.global ? "global" : "workspace")} task`;
    });
    this.root.querySelector<HTMLInputElement>("[data-editor-confirm]")?.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.confirm = event.target.checked;
      this.updateValidationInPlace();
    });
    this.root.querySelector<HTMLFormElement>("[data-task-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveTask();
    });
  }

  private openAddTaskEditor(): void {
    if (this.contextValue === undefined || this.operation !== undefined || !this.canWriteScope("workspace") && !this.canWriteScope("global")) return;
    const draft = emptyDraft();
    this.editor = { draft, initialDraft: cloneDraft(draft), sourceRef: undefined, originalIndex: undefined, focusReturn: { kind: "add" } };
    this.mode = "add";
    this.status = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = false;
    this.moveRecoveryObserved = false;
    this.render();
    this.focusSelector("[data-editor-title]");
  }

  private openEditTaskEditor(key: string | null): void {
    if (this.operation !== undefined || key === null) return;
    const ref = parseRef(key);
    if (ref === undefined) return;
    const found = this.findTask(ref);
    if (found === undefined) {
      this.setError("That task is no longer available. Refresh, then try again.");
      return;
    }
    const draft: WorkspaceTaskDraft = {
      id: found.task.id,
      title: found.task.title,
      command: found.task.command,
      description: found.task.description ?? "",
      group: found.task.group ?? "",
      confirm: found.task.confirm,
      global: ref.scope === "global",
    };
    this.editor = {
      draft,
      initialDraft: cloneDraft(draft),
      sourceRef: ref,
      originalIndex: found.index,
      focusReturn: { kind: "edit", ref },
    };
    this.mode = "edit";
    this.status = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = true;
    this.moveRecoveryObserved = false;
    this.render();
    this.focusSelector("[data-editor-title]");
  }

  private openDeleteConfirmation(key: string | null): void {
    if (this.operation !== undefined || key === null) return;
    const ref = parseRef(key);
    if (ref === undefined) return;
    const found = this.findTask(ref);
    if (found === undefined) {
      this.setError("That task is no longer available. Refresh, then try again.");
      return;
    }
    this.deleteState = { ref, task: cloneTask(found.task), focusReturn: { kind: "delete", ref } };
    this.mode = "delete-confirm";
    this.status = undefined;
    this.render();
    this.focusSelector("[data-cancel-delete]");
  }

  private cancelEditor(): void {
    if (this.operation !== undefined) return;
    const target = this.editor?.focusReturn;
    this.editor = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = false;
    this.moveRecoveryObserved = false;
    this.mode = "view";
    this.status = undefined;
    this.render();
    this.focusTarget(target);
  }

  private cancelDelete(): void {
    if (this.operation !== undefined) return;
    const target = this.deleteState?.focusReturn;
    this.deleteState = undefined;
    this.mode = "view";
    this.status = undefined;
    this.render();
    this.focusTarget(target);
  }

  private cancelMove(): void {
    if (this.operation !== undefined || this.editor === undefined) return;
    this.mode = this.editor.sourceRef === undefined ? "add" : "edit";
    this.render();
    this.focusSelector("[data-editor-title]");
  }

  private cancelRefreshDiscard(): void {
    if (this.operation !== undefined) return;
    const target = this.editor?.focusReturn;
    this.mode = this.editor?.sourceRef === undefined ? "add" : "edit";
    this.pendingRefreshFocus = undefined;
    this.render();
    this.focusTarget(target);
  }

  private async confirmRefreshDiscard(): Promise<void> {
    if (this.mode !== "refresh-discard-confirm") return;
    const target = this.pendingRefreshFocus ?? { kind: "refresh" as const };
    this.editor = undefined;
    this.deleteState = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = false;
    this.moveRecoveryObserved = false;
    this.mode = "view";
    this.pendingRefreshFocus = target;
    await this.requestRefresh(true);
  }

  private async requestRefresh(force = false): Promise<void> {
    if (this.operation !== undefined) return;
    if (!force && this.isEditorDirty()) {
      this.pendingRefreshFocus = this.editor?.focusReturn;
      this.mode = "refresh-discard-confirm";
      this.status = undefined;
      this.render();
      this.focusSelector("[data-cancel-refresh-discard]");
      return;
    }
    const target = this.pendingRefreshFocus ?? this.editor?.focusReturn ?? { kind: "refresh" as const };
    this.pendingRefreshFocus = undefined;
    this.editor = undefined;
    this.deleteState = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = false;
    this.moveRecoveryObserved = false;
    this.mode = "view";
    this.operation = { kind: "refresh", scopes: [] };
    const observation = this.captureActionState();
    const generation = this.selectionGeneration;
    const pending: PendingRefreshAction = {
      kind: "refresh",
      generation,
      scopes: ["workspace", "global"],
      observation,
      focusReturn: target,
      settled: false,
    };
    this.pendingAction = pending;
    this.status = { kind: "info", message: "Refreshing workspace task catalogs..." };
    this.render();
    try {
      await this.actionsValue.refresh();
      if (!this.ownsSelection(generation) || this.pendingAction !== pending) return;
      pending.settled = true;
      this.reconcilePendingAction();
    } catch (error) {
      if (!this.ownsSelection(generation) || this.pendingAction !== pending) return;
      this.pendingAction = undefined;
      this.operation = undefined;
      this.status = { kind: "error", message: "Could not refresh workspace task catalogs.", detail: formatError(error) };
      this.render();
    }
  }

  private async saveTask(): Promise<void> {
    const editor = this.editor;
    if (editor === undefined || this.operation !== undefined || (this.mode !== "add" && this.mode !== "edit")) return;
    const validation = this.validateEditor();
    if (!validation.ok) {
      this.validationErrors = validation.errors;
      this.status = { kind: "error", message: "Fix the highlighted fields before saving." };
      this.render();
      this.focusFirstInvalid(validation.errors);
      return;
    }
    const destinationScope: WorkspaceTaskScope = editor.draft.global ? "global" : "workspace";
    if (!this.canWriteScope(destinationScope)) return;
    if (editor.sourceRef !== undefined && editor.sourceRef.scope !== destinationScope) {
      this.mode = "move-confirm";
      this.status = undefined;
      this.render();
      this.focusSelector("[data-cancel-move]");
      return;
    }

    if (editor.sourceRef !== undefined && !this.isEditorDirty()) {
      const target = editor.focusReturn;
      this.editor = undefined;
      this.mode = "view";
      this.validationErrors = undefined;
      this.idManuallyEdited = false;
      this.status = { kind: "info", message: "No changes to save." };
      this.render();
      this.focusTarget(target);
      return;
    }

    const generation = this.selectionGeneration;
    const observation = this.captureActionState();
    const pending: PendingSaveAction = {
      kind: "save",
      generation,
      scopes: [destinationScope],
      observation,
      focusReturn: editor.focusReturn,
      scope: destinationScope,
      task: cloneTask(validation.task),
      settled: false,
    };
    this.pendingAction = pending;
    this.operation = { kind: "mutation", scopes: [destinationScope] };
    this.status = { kind: "info", message: editor.sourceRef === undefined ? "Creating workspace task..." : "Saving workspace task..." };
    this.render();
    try {
      if (editor.sourceRef === undefined) await this.actionsValue.create(destinationScope, validation.task);
      else await this.actionsValue.update(editor.sourceRef, validation.task);
      if (!this.ownsSelection(generation) || this.pendingAction !== pending) return;
      pending.settled = true;
      this.reconcilePendingAction();
    } catch (error) {
      if (!this.ownsSelection(generation) || this.pendingAction !== pending) return;
      this.pendingAction = undefined;
      this.operation = undefined;
      this.status = { kind: "error", message: "Could not save workspace task.", detail: formatError(error) };
      this.render();
    }
  }

  private async confirmMove(): Promise<void> {
    const editor = this.editor;
    if (editor?.sourceRef === undefined || this.operation !== undefined || this.mode !== "move-confirm") return;
    const validation = this.validateEditor();
    if (!validation.ok) return;
    const generation = this.selectionGeneration;
    this.operation = { kind: "mutation", scopes: ["workspace", "global"] };
    this.status = { kind: "info", message: "Moving workspace task..." };
    this.render();
    try {
      await this.actionsValue.move(editor.sourceRef, validation.task);
      if (!this.ownsSelection(generation)) return;
      this.operation = undefined;
      if (this.stateValue.move !== undefined || this.mutationBlocked("workspace") || this.mutationBlocked("global")) {
        this.status = this.stateValue.move === undefined ? { kind: "error", message: this.stateValue.mutationGate?.message ?? "Refresh before trying another task change." } : undefined;
        this.render();
        return;
      }
      if (this.moveRecoveryObserved && !this.isMoveComplete(editor, this.stateValue)) {
        this.status = { kind: "info", message: "Move was not completed. Confirm the move again after reviewing the catalogs." };
        this.render();
        return;
      }
      const target = editor.focusReturn;
      this.editor = undefined;
      this.mode = "view";
      this.validationErrors = undefined;
      this.moveRecoveryObserved = false;
      this.status = { kind: "success", message: `Moved task "${validation.task.title}".` };
      this.render();
      this.focusTarget(target);
    } catch (error) {
      if (!this.ownsSelection(generation)) return;
      this.operation = undefined;
      this.status = { kind: "error", message: "Could not move workspace task.", detail: formatError(error) };
      this.render();
    }
  }

  private async confirmDelete(): Promise<void> {
    const pending = this.deleteState;
    if (pending === undefined || this.operation !== undefined || this.isScopeDisabled(pending.ref.scope)) return;
    const generation = this.selectionGeneration;
    const observation = this.captureActionState();
    const pendingAction: PendingDeleteAction = {
      kind: "delete",
      generation,
      scopes: [pending.ref.scope],
      observation,
      focusReturn: pending.focusReturn,
      ref: { ...pending.ref },
      task: cloneTask(pending.task),
      settled: false,
    };
    this.pendingAction = pendingAction;
    this.operation = { kind: "mutation", scopes: [pending.ref.scope] };
    this.status = { kind: "info", message: "Deleting workspace task..." };
    this.render();
    try {
      await this.actionsValue.remove(pending.ref);
      if (!this.ownsSelection(generation) || this.pendingAction !== pendingAction) return;
      pendingAction.settled = true;
      this.reconcilePendingAction();
    } catch (error) {
      if (!this.ownsSelection(generation) || this.pendingAction !== pendingAction) return;
      this.pendingAction = undefined;
      this.operation = undefined;
      this.status = { kind: "error", message: "Could not delete workspace task.", detail: formatError(error) };
      this.render();
    }
  }

  private async retryMove(): Promise<void> {
    if (this.operation !== undefined || this.stateValue.move?.retryAllowed !== true) return;
    const generation = this.selectionGeneration;
    this.operation = { kind: "mutation", scopes: ["workspace", "global"] };
    this.status = { kind: "info", message: "Retrying workspace task move..." };
    this.render();
    try {
      await this.actionsValue.retryMove();
      if (!this.ownsSelection(generation)) return;
      this.operation = undefined;
      this.status = undefined;
      this.render();
    } catch (error) {
      if (!this.ownsSelection(generation)) return;
      this.operation = undefined;
      this.status = { kind: "error", message: "Could not retry workspace task move.", detail: formatError(error) };
      this.render();
    }
  }

  private async dispatchTask(key: string | null): Promise<void> {
    if (this.contextValue === undefined || key === null || this.runningTaskKey !== undefined) return;
    const ref = parseRef(key);
    if (ref === undefined) return;
    const found = this.findTask(ref);
    if (found === undefined) {
      this.setError("That task is no longer available. Refresh, then try again.");
      return;
    }
    if (found.task.confirm && !window.confirm(`Run ${found.task.title} (${scopeLabel(ref.scope)})?\n\n${found.task.command}`)) {
      this.status = { kind: "info", message: `Cancelled ${found.task.title}.` };
      this.render();
      return;
    }
    const selection = this.selectionGeneration;
    const terminal = ++this.terminalGeneration;
    this.runningTaskKey = workspaceTaskRefKey(ref);
    this.status = { kind: "info", message: `Starting ${found.task.title}...` };
    this.render();
    try {
      const handle = await runWorkspaceTaskInTerminal(this.contextValue.terminal, ref, found.task);
      if (!this.ownsTerminal(selection, terminal)) return;
      this.runningTaskKey = undefined;
      this.status = { kind: "success", message: `Started terminal command "${handle.run.title}".`, detail: found.task.command };
      this.render();
    } catch (error) {
      if (!this.ownsTerminal(selection, terminal)) return;
      this.runningTaskKey = undefined;
      this.status = { kind: "error", message: formatError(error) };
      this.render();
    }
  }

  private openWorkspaceTerminal(): void {
    if (this.contextValue === undefined) {
      this.setError("Select a workspace before opening a terminal.");
      return;
    }
    this.contextValue.terminal.open();
  }

  private validateEditor(): ValidateWorkspaceTaskDraftResult {
    const editor = this.editor;
    if (editor === undefined) return { ok: false, errors: { title: "Title is required." } };
    const scope: WorkspaceTaskScope = editor.draft.global ? "global" : "workspace";
    const catalog = this.catalog(scope);
    const existing = catalog.kind === "loaded" ? catalog.config.tasks : [];
    const originalIndex = editor.sourceRef?.scope === scope ? editor.originalIndex : undefined;
    return validateAndNormalizeDraft(editor.draft, existing, originalIndex);
  }

  private updateValidationInPlace(): void {
    if (this.editor === undefined) return;
    const validation = this.validateEditor();
    this.validationErrors = validation.ok ? undefined : validation.errors;
    const errors = this.validationErrors ?? {};
    for (const [field, id] of [["title", "task-title"], ["command", "task-command"], ["id", "task-id"]] as const) {
      const control = this.root.querySelector<HTMLElement>(`#${id}`);
      const errorElement = this.root.querySelector<HTMLElement>(`[data-field-error="${field}"]`);
      if (control === null || errorElement === null) continue;
      const error = errors[field];
      if (error === undefined) {
        control.removeAttribute("aria-invalid");
        if (field !== "command") control.removeAttribute("aria-describedby");
        errorElement.textContent = "";
        errorElement.hidden = true;
      } else {
        control.setAttribute("aria-invalid", "true");
        control.setAttribute("aria-describedby", field === "command" ? "task-command-help task-command-error" : `task-${field}-error`);
        errorElement.textContent = error;
        errorElement.hidden = false;
      }
    }
    const save = this.root.querySelector<HTMLButtonElement>("[data-save-task]");
    if (save !== null) save.disabled = this.operation !== undefined || !this.canWriteScope(this.editor.draft.global ? "global" : "workspace") || !validation.ok || this.isScopeDisabled(this.editor.draft.global ? "global" : "workspace");
  }

  private isEditorDirty(): boolean {
    const editor = this.editor;
    if (editor === undefined) return false;
    return editor.draft.id !== editor.initialDraft.id
      || editor.draft.title !== editor.initialDraft.title
      || editor.draft.command !== editor.initialDraft.command
      || editor.draft.description !== editor.initialDraft.description
      || editor.draft.group !== editor.initialDraft.group
      || editor.draft.confirm !== editor.initialDraft.confirm
      || editor.draft.global !== editor.initialDraft.global;
  }

  private focusFirstInvalid(errors: WorkspaceTaskDraftErrors): void {
    const field = errors.title === undefined ? errors.command === undefined ? "id" : "command" : "title";
    this.focusSelector(`[data-editor-${field}]`);
  }

  private focusSelector(selector: string): void {
    if (!this.connected) return;
    this.root.querySelector<HTMLElement>(selector)?.focus();
  }

  private focusTarget(target: FocusTarget | undefined): void {
    if (!this.connected) return;
    let element: HTMLElement | null = null;
    if (target?.kind === "add") element = this.root.querySelector("[data-add-task]");
    if (target?.kind === "edit") element = findButtonByValue(this.root, "data-edit-task", workspaceTaskRefKey(target.ref));
    if (target?.kind === "delete") element = findButtonByValue(this.root, "data-delete-task", workspaceTaskRefKey(target.ref));
    if (target?.kind === "refresh") element = this.root.querySelector("[data-refresh]");
    if (target?.kind === "heading" || element === null || element instanceof HTMLButtonElement && element.disabled) element = this.root.querySelector("[data-panel-heading]");
    element?.focus();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || this.operation !== undefined) return;
    if (this.mode === "add" || this.mode === "edit") {
      event.preventDefault();
      event.stopPropagation();
      this.cancelEditor();
    } else if (this.mode === "delete-confirm") {
      event.preventDefault();
      event.stopPropagation();
      this.cancelDelete();
    } else if (this.mode === "move-confirm") {
      event.preventDefault();
      event.stopPropagation();
      this.cancelMove();
    } else if (this.mode === "refresh-discard-confirm") {
      event.preventDefault();
      event.stopPropagation();
      this.cancelRefreshDiscard();
    }
  }

  private findTask(ref: WorkspaceTaskRef): { readonly task: WorkspaceTask; readonly index: number } | undefined {
    const catalog = this.catalog(ref.scope);
    if (catalog.kind !== "loaded") return undefined;
    const index = catalog.config.tasks.findIndex((task) => task.id === ref.id);
    const task = index < 0 ? undefined : catalog.config.tasks[index];
    return task === undefined ? undefined : { task: cloneTask(task), index };
  }

  private catalog(scope: WorkspaceTaskScope): WorkspaceCatalogState | GlobalCatalogState {
    return scope === "workspace" ? this.stateValue.workspace : this.stateValue.global;
  }

  private captureActionState(): ActionStateObservation {
    return {
      sources: {
        workspace: {
          lastKey: catalogStateKey(this.stateValue.workspace),
          delivered: false,
        },
        global: {
          lastKey: catalogStateKey(this.stateValue.global),
          delivered: false,
        },
      },
      mutationGateKey: mutationGateKey(this.stateValue.mutationGate),
    };
  }

  private recordPendingSourceObservations(next: WorkspaceTasksPanelState, published: boolean): void {
    const pending = this.pendingAction;
    if (pending === undefined || !this.ownsSelection(pending.generation)) return;
    // The controller recreates both source objects for each top-level publication.
    let changedAnyScope = false;
    for (const scope of ["workspace", "global"] as const) {
      const nextCatalog = scope === "workspace" ? next.workspace : next.global;
      const nextKey = catalogStateKey(nextCatalog);
      if (pending.observation.sources[scope].lastKey !== nextKey) changedAnyScope = true;
    }
    for (const scope of ["workspace", "global"] as const) {
      if (!pending.scopes.includes(scope)) continue;
      const nextCatalog = scope === "workspace" ? next.workspace : next.global;
      const source = pending.observation.sources[scope];
      const nextKey = catalogStateKey(nextCatalog);
      if (source.lastKey === nextKey) continue;
      source.lastKey = nextKey;
      source.delivered = true;
    }
    // A fresh authoritative snapshot can be semantically unchanged after a
    // canonical no-op. Its top-level publication identity is the acknowledgement.
    if (published && !changedAnyScope && pending.scopes.every((scope) => hasAuthoritativeCatalogState(this.catalog(scope)))) {
      for (const scope of pending.scopes) pending.observation.sources[scope].delivered = true;
    }
  }

  private reconcilePendingAction(): boolean {
    const pending = this.pendingAction;
    if (pending === undefined || !pending.settled || !this.ownsSelection(pending.generation)) return false;

    if (pending.kind === "refresh") {
      if (!pending.scopes.every((scope) => this.sourceSnapshotDelivered(scope, pending.observation))) return false;
      if (pending.scopes.some((scope) => !hasAuthoritativeCatalogState(this.catalog(scope)))) return false;
      for (const scope of pending.scopes) {
        const failure = catalogFailure(this.catalog(scope));
        if (failure !== undefined) return this.finishPendingFailure(pending, failure.message);
      }
      this.pendingAction = undefined;
      this.operation = undefined;
      this.status = { kind: "success", message: "Workspace task catalogs refreshed." };
      this.render();
      this.focusTarget(pending.focusReturn);
      return true;
    }

    const scope = pending.kind === "save" ? pending.scope : pending.ref.scope;
    const delivered = this.sourceSnapshotDelivered(scope, pending.observation);
    const gateChanged = this.mutationGateChanged(scope, pending.observation);
    if (!delivered && !gateChanged) return false;
    if (!hasAuthoritativeCatalogState(this.catalog(scope)) && !gateChanged) return false;

    const failure = catalogFailure(this.catalog(scope));
    if (failure !== undefined) return this.finishPendingFailure(pending, failure.message);
    if (gateChanged || this.mutationBlocked(scope)) {
      return this.finishPendingFailure(pending, this.stateValue.mutationGate?.message ?? "Refresh before trying another task change.");
    }

    const confirmed = pending.kind === "save"
      ? this.catalogContainsTask(scope, pending.task)
      : this.catalogDoesNotContainTask(pending.ref);
    if (!confirmed) return false;

    this.pendingAction = undefined;
    this.operation = undefined;
    if (pending.kind === "save") {
      this.editor = undefined;
      this.mode = "view";
      this.validationErrors = undefined;
      this.idManuallyEdited = false;
      this.status = { kind: "success", message: `Saved task "${pending.task.title}".` };
    } else {
      this.deleteState = undefined;
      this.mode = "view";
      this.status = { kind: "success", message: `Deleted task "${pending.task.title}".` };
    }
    this.render();
    this.focusTarget(pending.focusReturn);
    return true;
  }

  private sourceSnapshotDelivered(scope: WorkspaceTaskScope, observation: ActionStateObservation): boolean {
    return observation.sources[scope].delivered;
  }

  private mutationGateChanged(scope: WorkspaceTaskScope, observation: ActionStateObservation): boolean {
    const gate = this.stateValue.mutationGate;
    return mutationGateKey(gate) !== observation.mutationGateKey && gate?.scopes.includes(scope) === true;
  }

  private finishPendingFailure(pending: PendingAction, detail: string): boolean {
    if (this.pendingAction !== pending) return false;
    this.pendingAction = undefined;
    this.operation = undefined;
    const message = pending.kind === "refresh"
      ? "Could not refresh workspace task catalogs."
      : pending.kind === "save"
        ? "Could not save workspace task."
        : "Could not delete workspace task.";
    this.status = { kind: "error", message, detail };
    this.render();
    if (pending.kind === "refresh") this.focusTarget(pending.focusReturn);
    return true;
  }

  private catalogContainsTask(scope: WorkspaceTaskScope, expected: WorkspaceTask): boolean {
    const catalog = this.catalog(scope);
    return catalog.kind === "loaded" && catalog.config.tasks.some((task) => sameTask(task, expected));
  }

  private catalogDoesNotContainTask(ref: WorkspaceTaskRef): boolean {
    const catalog = this.catalog(ref.scope);
    return catalog.kind === "loaded" && !catalog.config.tasks.some((task) => task.id === ref.id);
  }

  private canWriteScope(scope: WorkspaceTaskScope): boolean {
    const catalog = this.catalog(scope);
    return catalog.kind === "loaded" || scope === "workspace" && catalog.kind === "missing";
  }

  private isScopeDisabled(scope: WorkspaceTaskScope): boolean {
    return this.operation?.scopes.includes(scope) === true
      || this.stateValue.mutationGate?.scopes.includes(scope) === true
      || this.stateValue.move !== undefined;
  }

  private mutationBlocked(scope: WorkspaceTaskScope): boolean {
    return this.stateValue.mutationGate?.scopes.includes(scope) === true || this.stateValue.move !== undefined;
  }

  private ownsSelection(generation: number): boolean {
    return this.connected && generation === this.selectionGeneration;
  }

  private ownsTerminal(selection: number, terminal: number): boolean {
    return this.ownsSelection(selection) && terminal === this.terminalGeneration;
  }

  private setError(message: string): void {
    this.status = { kind: "error", message };
    this.render();
  }

  private rememberOpenGroups(): void {
    for (const details of this.root.querySelectorAll<HTMLDetailsElement>("details[data-group-key]")) {
      const key = details.getAttribute("data-group-key");
      if (key === null) continue;
      if (details.open) this.expandedGroupKeys.add(key);
      else this.expandedGroupKeys.delete(key);
    }
  }

  private pruneExpandedGroups(): void {
    const valid = new Set<string>();
    for (const scope of ["global", "workspace"] as const) {
      const catalog = this.catalog(scope);
      if (catalog.kind !== "loaded") continue;
      for (const task of catalog.config.tasks) {
        if (task.group !== undefined) valid.add(workspaceTaskGroupKey(scope, task.group));
      }
    }
    for (const key of this.expandedGroupKeys) if (!valid.has(key)) this.expandedGroupKeys.delete(key);
  }

  private isMoveComplete(editor: EditorState, state: WorkspaceTasksPanelState): boolean {
    const source = editor.sourceRef;
    if (source === undefined) return false;
    const destination: WorkspaceTaskRef = { scope: editor.draft.global ? "global" : "workspace", id: editor.draft.id.trim() };
    return !this.catalogHasRef(state, source) && this.catalogHasRef(state, destination);
  }

  private catalogHasRef(state: WorkspaceTasksPanelState, ref: WorkspaceTaskRef): boolean {
    const catalog = ref.scope === "workspace" ? state.workspace : state.global;
    return catalog.kind === "loaded" && catalog.config.tasks.some((task) => task.id === ref.id);
  }
}

function renderTaskGroups(
  scope: WorkspaceTaskScope,
  tasks: readonly Readonly<WorkspaceTask>[],
  runningTaskKey: string | undefined,
  scopeDisabled: boolean,
  expanded: ReadonlySet<string>,
): string {
  const groups = new Map<string | undefined, WorkspaceTask[]>();
  for (const sourceTask of tasks) {
    const task = cloneTask(sourceTask);
    const group = groups.get(task.group);
    if (group === undefined) groups.set(task.group, [task]);
    else group.push(task);
  }
  return `<div class="tasks">${[...groups.entries()].map(([group, groupedTasks]) => {
    if (group === undefined) return `<section class="task-group ungrouped">${groupedTasks.map((task) => renderTask(scope, task, runningTaskKey, scopeDisabled, true)).join("")}</section>`;
    const key = workspaceTaskGroupKey(scope, group);
    const open = expanded.has(key);
    return `<details class="task-group" data-group-key="${escapeAttr(key)}" data-group-scope="${scope}"${open ? " open" : ""}>
      <summary><span class="disclosure-chevron" aria-hidden="true">›</span><span class="group-title">${escapeHtml(group)}</span><span class="group-count">${String(groupedTasks.length)} ${groupedTasks.length === 1 ? "task" : "tasks"}</span></summary>
      <div class="task-group-body">${groupedTasks.map((task) => renderTask(scope, task, runningTaskKey, scopeDisabled, true)).join("")}</div>
    </details>`;
  }).join("")}</div>`;
}

function renderTask(scope: WorkspaceTaskScope, task: WorkspaceTask, runningTaskKey: string | undefined, scopeDisabled: boolean, showScopeBadge: boolean): string {
  const ref = { scope, id: task.id } satisfies WorkspaceTaskRef;
  const key = workspaceTaskRefKey(ref);
  const label = scopeLabel(scope);
  const running = runningTaskKey === key;
  const description = task.description === undefined ? "" : `<span class="task-description">${escapeHtml(task.description)}</span>`;
  return `<article class="task-card" data-task-ref="${escapeAttr(key)}">
    <div class="task-copy">
      <div class="task-title-line"><strong>${escapeHtml(task.title)}</strong>${showScopeBadge ? `<span class="scope-badge">${escapeHtml(label)}</span>` : ""}</div>
      ${description}
      <pre class="task-script" data-task-script>${escapeHtml(task.command)}</pre>
    </div>
    <div class="task-actions">
      <button type="button" class="secondary" data-edit-task="${escapeAttr(key)}" aria-label="Edit ${escapeAttr(task.title)} (${escapeAttr(label)})" ${scopeDisabled ? "disabled" : ""}>Edit</button>
      <button type="button" class="secondary danger-secondary" data-delete-task="${escapeAttr(key)}" aria-label="Delete ${escapeAttr(task.title)} (${escapeAttr(label)})" ${scopeDisabled ? "disabled" : ""}>Delete</button>
      <button type="button" data-run-task="${escapeAttr(key)}" aria-label="Run ${escapeAttr(task.title)} (${escapeAttr(label)})" ${runningTaskKey !== undefined ? "disabled" : ""}>${running ? "Dispatching..." : "Run"}</button>
    </div>
  </article>`;
}

function fieldAttrs(field: "title" | "id", error: string | undefined, locked: boolean): string {
  return `${error === undefined ? "" : " aria-invalid=\"true\" aria-describedby=\"task-${field}-error\""}${locked ? " disabled" : ""}`;
}

function renderFieldError(field: "title" | "command" | "id", error: string | undefined): string {
  return `<p id="task-${field}-error" data-field-error="${field}" class="field-error"${error === undefined ? " hidden" : ""}>${error === undefined ? "" : escapeHtml(error)}</p>`;
}

function loadedCount(catalog: WorkspaceCatalogState | GlobalCatalogState): number {
  return catalog.kind === "loaded" ? catalog.config.tasks.length : 0;
}

function catalogNeedsAttention(catalog: WorkspaceCatalogState | GlobalCatalogState): boolean {
  return catalog.kind === "invalid" || catalog.kind === "unavailable" || catalog.kind === "error" || catalog.kind === "loaded" && catalog.refreshError !== undefined || catalog.kind === "missing" && catalog.refreshError !== undefined;
}

function catalogFailure(catalog: WorkspaceCatalogState | GlobalCatalogState): CatalogFailure | undefined {
  if ((catalog.kind === "loaded" || catalog.kind === "missing") && catalog.refreshError !== undefined) {
    return { message: catalog.refreshError };
  }
  if (catalog.kind === "invalid" || catalog.kind === "unavailable" || catalog.kind === "error") {
    return { message: catalog.message };
  }
  return undefined;
}

function catalogStateKey(catalog: WorkspaceCatalogState | GlobalCatalogState): string {
  return JSON.stringify(catalog);
}

function mutationGateKey(gate: WorkspaceTasksPanelState["mutationGate"]): string | undefined {
  return gate === undefined ? undefined : JSON.stringify({ scopes: [...gate.scopes], message: gate.message });
}

function hasAuthoritativeCatalogState(catalog: WorkspaceCatalogState | GlobalCatalogState): boolean {
  if (catalog.kind === "loading") return false;
  if (catalog.kind === "loaded" || catalog.kind === "missing") return !catalog.refreshing;
  return true;
}

function sameTask(left: Readonly<WorkspaceTask>, right: Readonly<WorkspaceTask>): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.command === right.command
    && left.description === right.description
    && left.group === right.group
    && left.confirm === right.confirm;
}

function scopeLabel(scope: WorkspaceTaskScope): "Global" | "Project" {
  return scope === "global" ? "Global" : "Project";
}

function parseRef(value: string): WorkspaceTaskRef | undefined {
  try {
    return parseWorkspaceTaskRefKey(value);
  } catch {
    return undefined;
  }
}

function findButtonByValue(root: ShadowRoot, attribute: string, value: string): HTMLElement | null {
  for (const button of root.querySelectorAll<HTMLElement>(`button[${attribute}]`)) {
    if (button.getAttribute(attribute) === value) return button;
  }
  return null;
}

function contextKey(context: WorkspacePanelContext | undefined): string | undefined {
  if (context === undefined) return undefined;
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id, context.workspace.path]);
}

function emptyDraft(): WorkspaceTaskDraft {
  return { id: "", title: "", command: "", description: "", group: "", confirm: false, global: false };
}

function cloneDraft(draft: WorkspaceTaskDraft): WorkspaceTaskDraft {
  return { ...draft };
}

function cloneTask(task: Readonly<WorkspaceTask>): WorkspaceTask {
  return {
    id: task.id,
    title: task.title,
    command: task.command,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.group === undefined ? {} : { group: task.group }),
    confirm: task.confirm,
  };
}

function emptyPanelState(): WorkspaceTasksPanelState {
  return { workspace: { kind: "loading" }, global: { kind: "loading" } };
}

function noOpActions(): WorkspaceTasksPanelActions {
  return {
    create: () => Promise.resolve(),
    update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    move: () => Promise.resolve(),
    retryMove: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function taskStyles(): string {
  return `<style>
    :host { display: block; min-width: 0; container-type: inline-size; }
    .tasks-panel { min-width: 0; container-type: inline-size; color: var(--pi-text); }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .toolbar h2 { margin: 0; font-size: 15px; }
    .toolbar-tasks { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .viewer { box-sizing: border-box; min-width: 0; min-height: 0; overflow: auto; padding: 12px; }
    .tasks-viewer { display: grid; align-content: start; gap: 12px; }
    .scope-filters { display: inline-flex; flex-wrap: wrap; gap: 6px; }
    .scope-filter { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-text); }
    .scope-filter.selected { border-color: var(--pi-accent-border); background: var(--pi-accent); color: var(--pi-bg); }
    .count, .catalog-count, .group-count { color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
    .scope-filter.selected .count { color: inherit; }
    .helper, .muted, .field-help { color: var(--pi-muted); }
    .helper { margin: 0; line-height: 1.45; }
    .catalog-list { display: grid; gap: 16px; min-width: 0; }
    .scope-catalog { display: grid; gap: 10px; min-width: 0; }
    .scope-catalog > h3 { margin: 0; color: var(--pi-text-secondary); font-size: 13px; }
    .tasks { display: grid; gap: 10px; min-width: 0; }
    .task-group { min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); }
    .task-group[open] { background: var(--pi-surface); }
    .task-group summary { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; list-style: none; }
    .task-group summary::-webkit-details-marker { display: none; }
    .task-group summary::marker { content: ""; }
    .disclosure-chevron { color: var(--pi-muted); font-size: 18px; line-height: 1; transition: transform .15s ease; }
    .task-group[open] .disclosure-chevron { transform: rotate(90deg); }
    .group-title { flex: 1 1 auto; min-width: 0; font-weight: 600; }
    .task-group-body { display: grid; gap: 10px; padding: 0 10px 10px; }
    .ungrouped { display: grid; gap: 10px; }
    .task-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); padding: 12px; }
    .task-copy { display: grid; min-width: 0; gap: 5px; }
    .task-title-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .task-description { color: var(--pi-muted); }
    .scope-badge { display: inline-block; border: 1px solid var(--pi-border-muted); border-radius: 4px; padding: 2px 6px; color: var(--pi-text-secondary); font-size: 11px; white-space: nowrap; }
    .task-script, .diagnostic { box-sizing: border-box; max-width: 100%; margin: 0; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .task-script { max-height: 12rem; overflow-y: auto; padding: 8px; }
    .diagnostic { max-height: 12rem; overflow: auto; padding: 8px; }
    .task-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .task-editor, .confirmation { width: min(100%, 620px); box-sizing: border-box; padding: 16px; background: var(--pi-surface); border: 1px solid var(--pi-border); border-radius: 8px; }
    .editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .task-editor h3, .confirmation h3 { margin: 0 0 16px; font-size: 18px; }
    .confirmation p { margin: 0 0 10px; line-height: 1.5; }
    .confirmation .task-script { margin: 10px 0 16px; }
    .task-form { display: grid; gap: 6px; }
    .task-form > label, .checkbox-field > label { font-size: 14px; font-weight: 500; }
    .task-form .required { color: var(--pi-danger); }
    .task-form input[type="text"], .task-form textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; background: var(--pi-bg); border: 1px solid var(--pi-border); border-radius: 6px; font-size: 14px; color: var(--pi-text); font-family: inherit; }
    .task-form textarea { min-height: 9rem; max-height: 24rem; resize: vertical; line-height: 1.45; }
    .task-form input[type="text"]::placeholder, .task-form textarea::placeholder { color: var(--pi-muted); }
    .checkbox-field { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px; margin-top: 8px; }
    .checkbox-field input { width: 18px; height: 18px; }
    .field-help { margin: 0 0 8px; font-size: 12px; line-height: 1.4; }
    .field-error { margin: 0 0 8px; color: var(--pi-danger); font-size: 12px; }
    .editor-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 10px; }
    .empty-state { display: grid; gap: 6px; border: 1px dashed var(--pi-border-muted); border-radius: 8px; color: var(--pi-muted); padding: 12px; }
    .panel-status { margin: 12px 12px 0; }
    .status { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
    .status.info { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
    .status.success { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
    .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
    .status.warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); color: var(--pi-text); }
    .status p { margin: 6px 0; }
    .empty { padding: 16px; color: var(--pi-muted); }
    button { border: 1px solid var(--pi-accent-border); border-radius: 7px; background: var(--pi-accent); color: var(--pi-bg); cursor: pointer; padding: 6px 10px; font: inherit; }
    button.secondary { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-text); }
    button.danger, button.danger-secondary { border-color: var(--pi-danger); }
    button.danger { background: var(--pi-danger); color: var(--pi-bg); }
    button.danger-secondary { background: var(--pi-surface); color: var(--pi-danger); }
    button:disabled { cursor: wait; opacity: .65; }
    button:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex="-1"]:focus-visible { outline: 2px solid var(--pi-accent-border); outline-offset: 2px; }
    @container (max-width: 600px) { .task-card { grid-template-columns: minmax(0, 1fr); } .task-actions { justify-content: flex-start; } }
  </style>`;
}
