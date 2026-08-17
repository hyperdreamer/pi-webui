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
const validationFailure = { kind: "validation" as const, message: "Invalid request" };
const conflictFailure = { kind: "conflict" as const, reason: "revision-conflict" as const, message: "Catalog changed" };
const unavailableFailure = { kind: "unavailable" as const, message: "Busy", retryable: false };
const unknownOutcomeFailure = { kind: "unknown-outcome" as const, message: "Server could not confirm the write" };
const moveConflict = { kind: "conflict" as const, reason: "destination-collision" as const, message: "Task already exists" };
const moveUnavailable = { kind: "unavailable" as const, message: "Busy" };
const readStatusMismatchFallback = {
  kind: "unavailable" as const,
  message: "Workspace Tasks could not be loaded. Refresh and try again.",
  retryable: true,
};
const writeStatusMismatchFallback = {
  kind: "unknown-outcome" as const,
  message: "Workspace task write outcome is unknown. Refresh before trying again.",
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

  it("propagates in-flight read cancellation after passing the signal to fetch", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("Read cancelled"), { name: "AbortError" });
    const fetchMock = vi.fn<FetchLike>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(abortError); }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pendingRead = workspaceTasksApi.readWorkspace(address, controller.signal);
    expect(fetchCall(fetchMock, 0)[1]?.signal).toBe(controller.signal);

    controller.abort();

    await expect(pendingRead).rejects.toBe(abortError);
  });

  it("propagates an AbortError from a read without a caller signal", async () => {
    const abortError = Object.assign(new Error("Read cancelled"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.reject(abortError)));

    await expect(workspaceTasksApi.readGlobal(address.machineId)).rejects.toBe(abortError);
  });

  it("propagates an AbortError while decoding a read response", async () => {
    const abortError = Object.assign(new Error("Read cancelled"), { name: "AbortError" });
    const response = new Response(JSON.stringify(globalLoaded));
    vi.spyOn(response, "json").mockRejectedValue(abortError);
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.resolve(response)));

    await expect(workspaceTasksApi.readGlobal(address.machineId)).rejects.toBe(abortError);
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

  it.each([
    [400, "conflict", conflictFailure],
    [400, "unavailable", unavailableFailure],
    [400, "unknown-outcome", unknownOutcomeFailure],
    [409, "validation", validationFailure],
    [409, "unavailable", unavailableFailure],
    [409, "unknown-outcome", unknownOutcomeFailure],
    [413, "conflict", conflictFailure],
    [413, "unavailable", unavailableFailure],
    [413, "unknown-outcome", unknownOutcomeFailure],
    [500, "validation", validationFailure],
    [500, "conflict", conflictFailure],
    [500, "unavailable", unavailableFailure],
    [503, "validation", validationFailure],
    [503, "conflict", conflictFailure],
    [503, "unknown-outcome", unknownOutcomeFailure],
  ] as const)("maps a regular %i response with a syntactically valid %s body to operation-safe fallbacks", async (status, _kind, body) => {
    stubSequenceFetch([jsonResponse(body, status), jsonResponse(body, status)]);

    const [read, replace] = await Promise.all([
      workspaceTasksApi.readWorkspace(address),
      workspaceTasksApi.replaceWorkspace({ ...address, expectedRevision: "workspace-revision", config }),
    ]);

    expect(read).toEqual(readStatusMismatchFallback);
    expect(replace).toEqual(writeStatusMismatchFallback);
  });

  it.each([
    [200, "partial", partialMove],
    [200, "conflict", moveConflict],
    [200, "validation", validationFailure],
    [200, "unavailable", moveUnavailable],
    [200, "unknown-outcome", unknownOutcomeFailure],
    [400, "completed", completedMove],
    [400, "partial", partialMove],
    [400, "conflict", moveConflict],
    [400, "unavailable", moveUnavailable],
    [400, "unknown-outcome", unknownOutcomeFailure],
    [409, "completed", completedMove],
    [409, "validation", validationFailure],
    [409, "unavailable", moveUnavailable],
    [409, "unknown-outcome", unknownOutcomeFailure],
    [413, "completed", completedMove],
    [413, "partial", partialMove],
    [413, "conflict", moveConflict],
    [413, "unavailable", moveUnavailable],
    [413, "unknown-outcome", unknownOutcomeFailure],
    [500, "completed", completedMove],
    [500, "partial", partialMove],
    [500, "conflict", moveConflict],
    [500, "validation", validationFailure],
    [500, "unavailable", moveUnavailable],
    [503, "completed", completedMove],
    [503, "partial", partialMove],
    [503, "conflict", moveConflict],
    [503, "validation", validationFailure],
    [503, "unknown-outcome", unknownOutcomeFailure],
  ] as const)("maps a move %i response with a syntactically valid %s body to unknown outcome", async (status, _kind, body) => {
    stubSequenceFetch([jsonResponse(body, status)]);

    await expect(workspaceTasksApi.move({ ...address, ...moveRequest })).resolves.toEqual(writeStatusMismatchFallback);
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
    ["non-JSON", () => new Response("not-json", { status: 404 })],
    ["empty", () => new Response(null, { status: 404 })],
  ] as const)("maps a %s 404 to scoped unavailability for reads, replacements, and moves", async (_label, response) => {
    stubSequenceFetch([response(), response(), response()]);

    const [read, replace, move] = await Promise.all([
      workspaceTasksApi.readGlobal(address.machineId),
      workspaceTasksApi.replaceGlobal({ machineId: address.machineId, expectedRevision: "global-revision", config }),
      workspaceTasksApi.move({ ...address, ...moveRequest }),
    ]);

    expect(read).toEqual({
      kind: "unavailable",
      message: "Workspace Tasks are unavailable on the selected machine.",
      retryable: false,
    });
    expect(replace).toEqual({
      kind: "unavailable",
      message: "Workspace Tasks are unavailable on the selected machine.",
      retryable: false,
    });
    expect(move).toEqual({
      kind: "unavailable",
      message: "Workspace Tasks are unavailable on the selected machine.",
    });
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
