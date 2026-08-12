// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { recentProjectsApi, type Machine, type Project, type RecentProjectEntry } from "../api";
import { MachineController } from "../controllers/machineController";
import { ProjectController } from "../controllers/projectController";
import { RecentProjectController } from "../controllers/recentProjectController";
import { WorkspaceController } from "../controllers/workspaceController";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
const { PiWebUiApp } = await import("./PiWebUiApp");
const { RecentProjectDialog } = await import("./RecentProjectDialog");
const { RecentProjectsPanel } = await import("./RecentProjectsPanel");
const { WorkspacePanel } = await import("./WorkspacePanel");
const { AppNavigationPanel } = await import("./appShell/AppNavigationPanel");

type PiWebUiAppElement = InstanceType<typeof PiWebUiApp>;
type RecentDialogElement = InstanceType<typeof RecentProjectDialog>;
type RecentProjectsPanelElement = InstanceType<typeof RecentProjectsPanel>;

const localMachine: Machine = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const remoteMachine: Machine = {
  id: "remote-b",
  name: "Remote B",
  kind: "remote",
  baseUrl: "http://remote-b.test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const entry: RecentProjectEntry = {
  id: "entry-alpha",
  name: "Alpha",
  path: "/work/alpha",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
};

const entryBeta: RecentProjectEntry = {
  id: "entry-beta",
  name: "Beta",
  path: "/work/beta",
  lastUsedAt: "2026-01-01T00:00:01.000Z",
};

const project: Project = {
  id: "project-alpha",
  name: "Alpha",
  path: "/work/alpha",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const dialogPrototype = HTMLDialogElement.prototype;
const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, "close");
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const closeConnections: boolean[] = [];
let mountedApp: PiWebUiAppElement | undefined;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function restoreDialogMethod(name: "showModal" | "close", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(dialogPrototype, name);
  else Object.defineProperty(dialogPrototype, name, descriptor);
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
});

afterAll(() => {
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else Object.defineProperty(window, "matchMedia", originalMatchMedia);
});

beforeEach(() => {
  closeConnections.length = 0;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
  Object.defineProperty(dialogPrototype, "showModal", {
    configurable: true,
    writable: true,
    value: function (this: HTMLDialogElement): void { this.open = true; },
  });
  Object.defineProperty(dialogPrototype, "close", {
    configurable: true,
    writable: true,
    value: function (this: HTMLDialogElement): void {
      closeConnections.push(this.isConnected);
      this.open = false;
    },
  });
});

