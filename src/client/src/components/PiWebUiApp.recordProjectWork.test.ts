import { afterEach, describe, expect, it, vi } from "vitest";
import { api, terminalsApi } from "../api";
import type { GitStatusResponse, Project, TerminalCommandRun, Workspace } from "../api";
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

function installRecorder(app: PiWebUiApp): string[] {
  const recorded: string[] = [];
  const controller: unknown = Reflect.get(app, "recentProjects");
  if (typeof controller !== "object" || controller === null) throw new Error("Expected the recentProjects controller");
  Reflect.set(controller, "recordWork", (projectId: string) => { recorded.push(projectId); });
  return recorded;
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

    expect(recorded).toEqual(["p1"]);
  });

  it("records nothing when no project is selected", () => {
    const app = createApp();
    const recorded = installRecorder(app);

    recordProjectWork(app);

    expect(recorded).toEqual([]);
  });

  it("records work when a prompt is submitted", () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project });
    const send = vi.spyOn(sessions(app), "send").mockResolvedValue(undefined);

    invokePrivate(app, "sendPrompt", "summarize the changes");

    expect(recorded).toEqual(["p1"]);
    expect(send).toHaveBeenCalledWith("summarize the changes", undefined, undefined, undefined);
  });

  it("records work when a runtime terminal is opened", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    vi.spyOn(api, "gitStatus").mockResolvedValue(gitStatus);

    await invokePrivate(app, "openRuntimeTerminal", "local", workspace);

    expect(recorded).toEqual(["p1"]);
  });

  it("records work when a plugin terminal is opened", () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    vi.spyOn(api, "gitStatus").mockResolvedValue(gitStatus);

    workspacePanelTerminal(app).open({});

    // The host wrapper records after issuing the open, and the openRuntimeTerminal
    // it delegates to records as well; the controller's newest-entry check makes
    // the repeated call a synchronous no-op.
    expect(recorded).toEqual(["p1", "p1"]);
  });

  it("records work when a plugin runs a terminal command", async () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });
    vi.spyOn(terminalsApi, "runTerminalCommand").mockResolvedValue(terminalCommandRun);

    const handle = workspacePanelTerminal(app).runCommand({ title: "Build", command: "npm test" });

    expect(recorded).toEqual(["p1"]);
    await expect(handle).resolves.toMatchObject({ run: { id: "run-1", status: "succeeded" } });
  });

  it("records work when the terminal tab reports input", () => {
    const app = createApp();
    const recorded = installRecorder(app);
    setState(app, { selectedProject: project, selectedWorkspace: workspace });

    terminalTabOnInput(app)();

    expect(recorded).toEqual(["p1"]);
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
