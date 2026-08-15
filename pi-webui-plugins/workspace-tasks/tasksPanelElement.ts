import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import {
  TASKS_CONFIG_PATH,
  appendWorkspaceTask,
  emptyWorkspaceTasksConfig,
  removeWorkspaceTaskAt,
  replaceWorkspaceTaskAt,
  suggestWorkspaceTaskId,
  validateAndNormalizeDraft,
  type ValidateWorkspaceTaskDraftResult,
  type WorkspaceTask,
  type WorkspaceTaskDraft,
  type WorkspaceTaskDraftErrors,
} from "./config.js";
import { runWorkspaceTaskInTerminal } from "./taskRunner.js";
import {
  ensureWorkspaceTasksConfig,
  getWorkspaceTasksCacheEntry,
  guardedWriteWorkspaceTasksConfig,
  refreshWorkspaceTasksConfig,
  subscribeWorkspaceTasksConfig,
  type GuardedWorkspaceTasksWriteResult,
  type WorkspaceTasksCacheEntry,
  type WorkspaceTasksConfigLoadResult,
  type WorkspaceTasksSnapshot,
} from "./workspaceTasksClient.js";

export const tasksPanelTagName = "pi-webui-workspace-tasks-panel";

type ConfigState = WorkspaceTasksConfigLoadResult;
type PanelMode = "view" | "add" | "edit" | "delete-confirm" | "reset-confirm" | "refresh-discard-confirm" | "conflicted" | "needs-refresh-after-write";
type OperationKind = "refresh" | "mutation";
type MutationAction = "save" | "delete" | "reset";
type FailedAction = "editor" | "delete" | "reset";
type FailureKind = GuardedWorkspaceTasksWriteResult["kind"];

type FocusTarget =
  | { kind: "add" }
  | { kind: "edit"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "reset" }
  | { kind: "refresh" }
  | { kind: "heading" };

interface TaskStatus {
  kind: "info" | "success" | "error";
  message: string;
  detail?: string;
}

interface EditorState {
  draft: WorkspaceTaskDraft;
  initialDraft: WorkspaceTaskDraft;
  sourceSnapshot: WorkspaceTasksSnapshot;
  originalIndex: number | undefined;
  focusReturn: FocusTarget;
}

interface DeleteState {
  task: WorkspaceTask;
  index: number;
  sourceSnapshot: WorkspaceTasksSnapshot;
  focusReturn: FocusTarget;
}

interface ResetState {
  sourceSnapshot: WorkspaceTasksSnapshot;
  focusReturn: FocusTarget;
}

interface FailureState {
  kind: FailureKind;
  detail: string;
  action: FailedAction;
}

export function defineTasksPanelElement(): void {
  if (!customElements.get(tasksPanelTagName)) customElements.define(tasksPanelTagName, PiWebUiTasksPanel);
}

export function tasksPanelBadge(context: WorkspacePanelContext): string | undefined {
  const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
  return entry !== undefined && (entry.state.kind === "unavailable" || entry.refreshRequired) ? "!" : undefined;
}

class PiWebUiTasksPanel extends HTMLElement {
  private contextValue: WorkspacePanelContext | undefined;
  private runningTaskId: string | undefined;
  private status: TaskStatus | undefined;
  private mode: PanelMode = "view";
  private operation: OperationKind | undefined;
  private editor: EditorState | undefined;
  private deleteState: DeleteState | undefined;
  private resetState: ResetState | undefined;
  private failure: FailureState | undefined;
  private validationErrors: WorkspaceTaskDraftErrors | undefined;
  private idManuallyEdited = false;
  private pendingRefreshFocus: FocusTarget | undefined;
  private operationGeneration = 0;
  private terminalRunGeneration = 0;
  private panelRefreshRequired = false;
  private selectionGeneration = 0;
  private connected = false;
  private unsubscribe: (() => void) | undefined;
  private readonly root: ShadowRoot;
  private readonly onConfigChanged = (workspaceKey: string): void => {
    const context = this.contextValue;
    if (!this.connected || context === undefined || cacheKeyForContext(context) !== workspaceKey) return;
    context.host.requestRender();
    this.render();
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.operation !== undefined) return;

