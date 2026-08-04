import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { forgetCachedNewSession, isCachedNewSessionInfo, loadCachedNewSessions, markCachedNewSessionInfo, mergeCachedNewSessions, rememberCachedNewSession, stripCachedNewSessionMarker } from "./cachedNewSessions";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const baseSession: SessionInfo = {
  id: "session-1",
  path: "/tmp/session-1.jsonl",
  cwd: "/repo",
  created: "2026-05-15T00:00:00.000Z",
  modified: "2026-05-15T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
  creationSource: "session-list-plus",
};

describe("cached new sessions", () => {
  it("stores and reloads new sessions with a browser-cache marker", () => {
    const storage = new MemoryStorage();

    rememberCachedNewSession(baseSession, "local", storage);

    const cached = loadCachedNewSessions(storage);
    expect(cached).toHaveLength(1);
    expect(cached[0]?.id).toBe("session-1");
    expect(cached[0]?.creationSource).toBe("session-list-plus");
    expect(isCachedNewSessionInfo(cached[0])).toBe(true);
  });

  it("preserves creation source when stripping the browser-cache marker", () => {
    expect(stripCachedNewSessionMarker(markCachedNewSessionInfo(baseSession))).toMatchObject({
      id: "session-1",
      creationSource: "session-list-plus",
    });
  });

  it("merges cached sessions for the selected cwd without duplicating server sessions", () => {
    const storage = new MemoryStorage();
    rememberCachedNewSession(baseSession, "local", storage);
    rememberCachedNewSession({ ...baseSession, id: "other", cwd: "/other" }, "local", storage);

    const cachedOnly = mergeCachedNewSessions("/repo", [], "local", storage);
    const mergedWithServerSession = mergeCachedNewSessions("/repo", [baseSession], "local", storage);

    expect(cachedOnly.map((session) => session.id)).toEqual(["session-1"]);
    expect(mergedWithServerSession.map((session) => session.id)).toEqual(["session-1"]);
    expect(isCachedNewSessionInfo(mergedWithServerSession[0])).toBe(false);
    expect(mergedWithServerSession[0]?.creationSource).toBe("session-list-plus");
    expect(loadCachedNewSessions(storage).map((session) => session.id)).toEqual(["other"]);
  });

  it("does not load an unknown cached creation source", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-webui:cached-new-sessions:v1", JSON.stringify([
      { ...baseSession, creationSource: "unknown" },
    ]));

    const [cached] = loadCachedNewSessions(storage);
    expect(cached).toBeDefined();
    expect(cached).not.toHaveProperty("creationSource");
  });

  it("forgets cached sessions", () => {
    const storage = new MemoryStorage();
    rememberCachedNewSession(baseSession, "local", storage);

    forgetCachedNewSession("session-1", "local", storage);

    expect(loadCachedNewSessions(storage)).toEqual([]);
  });

  it("keeps browser-cached sessions scoped by machine", () => {
    const storage = new MemoryStorage();
    rememberCachedNewSession(baseSession, "local", storage);
    rememberCachedNewSession({ ...baseSession, id: "session-2" }, "remote", storage);

    expect(mergeCachedNewSessions("/repo", [], "local", storage).map((session) => session.id)).toEqual(["session-1"]);
    expect(mergeCachedNewSessions("/repo", [], "remote", storage).map((session) => session.id)).toEqual(["session-2"]);
  });
});
