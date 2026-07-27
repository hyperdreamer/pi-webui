import { describe, expect, it, vi } from "vitest";
import { fetchGlobalMemories, fetchProjectMemories } from "./memoryClient.js";
import type { MemoryEntry } from "./memoryData.js";

function stubFetch(json: unknown, ok = true, status = 200): ReturnType<typeof vi.fn<typeof fetch>> {
  const mockResponse: unknown = {
    ok,
    status,
    json: () => Promise.resolve(json),
    headers: new Headers(),
    redirected: false,
    type: "basic" as const,
    url: "",
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Response is a browser API not fully constructable in test
  return vi.fn<typeof fetch>().mockResolvedValue(mockResponse as Response);
}

describe("memory client", () => {
  it("fetches global memories using an application-relative URL", async () => {
    const entries: MemoryEntry[] = [{ id: "1", content: "global" }];
    const mock = stubFetch({ entries });
    vi.stubGlobal("fetch", mock);

    const result = await fetchGlobalMemories();

    expect(result).toEqual(entries);
    expect(mock).toHaveBeenCalledWith("api/agent-memory/global");
  });

  it("fetches project memories with encoded project path", async () => {
    const entries: MemoryEntry[] = [{ id: "2", content: "project scoped" }];
    const mock = stubFetch({ entries });
    vi.stubGlobal("fetch", mock);

    const result = await fetchProjectMemories("/home/user/my project");

    expect(result).toEqual(entries);
    const calledUrl = mock.mock.calls[0]?.[0];
    expect(typeof calledUrl).toBe("string");
    expect(calledUrl).toContain("api/agent-memory/project?");
    expect(calledUrl).toContain("projectPath=");
    expect(calledUrl).toContain("projectPath=%2Fhome%2Fuser%2Fmy+project");
  });

  it("throws on non-ok response from global endpoint", async () => {
    vi.stubGlobal("fetch", stubFetch({}, false, 503));

    await expect(fetchGlobalMemories()).rejects.toThrow("Failed to load global memories: 503");
  });

  it("throws on non-ok response from project endpoint", async () => {
    vi.stubGlobal("fetch", stubFetch({}, false, 500));

    await expect(fetchProjectMemories("/x")).rejects.toThrow("Failed to load project memories: 500");
  });

  it("does not use absolute /api URLs", async () => {
    const mock = stubFetch({ entries: [] });
    vi.stubGlobal("fetch", mock);

    await fetchGlobalMemories();

    for (const call of mock.mock.calls) {
      const url = call[0];
      expect(typeof url).toBe("string");
      expect(url).not.toMatch(/^\/api\//);
    }
  });

  it("validates response shape and skips invalid entries", async () => {
    vi.stubGlobal("fetch", stubFetch({ entries: [{ id: "ok", content: "valid" }, { bogus: true }, null] }));

    const result = await fetchGlobalMemories();

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ok");
  });
});
