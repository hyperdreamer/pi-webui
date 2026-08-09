// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { Machine, Project, RecentProjectEntry } from "../api";
import { ProjectController } from "../controllers/projectController";
import { RecentProjectController } from "../controllers/recentProjectController";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
const { PiWebUiApp } = await import("./PiWebUiApp");
const { ClosedRecentProjectDialog } = await import("./ClosedRecentProjectDialog");
const { RecentProjectsPanel } = await import("./RecentProjectsPanel");
const { WorkspacePanel } = await import("./WorkspacePanel");

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

const entry: RecentProjectEntry = {
  id: "entry-alpha",
  name: "Alpha",
  path: "/work/alpha",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
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
  it("returns focus to the current row after keyboard activation and Cancel", async () => {
    const app = await mountApp();
    const originalRow = recentRow(await recentPanel(app));
    originalRow.focus();

    originalRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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
    expect(currentPanel.shadowRoot?.activeElement).toBe(currentRow);
  });

  it("returns focus after pointer activation closes through Escape and backdrop", async () => {
    const app = await mountApp();
    let panel = await recentPanel(app);
    recentRow(panel).click();
    let dialog = await openedDialog(app);

    nativeDialog(dialog).dispatchEvent(new Event("cancel", { cancelable: true }));
    panel = await settledRecentPanel(app);
    expect(panel.shadowRoot?.activeElement).toBe(recentRow(panel));

    recentRow(panel).click();
    dialog = await openedDialog(app);
    nativeDialog(dialog).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    panel = await settledRecentPanel(app);

    expect(panel.shadowRoot?.activeElement).toBe(recentRow(panel));
    expect(closeConnections).toEqual([true, true]);
  });

  it("restores focus after Reopen but never focuses a row removed from history", async () => {
    const app = await mountApp();
    const projects = projectsController(app);
    const recent = recentProjectsController(app);
    vi.spyOn(projects, "addRegisteredProject").mockResolvedValue(project);
    vi.spyOn(recent, "load").mockResolvedValue();

    let panel = await recentPanel(app);
    recentRow(panel).click();
    let dialog = await openedDialog(app);
    dialogButton(dialog, ".closed-recent-reopen").click();
    panel = await settledRecentPanel(app);

    expect(panel.shadowRoot?.activeElement).toBe(recentRow(panel));

    const rowRemovedByAction = recentRow(panel);
    rowRemovedByAction.click();
    dialog = await openedDialog(app);
    vi.spyOn(recent, "removeEntry").mockImplementation(() => {
      Reflect.set(recent, "current", { kind: "ready", entries: [] });
      app.requestUpdate();
      return Promise.resolve();
    });
    dialogButton(dialog, ".closed-recent-remove").click();
    panel = await settledRecentPanel(app);

    expect(panel.renderRoot.querySelector(".recent-project-row")).toBeNull();
    expect(rowRemovedByAction.isConnected).toBe(false);
    expect(panel.shadowRoot?.activeElement).not.toBe(rowRemovedByAction);
    expect(closeConnections).toEqual([true, true]);
  });
});

async function mountApp(): Promise<PiWebUiAppElement> {
  const app = new PiWebUiApp();
  setAppState(app, {
    ...initialAppState(),
    selectedMachine: localMachine,
    workspaceTool: "core:recent-projects",
    mainView: "core:recent-projects",
  });
  const recent = recentProjectsController(app);
  Reflect.set(recent, "current", { kind: "ready", entries: [entry] });
  vi.spyOn(recent, "load").mockResolvedValue();
  for (const methodName of [
    "renegotiateUnreadMachines",
    "refreshWorkspaceActivity",
    "loadClientConfig",
    "ensureGatewayPluginsLoaded",
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
  await app.updateComplete;
  await Promise.resolve();
  return recentPanel(app);
}

function recentRow(panel: RecentProjectsPanelElement): HTMLElement {
  const row = panel.renderRoot.querySelector<HTMLElement>(".recent-project-row");
  if (row === null) throw new Error("Expected recent project row");
  return row;
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
