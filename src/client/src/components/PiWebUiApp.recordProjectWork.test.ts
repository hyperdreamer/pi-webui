import { afterEach, describe, expect, it, vi } from "vitest";
import { api, terminalsApi } from "../api";
import type { GitStatusResponse, Machine, Project, StarterModelPolicyPreference, TerminalCommandRun, Workspace } from "../api";
import type { AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { WorkspaceController } from "../controllers/workspaceController";
import type { WorkspacePanelTerminal } from "../plugins/types";
import { isTemplateResult, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

const project: Project = {
  id: "p1",
  name: "alpha",
  path: "/work/alpha",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  path: "/work/alpha",
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

const projectBeta: Project = {
  id: "p2",
  name: "beta",
  path: "/work/beta",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const remoteMachine: Machine = {
  id: "remote-b",
  name: "Remote B",
  kind: "remote",
  baseUrl: "https://remote-b.example.test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const plusPolicy: StarterModelPolicyPreference = {
  mode: "tiered",
  tier: "frontier",
  exact: { model: { provider: "openai", id: "gpt-frontier" }, thinkingLevel: "high" },
};

const terminalCommandRun: TerminalCommandRun = {
  id: "run-1",
  origin: "core",
  projectId: "p1",
  workspaceId: "w1",
  terminalId: "t1",
  title: "Build",
  command: "npm test",
  status: "succeeded",
  createdAt: "2026-01-01T00:00:00.000Z",
  metadata: {},
};

const gitStatus: GitStatusResponse = { isGitRepo: true, hash: "abc123", files: [] };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface RecordedProjectWork {
  projectId: string;
  machineId: string | undefined;
}

function installRecorder(app: PiWebUiApp): RecordedProjectWork[] {
  const recorded: RecordedProjectWork[] = [];
  const controller: unknown = Reflect.get(app, "recentProjects");
  if (typeof controller !== "object" || controller === null) throw new Error("Expected the recentProjects controller");
  Reflect.set(controller, "recordWork", (projectId: string, machineId?: string) => { recorded.push({ projectId, machineId }); });
  return recorded;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function recordProjectWork(app: PiWebUiApp): void {
  const record: unknown = Reflect.get(app, "recordProjectWork");
  if (typeof record !== "function") throw new Error("Expected recordProjectWork");
  record.call(app);
}

function setState(app: PiWebUiApp, patch: Record<string, unknown>): void {
  if (!Reflect.set(app, "state", { ...Reflect.get(app, "state"), ...patch })) throw new Error("Could not set app state");
}

function invokePrivate(app: PiWebUiApp, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`Expected ${name}`);
  return method.call(app, ...args);
}

function appState(app: PiWebUiApp): AppState {
  const value: unknown = Reflect.get(app, "state");
  if (!isAppState(value)) throw new Error("Expected app state");
  return value;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "selectedProject") === "object"
    && typeof Reflect.get(value, "workspaceTool") === "string"
    && typeof Reflect.get(value, "mainView") === "string";
}

function sessions(app: PiWebUiApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("Expected the sessions controller");
  return controller;
}

function workspaces(app: PiWebUiApp): WorkspaceController {
  const controller: unknown = Reflect.get(app, "workspaces");
  if (!(controller instanceof WorkspaceController)) throw new Error("Expected the workspaces controller");
  return controller;
}

function workspacePanelTerminal(app: PiWebUiApp): WorkspacePanelTerminal {
  const create: unknown = Reflect.get(app, "createWorkspacePanelTerminal");
  if (typeof create !== "function") throw new Error("Expected createWorkspacePanelTerminal");
  const terminal: unknown = create.call(app, workspace, "local", "core");
  if (!isWorkspacePanelTerminal(terminal)) throw new Error("Expected a workspace panel terminal");
  return terminal;
}

function isWorkspacePanelTerminal(value: unknown): value is WorkspacePanelTerminal {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "open") === "function"
    && typeof Reflect.get(value, "runCommand") === "function";
}

function terminalTabOnInput(app: PiWebUiApp): () => void {
  const resolve: unknown = Reflect.get(app, "resolvedWorkspacePanelTabs");
  if (typeof resolve !== "function") throw new Error("Expected resolvedWorkspacePanelTabs");
  const tabs: unknown = resolve.call(app);
  if (!Array.isArray(tabs)) throw new Error("Expected resolved workspace panel tabs");
  const terminalTab: unknown = tabs.find((tab: unknown) => (
    typeof tab === "object" && tab !== null && Reflect.get(tab, "id") === "core:workspace.terminal"
  ));
  if (typeof terminalTab !== "object" || terminalTab === null) throw new Error("Expected the terminal tab");
  const render: unknown = Reflect.get(terminalTab, "render");
  if (typeof render !== "function") throw new Error("Expected the terminal tab renderer");
  const rendered: unknown = render.call(terminalTab);
  if (!isTemplateResult(rendered)) throw new Error("Terminal tab renderer did not return a template");
  const onInput: unknown = templateValueAfterMarker(rendered, ".onInput=");
  if (!isVoidFunction(onInput)) throw new Error("Expected the terminal panel onInput binding");
  return () => { onInput(); };
}

function isVoidFunction(value: unknown): value is () => void {
  return typeof value === "function";
}

describe("PiWebUiApp.recordProjectWork", () => {
  it("records the selected project", () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project });

    recordProjectWork(app);

    expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
  });

  it("records nothing when no project is selected", () => {
    const app = createApp();
    const recorded = installRecorder(app);

    recordProjectWork(app);

    expect(recorded).toEqual([]);
  });

  it("records a prompt only after SessionController accepts it", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project });
    const acceptance = deferred<boolean>();
    const send = vi.spyOn(sessions(app), "send").mockReturnValue(acceptance.promise);

    invokePrivate(app, "sendPrompt", "summarize the changes");

    expect(recorded).toEqual([]);
    expect(send).toHaveBeenCalledWith("summarize the changes", undefined, undefined, undefined);
    acceptance.resolve(true);
    await vi.waitFor(() => {
      expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
    });
  });

  it("does not record a prompt rejected by SessionController", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project });
    vi.spyOn(sessions(app), "send").mockResolvedValue(false);

    invokePrivate(app, "sendPrompt", "unsent work");
    await Promise.resolve();

    expect(recorded).toEqual([]);
  });

  it("records an awaited prompt against its originating machine and project", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    const acceptance = deferred<boolean>();
    setState(app, { selectedProject: project });
    vi.spyOn(sessions(app), "send").mockReturnValue(acceptance.promise);

    invokePrivate(app, "sendPrompt", "work in alpha");
    setState(app, { selectedMachine: remoteMachine, selectedProject: projectBeta });
    acceptance.resolve(true);

    await vi.waitFor(() => {
      expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
    });
  });

  it("records work when a runtime terminal is opened", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    vi.spyOn(api, "gitStatus").mockResolvedValue(gitStatus);

    await invokePrivate(app, "openRuntimeTerminal", "local", workspace);

    expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
  });

  it("records work once when a plugin terminal is opened", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    vi.spyOn(api, "gitStatus").mockResolvedValue(gitStatus);

    workspacePanelTerminal(app).open({});

    await vi.waitFor(() => {
      expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
    });
  });

  it("records a terminal command only after launch succeeds and keeps its origin", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    const launch = deferred<TerminalCommandRun>();
    vi.spyOn(terminalsApi, "runTerminalCommand").mockReturnValue(launch.promise);

    const handle = workspacePanelTerminal(app).runCommand({ title: "Build", command: "npm test" });

    expect(recorded).toEqual([]);
    setState(app, { selectedMachine: remoteMachine, selectedProject: projectBeta });
    launch.resolve(terminalCommandRun);
    await expect(handle).resolves.toMatchObject({ run: { id: "run-1", status: "succeeded" } });
    expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
  });

  it("does not record a failed terminal command launch", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    vi.spyOn(terminalsApi, "runTerminalCommand").mockRejectedValue(new Error("launch failed"));

    await expect(workspacePanelTerminal(app).runCommand({ title: "Build", command: "npm test" }))
      .rejects.toThrow("launch failed");

    expect(recorded).toEqual([]);
  });

  it("records work when the terminal tab reports input", () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });

    terminalTabOnInput(app)();

    expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
  });

  it("records a successful legacy starter prompt and ignores a failed one", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    Reflect.set(app, "focusChatComposer", () => Promise.resolve());
    Reflect.set(app, "starterModelPolicySelectionSupported", () => false);
    const start = vi.spyOn(sessions(app), "startSessionWithPrompt")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    invokePrivate(app, "handleStartSessionPrompt", "legacy success");
    await vi.waitFor(() => {
      expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
    });
    invokePrivate(app, "handleStartSessionPrompt", "legacy failure");
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(2);
    expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
  });

  it("records a successful Plus starter prompt and ignores a failed one", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    Reflect.set(app, "focusChatComposer", () => Promise.resolve());
    Reflect.set(app, "starterModelPolicySelectionSupported", () => true);
    Reflect.set(app, "starterPlusModelPolicyInitializer", () => plusPolicy);
    const start = vi.spyOn(sessions(app), "startPlusSessionWithPrompt")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    invokePrivate(app, "handleStartSessionPrompt", "plus success");
    await vi.waitFor(() => {
      expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
    });
    invokePrivate(app, "handleStartSessionPrompt", "plus failure");
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(2);
    expect(recorded).toEqual([{ projectId: "p1", machineId: "local" }]);
  });

  it("does not record when a project is selected", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { projects: [project] });
    vi.spyOn(api, "workspaces").mockResolvedValue([]);

    // Drive the app-level navigation selection handler, the same path the
    // session browser binds to project rows. The post-selection focus tail
    // awaits updateComplete and never resolves in this node environment, so
    // wait for the selection to complete and then let the microtask chain
    // settle before asserting nothing was recorded.
    void invokePrivate(
      app,
      "selectNavigationItem",
      "projects",
      "workspaces",
      () => workspaces(app).selectProject(project),
    );
    await vi.waitFor(() => {
      expect(appState(app).selectedProject).toEqual(project);
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(recorded).toEqual([]);
  });
});

function createApp(): PiWebUiApp {
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("document", {
    title: "",
    head: { nodeType: 1, ownerDocument: null, parentNode: null },
  });
  vi.stubGlobal("MutationObserver", vi.fn(FakeMutationObserver));
  vi.stubGlobal("window", {
    location: { search: "", href: "http://localhost/", pathname: "/", hash: "" },
    localStorage: createStorage(),
    history: { pushState: vi.fn(), replaceState: vi.fn() },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  return new PiWebUiApp();
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length(): number { return values.size; },
    clear: () => { values.clear(); },
    getItem: (key: string) => (values.has(key) ? values.get(key) ?? null : null),
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function FakeMutationObserver(this: { observe: ReturnType<typeof vi.fn>; disconnect: () => void }) {
  this.observe = vi.fn();
  this.disconnect = () => undefined;
}
