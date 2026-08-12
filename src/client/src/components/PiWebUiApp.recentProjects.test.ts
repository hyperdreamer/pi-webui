import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, HttpRequestError, recentProjectsApi } from "../api";
import type { Project, RecentProjectEntry } from "../api";
import type { AppState } from "../appState";
import { ProjectController } from "../controllers/projectController";
import { RecentProjectController } from "../controllers/recentProjectController";
import { isTemplateResult, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";
import type { ResolvedWorkspacePanelTab } from "./WorkspacePanel";

const projectAlpha: Project = {
  id: "project-alpha",
  name: "Alpha",
  path: "/work/alpha",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const closedEntry: RecentProjectEntry = {
  id: "entry-alpha",
  name: "Alpha",
  path: "/work/alpha",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function resolvedTabs(app: PiWebUiApp): ResolvedWorkspacePanelTab[] {
  const resolve: unknown = Reflect.get(app, "resolvedWorkspacePanelTabs");
  if (typeof resolve !== "function") throw new Error("Expected resolvedWorkspacePanelTabs");
  const tabs: unknown = resolve.call(app);
  if (!Array.isArray(tabs) || !tabs.every(isResolvedWorkspacePanelTab)) {
    throw new Error("Expected an array of resolved tabs");
  }
  return tabs;
}

function isResolvedWorkspacePanelTab(value: unknown): value is ResolvedWorkspacePanelTab {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "id") === "string"
    && typeof Reflect.get(value, "title") === "string"
    && typeof Reflect.get(value, "render") === "function";
}

describe("PiWebUiApp recent projects tab", () => {
  it("registers the closed recent-project dialog when the app module loads", () => {
    expect(customElements.get("closed-recent-project-dialog")).toBeDefined();
  });

  it("offers Recent Projects first when no workspace is selected", () => {
    const app = createApp();

    const tabs = resolvedTabs(app);

    expect(tabs[0]?.id).toBe("core:recent-projects");
    expect(tabs[0]?.title).toBe("Recent Projects");
    expect(tabs.every((tab) => tab.id === "core:recent-projects")).toBe(true);
  });

  it("renders the Recent Projects body without a workspace context", () => {
    const app = createApp();

    expect(() => resolvedTabs(app)[0]?.render()).not.toThrow();
  });

  it("offers Recent Projects in the mobile main tabs and selects it without a workspace", () => {
    const app = createApp();

    const tabs = mobileMainTabs(app);
    expect(tabs.find((tab) => tab.id === "core:recent-projects"))
      .toEqual(expect.objectContaining({ id: "core:recent-projects", label: "Recent Projects" }));
    expect(tabs.map((tab) => tab.id)).not.toContain("core:workspace.files");

    invokeSelectMainView(app, "core:recent-projects");

    const state = appState(app);
    expect(state.workspaceTool).toBe("core:recent-projects");
    expect(state.mainView).toBe("core:recent-projects");
  });

  it("keeps the closed entry and surfaces the specific failure when reopening fails", async () => {
    const app = createApp();
    setClosedEntry(app);
    const addProject = vi.spyOn(api, "addProject").mockRejectedValue(new Error("Directory not found"));
    const loadRecentProjects = vi.spyOn(recentProjectsApi, "recentProjects").mockResolvedValue([]);

    const onReopen = dialogReopenHandler(app);
    await expect(onReopen(closedEntry)).rejects.toThrow("Directory not found");

    expect(addProject).toHaveBeenCalledWith("/work/alpha", "Alpha", false, "local");
    expect(Reflect.get(app, "closedRecentProjectEntry")).toBe(closedEntry);
    expect(loadRecentProjects).not.toHaveBeenCalled();
  });

  it("reopens with the saved name, selects the project, and reloads history on success", async () => {
    const app = createApp();
    setClosedEntry(app);
    const addProject = vi.spyOn(api, "addProject").mockResolvedValue(projectAlpha);
    vi.spyOn(api, "workspaces").mockResolvedValue([]);
    vi.spyOn(recentProjectsApi, "recentProjects").mockResolvedValue([closedEntry]);

    const onReopen = dialogReopenHandler(app);
    await onReopen(closedEntry);

    expect(addProject).toHaveBeenCalledWith("/work/alpha", "Alpha", false, "local");
    expect(appState(app).selectedProject).toEqual(projectAlpha);
    await vi.waitFor(() => {
      expect(recentProjectsController(app).state).toEqual({ kind: "ready", entries: [closedEntry] });
    });
  });

  it("refreshes recent history after an ordinary Add Project succeeds", async () => {
    const app = createApp();
    vi.spyOn(api, "addProject").mockResolvedValue(projectAlpha);
    vi.spyOn(api, "workspaces").mockResolvedValue([]);
    const loadRecentProjects = vi.spyOn(recentProjectsApi, "recentProjects").mockResolvedValue([closedEntry]);

    await projectsController(app).addProject("/work/alpha");

    expect(loadRecentProjects).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(recentProjectsController(app).state).toEqual({ kind: "ready", entries: [closedEntry] });
    });
  });

  it("passes a removal failure through without reconciliation or app-level error", async () => {
    const app = createApp();
    setClosedEntry(app);
    const failure = new HttpRequestError("Recent project is registered", 409);
    vi.spyOn(recentProjectsApi, "removeRecentProject").mockRejectedValue(failure);
    vi.spyOn(recentProjectsApi, "recentProjects").mockResolvedValue([closedEntry]);
    const loadProjects = vi.spyOn(api, "projects").mockResolvedValue([projectAlpha]);
    await recentProjectsController(app).load();

    const onRemove = dialogRemoveHandler(app);
    await expect(onRemove(closedEntry)).rejects.toBe(failure);

    expect(loadProjects).not.toHaveBeenCalled();
    expect(appState(app).error).toBe("");
  });
});

