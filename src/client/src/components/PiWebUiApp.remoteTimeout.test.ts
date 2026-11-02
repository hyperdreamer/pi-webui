// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, projectsApi, type Machine, type Project, type SessionInfo, type Workspace } from "../api";
import { initialAppState, type AppState, type SessionListFailure, type SessionListLoad } from "../appState";
import { ProjectCatalogController } from "../controllers/projectCatalogController";
import { SessionController } from "../controllers/sessionController";
import { WorkspaceController } from "../controllers/workspaceController";
import { RealtimeSocket } from "../sessionSocket";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
const { PiWebUiApp } = await import("./PiWebUiApp");
const { AppNavigationPanel } = await import("./appShell/AppNavigationPanel");
const { MachineDialog } = await import("./MachineDialog");
const { MachineList } = await import("./MachineList");
const { MachineSwitcher } = await import("./MachineSwitcher");
const { SessionList } = await import("./SessionList");
const { SessionListLoadNotice } = await import("./SessionListLoadNotice");
type PiWebUiAppElement = InstanceType<typeof PiWebUiApp>;
type AppNavigationPanelElement = InstanceType<typeof AppNavigationPanel>;
type SessionListElement = InstanceType<typeof SessionList>;
type SessionListLoadNoticeElement = InstanceType<typeof SessionListLoadNotice>;
type MachineDialogElement = InstanceType<typeof MachineDialog>;
type MachineListElement = InstanceType<typeof MachineList>;
type MachineSwitcherElement = InstanceType<typeof MachineSwitcher>;

const localMachine: Machine = {
  id: "local",
  name: "This machine",
  kind: "local",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};

const remoteMachine: Machine = {
  id: "remote-lab",
  name: "Remote Lab",
  kind: "remote",
  baseUrl: "https://lab.example.test/",
  requestTimeoutMs: 90_000,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};

const project: Project = {
  id: "project-a",
  name: "Project A",
  path: "/work/project-a",
  createdAt: "2026-10-17T00:00:00.000Z",
};

const workspace: Workspace = {
  id: "workspace-a",
  projectId: project.id,
  path: "/work/project-a",
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

const session: SessionInfo = {
  id: "session-a",
  cwd: workspace.path,
  path: "/work/project-a/.pi/sessions/session-a.jsonl",
  created: "2026-10-17T00:00:00.000Z",
  modified: "2026-10-17T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hello",
};

const LOAD_STARTED_AT = 1_000_000;
const REMOTE_BUDGET_MS = 120_000;

let mountedApp: PiWebUiAppElement | undefined;

beforeEach(() => {
  // jsdom has no usable matchMedia; the app guards on the property's presence,
  // so it must be a function rather than a missing global.
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: desktopMediaQuery });
});