afterEach(async () => {
  document.body.replaceChildren();
  await mountedApp?.updateComplete;
  await Promise.resolve();
  mountedApp = undefined;
  restoreDialogMethod("showModal", originalShowModal);
  restoreDialogMethod("close", originalClose);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp recent-project dialog", () => {
  it("selects a registered primary directly while its X opens removal confirmation", async () => {
    const app = await mountApp([entry], [localMachine], [project]);
    const selectProject = vi.spyOn(workspaceController(app), "selectProject").mockResolvedValue();
    const panel = await recentPanel(app);

    recentPrimary(panel).click();
    await vi.waitFor(() => { expect(selectProject).toHaveBeenCalledWith(project); });
    expect(app.renderRoot.querySelector("recent-project-dialog")).toBeNull();

    recentRemove(panel).click();
    const dialog = await openedDialog(app);

    expect(dialog.initialView).toBe("removal-confirmation");
    expect(dialog.renderRoot.querySelector(".recent-project-confirm-remove")).not.toBeNull();
    expect(dialog.renderRoot.querySelector(".recent-project-reopen")).toBeNull();
    expect(selectProject).toHaveBeenCalledTimes(1);
  });

  it("opens a Closed row in Closed actions and transitions to confirmation without removing", async () => {
    const app = await mountApp();
    const removeEntry = vi.spyOn(recentProjectsController(app), "removeEntry");
    const panel = await recentPanel(app);

    recentPrimary(panel).click();
    const dialog = await openedDialog(app);
    expect(dialog.initialView).toBe("closed-actions");
    expect(dialog.renderRoot.querySelector(".recent-project-reopen")).not.toBeNull();

    dialogButton(dialog, ".recent-project-remove-request").click();
    await vi.waitFor(() => {
      expect(dialog.renderRoot.querySelector(".recent-project-confirm-remove")).not.toBeNull();
    });

    expect(removeEntry).not.toHaveBeenCalled();
  });

  it("opens a Closed row X in confirmation directly and returns focus to its current X on Cancel", async () => {
    const app = await mountApp();
    const panel = await recentPanel(app);
    const remove = recentRemove(panel);
    remove.focus();

    remove.click();
    const dialog = await openedDialog(app);
    expect(dialog.initialView).toBe("removal-confirmation");
    expect(dialog.renderRoot.querySelector(".recent-project-reopen")).toBeNull();

    dialogButton(dialog, ".recent-project-cancel").click();
    const settled = await settledRecentPanel(app);

    expect(app.renderRoot.querySelector("recent-project-dialog")).toBeNull();
    expect(settled.shadowRoot?.activeElement).toBe(recentRemove(settled));
  });

  it("dismisses confirmation from a Closed flow rather than returning to Closed actions", async () => {
    const app = await mountApp();
    const panel = await recentPanel(app);
    const primary = recentPrimary(panel);
    primary.focus();

    primary.click();
    const dialog = await openedDialog(app);
    dialogButton(dialog, ".recent-project-remove-request").click();
    await vi.waitFor(() => {
      expect(dialog.renderRoot.querySelector(".recent-project-confirm-remove")).not.toBeNull();
    });
    dialogButton(dialog, ".recent-project-cancel").click();

    const settled = await settledRecentPanel(app);
    expect(app.renderRoot.querySelector("recent-project-dialog")).toBeNull();
    expect(settled.shadowRoot?.activeElement).toBe(recentPrimary(settled));
  });

  it("keeps confirmation open with the exact generic removal error and preserves registered projects", async () => {
    const app = await mountApp([entry], [localMachine], [project]);
    vi.spyOn(recentProjectsApi, "removeRecentProject").mockRejectedValue(new Error("Machine offline"));
    const panel = await recentPanel(app);

    recentRemove(panel).click();
    const dialog = await openedDialog(app);
    dialogButton(dialog, ".recent-project-confirm-remove").click();

    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Machine offline");
    });

    expect(app.renderRoot.querySelector("recent-project-dialog")).toBe(dialog);
    expect(nativeDialog(dialog).open).toBe(true);
    expect(appState(app).projects).toEqual([project]);
    expect(appState(app).error).toBe("");
  });

  it("removes a registered history entry without changing registered projects", async () => {
    const app = await mountApp([entry], [localMachine], [project]);
    vi.spyOn(recentProjectsApi, "removeRecentProject").mockResolvedValue([]);
    const panel = await recentPanel(app);

    recentRemove(panel).click();
    const dialog = await openedDialog(app);
    dialogButton(dialog, ".recent-project-confirm-remove").click();

    const settled = await settledRecentPanel(app);
    expect(settled.renderRoot.querySelector(".recent-project-row")).toBeNull();
    expect(appState(app).projects).toEqual([project]);
  });

  it.each([
    ["next primary", [entry, entryBeta], entry.id, [entryBeta], entryBeta.id],
    ["previous primary", [entry, entryBeta], entryBeta.id, [entry], entry.id],
  ] as const)("focuses the %s after successful removal", async (_label, initialEntries, removedId, remainingEntries, focusedId) => {
    const app = await mountApp([...initialEntries]);
    const recent = recentProjectsController(app);
    vi.spyOn(recent, "removeEntry").mockImplementation(() => {
      Reflect.set(recent, "current", { kind: "ready", entries: remainingEntries });
      app.requestUpdate();
      return Promise.resolve({ kind: "removed" } as const);
    });
    const panel = await recentPanel(app);

    recentRemove(panel, removedId).click();
    const dialog = await openedDialog(app);
    dialogButton(dialog, ".recent-project-confirm-remove").click();

    const settled = await settledRecentPanel(app);
    expect(settled.shadowRoot?.activeElement).toBe(recentPrimary(settled, focusedId));
  });

  it("focuses the empty state after successful removal of the final entry", async () => {
    const app = await mountApp();
    const recent = recentProjectsController(app);
    vi.spyOn(recent, "removeEntry").mockImplementation(() => {
      Reflect.set(recent, "current", { kind: "ready", entries: [] });
      app.requestUpdate();
      return Promise.resolve({ kind: "removed" } as const);
    });
    const panel = await recentPanel(app);

    recentRemove(panel).click();
    const dialog = await openedDialog(app);
    dialogButton(dialog, ".recent-project-confirm-remove").click();

    const settled = await settledRecentPanel(app);
    const empty = settled.renderRoot.querySelector<HTMLElement>(".recent-projects-empty");
    expect(settled.shadowRoot?.activeElement).toBe(empty);
  });

  it("uses the Closed primary fallback after removal from Closed actions", async () => {
    const app = await mountApp([entry, entryBeta]);
    const recent = recentProjectsController(app);
    vi.spyOn(recent, "removeEntry").mockImplementation(() => {
      Reflect.set(recent, "current", { kind: "ready", entries: [entryBeta] });
      app.requestUpdate();
      return Promise.resolve({ kind: "removed" } as const);
    });
    const panel = await recentPanel(app);

    recentPrimary(panel, entry.id).click();
    const dialog = await openedDialog(app);
    dialogButton(dialog, ".recent-project-remove-request").click();
    await vi.waitFor(() => {
      expect(dialog.renderRoot.querySelector(".recent-project-confirm-remove")).not.toBeNull();
    });
    dialogButton(dialog, ".recent-project-confirm-remove").click();

    const settled = await settledRecentPanel(app);
    expect(settled.shadowRoot?.activeElement).toBe(recentPrimary(settled, entryBeta.id));
  });

  it("keeps focus in the dialog after a failed Reopen and restores the primary after success", async () => {
    const failedApp = await mountApp();
    vi.spyOn(projectsController(failedApp), "addRegisteredProject").mockRejectedValue(new Error("Directory not found"));
    let panel = await recentPanel(failedApp);
    recentPrimary(panel).click();
    let dialog = await openedDialog(failedApp);
    const reopen = dialogButton(dialog, ".recent-project-reopen");
    reopen.click();

    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Directory not found");
    });
    expect(appState(failedApp).error).toBe("");
    expect(dialog.shadowRoot?.activeElement).toBe(reopen);

    document.body.replaceChildren();
    await failedApp.updateComplete;
    const successfulApp = await mountApp();
    vi.spyOn(projectsController(successfulApp), "addRegisteredProject").mockResolvedValue(project);
    vi.spyOn(recentProjectsController(successfulApp), "load").mockResolvedValue();
    panel = await recentPanel(successfulApp);
    recentPrimary(panel).click();
    dialog = await openedDialog(successfulApp);
    dialogButton(dialog, ".recent-project-reopen").click();

    const settled = await settledRecentPanel(successfulApp);
    expect(successfulApp.renderRoot.querySelector("recent-project-dialog")).toBeNull();
    expect(settled.shadowRoot?.activeElement).toBe(recentPrimary(settled));
  });

  it("closes on machine change without restoring a stale focus closure", async () => {
    const app = await mountApp([entry], [localMachine, remoteMachine]);
    const panel = await recentPanel(app);
    const restoreLocalFocus = vi.fn();
    Reflect.set(panel, "restoreClosedFocus", restoreLocalFocus);
    recentPrimary(panel).click();
    await openedDialog(app);

    await selectMachineFromNavigation(app, remoteMachine);
    await app.updateComplete;

    expect(appState(app).selectedMachine).toBe(remoteMachine);
    expect(app.renderRoot.querySelector("recent-project-dialog")).toBeNull();
    expect(closeConnections).toEqual([true]);
    expect(restoreLocalFocus).not.toHaveBeenCalled();
  });

  it("does not let a deferred local action close dialog B or restore old-machine focus", async () => {
    const app = await mountApp([entry, entryBeta], [localMachine, remoteMachine]);
    const pendingReopen = deferred<Project>();
    const reopen = vi.spyOn(projectsController(app), "addRegisteredProject").mockReturnValue(pendingReopen.promise);

    let panel = await recentPanel(app);
    const restoreLocalFocus = vi.fn();
    Reflect.set(panel, "restoreClosedFocus", restoreLocalFocus);
    recentPrimary(panel, entry.id).click();
    const dialogA = await openedDialog(app);
    dialogButton(dialogA, ".recent-project-reopen").click();
    await vi.waitFor(() => { expect(dialogButton(dialogA, ".recent-project-reopen").disabled).toBe(true); });

    await selectMachineFromNavigation(app, remoteMachine);
    panel = await settledRecentPanel(app);
    recentPrimary(panel, entryBeta.id).click();
    const dialogB = await openedDialog(app);
    const reopenB = dialogButton(dialogB, ".recent-project-reopen");

    pendingReopen.resolve(project);
    await vi.waitFor(() => { expect(reopen).toHaveBeenCalledWith(entry.path, entry.name); });
    await app.updateComplete;
    await Promise.resolve();

    expect(app.renderRoot.querySelector("recent-project-dialog")).toBe(dialogB);
    expect(nativeDialog(dialogB).open).toBe(true);
    expect(dialogB.shadowRoot?.activeElement).toBe(reopenB);
    expect(restoreLocalFocus).not.toHaveBeenCalled();
  });

  it("does not let a deferred action from dialog A close a newer same-machine dialog", async () => {
    const app = await mountApp([entry, entryBeta]);
    const pendingReopen = deferred<Project>();
    vi.spyOn(projectsController(app), "addRegisteredProject").mockReturnValue(pendingReopen.promise);
    const staleFocus = vi.fn();
    const currentFocus = vi.fn();
    const panel = await recentPanel(app);

    recentPrimary(panel, entry.id).click();
    const dialogA = await openedDialog(app);
    dialogButton(dialogA, ".recent-project-reopen").click();
    await vi.waitFor(() => { expect(dialogButton(dialogA, ".recent-project-reopen").disabled).toBe(true); });

    openRecentProjectDialog(app, entryBeta, staleFocus, currentFocus);
    const dialogB = await openedDialog(app);
    expect(dialogB.entry).toBe(entryBeta);

    pendingReopen.resolve(project);
    await app.updateComplete;
    await Promise.resolve();

    expect(app.renderRoot.querySelector("recent-project-dialog")).toBe(dialogB);
    expect(nativeDialog(dialogB).open).toBe(true);
    expect(staleFocus).not.toHaveBeenCalled();
    expect(currentFocus).not.toHaveBeenCalled();
  });

  it("disables every button while busy, ignores dismissal, then leaves dialog B untouched after completion", async () => {
    const app = await mountApp([entry, entryBeta]);
    const pendingReopen = deferred<Project>();
    vi.spyOn(projectsController(app), "addRegisteredProject").mockReturnValue(pendingReopen.promise);
    vi.spyOn(recentProjectsController(app), "load").mockResolvedValue();
    let panel = await recentPanel(app);
    recentPrimary(panel, entry.id).click();
    const dialogA = await openedDialog(app);
    const staleClose = dialogA.onClose;
    dialogButton(dialogA, ".recent-project-reopen").click();

    await vi.waitFor(() => {
      expect(Array.from(dialogA.renderRoot.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
    });
    dialogButton(dialogA, ".recent-project-cancel").click();
    nativeDialog(dialogA).dispatchEvent(new Event("cancel", { cancelable: true }));
    nativeDialog(dialogA).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(app.renderRoot.querySelector("recent-project-dialog")).toBe(dialogA);

    pendingReopen.resolve(project);
    await vi.waitFor(() => { expect(app.renderRoot.querySelector("recent-project-dialog")).toBeNull(); });
    panel = await settledRecentPanel(app);
    recentPrimary(panel, entryBeta.id).click();
    const dialogB = await openedDialog(app);
    const reopenB = dialogButton(dialogB, ".recent-project-reopen");

    staleClose();
    await app.updateComplete;

    expect(app.renderRoot.querySelector("recent-project-dialog")).toBe(dialogB);
    expect(nativeDialog(dialogB).open).toBe(true);
    expect(dialogB.shadowRoot?.activeElement).toBe(reopenB);
  });
});

