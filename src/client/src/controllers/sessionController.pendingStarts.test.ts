import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { isCachedNewSessionInfo, loadCachedNewSessions } from "../cachedNewSessions";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, fullStarterModelPolicyPreference, MemoryStorage, oldSession, replacementSession, sessionKey, sessionLookupId, status, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

describe("SessionController pending starts", () => {
  it("creates and selects a temporary editable session before backend start resolves", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const messageRequest = deferred<typeof emptyPage>();
    const messageCalls: string[] = [];
    const statusCalls: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: (session) => { messageCalls.push(sessionLookupId(session)); return messageRequest.promise; },
      status: (session) => { statusCalls.push(sessionLookupId(session)); return Promise.resolve(status(sessionLookupId(session))); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporarySession = state.selectedSession;

    expect(temporarySession?.id).toMatch(/^pending-session-/);
    expect(temporarySession?.persisted).toBe(false);
    expect(state.sessions.map((session) => session.id)).toEqual([temporarySession?.id]);
    expect(state.activity).toMatchObject({ sessionId: temporarySession?.id, phase: "active", label: "Creating session" });
    expect(messageCalls).toEqual([]);
    expect(statusCalls).toEqual([]);

    let completed: boolean | undefined;
    void start.then((result) => { completed = result; });
    startRequest.resolve(started);
    await Promise.resolve();
    await Promise.resolve();

    expect(messageCalls).toEqual(["started-session"]);
    expect(completed).toBeUndefined();

    messageRequest.resolve(emptyPage);
    expect(await start).toBe(true);

    expect(state.sessions.map((session) => session.id)).toEqual(["started-session"]);
    expect(state.selectedSession?.id).toBe("started-session");
    expect(messageCalls).toEqual(["started-session"]);
    expect(statusCalls).toEqual(["started-session"]);
  });

  it("does not duplicate a started session when its session.created broadcast races the HTTP response", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const socket = new FakeSocket();
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => {
        // Simulate the broadcast arriving before the HTTP response resolves.
        controller.applyGlobalEvent({ type: "session.created", session: started });
        return startRequest.promise;
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;

    expect(state.sessions.map((session) => session.id)).toEqual([temporaryId]);

    startRequest.resolve(started);
    await start;

    expect(state.sessions.map((session) => session.id)).toEqual(["started-session"]);
    expect(isCachedNewSessionInfo(state.sessions[0])).toBe(true);
  });

  it("releases unrelated created-session broadcasts after pending starts settle", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const otherClientSession: SessionInfo = { ...oldSession, id: "other-client-session", path: "/tmp/other-client-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    controller.applyGlobalEvent({ type: "session.created", session: started });
    controller.applyGlobalEvent({ type: "session.created", session: otherClientSession });

    expect(state.sessions.map((session) => session.id)).toEqual([temporaryId]);

    startRequest.resolve(started);
    await start;

    const sessionIds = state.sessions.map((session) => session.id);
    expect(sessionIds).not.toContain(temporaryId);
    expect(sessionIds.filter((id) => id === started.id)).toHaveLength(1);
    expect(sessionIds.filter((id) => id === otherClientSession.id)).toHaveLength(1);
  });

  it("preserves temporary start rows across session-list refreshes before backend resolution", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      sessions: () => Promise.resolve([oldSession]),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    await controller.refreshCurrentWorkspaceSessions();

    expect(state.sessions.map((session) => session.id)).toEqual([temporaryId, oldSession.id]);
    expect(state.selectedSession?.id).toBe(temporaryId);

    startRequest.resolve(started);
    await start;

    expect(state.sessions.map((session) => session.id)).toEqual([started.id, oldSession.id]);
    expect(state.selectedSession?.id).toBe(started.id);
  });

  it("tracks multiple pending session starts without blocking another start", async () => {
    const firstStarted: SessionInfo = { ...oldSession, id: "started-session-1", path: "/tmp/started-session-1.jsonl" };
    const secondStarted: SessionInfo = { ...oldSession, id: "started-session-2", path: "/tmp/started-session-2.jsonl" };
    const startResolvers: ((session: SessionInfo) => void)[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => new Promise<SessionInfo>((resolve) => { startResolvers.push(resolve); }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const firstStart = controller.startSession();
    const firstTemporaryId = state.selectedSession?.id;
    const secondStart = controller.startSession();
    const secondTemporaryId = state.selectedSession?.id;

    expect(startResolvers).toHaveLength(2);
    expect(state.startingSessionCount).toBe(0);
    expect(state.sessions.map((session) => session.id)).toEqual([secondTemporaryId, firstTemporaryId]);
    expect(state.selectedSession?.id).toBe(secondTemporaryId);
    expect(state.sessions.every((session) => session.persisted === false)).toBe(true);

    startResolvers[0]?.(firstStarted);
    await firstStart;

    expect(state.sessions.map((session) => session.id)).toEqual([secondTemporaryId, "started-session-1"]);
    expect(state.selectedSession?.id).toBe(secondTemporaryId);

    startResolvers[1]?.(secondStarted);
    await secondStart;

    expect(state.startingSessionCount).toBe(0);
    expect(state.sessions.map((session) => session.id)).toEqual(["started-session-2", "started-session-1"]);
    expect(state.selectedSession?.id).toBe("started-session-2");
  });

  it("moves a temporary session draft and cached-new marker to the resolved session", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    saveDraft(sessionKey(temporaryId), "draft text");

    startRequest.resolve(started);
    await start;

    expect(loadDraft(sessionKey(temporaryId))).toBe("");
    expect(loadDraft(sessionKey(started.id))).toBe("draft text");
    expect(loadCachedNewSessions().map((session) => session.id)).toEqual([started.id]);
    expect(isCachedNewSessionInfo(state.sessions[0])).toBe(true);
  });

  it("returns false without side effects when no workspace is selected", async () => {
    let startCalls = 0;
    let state: AppState = { ...initialAppState(), sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => {
        startCalls += 1;
        return Promise.resolve(oldSession);
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.startSession()).resolves.toBe(false);

    expect(startCalls).toBe(0);
    expect(state.sessions).toEqual([]);
    expect(state.selectedSession).toBeUndefined();
  });

  it("keeps a failed temporary start selected with a discardable transient row and returns false", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => Promise.reject(new Error("backend unavailable")),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.startSession()).resolves.toBe(false);
    const temporaryId = state.selectedSession?.id;

    expect(temporaryId).toMatch(/^pending-session-/);
    expect(state.sessions.map((session) => session.id)).toEqual([temporaryId]);
    expect(state.sessions[0]?.persisted).toBe(false);
    expect(state.activity).toMatchObject({ sessionId: temporaryId, phase: "error", label: "Session creation failed" });
    expect(state.error).toContain("backend unavailable");

    await controller.deleteCachedNewSession(state.sessions[0]);

    expect(state.sessions).toEqual([]);
    expect(state.selectedSession).toBeUndefined();
  });

  it("stops the backend session if a discarded pending start resolves later", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const stoppedIds: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      stop: (session) => { stoppedIds.push(sessionLookupId(session)); return Promise.resolve({ stopped: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    await controller.send("queued before discard");
    expect(state.clientQueuedSessionMessages[temporaryId]).toEqual([{ kind: "followUp", text: "queued before discard" }]);

    await controller.deleteCachedNewSession(state.selectedSession);
    expect(state.sessions).toEqual([]);
    expect(state.selectedSession).toBeUndefined();
    expect(state.clientQueuedSessionMessages[temporaryId]).toBeUndefined();

    startRequest.resolve(started);
    await start;

    expect(stoppedIds).toEqual([started.id]);
    expect(state.sessions).toEqual([]);
    expect(state.selectedSession).toBeUndefined();
  });

  it("confirms a plus start from its cloned initializer after the sourced session resolves", async () => {
    const started: SessionInfo = { ...replacementSession, creationSource: "session-list-plus" };
    const startRequest = deferred<SessionInfo>();
    const startPlusSession = vi.fn<typeof defaultApi.startPlusSession>(() => startRequest.promise);
    const onStarterModelPolicyConfirmed = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicyConfirmed"]>>();
    const harness = pendingStartHarness({ startPlusSession }, onStarterModelPolicyConfirmed);
    const initialModelPolicy = {
      ...fullStarterModelPolicyPreference,
      exact: {
        ...fullStarterModelPolicyPreference.exact,
        model: { ...fullStarterModelPolicyPreference.exact.model },
      },
    };

    const start = harness.controller.startPlusSession(initialModelPolicy);
    const temporarySession = harness.state().selectedSession;
    const requestedPolicy = startPlusSession.mock.calls[0]?.[1];

    expect(temporarySession?.creationSource).toBe("session-list-plus");
    expect(startPlusSession).toHaveBeenCalledWith("/repo", fullStarterModelPolicyPreference, "local");
    expect(requestedPolicy).not.toBe(initialModelPolicy);
    expect(requestedPolicy?.exact).not.toBe(initialModelPolicy.exact);
    expect(requestedPolicy?.exact.model).not.toBe(initialModelPolicy.exact.model);
    initialModelPolicy.mode = "exact";
    initialModelPolicy.exact.model.id = "mutated-after-start";

    startRequest.resolve(started);
    await expect(start).resolves.toBe(true);

    expect(onStarterModelPolicyConfirmed).toHaveBeenCalledTimes(1);
    const confirmation = onStarterModelPolicyConfirmed.mock.calls[0]?.[0];
    if (confirmation === undefined) throw new Error("Expected a plus-start confirmation");
    expect(confirmation.machineId).toBe("local");
    expect(confirmation.session).toMatchObject({
      id: "new-session",
      creationSource: "session-list-plus",
    });
    expect(confirmation.policy).toEqual(fullStarterModelPolicyPreference);
    expect(confirmation.policy).toBe(requestedPolicy);
  });

  it("queues a plus start's initial prompt until backend creation succeeds", async () => {
    const started: SessionInfo = { ...replacementSession, creationSource: "session-list-plus" };
    const startRequest = deferred<SessionInfo>();
    const startPlusSession = vi.fn<typeof defaultApi.startPlusSession>(() => startRequest.promise);
    const prompt = vi.fn(() => Promise.resolve({ accepted: true } as const));
    const harness = pendingStartHarness({ startPlusSession, prompt });
    const startOutcomes: boolean[] = [];

    const starting = harness.controller.startPlusSessionWithPrompt(
      "Plan the migration",
      undefined,
      undefined,
      "inline",
      fullStarterModelPolicyPreference,
      (startedSuccessfully) => { startOutcomes.push(startedSuccessfully); },
    );

    expect(startPlusSession).toHaveBeenCalledWith("/repo", fullStarterModelPolicyPreference, "local");
    expect(prompt).not.toHaveBeenCalled();
    expect(startOutcomes).toEqual([]);

    startRequest.resolve(started);
    await expect(starting).resolves.toBeUndefined();

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: started.id }),
      "Plan the migration",
      undefined,
      "local",
      undefined,
    );
    expect(startOutcomes).toEqual([true]);
  });

  it("does not confirm a failed plus start", async () => {
    const onStarterModelPolicyConfirmed = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicyConfirmed"]>>();
    const harness = pendingStartHarness(
      { startPlusSession: () => Promise.reject(new Error("backend unavailable")) },
      onStarterModelPolicyConfirmed,
    );

    await expect(harness.controller.startPlusSession(fullStarterModelPolicyPreference)).resolves.toBe(false);

    expect(onStarterModelPolicyConfirmed).not.toHaveBeenCalled();
  });

  it("does not confirm a discarded plus start that resolves later", async () => {
    const started: SessionInfo = { ...replacementSession, creationSource: "session-list-plus" };
    const startRequest = deferred<SessionInfo>();
    const onStarterModelPolicyConfirmed = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicyConfirmed"]>>();
    const harness = pendingStartHarness(
      {
        startPlusSession: () => startRequest.promise,
        stop: () => Promise.resolve({ stopped: true }),
      },
      onStarterModelPolicyConfirmed,
    );

    const start = harness.controller.startPlusSession(fullStarterModelPolicyPreference);
    await harness.controller.deleteCachedNewSession(harness.state().selectedSession);
    startRequest.resolve(started);
    await start;

    expect(onStarterModelPolicyConfirmed).not.toHaveBeenCalled();
  });

  it("confirms a plus start against its originating scope after the selected workspace changes", async () => {
    const started: SessionInfo = { ...replacementSession, creationSource: "session-list-plus" };
    const startRequest = deferred<SessionInfo>();
    const onStarterModelPolicyConfirmed = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicyConfirmed"]>>();
    const harness = pendingStartHarness({ startPlusSession: () => startRequest.promise }, onStarterModelPolicyConfirmed);

    const start = harness.controller.startPlusSession(fullStarterModelPolicyPreference);
    harness.setState({ selectedWorkspace: { ...workspace, id: "other-workspace", path: "/other" } });
    startRequest.resolve(started);
    await start;

    expect(onStarterModelPolicyConfirmed).toHaveBeenCalledWith({
      machineId: "local",
      session: started,
      policy: fullStarterModelPolicyPreference,
    });
  });

  it("does not confirm a plus start when the resolved session omits its source", async () => {
    const onStarterModelPolicyConfirmed = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicyConfirmed"]>>();
    const harness = pendingStartHarness(
      { startPlusSession: () => Promise.resolve(replacementSession) },
      onStarterModelPolicyConfirmed,
    );

    await expect(harness.controller.startPlusSession(fullStarterModelPolicyPreference)).resolves.toBe(true);

    expect(onStarterModelPolicyConfirmed).not.toHaveBeenCalled();
  });

  it("does not confirm a legacy start even when its response projects plus provenance", async () => {
    const started: SessionInfo = { ...replacementSession, creationSource: "session-list-plus" };
    const onStarterModelPolicyConfirmed = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicyConfirmed"]>>();
    const harness = pendingStartHarness(
      { startSession: () => Promise.resolve(started) },
      onStarterModelPolicyConfirmed,
    );

    await expect(harness.controller.startSession()).resolves.toBe(true);

    expect(onStarterModelPolicyConfirmed).not.toHaveBeenCalled();
  });
});

function pendingStartHarness(
  apiOverrides: Partial<typeof defaultApi>,
  onStarterModelPolicyConfirmed: NonNullable<SessionControllerDependencies["onStarterModelPolicyConfirmed"]> = () => undefined,
): {
  controller: SessionController;
  state: () => AppState;
  setState: (patch: Partial<AppState>) => void;
} {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
  const api: typeof defaultApi = {
    ...defaultApi,
    messages: () => Promise.resolve(emptyPage),
    status: (session) => Promise.resolve(status(sessionLookupId(session))),
    streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    ...apiOverrides,
  };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket(), onStarterModelPolicyConfirmed },
  );
  return {
    controller,
    state: () => state,
    setState: (patch) => { state = { ...state, ...patch }; },
  };
}