afterEach(async () => {
  document.body.replaceChildren();
  await mountedApp?.updateComplete;
  await Promise.resolve();
  mountedApp = undefined;
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("PiWebUiApp remote session-list feedback", () => {
  it("shows retry feedback with a session open and keeps the start screen hidden", async () => {
    const app = await mountApp({
      selectedSession: session,
      sessions: [session],
      sessionListFailure: timeoutFailure(),
    });
    await settleUpdates(app);

    expect(noticeText(app)).toContain("Try again");
    expect(appElement(app, "chat-view")).not.toBeNull();
    expect(appElement(app, ".empty")).toBeNull();
    expect(shouldShowSessionStartScreen(app)).toBe(false);
  });

  it("keeps the start screen hidden while a list failure explains the wait", async () => {
    const app = await mountApp({
      sessions: [],
      sessionListFailure: timeoutFailure(),
    });

    expect(shouldShowSessionStartScreen(app)).toBe(false);
    expect(appElement(app, ".empty")?.textContent).toBe("Select or start a session.");

    const noFailure = await mountApp({ sessions: [] });
    expect(shouldShowSessionStartScreen(noFailure)).toBe(true);
  });

  it("an unrelated error after a timeout still appears in the banner", async () => {
    const app = await mountApp({
      selectedSession: session,
      sessions: [session],
      sessionListFailure: timeoutFailure(),
    });
    Reflect.set(app, "state", { ...appState(app), error: "unrelated error" });
    await settleUpdates(app);

    expect(appElement(app, ".error")?.textContent).toContain("unrelated error");
    const retry = vi.spyOn(workspacesController(app), "retrySessionList").mockResolvedValue(undefined);
    clickButton(noticeRoot(app), "Try again");
    await settleUpdates(app);

    expect(retry).toHaveBeenCalledOnce();
    expect(appElement(app, ".error")?.textContent).toContain("unrelated error");
    expect(noticeText(app)).toContain("Try again");
  });
});

describe("PiWebUiApp machine edit dialog", () => {
  it("routes Raise limit and both Edit actions to the same guarded dialog", async () => {
    const app = await mountApp({
      selectedSession: session,
      sessions: [session],
      sessionListFailure: timeoutFailure(),
    });
    await settleUpdates(app);

    clickButton(noticeRoot(app), "Raise limit");
    await app.updateComplete;

    expect(machineDialogTarget(app)?.id).toBe(remoteMachine.id);
    expect(Reflect.get(app, "machineDialogFocusRequestTimeout")).toBe(true);
    expect(machineDialog(app)?.machine?.id).toBe(remoteMachine.id);

    await openMachineListEdit(await openCompactMachineList(app));
    await app.updateComplete;
    expect(machineDialogTarget(app)?.id).toBe(remoteMachine.id);

    clickMachineSwitcherEdit(await openSwitcherActions(app));
    await app.updateComplete;
    expect(machineDialogTarget(app)?.id).toBe(remoteMachine.id);
    expect(machineDialog(app)?.machine?.id).toBe(remoteMachine.id);
  });

  it("ignores a dialog submit that lands after a newer dialog opened", async () => {
    const update = deferred<Machine>();
    const updateMachine = vi.spyOn(api, "updateMachine").mockReturnValue(update.promise);
    const app = await mountApp();
    openEditDialog(app, remoteMachine);
    await app.updateComplete;
    const generation: unknown = Reflect.get(app, "machineDialogGeneration");

    const staleSubmit = submitMachineDialog(app, generation, 150_000);
    openCreateDialog(app);
    await app.updateComplete;
    update.resolve({ ...remoteMachine, requestTimeoutMs: 150_000 });
    await staleSubmit;

    expect(updateMachine).toHaveBeenCalledWith(remoteMachine.id, {
      name: remoteMachine.name,
      baseUrl: remoteMachine.baseUrl,
      requestTimeoutMs: 150_000,
    });
    expect(appState(app).machineDialogOpen).toBe(true);
    expect(machineDialogTarget(app)).toBeUndefined();
    expect(appState(app).selectedMachine?.id).toBe(remoteMachine.id);
  });

  it("keeps the selection when a superseded create lands after a newer dialog opened", async () => {
    const creation = deferred<Machine>();
    const addMachine = vi.spyOn(api, "addMachine").mockReturnValue(creation.promise);
    const app = await mountApp({ selectedSession: session, sessions: [session] });
    openCreateDialog(app);
    await app.updateComplete;
    const generation: unknown = Reflect.get(app, "machineDialogGeneration");

    const staleSubmit = submitMachineDialog(app, generation, 120_000);
    openCreateDialog(app);
    await app.updateComplete;
    creation.resolve({ ...remoteMachine, id: "remote-new" });
    await staleSubmit;
    await settleUpdates(app);

    expect(addMachine).toHaveBeenCalledWith({
      name: remoteMachine.name,
      baseUrl: remoteMachine.baseUrl,
      requestTimeoutMs: 120_000,
    });
    // The create persisted, but the newer dialog owns the UI: no selection and
    // no workspace/session reset may follow from the superseded submit.
    expect(appState(app).machines.some((machine) => machine.id === "remote-new")).toBe(true);
    expect(appState(app).machineDialogOpen).toBe(true);
    expect(machineDialogTarget(app)).toBeUndefined();
    expect(appState(app).selectedMachine?.id).toBe(remoteMachine.id);
    expect(appState(app).selectedWorkspace?.id).toBe(workspace.id);
    expect(appState(app).selectedSession?.id).toBe(session.id);
  });

  it("keeps a superseded edit failure out of the newer dialog", async () => {
    const update = deferred<Machine>();
    const updateMachine = vi.spyOn(api, "updateMachine").mockReturnValue(update.promise);
    const app = await mountApp();
    openEditDialog(app, remoteMachine);
    await app.updateComplete;
    const generation: unknown = Reflect.get(app, "machineDialogGeneration");

    const staleSubmit = submitMachineDialog(app, generation, 150_000);
    openCreateDialog(app);
    await app.updateComplete;
    Reflect.set(app, "state", { ...appState(app), error: "Newer dialog error" });
    await settleUpdates(app);

    update.reject(new Error("Remote rejected the old edit"));
    await staleSubmit;
    await settleUpdates(app);

    expect(updateMachine).toHaveBeenCalledWith(remoteMachine.id, {
      name: remoteMachine.name,
      baseUrl: remoteMachine.baseUrl,
      requestTimeoutMs: 150_000,
    });
    expect(appState(app).machineDialogOpen).toBe(true);
    expect(machineDialogTarget(app)).toBeUndefined();
    expect(appState(app).error).toBe("Newer dialog error");
    expect(machineDialog(app)?.error).toBe("Newer dialog error");
    expect(appState(app).selectedMachine?.id).toBe(remoteMachine.id);
  });

  it("shows a current edit failure in the dialog that owns it", async () => {
    vi.spyOn(api, "updateMachine").mockRejectedValue(new Error("Remote rejected the edit"));
    const app = await mountApp();
    openEditDialog(app, remoteMachine);
    await app.updateComplete;
    const generation: unknown = Reflect.get(app, "machineDialogGeneration");

    await submitMachineDialog(app, generation, 150_000);
    await settleUpdates(app);

    expect(appState(app).machineDialogOpen).toBe(true);
    expect(appState(app).error).toBe("Error: Remote rejected the edit");
    expect(machineDialog(app)?.error).toContain("Remote rejected the edit");
  });

  it("saves the edited patience without selecting or resetting the machine", async () => {
    const updateMachine = vi.spyOn(api, "updateMachine").mockImplementation((machineId, patch) => Promise.resolve({
      ...remoteMachine,
      ...patch,
      id: machineId,
    }));
    const loadProjects = vi.spyOn(projectsApi, "projects");
    const app = await mountApp({ selectedSession: session, sessions: [session] });
    openEditDialog(app, remoteMachine);
    await app.updateComplete;

    const dialog = machineDialog(app);
    if (dialog === null) throw new Error("Expected the machine dialog");
    await dialog.updateComplete;
    expect(inputValue(dialog, "requestTimeoutMs")).toBe("90");

    await setInput(dialog, "requestTimeoutMs", "150");
    await submitDialog(dialog);
    await settleUpdates(app);

    expect(updateMachine).toHaveBeenCalledWith(remoteMachine.id, {
      name: remoteMachine.name,
      baseUrl: remoteMachine.baseUrl,
      requestTimeoutMs: 150_000,
    });
    expect(loadProjects).not.toHaveBeenCalled();
    expect(appState(app).machineDialogOpen).toBe(false);
    expect(appState(app).machines.find((machine) => machine.id === remoteMachine.id)?.requestTimeoutMs).toBe(150_000);
    expect(appState(app).selectedMachine).toMatchObject({ id: remoteMachine.id, requestTimeoutMs: 150_000 });
    expect(appState(app).selectedWorkspace?.id).toBe(workspace.id);
    expect(appState(app).selectedSession?.id).toBe(session.id);
  });

  it("creates a machine with the confirmed patience and closes its own dialog", async () => {
    const addMachine = vi.spyOn(api, "addMachine").mockResolvedValue({ ...remoteMachine, id: "remote-new" });
    const app = await mountApp();
    openCreateDialog(app);
    await app.updateComplete;

    const dialog = machineDialog(app);
    if (dialog === null) throw new Error("Expected the machine dialog");
    await dialog.updateComplete;
    await setInput(dialog, "baseUrl", "https://lab.example.test/");
    await setInput(dialog, "name", "Remote Lab");
    await setInput(dialog, "requestTimeoutMs", "120");
    await submitDialog(dialog);
    await settleUpdates(app);

    expect(addMachine).toHaveBeenCalledWith({
      name: remoteMachine.name,
      baseUrl: remoteMachine.baseUrl,
      requestTimeoutMs: 120_000,
    });
    expect(appState(app).machineDialogOpen).toBe(false);
  });
});

describe("PiWebUiApp remote read intents", () => {
  it("classifies realtime invalidations and recovery refreshes as background reads", async () => {
    const app = await mountApp({ selectedMachine: localMachine });
    const workspaces = workspacesController(app);
    const refresh = vi.spyOn(workspaces, "refreshSessionLists").mockResolvedValue(undefined);

    callAppMethod(app, "handleRealtimeEvent", localMachine.id, { type: "sessions.changed", cwd: workspace.path });
    expect(refresh).toHaveBeenLastCalledWith([workspace.path], localMachine.id, "background");

    const reconnect = captureReconnect(app);
    callAppMethod(app, "connectRealtime");
    reconnect();
    await flush();

    expect(refresh).toHaveBeenLastCalledWith(undefined, localMachine.id, "background");
  });

  it("keeps mutation reconciliation on the foreground read path", async () => {
    const app = await mountApp();
    const refresh = vi.spyOn(workspacesController(app), "refreshSessionLists").mockResolvedValue(undefined);
    const forward: unknown = Reflect.get(sessionController(app), "refreshSessionLists");
    if (typeof forward !== "function") throw new Error("SessionController refreshSessionLists is unavailable");

    await Promise.resolve(Reflect.apply(forward, sessionController(app), [[workspace.path], localMachine.id, "foreground"]));

    expect(refresh).toHaveBeenCalledWith([workspace.path], localMachine.id, "foreground");
  });
});

describe("PiWebUiApp session-list notice wiring", () => {
  it("passes the selected machine and the load and failure records down to the notice", async () => {
    const load = selectionLoad();
    const failure = timeoutFailure();
    const app = await mountApp({ sessionListLoad: load, sessionListFailure: failure });

    await settleUpdates(app);
    const panel = navigationPanel(app);
    expect(Reflect.get(panel, "sessionListLoad")).toBe(load);
    expect(Reflect.get(panel, "sessionListFailure")).toBe(failure);

    const list = sessionList(app);
    expect(Reflect.get(list, "machine")?.id).toBe(remoteMachine.id);
    expect(Reflect.get(list, "sessionListLoad")).toBe(load);
    expect(Reflect.get(list, "sessionListFailure")).toBe(failure);
    expect(Reflect.get(list, "onRetrySessionList")).toBeTypeOf("function");
    expect(Reflect.get(list, "onRaiseSessionListLimit")).toBeTypeOf("function");
  });

  it("hides failures outside the selected workspace scope", async () => {
    const foreignMachineFailure = timeoutFailure({ machineId: "remote-other" });
    const foreignWorkspaceFailure = timeoutFailure({ workspaceId: "workspace-other" });
    const movedProjectFailure = timeoutFailure({ projectPath: "/moved/project" });
    const movedPathFailure = timeoutFailure({ workspacePath: "/moved/workspace" });
    const app = await mountApp({
      selectedSession: session,
      sessions: [session],
      sessionListFailure: foreignMachineFailure,
    });
    await settleUpdates(app);

    expect(noticeText(app)).not.toContain("Raise limit");
    expect(machineDialogTarget(app)).toBeUndefined();

    for (const failure of [foreignWorkspaceFailure, movedProjectFailure, movedPathFailure]) {
      Reflect.set(app, "state", { ...appState(app), sessionListFailure: failure });
      await settleUpdates(app);
      expect(noticeText(app)).not.toContain("Try again");
      expect(machineDialogTarget(app)).toBeUndefined();
    }
  });

  it("binds retained failure actions to their originating scope", async () => {
    const failure = timeoutFailure();
    const app = await mountApp({ sessionListFailure: failure });
    await settleUpdates(app);
    const actionButtons = Array.from(noticeRoot(app).querySelectorAll<HTMLButtonElement>("button"));
    const retryButton = actionButtons[0];
    const raiseButton = actionButtons[1];
    if (retryButton === undefined || raiseButton === undefined) throw new Error("Expected both failure actions");
    const retry = vi.spyOn(workspacesController(app), "retrySessionList").mockResolvedValue(undefined);
    const movedWorkspace = { ...workspace, path: "/moved/workspace" };
    Reflect.set(app, "state", {
      ...appState(app),
      selectedWorkspace: movedWorkspace,
      workspaces: [movedWorkspace],
      workspacesByProjectId: { [project.id]: [movedWorkspace] },
    });
    await settleUpdates(app);

    retryButton.click();
    raiseButton.click();
    await app.updateComplete;

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(failure);
    expect(machineDialogTarget(app)).toBeUndefined();
  });
});

describe("machine menus under the navigation panel", () => {
  it("forwards edit from both machine menus without selecting the machine", async () => {
    const onEdit = vi.fn();
    const onSelect = vi.fn();
    const panel = await mountPanel((instance) => {
      instance.machines = [localMachine, remoteMachine];
      instance.selectedMachine = remoteMachine;
      instance.onEditMachine = onEdit;
      instance.onSelectMachine = onSelect;
    });

    clickMachineSwitcherEdit(await openSwitcherActionsFrom(panel));
    expect(onEdit).toHaveBeenCalledWith(remoteMachine);
    expect(onSelect).not.toHaveBeenCalled();

    panel.compact = true;
    await panel.updateComplete;
    await openMachineListEdit(openCompactMachineListFrom(panel));
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null
    && Array.isArray(Reflect.get(value, "machines"))
    && "selectedMachine" in value
    && "error" in value;
}

function appState(app: PiWebUiAppElement): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebUiApp state is unavailable");
  return state;
}

async function mountApp(overrides: Partial<AppState> = {}): Promise<PiWebUiAppElement> {
  const app = new PiWebUiApp();
  Reflect.set(app, "state", { ...baseState(), ...overrides } satisfies AppState);
  // Adding a machine selects it, which reloads projects and probes the new
  // machine; keep that path in-process instead of on the shared fetch double.
  vi.spyOn(api, "projects").mockResolvedValue([project]);
  vi.spyOn(api, "health").mockResolvedValue({ machineId: localMachine.id, ok: true, checkedAt: "2026-10-17T00:00:00.000Z", status: "online" });
  vi.spyOn(api, "runtime").mockResolvedValue({ machineId: localMachine.id, ok: true, checkedAt: "2026-10-17T00:00:00.000Z" });
  mountWithoutAppSideEffects(app);
  await settleUpdates(app);
  return app;
}

/** Drain the app and the custom elements it renders, which update in turns. */
async function settleUpdates(app: PiWebUiAppElement): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    await flush();
    await app.updateComplete;
  }
}

function baseState(): AppState {
  return {
    ...initialAppState(),
    machines: [localMachine, remoteMachine],
    selectedMachine: remoteMachine,
    projects: [project],
    workspaces: [workspace],
    selectedProject: project,
    selectedWorkspace: workspace,
  };
}

function mountWithoutAppSideEffects(app: PiWebUiAppElement): void {
  mountedApp = app;
  vi.spyOn(PiWebUiApp.prototype, "connectedCallback").mockImplementation(function (this: PiWebUiAppElement): void {
    LitElement.prototype.connectedCallback.call(this);
  });
  document.body.append(app);
}

async function mountPanel(configure: (panel: AppNavigationPanelElement) => void): Promise<AppNavigationPanelElement> {
  const panel = new AppNavigationPanel();
  configure(panel);
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function shouldShowSessionStartScreen(app: PiWebUiAppElement): boolean {
  const method: unknown = Reflect.get(app, "shouldShowSessionStartScreen");
  if (typeof method !== "function") throw new Error("shouldShowSessionStartScreen is unavailable");
  return Reflect.apply(method, app, [appState(app)]) === true;
}

function workspacesController(app: PiWebUiAppElement): WorkspaceController {
  const workspaces: unknown = Reflect.get(app, "workspaces");
  if (!(workspaces instanceof WorkspaceController)) throw new Error("PiWebUiApp workspaces controller is unavailable");
  return workspaces;
}

function sessionController(app: PiWebUiAppElement): SessionController {
  const sessions: unknown = Reflect.get(app, "sessions");
  if (!(sessions instanceof SessionController)) throw new Error("PiWebUiApp sessions controller is unavailable");
  return sessions;
}

function callAppMethod(app: PiWebUiAppElement, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`PiWebUiApp.${name} is not callable`);
  return Reflect.apply(method, app, args);
}

function appElement(app: PiWebUiAppElement, selector: string): HTMLElement | null {
  return app.renderRoot.querySelector<HTMLElement>(selector);
}

function navigationPanel(app: PiWebUiAppElement): AppNavigationPanelElement {
  const panel = app.renderRoot.querySelector("app-navigation-panel");
  if (!(panel instanceof AppNavigationPanel)) throw new Error("Expected the navigation panel");
  return panel;
}

function sessionList(app: PiWebUiAppElement): SessionListElement {
  const list = navigationPanel(app).renderRoot.querySelector("session-list");
  if (!(list instanceof SessionList)) throw new Error("Expected the session list");
  return list;
}

function noticeElement(app: PiWebUiAppElement): SessionListLoadNoticeElement | null {
  const notice = sessionList(app).renderRoot.querySelector("session-list-load-notice");
  return notice instanceof SessionListLoadNotice ? notice : null;
}

function noticeRoot(app: PiWebUiAppElement): ShadowRoot {
  const notice = noticeElement(app);
  if (notice === null) throw new Error("Expected the session list load notice");
  const root = notice.shadowRoot;
  if (root === null) throw new Error("Expected an open notice shadow root");
  return root;
}

function noticeText(app: PiWebUiAppElement): string {
  return noticeRoot(app).textContent;
}

function machineDialog(app: PiWebUiAppElement): MachineDialogElement | null {
  const dialog = app.renderRoot.querySelector("machine-dialog");
  return dialog instanceof MachineDialog ? dialog : null;
}

function isMachine(value: unknown): value is Machine {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "string";
}

function machineDialogTarget(app: PiWebUiAppElement): Machine | undefined {
  const target: unknown = Reflect.get(app, "machineDialogTarget");
  return isMachine(target) ? target : undefined;
}

function openEditDialog(app: PiWebUiAppElement, machine: Machine): void {
  const open: unknown = Reflect.get(app, "openMachineEditDialog");
  if (typeof open !== "function") throw new Error("openMachineEditDialog is unavailable");
  Reflect.apply(open, app, [machine]);
}

function openCreateDialog(app: PiWebUiAppElement): void {
  const open: unknown = Reflect.get(app, "openMachineDialog");
  if (typeof open !== "function") throw new Error("openMachineDialog is unavailable");
  Reflect.apply(open, app, []);
}

function submitMachineDialog(app: PiWebUiAppElement, generation: unknown, requestTimeoutMs: number): Promise<void> {
  const submit: unknown = Reflect.get(app, "submitMachineDialog");
  if (typeof submit !== "function") throw new Error("submitMachineDialog is unavailable");
  const result: unknown = Reflect.apply(submit, app, [{
    name: remoteMachine.name,
    baseUrl: remoteMachine.baseUrl,
    requestTimeoutMs,
  }, generation]);
  if (!(result instanceof Promise)) throw new Error("submitMachineDialog did not return a promise");
  return result;
}

async function openCompactMachineList(app: PiWebUiAppElement): Promise<MachineListElement> {
  const panel = navigationPanel(app);
  panel.compact = true;
  await panel.updateComplete;
  return openCompactMachineListFrom(panel);
}

function openCompactMachineListFrom(panel: AppNavigationPanelElement): MachineListElement {
  const list = panel.renderRoot.querySelector("machine-list");
  if (!(list instanceof MachineList)) throw new Error("Expected the compact machine list");
  return list;
}

async function openSwitcherActions(app: PiWebUiAppElement): Promise<MachineSwitcherElement> {
  const panel = navigationPanel(app);
  panel.compact = false;
  await panel.updateComplete;
  return openSwitcherActionsFrom(panel);
}

async function openSwitcherActionsFrom(panel: AppNavigationPanelElement): Promise<MachineSwitcherElement> {
  const switcher = panel.renderRoot.querySelector("machine-switcher");
  if (!(switcher instanceof MachineSwitcher)) throw new Error("Expected the machine switcher");
  const root = switcher.shadowRoot;
  if (root === null) throw new Error("Expected an open switcher shadow root");
  const trigger = root.querySelector<HTMLButtonElement>(".machine-switcher-button");
  if (trigger === null) throw new Error("Expected the switcher trigger");
  trigger.click();
  await switcher.updateComplete;
  const toggle = root.querySelector<HTMLButtonElement>(`.machine-option-actions-toggle[aria-label="Actions for ${remoteMachine.name}"]`);
  if (toggle === null) throw new Error("Expected the switcher actions toggle");
  toggle.click();
  await switcher.updateComplete;
  return switcher;
}

function clickMachineSwitcherEdit(switcher: MachineSwitcherElement): void {
  const root = switcher.shadowRoot;
  if (root === null) throw new Error("Expected an open switcher shadow root");
  const panel = root.querySelector<HTMLElement>(".machine-option-actions-panel");
  if (panel === null) throw new Error("Expected an open switcher actions panel");
  clickButton(panel, "Edit");
}

async function openMachineListEdit(list: MachineListElement): Promise<void> {
  const root = list.shadowRoot;
  if (root === null) throw new Error("Expected an open machine list shadow root");
  const row = Array.from(root.querySelectorAll<HTMLElement>(".machine-row"))
    .find((candidate) => candidate.querySelector(".machine-primary-label")?.textContent === remoteMachine.name);
  if (row === undefined) throw new Error(`Expected a machine row for ${remoteMachine.name}`);
  const toggle = row.querySelector<HTMLButtonElement>(".action-menu-toggle");
  if (toggle === null) throw new Error("Expected a machine actions menu");
  toggle.click();
  await list.updateComplete;
  const menu = row.querySelector<HTMLElement>(".action-menu-panel");
  if (menu === null) throw new Error("Expected an open machine actions menu");
  clickButton(menu, "Edit");
  await list.updateComplete;
}

function captureReconnect(app: PiWebUiAppElement): () => void {
  let reconnect: (() => void) | undefined;
  const realtime: unknown = Reflect.get(app, "realtime");
  if (!(realtime instanceof RealtimeSocket)) throw new Error("Realtime socket is unavailable");
  vi.spyOn(realtime, "connect").mockImplementation((_onEvent, onOpen) => {
    if (typeof onOpen === "function") reconnect = onOpen;
  });
  // Recovery touches collaborators that own their own budgets; only the intent
  // this app hands the session-list refresh is under test here.
  Reflect.set(app, "renegotiateUnreadMachine", () => Promise.resolve());
  Reflect.set(app, "refreshWorkspaceActivity", () => Promise.resolve());
  Reflect.set(app, "refreshActiveTerminals", () => Promise.resolve());
  const projectCatalog: unknown = Reflect.get(app, "projectCatalog");
  if (!(projectCatalog instanceof ProjectCatalogController)) throw new Error("Project catalog controller is unavailable");
  vi.spyOn(projectCatalog, "refresh").mockResolvedValue(undefined);
  return () => {
    if (reconnect === undefined) throw new Error("RealtimeSocket.connect did not receive a reconnect callback");
    reconnect();
  };
}

function selectionLoad(): SessionListLoad {
  return {
    owner: "selection",
    scope: { machineId: remoteMachine.id, projectId: project.id, projectPath: project.path, workspaceId: workspace.id, workspacePath: workspace.path },
    startedAt: LOAD_STARTED_AT,
    budgetMs: REMOTE_BUDGET_MS,
    phase: "waiting",
  };
}

function timeoutFailure(overrides: { machineId?: string; workspaceId?: string; projectPath?: string; workspacePath?: string } = {}): SessionListFailure {
  const failure: SessionListFailure = {
    scope: {
      machineId: overrides.machineId ?? remoteMachine.id,
      machineName: remoteMachine.name,
      projectId: project.id,
      projectPath: overrides.projectPath ?? project.path,
      workspaceId: overrides.workspaceId ?? workspace.id,
      workspacePath: overrides.workspacePath ?? workspace.path,
    },
    kind: "timeout",
    elapsedMs: 1_002_000,
    budgetMs: REMOTE_BUDGET_MS,
  };
  return failure;
}

function clickButton(root: ParentNode, label: string): void {
  const button = Array.from(root.querySelectorAll("button"))
    .find((candidate) => candidate.textContent.trim() === label);
  if (button === undefined) throw new Error(`Expected a ${label} button`);
  button.click();
}

function inputValue(dialog: MachineDialogElement, name: string): string {
  const input = dialog.renderRoot.querySelector<HTMLInputElement>(`input[name='${name}']`);
  if (input === null) throw new Error(`Expected the ${name} input`);
  return input.value;
}

async function setInput(dialog: MachineDialogElement, name: string, value: string): Promise<void> {
  const input = dialog.renderRoot.querySelector<HTMLInputElement>(`input[name='${name}']`);
  if (input === null) throw new Error(`Expected the ${name} input`);
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await dialog.updateComplete;
}

async function submitDialog(dialog: MachineDialogElement): Promise<void> {
  const form = dialog.renderRoot.querySelector("form");
  if (form === null) throw new Error("Expected the dialog form");
  form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, composed: true }));
  await flush();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return {
    promise,
    resolve: (value: T) => { if (resolve === undefined) throw new Error("Deferred already settled"); resolve(value); },
    reject: (reason: unknown) => { if (reject === undefined) throw new Error("Deferred already settled"); reject(reason); },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function desktopMediaQuery(query: string): MediaQueryList {
  return {
    matches: query.includes("min-width"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}
