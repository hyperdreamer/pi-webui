// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { api, HttpRequestError, recentProjectsApi, type Machine, type Project, type RecentProjectEntry } from "../api";
import { MachineController } from "../controllers/machineController";
import { ProjectController } from "../controllers/projectController";
import { RecentProjectController } from "../controllers/recentProjectController";
import { WorkspaceController } from "../controllers/workspaceController";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
const { PiWebUiApp } = await import("./PiWebUiApp");
const { ClosedRecentProjectDialog } = await import("./ClosedRecentProjectDialog");
const { RecentProjectsPanel } = await import("./RecentProjectsPanel");
const { WorkspacePanel } = await import("./WorkspacePanel");
const { AppNavigationPanel } = await import("./appShell/AppNavigationPanel");

type PiWebUiAppElement = InstanceType<typeof PiWebUiApp>;
type ClosedDialogElement = InstanceType<typeof ClosedRecentProjectDialog>;
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

describe("PiWebUiApp closed recent-project focus restoration", () => {
  it("returns focus to the current primary action after keyboard activation and Cancel", async () => {
    const app = await mountApp();
    const panel = await recentPanel(app);
    const originalRow = recentRow(panel);
    const originalPrimary = recentPrimary(panel);
    originalPrimary.focus();

    originalPrimary.click();
    const dialog = await openedDialog(app);
    await setRecentEntries(app, []);
    expect(originalRow.isConnected).toBe(false);
    await setRecentEntries(app, [entry]);
    dialogButton(dialog, ".closed-recent-cancel").click();

    const currentPanel = await settledRecentPanel(app);
    const currentRow = recentRow(currentPanel);
    expect(app.renderRoot.querySelector("closed-recent-project-dialog")).toBeNull();
    expect(closeConnections).toEqual([true]);
    expect(currentRow).not.toBe(originalRow);
    expect(currentPanel.shadowRoot?.activeElement).toBe(recentPrimary(currentPanel));
  });

  it("returns focus after pointer activation closes through Escape and backdrop", async () => {
    const app = await mountApp();
    let panel = await recentPanel(app);
    recentPrimary(panel).click();
    let dialog = await openedDialog(app);

    nativeDialog(dialog).dispatchEvent(new Event("cancel", { cancelable: true }));
    panel = await settledRecentPanel(app);
    expect(panel.shadowRoot?.activeElement).toBe(recentPrimary(panel));

    recentPrimary(panel).click();
    dialog = await openedDialog(app);
    nativeDialog(dialog).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    panel = await settledRecentPanel(app);

    expect(panel.shadowRoot?.activeElement).toBe(recentPrimary(panel));
    expect(closeConnections).toEqual([true, true]);
  });

  it("keeps a former registered conflict open as an ordinary failure without reconciling", async () => {
    const app = await mountApp();
    const conflict = new HttpRequestError("Recent project is registered", 409);
    vi.spyOn(recentProjectsApi, "removeRecentProject").mockRejectedValue(conflict);
    vi.spyOn(recentProjectsApi, "recentProjects").mockResolvedValue([entry]);
    const loadProjects = vi.spyOn(api, "projects").mockResolvedValue([project]);

    const panel = await recentPanel(app);
    recentPrimary(panel).click();
    const dialog = await openedDialog(app);
    dialogButton(dialog, ".closed-recent-remove").click();

    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Recent project is registered");
    });

    expect(app.renderRoot.querySelector("closed-recent-project-dialog")).toBe(dialog);
    expect(nativeDialog(dialog).open).toBe(true);
    expect(loadProjects).not.toHaveBeenCalled();
    expect(appState(app).projects).toEqual([]);
    expect(appState(app).error).toBe("");
    expect(closeConnections).toEqual([]);
  });

  it("keeps a generic removal failure open", async () => {
    const app = await mountApp();
    vi.spyOn(recentProjectsApi, "removeRecentProject").mockRejectedValue(new HttpRequestError("Machine offline", 503));

    const panel = await recentPanel(app);
    recentPrimary(panel).click();
    const dialog = await openedDialog(app);
    dialogButton(dialog, ".closed-recent-remove").click();

    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Machine offline");
    });

    expect(app.renderRoot.querySelector("closed-recent-project-dialog")).toBe(dialog);
    expect(nativeDialog(dialog).open).toBe(true);
    expect(closeConnections).toEqual([]);
  });

  it("closes without restoring local row focus when the navigation selector changes machines", async () => {
    const app = await mountApp([entry], [localMachine, remoteMachine]);
    const panel = await recentPanel(app);
    const restoreLocalFocus = vi.fn();
    Reflect.set(panel, "restoreClosedFocus", restoreLocalFocus);
    recentPrimary(panel).click();
    await openedDialog(app);

    await selectMachineFromNavigation(app, remoteMachine);
    await app.updateComplete;

    expect(appState(app).selectedMachine).toBe(remoteMachine);
    expect(app.renderRoot.querySelector("closed-recent-project-dialog")).toBeNull();
    expect(closeConnections).toEqual([true]);
    expect(restoreLocalFocus).not.toHaveBeenCalled();
  });

  it("does not run retained local actions against the newly selected remote machine", async () => {
    const app = await mountApp([entry], [localMachine, remoteMachine]);
    vi.spyOn(workspaceController(app), "selectProject").mockResolvedValue();
    const addProject = vi.spyOn(api, "addProject").mockResolvedValue(project);
    const removeRecentProject = vi.spyOn(recentProjectsApi, "removeRecentProject").mockResolvedValue([]);

    const panel = await recentPanel(app);
    recentPrimary(panel).click();
    const dialogA = await openedDialog(app);
    const reopenA = dialogA.onReopen;
    const removeA = dialogA.onRemove;

    await selectMachineFromNavigation(app, remoteMachine);
    await reopenA(entry);
    await removeA(entry);

    expect(appState(app).selectedMachine).toBe(remoteMachine);
    expect(addProject).not.toHaveBeenCalled();
    expect(removeRecentProject).not.toHaveBeenCalled();
  });

  it("keeps remote dialog B open when a deferred local action settles", async () => {
    const app = await mountApp([entry, entryBeta], [localMachine, remoteMachine]);
    const pendingReopen = deferred<Project>();
    const reopen = vi.spyOn(projectsController(app), "addRegisteredProject").mockReturnValue(pendingReopen.promise);

    let panel = await recentPanel(app);
    const restoreLocalFocus = vi.fn();
    Reflect.set(panel, "restoreClosedFocus", restoreLocalFocus);
    recentPrimary(panel, entry.id).click();
    const dialogA = await openedDialog(app);
    const closeAttempted = observeNextDialogClose(dialogA);
    dialogButton(dialogA, ".closed-recent-reopen").click();

    await vi.waitFor(() => {
      expect(dialogButton(dialogA, ".closed-recent-reopen").disabled).toBe(true);
    });

    await selectMachineFromNavigation(app, remoteMachine);
    panel = await settledRecentPanel(app);
    recentPrimary(panel, entryBeta.id).click();
    const dialogB = await openedDialog(app);
    const reopenB = dialogButton(dialogB, ".closed-recent-reopen");
    expect(dialogB.shadowRoot?.activeElement).toBe(reopenB);

    pendingReopen.resolve(project);
    await closeAttempted;
    await app.updateComplete;

    expect(reopen).toHaveBeenCalledWith(entry.path, entry.name);
    expect(app.renderRoot.querySelector("closed-recent-project-dialog")).toBe(dialogB);
    expect(nativeDialog(dialogB).open).toBe(true);
    expect(dialogB.shadowRoot?.activeElement).toBe(reopenB);
    expect(restoreLocalFocus).not.toHaveBeenCalled();
  });

  it.each([
    ["Reopen", "cancel"],
    ["Remove", "escape"],
    ["Remove", "backdrop"],
  ] as const)("keeps dialog B open when pending %s in dialog A settles after %s", async (action, dismissal) => {
    const app = await mountApp([entry, entryBeta]);
    const projects = projectsController(app);
    const recent = recentProjectsController(app);
    const pendingReopen = deferred<Project>();
    const pendingRemove = deferred<{ kind: "removed" }>();
    const reopen = vi.spyOn(projects, "addRegisteredProject").mockReturnValue(pendingReopen.promise);
    const remove = vi.spyOn(recent, "removeEntry").mockReturnValue(pendingRemove.promise);

    let panel = await recentPanel(app);
    const alphaPrimary = recentPrimary(panel, entry.id);
    alphaPrimary.click();
    const dialogA = await openedDialog(app);
    const closeA = dialogA.onClose;
    const onCloseA = vi.fn(() => { closeA(); });
    dialogA.onClose = onCloseA;
    dialogButton(dialogA, action === "Reopen" ? ".closed-recent-reopen" : ".closed-recent-remove").click();

    await vi.waitFor(() => {
      expect(dialogButton(dialogA, ".closed-recent-reopen").disabled).toBe(true);
      expect(dialogButton(dialogA, ".closed-recent-remove").disabled).toBe(true);
      expect(dialogButton(dialogA, ".closed-recent-cancel").disabled).toBe(false);
    });

    if (dismissal === "cancel") dialogButton(dialogA, ".closed-recent-cancel").click();
    else if (dismissal === "escape") nativeDialog(dialogA).dispatchEvent(new Event("cancel", { cancelable: true }));
    else nativeDialog(dialogA).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => { expect(app.renderRoot.querySelector("closed-recent-project-dialog")).toBeNull(); });
    panel = await settledRecentPanel(app);
    recentPrimary(panel, entryBeta.id).click();
    const dialogB = await openedDialog(app);
    const reopenB = dialogButton(dialogB, ".closed-recent-reopen");
    expect(dialogB.shadowRoot?.activeElement).toBe(reopenB);

    if (action === "Reopen") {
      pendingReopen.resolve(project);
    } else {
      await setRecentEntries(app, [entryBeta]);
      pendingRemove.resolve({ kind: "removed" });
    }

    await vi.waitFor(() => { expect(onCloseA).toHaveBeenCalledTimes(2); });
    expect(app.renderRoot.querySelector("closed-recent-project-dialog")).toBe(dialogB);
    expect(nativeDialog(dialogB).open).toBe(true);
    expect(dialogB.shadowRoot?.activeElement).toBe(reopenB);
    panel = await settledRecentPanel(app);
    expect(panel.shadowRoot?.activeElement).not.toBe(alphaPrimary);
    if (action === "Reopen") expect(reopen).toHaveBeenCalledWith(entry.path, entry.name);
    else expect(remove).toHaveBeenCalledWith(entry.id);
  });

  it("restores focus after Reopen but never focuses a row removed from history", async () => {
    const app = await mountApp();
    const projects = projectsController(app);
    const recent = recentProjectsController(app);
    vi.spyOn(projects, "addRegisteredProject").mockResolvedValue(project);
    vi.spyOn(recent, "load").mockResolvedValue();

    let panel = await recentPanel(app);
    recentPrimary(panel).click();
    let dialog = await openedDialog(app);
    dialogButton(dialog, ".closed-recent-reopen").click();
    panel = await settledRecentPanel(app);

    expect(panel.shadowRoot?.activeElement).toBe(recentPrimary(panel));

    const rowRemovedByAction = recentRow(panel);
    const primaryRemovedByAction = recentPrimary(panel);
    primaryRemovedByAction.click();
    dialog = await openedDialog(app);
    vi.spyOn(recent, "removeEntry").mockImplementation(() => {
      Reflect.set(recent, "current", { kind: "ready", entries: [] });
      app.requestUpdate();
      return Promise.resolve({ kind: "removed" });
    });
    dialogButton(dialog, ".closed-recent-remove").click();
    panel = await settledRecentPanel(app);

    expect(panel.renderRoot.querySelector(".recent-project-row")).toBeNull();
    expect(rowRemovedByAction.isConnected).toBe(false);
    expect(panel.shadowRoot?.activeElement).not.toBe(primaryRemovedByAction);
    expect(closeConnections).toEqual([true, true]);
  });
});

