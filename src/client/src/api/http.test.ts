import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appUrl = vi.hoisted(() => ({
  resolve: vi.fn((path: string) => `https://pi.example.test/nested/pi-webui/${path}`),
}));

vi.mock("../appUrl", () => ({ resolveAppUrl: appUrl.resolve }));

import { request, requestJson } from "./http";

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
});
