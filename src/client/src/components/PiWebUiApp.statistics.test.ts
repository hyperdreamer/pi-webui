import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectUsageResponse } from "../../../shared/apiTypes";
import { projectsApi, type Machine, type Project } from "../api";
import type { AppState } from "../appState";
import { findTemplateContaining, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

const projectA: Project = {
  id: "project-a",
  name: "Project A",
  path: "/work/project-a",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const projectB: Project = {
  id: "project-b",
  name: "Project B",
  path: "/work/project-b",
  createdAt: "2026-08-02T00:00:00.000Z",
};

const remoteMachine: Machine = {
  id: "remote-a",
  name: "Remote A",
  kind: "remote",
  baseUrl: "https://remote.example.test/",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp project statistics requests", () => {
  it("ignores a superseded project response and applies the current response", async () => {
    const app = createApp();
    const stale = deferred<ProjectUsageResponse>();
    const current = deferred<ProjectUsageResponse>();
    vi.spyOn(projectsApi, "projectUsage")
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);

    const staleRequest = showProjectStatistics(app, projectA);
    const currentRequest = showProjectStatistics(app, projectB);
    stale.resolve(usageReport(projectA, 1));
    await staleRequest;

    expect(statisticsState(app)).toEqual({
      project: projectB,
      report: undefined,
      loading: true,
      error: undefined,
    });

    const currentReport = usageReport(projectB, 2);
    current.resolve(currentReport);
    await currentRequest;

    expect(statisticsState(app)).toEqual({
      project: projectB,
      report: currentReport,
      loading: false,
      error: undefined,
    });
  });

  it("ignores an error from a superseded project request", async () => {
    const app = createApp();
    const stale = deferred<ProjectUsageResponse>();
    const current = deferred<ProjectUsageResponse>();
    vi.spyOn(projectsApi, "projectUsage")
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);

    const staleRequest = showProjectStatistics(app, projectA);
    const currentRequest = showProjectStatistics(app, projectB);
    stale.reject(new Error("stale failure"));
    await staleRequest;

    expect(statisticsState(app)).toEqual({
      project: projectB,
      report: undefined,
      loading: true,
      error: undefined,
    });

    current.resolve(usageReport(projectB, 2));
    await currentRequest;
  });

  it("does not repopulate statistics after the dialog closes", async () => {
    const app = createApp();
    const response = deferred<ProjectUsageResponse>();
    vi.spyOn(projectsApi, "projectUsage").mockReturnValue(response.promise);
    const request = showProjectStatistics(app, projectA);

    closeProjectStatistics(app);
    response.resolve(usageReport(projectA, 1));
    await request;

    expect(statisticsState(app)).toEqual({
      project: undefined,
      report: undefined,
      loading: false,
      error: undefined,
    });
  });

  it("invalidates a request when the selected machine changes away and back", async () => {
    const app = createApp();
    const response = deferred<ProjectUsageResponse>();
    vi.spyOn(projectsApi, "projectUsage").mockReturnValue(response.promise);
    const request = showProjectStatistics(app, projectA);

    stubMachineChangeSideEffects(app);
    changeMachine(app, remoteMachine);
    changeMachine(app, undefined);
    response.resolve(usageReport(projectA, 1));
    await request;

    expect(Reflect.get(app, "statisticsReport")).toBeUndefined();
    expect(Reflect.get(app, "statisticsError")).toBeUndefined();
  });
});

type ShowProjectStatistics = (this: PiWebUiApp, project: Project) => Promise<void>;
type RenderApp = (this: PiWebUiApp) => TemplateResult;
type CloseProjectStatistics = () => void;
type HandleMachineChange = (this: PiWebUiApp, previous: AppState, next: AppState) => void;

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", {
    location: { search: "" },
    localStorage: storage,
    innerWidth: 1280,
    clearTimeout: () => undefined,
  });
  const app = new PiWebUiApp();
  if (!Reflect.set(app, "getBoundingClientRect", () => ({ width: 1280 }))) throw new Error("Could not stub PiWebUiApp bounds");
  return app;
}

function showProjectStatistics(app: PiWebUiApp, project: Project): Promise<void> {
  const method: unknown = Reflect.get(app, "showProjectStatistics");
  if (!isShowProjectStatistics(method)) throw new Error("PiWebUiApp.showProjectStatistics is not callable");
  return method.call(app, project);
}

function closeProjectStatistics(app: PiWebUiApp): void {
  const template = findTemplateContaining(renderApp(app), "<project-statistics-dialog");
  if (template === undefined) throw new Error("PiWebUiApp did not render project-statistics-dialog");
  const callback: unknown = templateValueAfterMarker(template, ".onClose=");
  if (!isCloseProjectStatistics(callback)) throw new Error("Project statistics close callback is not callable");
  callback();
}

function renderApp(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "render");
  if (!isRenderApp(method)) throw new Error("PiWebUiApp.render is not callable");
  return method.call(app);
}

function statisticsState(app: PiWebUiApp): { project: unknown; report: unknown; loading: boolean; error: unknown } {
  const loading: unknown = Reflect.get(app, "statisticsLoading");
  if (typeof loading !== "boolean") throw new Error("PiWebUiApp statistics loading state is unavailable");
  return {
    project: Reflect.get(app, "statisticsProject"),
    report: Reflect.get(app, "statisticsReport"),
    loading,
    error: Reflect.get(app, "statisticsError"),
  };
}

function changeMachine(app: PiWebUiApp, selectedMachine: Machine | undefined): void {
  const previous = appState(app);
  const next = { ...previous, selectedMachine };
  if (!Reflect.set(app, "state", next)) throw new Error("Could not set PiWebUiApp state");
  const method: unknown = Reflect.get(app, "handleMachineChange");
  if (!isHandleMachineChange(method)) throw new Error("PiWebUiApp.handleMachineChange is not callable");
  method.call(app, previous, next);
}

function appState(app: PiWebUiApp): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebUiApp state is unavailable");
  return state;
}

function stubMachineChangeSideEffects(app: PiWebUiApp): void {
  if (!Reflect.set(app, "connectRealtime", () => undefined)) throw new Error("Could not stub realtime connection");
  if (!Reflect.set(app, "loadPluginsForSelectedMachine", () => Promise.resolve())) throw new Error("Could not stub plugin loading");
}

function usageReport(project: Project, input: number): ProjectUsageResponse {
  const total = { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessionCount: 1 };
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessionCount: 0 };
  return {
    projectPath: project.path,
    buckets: { live: total, retired: { ...empty }, archived: { ...empty } },
    total,
    generatedAt: "2026-08-05T00:00:00.000Z",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function isShowProjectStatistics(value: unknown): value is ShowProjectStatistics {
  return typeof value === "function";
}

function isRenderApp(value: unknown): value is RenderApp {
  return typeof value === "function";
}

function isCloseProjectStatistics(value: unknown): value is CloseProjectStatistics {
  return typeof value === "function";
}

function isHandleMachineChange(value: unknown): value is HandleMachineChange {
  return typeof value === "function";
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "selectedMachine" in value && "workspacesByProjectId" in value;
}
