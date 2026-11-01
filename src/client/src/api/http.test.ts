import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appUrl = vi.hoisted(() => ({
  resolve: vi.fn((path: string) => `https://pi.example.test/nested/pi-webui/${path}`),
}));

vi.mock("../appUrl", () => ({ resolveAppUrl: appUrl.resolve }));

import { HttpResponseBodyError, request, requestJson } from "./http";

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  appUrl.resolve.mockClear();
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request errors", () => {
  it("preserves a JSON error message and exposes the response status", async () => {
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.resolve(new Response(
      JSON.stringify({ error: "Recent project is registered" }),
      { status: 409, statusText: "Conflict", headers: { "content-type": "application/json" } },
    ))));

    await expect(request("api/recent-projects/e1", (value) => value))
      .rejects.toMatchObject({ message: "Recent project is registered", status: 409 });
  });

  it("preserves the status-text fallback and exposes the response status", async () => {
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.resolve(new Response(
      "not-json",
      { status: 503, statusText: "Service Unavailable" },
    ))));

    await expect(request("api/recent-projects", (value) => value))
      .rejects.toMatchObject({ message: "Service Unavailable", status: 503 });
  });
});

describe("response phases", () => {
  it("reports response start before reading a delayed first body chunk", async () => {
    const body = deferredResponseBody();
    let readStartedAtCallback: boolean | undefined;
    const onResponse = vi.fn(() => {
      readStartedAtCallback = body.readStarted;
    });
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.resolve(body.response)));

    const pending = request("api/sessions?cwd=%2Frepo", parseRows, {}, onResponse);
    await flushMicrotasks();

    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(readStartedAtCallback).toBe(false);

    body.release();
    await expect(pending).resolves.toEqual([{ id: "s1" }]);
    expect(body.readStarted).toBe(true);
  });

  it("separates successful body transport failure from JSON and schema failure", async () => {
    const transportError = new Error("connection reset");
    stubFetchResponse(erroredBodyResponse(transportError));
    const transportFailure = await request("api/sessions", parseRows, {}, vi.fn())
      .then(() => undefined, (error: unknown) => error);
    expect(transportFailure).toBeInstanceOf(HttpResponseBodyError);
    expect(transportFailure).toMatchObject({ name: "HttpResponseBodyError", message: "Failed to receive response body", status: 200 });
    expect(transportFailure).toHaveProperty("cause", transportError);

    stubFetchResponse(new Response("not-json", { status: 200 }));
    await expect(request("api/sessions", parseRows, {}, vi.fn()))
      .rejects.not.toHaveProperty("name", "HttpResponseBodyError");

    stubFetchResponse(new Response("{}", { status: 200 }));
    await expect(request("api/sessions", parseRows, {}, vi.fn()))
      .rejects.not.toHaveProperty("name", "HttpResponseBodyError");

    const abortError = Object.assign(new Error("Response cancelled"), { name: "AbortError" });
    stubFetchResponse(erroredBodyResponse(abortError));
    await expect(request("api/sessions", parseRows, {}, vi.fn()))
      .rejects.toMatchObject({ name: "AbortError" });

    const controller = new AbortController();
    controller.abort();
    const abortSideError = new Error("stream closed by caller abort");
    stubFetchResponse(erroredBodyResponse(abortSideError));
    await expect(request("api/sessions", parseRows, { signal: controller.signal }, vi.fn()))
      .rejects.toBe(abortSideError);
  });
});

describe("request without phase reporting", () => {
  it("retains its own body handling when the response callback is omitted", async () => {
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.resolve(new Response("not-json", { status: 200 }))));

    await expect(request("api/sessions", parseRows)).rejects.toHaveProperty("name", "SyntaxError");
  });
});

describe("requestJson", () => {
  it("returns a parsed non-2xx JSON response after resolving one application-relative reference", async () => {
    const body = { kind: "conflict", reason: "revision-conflict", message: "Catalog changed" };
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(new Response(
      JSON.stringify(body),
      { status: 409, statusText: "Conflict", headers: { "content-type": "application/json" } },
    )));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestJson("api/machines/remote/workspace-tasks", { method: "PUT", body: "{}" })).resolves.toEqual({
      status: 409,
      body,
    });

    expect(appUrl.resolve).toHaveBeenCalledOnce();
    expect(appUrl.resolve).toHaveBeenCalledWith("api/machines/remote/workspace-tasks");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pi.example.test/nested/pi-webui/api/machines/remote/workspace-tasks",
      expect.objectContaining({ method: "PUT", body: "{}" }),
    );
  });

  it("preserves a non-JSON response status while leaving its body unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.resolve(new Response("not-json", { status: 404 }))));

    await expect(requestJson("api/machines/remote/workspace-tasks")).resolves.toEqual({
      status: 404,
      body: undefined,
    });
  });

  it("rethrows a structurally identified AbortError from response decoding", async () => {
    const abortError = Object.assign(new Error("Response cancelled"), { name: "AbortError" });
    const response = new Response(JSON.stringify({ kind: "conflict" }));
    vi.spyOn(response, "json").mockRejectedValue(abortError);
    vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.resolve(response)));

    await expect(requestJson("api/machines/remote/workspace-tasks")).rejects.toBe(abortError);
  });
});

function parseRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid session rows");
  return value;
}

function stubFetchResponse(response: Response): void {
  vi.stubGlobal("fetch", vi.fn<FetchLike>(() => Promise.resolve(response)));
}

interface DeferredResponseBody {
  readonly response: Response;
  readonly readStarted: boolean;
  release(): void;
}

function deferredResponseBody(): DeferredResponseBody {
  let readStarted = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    pull() {
      readStarted = true;
    },
  }, { highWaterMark: 0 });
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    get readStarted() {
      return readStarted;
    },
    release: () => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify([{ id: "s1" }])));
      controller.close();
    },
  };
}

function erroredBodyResponse(error: unknown): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(error);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
