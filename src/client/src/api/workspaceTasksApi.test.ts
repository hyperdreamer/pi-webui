import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveWorkspaceTaskRequest, WorkspaceTasksFailureResponse } from "../../../shared/apiTypes";
import type { WorkspaceTask, WorkspaceTasksConfig } from "../../../shared/workspaceTasks";
import { workspaceTasksApi } from "./workspaceTasksApi";

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const task: WorkspaceTask = {
  id: "build",
  title: "Build",
  command: "npm run build",
  confirm: false,
};
const config: WorkspaceTasksConfig = { version: 1, tasks: [task] };
const emptyConfig: WorkspaceTasksConfig = { version: 1, tasks: [] };
const operationId = "00000000-0000-4000-8000-000000000001";
const address = {
  machineId: "remote /?",
  projectId: "project /?",
  workspaceId: "workspace /?",
};
const workspaceLoaded = { kind: "loaded" as const, config, revision: "workspace-revision" };
const globalLoaded = { kind: "loaded" as const, config: emptyConfig, revision: "global-revision" };
const moveRequest: MoveWorkspaceTaskRequest = {
  operationId,
  intent: "start",
  source: {
    ref: { scope: "workspace", id: task.id },
    expectedCatalog: { kind: "loaded", config, revision: "workspace-revision" },
  },
  destination: {
    scope: "global",
    expectedCatalog: globalLoaded,
    task,
  },
};
const completedMove = {
  kind: "completed" as const,
  operationId,
  workspace: { kind: "loaded" as const, config: emptyConfig, revision: "workspace-after" },
  global: { kind: "loaded" as const, config, revision: "global-after" },
};
const partialMove = {
  kind: "partial" as const,
  operationId,
  phase: "destination-written" as const,
  workspace: { kind: "loaded" as const, config, revision: "workspace-before" },
  global: { kind: "loaded" as const, config, revision: "global-after" },
};

