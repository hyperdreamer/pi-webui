import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { StreamEventBuffer } from "../streamEventBuffer";
import { SessionController } from "./sessionController";
import { defaultApi, EmitSocket, emptyPage, FakeSocket, oldSession, replacementSession, runPendingAnimationFrames, status, workspace, type AppState, type MessagePage, type SessionActivity, type SessionInfo } from "./sessionController.testSupport";

interface ScheduledOverloadResync {
  run: () => void;
  delayMs: number;
  cancelled: boolean;
}

function createOverloadResyncScheduler() {
  const scheduled: ScheduledOverloadResync[] = [];
  return {
    scheduled,
    schedule: (run: () => void, delayMs: number): (() => void) => {
      const entry: ScheduledOverloadResync = { run, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
  };
}

function latestScheduledOverloadResync(scheduler: ReturnType<typeof createOverloadResyncScheduler>): ScheduledOverloadResync {
  const scheduled = scheduler.scheduled.at(-1);
  if (scheduled === undefined) throw new Error("Expected an overload resync to be scheduled");
  return scheduled;
}

function overflowStreamBuffer(socket: EmitSocket, seq: number): void {
  socket.emit({ type: "assistant.delta", text: "a", seq });
  socket.emit({ type: "assistant.thinking.delta", text: "t", seq: seq + 1 });
  runPendingAnimationFrames();
}

async function settleRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("SessionController live events", () => {
  it("coalesces rapid status updates into a single state write per frame", () => {
    const setStateCalls: Partial<AppState>[] = [];
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 1 } });
    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 2 } });
    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 3 } });

    // Nothing applies until the frame is flushed; last-write-wins per session.
    expect(setStateCalls).toHaveLength(0);
    expect(state.sessionStatuses[oldSession.id]).toBeUndefined();

    runPendingAnimationFrames();

    expect(setStateCalls).toHaveLength(1);
    expect(state.sessionStatuses[oldSession.id]).toMatchObject({ sessionId: oldSession.id, messageCount: 3 });
    expect(state.status?.messageCount).toBe(3);
  });

  it("applies the latest activity per session on flush", () => {
    const setStateCalls: Partial<AppState>[] = [];
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "activity.update", activity: { sessionId: oldSession.id, phase: "active", label: "running tool", at: "t1" } });
    controller.applyGlobalEvent({ type: "activity.update", activity: { sessionId: oldSession.id, phase: "idle", label: "idle", at: "t2" } });

    expect(setStateCalls).toHaveLength(0);

    controller.flushPendingUpdates();

    expect(state.sessionActivities[oldSession.id]).toMatchObject({ phase: "idle", label: "idle" });
    expect(state.activity?.phase).toBe("idle");
  });

  it("coalesces status updates delivered over the per-session socket until the frame is flushed", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 7 } });
    socket.emit({ type: "status.update", status: { ...status(oldSession.id), isStreaming: true, messageCount: 8 } });

    // Buffered, not applied synchronously.
    expect(state.sessionStatuses[oldSession.id]?.messageCount).toBeUndefined();

    controller.flushPendingUpdates();

    expect(state.sessionStatuses[oldSession.id]?.messageCount).toBe(8);
    expect(state.status?.messageCount).toBe(8);
  });

  it("refreshes message history after a turn ends so message actions do not require a page reload", async () => {
    const initialHistory: MessagePage = {
      messages: [
        { role: "user", content: "Start here" },
        { role: "assistant", content: "First answer" },
      ],
      start: 0,
      total: 2,
    };
    const authoritativeHistory: MessagePage = {
      messages: [
        ...initialHistory.messages,
        {
          role: "user",
          content: "Revise this",
          entryId: "user-entry-2",
          previousAssistantEntryId: "assistant-entry-1",
          canFork: true,
        },
      ],
      start: 0,
      total: 3,
    };
    const socket = new EmitSocket();
    let messageCalls = 0;
    const messages = vi.fn<typeof defaultApi.messages>(() => {
      messageCalls += 1;
      return Promise.resolve(messageCalls === 1 ? initialHistory : authoritativeHistory);
    });
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages,
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ type: "message.append", message: { role: "user", content: "Revise this" } });
    expect(state.messages.at(-1)).toEqual({ role: "user", parts: [{ type: "text", text: "Revise this" }] });

    socket.emit({ type: "agent.end" });

    await vi.waitFor(() => { expect(messages).toHaveBeenCalledTimes(2); });
    expect(state.messages.at(-1)).toEqual({
      role: "user",
      parts: [{ type: "text", text: "Revise this" }],
      entryId: "user-entry-2",
      previousAssistantEntryId: "assistant-entry-1",
      canFork: true,
    });
  });

  it("clears stale active activity when an idle status arrives", () => {
    const activeActivity: SessionActivity = { sessionId: oldSession.id, phase: "active", label: "running tool", at: "2026-05-15T00:00:00.000Z" };
    let state: AppState = {
      ...initialAppState(),
      selectedSession: oldSession,
      sessions: [oldSession],
      activity: activeActivity,
      sessionActivities: { [oldSession.id]: activeActivity },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "status.update", status: status(oldSession.id) });
    controller.flushPendingUpdates();

    expect(state.activity).toBeUndefined();
    expect(state.sessionActivities[oldSession.id]).toBeUndefined();
    expect(state.sessionStatuses[oldSession.id]).toMatchObject({ sessionId: oldSession.id, isStreaming: false });
  });

  it("updates visible session message counts from live status events", () => {
    let state: AppState = {
      ...initialAppState(),
      selectedSession: oldSession,
      sessions: [oldSession],
      projectSessions: [oldSession],
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), messageCount: 3 } });
    controller.flushPendingUpdates();

    expect(state.sessions[0]?.messageCount).toBe(3);
    expect(state.projectSessions[0]?.messageCount).toBe(3);
    expect(state.selectedSession?.messageCount).toBe(3);
  });

  it("adds a newly created session to the list when it belongs to the selected workspace", () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );
    const spawned: SessionInfo = { ...oldSession, id: "spawned-session", path: "/tmp/spawned-session.jsonl" };

    controller.applyGlobalEvent({ type: "session.created", session: spawned });

    expect(state.sessions.map((session) => session.id)).toEqual(["spawned-session", "old-session"]);
  });

  it("adds a created session from another project workspace to the hierarchy catalog", () => {
    const featureWorkspace = { ...workspace, id: "workspace-feature", path: "/repo-feature", label: "feature" };
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      workspaces: [workspace, featureWorkspace],
      sessions: [oldSession],
      projectSessions: [oldSession],
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );
    const child: SessionInfo = {
      ...oldSession,
      id: "child-session",
      path: "/tmp/child-session.jsonl",
      cwd: featureWorkspace.path,
      parentSessionPath: oldSession.path,
    };

    controller.applyGlobalEvent({ type: "session.created", session: child });

    expect(state.sessions).toEqual([oldSession]);
    expect(state.projectSessions).toEqual([child, oldSession]);
  });

  it("ignores a created session for a different workspace or a duplicate id", () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({ type: "session.created", session: { ...oldSession, id: "other", cwd: "/other-repo" } });
    controller.applyGlobalEvent({ type: "session.created", session: { ...oldSession } });

    expect(state.sessions.map((session) => session.id)).toEqual(["old-session"]);
  });

  it("coalesces a flood of assistant deltas into a single transcript write per frame", async () => {
    const socket = new EmitSocket();
    const setStateCalls: Partial<AppState>[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    setStateCalls.length = 0;

    for (let index = 0; index < 500; index += 1) {
      socket.emit({ type: "assistant.delta", text: "x", seq: index + 1 });
    }

    expect(controller.pendingTranscriptEventCount()).toBe(1);
    expect(setStateCalls.filter((patch) => patch.messages !== undefined)).toHaveLength(0);

    runPendingAnimationFrames();

    expect(controller.pendingTranscriptEventCount()).toBe(0);
    const messageWrites = setStateCalls.filter((patch) => patch.messages !== undefined);
    expect(messageWrites).toHaveLength(1);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "x".repeat(500) }] }]);
  });

  it("flushes buffered deltas before applying a structural shell start", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ type: "assistant.delta", text: "before ", seq: 1 });
    socket.emit({ type: "assistant.delta", text: "barrier", seq: 2 });
    expect(controller.pendingTranscriptEventCount()).toBe(1);

    socket.emit({ type: "shell.start", command: "ls", seq: 3 });

    expect(controller.pendingTranscriptEventCount()).toBe(0);
    expect(state.messages).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "before barrier" }] },
      { role: "bash", parts: [{ type: "text", text: "$ ls" }] },
    ]);

    socket.emit({ type: "shell.chunk", chunk: "a", seq: 4 });
    socket.emit({ type: "shell.chunk", chunk: "b", seq: 5 });
    runPendingAnimationFrames();

    expect(state.messages).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "before barrier" }] },
      { role: "bash", parts: [{ type: "text", text: "$ ls\n\nab" }] },
    ]);
  });

  it("buffers repeated tool updates while keeping different tool calls separate", async () => {
    const socket = new EmitSocket();
    const setStateCalls: Partial<AppState>[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ type: "tool.start", toolName: "bash", toolCallId: "c1", summary: "first", seq: 1 });
    socket.emit({ type: "tool.start", toolName: "bash", toolCallId: "c2", summary: "second", seq: 2 });
    setStateCalls.length = 0;

    for (let index = 0; index < 200; index += 1) {
      socket.emit({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: `partial ${String(index)}`, seq: index + 3 });
    }
    socket.emit({ type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other partial", seq: 203 });
    socket.emit({ type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other final", seq: 204 });

    expect(controller.pendingTranscriptEventCount()).toBe(2);
    expect(setStateCalls.filter((patch) => patch.messages !== undefined)).toHaveLength(0);

    runPendingAnimationFrames();

    expect(controller.pendingTranscriptEventCount()).toBe(0);
    expect(setStateCalls.filter((patch) => patch.messages !== undefined)).toHaveLength(1);
    expect(state.messages).toEqual([
      {
        role: "tool",
        parts: [{ type: "toolExecution", toolCallId: "c1", toolName: "bash", summary: "first", status: "running", resultText: "partial 199" }],
      },
      {
        role: "tool",
        parts: [{ type: "toolExecution", toolCallId: "c2", toolName: "bash", summary: "second", status: "running", resultText: "other final" }],
      },
    ]);
  });

  it("requests one authoritative refresh when the stream buffer overflows", async () => {
    const socket = new EmitSocket();
    const setStateCalls: Partial<AppState>[] = [];
    const streamSnapshot = vi.fn<typeof defaultApi.streamSnapshot>(() => Promise.resolve({ seq: 0, partial: null }));
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot,
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket,
        streamEventBuffer: new StreamEventBuffer({ maxEventRuns: 1, maxBytes: 262_144 }),
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    streamSnapshot.mockClear();
    setStateCalls.length = 0;

    socket.emit({ type: "assistant.delta", text: "discarded", seq: 1 });
    socket.emit({ type: "assistant.thinking.delta", text: "overflow", seq: 2 });

    expect(setStateCalls.filter((patch) => patch.messages !== undefined)).toHaveLength(0);
    runPendingAnimationFrames();
    expect(setStateCalls.filter((patch) => patch.messages !== undefined)).toHaveLength(0);

    await vi.waitFor(() => { expect(streamSnapshot).toHaveBeenCalledOnce(); });
    await vi.waitFor(() => {
      expect(setStateCalls.filter((patch) => patch.messages !== undefined)).toHaveLength(1);
    });
    expect(streamSnapshot).toHaveBeenCalledOnce();
    expect(state.messages).toEqual([]);
  });

  it("throttles repeated overload resyncs to one per interval", async () => {
    const socket = new EmitSocket();
    const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(emptyPage));
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages,
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    let clock = 10_000;
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket,
        now: () => clock,
        streamEventBuffer: new StreamEventBuffer({ maxEventRuns: 1, maxBytes: 262_144 }),
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    const baseline = messages.mock.calls.length;

    // Each burst overflows the 1-run cap. Settling the refresh between bursts is
    // essential: `TrailingRefreshCoordinator` only merges requests that arrive
    // while one is already in flight, so without settling it would absorb the
    // whole loop and the test would pass with no throttle present. Measured
    // unthrottled behaviour for this loop is one refetch per burst.
    const overflowOnce = async (seq: number): Promise<void> => {
      socket.emit({ type: "assistant.delta", text: "a", seq });
      socket.emit({ type: "assistant.thinking.delta", text: "t", seq: seq + 1 });
      runPendingAnimationFrames();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    };

    for (let burst = 0; burst < 4; burst++) {
      await overflowOnce(1 + burst * 2);
      clock += 100;
    }

    // Four overloads inside one 1000ms window collapse to a single refetch.
    expect(messages.mock.calls.length).toBe(baseline + 1);

    clock += 1_000;
    await overflowOnce(99);

    expect(messages.mock.calls.length).toBe(baseline + 2);
  });

  it("runs a deferred overload resync after the cooldown without another event", async () => {
    const socket = new EmitSocket();
    const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(emptyPage));
    const scheduler = createOverloadResyncScheduler();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages,
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    let clock = 10_000;
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket,
        now: () => clock,
        scheduleOverloadResync: scheduler.schedule,
        streamEventBuffer: new StreamEventBuffer({ maxEventRuns: 1, maxBytes: 262_144 }),
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    const baseline = messages.mock.calls.length;

    overflowStreamBuffer(socket, 1);
    await settleRefresh();
    expect(messages).toHaveBeenCalledTimes(baseline + 1);

    clock += 100;
    overflowStreamBuffer(socket, 3);
    await settleRefresh();
    expect(messages).toHaveBeenCalledTimes(baseline + 1);
    expect(scheduler.scheduled).toHaveLength(1);
    const trailing = latestScheduledOverloadResync(scheduler);
    expect(trailing.delayMs).toBe(900);

    clock += 900;
    trailing.run();
    await settleRefresh();

    expect(messages).toHaveBeenCalledTimes(baseline + 2);
  });

  it("collapses many suppressed overload resyncs into one deferred refresh", async () => {
    const socket = new EmitSocket();
    const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(emptyPage));
    const scheduler = createOverloadResyncScheduler();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages,
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    let clock = 10_000;
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket,
        now: () => clock,
        scheduleOverloadResync: scheduler.schedule,
        streamEventBuffer: new StreamEventBuffer({ maxEventRuns: 1, maxBytes: 262_144 }),
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    const baseline = messages.mock.calls.length;

    overflowStreamBuffer(socket, 1);
    await settleRefresh();

    for (let overflow = 0; overflow < 4; overflow += 1) {
      clock += 100;
      overflowStreamBuffer(socket, 3 + overflow * 2);
    }
    await settleRefresh();

    expect(messages).toHaveBeenCalledTimes(baseline + 1);
    expect(scheduler.scheduled).toHaveLength(1);
    const trailing = latestScheduledOverloadResync(scheduler);

    clock += 600;
    trailing.run();
    await settleRefresh();

    expect(messages).toHaveBeenCalledTimes(baseline + 2);
    expect(scheduler.scheduled).toHaveLength(1);
  });

  it("cancels deferred overload resyncs after session changes or disposal", async () => {
    const socket = new EmitSocket();
    const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(emptyPage));
    const scheduler = createOverloadResyncScheduler();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession, replacementSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages,
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    let clock = 10_000;
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket,
        now: () => clock,
        scheduleOverloadResync: scheduler.schedule,
        streamEventBuffer: new StreamEventBuffer({ maxEventRuns: 1, maxBytes: 262_144 }),
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    overflowStreamBuffer(socket, 1);
    await settleRefresh();
    clock += 100;
    overflowStreamBuffer(socket, 3);
    const beforeSelection = latestScheduledOverloadResync(scheduler);

    await controller.selectSession(replacementSession, { updateUrl: false });
    const afterSelection = messages.mock.calls.length;
    expect(beforeSelection.cancelled).toBe(true);

    clock += 900;
    beforeSelection.run();
    await settleRefresh();
    expect(messages).toHaveBeenCalledTimes(afterSelection);

    overflowStreamBuffer(socket, 5);
    await settleRefresh();
    clock += 100;
    overflowStreamBuffer(socket, 7);
    const beforeDispose = latestScheduledOverloadResync(scheduler);

    controller.dispose();
    const afterDispose = messages.mock.calls.length;
    expect(beforeDispose.cancelled).toBe(true);

    clock += 900;
    beforeDispose.run();
    await settleRefresh();
    expect(messages).toHaveBeenCalledTimes(afterDispose);
  });
});
