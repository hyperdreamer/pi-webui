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
  readonly sourceGenerations?: { readonly workspace: number; readonly global: number };
  readonly move?: { readonly kind: "partial" | "unknown-outcome" | "conflict"; readonly message: string; readonly retryAllowed: boolean };
  readonly moveError?: { readonly kind: "validation" | "unavailable"; readonly message: string };
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

type BridgeActionName = keyof WorkspaceTasksActions;
type MockedWorkspaceTasksActions = WorkspaceTasksActions & {
  readonly create: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
  readonly move: ReturnType<typeof vi.fn>;
  readonly retryMove: ReturnType<typeof vi.fn>;
  readonly refresh: ReturnType<typeof vi.fn>;
};

interface ControllableBridge {
  readonly actions: MockedWorkspaceTasksActions;
  attach(panel: TasksPanelElement): void;
  publish(nextState: WorkspaceTasksWorkspaceState): void;
  publishWorkspace(nextCatalog: CatalogState): void;
  publishGlobal(nextCatalog: CatalogState): void;
  resolve(action: BridgeActionName): void;
  complete(action: BridgeActionName, nextState: WorkspaceTasksWorkspaceState): void;
  settleThenPublish(action: BridgeActionName, nextState: WorkspaceTasksWorkspaceState): void;
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
  sourceGenerations: { workspace: 1, global: 1 },
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