async function mountApp(
  entries: RecentProjectEntry[] = [entry],
  machines: Machine[] = [localMachine],
  projects: Project[] = [],
): Promise<PiWebUiAppElement> {
  const app = new PiWebUiApp();
  setAppState(app, {
    ...initialAppState(),
    machines,
    selectedMachine: localMachine,
    projects,
    workspaceTool: "core:recent-projects",
    mainView: "core:recent-projects",
  });
  const recent = recentProjectsController(app);
  Reflect.set(recent, "current", { kind: "ready", entries });
  vi.spyOn(recent, "load").mockResolvedValue();
  for (const methodName of [
    "renegotiateUnreadMachines",
    "refreshWorkspaceActivity",
    "loadClientConfig",
    "ensureGatewayPluginsLoaded",
    "loadPluginsForSelectedMachine",
    "loadProjectsAndRestoreRoute",
  ]) {
    Reflect.set(app, methodName, () => Promise.resolve());
  }
  for (const methodName of [
    "synchronizeProjectCatalogPolling",
    "applyPreferredTheme",
    "connectRealtime",
    "syncWindowTitle",
  ]) {
    Reflect.set(app, methodName, () => undefined);
  }
  vi.spyOn(PiWebUiApp.prototype, "connectedCallback").mockImplementation(function (this: PiWebUiAppElement): void {
    LitElement.prototype.connectedCallback.call(this);
  });
  vi.spyOn(PiWebUiApp.prototype, "disconnectedCallback").mockImplementation(function (this: PiWebUiAppElement): void {
    LitElement.prototype.disconnectedCallback.call(this);
  });
  mountedApp = app;
  document.body.append(app);
  await app.updateComplete;
  const panel = await settledRecentPanel(app);
  await vi.waitFor(() => { expect(panel.renderRoot.querySelector(".recent-project-row")).not.toBeNull(); });
  return app;
}

