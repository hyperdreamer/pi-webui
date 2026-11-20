import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { SessionNotification, SessionNotificationInboxEvent, SessionNotificationInboxSnapshot } from "../../../shared/apiTypes";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import { SessionNotificationController, type SessionNotificationApi } from "./sessionNotificationController";
import { SessionController, type SessionNotificationSessionBridge } from "./sessionController";
import { defaultApi, EmitSocket, emptyPage, oldSession, status, workspace, type AppState } from "./sessionController.testSupport";

function inboxEvent(): SessionNotificationInboxEvent {
  return {
    type: "notifications.inbox",
    daemonInstanceId: "daemon-a",
    catalogRevision: 1,
    summary: {
      sessionId: oldSession.id,
      cwd: oldSession.cwd,
      inboxRevision: 1,
      retainedCount: 1,
      discardedCount: 0,
      highestSeverity: "warning",
    },
    dismissThrough: { order: 1, overflowWatermark: 0 },
    delta: {
      kind: "added",
      notification: {
        id: "daemon-a:1",
        message: "background extension needs attention",
        truncated: false,
        severity: "warning",
        receivedAt: "2026-07-18T00:00:00.000Z",
        order: 1,
      },
    },
  };
}

function notificationSnapshot(inboxRevision: number, notifications: SessionNotification[] = []): SessionNotificationInboxSnapshot {
  const highestSeverity = notifications.some((item) => item.severity === "error")
    ? "error"
    : notifications.some((item) => item.severity === "warning") ? "warning" : notifications.length > 0 ? "info" : undefined;
  return {
    daemonInstanceId: "daemon-a",
    catalogRevision: inboxRevision,
    summary: {
      sessionId: oldSession.id,
      cwd: oldSession.cwd,
      inboxRevision,
      retainedCount: notifications.length,
      discardedCount: 0,
      ...(highestSeverity === undefined ? {} : { highestSeverity }),
    },
    notifications,
    dismissThrough: { order: notifications[0]?.order ?? 0, overflowWatermark: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function realNotificationBridgeHarness(
  notificationInbox: SessionNotificationApi["notificationInbox"],
  messages: typeof defaultApi.messages = vi.fn(() => Promise.resolve(emptyPage)),
) {
  const localMachine = {
    id: "local",
    name: "Local",
    kind: "local" as const,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
  let state: AppState = {
    ...initialAppState(),
    machines: [localMachine],
    selectedMachine: localMachine,
    selectedWorkspace: workspace,
    selectedSession: oldSession,
    sessions: [oldSession],
    machineRuntimes: {
      local: {
        machineId: "local",
        ok: true,
        checkedAt: "2026-07-18T00:00:00.000Z",
        capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications],
      },
    },
  };
  const socket = new EmitSocket();
  const extensionEntries = vi.fn(() => Promise.resolve({ entries: [], seq: 0, readRevision: 1 }));
  const bridge = new SessionNotificationController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    { api: { ...defaultApi, notificationInbox }, onBackgroundError: vi.fn() },
  );
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    {
      socket,
      notifications: bridge,
      api: {
        ...defaultApi,
        messages,
        status: vi.fn(() => Promise.resolve(status(oldSession.id))),
        streamSnapshot: vi.fn(() => Promise.resolve({ seq: 0, partial: null })),
        extensionEntries,
      },
    },
  );
  return { controller, bridge, socket, extensionEntries, get state() { return state; } };
}

describe("SessionController notification event boundary", () => {
  it.each(["before", "after"] as const)("covers a marker received %s the selection snapshot settles through the real bridge", async (timing) => {
    const first = deferred<SessionNotificationInboxSnapshot>();
    const catchUp = deferred<SessionNotificationInboxSnapshot>();
    const catchUpStarted = deferred<undefined>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => { catchUpStarted.resolve(undefined); return catchUp.promise; });
    const transcript = deferred<typeof emptyPage>();
    const harness = realNotificationBridgeHarness(notificationInbox, vi.fn(() => transcript.promise));
    const selecting = harness.controller.selectSession(oldSession, { updateUrl: false });
    const selectionRead = harness.bridge.refreshSelectedSession(oldSession, "local");
    expect(notificationInbox).toHaveBeenCalledTimes(1);
    harness.socket.open();
    expect(notificationInbox).toHaveBeenCalledTimes(1);
    if (timing === "after") {
      first.resolve(notificationSnapshot(1));
      await selectionRead;
      expect(notificationInbox).toHaveBeenCalledTimes(1);
      transcript.resolve(emptyPage);
      await selecting;
    }
    harness.socket.emit({ type: "session.subscribed" });
    harness.socket.emit({ type: "session.subscribed" });
    if (timing === "before") {
      expect(notificationInbox).toHaveBeenCalledTimes(1);
      first.resolve(notificationSnapshot(1));
    }
    await first.promise;
    expect(notificationInbox).toHaveBeenCalledTimes(2);
    await catchUpStarted.promise;
    const delta = inboxEvent().delta;
    if (delta.kind !== "added") throw new Error("expected notification fixture");
    catchUp.resolve(notificationSnapshot(2, [delta.notification]));
    await selectionRead;
    await vi.waitFor(() => { expect(harness.state.selectedNotificationInbox?.notifications).toEqual([delta.notification]); });
    if (timing === "before") {
      expect(harness.extensionEntries).toHaveBeenCalledTimes(1);
      transcript.resolve(emptyPage);
      await selecting;
    }
    await vi.waitFor(() => { expect(harness.extensionEntries).toHaveBeenCalledTimes(3); });
    expect(notificationInbox).toHaveBeenCalledTimes(2);
    // Exercise selected-socket delivery after either join path has finished.
    harness.socket.emit({
      ...inboxEvent(),
      catalogRevision: 3,
      summary: { ...inboxEvent().summary, inboxRevision: 3, retainedCount: 2 },
      dismissThrough: { order: 2, overflowWatermark: 0 },
      delta: { kind: "added", notification: { ...delta.notification, id: "daemon-a:2", order: 2 } },
    });
    expect(harness.state.selectedNotificationInbox?.notifications.map((row) => row.id)).toEqual(["daemon-a:2", "daemon-a:1"]);
    harness.controller.dispose();
    harness.bridge.dispose();
  });

  it.each(["joined", "steady"] as const)("reserves reconnect coverage behind an older socket read in the %s path", async (phase) => {
    const olderRead = deferred<SessionNotificationInboxSnapshot>();
    const catchUp = deferred<SessionNotificationInboxSnapshot>();
    const catchUpStarted = deferred<undefined>();
    const transcript = deferred<typeof emptyPage>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>();
    const messages = vi.fn<typeof defaultApi.messages>();
    if (phase === "steady") {
      notificationInbox.mockResolvedValueOnce(notificationSnapshot(1));
      messages.mockResolvedValueOnce(emptyPage);
    }
    notificationInbox
      .mockImplementationOnce(() => olderRead.promise)
      .mockImplementationOnce(() => { catchUpStarted.resolve(undefined); return catchUp.promise; });
    messages.mockImplementation(() => transcript.promise);
    const harness = realNotificationBridgeHarness(notificationInbox, messages);
    const selecting = harness.controller.selectSession(oldSession, { updateUrl: false });
    if (phase === "steady") await selecting;
    const heldRead = harness.bridge.refreshSelectedSession(oldSession, "local");
    const beforeReconnect = notificationInbox.mock.calls.length;
    harness.socket.reconnect();
    expect(notificationInbox).toHaveBeenCalledTimes(beforeReconnect);
    harness.socket.emit({ type: "session.subscribed" });
    harness.socket.emit({ type: "session.subscribed" });
    expect(notificationInbox).toHaveBeenCalledTimes(beforeReconnect);
    olderRead.resolve(notificationSnapshot(1));
    await olderRead.promise;
    expect(notificationInbox).toHaveBeenCalledTimes(beforeReconnect + 1);
    await catchUpStarted.promise;
    const delta = inboxEvent().delta;
    if (delta.kind !== "added") throw new Error("expected notification fixture");
    catchUp.resolve(notificationSnapshot(2, [delta.notification]));
    await heldRead;
    expect(harness.state.selectedNotificationInbox?.notifications).toEqual([delta.notification]);
    expect(notificationInbox).toHaveBeenCalledTimes(beforeReconnect + 1);
    transcript.resolve(emptyPage);
    await selecting;
    await vi.waitFor(() => { expect(harness.extensionEntries.mock.calls.length).toBeGreaterThanOrEqual(3); });
    harness.socket.emit({ type: "session.subscribed" });
    await harness.bridge.ensurePostSubscriptionRefresh(oldSession, "local", 2);
    expect(notificationInbox).toHaveBeenCalledTimes(beforeReconnect + 1);
    harness.controller.dispose();
    harness.bridge.dispose();
  });

  it("handles inbox events before transcript watermarking and filters only marked legacy output with support", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const applyInboxEvent = vi.fn();
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession: vi.fn(() => Promise.resolve()),
      observeSocketIncarnation: vi.fn(),
      ensurePostSubscriptionRefresh: vi.fn(() => Promise.resolve()),
      applyInboxEvent,
      shouldFilterLegacyNotification: vi.fn((_machineId, notificationId) => notificationId !== undefined),
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: vi.fn(() => Promise.resolve(emptyPage)),
      status: vi.fn(() => Promise.resolve(status(oldSession.id))),
      streamSnapshot: vi.fn(() => Promise.resolve({ seq: 100, partial: null })),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket, notifications: bridge },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ ...inboxEvent(), seq: 50 });
    socket.emit({ type: "command.output", level: "info", message: "legacy duplicate", notificationId: "daemon-a:1", seq: 101 });

    expect(applyInboxEvent).toHaveBeenCalledExactlyOnceWith("local", expect.objectContaining({ type: "notifications.inbox" }), 1);
    expect(state.messages).toEqual([]);

    socket.emit({ type: "command.output", level: "info", message: "ordinary extension output", seq: 102 });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "ordinary extension output" }]);
  });

  it("preserves marked legacy notification output when capability support is absent", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const bridge: SessionNotificationSessionBridge = {
      prepareSelectedSession: vi.fn(),
      clearSelectedSession: vi.fn(),
      refreshSelectedSession: vi.fn(() => Promise.resolve()),
      observeSocketIncarnation: vi.fn(),
      ensurePostSubscriptionRefresh: vi.fn(() => Promise.resolve()),
      applyInboxEvent: vi.fn(),
      shouldFilterLegacyNotification: vi.fn(() => false),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        socket,
        notifications: bridge,
        api: {
          ...defaultApi,
          messages: vi.fn(() => Promise.resolve(emptyPage)),
          status: vi.fn(() => Promise.resolve(status(oldSession.id))),
          streamSnapshot: vi.fn(() => Promise.resolve({ seq: 0, partial: null })),
        },
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ type: "command.output", level: "info", message: "legacy notification", notificationId: "new-daemon:1", seq: 1 });

    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "legacy notification" }]);
  });
});