    if (this.mode === "add" || this.mode === "edit" || (this.mode === "conflicted" && this.failure?.action === "editor") || (this.mode === "needs-refresh-after-write" && this.failure?.action === "editor")) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelEditor();
      return;
    }
    if (this.mode === "delete-confirm" || (this.mode === "conflicted" && this.failure?.action === "delete") || (this.mode === "needs-refresh-after-write" && this.failure?.action === "delete")) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelDelete();
      return;
    }
    if (this.mode === "reset-confirm" || (this.mode === "conflicted" && this.failure?.action === "reset") || (this.mode === "needs-refresh-after-write" && this.failure?.action === "reset")) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelReset();
      return;
    }
    if (this.mode === "refresh-discard-confirm") {
      event.preventDefault();
      event.stopPropagation();
      this.cancelRefreshDiscard();
    }
  };

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.addEventListener("keydown", (event) => {
      if (event instanceof KeyboardEvent) this.onKeyDown(event);
    });
  }

  set context(value: WorkspacePanelContext | undefined) {
    const previousKey = this.contextValue === undefined ? undefined : cacheKeyForContext(this.contextValue);
    const nextKey = value === undefined ? undefined : cacheKeyForContext(value);
    this.contextValue = value;
    if (previousKey === nextKey) return;

    this.selectionGeneration += 1;
    this.operationGeneration += 1;
    this.terminalRunGeneration += 1;
    this.operation = undefined;
    this.runningTaskId = undefined;
    this.mode = "view";
    this.editor = undefined;
    this.deleteState = undefined;
    this.resetState = undefined;
    this.failure = undefined;
    this.validationErrors = undefined;
    this.pendingRefreshFocus = undefined;
    this.idManuallyEdited = false;
    this.panelRefreshRequired = false;
    this.status = undefined;
    this.render();
  }

  connectedCallback(): void {
    this.connected = true;
    this.unsubscribe = subscribeWorkspaceTasksConfig(this.onConfigChanged);
    this.render();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.selectionGeneration += 1;
    this.operationGeneration += 1;
    this.terminalRunGeneration += 1;
    this.operation = undefined;
    this.runningTaskId = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private render(): void {
    const context = this.contextValue;
    if (context === undefined) {
      this.root.innerHTML = `${taskStyles()}<section class="empty">Select a workspace.</section>`;
      return;
    }

    const entry = ensureWorkspaceTasksConfig(context.files, cacheKeyForContext(context));
    const refreshDisabled = this.operation !== undefined || this.isConfirmationMode();
    const showAdd = this.mode === "view"
      && !this.isRefreshRequired(entry)
      && (entry.state.kind === "loaded" || entry.state.kind === "missing");
    const showReset = this.mode === "view" && !this.isRefreshRequired(entry) && entry.state.kind === "invalid";

    this.root.innerHTML = `
      ${taskStyles()}
      <main class="tasks-panel" data-panel-mode="${escapeAttr(this.mode)}">
        <section class="toolbar">
          <h2 data-panel-heading tabindex="-1">Workspace Tasks</h2>
          <span class="toolbar-tasks">
            ${showAdd ? `<button type="button" class="secondary" data-add-task>Add Task</button>` : ""}
            <button type="button" class="secondary" data-refresh-config ${refreshDisabled ? "disabled" : ""}>Refresh</button>
            <button type="button" class="secondary" data-open-terminal>Open Terminal</button>
          </span>
        </section>
        ${this.renderStatus()}
        <section class="viewer tasks-viewer">
          ${this.renderBody(entry, showReset)}
        </section>
      </main>
    `;

    this.bindHandlers(context);
  }

  private isRefreshRequired(entry: WorkspaceTasksCacheEntry): boolean {
    return this.panelRefreshRequired || entry.refreshRequired;
  }

  private isConfirmationMode(): boolean {
    return this.mode === "delete-confirm" || this.mode === "reset-confirm" || this.mode === "refresh-discard-confirm";
  }

  private renderBody(entry: WorkspaceTasksCacheEntry, showReset: boolean): string {
    if (this.mode === "add" || this.mode === "edit") return this.renderEditor(entry, false);
    if (this.mode === "delete-confirm") return this.renderDeleteConfirmation(false);
    if (this.mode === "reset-confirm") return this.renderResetConfirmation(false);
    if (this.mode === "refresh-discard-confirm") return this.renderRefreshDiscardConfirmation();
    if (this.mode === "conflicted" || this.mode === "needs-refresh-after-write") {
      const action = this.failure?.action;
      if (action === "editor") return this.renderEditor(entry, true);
      if (action === "delete") return this.renderDeleteConfirmation(true);
      if (action === "reset") return this.renderResetConfirmation(true);
    }
    return this.renderConfigState(entry, showReset);
  }

  private renderConfigState(entry: WorkspaceTasksCacheEntry, showReset: boolean): string {
    const state = entry.state;
    if (state.kind === "loading") return `<p class="muted" data-loading>Loading ${escapeHtml(TASKS_CONFIG_PATH)}...</p>`;
    if (state.kind === "missing") {
      return `${this.renderRefreshRequired(entry)}<div class="empty-state"><strong>${escapeHtml(state.message)}</strong><p>${escapeHtml(state.hint)}</p></div>`;
    }
    if (state.kind === "invalid") {
      return `
        ${this.renderRefreshRequired(entry)}
        <div class="status error" data-invalid-state>
          <strong>${escapeHtml(state.message)}</strong>
          <p>${escapeHtml(state.hint)}</p>
          <pre class="diagnostic">${escapeHtml(state.detail)}</pre>
          ${showReset ? `<button type="button" class="danger-secondary" data-reset-tasks-file>Reset Tasks File</button>` : ""}
        </div>
      `;
    }
    if (state.kind === "unavailable") {
      return `
        <div class="status error" data-unavailable-state>
          <strong>${escapeHtml(state.message)}</strong>
          <p>${escapeHtml(state.hint)}</p>
          ${state.detail === undefined ? "" : `<pre class="diagnostic">${escapeHtml(state.detail)}</pre>`}
        </div>
      `;
    }
    if (state.config.tasks.length === 0) {
      return `${this.renderRefreshRequired(entry)}<p class="muted">No tasks are defined in ${escapeHtml(state.path)}. Add tasks to the file, then click Refresh.</p>`;
    }
    return `
      ${this.renderRefreshRequired(entry)}
      <p class="muted">Tasks run as one script in one dedicated workspace terminal. Use <code>set -e</code> or <code>&amp;&amp;</code> when the script should stop after a failure.</p>
      ${renderTaskGroups(state.config.tasks, this.runningTaskId, this.isRefreshRequired(entry) || this.operation !== undefined)}
    `;
  }

  private renderRefreshRequired(entry: WorkspaceTasksCacheEntry): string {
    if (!this.isRefreshRequired(entry)) return "";
    return `<div class="status warning" data-refresh-required role="status">Refresh the workspace tasks file before making another change.</div>`;
  }

  private renderStatus(): string {
    if (this.status === undefined) return "";
    const detail = this.status.detail === undefined ? "" : `<pre class="diagnostic">${escapeHtml(this.status.detail)}</pre>`;
    return `<div class="status panel-status ${escapeAttr(this.status.kind)}" data-panel-status role="status" aria-live="polite" tabindex="-1">${escapeHtml(this.status.message)}${detail}</div>`;
  }

  private renderEditor(entry: WorkspaceTasksCacheEntry, locked: boolean): string {
    const editor = this.editor;
    if (editor === undefined) return "";
    const validation = this.validateEditor(entry);
    const errors = this.validationErrors ?? {};
    const titleError = errors.title;
    const commandError = errors.command;
    const idError = errors.id;
    const saveDisabled = locked
      || this.operation !== undefined
      || this.isRefreshRequired(entry)
      || (entry.state.kind !== "loaded" && entry.state.kind !== "missing")
      || !validation.ok;
    const titleDescribedBy = titleError === undefined ? "" : ` aria-describedby="task-title-error"`;
    const idDescribedBy = idError === undefined ? "" : ` aria-describedby="task-id-error"`;
    const commandDescribedBy = commandError === undefined ? "task-command-help" : "task-command-help task-command-error";
    const heading = editor.originalIndex === undefined ? "Add Task" : "Edit Task";
    const failureRefresh = locked ? `<button type="button" class="secondary" data-refresh-after-failure>Refresh</button>` : "";

    return `
      <section class="task-editor" data-task-editor>
        <h3>${heading}</h3>
        <form class="task-form" data-task-form>
          <label for="task-title">Title <span class="required" aria-hidden="true">*</span></label>
          <input id="task-title" name="title" type="text" value="${escapeAttr(editor.draft.title)}" placeholder="Build app" data-editor-title aria-required="true"${titleError === undefined ? "" : ` aria-invalid="true"`}${titleDescribedBy} ${locked ? "disabled" : ""}>
          ${renderFieldError("title", titleError)}

          <label for="task-command">Command script <span class="required" aria-hidden="true">*</span></label>
          <textarea id="task-command" name="command" data-editor-command aria-required="true" aria-describedby="${commandDescribedBy}"${commandError === undefined ? "" : ` aria-invalid="true"`}${locked ? " disabled" : ""}>${escapeHtml(editor.draft.command)}</textarea>
          <p id="task-command-help" class="field-help">Runs once in one terminal through the server shell. Use <code>set -e</code> or <code>&amp;&amp;</code> for fail-fast behavior.</p>
          ${renderFieldError("command", commandError)}

          <label for="task-id">ID <span class="required" aria-hidden="true">*</span></label>
          <input id="task-id" name="id" type="text" value="${escapeAttr(editor.draft.id)}" placeholder="Auto-generated from title" data-editor-id aria-required="true"${idError === undefined ? "" : ` aria-invalid="true"`}${idDescribedBy} ${locked ? "disabled" : ""}>
          ${renderFieldError("id", idError)}

          <label for="task-description">Description</label>
          <input id="task-description" name="description" type="text" value="${escapeAttr(editor.draft.description)}" placeholder="Optional description" data-editor-description ${locked ? "disabled" : ""}>

          <label for="task-group">Group</label>
          <input id="task-group" name="group" type="text" value="${escapeAttr(editor.draft.group)}" placeholder="Optional group name" data-editor-group ${locked ? "disabled" : ""}>

          <span class="checkbox-field">
            <input id="task-confirm" name="confirm" type="checkbox" ${editor.draft.confirm ? "checked" : ""} data-editor-confirm ${locked ? "disabled" : ""}>
            <label for="task-confirm">Require confirmation before running</label>
          </span>

          <div class="editor-actions">
            <button type="button" class="secondary" data-cancel-editor>Cancel</button>
            ${failureRefresh}
            <button type="button" class="primary" data-save-task ${saveDisabled ? "disabled" : ""}>Save Task</button>
          </div>
        </form>
      </section>
    `;
  }

  private renderDeleteConfirmation(locked: boolean): string {
    const state = this.deleteState;
    if (state === undefined) return "";
    return `
      <section class="confirmation" data-delete-confirmation>
        <h3>Delete Task</h3>
        <p>Are you sure you want to delete <strong>${escapeHtml(state.task.title)}</strong>?</p>
        <pre class="task-script">${escapeHtml(state.task.command)}</pre>
        <div class="editor-actions">
          <button type="button" class="secondary" data-cancel-delete>Cancel</button>
          ${locked ? `<button type="button" class="secondary" data-refresh-after-failure>Refresh</button>` : `<button type="button" class="danger" data-confirm-delete ${this.operation === undefined ? "" : "disabled"}>Delete Task</button>`}
        </div>
      </section>
    `;
  }

  private renderResetConfirmation(locked: boolean): string {
    if (this.resetState === undefined) return "";
    return `
      <section class="confirmation" data-reset-confirmation>
        <h3>Reset Tasks File</h3>
        <p>This replaces the invalid contents of <code>${escapeHtml(TASKS_CONFIG_PATH)}</code> with an empty version 1 tasks file.</p>
        <div class="editor-actions">
          <button type="button" class="secondary" data-cancel-reset>Cancel</button>
          ${locked ? `<button type="button" class="secondary" data-refresh-after-failure>Refresh</button>` : `<button type="button" class="danger" data-confirm-reset ${this.operation === undefined ? "" : "disabled"}>Reset Tasks File</button>`}
        </div>
      </section>
    `;
  }

  private renderRefreshDiscardConfirmation(): string {
    return `
      <section class="confirmation" data-refresh-discard-confirmation>
        <h3>Discard draft and refresh?</h3>
        <p>Your unsaved task draft will be discarded. Refresh loads the authoritative workspace file.</p>
        <div class="editor-actions">
          <button type="button" class="secondary" data-cancel-refresh-discard>Cancel</button>
          <button type="button" class="primary" data-confirm-refresh-discard>Discard &amp; Refresh</button>
        </div>
      </section>
    `;
  }

  private bindHandlers(context: WorkspacePanelContext): void {
    this.root.querySelector<HTMLButtonElement>("button[data-add-task]")?.addEventListener("click", () => {
      this.openAddTaskEditor();
    });
    this.root.querySelector<HTMLButtonElement>("button[data-refresh-config]")?.addEventListener("click", () => {
      void this.requestRefresh(context);
    });
    this.root.querySelector<HTMLButtonElement>("button[data-open-terminal]")?.addEventListener("click", () => {
      this.openWorkspaceTerminal();
    });
    this.root.querySelector<HTMLButtonElement>("button[data-reset-tasks-file]")?.addEventListener("click", () => {
      this.openResetConfirmation(context);
    });
    this.root.querySelector<HTMLButtonElement>("button[data-cancel-editor]")?.addEventListener("click", () => {
      this.cancelEditor();
    });
    this.root.querySelector<HTMLButtonElement>("button[data-save-task]")?.addEventListener("click", () => {
      void this.saveTask(context);
    });
    this.root.querySelector<HTMLButtonElement>("button[data-cancel-delete]")?.addEventListener("click", () => {
      this.cancelDelete();
    });
    this.root.querySelector<HTMLButtonElement>("button[data-confirm-delete]")?.addEventListener("click", () => {
      void this.confirmDelete(context);
    });
    this.root.querySelector<HTMLButtonElement>("button[data-cancel-reset]")?.addEventListener("click", () => {
      this.cancelReset();
    });
    this.root.querySelector<HTMLButtonElement>("button[data-confirm-reset]")?.addEventListener("click", () => {
      void this.confirmReset(context);
    });
    this.root.querySelector<HTMLButtonElement>("button[data-cancel-refresh-discard]")?.addEventListener("click", () => {
      this.cancelRefreshDiscard();
    });
    this.root.querySelector<HTMLButtonElement>("button[data-confirm-refresh-discard]")?.addEventListener("click", () => {
      void this.confirmRefreshDiscard(context);
    });
    this.root.querySelector<HTMLButtonElement>("button[data-refresh-after-failure]")?.addEventListener("click", () => {
      void this.requestRefresh(context, true);
    });

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-task-id]")) {
      button.addEventListener("click", () => {
        void this.dispatchTaskById(context, button.getAttribute("data-task-id"));
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-edit-task]")) {
      button.addEventListener("click", () => {
        this.openEditTaskEditor(context, button.getAttribute("data-edit-task"));
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-delete-task]")) {
      button.addEventListener("click", () => {
        this.openDeleteConfirmation(context, button.getAttribute("data-delete-task"));
      });
    }

    const title = this.root.querySelector<HTMLInputElement>("input[data-editor-title]");
    title?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.title = event.target.value;
      if (!this.idManuallyEdited) {
        this.editor.draft.id = suggestWorkspaceTaskId(event.target.value);
        const id = this.root.querySelector<HTMLInputElement>("input[data-editor-id]");
        if (id !== null) id.value = this.editor.draft.id;
      }
      this.updateValidationInPlace(context);
    });

    const id = this.root.querySelector<HTMLInputElement>("input[data-editor-id]");
    id?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.id = event.target.value;
      this.idManuallyEdited = true;
      this.updateValidationInPlace(context);
    });

    const command = this.root.querySelector<HTMLTextAreaElement>("textarea[data-editor-command]");
    command?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLTextAreaElement) || this.editor === undefined) return;
      this.editor.draft.command = event.target.value;
      this.updateValidationInPlace(context);
    });

    const description = this.root.querySelector<HTMLInputElement>("input[data-editor-description]");
    description?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.description = event.target.value;
      this.updateValidationInPlace(context);
    });

    const group = this.root.querySelector<HTMLInputElement>("input[data-editor-group]");
    group?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.group = event.target.value;
      this.updateValidationInPlace(context);
    });

    const confirm = this.root.querySelector<HTMLInputElement>("input[data-editor-confirm]");
    confirm?.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLInputElement) || this.editor === undefined) return;
      this.editor.draft.confirm = event.target.checked;
      this.updateValidationInPlace(context);
    });

    this.root.querySelector<HTMLFormElement>("form[data-task-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveTask(context);
    });
  }

  private openAddTaskEditor(): void {
    const context = this.contextValue;
    if (context === undefined || this.operation !== undefined) return;
    const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
    if (entry === undefined || this.isRefreshRequired(entry) || (entry.state.kind !== "loaded" && entry.state.kind !== "missing")) return;
    const draft = emptyDraft();
    this.editor = {
      draft,
      initialDraft: cloneDraft(draft),
      sourceSnapshot: entry.state.snapshot,
      originalIndex: undefined,
      focusReturn: { kind: "add" },
    };
    this.mode = "add";
    this.failure = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = false;
    this.status = undefined;
    this.render();
    this.focusSelector("input[data-editor-title]");
  }

  private openEditTaskEditor(context: WorkspacePanelContext, taskId: string | null): void {
    if (!this.isCurrentContext(context) || this.operation !== undefined || taskId === null) return;
    const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
    if (entry === undefined || this.isRefreshRequired(entry) || entry.state.kind !== "loaded") return;
    const index = entry.state.config.tasks.findIndex((task) => task.id === taskId);
    const task = index < 0 ? undefined : entry.state.config.tasks[index];
    if (task === undefined) {
      this.setError("That task is no longer available. Click Refresh, then try again.");
      return;
    }
    const draft: WorkspaceTaskDraft = {
      id: task.id,
      title: task.title,
      command: task.command,
      description: task.description ?? "",
      group: task.group ?? "",
      confirm: task.confirm,
    };
    this.editor = {
      draft,
      initialDraft: cloneDraft(draft),
      sourceSnapshot: entry.state.snapshot,
      originalIndex: index,
      focusReturn: { kind: "edit", id: task.id },
    };
    this.mode = "edit";
    this.failure = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = true;
    this.status = undefined;
    this.render();
    this.focusSelector("input[data-editor-title]");
  }

  private openDeleteConfirmation(context: WorkspacePanelContext, taskId: string | null): void {
    if (!this.isCurrentContext(context) || this.operation !== undefined || taskId === null) return;
    const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
    if (entry === undefined || this.isRefreshRequired(entry) || entry.state.kind !== "loaded") return;
    const index = entry.state.config.tasks.findIndex((task) => task.id === taskId);
    const task = index < 0 ? undefined : entry.state.config.tasks[index];
    if (task === undefined) {
      this.setError("That task is no longer available. Click Refresh, then try again.");
      return;
    }
    this.deleteState = {
      task,
      index,
      sourceSnapshot: entry.state.snapshot,
      focusReturn: { kind: "delete", id: task.id },
    };
    this.mode = "delete-confirm";
    this.failure = undefined;
    this.status = undefined;
    this.render();
    this.focusSelector("button[data-cancel-delete]");
  }

  private openResetConfirmation(context: WorkspacePanelContext): void {
    if (!this.isCurrentContext(context) || this.operation !== undefined) return;
    const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
    if (entry === undefined || this.isRefreshRequired(entry) || entry.state.kind !== "invalid") return;
    this.resetState = { sourceSnapshot: entry.state.snapshot, focusReturn: { kind: "reset" } };
    this.mode = "reset-confirm";
    this.failure = undefined;
    this.status = undefined;
    this.render();
    this.focusSelector("button[data-cancel-reset]");
  }

  private cancelEditor(): void {
    if (this.operation !== undefined) return;
    const target = this.editor?.focusReturn;
    this.editor = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = false;
    this.failure = undefined;
    this.mode = "view";
    this.status = undefined;
    this.render();
    this.focusTarget(target);
  }

  private cancelDelete(): void {
    if (this.operation !== undefined) return;
    const target = this.deleteState?.focusReturn;
    this.deleteState = undefined;
    this.failure = undefined;
    this.mode = "view";
    this.status = undefined;
    this.render();
    this.focusTarget(target);
  }

  private cancelReset(): void {
    if (this.operation !== undefined) return;
    const target = this.resetState?.focusReturn;
    this.resetState = undefined;
    this.failure = undefined;
    this.mode = "view";
    this.status = undefined;
    this.render();
    this.focusTarget(target);
  }

  private cancelRefreshDiscard(): void {
    if (this.operation !== undefined) return;
    const target = this.editor?.focusReturn;
    this.mode = this.editor === undefined ? "view" : this.editor.originalIndex === undefined ? "add" : "edit";
    this.pendingRefreshFocus = undefined;
    this.render();
    this.focusTarget(target);
  }

  private async confirmRefreshDiscard(context: WorkspacePanelContext): Promise<void> {
    if (this.mode !== "refresh-discard-confirm") return;
    const target = this.pendingRefreshFocus ?? { kind: "refresh" as const };
    this.editor = undefined;
    this.deleteState = undefined;
    this.resetState = undefined;
    this.failure = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = false;
    this.pendingRefreshFocus = target;
    await this.requestRefresh(context, true);
  }

  private async requestRefresh(context: WorkspacePanelContext, force = false): Promise<void> {
    if (!this.isCurrentContext(context) || this.operation !== undefined) return;
    if (!force && this.isConfirmationMode()) return;
    if (!force && (this.mode === "add" || this.mode === "edit") && this.editor !== undefined && this.isEditorDirty()) {
      this.pendingRefreshFocus = this.editor.focusReturn;
      this.mode = "refresh-discard-confirm";
      this.status = undefined;
      this.render();
      this.focusSelector("button[data-cancel-refresh-discard]");
      return;
    }

    const target = this.pendingRefreshFocus ?? this.editor?.focusReturn ?? { kind: "refresh" as const };
    this.pendingRefreshFocus = undefined;
    this.editor = undefined;
    this.deleteState = undefined;
    this.resetState = undefined;
    this.failure = undefined;
    this.validationErrors = undefined;
    this.idManuallyEdited = false;
    this.mode = "view";
    this.operation = "refresh";
    const operationGeneration = ++this.operationGeneration;
    const selectionGeneration = this.selectionGeneration;
    this.status = { kind: "info", message: `Refreshing ${TASKS_CONFIG_PATH}...` };
    this.render();

    try {
      const state = await refreshWorkspaceTasksConfig(context.files, cacheKeyForContext(context));
      if (!this.ownsOperation(context, selectionGeneration, operationGeneration)) return;
      const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
      if (entry?.state !== state) {
        this.operation = undefined;
        this.status = undefined;
        this.render();
        return;
      }
      this.panelRefreshRequired = false;
      this.operation = undefined;
      this.status = refreshStatus(state);
      this.render();
      this.focusTarget(target);
    } catch (error) {
      if (!this.ownsOperation(context, selectionGeneration, operationGeneration)) return;
      this.operation = undefined;
      this.status = { kind: "error", message: `Could not refresh ${TASKS_CONFIG_PATH}.`, detail: formatError(error) };
      this.render();
    }
  }

  private async saveTask(context: WorkspacePanelContext): Promise<void> {
    if (!this.isCurrentContext(context) || this.operation !== undefined || this.editor === undefined || (this.mode !== "add" && this.mode !== "edit")) return;
    const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
    if (entry === undefined) return;
    const validation = this.validateEditor(entry);
    if (!validation.ok) {
      this.validationErrors = validation.errors;
      this.status = { kind: "error", message: "Fix the highlighted fields before saving." };
      this.render();
      this.focusFirstInvalid(validation.errors);
      return;
    }
    if (entry.state.kind !== "loaded" && entry.state.kind !== "missing") {
      this.enterFailure("preflight-unavailable", "The current tasks file could not be verified. Refresh before trying again.", "editor");
      return;
    }

    const editor = this.editor;
    const nextConfig = this.mode === "add"
      ? appendWorkspaceTask(entry.state.kind === "loaded" ? entry.state.config : emptyWorkspaceTasksConfig, validation.task)
      : this.buildEditedConfig(entry, validation.task);
    if (nextConfig === undefined) return;

    const operationGeneration = ++this.operationGeneration;
    const selectionGeneration = this.selectionGeneration;
    this.operation = "mutation";
    this.status = { kind: "info", message: "Saving workspace task..." };
    this.render();

    try {
      const result = await guardedWriteWorkspaceTasksConfig(
        context.files,
        cacheKeyForContext(context),
        editor.sourceSnapshot,
        nextConfig,
      );
      if (!this.ownsOperation(context, selectionGeneration, operationGeneration)) return;
      this.operation = undefined;
      if (result.kind === "written") {
        const currentEntry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
        if (currentEntry?.state !== result.state) {
          this.status = undefined;
          this.render();
          return;
        }
        const title = validation.task.title;
        this.mode = "view";
        this.editor = undefined;
        this.validationErrors = undefined;
        this.idManuallyEdited = false;
        this.failure = undefined;
        this.status = { kind: "success", message: `Saved task "${title}".` };
        this.render();
        this.focusTarget(editor.focusReturn);
        return;
      }
      this.applyWriteFailure(result, "editor");
    } catch (error) {
      if (!this.ownsOperation(context, selectionGeneration, operationGeneration)) return;
      this.operation = undefined;
      this.applyWriteFailure({ kind: "write-failed", detail: `Unable to write ${TASKS_CONFIG_PATH}: ${formatError(error)}` }, "editor");
    }
  }

  private buildEditedConfig(entry: WorkspaceTasksCacheEntry, task: WorkspaceTask) {
    const editor = this.editor;
    if (entry.state.kind !== "loaded" || editor?.originalIndex === undefined) return undefined;
    const original = entry.state.config.tasks[editor.originalIndex];
    if (original?.id !== editor.initialDraft.id) {
      this.enterFailure("conflict", "The task list changed outside this panel. Refresh before trying again.", "editor");
      return undefined;
    }
    return replaceWorkspaceTaskAt(entry.state.config, editor.originalIndex, task);
  }

  private async confirmDelete(context: WorkspacePanelContext): Promise<void> {
    if (!this.isCurrentContext(context) || this.operation !== undefined || this.deleteState === undefined || this.mode !== "delete-confirm") return;
    const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
    const pending = this.deleteState;
    if (entry?.state.kind !== "loaded" || this.isRefreshRequired(entry) || entry.state.config.tasks[pending.index]?.id !== pending.task.id) {
      this.enterFailure("conflict", "The task list changed outside this panel. Refresh before trying again.", "delete");
      return;
    }
    let nextConfig;
    try {
      nextConfig = removeWorkspaceTaskAt(entry.state.config, pending.index);
    } catch (error) {
      this.enterFailure("conflict", formatError(error), "delete");
      return;
    }
    await this.performMutation(context, pending.sourceSnapshot, nextConfig, "delete", pending.task.title, pending.focusReturn);
  }

  private async confirmReset(context: WorkspacePanelContext): Promise<void> {
    if (!this.isCurrentContext(context) || this.operation !== undefined || this.resetState === undefined || this.mode !== "reset-confirm") return;
    const pending = this.resetState;
    await this.performMutation(context, pending.sourceSnapshot, emptyWorkspaceTasksConfig, "reset", undefined, pending.focusReturn);
  }

  private async performMutation(
    context: WorkspacePanelContext,
    sourceSnapshot: WorkspaceTasksSnapshot,
    nextConfig: { version: 1; tasks: WorkspaceTask[] },
    action: MutationAction,
    title: string | undefined,
    focusReturn: FocusTarget,
  ): Promise<void> {
    const operationGeneration = ++this.operationGeneration;
    const selectionGeneration = this.selectionGeneration;
    this.operation = "mutation";
    this.status = { kind: "info", message: action === "delete" ? "Deleting workspace task..." : action === "reset" ? "Resetting workspace tasks file..." : "Saving workspace task..." };
    this.render();

    try {
      const result = await guardedWriteWorkspaceTasksConfig(context.files, cacheKeyForContext(context), sourceSnapshot, nextConfig);
      if (!this.ownsOperation(context, selectionGeneration, operationGeneration)) return;
      this.operation = undefined;
      if (result.kind === "written") {
        const currentEntry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
        if (currentEntry?.state !== result.state) {
          this.status = undefined;
          this.render();
          return;
        }
        this.mode = "view";
        this.editor = undefined;
        this.deleteState = undefined;
        this.resetState = undefined;
        this.failure = undefined;
        this.validationErrors = undefined;
        this.idManuallyEdited = false;
        this.status = action === "delete" && title !== undefined
          ? { kind: "success", message: `Deleted task "${title}".` }
          : action === "reset"
            ? { kind: "success", message: "Reset workspace tasks file." }
            : { kind: "success", message: "Saved workspace task." };
        this.render();
        this.focusTarget(focusReturn);
        return;
      }
      this.applyWriteFailure(result, action === "delete" ? "delete" : "reset");
    } catch (error) {
      if (!this.ownsOperation(context, selectionGeneration, operationGeneration)) return;
      this.operation = undefined;
      this.applyWriteFailure({ kind: "write-failed", detail: `Unable to write ${TASKS_CONFIG_PATH}: ${formatError(error)}` }, action === "delete" ? "delete" : "reset");
    }
  }

  private applyWriteFailure(result: Exclude<GuardedWorkspaceTasksWriteResult, { kind: "written" }>, action: FailedAction): void {
    this.panelRefreshRequired = true;
    this.failure = { kind: result.kind, detail: result.detail, action };
    this.mode = result.kind === "conflict" || result.kind === "preflight-unavailable" ? "conflicted" : "needs-refresh-after-write";
    this.status = { kind: "error", message: failureMessage(result.kind), detail: result.detail };
    this.render();
  }

  private enterFailure(kind: FailureKind, detail: string, action: FailedAction): void {
    this.panelRefreshRequired = true;
    this.failure = { kind, detail, action };
    this.mode = kind === "conflict" || kind === "preflight-unavailable" ? "conflicted" : "needs-refresh-after-write";
    this.status = { kind: "error", message: failureMessage(kind), detail };
    this.render();
  }

  private dispatchTaskById(context: WorkspacePanelContext, taskId: string | null): Promise<void> {
    if (!this.isCurrentContext(context) || taskId === null) return Promise.resolve();
    const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
    const task = entry?.state.kind === "loaded" ? entry.state.config.tasks.find((candidate) => candidate.id === taskId) : undefined;
    if (task === undefined) {
      this.setError("That task is no longer available. Click Refresh, then try again.");
      return Promise.resolve();
    }
    return this.dispatchTask(context, task);
  }

  private async dispatchTask(context: WorkspacePanelContext, task: WorkspaceTask): Promise<void> {
    if (this.runningTaskId !== undefined || this.operation !== undefined) return;
    if (task.confirm && !window.confirm(`Run ${task.title}?\n\n${task.command}`)) {
      this.status = { kind: "info", message: `Cancelled ${task.title}.` };
      this.render();
      return;
    }
    const selectionGeneration = this.selectionGeneration;
    const terminalRunGeneration = ++this.terminalRunGeneration;
    this.runningTaskId = task.id;
    this.status = { kind: "info", message: `Starting ${task.title}...` };
    this.render();
    try {
      const handle = await runWorkspaceTaskInTerminal(context.terminal, task);
      if (!this.ownsTerminalRun(context, selectionGeneration, terminalRunGeneration)) return;
      this.runningTaskId = undefined;
      this.renderTerminalStatus({ kind: "success", message: `Started terminal command "${handle.run.title}".`, detail: task.command });
    } catch (error) {
      if (!this.ownsTerminalRun(context, selectionGeneration, terminalRunGeneration)) return;
      this.runningTaskId = undefined;
      this.renderTerminalStatus({ kind: "error", message: formatError(error) });
    }
  }

  private renderTerminalStatus(status: TaskStatus): void {
    if (this.operation !== undefined) {
      this.render();
      return;
    }
    this.status = status;
    this.render();
  }

  private openWorkspaceTerminal(terminalId?: string): void {
    const context = this.contextValue;
    if (context === undefined) {
      this.setError("Select a workspace before opening a terminal.");
      return;
    }
    if (terminalId === undefined) context.terminal.open();
    else context.terminal.open({ terminalId });
  }

  private validateEditor(entry: WorkspaceTasksCacheEntry): ValidateWorkspaceTaskDraftResult {
    const editor = this.editor;
    if (editor === undefined) return { ok: false, errors: { title: "Title is required." } };
    const existingTasks = entry.state.kind === "loaded" ? entry.state.config.tasks : [];
    return validateAndNormalizeDraft(editor.draft, existingTasks, editor.originalIndex);
  }

  private updateValidationInPlace(context: WorkspacePanelContext): void {
    const entry = getWorkspaceTasksCacheEntry(cacheKeyForContext(context));
    if (entry === undefined || this.editor === undefined) return;
    const result = this.validateEditor(entry);
    this.validationErrors = result.ok ? undefined : result.errors;
    const errors = this.validationErrors ?? {};
    const controls: ["title" | "command" | "id", string][] = [["title", "task-title"], ["command", "task-command"], ["id", "task-id"]];
    for (const [field, controlId] of controls) {
      const control = this.root.querySelector<HTMLElement>(`#${controlId}`);
      const error = errors[field];
      const errorElement = this.root.querySelector<HTMLElement>(`[data-field-error="${field}"]`);
      if (control === null || errorElement === null) continue;
      if (error === undefined) {
        control.removeAttribute("aria-invalid");
        if (field === "command") control.setAttribute("aria-describedby", "task-command-help");
        else control.removeAttribute("aria-describedby");
        errorElement.textContent = "";
        errorElement.hidden = true;
      } else {
        control.setAttribute("aria-invalid", "true");
        control.setAttribute("aria-describedby", field === "command" ? `task-command-help task-command-error` : `task-${field}-error`);
        errorElement.textContent = error;
        errorElement.hidden = false;
      }
    }
    const save = this.root.querySelector<HTMLButtonElement>("button[data-save-task]");
    if (save !== null) save.disabled = this.operation !== undefined || this.isRefreshRequired(entry) || !result.ok || this.failure !== undefined;
  }

  private isEditorDirty(): boolean {
    const editor = this.editor;
    if (editor === undefined) return false;
    return editor.draft.id !== editor.initialDraft.id
      || editor.draft.title !== editor.initialDraft.title
      || editor.draft.command !== editor.initialDraft.command
      || editor.draft.description !== editor.initialDraft.description
      || editor.draft.group !== editor.initialDraft.group
      || editor.draft.confirm !== editor.initialDraft.confirm;
  }

  private focusFirstInvalid(errors: WorkspaceTaskDraftErrors): void {
    const field = errors.title === undefined ? errors.command === undefined ? "id" : "command" : "title";
    this.focusSelector(`input[data-editor-${field}], textarea[data-editor-${field}]`);
  }

  private focusSelector(selector: string): void {
    if (!this.connected) return;
    this.root.querySelector<HTMLElement>(selector)?.focus();
  }

  private focusTarget(target: FocusTarget | undefined): void {
    if (!this.connected) return;
    let element: HTMLElement | undefined;
    if (target?.kind === "add") element = this.root.querySelector<HTMLElement>("button[data-add-task]") ?? undefined;
    if (target?.kind === "edit") element = findButtonByValue(this.root, "data-edit-task", target.id);
    if (target?.kind === "delete") element = findButtonByValue(this.root, "data-delete-task", target.id);
    if (target?.kind === "reset") element = this.root.querySelector<HTMLElement>("button[data-reset-tasks-file]") ?? undefined;
    if (target?.kind === "refresh") element = this.root.querySelector<HTMLElement>("button[data-refresh-config]") ?? undefined;
    if (target?.kind === "heading" || element === undefined) element = this.root.querySelector<HTMLElement>("[data-panel-heading]") ?? undefined;
    element?.focus();
  }

  private isCurrentContext(context: WorkspacePanelContext): boolean {
    return this.connected && this.contextValue !== undefined && cacheKeyForContext(this.contextValue) === cacheKeyForContext(context);
  }

  private ownsTerminalRun(context: WorkspacePanelContext, selectionGeneration: number, terminalRunGeneration: number): boolean {
    return this.isCurrentContext(context)
      && this.selectionGeneration === selectionGeneration
      && this.terminalRunGeneration === terminalRunGeneration;
  }

  private ownsOperation(context: WorkspacePanelContext, selectionGeneration: number, operationGeneration: number): boolean {
    return this.isCurrentContext(context)
      && this.selectionGeneration === selectionGeneration
      && this.operationGeneration === operationGeneration;
  }

  private setError(message: string): void {
    this.status = { kind: "error", message };
    this.render();
  }
}

