/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-confusing-void-expression */
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import type { WorkspaceTask, WorkspaceTaskRef, WorkspaceTaskScope } from "../../src/shared/workspaceTasks";

interface CatalogState {
  readonly kind: "loading" | "loaded" | "missing" | "invalid" | "unavailable" | "error";
  readonly config?: { readonly version: 1; readonly tasks: readonly Readonly<WorkspaceTask>[] };
  readonly message?: string;
  readonly hint?: string;
  readonly detail?: string;
  readonly refreshing?: boolean;
  readonly refreshError?: string;
}

interface WorkspaceTasksWorkspaceState {
  readonly workspace: CatalogState;
  readonly global: CatalogState;
  readonly move?: { readonly kind: "partial" | "unknown-outcome" | "conflict"; readonly message: string; readonly retryAllowed: boolean };
  readonly mutationGate?: { readonly scopes: readonly WorkspaceTaskScope[]; readonly message: string };
}

interface WorkspaceTasksActions {
  create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void>;
  update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>;
  remove(ref: WorkspaceTaskRef): Promise<void>;
  move(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>;
  retryMove(): Promise<void>;
  refresh(): Promise<void>;
}
import { defineTasksPanelElement, tasksPanelTagName } from "./tasksPanelElement.js";

interface TasksPanelElement extends HTMLElement {
  context: WorkspacePanelContext | undefined;
  workspaceTasksState: WorkspaceTasksWorkspaceState;
  workspaceTasksActions: WorkspaceTasksActions;
}

const task = (overrides: Partial<WorkspaceTask> = {}): WorkspaceTask => ({
  id: "build",
  title: "Build",
  command: "npm run build",
  confirm: false,
  ...overrides,
});

const loadedState = (workspace: readonly WorkspaceTask[] = [task()], global: readonly WorkspaceTask[] = []): WorkspaceTasksWorkspaceState => ({
  workspace: { kind: "loaded", config: { version: 1, tasks: workspace }, refreshing: false },
  global: { kind: "loaded", config: { version: 1, tasks: global }, refreshing: false },
});

beforeEach(() => {
  defineTasksPanelElement();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("workspace tasks editor", () => {
  it("defaults a new task to Project and checks the global scope for a new global task", () => {
    const panel = mount(loadedState());
    button(panel, "[data-add-task]").click();
    expect(input(panel, "[data-editor-global]").checked).toBe(false);
    expect(panel.shadowRoot?.textContent).toContain("Project task");
    button(panel, "[data-cancel-editor]").click();
    button(panel, "[data-add-task]").click();
    input(panel, "[data-editor-global]").click();
    expect(input(panel, "[data-editor-global]").checked).toBe(true);
    expect(panel.shadowRoot?.textContent).toContain("Global task");
  });

  it("edits within the same scope and sends the full task through controller actions", async () => {
    const actions = createActions();
    const panel = mount(loadedState([task()]), actions);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-title]").value = "Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    textarea(panel).value = "set -e\nnpm run release\n";
    textarea(panel).dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
    expect(actions.update).toHaveBeenCalledWith({ scope: "workspace", id: "build" }, expect.objectContaining({
      id: "build",
      title: "Release",
      command: "set -e\nnpm run release\n",
    }));
  });

  it("confirms promotion, supports a changed destination ID, and sends the source ref separately", async () => {
    const actions = createActions();
    const panel = mount(loadedState([task()], []), actions);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-global]").click();
    input(panel, "[data-editor-id]").value = "release";
    input(panel, "[data-editor-id]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();

    expect(panel.shadowRoot?.querySelector("[data-move-confirmation]")).not.toBeNull();
    expect(panel.shadowRoot?.textContent).toContain("Project to Global");
    button(panel, "[data-confirm-move]").click();
    await vi.waitFor(() => expect(actions.move).toHaveBeenCalledTimes(1));
    expect(actions.move).toHaveBeenCalledWith({ scope: "workspace", id: "build" }, expect.objectContaining({ id: "release" }));
  });

  it("shows destination collision validation and does not call move", () => {
    const actions = createActions();
    const panel = mount(loadedState([task()], [task({ id: "release", title: "Release" })]), actions);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-global]").click();
    input(panel, "[data-editor-id]").value = "release";
    input(panel, "[data-editor-id]").dispatchEvent(new Event("input", { bubbles: true }));
    expect(button(panel, "[data-save-task]").disabled).toBe(true);
    expect(panel.shadowRoot?.textContent).toContain("already exists");
    expect(actions.move).not.toHaveBeenCalled();
  });

  it("keeps a partial move recoverable, enables Retry only after authoritative state, and preserves manual-resolution copy", async () => {
    const actions = createActions();
    const panel = mount(loadedState([task()], []), actions);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-global]").click();
    button(panel, "[data-save-task]").click();
    button(panel, "[data-confirm-move]").click();
    await vi.waitFor(() => expect(actions.move).toHaveBeenCalledTimes(1));

    panel.workspaceTasksState = {
      workspace: { kind: "loaded", config: { version: 1, tasks: [task()] }, refreshing: false },
      global: { kind: "loaded", config: { version: 1, tasks: [task()] }, refreshing: false },
      move: { kind: "partial", message: "Move is partially complete.", retryAllowed: false },
      mutationGate: { scopes: ["workspace", "global"], message: "Move recovery pending." },
    };
    expect(button(panel, "[data-retry-move]").disabled).toBe(true);
    panel.workspaceTasksState = {
      ...panel.workspaceTasksState,
      move: { kind: "partial", message: "Move is partially complete.", retryAllowed: true },
    };
    expect(button(panel, "[data-retry-move]").disabled).toBe(false);
    button(panel, "[data-retry-move]").click();
    await vi.waitFor(() => expect(actions.retryMove).toHaveBeenCalledTimes(1));

    panel.workspaceTasksState = {
      ...panel.workspaceTasksState,
      move: { kind: "conflict", message: "Manual resolution required.", retryAllowed: false },
    };
    expect(panel.shadowRoot?.textContent).toContain("Manual resolution required.");
    expect(button(panel, "[data-retry-move]").disabled).toBe(true);
  });

  it("requires confirmation before Refresh discards a dirty draft, and Cancel leaves the mutation gate", () => {
    const actions = createActions();
    const panel = mount(loadedState(), actions);
    button(panel, "[data-add-task]").click();
    input(panel, "[data-editor-title]").value = "Draft";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-refresh]").click();
    expect(panel.shadowRoot?.querySelector("[data-refresh-discard-confirmation]")).not.toBeNull();
    button(panel, "[data-cancel-refresh-discard]").click();
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();

    panel.workspaceTasksState = {
      ...loadedState(),
      mutationGate: { scopes: ["workspace"], message: "Refresh required before editing." },
    };
    button(panel, "[data-cancel-editor]").click();
    expect(panel.shadowRoot?.textContent).toContain("Refresh required before editing.");
    expect(button(panel, "[data-edit-task='workspace:build']").disabled).toBe(true);
  });