async function recentPanel(app: PiWebUiAppElement): Promise<RecentProjectsPanelElement> {
  const workspace = app.renderRoot.querySelector("workspace-panel");
  if (!(workspace instanceof WorkspacePanel)) throw new Error("Expected workspace panel");
  await workspace.updateComplete;
  const panel = workspace.renderRoot.querySelector("recent-projects-panel");
  if (!(panel instanceof RecentProjectsPanel)) throw new Error("Expected recent projects panel");
  await panel.updateComplete;
  return panel;
}

async function settledRecentPanel(app: PiWebUiAppElement): Promise<RecentProjectsPanelElement> {
  for (let round = 0; round < 3; round += 1) {
    await app.updateComplete;
    await Promise.resolve();
  }
  const panel = await recentPanel(app);
  await Promise.resolve();
  return panel;
}

function recentRow(panel: RecentProjectsPanelElement, entryId = entry.id): HTMLElement {
  const row = panel.renderRoot.querySelector<HTMLElement>(`[data-recent-project-id="${entryId}"]`);
  if (row === null) throw new Error(`Expected recent project row ${entryId}`);
  return row;
}

function recentPrimary(panel: RecentProjectsPanelElement, entryId = entry.id): HTMLButtonElement {
  const primary = recentRow(panel, entryId).querySelector<HTMLButtonElement>("button.recent-project-open");
  if (primary === null) throw new Error(`Expected recent project primary action ${entryId}`);
  return primary;
}

