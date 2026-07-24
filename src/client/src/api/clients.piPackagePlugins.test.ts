import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piPackagePluginsApi } from "./clients";

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pi package Plugins API", () => {
  it("uses encoded machine and workspace paths for reads and mutations", async () => {
    const response = { packages: [], totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 }, diagnostics: [] };
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse(response)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(piPackagePluginsApi.list("/repo with spaces", "remote /?")).resolves.toEqual(response);
    await expect(piPackagePluginsApi.mutate({
      action: "install",
      source: "npm:@acme/tools",
      scope: "project",
      cwd: "/repo with spaces",
    }, "remote /?")).resolves.toEqual(response);

    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20%2F%3F/package-plugins?cwd=%2Frepo+with+spaces");
    expect(fetchCall(fetchMock, 1)[0]).toBe("https://pi.example.test/api/machines/remote%20%2F%3F/package-plugins");
    expect(fetchCall(fetchMock, 1)[1]?.method).toBe("POST");
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 1)[1]))).toEqual({
      action: "install",
      source: "npm:@acme/tools",
      scope: "project",
      cwd: "/repo with spaces",
    });
  });
});

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function fetchCall(fetchMock: FetchMock, index: number): Parameters<FetchLike> {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${String(index)}`);
  return call;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("Expected string request body");
  return init.body;
}