  it("restores focus to the source action after Cancel", () => {
    const panel = mount(loadedState());
    const edit = button(panel, "[data-edit-task='workspace:build']");
    edit.click();
    button(panel, "[data-cancel-editor]").click();
    expect(panel.shadowRoot?.activeElement).toBe(panel.shadowRoot?.querySelector("[data-edit-task='workspace:build']"));
  });
});

function mount(nextState: WorkspaceTasksWorkspaceState, actions = createActions()): TasksPanelElement {
  const panel = document.createElement(tasksPanelTagName) as TasksPanelElement;
  panel.context = createContext();
  panel.workspaceTasksActions = actions;
  panel.workspaceTasksState = nextState;
  document.body.append(panel);
  return panel;
}

function createActions(): WorkspaceTasksActions & { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn>; retryMove: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } {
  return {
    create: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    move: vi.fn(() => Promise.resolve()),
    retryMove: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
}

function button(panel: HTMLElement, selector: string): HTMLButtonElement {
  const element = panel.shadowRoot?.querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button ${selector}`);
  return element;
}

function input(panel: HTMLElement, selector: string): HTMLInputElement {
  const element = panel.shadowRoot?.querySelector(selector);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Expected input ${selector}`);
  return element;
}

function textarea(panel: HTMLElement): HTMLTextAreaElement {
  const element = panel.shadowRoot?.querySelector("[data-editor-command]");
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("Expected command textarea");
  return element;
}

function createContext(): WorkspacePanelContext {
  return {
    machine: { id: "local", kind: "local", name: "Local" },
    workspace: { id: "ws", projectId: "project", path: "/tmp/ws", label: "Project", isMain: true, isGitRepo: false, isGitWorktree: false },
    state: {},
    files: { readFile: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
  };
}