function recentRemove(panel: RecentProjectsPanelElement, entryId = entry.id): HTMLButtonElement {
  const remove = recentRow(panel, entryId).querySelector<HTMLButtonElement>("button.recent-project-remove");
  if (remove === null) throw new Error(`Expected recent project remove action ${entryId}`);
  return remove;
}

function openRecentProjectDialog(
  app: PiWebUiAppElement,
  entryToOpen: RecentProjectEntry,
  cancelFocus: () => void,
  removalFocus: () => void,
): void {
  const open: unknown = Reflect.get(app, "openRecentProjectDialog");
  if (typeof open !== "function") throw new Error("Expected recent project dialog opener");
  open.call(app, entryToOpen, "closed-actions", cancelFocus, removalFocus);
}

async function openedDialog(app: PiWebUiAppElement): Promise<RecentDialogElement> {
  await app.updateComplete;
  const dialog = app.renderRoot.querySelector("recent-project-dialog");
  if (!(dialog instanceof RecentProjectDialog)) throw new Error("Expected recent project dialog");
  await dialog.updateComplete;
  return dialog;
}

function nativeDialog(dialog: RecentDialogElement): HTMLDialogElement {
  const native = dialog.renderRoot.querySelector<HTMLDialogElement>("dialog");
  if (native === null) throw new Error("Expected native dialog");
  return native;
}

