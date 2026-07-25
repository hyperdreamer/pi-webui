import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const SESSION_ID = "message-actions-session";

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant", content: string) {
  return { type: "message", id, parentId, timestamp: "2026-08-01T00:00:00.000Z", message: { role, content } };
}

describe("PiSessionService per-message actions", () => {
  it("projects fork and edit identifiers with user history messages", async () => {
    const entries = [
      messageEntry("user-1", null, "user", "Start here"),
      messageEntry("assistant-1", "user-1", "assistant", "First answer"),
      messageEntry("user-2", "assistant-1", "user", "Revise this"),
    ];
    const manager = fakeSessionManager("/workspace", {
      getSessionId: () => SESSION_ID,
      getBranch: () => entries,
    });
    const fake = fakeRuntime(SESSION_ID, { sessionManager: manager });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-webui-test-agent",
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.messages(sessionRef(SESSION_ID), { limit: 20 })).resolves.toEqual({
      messages: [
        { role: "user", content: "Start here", entryId: "user-1" },
        { role: "assistant", content: "First answer" },
        {
          role: "user",
          content: "Revise this",
          entryId: "user-2",
          previousAssistantEntryId: "assistant-1",
          canFork: true,
        },
      ],
      start: 0,
      total: 3,
    });

    await service.dispose();
  });

  it("navigates to the preceding assistant without generating a branch summary", async () => {
    const navigateTree = vi.fn(() => Promise.resolve({ cancelled: false }));
    const manager = fakeSessionManager("/workspace", { getSessionId: () => SESSION_ID });
    const fake = fakeRuntime(SESSION_ID, { sessionManager: manager, navigateTree });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-webui-test-agent",
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.editFromHere(sessionRef(SESSION_ID), "assistant-1")).resolves.toEqual({ cancelled: false });
    expect(navigateTree).toHaveBeenCalledExactlyOnceWith("assistant-1", { summarize: false });

    await service.dispose();
  });

  it("forks an independent session from the selected user entry", async () => {
    const manager = fakeSessionManager("/workspace", { getSessionId: () => SESSION_ID });
    const fake = fakeRuntime(SESSION_ID, { sessionManager: manager });
    const forked = fakeRuntime("forked-session", {
      sessionManager: fakeSessionManager("/workspace", { getSessionId: () => "forked-session" }),
    });
    let rebindSession: ((session: typeof forked.session) => Promise<void>) | undefined;
    fake.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const fork = vi.fn(async () => {
      if (!Reflect.set(fake.runtime, "session", forked.session)) throw new Error("Could not rebind the forked runtime");
      await rebindSession?.(forked.session);
      return { cancelled: false };
    });
    fake.runtime.fork = fork;
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: "/tmp/pi-webui-test-agent",
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.forkFromHere(sessionRef(SESSION_ID), "user-2")).resolves.toMatchObject({
      cancelled: false,
      session: { id: "forked-session", path: "/tmp/forked-session.jsonl", cwd: "/workspace" },
    });
    expect(fork).toHaveBeenCalledExactlyOnceWith("user-2");
    const created = hub.globalEvents.find((event) => event.type === "session.created");
    if (created?.type !== "session.created") throw new Error("Expected a session-created event");
    expect(created.session.id).toBe("forked-session");

    await service.dispose();
  });
});
