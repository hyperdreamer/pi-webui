import { describe, expect, it } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";
import { defaultApi, emptyPage, FakeSocket, oldSession, sessionLookupId, status, workspace, type AppState } from "./sessionController.testSupport";

describe("SessionController archive and cleanup", () => {
  it("forgets the selected active session when archiving leaves only archived sessions", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [persistedSession] };
    const urlUpdates: ({ replace?: boolean | undefined } | undefined)[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: () => Promise.resolve({ archived: true }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      (options) => { urlUpdates.push(options); },
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(persistedSession, { updateUrl: false });
    await controller.archiveSession();

    expect(state.selectedSession).toBeUndefined();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ ...oldSession, archived: true });
    expect(typeof state.sessions[0]?.archivedAt).toBe("string");
    expect(controller.preferredSession(workspace.path, state.sessions, undefined)).toBeUndefined();
    expect(urlUpdates).toEqual([undefined]);
  });

  it("archives legacy sessions when persistence support is not advertised", async () => {
    const legacySession = { ...oldSession };
    const archivedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: legacySession, sessions: [legacySession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: (session) => {
        archivedIds.push(sessionLookupId(session));
        return Promise.resolve({ archived: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.archiveSession(legacySession);

    expect(archivedIds).toEqual([legacySession.id]);
    expect(state.sessions[0]).toMatchObject({ id: legacySession.id, archived: true });
  });

  it("archives selected session descendants and selects the next active session", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const childSession = { ...oldSession, id: "child-session", path: "/tmp/child-session.jsonl", parentSessionPath: persistedSession.path, persisted: true };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl", persisted: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [persistedSession, childSession, nextSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      archiveWithDescendants: () => Promise.resolve({ archived: true, sessionIds: [persistedSession.id, childSession.id], archivedCount: 2, skippedAlreadyArchivedCount: 0 }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(persistedSession, { updateUrl: false });
    await controller.archiveSessionWithDescendants(persistedSession);

    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === childSession.id)).toMatchObject({ archived: true });
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("archives selected sessions in bulk", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const secondSession = { ...oldSession, id: "second-session", path: "/tmp/second-session.jsonl", persisted: true };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl", persisted: true };
    const archivedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [persistedSession, secondSession, nextSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: (session) => {
        archivedIds.push(sessionLookupId(session));
        return Promise.resolve({ archived: true });
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(persistedSession, { updateUrl: false });
    await controller.archiveSessions([persistedSession, secondSession]);

    expect(archivedIds).toEqual([oldSession.id, secondSession.id]);
    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === secondSession.id)).toMatchObject({ archived: true });
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("uses true bulk archive when the selected runtime supports it and applies partial failures", async () => {
    const persistedSession = { ...oldSession, persisted: true };
    const failedSession = { ...oldSession, id: "failed-session", path: "/tmp/failed-session.jsonl", persisted: true };
    const archiveCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      sessions: [persistedSession, failedSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEBUI_CAPABILITIES.sessionsBulkMutations] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      archiveMany: (sessions, machineId) => {
        archiveCalls.push({ ids: sessions.map(sessionLookupId), machineId: machineId ?? "local" });
        return Promise.resolve({ archived: true, archivedSessionIds: [persistedSession.id], failures: [{ sessionId: failedSession.id, error: "busy" }], generatedAt: "now" });
      },
      archive: () => { throw new Error("single archive should not be used"); },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.selectSession(persistedSession, { updateUrl: false });
    await controller.archiveSessions([persistedSession, failedSession]);

    expect(archiveCalls).toEqual([{ ids: [oldSession.id, failedSession.id], machineId: "local" }]);
    expect(state.sessions.find((session) => session.id === oldSession.id)).toMatchObject({ archived: true });
    expect(state.sessions.find((session) => session.id === failedSession.id)?.archived).toBeUndefined();
    expect(state.selectedSession?.id).toBe(failedSession.id);
    expect(state.error).toBe("Archive failed for 1 session: failed-session: busy");
  });

  it("throttles per-session archive fallback when bulk mutations are unsupported", async () => {
    const sessions = Array.from({ length: 6 }, (_value, index) => ({ ...oldSession, id: `session-${String(index)}`, path: `/tmp/session-${String(index)}.jsonl`, persisted: true }));
    const resolvers: (() => void)[] = [];
    const startedIds: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions };
    const api: typeof defaultApi = {
      ...defaultApi,
      archive: (session) => new Promise((resolve) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        startedIds.push(sessionLookupId(session));
        resolvers.push(() => {
          activeCount -= 1;
          resolve({ archived: true });
        });
      }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    const archive = controller.archiveSessions(sessions);
    await Promise.resolve();

    expect(startedIds).toHaveLength(4);
    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(startedIds).toHaveLength(5);
    for (const resolve of resolvers.splice(0)) resolve();
    await Promise.resolve();
    await Promise.resolve();
    for (const resolve of resolvers.splice(0)) resolve();
    await archive;

    expect(maxActiveCount).toBe(4);
    expect(state.sessions.every((session) => session.archived === true)).toBe(true);
  });

  it("deletes selected archived sessions in bulk and selects the next current session", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl" };
    const deletedIds: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: archivedSession,
      sessions: [archivedSession, nextSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchived: (session) => {
        deletedIds.push(sessionLookupId(session));
        return Promise.resolve({ deleted: true });
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.deleteArchivedSessions([archivedSession]);

    expect(deletedIds).toEqual([archivedSession.id]);
    expect(state.sessions.map((session) => session.id)).toEqual([nextSession.id]);
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("uses true bulk delete when supported and keeps partial failures visible", async () => {
    const deletedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const failedSession = { ...oldSession, id: "failed-archived", path: "/tmp/failed-archived.jsonl", archived: true, archivedAt: "later" };
    const deleteCalls: { ids: string[]; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: deletedSession,
      sessions: [deletedSession, failedSession],
      machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived, PI_WEBUI_CAPABILITIES.sessionsBulkMutations] } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchivedMany: (sessions, machineId) => {
        deleteCalls.push({ ids: sessions.map(sessionLookupId), machineId: machineId ?? "local" });
        return Promise.resolve({ deleted: true, deletedSessionIds: [deletedSession.id], failures: [{ sessionId: failedSession.id, error: "busy" }], generatedAt: "now" });
      },
      deleteArchived: () => { throw new Error("single delete should not be used"); },
      messages: () => Promise.resolve(emptyPage),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.deleteArchivedSessions([deletedSession, failedSession]);

    expect(deleteCalls).toEqual([{ ids: [deletedSession.id, failedSession.id], machineId: "local" }]);
    expect(state.sessions.map((session) => session.id)).toEqual([failedSession.id]);
    expect(state.selectedSession?.id).toBe(failedSession.id);
    expect(state.error).toBe("Delete failed for 1 session: failed-archived: busy");
  });

  it("applies cleanup execution results and refreshes the current workspace sessions", async () => {
    const archivedAt = "2026-06-25T12:00:00.000Z";
    const deletedArchived = { ...oldSession, id: "deleted-archived", path: "/tmp/deleted-archived.jsonl", archived: true, archivedAt: "2026-05-01T00:00:00.000Z" };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl" };
    const refreshedArchived = { ...oldSession, archived: true, archivedAt };
    const sessionsCalls: { cwd: string; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession, deletedArchived, nextSession],
      sessionStatuses: { [oldSession.id]: status(oldSession.id), [deletedArchived.id]: status(deletedArchived.id), [nextSession.id]: status(nextSession.id) },
      sessionActivities: { [oldSession.id]: { sessionId: oldSession.id, phase: "idle", label: "idle", at: archivedAt } },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: (cwd, machineId) => {
        sessionsCalls.push({ cwd, machineId: machineId ?? "local" });
        return Promise.resolve([refreshedArchived, nextSession]);
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.applySessionCleanupResult({
      generatedAt: archivedAt,
      thresholds: { archiveIdleDays: 30, deleteArchivedDays: 60 },
      projects: [{ cwd: workspace.path, archiveCount: 1, deleteCount: 1 }],
      totals: { archiveCount: 1, deleteCount: 1 },
      archivedSessionIds: [oldSession.id],
      deletedSessionIds: [deletedArchived.id],
    });

    expect(sessionsCalls).toEqual([{ cwd: workspace.path, machineId: "local" }]);
    expect(state.sessions.map((session) => session.id)).toEqual([oldSession.id, nextSession.id]);
    expect(state.sessions[0]).toMatchObject({ id: oldSession.id, archived: true, archivedAt });
    expect(state.selectedSession?.id).toBe(nextSession.id);
    expect(state.sessionStatuses[oldSession.id]).toBeUndefined();
    expect(state.sessionStatuses[deletedArchived.id]).toBeUndefined();
    expect(state.sessionActivities[oldSession.id]).toBeUndefined();
  });

  it("does not delete archived sessions when the selected machine runtime reports no support", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const deletedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [archivedSession], machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [] } } };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchived: (session) => {
        deletedIds.push(sessionLookupId(session));
        return Promise.resolve({ deleted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.deleteArchivedSessions([archivedSession]);

    expect(deletedIds).toEqual([]);
    expect(state.sessions).toEqual([archivedSession]);
    expect(state.error).toContain("requires an updated Pi-Web runtime");
  });

  it("allows legacy archived-session deletion when runtime support is unknown", async () => {
    const archivedSession = { ...oldSession, archived: true, archivedAt: "later" };
    const deletedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: archivedSession, sessions: [archivedSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      deleteArchived: (session) => {
        deletedIds.push(sessionLookupId(session));
        return Promise.resolve({ deleted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.deleteArchivedSessions([archivedSession]);

    expect(deletedIds).toEqual([archivedSession.id]);
    expect(state.sessions).toEqual([]);
    expect(state.error).toBe("");
  });
});