function dialogButton(dialog: RecentDialogElement, selector: string): HTMLButtonElement {
  const button = dialog.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`Expected ${selector}`);
  return button;
}

async function selectMachineFromNavigation(app: PiWebUiAppElement, machine: Machine): Promise<void> {
  vi.spyOn(projectsController(app), "loadProjects").mockResolvedValue(true);
  vi.spyOn(machineController(app), "refreshMachineHealth").mockResolvedValue(undefined);
  vi.spyOn(machineController(app), "refreshMachineRuntime").mockResolvedValue(undefined);
  Reflect.set(app, "focusNavigationTarget", () => Promise.resolve());

  const navigation = app.renderRoot.querySelector("app-navigation-panel");
  if (!(navigation instanceof AppNavigationPanel)) throw new Error("Expected app navigation panel");
  await navigation.updateComplete;
  if (navigation.onSelectMachine === undefined) throw new Error("Expected machine selection callback");
  await navigation.onSelectMachine(machine);
  await app.updateComplete;
  await Promise.resolve();
}

function appState(app: PiWebUiAppElement): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("App state unavailable");
  return state;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null
    && Array.isArray(Reflect.get(value, "projects"))
    && typeof Reflect.get(value, "error") === "string";
}

function setAppState(app: PiWebUiAppElement, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set app state");
}

function recentProjectsController(app: PiWebUiAppElement): RecentProjectController {
  const controller: unknown = Reflect.get(app, "recentProjects");
  if (!(controller instanceof RecentProjectController)) throw new Error("Recent project controller unavailable");
  return controller;
}

function projectsController(app: PiWebUiAppElement): ProjectController {
  const controller: unknown = Reflect.get(app, "projects");
  if (!(controller instanceof ProjectController)) throw new Error("Project controller unavailable");
  return controller;
}

function machineController(app: PiWebUiAppElement): MachineController {
  const controller: unknown = Reflect.get(app, "machines");
  if (!(controller instanceof MachineController)) throw new Error("Machine controller unavailable");
  return controller;
}

function workspaceController(app: PiWebUiAppElement): WorkspaceController {
  const controller: unknown = Reflect.get(app, "workspaces");
  if (!(controller instanceof WorkspaceController)) throw new Error("Workspace controller unavailable");
  return controller;
}
