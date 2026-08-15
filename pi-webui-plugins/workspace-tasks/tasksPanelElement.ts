import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import { TASKS_CONFIG_PATH, type WorkspaceTask } from "./config.js";
import { runWorkspaceTaskInTerminal } from "./taskRunner.js";
import { loadWorkspaceTasksConfig, tasksConfigRefreshHint, tasksConfigUnavailableMessage, type WorkspaceTasksConfigLoadResult } from "./workspaceTasksClient.js";

export const tasksPanelTagName = "pi-webui-workspace-tasks-panel";

const configChangedEvent = "pi-webui-workspace-tasks-config-changed";

type ConfigState =
  | { kind: "loading" }
  | WorkspaceTasksConfigLoadResult;

interface TaskStatus {
  kind: "info" | "success" | "error";
  message: string;
  detail?: string;
}

type EditorMode = "view" | "add" | "edit" | "delete-confirm";

interface TaskDraft {
  id: string;
  title: string;
  command: string;
  description: string;
  group: string;
  confirm: boolean;
  originalId?: string; // Track original ID when editing to find the task to replace
}

const configCache = new Map<string, ConfigState>();

export function clearConfigCacheForTesting(): void {
  configCache.clear();
}

export function defineTasksPanelElement(): void {
  if (!customElements.get(tasksPanelTagName)) customElements.define(tasksPanelTagName, PiWebUiTasksPanel);
}

export function tasksPanelBadge(context: WorkspacePanelContext): string | undefined {
  const state = getCachedWorkspaceConfig(context);
  return state?.kind === "unavailable" ? "!" : undefined;
}

class PiWebUiTasksPanel extends HTMLElement {
  private contextValue: WorkspacePanelContext | undefined;
  private runningTaskId: string | undefined;
  private status: TaskStatus | undefined;
  private editorMode: EditorMode = "view";
  private taskDraft: TaskDraft = { id: "", title: "", command: "", description: "", group: "", confirm: false };
  private idManuallyEdited = false;
  private taskToDelete: WorkspaceTask | undefined;
  private readonly root: ShadowRoot;
  private readonly onConfigChanged = () => {
    this.render();
  };

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  set context(value: WorkspacePanelContext | undefined) {
    const previousKey = this.contextValue === undefined ? undefined : cacheKeyForContext(this.contextValue);
    const nextKey = value === undefined ? undefined : cacheKeyForContext(value);
    this.contextValue = value;
    // Parent app updates should not rebuild this shadow DOM for the same workspace:
    // doing so resets the mobile scroll position and can replace buttons mid-click.
    if (previousKey === nextKey) return;
    this.runningTaskId = undefined;
    this.status = undefined;
    this.editorMode = "view";
    this.taskDraft = { id: "", title: "", command: "", description: "", group: "", confirm: false };
    this.render();
  }

  connectedCallback(): void {
    window.addEventListener(configChangedEvent, this.onConfigChanged);
    this.render();
  }

  disconnectedCallback(): void {
    window.removeEventListener(configChangedEvent, this.onConfigChanged);
  }