  it("short-circuits an unchanged edit without sending a write", () => {
    const actions = createActions();
    const panel = mount(loadedState([task()], []), actions);
    button(panel, "[data-edit-task='workspace:build']").click();
    button(panel, "[data-save-task]").click();

    expect(actions.update).not.toHaveBeenCalled();
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).toBeNull();
    expect(panelStatusText(panel)).toContain("No changes to save.");
  });  it("confirms promotion, supports a changed destination ID, and sends the source ref separately", async () => {
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

  it.each([
    ["create", "validation", "workspace"],
    ["create", "unavailable", "global"],
    ["update", "validation", "workspace"],
    ["update", "unavailable", "global"],
    ["remove", "validation", "workspace"],
    ["remove", "unavailable", "global"],
  ] as const)("retains the %s context when its %s result publishes a source refresh error", async (action, result, scope) => {
    const bridge = createControllableBridge();
    const initial = loadedState([
      task({ id: "workspace-build", title: "Project Build" }),
    ], [
      task({ id: "global-build", title: "Global Build" }),
    ]);
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    const failure = `${result} ${scope} task mutation`;

    if (action === "create") {
      button(panel, "[data-add-task]").click();
      if (scope === "global") input(panel, "[data-editor-global]").click();
      input(panel, "[data-editor-title]").value = "Release";
      input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
      textarea(panel).value = "npm run release";
      textarea(panel).dispatchEvent(new Event("input", { bubbles: true }));
      button(panel, "[data-save-task]").click();
    } else if (action === "update") {
      const id = scope === "workspace" ? "workspace-build" : "global-build";
      button(panel, `[data-edit-task='${scope}:${id}']`).click();
      input(panel, "[data-editor-title]").value = "Changed";
      input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
      button(panel, "[data-save-task]").click();
    } else {
      const id = scope === "workspace" ? "workspace-build" : "global-build";
      button(panel, `[data-delete-task='${scope}:${id}']`).click();
      button(panel, "[data-confirm-delete]").click();
    }

    await vi.waitFor(() => expect(bridge.actions[action]).toHaveBeenCalledTimes(1));
    bridge.settleThenPublish(action, withSourceRefreshError(initial, scope, failure));

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain(failure));
    expect(panel.shadowRoot?.querySelector(action === "remove" ? "[data-delete-confirmation]" : "[data-task-editor]")).not.toBeNull();
    expect(panelStatusText(panel)).not.toMatch(/Saved task|Deleted task/);
  });

  it("retains a draft when Create resolves without an authoritative source publication", async () => {
    const bridge = createControllableBridge();
    const panel = mount(loadedState(), bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-add-task]").click();
    input(panel, "[data-editor-title]").value = "Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    textarea(panel).value = "npm run release";
    textarea(panel).dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.create).toHaveBeenCalledTimes(1));

    bridge.resolve("create");

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Creating workspace task..."));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();
  });

  it("settles a canonical no-op update only after its matching source generation publication", async () => {
    const bridge = createControllableBridge();
    const panel = mount(loadedState([task()], []), bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-description]").value = " ";
    input(panel, "[data-editor-description]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));

    bridge.resolve("update");
    bridge.publish({
      ...loadedState([task()], []),
      sourceGenerations: { workspace: 1, global: 2 },
    });

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Saving workspace task..."));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();

    bridge.publish({
      ...loadedState([task()], []),
      sourceGenerations: { workspace: 2, global: 2 },
    });

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain('Saved task "Build".'));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).toBeNull();
    expect(panel.shadowRoot?.activeElement).toBe(panel.shadowRoot?.querySelector("[data-edit-task='workspace:build']"));
  });

  it.each(["validation", "unavailable"] as const)("retains the move editor for a known %s error without blocking later task actions", async (kind) => {
    const bridge = createControllableBridge();
    const panel = mount(loadedState([task()], []), bridge.actions);
    bridge.attach(panel);
    startScopeMove(panel, "workspace", "release");
    await vi.waitFor(() => expect(bridge.actions.move).toHaveBeenCalledTimes(1));

    bridge.complete("move", {
      ...loadedState([task()], []),
      moveError: { kind, message: `${kind} move failed before any catalog write.` },
    });

    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("[data-move-error]")?.textContent).toContain(`${kind} move failed`));
    expect(panel.shadowRoot?.querySelector("[data-move-confirmation]")).not.toBeNull();
    expect(panel.shadowRoot?.querySelector("[data-retry-move]")).toBeNull();
    expect(button(panel, "[data-cancel-move]")).not.toBeNull();

    button(panel, "[data-cancel-move]").click();
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();
    if (input(panel, "[data-editor-global]").checked) input(panel, "[data-editor-global]").click();
    input(panel, "[data-editor-title]").value = "Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));
  });

  it("keeps a successful update pending until its delayed authoritative snapshot arrives", async () => {
    const bridge = createControllableBridge();
    const panel = mount(loadedState([task()], []), bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-title]").value = "Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));

    bridge.resolve("update");
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Saving workspace task..."));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();

    bridge.publish(loadedState([task({ title: "Release" })], []));
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain('Saved task "Release".'));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).toBeNull();
  });

  it("keeps a successful create pending until its delayed authoritative snapshot arrives", async () => {
    const bridge = createControllableBridge();
    const panel = mount(loadedState([], []), bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-add-task]").click();
    input(panel, "[data-editor-title]").value = "Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    textarea(panel).value = "npm run release";
    textarea(panel).dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.create).toHaveBeenCalledTimes(1));

    bridge.resolve("create");
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Creating workspace task..."));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();

    bridge.publish(loadedState([task({ id: "release", title: "Release", command: "npm run release" })], []));
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain('Saved task "Release".'));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).toBeNull();
  });

  it("keeps a successful delete pending until its delayed authoritative snapshot arrives", async () => {
    const bridge = createControllableBridge();
    const panel = mount(loadedState([task()], []), bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-delete-task='workspace:build']").click();
    button(panel, "[data-confirm-delete]").click();
    await vi.waitFor(() => expect(bridge.actions.remove).toHaveBeenCalledTimes(1));

    bridge.resolve("remove");
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Deleting workspace task..."));
    expect(panel.shadowRoot?.querySelector("[data-delete-confirmation]")).not.toBeNull();

    bridge.publish(loadedState([], []));
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain('Deleted task "Build".'));
    expect(panel.shadowRoot?.querySelector("[data-delete-confirmation]")).toBeNull();
  });

  it("waits for source refresh lifecycles before completing unchanged Refresh", async () => {
    const bridge = createControllableBridge();
    const initial = loadedState([task()], [task({ id: "global-build", title: "Global Build" })]);
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-refresh]").click();
    await vi.waitFor(() => expect(bridge.actions.refresh).toHaveBeenCalledTimes(1));

    bridge.resolve("refresh");
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Refreshing workspace task catalogs..."));

    const beforeUnrelatedPublication = panel.workspaceTasksState;
    bridge.publishGlobal({ kind: "loaded", config: { version: 1, tasks: [task({ id: "global-build", title: "Global Release" })] }, refreshing: false });
    expect(panel.workspaceTasksState.workspace).not.toBe(beforeUnrelatedPublication.workspace);
    expect(panel.workspaceTasksState.global).not.toBe(beforeUnrelatedPublication.global);
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Refreshing workspace task catalogs..."));

    const refreshing = loadedState([task()], [task({ id: "global-build", title: "Global Release" })]);
    bridge.publish({
      ...refreshing,
      workspace: { ...refreshing.workspace, refreshing: true },
      global: { ...refreshing.global, refreshing: true },
    });
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Refreshing workspace task catalogs..."));

    bridge.publish(refreshing);
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Workspace task catalogs refreshed."));
  });

  it("does not let a fresh unrelated source publication surface a pre-existing workspace error", async () => {
    const bridge = createControllableBridge();
    const initial = withSourceRefreshError(
      loadedState([task()], [task({ id: "global-build", title: "Global Build" })]),
      "workspace",
      "Earlier workspace refresh failed",
    );
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-title]").value = "Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));

    bridge.resolve("update");
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Saving workspace task..."));
    const beforeUnrelatedPublication = panel.workspaceTasksState;
    bridge.publishGlobal({ kind: "loaded", config: { version: 1, tasks: [task({ id: "global-build", title: "Global Release" })] }, refreshing: false });
    expect(panel.workspaceTasksState.workspace).not.toBe(beforeUnrelatedPublication.workspace);
    expect(panel.workspaceTasksState.global).not.toBe(beforeUnrelatedPublication.global);
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Saving workspace task..."));
    expect(panelStatusText(panel)).not.toContain("Earlier workspace refresh failed");
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();

    bridge.publishWorkspace({ kind: "loaded", config: { version: 1, tasks: [task({ title: "Release" })] }, refreshing: false });
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain('Saved task "Release".'));
  });

  it("does not let a fresh unrelated source publication surface a pre-existing global error", async () => {
    const bridge = createControllableBridge();
    const initial = withSourceRefreshError(
      loadedState([task({ id: "project-build", title: "Project Build" })], [task({ id: "global-build", title: "Global Build" })]),
      "global",
      "Earlier global refresh failed",
    );
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-edit-task='global:global-build']").click();
    input(panel, "[data-editor-title]").value = "Global Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));

    bridge.resolve("update");
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Saving workspace task..."));
    const beforeUnrelatedPublication = panel.workspaceTasksState;
    bridge.publishWorkspace({ kind: "loaded", config: { version: 1, tasks: [task({ id: "project-build", title: "Project Release" })] }, refreshing: false });
    expect(panel.workspaceTasksState.workspace).not.toBe(beforeUnrelatedPublication.workspace);
    expect(panel.workspaceTasksState.global).not.toBe(beforeUnrelatedPublication.global);
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Saving workspace task..."));
    expect(panelStatusText(panel)).not.toContain("Earlier global refresh failed");
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();

    bridge.publishGlobal({ kind: "loaded", config: { version: 1, tasks: [task({ id: "global-build", title: "Global Release" })] }, refreshing: false });
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain('Saved task "Global Release".'));
  });

  it("does not treat a re-assigned stale state object as update confirmation", async () => {
    const bridge = createControllableBridge();
    const initial = loadedState([task()], []);
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-title]").value = "Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));

    bridge.complete("update", loadedState([task()], []));

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Saving workspace task..."));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();
    bridge.publish(loadedState([task({ title: "Release" })], []));
    await vi.waitFor(() => expect(panelStatusText(panel)).toContain('Saved task "Release".'));
  });

  it("does not mistake a pre-existing source refresh error for a failed update after newer data confirms the save", async () => {
    const bridge = createControllableBridge();
    const initial = withSourceRefreshError(loadedState([task()], []), "workspace", "Earlier workspace refresh failed");
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-title]").value = "Release";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));

    bridge.complete("update", loadedState([task({ title: "Release" })], []));

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain('Saved task "Release".'));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).toBeNull();
  });

  it("retains an update when its post-action refresh error matches an earlier error", async () => {
    const bridge = createControllableBridge();
    const initial = withSourceRefreshError(loadedState([task()], []), "workspace", "Workspace write unavailable");
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-title]").value = "Changed";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));

    bridge.publish({
      ...initial,
      workspace: { ...initial.workspace, refreshing: true },
    });
    bridge.publish(withSourceRefreshError(initial, "workspace", "Workspace write unavailable"));
    bridge.resolve("update");

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Workspace write unavailable"));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();
    expect(panelStatusText(panel)).not.toContain('Saved task "Build".');
  });

  it("retains an editor when an update publishes an authoritative invalid source", async () => {
    const bridge = createControllableBridge();
    const initial = loadedState([task()], []);
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-edit-task='workspace:build']").click();
    input(panel, "[data-editor-title]").value = "Changed";
    input(panel, "[data-editor-title]").dispatchEvent(new Event("input", { bubbles: true }));
    button(panel, "[data-save-task]").click();
    await vi.waitFor(() => expect(bridge.actions.update).toHaveBeenCalledTimes(1));

    bridge.complete("update", {
      ...initial,
      workspace: { kind: "invalid", message: "Project task catalog is invalid", hint: "Repair the catalog.", detail: "Invalid JSON" },
    });

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Project task catalog is invalid"));
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();
  });

  it("reports source failures after an explicit Refresh instead of reporting success", async () => {
    const bridge = createControllableBridge();
    const initial = loadedState([task()], []);
    const panel = mount(initial, bridge.actions);
    bridge.attach(panel);
    button(panel, "[data-refresh]").click();
    await vi.waitFor(() => expect(bridge.actions.refresh).toHaveBeenCalledTimes(1));

    const unavailable = {
      ...loadedState([task()], []),
      global: { kind: "unavailable" as const, message: "Global tasks are unavailable", hint: "Refresh and try again." },
    };
    bridge.publish({
      ...unavailable,
      workspace: { ...unavailable.workspace, refreshing: true },
    });
    bridge.publish(unavailable);
    bridge.resolve("refresh");

    await vi.waitFor(() => expect(panelStatusText(panel)).toContain("Global tasks are unavailable"));
    expect(panelStatusText(panel)).not.toContain("Workspace task catalogs refreshed.");
  });

  it("keeps promotion recovery scoped to the original refs and enables one retry only after Refresh proves the destination", async () => {
    const bridge = createControllableBridge();
    const panel = mount(loadedState([task()], []), bridge.actions);
    bridge.attach(panel);
    startScopeMove(panel, "workspace", "release");
    await vi.waitFor(() => expect(bridge.actions.move).toHaveBeenCalledTimes(1));
    expect(bridge.actions.move).toHaveBeenCalledWith(
      { scope: "workspace", id: "build" },
      expect.objectContaining({ id: "release" }),
    );

    const partial = {
      ...loadedState([task()], [task({ id: "release" })]),
      move: { kind: "partial" as const, message: "Move is partially complete.", retryAllowed: false },
      mutationGate: { scopes: ["workspace", "global"] as const, message: "Move recovery pending." },
    };
    bridge.complete("move", partial);
    // Wait for the move callback to settle; its in-flight state independently disables Retry.
    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("[data-panel-status]")).toBeNull());
    expect(button(panel, "[data-retry-move]").disabled).toBe(true);
    expect(bridge.actions.retryMove).not.toHaveBeenCalled();
    expect(panel.shadowRoot?.querySelector("[data-move-confirmation]")).not.toBeNull();

    button(panel, "[data-refresh]").click();
    expect(panel.shadowRoot?.querySelector("[data-refresh-discard-confirmation]")).not.toBeNull();
    button(panel, "[data-confirm-refresh-discard]").click();
    await vi.waitFor(() => expect(bridge.actions.refresh).toHaveBeenCalledTimes(1));
    const recovery = {
      ...loadedState([task()], [task({ id: "release" })]),
      move: { kind: "partial" as const, message: "Move is partially complete.", retryAllowed: true },
    };
    bridge.publish({
      ...recovery,
      workspace: { ...recovery.workspace, refreshing: true },
      global: { ...recovery.global, refreshing: true },
    });
    bridge.publish(recovery);
    bridge.resolve("refresh");

    await vi.waitFor(() => expect(button(panel, "[data-retry-move]").disabled).toBe(false));
    expect(bridge.actions.retryMove).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(panel.shadowRoot?.activeElement).toBe(panel.shadowRoot?.querySelector("[data-panel-heading]")));
    button(panel, "[data-retry-move]").click();
    await vi.waitFor(() => expect(bridge.actions.retryMove).toHaveBeenCalledTimes(1));
    bridge.complete("retryMove", loadedState([], [task({ id: "release" })]));
    await vi.waitFor(() => expect(bridge.actions.retryMove).toHaveBeenCalledTimes(1));
  });

  it("keeps a demotion draft through unknown-outcome recovery and preserves manual resolution after a lost retry claim", async () => {
    const bridge = createControllableBridge();
    const panel = mount(loadedState([], [task()]), bridge.actions);
    bridge.attach(panel);
    startScopeMove(panel, "global", "project-build");
    await vi.waitFor(() => expect(bridge.actions.move).toHaveBeenCalledTimes(1));
    expect(bridge.actions.move).toHaveBeenCalledWith(
      { scope: "global", id: "build" },
      expect.objectContaining({ id: "project-build" }),
    );

    bridge.publish({
      ...loadedState([], [task()]),
      move: { kind: "unknown-outcome", message: "Move outcome is unknown.", retryAllowed: false },
      mutationGate: { scopes: ["workspace", "global"] as const, message: "Move recovery pending." },
    });
    bridge.publish({
      ...loadedState([task({ id: "project-build" })], [task()]),
      move: { kind: "partial", message: "Move is partially complete.", retryAllowed: true },
      mutationGate: { scopes: ["workspace", "global"] as const, message: "Move recovery pending." },
    });
    bridge.resolve("move");

    await vi.waitFor(() => expect(button(panel, "[data-retry-move]").disabled).toBe(false));
    expect(bridge.actions.retryMove).not.toHaveBeenCalled();
    expect(panel.shadowRoot?.textContent).toContain("Global to Project");
    expect(panel.shadowRoot?.querySelector("[data-move-confirmation]")).not.toBeNull();

    button(panel, "[data-retry-move]").click();
    await vi.waitFor(() => expect(bridge.actions.retryMove).toHaveBeenCalledTimes(1));
    bridge.publish({
      ...loadedState([task({ id: "project-build" })], [task()]),
      move: { kind: "conflict", message: "The move claim was lost.", retryAllowed: false },
      mutationGate: { scopes: ["workspace", "global"] as const, message: "The move claim was lost." },
    });
    bridge.resolve("retryMove");

    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("[data-manual-resolution]")).not.toBeNull());
    expect(panel.shadowRoot?.querySelector("[data-mutation-gate]")?.textContent).toContain("The move claim was lost.");
    expect(panel.shadowRoot?.textContent).toContain("The move claim was lost.");
    expect(panel.shadowRoot?.textContent).toContain("Manual resolution required.");
    expect(panel.shadowRoot?.querySelector("[data-move-confirmation]")).not.toBeNull();
    expect(button(panel, "[data-retry-move]").disabled).toBe(true);
    expect(bridge.actions.retryMove).toHaveBeenCalledTimes(1);
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

