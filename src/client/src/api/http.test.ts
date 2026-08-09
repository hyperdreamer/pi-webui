import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "./http";

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
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