function renderFieldError(field: "title" | "command" | "id", error: string | undefined): string {
  return `<p id="task-${field}-error" data-field-error="${field}" class="field-error"${error === undefined ? " hidden" : ""}>${error === undefined ? "" : escapeHtml(error)}</p>`;
}

function renderTaskGroups(tasks: WorkspaceTask[], runningTaskId: string | undefined, actionsDisabled: boolean): string {
  return `<div class="tasks">${groupTasks(tasks).map((group) => renderTaskGroup(group, runningTaskId, actionsDisabled)).join("")}</div>`;
}

function groupTasks(tasks: WorkspaceTask[]): { title: string | undefined; tasks: WorkspaceTask[] }[] {
  const groups: { title: string | undefined; tasks: WorkspaceTask[] }[] = [];
  for (const task of tasks) {
    let group = groups.find((candidate) => candidate.title === task.group);
    if (group === undefined) {
      group = { title: task.group, tasks: [] };
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}

function renderTaskGroup(group: { title: string | undefined; tasks: WorkspaceTask[] }, runningTaskId: string | undefined, actionsDisabled: boolean): string {
  const title = group.title === undefined ? "" : `<h3>${escapeHtml(group.title)}</h3>`;
  return `<section class="task-group">${title}${group.tasks.map((task) => renderTask(task, runningTaskId, actionsDisabled)).join("")}</section>`;
}

function renderTask(task: WorkspaceTask, runningTaskId: string | undefined, actionsDisabled: boolean): string {
  const running = runningTaskId === task.id;
  const runDisabled = runningTaskId !== undefined || actionsDisabled;
  const mutationDisabled = runningTaskId !== undefined || actionsDisabled;
  const description = task.description === undefined ? "" : `<span>${escapeHtml(task.description)}</span>`;
  return `
    <article class="task-card">
      <div class="task-copy">
        <strong>${escapeHtml(task.title)}</strong>
        ${description}
        <pre class="task-script" data-task-script>${escapeHtml(task.command)}</pre>
      </div>
      <div class="task-actions">
        <button type="button" class="secondary" data-edit-task="${escapeAttr(task.id)}" ${mutationDisabled ? "disabled" : ""}>Edit</button>
        <button type="button" class="secondary danger-secondary" data-delete-task="${escapeAttr(task.id)}" ${mutationDisabled ? "disabled" : ""}>Delete</button>
        <button type="button" data-task-id="${escapeAttr(task.id)}" ${runDisabled ? "disabled" : ""}>${running ? "Dispatching..." : "Run"}</button>
      </div>
    </article>
  `;
}

function findButtonByValue(root: ShadowRoot, attribute: string, value: string): HTMLElement | undefined {
  for (const button of root.querySelectorAll<HTMLElement>(`button[${attribute}]`)) {
    if (button.getAttribute(attribute) === value) return button;
  }
  return undefined;
}

function emptyDraft(): WorkspaceTaskDraft {
  return { id: "", title: "", command: "", description: "", group: "", confirm: false };
}

function cloneDraft(draft: WorkspaceTaskDraft): WorkspaceTaskDraft {
  return { ...draft };
}

function cacheKeyForContext(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}

function refreshStatus(state: ConfigState): TaskStatus | undefined {
  if (state.kind === "loaded") return { kind: "success", message: `Loaded ${String(state.config.tasks.length)} task${state.config.tasks.length === 1 ? "" : "s"}.` };
  if (state.kind === "missing") return { kind: "info", message: "No workspace tasks file is configured." };
  if (state.kind === "invalid") return { kind: "error", message: "Workspace tasks configuration is invalid.", detail: state.detail };
  const detail = state.detail;
  return detail === undefined
    ? { kind: "error", message: state.message }
    : { kind: "error", message: state.message, detail };
}

function failureMessage(kind: FailureKind): string {
  if (kind === "conflict") return "The tasks file changed outside this panel. Refresh before trying again.";
  if (kind === "preflight-unavailable") return "The current tasks file could not be verified. Refresh before trying again.";
  if (kind === "write-failed") return "The task write failed. Refresh before trying again; the result may be unknown.";
  return "The task was written, but the new file could not be verified. Refresh before trying again.";
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
  return `
    <style>
      :host { display: block; min-width: 0; container-type: inline-size; }
      .tasks-panel { min-width: 0; container-type: inline-size; color: var(--pi-text); }
      .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
      .toolbar h2 { margin: 0; font-size: 15px; }
      .toolbar-tasks { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .viewer { box-sizing: border-box; min-width: 0; min-height: 0; overflow: auto; padding: 12px; }
      .tasks-viewer { display: grid; align-content: start; gap: 12px; }
      .tasks { display: grid; gap: 14px; min-width: 0; }
      .task-group { display: grid; gap: 10px; min-width: 0; }
      .task-group h3 { margin: 4px 0 0; color: var(--pi-text-secondary); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; }
      .task-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); padding: 12px; }
      .task-copy { display: grid; min-width: 0; gap: 5px; }
      .task-copy span, .muted, .field-help { color: var(--pi-muted); }
      .task-script, .diagnostic { box-sizing: border-box; max-width: 100%; margin: 0; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
      .task-script { max-height: 12rem; overflow-y: auto; padding: 8px; }
      .diagnostic { max-height: 12rem; overflow: auto; padding: 8px; }
      code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      button { border: 1px solid var(--pi-accent-border); border-radius: 7px; background: var(--pi-accent); color: var(--pi-bg); cursor: pointer; padding: 6px 10px; font: inherit; }
      button.secondary { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-text); }
      button.danger, button.danger-secondary { border-color: var(--pi-danger); }
      button.danger { background: var(--pi-danger); color: var(--pi-bg); }
      button.danger-secondary { background: var(--pi-surface); color: var(--pi-danger); }
      button:disabled { cursor: wait; opacity: 0.65; }
      button:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex="-1"]:focus-visible { outline: 2px solid var(--pi-accent-border); outline-offset: 2px; }
      .task-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .task-editor, .confirmation { width: min(100%, 620px); box-sizing: border-box; padding: 16px; background: var(--pi-surface); border: 1px solid var(--pi-border); border-radius: 8px; }
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
      .empty-state { border: 1px dashed var(--pi-border-muted); border-radius: 8px; color: var(--pi-muted); padding: 12px; }
      .empty-state p { margin: 6px 0 0; }
      .panel-status { margin: 12px 12px 0; }
      .status { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
      .status.info { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
      .status.success { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
      .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
      .status.warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); color: var(--pi-text); }
      .status p { margin: 6px 0; }
      .empty { padding: 16px; color: var(--pi-muted); }
      @container (max-width: 600px) {
        .task-card { grid-template-columns: minmax(0, 1fr); }
        .task-actions { justify-content: flex-start; }
      }
    </style>
  `;
}