function createActions(): MockedWorkspaceTasksActions {
  return {
    create: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    move: vi.fn(() => Promise.resolve()),
    retryMove: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
}

function createControllableBridge(): ControllableBridge {
  let panel: TasksPanelElement | undefined;
  const pending: { readonly action: BridgeActionName; readonly resolve: () => void }[] = [];
  const dispatch = (action: BridgeActionName): Promise<void> => new Promise((resolve) => {
    pending.push({ action, resolve });
  });
  const actions: MockedWorkspaceTasksActions = {
    create: vi.fn(() => dispatch("create")),
    update: vi.fn(() => dispatch("update")),
    remove: vi.fn(() => dispatch("remove")),
    move: vi.fn(() => dispatch("move")),
    retryMove: vi.fn(() => dispatch("retryMove")),
    refresh: vi.fn(() => dispatch("refresh")),
  };

  return {
    actions,
    attach(nextPanel) {
      panel = nextPanel;
    },
    publish(nextState) {
      if (panel === undefined) throw new Error("Attach the bridge before publishing state.");
      // WorkspaceTasksController.publishCurrent() creates fresh snapshots for both sources.
      panel.workspaceTasksState = cloneBridgeState(nextState);
    },
    publishWorkspace(nextCatalog) {
      if (panel === undefined) throw new Error("Attach the bridge before publishing state.");
      this.publish({ ...panel.workspaceTasksState, workspace: nextCatalog });
    },
    publishGlobal(nextCatalog) {
      if (panel === undefined) throw new Error("Attach the bridge before publishing state.");
      this.publish({ ...panel.workspaceTasksState, global: nextCatalog });
    },
    resolve(action) {
      const pendingAction = pending.shift();
      if (pendingAction?.action !== action) throw new Error(`Expected pending ${action} action.`);
      pendingAction.resolve();
    },
    complete(action: BridgeActionName, nextState: WorkspaceTasksWorkspaceState) {
      this.publish(nextState);
      this.resolve(action);
    },
    settleThenPublish(action: BridgeActionName, nextState: WorkspaceTasksWorkspaceState) {
      this.resolve(action);
      this.publish(nextState);
    },
  };
}

function cloneBridgeState(state: WorkspaceTasksWorkspaceState): WorkspaceTasksWorkspaceState {
  return {
    ...state,
    workspace: cloneCatalogState(state.workspace),
    global: cloneCatalogState(state.global),
    ...(state.sourceGenerations === undefined ? {} : { sourceGenerations: { ...state.sourceGenerations } }),
    ...(state.move === undefined ? {} : { move: { ...state.move } }),
    ...(state.moveError === undefined ? {} : { moveError: { ...state.moveError } }),
    ...(state.mutationGate === undefined ? {} : { mutationGate: { ...state.mutationGate, scopes: [...state.mutationGate.scopes] } }),
  };
}

function cloneCatalogState(state: CatalogState): CatalogState {
  return {
    ...state,
    ...(state.config === undefined ? {} : {
      config: {
        version: 1,
        tasks: state.config.tasks.map((candidate) => ({ ...candidate })),
      },
    }),
  };
}

function withSourceRefreshError(
  state: WorkspaceTasksWorkspaceState,
  scope: WorkspaceTaskScope,
  refreshError: string,
): WorkspaceTasksWorkspaceState {
  if (scope === "workspace") {
    if (state.workspace.kind !== "loaded") throw new Error("Expected loaded workspace catalog.");
    return { ...state, workspace: { ...state.workspace, refreshError } };
  }
  if (state.global.kind !== "loaded") throw new Error("Expected loaded global catalog.");
  return { ...state, global: { ...state.global, refreshError } };
}

function startScopeMove(panel: TasksPanelElement, sourceScope: WorkspaceTaskScope, destinationId: string): void {
  button(panel, `[data-edit-task='${sourceScope}:build']`).click();
  const global = input(panel, "[data-editor-global]");
  if (global.checked === (sourceScope === "global")) global.click();
  input(panel, "[data-editor-id]").value = destinationId;
  input(panel, "[data-editor-id]").dispatchEvent(new Event("input", { bubbles: true }));
  button(panel, "[data-save-task]").click();
  button(panel, "[data-confirm-move]").click();
}

function panelStatusText(panel: HTMLElement): string {
  return panel.shadowRoot?.querySelector("[data-panel-status]")?.textContent ?? "";
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