function setClosedEntry(app: PiWebUiApp): void {
  const open: unknown = Reflect.get(app, "openClosedRecentProject");
  if (typeof open !== "function") throw new Error("Could not open closed entry");
  open.call(app, closedEntry, () => undefined);
}

function dialogReopenHandler(app: PiWebUiApp): (entry: RecentProjectEntry) => Promise<void> {
  const rendered = renderClosedRecentProjectDialog(app);
  const handler: unknown = templateValueAfterMarker(rendered, ".onReopen=");
  if (!isReopenHandler(handler)) throw new Error("Expected onReopen handler");
  return handler;
}

function dialogRemoveHandler(app: PiWebUiApp): (entry: RecentProjectEntry) => Promise<void> {
  const rendered = renderClosedRecentProjectDialog(app);
  const handler: unknown = templateValueAfterMarker(rendered, ".onRemove=");
  if (!isReopenHandler(handler)) throw new Error("Expected onRemove handler");
  return handler;
}

function isReopenHandler(value: unknown): value is (entry: RecentProjectEntry) => Promise<void> {
  return typeof value === "function";
}

function renderClosedRecentProjectDialog(app: PiWebUiApp): TemplateResult {
  const render: unknown = Reflect.get(app, "renderClosedRecentProjectDialog");
  if (typeof render !== "function") throw new Error("Closed recent project dialog renderer was unavailable");
  const result: unknown = render.call(app);
  if (!isTemplateResult(result)) throw new Error("Closed recent project dialog renderer did not return a template");
  return result;
}

function mobileMainTabs(app: PiWebUiApp): { id: string; label: string }[] {
  const render: unknown = Reflect.get(app, "mobileMainTabs");
  if (typeof render !== "function") throw new Error("Mobile main tab renderer was unavailable");
  const result: unknown = render.call(app);
  if (!Array.isArray(result) || !result.every(isMobileMainTab)) throw new Error("Mobile main tab renderer returned an invalid result");
  return result;
}

function isMobileMainTab(value: unknown): value is { id: string; label: string } {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "id") === "string"
    && typeof Reflect.get(value, "label") === "string";
}

function invokeSelectMainView(app: PiWebUiApp, view: string): void {
  const method: unknown = Reflect.get(app, "selectMainView");
  if (typeof method !== "function") throw new Error("PiWebUiApp.selectMainView was not callable");
  method.call(app, view);
}

function appState(app: PiWebUiApp): AppState {
  const value: unknown = Reflect.get(app, "state");
  if (!isAppState(value)) throw new Error("PiWebUiApp state is unavailable");
  return value;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "workspaceTool") === "string"
    && typeof Reflect.get(value, "mainView") === "string";
}

function projectsController(app: PiWebUiApp): ProjectController {
  const controller: unknown = Reflect.get(app, "projects");
  if (!(controller instanceof ProjectController)) throw new Error("PiWebUiApp projects controller is unavailable");
  return controller;
}

function recentProjectsController(app: PiWebUiApp): RecentProjectController {
  const controller: unknown = Reflect.get(app, "recentProjects");
  if (!(controller instanceof RecentProjectController)) throw new Error("PiWebUiApp recent projects controller is unavailable");
  return controller;
}

function FakeMutationObserver(this: { observe: ReturnType<typeof vi.fn>; disconnect: () => void }) {
  this.observe = vi.fn();
  this.disconnect = () => undefined;
}

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
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}