  private render(): void {
    const context = this.contextValue;
    if (context === undefined) {
      this.root.innerHTML = `${taskStyles()}<section class="empty">Select a workspace.</section>`;
      return;
    }

    const state = getOrLoadWorkspaceConfig(context);
    this.root.innerHTML = `
      ${taskStyles()}
      <section class="toolbar">
        <strong>Workspace Tasks</strong>
        <span class="toolbar-tasks">
          ${this.editorMode === "view" && (state.kind === "loaded" || state.kind === "missing") ? `<button class="secondary" data-add-task>Add Task</button>` : ""}
          <button class="secondary" data-refresh-config ${state.kind === "loading" ? "disabled" : ""}>Refresh</button>
          <button class="secondary" data-open-terminal>Open Terminal</button>
        </span>
      </section>
      ${this.renderStatus()}
      <section class="viewer tasks-viewer">
        ${this.editorMode === "delete-confirm" ? this.renderDeleteConfirmation() : this.editorMode === "view" ? this.renderConfigState(state) : this.renderEditor()}
      </section>
    `;

    this.root.querySelector("button[data-add-task]")?.addEventListener("click", () => {
      this.openAddTaskEditor();
    });

    this.root.querySelector("button[data-refresh-config]")?.addEventListener("click", () => {
      void this.refreshConfig(context);
    });

    for (const button of this.root.querySelectorAll("button[data-task-id]")) {
      button.addEventListener("click", () => {
        void this.dispatchTaskById(context, button.getAttribute("data-task-id"));
      });
    }

    for (const button of this.root.querySelectorAll("button[data-edit-task]")) {
      button.addEventListener("click", () => {
        this.openEditTaskEditor(context, button.getAttribute("data-edit-task"));
      });
    }

    for (const button of this.root.querySelectorAll("button[data-delete-task]")) {
      button.addEventListener("click", () => {
        this.openDeleteConfirmation(context, button.getAttribute("data-delete-task"));
      });
    }

    this.root.querySelector("button[data-open-terminal]")?.addEventListener("click", () => {
      this.openWorkspaceTerminal();
    });

    // Editor event listeners
    this.root.querySelector("input[data-editor-title]")?.addEventListener("input", (e) => {
      if (e.target instanceof HTMLInputElement) {
        this.taskDraft.title = e.target.value;
        if (!this.idManuallyEdited) {
          this.taskDraft.id = suggestTaskId(e.target.value);
          const idInput = this.root.querySelector<HTMLInputElement>("input[data-editor-id]");
          if (idInput) {
            idInput.value = this.taskDraft.id;
            idInput.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        this.updateSaveButtonState();
      }
    });

    this.root.querySelector("input[data-editor-command]")?.addEventListener("input", (e) => {
      if (e.target instanceof HTMLInputElement) {
        this.taskDraft.command = e.target.value;
        this.updateSaveButtonState();
      }
    });

    this.root.querySelector("input[data-editor-id]")?.addEventListener("input", (e) => {
      if (e.target instanceof HTMLInputElement) {
        this.taskDraft.id = e.target.value;
        this.idManuallyEdited = true;
      }
    });

    this.root.querySelector("input[data-editor-description]")?.addEventListener("input", (e) => {
      if (e.target instanceof HTMLInputElement) this.taskDraft.description = e.target.value;
    });

    this.root.querySelector("input[data-editor-group]")?.addEventListener("input", (e) => {
      if (e.target instanceof HTMLInputElement) this.taskDraft.group = e.target.value;
    });

    this.root.querySelector("input[data-editor-confirm]")?.addEventListener("change", (e) => {
      if (e.target instanceof HTMLInputElement) this.taskDraft.confirm = e.target.checked;
    });

    this.root.querySelector("button[data-cancel-editor]")?.addEventListener("click", () => {
      this.cancelEditor();
    });

    this.root.querySelector("button[data-save-task]")?.addEventListener("click", () => {
      void this.saveTask(context);
    });

    this.root.querySelector("button[data-cancel-delete]")?.addEventListener("click", () => {
      this.cancelDelete();
    });

    this.root.querySelector("button[data-confirm-delete]")?.addEventListener("click", () => {
      void this.confirmDelete(context);
    });
  }

  private dispatchTaskById(context: WorkspacePanelContext, taskId: string | null): Promise<void> {
    if (!this.isCurrentContext(context)) return Promise.resolve();
    const task = taskFromConfigState(getCachedWorkspaceConfig(context), taskId);
    if (task === undefined) {
      this.status = { kind: "error", message: "That task is no longer available. Click Refresh, then try again." };
      this.render();
      return Promise.resolve();
    }
    return this.dispatchTask(context, task);
  }

  private isCurrentContext(context: WorkspacePanelContext): boolean {
    return this.contextValue !== undefined && cacheKeyForContext(this.contextValue) === cacheKeyForContext(context);
  }

  private renderConfigState(state: ConfigState): string {
    if (state.kind === "loading") return `<p class="muted">Loading ${escapeHtml(TASKS_CONFIG_PATH)}…</p>`;
    if (state.kind === "missing") return renderMissingState(state);
    if (state.kind === "unavailable") return renderUnavailableState(state);
    if (state.kind === "invalid") return renderInvalidState(state);

    if (state.config.tasks.length === 0) return `<p class="muted">No tasks are defined in ${escapeHtml(state.path)}. Add tasks to the file, then click Refresh.</p>`;
    return `
      <p class="muted">Tasks run in a dedicated workspace terminal, then switch to that terminal. Edit ${escapeHtml(state.path)} and click Refresh to reload.</p>
      ${renderTaskGroups(state.config.tasks, this.runningTaskId)}
    `;
  }

  private renderStatus(): string {
    if (this.status === undefined) return "";
    const detail = this.status.detail === undefined ? "" : `<pre>${escapeHtml(this.status.detail)}</pre>`;
    return `<div class="status panel-status ${escapeAttr(this.status.kind)}">${escapeHtml(this.status.message)}${detail}</div>`;
  }

  private async refreshConfig(context: WorkspacePanelContext): Promise<void> {
    this.status = { kind: "info", message: `Refreshing ${TASKS_CONFIG_PATH}…` };
    configCache.set(cacheKeyForContext(context), { kind: "loading" });
    this.render();

    const state = await refreshWorkspaceConfig(context);
    if (!this.isCurrentContext(context)) return;
    this.status = state.kind === "loaded"
      ? { kind: "success", message: `Loaded ${String(state.config.tasks.length)} task${state.config.tasks.length === 1 ? "" : "s"}.` }
      : undefined;
    this.render();
  }

  private async dispatchTask(context: WorkspacePanelContext, task: WorkspaceTask): Promise<void> {
    if (this.runningTaskId !== undefined) {
      this.status = { kind: "info", message: "Another task is already starting. Wait for it to finish dispatching, then try again." };
      this.render();
      return;
    }
    if (task.confirm && !window.confirm(`Run ${task.title}?\n\n${task.command}`)) {
      this.status = { kind: "info", message: `Cancelled ${task.title}.` };
      this.render();
      return;
    }

    this.runningTaskId = task.id;
    this.status = { kind: "info", message: `Starting ${task.title}…` };
    this.render();

    try {
      const handle = await runWorkspaceTaskInTerminal(context.terminal, task);
      if (!this.isCurrentContext(context)) return;
      this.status = {
        kind: "success",
        message: `Started terminal command “${handle.run.title}”.`,
        detail: task.command,
      };
      this.runningTaskId = undefined;
      this.render();
    } catch (error) {
      if (!this.isCurrentContext(context)) return;
      this.runningTaskId = undefined;
      this.status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
      this.render();
    }
  }

  private openWorkspaceTerminal(terminalId?: string): void {
    const context = this.contextValue;
    if (context === undefined) {
      this.status = { kind: "error", message: "Select a workspace before opening a terminal." };
      this.render();
      return;
    }
    if (terminalId === undefined) context.terminal.open();
    else context.terminal.open({ terminalId });
  }

  private openAddTaskEditor(): void {
    this.editorMode = "add";
    this.taskDraft = { id: "", title: "", command: "", description: "", group: "", confirm: false };
    this.idManuallyEdited = false;
    this.status = undefined;
    this.render();
  }

  private openEditTaskEditor(context: WorkspacePanelContext, taskId: string | null): void {
    const task = taskFromConfigState(getCachedWorkspaceConfig(context), taskId);
    if (task === undefined) {
      this.status = { kind: "error", message: "That task is no longer available. Click Refresh, then try again." };
      this.render();
      return;
    }
    this.editorMode = "edit";
    this.taskDraft = {
      id: task.id,
      title: task.title,
      command: task.command,
      description: task.description ?? "",
      group: task.group ?? "",
      confirm: task.confirm,
      originalId: task.id,
    };
    this.idManuallyEdited = true; // Don't auto-suggest ID when editing
    this.status = undefined;
    this.render();
  }

  private openDeleteConfirmation(context: WorkspacePanelContext, taskId: string | null): void {
    const task = taskFromConfigState(getCachedWorkspaceConfig(context), taskId);
    if (task === undefined) {
      this.status = { kind: "error", message: "That task is no longer available. Click Refresh, then try again." };
      this.render();
      return;
    }
    this.editorMode = "delete-confirm";
    this.taskToDelete = task;
    this.status = undefined;
    this.render();
  }

  private cancelDelete(): void {
    this.editorMode = "view";
    this.taskToDelete = undefined;
    this.status = undefined;
    this.render();
  }

  private async confirmDelete(context: WorkspacePanelContext): Promise<void> {
    if (!this.isCurrentContext(context) || this.taskToDelete === undefined) return;

    const state = getCachedWorkspaceConfig(context);
    if (state?.kind !== "loaded") {
      this.status = { kind: "error", message: "Cannot delete: config is not loaded." };
      this.render();
      return;
    }

    const taskToDelete = this.taskToDelete;
    const taskTitle = taskToDelete.title;
    const updatedTasks = state.config.tasks.filter((task) => task.id !== taskToDelete.id);
    const updatedConfig = {
      version: 1 as const,
      tasks: updatedTasks,
    };

    try {
      await context.files.writeFile(TASKS_CONFIG_PATH, JSON.stringify(updatedConfig, null, 2));
      await refreshWorkspaceConfig(context);
      this.editorMode = "view";
      this.taskToDelete = undefined;
      this.status = { kind: "success", message: `Deleted task "${taskTitle}".` };
      this.render();
    } catch (error) {
      this.status = { kind: "error", message: `Failed to delete task: ${error instanceof Error ? error.message : String(error)}` };
      this.render();
    }
  }

  private cancelEditor(): void {
    this.editorMode = "view";
    this.taskDraft = { id: "", title: "", command: "", description: "", group: "", confirm: false };
    this.idManuallyEdited = false;
    this.status = undefined;
    this.render();
  }

  private updateSaveButtonState(): void {
    const canSave = this.taskDraft.title.trim() !== "" && this.taskDraft.command.trim() !== "";
    const saveButton = this.root.querySelector<HTMLButtonElement>("button[data-save-task]");
    if (saveButton) saveButton.disabled = !canSave;
  }

  private async saveTask(context: WorkspacePanelContext): Promise<void> {
    if (!this.isCurrentContext(context)) return;

    const state = getCachedWorkspaceConfig(context);
    if (state?.kind !== "loaded" && state?.kind !== "missing") {
      this.status = { kind: "error", message: "Cannot save: config is not loaded." };
      this.render();
      return;
    }

    const existingTasks = state.kind === "loaded" ? state.config.tasks : [];
    const newTask: WorkspaceTask = {
      id: this.taskDraft.id.trim() || suggestTaskId(this.taskDraft.title),
      title: this.taskDraft.title.trim(),
      command: this.taskDraft.command.trim(),
      ...(this.taskDraft.description.trim() === "" ? {} : { description: this.taskDraft.description.trim() }),
      ...(this.taskDraft.group.trim() === "" ? {} : { group: this.taskDraft.group.trim() }),
      confirm: this.taskDraft.confirm,
    };

    let updatedTasks: WorkspaceTask[];
    if (this.editorMode === "edit" && this.taskDraft.originalId !== undefined) {
      // Replace the existing task
      updatedTasks = existingTasks.map(t => t.id === this.taskDraft.originalId ? newTask : t);
    } else {
      // Add new task
      updatedTasks = [...existingTasks, newTask];
    }

    const updatedConfig = {
      version: 1 as const,
      tasks: updatedTasks,
    };

    try {
      await context.files.writeFile(TASKS_CONFIG_PATH, JSON.stringify(updatedConfig, null, 2));
      await refreshWorkspaceConfig(context);
      this.editorMode = "view";
      this.taskDraft = { id: "", title: "", command: "", description: "", group: "", confirm: false };
      this.idManuallyEdited = false;
      this.status = { kind: "success", message: `Saved task "${newTask.title}".` };
      this.render();
    } catch (error) {
      this.status = { kind: "error", message: `Failed to save task: ${error instanceof Error ? error.message : String(error)}` };
      this.render();
    }
  }

  private renderEditor(): string {
    const canSave = this.taskDraft.title.trim() !== "" && this.taskDraft.command.trim() !== "";
    return `
      <div class="task-editor">
        <h3>${this.editorMode === "add" ? "Add Task" : "Edit Task"}</h3>
        <form class="task-form">
          <label>
            Title <span class="required">*</span>
            <input name="title" type="text" value="${escapeAttr(this.taskDraft.title)}" placeholder="Build app" data-editor-title />
          </label>
          <label>
            Command <span class="required">*</span>
            <input name="command" type="text" value="${escapeAttr(this.taskDraft.command)}" placeholder="npm run build" data-editor-command />
          </label>
          <label>
            ID
            <input name="id" type="text" value="${escapeAttr(this.taskDraft.id)}" placeholder="Auto-generated from title" data-editor-id />
          </label>
          <label>
            Description
            <input name="description" type="text" value="${escapeAttr(this.taskDraft.description)}" placeholder="Optional description" data-editor-description />
          </label>
          <label>
            Group
            <input name="group" type="text" value="${escapeAttr(this.taskDraft.group)}" placeholder="Optional group name" data-editor-group />
          </label>
          <label class="checkbox-label">
            <input name="confirm" type="checkbox" ${this.taskDraft.confirm ? "checked" : ""} data-editor-confirm />
            Require confirmation before running
          </label>
          <div class="editor-actions">
            <button type="button" class="secondary" data-cancel-editor>Cancel</button>
            <button type="button" class="primary" data-save-task ${canSave ? "" : "disabled"}>Save Task</button>
          </div>
        </form>
      </div>
    `;
  }

  private renderDeleteConfirmation(): string {
    if (this.taskToDelete === undefined) return "";
    return `
      <div class="delete-confirm">
        <h3>Delete Task</h3>
        <p>Are you sure you want to delete <strong>${escapeHtml(this.taskToDelete.title)}</strong>?</p>
        <code>${escapeHtml(this.taskToDelete.command)}</code>
        <div class="editor-actions">
          <button type="button" class="secondary" data-cancel-delete>Cancel</button>
          <button type="button" class="danger" data-confirm-delete>Delete Task</button>
        </div>
      </div>
    `;
  }
}

function getCachedWorkspaceConfig(context: WorkspacePanelContext): ConfigState | undefined {
  return configCache.get(cacheKeyForContext(context));
}

function getOrLoadWorkspaceConfig(context: WorkspacePanelContext): ConfigState {
  const cached = getCachedWorkspaceConfig(context);
  if (cached !== undefined) return cached;

  const loading: ConfigState = { kind: "loading" };
  configCache.set(cacheKeyForContext(context), loading);
  void refreshWorkspaceConfig(context);
  return loading;
}

async function refreshWorkspaceConfig(context: WorkspacePanelContext): Promise<ConfigState> {
  const key = cacheKeyForContext(context);
  const state = await loadWorkspaceTasksConfig(context.files).catch((error: unknown): ConfigState => ({
    kind: "unavailable",
    message: tasksConfigUnavailableMessage,
    hint: tasksConfigRefreshHint,
    detail: error instanceof Error ? error.message : String(error),
  }));
  configCache.set(key, state);
  context.host.requestRender();
  window.dispatchEvent(new Event(configChangedEvent));
  return state;
}

function cacheKeyForContext(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}

function renderMissingState(state: Extract<ConfigState, { kind: "missing" }>): string {
  return `<div class="empty-state"><strong>${escapeHtml(state.message)}</strong><p>${escapeHtml(state.hint)}</p></div>`;
}

function renderUnavailableState(state: Extract<ConfigState, { kind: "unavailable" }>): string {
  const detail = state.detail === undefined ? "" : `<pre>${escapeHtml(state.detail)}</pre>`;
  return `<div class="status error"><strong>${escapeHtml(state.message)}</strong><p>${escapeHtml(state.hint)}</p>${detail}</div>`;
}

function renderInvalidState(state: Extract<ConfigState, { kind: "invalid" }>): string {
  return `<div class="status error"><strong>${escapeHtml(state.message)}</strong><p>${escapeHtml(state.hint)}</p><pre>${escapeHtml(state.detail)}</pre></div>`;
}

function renderTaskGroups(tasks: WorkspaceTask[], runningTaskId: string | undefined): string {
  return `<div class="tasks">${groupTasks(tasks).map((group) => renderTaskGroup(group, runningTaskId)).join("")}</div>`;
}

function groupTasks(tasks: WorkspaceTask[]): { title: string | undefined; tasks: WorkspaceTask[] }[] {
  const groups: { title: string | undefined; tasks: WorkspaceTask[] }[] = [];
  for (const task of tasks) {
    const title = task.group;
    let group = groups.find((candidate) => candidate.title === title);
    if (group === undefined) {
      group = { title, tasks: [] };
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}

function renderTaskGroup(group: { title: string | undefined; tasks: WorkspaceTask[] }, runningTaskId: string | undefined): string {
  const title = group.title === undefined ? "" : `<h3>${escapeHtml(group.title)}</h3>`;
  return `<section class="task-group">${title}${group.tasks.map((task) => renderTask(task, runningTaskId)).join("")}</section>`;
}

function renderTask(task: WorkspaceTask, runningTaskId: string | undefined): string {
  const running = runningTaskId === task.id;
  const disabled = runningTaskId !== undefined;
  const description = task.description === undefined ? "" : `<span>${escapeHtml(task.description)}</span>`;
  return `
    <article class="task-card">
      <div class="task-copy">
        <strong>${escapeHtml(task.title)}</strong>
        ${description}
        <code>${escapeHtml(task.command)}</code>
      </div>
      <div class="task-actions">
        <button class="secondary" data-edit-task="${escapeAttr(task.id)}" ${disabled ? "disabled" : ""}>Edit</button>
        <button class="secondary danger-secondary" data-delete-task="${escapeAttr(task.id)}" ${disabled ? "disabled" : ""}>Delete</button>
        <button data-task-id="${escapeAttr(task.id)}" ${disabled ? "disabled" : ""}>${running ? "Dispatching…" : "Run"}</button>
      </div>
    </article>
  `;
}

function taskFromConfigState(state: ConfigState | undefined, taskId: string | null): WorkspaceTask | undefined {
  if (state?.kind !== "loaded" || taskId === null) return undefined;
  return state.config.tasks.find((task) => task.id === taskId);
}

function taskStyles(): string {
  return `
    <style>
      :host { display: contents; }
      .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
      .toolbar-tasks { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .viewer { box-sizing: border-box; min-height: 0; overflow: auto; padding: 12px; }
      .tasks-viewer { display: grid; align-content: start; gap: 12px; }
      .tasks { display: grid; gap: 14px; }
      .task-group { display: grid; gap: 10px; }
      .task-group h3 { margin: 4px 0 0; color: var(--pi-text-secondary); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; }
      .task-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
      .task-copy { display: grid; min-width: 0; gap: 5px; }
      .task-copy span, .muted { color: var(--pi-muted); }
      code, pre { border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      code { overflow: auto; padding: 5px 7px; white-space: nowrap; }
      pre { margin: 8px 0 0; overflow: auto; padding: 8px; white-space: pre-wrap; }
      button { border: 1px solid var(--pi-accent-border); border-radius: 7px; background: var(--pi-accent); color: var(--pi-bg); cursor: pointer; padding: 6px 10px; font: inherit; }
      button.secondary { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-text); }
      button.danger { border-color: var(--pi-danger); background: var(--pi-danger); color: var(--pi-bg); }
      button.danger-secondary { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-danger); }
      button:disabled { cursor: wait; opacity: 0.65; }
      .task-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .task-editor, .delete-confirm { max-width: 600px; padding: 16px; background: var(--pi-surface); border: 1px solid var(--pi-border); border-radius: 10px; }
      .task-editor h3, .delete-confirm h3 { margin: 0 0 16px; font-size: 18px; }
      .delete-confirm p { margin: 0 0 8px; line-height: 1.5; }
      .delete-confirm code { display: block; margin: 8px 0 16px; }
      .task-form { display: grid; gap: 14px; }
      .task-form label { display: grid; gap: 6px; font-size: 14px; font-weight: 500; }
      .task-form label .required { color: var(--pi-danger); }
      .task-form input[type="text"] { padding: 8px 10px; background: var(--pi-bg); border: 1px solid var(--pi-border); border-radius: 6px; font-size: 14px; color: var(--pi-text); font-family: inherit; }
      .task-form input[type="text"]::placeholder { color: var(--pi-muted); }
      .task-form input[type="text"]:focus { outline: none; border-color: var(--pi-accent-border); }
      .checkbox-label { grid-template-columns: auto 1fr !important; align-items: center; gap: 8px !important; }
      .checkbox-label input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
      .editor-actions { display: flex; gap: 8px; margin-top: 4px; justify-content: flex-end; }
      .empty-state { border: 1px dashed var(--pi-border-muted); border-radius: 8px; color: var(--pi-muted); padding: 12px; }
      .empty-state p { margin: 6px 0 0; }
      .panel-status { margin: 12px 12px 0; }
      .status { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
      .status.info { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
      .status.success { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
      .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
      .empty { padding: 16px; color: var(--pi-muted); }
      @media (max-width: 760px) {
        .task-card { grid-template-columns: 1fr; }
        .task-card button { justify-self: start; }
      }
    </style>
  `;
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function suggestTaskId(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}
