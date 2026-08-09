import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentProjectsApi } from "./clients";

const entry = { id: "e 1", name: "alpha", path: "/work/alpha", lastUsedAt: "2026-01-01T00:00:00.000Z" };

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

function stubJsonFetch(value: unknown): FetchMock {
  const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse(value)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function fetchCall(fetchMock: FetchMock, index: number): Parameters<FetchLike> {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${String(index)}`);
  return call;
}

function requestedUrl(fetchMock: FetchMock): string {
  return toUrl(fetchCall(fetchMock, 0)[0]).href;
}

function toUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input, "https://pi.example.test");
}

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recentProjectsApi", () => {
  it("lists history for the local machine", async () => {
    const fetchMock = stubJsonFetch([entry]);

    await expect(recentProjectsApi.recentProjects()).resolves.toEqual([entry]);
    expect(requestedUrl(fetchMock)).toContain("api/machines/local/recent-projects");
  });

  it("encodes the project id when recording work on a remote machine", async () => {
    const fetchMock = stubJsonFetch([entry]);

    await recentProjectsApi.recordRecentProject("p 1", "remote a");

    expect(requestedUrl(fetchMock)).toContain("api/machines/remote%20a/projects/p%201/recent");
  });

  it("encodes the entry id when removing history", async () => {
    const fetchMock = stubJsonFetch([]);

    await expect(recentProjectsApi.removeRecentProject("e 1")).resolves.toEqual([]);
    expect(requestedUrl(fetchMock)).toContain("api/machines/local/recent-projects/e%201");
  });

  it("rejects a malformed response", async () => {
    stubJsonFetch([{ id: "e1" }]);

    await expect(recentProjectsApi.recentProjects()).rejects.toThrow();
  });
});
