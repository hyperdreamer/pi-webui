import type { TemplateResult } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectUsageCountResponse, ProjectUsageResponse } from "../../../shared/apiTypes";
import { projectsApi, workspacesApi, type Machine, type Project, type Workspace } from "../api";
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

beforeEach(() => {
  vi.spyOn(workspacesApi, "workspaces").mockResolvedValue([]);
  vi.spyOn(projectsApi, "projectUsageCount").mockResolvedValue({ sessionCount: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp project statistics requests", () => {
  it("uses fresh topology for an uncached project before reporting its live sessions", async () => {
    const app = createApp();
    const liveWorkspace = workspace(projectA, "project-a-main", projectA.path);
    const topologyRequest = vi.mocked(workspacesApi.workspaces).mockResolvedValue([liveWorkspace]);
    const expectedReport = usageReport(projectA, 12);
    const reportRequest = vi.spyOn(projectsApi, "projectUsage").mockImplementation((scope) => {
      return scope.liveCwds.includes(liveWorkspace.path)
        ? Promise.resolve(expectedReport)
        : Promise.reject(new Error("live workspace was omitted"));
    });

    await showProjectStatistics(app, projectA);

    expect(topologyRequest).toHaveBeenCalledWith(projectA.id, "local");
    expect(projectsApi.projectUsageCount).toHaveBeenCalledWith({
      projectPath: projectA.path,
      liveCwds: [liveWorkspace.path],
    }, "local");
    expect(reportRequest).toHaveBeenCalledWith({
      projectPath: projectA.path,
      liveCwds: [liveWorkspace.path],
    }, "local");
    expect(Reflect.get(app, "statisticsReport")).toBe(expectedReport);
  });

  it("refreshes stale cached topology before reporting usage", async () => {
    const app = createApp();
    const staleWorkspace = workspace(projectA, "stale", "/work/project-a-stale");
    const freshWorkspace = workspace(projectA, "fresh", "/work/project-a-fresh");
    const state = appState(app);
    if (!Reflect.set(app, "state", {
      ...state,
      workspacesByProjectId: { [projectA.id]: [staleWorkspace] },
    })) throw new Error("Could not seed stale project topology");
    vi.mocked(workspacesApi.workspaces).mockResolvedValue([freshWorkspace]);
    const reportRequest = vi.spyOn(projectsApi, "projectUsage").mockResolvedValue(usageReport(projectA, 1));

    await showProjectStatistics(app, projectA);

    expect(reportRequest).toHaveBeenCalledWith({
      projectPath: projectA.path,
      liveCwds: [freshWorkspace.path],
    }, "local");
    expect(reportRequest).not.toHaveBeenCalledWith(expect.objectContaining({
      liveCwds: [staleWorkspace.path],
    }), expect.anything());
  });

  it("surfaces a topology failure instead of reporting an empty scope", async () => {
    const app = createApp();
    vi.mocked(workspacesApi.workspaces).mockRejectedValue(new Error("topology failed"));
    const reportRequest = vi.spyOn(projectsApi, "projectUsage").mockResolvedValue(usageReport(projectA, 1));

    await showProjectStatistics(app, projectA);

    expect(projectsApi.projectUsageCount).not.toHaveBeenCalled();
    expect(reportRequest).not.toHaveBeenCalled();
    expect(statisticsState(app)).toEqual({
      project: projectA,
      report: undefined,
      loading: false,
      error: "topology failed",
    });
  });

  it("ignores topology from a superseded statistics request", async () => {
    const app = createApp();
    const staleTopology = deferred<Workspace[]>();
    const currentTopology = deferred<Workspace[]>();
    vi.mocked(workspacesApi.workspaces)
      .mockReturnValueOnce(staleTopology.promise)
      .mockReturnValueOnce(currentTopology.promise);
    const reportRequest = vi.spyOn(projectsApi, "projectUsage").mockImplementation((scope) => {
      return Promise.resolve(scope.projectPath === projectB.path
        ? usageReport(projectB, 2)
        : usageReport(projectA, 1));
    });

    const staleRequest = showProjectStatistics(app, projectA);
    const currentRequest = showProjectStatistics(app, projectB);
    staleTopology.resolve([workspace(projectA, "project-a-main", projectA.path)]);
    await staleRequest;

    expect(reportRequest).not.toHaveBeenCalled();
    expect(statisticsState(app)).toEqual({
      project: projectB,
      report: undefined,
      loading: true,
      error: undefined,
    });

    currentTopology.resolve([workspace(projectB, "project-b-main", projectB.path)]);
    await currentRequest;

    expect(reportRequest).toHaveBeenCalledOnce();
    expect(statisticsState(app)).toEqual({
      project: projectB,
      report: usageReport(projectB, 2),
      loading: false,
      error: undefined,
    });
  });

  it("does not issue usage requests when topology completes after the dialog closes", async () => {
    const app = createApp();
    const topology = deferred<Workspace[]>();
    vi.mocked(workspacesApi.workspaces).mockReturnValue(topology.promise);
    const reportRequest = vi.spyOn(projectsApi, "projectUsage").mockResolvedValue(usageReport(projectA, 1));
    const request = showProjectStatistics(app, projectA);

    closeProjectStatistics(app);
    topology.resolve([workspace(projectA, "project-a-main", projectA.path)]);
    await request;

    expect(projectsApi.projectUsageCount).not.toHaveBeenCalled();
    expect(reportRequest).not.toHaveBeenCalled();
    expect(statisticsState(app)).toEqual({
      project: undefined,
      report: undefined,
      loading: false,
      error: undefined,
    });
  });

  it("renders the enumerated session count while the scan is pending", async () => {
    const app = createApp();
    const count = deferred<ProjectUsageCountResponse>();
    const response = deferred<ProjectUsageResponse>();
    const countRequest = vi.mocked(projectsApi.projectUsageCount).mockReturnValue(count.promise);
    const scanRequest = vi.spyOn(projectsApi, "projectUsage").mockReturnValue(response.promise);

    const request = showProjectStatistics(app, projectA);
    await settleTopology();
    expect(countRequest).toHaveBeenCalledWith({ projectPath: projectA.path, liveCwds: [] }, "local");
    expect(scanRequest).toHaveBeenCalledWith({ projectPath: projectA.path, liveCwds: [] }, "local");

    count.resolve({ sessionCount: 639 });
    await count.promise;
    await Promise.resolve();

    expect(statisticsDialogProperty(app, ".sessionCount=")).toBe(639);
    expect(Reflect.get(app, "statisticsLoading")).toBe(true);

    response.resolve(usageReport(projectA, 1));
    await request;
  });

  it("ignores a superseded count and applies the current count", async () => {
    const app = createApp();
    const staleCount = deferred<ProjectUsageCountResponse>();
    const currentCount = deferred<ProjectUsageCountResponse>();
    const staleResponse = deferred<ProjectUsageResponse>();
    const currentResponse = deferred<ProjectUsageResponse>();
    const countRequest = vi.mocked(projectsApi.projectUsageCount)
      .mockReturnValueOnce(staleCount.promise)
      .mockReturnValueOnce(currentCount.promise);
    vi.spyOn(projectsApi, "projectUsage")
      .mockReturnValueOnce(staleResponse.promise)
      .mockReturnValueOnce(currentResponse.promise);

    const staleRequest = showProjectStatistics(app, projectA);
    await settleTopology();
    const currentRequest = showProjectStatistics(app, projectB);
    await settleTopology();
    expect(countRequest).toHaveBeenCalledTimes(2);

    staleCount.resolve({ sessionCount: 99 });
    await staleCount.promise;
    await Promise.resolve();
    expect(Reflect.get(app, "statisticsSessionCount")).toBeUndefined();

    currentCount.resolve({ sessionCount: 4 });
    await currentCount.promise;
    await Promise.resolve();
    expect(Reflect.get(app, "statisticsSessionCount")).toBe(4);

    staleResponse.resolve(usageReport(projectA, 1));
    currentResponse.resolve(usageReport(projectB, 2));
    await Promise.all([staleRequest, currentRequest]);
  });

  it("does not populate the count after the dialog closes", async () => {
    const app = createApp();
    const count = deferred<ProjectUsageCountResponse>();
    const response = deferred<ProjectUsageResponse>();
    const countRequest = vi.mocked(projectsApi.projectUsageCount).mockReturnValue(count.promise);
    vi.spyOn(projectsApi, "projectUsage").mockReturnValue(response.promise);
    const request = showProjectStatistics(app, projectA);
    await settleTopology();
    expect(countRequest).toHaveBeenCalledOnce();

    closeProjectStatistics(app);
    count.resolve({ sessionCount: 8 });
    await count.promise;
    await Promise.resolve();

    expect(Reflect.get(app, "statisticsSessionCount")).toBeUndefined();
    response.resolve(usageReport(projectA, 1));
    await request;
  });

  it("allows the scan to complete when the count request fails", async () => {
    const app = createApp();
    const report = usageReport(projectA, 7);
    const countRequest = vi.mocked(projectsApi.projectUsageCount).mockRejectedValue(new Error("count failed"));
    vi.spyOn(projectsApi, "projectUsage").mockResolvedValue(report);

    await showProjectStatistics(app, projectA);

    expect(countRequest).toHaveBeenCalledOnce();
    expect(Reflect.get(app, "statisticsReport")).toBe(report);
    expect(Reflect.get(app, "statisticsError")).toBeUndefined();
    expect(statisticsDialogProperty(app, ".report=")).toBe(report);
  });

  it("starts and completes the scan without waiting for a slow count", async () => {
    const app = createApp();
    const count = deferred<ProjectUsageCountResponse>();
    const report = usageReport(projectA, 5);
    const countRequest = vi.mocked(projectsApi.projectUsageCount).mockReturnValue(count.promise);
    const scanRequest = vi.spyOn(projectsApi, "projectUsage").mockResolvedValue(report);

    const request = showProjectStatistics(app, projectA);
    await Promise.resolve();
    await Promise.resolve();
    const countCallsBeforeResolution = countRequest.mock.calls.length;
    const scanCallsBeforeResolution = scanRequest.mock.calls.length;
    const reportBeforeCount: unknown = Reflect.get(app, "statisticsReport");
    count.resolve({ sessionCount: 1 });
    await request;

    expect(countCallsBeforeResolution).toBe(1);
    expect(scanCallsBeforeResolution).toBe(1);
    expect(reportBeforeCount).toBe(report);
  });

  it("ignores a superseded project response and applies the current response", async () => {
    const app = createApp();
    const stale = deferred<ProjectUsageResponse>();
    const current = deferred<ProjectUsageResponse>();
    vi.spyOn(projectsApi, "projectUsage")
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);

    const staleRequest = showProjectStatistics(app, projectA);
    await settleTopology();
    const currentRequest = showProjectStatistics(app, projectB);
    await settleTopology();
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
    const count = deferred<ProjectUsageCountResponse>();
    const response = deferred<ProjectUsageResponse>();
    const countRequest = vi.mocked(projectsApi.projectUsageCount).mockReturnValue(count.promise);
    vi.spyOn(projectsApi, "projectUsage").mockReturnValue(response.promise);
    const request = showProjectStatistics(app, projectA);
    await settleTopology();

    stubMachineChangeSideEffects(app);
    changeMachine(app, remoteMachine);
    changeMachine(app, undefined);
    count.resolve({ sessionCount: 12 });
    response.resolve(usageReport(projectA, 1));
    await count.promise;
    await request;
    await Promise.resolve();

    expect(countRequest).toHaveBeenCalledOnce();
    expect(Reflect.get(app, "statisticsSessionCount")).toBeUndefined();
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
  const callback: unknown = statisticsDialogProperty(app, ".onClose=");
  if (!isCloseProjectStatistics(callback)) throw new Error("Project statistics close callback is not callable");
  callback();
}

function statisticsDialogProperty(app: PiWebUiApp, marker: string): unknown {
  const template = findTemplateContaining(renderApp(app), "<project-statistics-dialog");
  if (template === undefined) throw new Error("PiWebUiApp did not render project-statistics-dialog");
  return templateValueAfterMarker(template, marker);
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

function workspace(project: Project, id: string, path: string): Workspace {
  return {
    id,
    projectId: project.id,
    path,
    label: id,
    isMain: path === project.path,
    isGitRepo: true,
    isGitWorktree: path !== project.path,
  };
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

// Statistics requests now resolve workspace topology before issuing count and report
// requests, so tests that observe those requests must let the topology await settle.
async function settleTopology(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