beforeEach(() => {
  vi.stubEnv("BASE_URL", "./");
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/nested/pi-webui/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("workspaceTasksApi", () => {
  it("uses encoded application-relative paths, exact bodies, and read cancellation for all five routes", async () => {
    const signal = new AbortController().signal;
    const fetchMock = stubSequenceFetch([
      jsonResponse(workspaceLoaded),
      jsonResponse(workspaceLoaded),
      jsonResponse(globalLoaded),
      jsonResponse(globalLoaded),
      jsonResponse(completedMove),
    ]);

    const [workspace, replacedWorkspace, global, replacedGlobal, moved] = await Promise.all([
      workspaceTasksApi.readWorkspace(address, signal),
      workspaceTasksApi.replaceWorkspace({ ...address, expectedRevision: "workspace-revision", config }),
      workspaceTasksApi.readGlobal("local"),
      workspaceTasksApi.replaceGlobal({ machineId: address.machineId, expectedRevision: "global-revision", config }),
      workspaceTasksApi.move({ ...address, ...moveRequest }),
    ]);

    expect(workspace).toEqual({ kind: "success", value: workspaceLoaded });
    expect(replacedWorkspace).toEqual({ kind: "success", value: workspaceLoaded });
    expect(global).toEqual({ kind: "success", value: globalLoaded });
    expect(replacedGlobal).toEqual({ kind: "success", value: globalLoaded });
    expect(moved).toEqual(completedMove);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://pi.example.test/nested/pi-webui/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%2F%3F/workspace-tasks",
      "https://pi.example.test/nested/pi-webui/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%2F%3F/workspace-tasks",
      "https://pi.example.test/nested/pi-webui/api/machines/local/workspace-tasks/global",
      "https://pi.example.test/nested/pi-webui/api/machines/remote%20%2F%3F/workspace-tasks/global",
      "https://pi.example.test/nested/pi-webui/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%2F%3F/workspace-tasks/move",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "PUT", "GET", "PUT", "POST"]);
    expect(fetchCall(fetchMock, 0)[1]?.signal).toBe(signal);
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 1)[1]))).toEqual({ expectedRevision: "workspace-revision", config });
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 3)[1]))).toEqual({ expectedRevision: "global-revision", config });
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 4)[1]))).toEqual(moveRequest);
  });

  it.each([
    [400, { kind: "validation", message: "Invalid request" }],
    [409, { kind: "conflict", reason: "revision-conflict", message: "Catalog changed" }],
    [413, { kind: "validation", message: "Request body too large" }],
    [503, { kind: "unavailable", message: "Busy", retryable: true }],
  ] as const)("parses typed %i replacement failures", async (status, body) => {
    stubSequenceFetch([jsonResponse(body, status)]);

    await expect(workspaceTasksApi.replaceWorkspace({ ...address, expectedRevision: "workspace-revision", config })).resolves.toEqual(body);
  });

  it.each([
    [400, { kind: "validation", message: "Invalid request" }],
    [409, { kind: "conflict", reason: "move-in-progress", message: "Move pending" }],
    [413, { kind: "validation", message: "Request body too large" }],
    [503, { kind: "unavailable", message: "Busy", retryable: true }],
  ] as const)("parses typed %i read failures", async (status, body: WorkspaceTasksFailureResponse) => {
    stubSequenceFetch([jsonResponse(body, status)]);

    await expect(workspaceTasksApi.readWorkspace(address)).resolves.toEqual(body);
  });

  it("parses a typed 500 unknown-outcome response before the write fallback", async () => {
    const typedUnknown = { kind: "unknown-outcome", message: "Server could not confirm the write" };
    stubSequenceFetch([jsonResponse(typedUnknown, 500)]);

    await expect(workspaceTasksApi.replaceGlobal({ machineId: address.machineId, expectedRevision: "global-revision", config })).resolves.toEqual(typedUnknown);
  });

  it.each([
    [200, completedMove],
    [400, { kind: "validation", message: "Invalid move" }],
    [409, partialMove],
    [409, { kind: "conflict", reason: "destination-collision", message: "Task already exists" }],
    [413, { kind: "validation", message: "Request body too large" }],
    [503, { kind: "unavailable", message: "Busy" }],
    [500, { kind: "unknown-outcome", message: "Server could not confirm the move" }],
  ] as const)("strictly parses known %i move response envelopes", async (status, body) => {
    stubSequenceFetch([jsonResponse(body, status)]);

    await expect(workspaceTasksApi.move({ ...address, ...moveRequest })).resolves.toEqual(body);
  });

  it("maps a 404 to scoped unavailability instead of write ambiguity", async () => {
    stubSequenceFetch([
      jsonResponse({ error: "Route unavailable" }, 404),
      jsonResponse({ error: "Route unavailable" }, 404),
      jsonResponse({ error: "Route unavailable" }, 404),
    ]);

    const [read, replace, move] = await Promise.all([
      workspaceTasksApi.readGlobal(address.machineId),
      workspaceTasksApi.replaceGlobal({ machineId: address.machineId, expectedRevision: "global-revision", config }),
      workspaceTasksApi.move({ ...address, ...moveRequest }),
    ]);

    expect(read).toMatchObject({ kind: "unavailable", retryable: false });
    expect(replace).toMatchObject({ kind: "unavailable", retryable: false });
    expect(move).toMatchObject({ kind: "unavailable" });
  });

  it.each([
    ["network failure", () => Promise.reject(new Error("offline"))],
    ["malformed JSON", () => Promise.resolve(new Response("not-json", { status: 200 }))],
    ["502 response", () => Promise.resolve(jsonResponse({ error: "Gateway unavailable" }, 502))],
    ["504 response", () => Promise.resolve(jsonResponse({ error: "Gateway timeout" }, 504))],
    ["unexpected 5xx response", () => Promise.resolve(jsonResponse({ error: "Unexpected failure" }, 501))],
  ] as const)("maps %s reads to unavailable", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => response()));

    await expect(workspaceTasksApi.readWorkspace(address)).resolves.toMatchObject({ kind: "unavailable" });
  });

  it.each([
    ["network failure", () => Promise.reject(new Error("offline"))],
    ["malformed JSON", () => Promise.resolve(new Response("not-json", { status: 200 }))],
    ["502 response", () => Promise.resolve(jsonResponse({ error: "Gateway unavailable" }, 502))],
    ["504 response", () => Promise.resolve(jsonResponse({ error: "Gateway timeout" }, 504))],
    ["unexpected 5xx response", () => Promise.resolve(jsonResponse({ error: "Unexpected failure" }, 501))],
  ] as const)("maps %s replacements and moves to unknown outcomes", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => response()));

    const [replace, move] = await Promise.all([
      workspaceTasksApi.replaceWorkspace({ ...address, expectedRevision: "workspace-revision", config }),
      workspaceTasksApi.move({ ...address, ...moveRequest }),
    ]);

    expect(replace).toMatchObject({ kind: "unknown-outcome" });
    expect(move).toMatchObject({ kind: "unknown-outcome" });
  });

  it("rejects malformed known envelopes into the operation-safe fallback", async () => {
    stubSequenceFetch([
      jsonResponse({ ...workspaceLoaded, unexpected: true }),
      jsonResponse({ kind: "validation", message: "Invalid request", unexpected: true }, 400),
      jsonResponse({ ...partialMove, unexpected: true }, 409),
    ]);

    const [read, replace, move] = await Promise.all([
      workspaceTasksApi.readWorkspace(address),
      workspaceTasksApi.replaceWorkspace({ ...address, expectedRevision: "workspace-revision", config }),
      workspaceTasksApi.move({ ...address, ...moveRequest }),
    ]);

    expect(read).toMatchObject({ kind: "unavailable" });
    expect(replace).toMatchObject({ kind: "unknown-outcome" });
    expect(move).toMatchObject({ kind: "unknown-outcome" });
  });
});

function stubSequenceFetch(responses: Response[]): ReturnType<typeof vi.fn<FetchLike>> {
  const queued = [...responses];
  const fetchMock = vi.fn<FetchLike>(() => {
    const response = queued.shift();
    if (response === undefined) throw new Error("Unexpected fetch request");
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchCall(fetchMock: ReturnType<typeof stubSequenceFetch>, index: number): Parameters<FetchLike> {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${String(index)}`);
  return call;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return init.body;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