async function mountApp(entries: RecentProjectEntry[] = [entry], machines: Machine[] = [localMachine]): Promise<PiWebUiAppElement> {
  const app = new PiWebUiApp();
  setAppState(app, {
    ...initialAppState(),
    machines,
    selectedMachine: localMachine,
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
  // The panel's focus closures settle on the element update cascade after the
  // dialog action completes, so flush enough microtask rounds for restored
  // focus to land before assertions.
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

async function openedDialog(app: PiWebUiAppElement): Promise<ClosedDialogElement> {
  await app.updateComplete;
  const dialog = app.renderRoot.querySelector("closed-recent-project-dialog");
  if (!(dialog instanceof ClosedRecentProjectDialog)) throw new Error("Expected closed recent-project dialog");
  await dialog.updateComplete;
  return dialog;
}

function nativeDialog(dialog: ClosedDialogElement): HTMLDialogElement {
  const native = dialog.renderRoot.querySelector<HTMLDialogElement>("dialog");
  if (native === null) throw new Error("Expected native dialog");
  return native;
}

function dialogButton(dialog: ClosedDialogElement, selector: string): HTMLButtonElement {
  const button = dialog.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`Expected ${selector}`);
  return button;
}

function observeNextDialogClose(dialog: ClosedDialogElement): Promise<void> {
  const attempted = deferred<undefined>();
  let onClose = dialog.onClose;
  Object.defineProperty(dialog, "onClose", {
    configurable: true,
    get: () => () => {
      try {
        onClose();
      } finally {
        attempted.resolve(undefined);
      }
    },
    set: (next: () => void) => { onClose = next; },
  });
  return attempted.promise;
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

async function setRecentEntries(app: PiWebUiAppElement, entries: RecentProjectEntry[]): Promise<void> {
  Reflect.set(recentProjectsController(app), "current", { kind: "ready", entries });
  app.requestUpdate();
  await app.updateComplete;
  await recentPanel(app);
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
