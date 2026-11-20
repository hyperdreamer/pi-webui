import { describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { selectedNotificationView } from "../sessionNotifications";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import type {
  Machine,
  MachineRuntime,
  SessionRef,
  SessionInfo,
  SessionNotification,
  SessionNotificationInboxEvent,
  SessionNotificationInboxSnapshot,
} from "../../../shared/apiTypes";
import { SessionNotificationController, type SessionNotificationApi, type SessionNotificationControllerDependencies } from "./sessionNotificationController";
import { isClientPendingStartSessionInfo } from "./sessionController";
import { parseSessionNotificationInboxEvent, parseSessionNotificationInboxSnapshot } from "../api/parsers";

const localMachine: Machine = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const session: SessionInfo = {
  id: "session-1",
  cwd: "/repo",
  path: "/tmp/session-1.jsonl",
  created: "2026-07-18T00:00:00.000Z",
  modified: "2026-07-18T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

function entry(order: number, severity: SessionNotification["severity"] = "info", daemonInstanceId = "daemon-a"): SessionNotification {
  return {
    id: `${daemonInstanceId}:${String(order)}`,
    message: `notice ${String(order)}`,
    truncated: false,
    severity,
    receivedAt: new Date(Date.UTC(2026, 10, 18, 0, 0, order)).toISOString(),
    order,
  };
}

function inboxSnapshot(
  notifications: SessionNotification[] = [entry(1)],
  options: { inboxRevision?: number; catalogRevision?: number; discardedCount?: number; daemonInstanceId?: string; session?: SessionRef } = {},
): SessionNotificationInboxSnapshot {
  const highestSeverity = notifications.some((notification) => notification.severity === "error")
    ? "error"
    : notifications.some((notification) => notification.severity === "warning") ? "warning" : notifications.length > 0 ? "info" : undefined;
  return {
    daemonInstanceId: options.daemonInstanceId ?? "daemon-a",
    catalogRevision: options.catalogRevision ?? options.inboxRevision ?? 1,
    summary: {
      sessionId: options.session?.id ?? session.id,
      cwd: options.session?.cwd ?? session.cwd,
      inboxRevision: options.inboxRevision ?? 1,
      retainedCount: notifications.length,
      discardedCount: options.discardedCount ?? 0,
      ...(highestSeverity === undefined ? {} : { highestSeverity }),
    },
    notifications,
    dismissThrough: { order: notifications[0]?.order ?? 0, overflowWatermark: options.discardedCount ?? 0 },
  };
}

function addedEvent(notification: SessionNotification, inboxRevision: number, retainedCount: number): SessionNotificationInboxEvent {
  return {
    type: "notifications.inbox",
    daemonInstanceId: "daemon-a",
    catalogRevision: inboxRevision,
    summary: {
      sessionId: session.id,
      cwd: session.cwd,
      inboxRevision,
      retainedCount,
      discardedCount: 0,
      highestSeverity: notification.severity,
    },
    dismissThrough: { order: notification.order, overflowWatermark: 0 },
    delta: { kind: "added", notification },
  };
}

function capableState(): AppState {
  return {
    ...initialAppState(),
    machines: [localMachine],
    selectedMachine: localMachine,
    selectedSession: session,
    sessions: [session],
    machineRuntimes: {
      local: {
        machineId: "local",
        ok: true,
        checkedAt: "2026-07-18T00:00:00.000Z",
        capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications],
      },
    },
  };
}

function runtimeWithVersion(version = "1", machineId = "local"): MachineRuntime {
  return {
    machineId,
    ok: true,
    checkedAt: "2026-11-18T00:00:00.000Z",
    packageName: "@hyperdreamer/pi-webui",
    capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications],
    components: {
      web: { component: "web", label: "Web", runtimeVersion: version, available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications] },
      sessiond: { component: "sessiond", label: "Daemon", runtimeVersion: version, available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications] },
    },
  };
}

function createHarness(
  initialState = capableState(),
  overrides: Partial<SessionNotificationApi> = {},
  dependencies: Omit<SessionNotificationControllerDependencies, "api"> = {},
) {
  let state = initialState;
  const api: SessionNotificationApi = {
    notificationInbox: vi.fn(() => Promise.resolve(inboxSnapshot())),
    dismissNotification: vi.fn(() => Promise.resolve(inboxSnapshot([], { inboxRevision: 2, catalogRevision: 2 }))),
    dismissAllNotifications: vi.fn(() => Promise.resolve(inboxSnapshot([], { inboxRevision: 2, catalogRevision: 2 }))),
    ...overrides,
  };
  const onBackgroundError = vi.fn();
  const controller = new SessionNotificationController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    { api, onBackgroundError, ...dependencies },
  );
  return {
    controller,
    api,
    onBackgroundError,
    get state() { return state; },
    replaceState(next: AppState) { state = next; },
  };
}

describe("SessionNotificationController selected inbox ownership", () => {
  it("makes no notification request and preserves marked legacy output without effective capability support", async () => {
    const state = { ...capableState(), machineRuntimes: {} };
    const harness = createHarness(state);

    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");

    expect(harness.api.notificationInbox).not.toHaveBeenCalled();
    expect(harness.controller.shouldFilterLegacyNotification("local", "notification-1")).toBe(false);
    expect(harness.state.selectedNotificationInbox).toBeUndefined();
  });

  it("treats a validated selected-inbox event as support during a rolling capability transition", async () => {
    const state = { ...capableState(), machineRuntimes: {} };
    const harness = createHarness(state);
    harness.controller.prepareSelectedSession(session, "local");

    harness.controller.applyInboxEvent("local", addedEvent(entry(1), 1, 1));

    await vi.waitFor(() => { expect(harness.api.notificationInbox).toHaveBeenCalledOnce(); });
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toHaveLength(1);
    expect(harness.controller.shouldFilterLegacyNotification("local", "daemon-a:1")).toBe(true);
  });

  it("joins selected live events that arrive while the selected snapshot is loading", async () => {
    const pendingInbox = deferred<SessionNotificationInboxSnapshot>();
    const harness = createHarness(capableState(), { notificationInbox: vi.fn(() => pendingInbox.promise) });

    harness.controller.prepareSelectedSession(session, "local");
    const refresh = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", addedEvent(entry(2, "warning"), 2, 2));
    pendingInbox.resolve(inboxSnapshot([entry(1)], { inboxRevision: 1, catalogRevision: 1 }));
    await refresh;

    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual([
      "daemon-a:2",
      "daemon-a:1",
    ]);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.announcements).toMatchObject([
      { severity: "warning" },
    ]);
  });

  it("reserves one post-subscription read while the selection read is pending", async () => {
    const first = deferred<SessionNotificationInboxSnapshot>();
    const catchUp = deferred<SessionNotificationInboxSnapshot>();
    const firstStarted = deferred<undefined>();
    const catchUpStarted = deferred<undefined>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockImplementationOnce(() => { firstStarted.resolve(undefined); return first.promise; })
      .mockImplementationOnce(() => { catchUpStarted.resolve(undefined); return catchUp.promise; });
    const harness = createHarness(capableState(), { notificationInbox });
    const { controller } = harness;
    controller.prepareSelectedSession(session, "local");
    controller.observeSocketIncarnation(session, "local", 1);
    const selectionRead = controller.refreshSelectedSession(session, "local");
    await firstStarted.promise;
    const marker = controller.ensurePostSubscriptionRefresh(session, "local", 1);
    const duplicate = controller.ensurePostSubscriptionRefresh(session, "local", 1);
    expect(notificationInbox).toHaveBeenCalledTimes(1);
    first.resolve(inboxSnapshot([]));
    await catchUpStarted.promise;
    const duplicateDuringCatchUp = controller.ensurePostSubscriptionRefresh(session, "local", 1);
    const gapRow = entry(1, "warning");
    catchUp.resolve(inboxSnapshot([gapRow], { inboxRevision: 2 }));
    await Promise.all([selectionRead, marker, duplicate, duplicateDuringCatchUp]);
    await controller.ensurePostSubscriptionRefresh(session, "local", 1);
    expect(notificationInbox).toHaveBeenCalledTimes(2);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([gapRow]);
  });

  it("ignores notification events for an unselected chat", async () => {
    const harness = createHarness();
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const selectedBefore = harness.state.selectedNotificationInbox;

    harness.controller.applyInboxEvent("local", {
      ...addedEvent(entry(2), 2, 1),
      summary: { ...addedEvent(entry(2), 2, 1).summary, sessionId: "session-2" },
    });
    await Promise.resolve();

    expect(harness.api.notificationInbox).toHaveBeenCalledOnce();
    expect(harness.state.selectedNotificationInbox).toBe(selectedBefore);
  });

  it("recovers a selected inbox revision gap from its bounded snapshot", async () => {
    const first = inboxSnapshot([entry(1)], { inboxRevision: 1, catalogRevision: 1 });
    const recovered = inboxSnapshot([entry(3), entry(1)], { inboxRevision: 3, catalogRevision: 3 });
    const notificationInbox = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(recovered);
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");

    harness.controller.applyInboxEvent("local", addedEvent(entry(3), 3, 2));

    await vi.waitFor(() => { expect(notificationInbox).toHaveBeenCalledTimes(2); });
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual([
      "daemon-a:3",
      "daemon-a:1",
    ]);
  });

  it("ignores an old selected-inbox response after selection changes", async () => {
    const oldInbox = deferred<SessionNotificationInboxSnapshot>();
    const harness = createHarness(capableState(), { notificationInbox: vi.fn(() => oldInbox.promise) });
    const otherSession = { ...session, id: "session-2", path: "/tmp/session-2.jsonl" };

    harness.controller.prepareSelectedSession(session, "local");
    const refresh = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.prepareSelectedSession(otherSession, "local");
    oldInbox.resolve(inboxSnapshot());
    await refresh;

    expect(harness.state.selectedNotificationInbox).toMatchObject({ sessionId: "session-2", status: "loading", notifications: [] });
  });

  it("hides a selected remote inbox when the machine becomes unreachable and ignores an in-flight snapshot", async () => {
    const remoteMachine: Machine = { ...localMachine, id: "remote-a", name: "Remote", kind: "remote", baseUrl: "https://remote.example.test/" };
    const runtime = capableState().machineRuntimes["local"];
    if (runtime === undefined) throw new Error("expected capable runtime fixture");
    const initial = {
      ...capableState(),
      machines: [remoteMachine],
      selectedMachine: remoteMachine,
      machineRuntimes: { [remoteMachine.id]: { ...runtime, machineId: remoteMachine.id } },
    };
    const pendingInbox = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn()
      .mockResolvedValueOnce(inboxSnapshot())
      .mockImplementationOnce(() => pendingInbox.promise);
    const harness = createHarness(initial, { notificationInbox });

    harness.controller.prepareSelectedSession(session, remoteMachine.id);
    await harness.controller.refreshSelectedSession(session, remoteMachine.id);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toHaveLength(1);

    const refresh = harness.controller.refreshSelectedSession(session, remoteMachine.id);
    const previous = harness.state;
    const offline: AppState = {
      ...previous,
      machineStatuses: {
        [remoteMachine.id]: {
          machineId: remoteMachine.id,
          ok: false,
          checkedAt: "2026-07-18T00:01:00.000Z",
          status: "offline",
        },
      },
    };
    harness.replaceState(offline);
    harness.controller.syncEnvironment(previous, offline);

    expect(harness.state.selectedNotificationInbox?.status).toBe("stale");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toBeUndefined();

    pendingInbox.resolve(inboxSnapshot([entry(2, "error")], { inboxRevision: 2, catalogRevision: 2 }));
    await refresh;
    expect(harness.state.selectedNotificationInbox?.status).toBe("stale");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toBeUndefined();
  });
});

describe("SessionNotificationController optimistic mutations", () => {
  it("does not let a delayed refresh snapshot roll back a newer dismissal response", async () => {
    const initial = inboxSnapshot([entry(1)], { inboxRevision: 1, catalogRevision: 1 });
    const delayedRefresh = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => delayedRefresh.promise);
    const dismissed = inboxSnapshot([], { inboxRevision: 2, catalogRevision: 2 });
    const harness = createHarness(capableState(), {
      notificationInbox,
      dismissNotification: vi.fn(() => Promise.resolve(dismissed)),
    });

    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const refresh = harness.controller.refreshSelectedSession(session, "local");
    await harness.controller.dismissNotification("daemon-a:1");

    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([]);
    delayedRefresh.resolve(initial);
    await refresh;

    expect(harness.state.selectedNotificationInbox?.summary?.inboxRevision).toBe(2);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([]);
  });

  it("optimistically dismisses one card, reconciles the response, and rolls back/refetches on failure", async () => {
    const dismiss = deferred<SessionNotificationInboxSnapshot>();
    const refreshAfterFailure = deferred<SessionNotificationInboxSnapshot>();
    const initialInbox = inboxSnapshot([entry(2, "warning"), entry(1)]);
    const notificationInbox = vi.fn()
      .mockResolvedValueOnce(initialInbox)
      .mockImplementationOnce(() => refreshAfterFailure.promise);
    const dismissNotification = vi.fn()
      .mockImplementationOnce(() => dismiss.promise)
      .mockRejectedValueOnce(new Error("offline"));
    const harness = createHarness(capableState(), { notificationInbox, dismissNotification });

    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const firstDismissal = harness.controller.dismissNotification("daemon-a:2");

    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:1"]);

    dismiss.resolve(inboxSnapshot([entry(1)], { inboxRevision: 2, catalogRevision: 2 }));
    await firstDismissal;
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:1"]);

    const failedDismissal = harness.controller.dismissNotification("daemon-a:1");
    await vi.waitFor(() => { expect(harness.state.error).toContain("offline"); });
    refreshAfterFailure.resolve(inboxSnapshot([entry(1)], { inboxRevision: 2, catalogRevision: 2 }));
    await failedDismissal;

    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:1"]);
    expect(notificationInbox).toHaveBeenCalledTimes(2);
  });

  it("uses the server cutoff for dismiss-all and leaves a concurrently arriving newer card visible", async () => {
    const dismissAll = deferred<SessionNotificationInboxSnapshot>();
    const dismissAllNotifications = vi.fn(() => dismissAll.promise);
    const harness = createHarness(capableState(), {
      notificationInbox: vi.fn(() => Promise.resolve(inboxSnapshot([entry(2), entry(1)]))),
      dismissAllNotifications,
    });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");

    const dismissal = harness.controller.dismissAll();
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([]);
    expect(dismissAllNotifications).toHaveBeenCalledWith({ id: session.id, cwd: session.cwd }, "daemon-a", { order: 2, overflowWatermark: 0 }, "local");

    harness.controller.applyInboxEvent("local", addedEvent(entry(3), 2, 3));
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:3"]);

    dismissAll.resolve(inboxSnapshot([entry(3)], { inboxRevision: 3, catalogRevision: 3 }));
    await dismissal;
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:3"]);
  });
});

describe("SessionNotificationController reviewed recovery regressions", () => {
  it("reuses completed post-subscription coverage for duplicate markers", async () => {
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([]))
      .mockResolvedValue(inboxSnapshot([entry(1)], { inboxRevision: 2 }));
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    harness.controller.observeSocketIncarnation(session, "local", 1);
    await harness.controller.refreshSelectedSession(session, "local");
    await harness.controller.ensurePostSubscriptionRefresh(session, "local", 1);
    await harness.controller.ensurePostSubscriptionRefresh(session, "local", 1);
    expect(notificationInbox).toHaveBeenCalledTimes(2);
  });

  it("reserves reconnect coverage behind a pending earlier-incarnation read", async () => {
    const first = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(inboxSnapshot([entry(2), entry(1)], { inboxRevision: 2 }));
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    harness.controller.observeSocketIncarnation(session, "local", 1);
    const read = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.observeSocketIncarnation(session, "local", 2);
    const marker = harness.controller.ensurePostSubscriptionRefresh(session, "local", 2);
    first.resolve(inboxSnapshot([entry(1)]));
    await Promise.all([read, marker]);
    expect(notificationInbox).toHaveBeenCalledTimes(2);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((row) => row.id)).toEqual(["daemon-a:2", "daemon-a:1"]);
  });

  it("does not let a pre-runtime-replacement read establish support for the new generation", async () => {
    const oldRead = deferred<SessionNotificationInboxSnapshot>();
    const replacementRead = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => replacementRead.promise);
    const initial = { ...capableState(), machineRuntimes: { local: runtimeWithVersion() } };
    const harness = createHarness(initial, { notificationInbox });
    harness.controller.syncEnvironment(harness.state, harness.state);
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const generation = harness.controller.runtimeGenerationFor("local");
    const read = harness.controller.refreshSelectedSession(session, "local");
    const previous = harness.state;
    harness.replaceState({ ...previous, machineRuntimes: { local: runtimeWithVersion("2") } });
    harness.controller.syncEnvironment(previous, harness.state);
    expect(harness.controller.runtimeGenerationFor("local")).toBe(generation + 1);
    expect(notificationInbox).toHaveBeenCalledTimes(3);
    oldRead.resolve(inboxSnapshot([entry(1)]));
    await read;
    expect(harness.controller.acceptedSupportFor("local")).toBeUndefined();
    expect(harness.state.selectedNotificationInbox?.status).toBe("stale");
    expect(harness.controller.inboxOperation).toMatchObject({ kind: "loading-inbox" });
    const currentRead = harness.controller.refreshSelectedSession(session, "local");
    replacementRead.resolve(inboxSnapshot([entry(1, "warning", "daemon-b")], { daemonInstanceId: "daemon-b" }));
    await currentRead;
    expect(harness.controller.acceptedSupportFor("local")?.daemonInstanceId).toBe("daemon-b");
  });

  it("suppresses a retired-daemon read rejection and recovers after replacement evidence", async () => {
    const oldRead = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockImplementationOnce(() => oldRead.promise)
      .mockResolvedValue(inboxSnapshot([entry(2, "warning")], { inboxRevision: 1, daemonInstanceId: "daemon-b" }));
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const read = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", {
      ...addedEvent(entry(2, "warning"), 1, 1),
      daemonInstanceId: "daemon-b",
    }, 1);
    oldRead.reject(new Error("retired read failed"));
    await read;
    await vi.waitFor(() => { expect(notificationInbox).toHaveBeenCalledTimes(3); });
    expect(harness.controller.failureMessage).toBeUndefined();
    expect(harness.state.error).not.toContain("retired read failed");
  });

  it("reconciles a valid joined addition when the refresh fails", async () => {
    const pending = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockImplementationOnce(() => pending.promise);
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const read = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", addedEvent(entry(2, "warning"), 2, 2), 1);
    pending.reject(new Error("background read failed"));
    await read;
    expect(harness.state.selectedNotificationInbox?.status).toBe("fresh");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((row) => row.id)).toEqual(["daemon-a:2", "daemon-a:1"]);
  });

  it("keeps a resync-invalidated inbox stale when its replacement read fails", async () => {
    const pending = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockImplementationOnce(() => pending.promise);
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const read = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", {
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 2,
      summary: { sessionId: session.id, cwd: session.cwd, inboxRevision: 2, retainedCount: 1, discardedCount: 0, highestSeverity: "info" },
      dismissThrough: { order: 1, overflowWatermark: 0 },
      delta: { kind: "resync" },
    }, 1);
    pending.reject(new Error("resync recovery failed"));
    await read;
    expect(harness.state.selectedNotificationInbox?.status).toBe("stale");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toBeUndefined();
  });

  it("retains same-daemon announcement history through stale recovery and an empty snapshot", async () => {
    const recovery = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockImplementationOnce(() => recovery.promise);
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", addedEvent(entry(2, "warning"), 2, 2), 1);
    const announcements = harness.state.selectedNotificationInbox?.announcements;
    harness.controller.applyInboxEvent("local", {
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 3,
      summary: { sessionId: session.id, cwd: session.cwd, inboxRevision: 3, retainedCount: 2, discardedCount: 0, highestSeverity: "warning" },
      dismissThrough: { order: 2, overflowWatermark: 0 },
      delta: { kind: "resync" },
    }, 1);
    await vi.waitFor(() => { expect(notificationInbox).toHaveBeenCalledTimes(2); });
    recovery.resolve(inboxSnapshot([], { inboxRevision: 3 }));
    await vi.waitFor(() => { expect(harness.state.selectedNotificationInbox?.status).toBe("fresh"); });
    expect(harness.state.selectedNotificationInbox?.announcements).toEqual(announcements);
    harness.controller.applyInboxEvent("local", addedEvent(entry(2, "warning"), 4, 1), 1);
    expect(harness.state.selectedNotificationInbox?.announcements).toEqual(announcements);
  });

  it("does not announce an initial-join addition rejected for a revision gap", async () => {
    const first = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(inboxSnapshot([entry(3), entry(1)], { inboxRevision: 3 }));
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    const read = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", addedEvent(entry(3), 3, 2), 1);
    first.resolve(inboxSnapshot([entry(1)], { inboxRevision: 1 }));
    await read;
    expect(harness.state.selectedNotificationInbox?.announcements).toEqual([]);
  });
  it.each([
    ["missing machine", { machineId: "missing", session }],
    ["empty machine ID", { machineId: "", session }],
    ["empty session ID", { machineId: "local", session: { ...session, id: "" } }],
    ["empty cwd", { machineId: "local", session: { ...session, cwd: "" } }],
    ["archived session", { machineId: "local", session: { ...session, archived: true } }],
    ["client-pending session", { machineId: "local", session: { ...session, clientPendingStart: true, machineId: "local" } }],
  ] as const)("admits no inbox or mutation for an ineligible %s", async (_label, selection) => {
    const harness = createHarness();
    harness.controller.prepareSelectedSession(selection.session, selection.machineId);
    await harness.controller.refreshSelectedSession(selection.session, selection.machineId);
    await harness.controller.dismissNotification("daemon-a:1");
    await harness.controller.dismissAll();
    expect(harness.api.notificationInbox).not.toHaveBeenCalled();
    expect(harness.api.dismissNotification).not.toHaveBeenCalled();
    expect(harness.api.dismissAllNotifications).not.toHaveBeenCalled();
    expect(harness.state.selectedNotificationInbox).toBeUndefined();
  });

  it("validates machine, cwd, and session identity independently for inbox events", () => {
    const harness = createHarness();
    harness.controller.prepareSelectedSession(session, "local");
    const wrongCwd = {
      ...addedEvent(entry(1), 1, 1),
      summary: { ...addedEvent(entry(1), 1, 1).summary, cwd: "/elsewhere" },
    };
    const wrongSession = {
      ...addedEvent(entry(1), 1, 1),
      summary: { ...addedEvent(entry(1), 1, 1).summary, sessionId: "another-session" },
    };
    harness.controller.applyInboxEvent("remote", addedEvent(entry(1), 1, 1));
    harness.controller.applyInboxEvent("local", wrongCwd);
    harness.controller.applyInboxEvent("local", wrongSession);
    expect(harness.api.notificationInbox).not.toHaveBeenCalled();
    expect(harness.state.selectedNotificationInbox).toMatchObject({ machineId: "local", cwd: session.cwd, sessionId: session.id, status: "loading", notifications: [] });
  });

  it("keeps support for the same runtime, advances on daemon replacement, and advances removed machines", async () => {
    const replacementSnapshot = inboxSnapshot([entry(2, "info", "daemon-b")], { daemonInstanceId: "daemon-b" });
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot())
      .mockResolvedValue(replacementSnapshot);
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.syncEnvironment(harness.state, harness.state);
    const initialGeneration = harness.controller.runtimeGenerationFor("local");
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const support = harness.controller.acceptedSupportFor("local");
    const previous = harness.state;
    const runtime = previous.machineRuntimes["local"];
    if (runtime === undefined) throw new Error("expected runtime fixture");
    const sameRuntime = { ...runtime, checkedAt: "2026-11-18T00:00:00.000Z" };
    const failedRuntime = { machineId: "local", ok: false as const, checkedAt: "2026-11-18T00:01:00.000Z", error: "temporary negotiation failure" };
    harness.replaceState({ ...previous, machineRuntimes: { local: sameRuntime } });
    harness.controller.syncEnvironment(previous, harness.state);
    expect(harness.controller.runtimeGenerationFor("local")).toBe(initialGeneration);
    expect(harness.controller.acceptedSupportFor("local")).toEqual(support);
    const sameRuntimeState = harness.state;
    harness.replaceState({ ...sameRuntimeState, machineRuntimes: { local: failedRuntime } });
    harness.controller.syncEnvironment(sameRuntimeState, harness.state);
    expect(harness.controller.acceptedSupportFor("local")).toEqual(support);

    harness.controller.applyInboxEvent("local", { ...addedEvent(entry(2), 1, 1), daemonInstanceId: "daemon-b" });
    expect(harness.controller.runtimeGenerationFor("local")).toBe(initialGeneration + 1);
    expect(harness.controller.acceptedSupportFor("local")).toMatchObject({ daemonInstanceId: "daemon-b", runtimeGeneration: initialGeneration + 1 });
    await harness.controller.refreshSelectedSession(session, "local");
    expect(harness.state.selectedNotificationInbox?.daemonInstanceId).toBe("daemon-b");
    harness.controller.dispose();

    const remote: Machine = { ...localMachine, id: "remote", name: "Remote", kind: "remote", baseUrl: "https://remote.example.test/" };
    const remoteRuntime = { ...runtime, machineId: "remote" };
    const beforeRemoval = { ...capableState(), machines: [localMachine, remote], machineRuntimes: { local: runtime, remote: remoteRuntime } };
    const removalHarness = createHarness(beforeRemoval);
    removalHarness.controller.syncEnvironment(beforeRemoval, beforeRemoval);
    const remoteGeneration = removalHarness.controller.runtimeGenerationFor("remote");
    const afterRemoval = { ...beforeRemoval, machines: [localMachine], machineRuntimes: { local: runtime } };
    removalHarness.replaceState(afterRemoval);
    removalHarness.controller.syncEnvironment(beforeRemoval, afterRemoval);
    expect(removalHarness.controller.runtimeGenerationFor("remote")).toBe(remoteGeneration + 1);
  });

  it.each(["success", "failure"] as const)("keeps a current same-ID dismissal overlay when a prior selection ends in %s", async (outcome) => {
    const firstDismissal = deferred<SessionNotificationInboxSnapshot>();
    const secondDismissal = deferred<SessionNotificationInboxSnapshot>();
    const dismissNotification = vi.fn<SessionNotificationApi["dismissNotification"]>()
      .mockImplementationOnce(() => firstDismissal.promise)
      .mockImplementationOnce(() => secondDismissal.promise);
    const harness = createHarness(capableState(), { dismissNotification });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const oldAction = harness.controller.dismissNotification("daemon-a:1");
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const currentAction = harness.controller.dismissNotification("daemon-a:1");
    if (outcome === "success") firstDismissal.resolve(inboxSnapshot([], { inboxRevision: 2 }));
    else firstDismissal.reject(new Error("retired same-ID dismissal failed"));
    await oldAction;
    expect(harness.controller.failureMessage).toBeUndefined();
    expect(harness.onBackgroundError).not.toHaveBeenCalled();
    expect(harness.state.selectedNotificationInbox?.optimisticDismissedIds).toEqual(["daemon-a:1"]);
    secondDismissal.resolve(inboxSnapshot([], { inboxRevision: 2 }));
    await currentAction;
  });

  it.each([
    ["row", "success", "success"],
    ["row", "success", "failure"],
    ["row", "failure", "success"],
    ["row", "failure", "failure"],
    ["all", "success", "success"],
    ["all", "success", "failure"],
    ["all", "failure", "success"],
    ["all", "failure", "failure"],
  ] as const)("settles %s first with row %s and Clear all %s without removing another overlay", async (first, rowOutcome, allOutcome) => {
    const rowResult = deferred<SessionNotificationInboxSnapshot>();
    const allResult = deferred<SessionNotificationInboxSnapshot>();
    let authoritative = inboxSnapshot([entry(2, "warning"), entry(1)]);
    const notificationInbox = vi.fn(() => Promise.resolve(authoritative));
    const dismissNotification = vi.fn(() => rowResult.promise);
    const dismissAllNotifications = vi.fn(() => allResult.promise);
    const harness = createHarness(capableState(), { notificationInbox, dismissNotification, dismissAllNotifications });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const rowAction = harness.controller.dismissNotification("daemon-a:2");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ retainedCount: 1, highestSeverity: "info" });
    const allAction = harness.controller.dismissAll();
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ notifications: [], retainedCount: 0, dismissAllPending: true });
    expect(dismissAllNotifications).toHaveBeenCalledExactlyOnceWith({ id: session.id, cwd: session.cwd }, "daemon-a", { order: 2, overflowWatermark: 0 }, "local");

    const settle = async (kind: "row" | "all") => {
      const outcome = kind === "row" ? rowOutcome : allOutcome;
      const result = kind === "row" ? rowResult : allResult;
      const rows = kind === "row" ? authoritative.notifications.filter((row) => row.id !== "daemon-a:2") : [];
      if (outcome === "success") {
        authoritative = inboxSnapshot(rows, { inboxRevision: authoritative.summary.inboxRevision + 1 });
        result.resolve(authoritative);
      } else {
        result.reject(new Error(`${kind} dismissal rejected`));
      }
      await (kind === "row" ? rowAction : allAction);
    };
    await settle(first);
    if (first === "row") {
      expect(harness.state.selectedNotificationInbox?.optimisticDismissedIds).toEqual([]);
      expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.dismissAllPending).toBe(true);
      await settle("all");
    } else {
      expect(harness.state.selectedNotificationInbox?.optimisticDismissedIds).toEqual(["daemon-a:2"]);
      expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.dismissAllPending).toBe(false);
      await settle("row");
    }
    expect(harness.state.selectedNotificationInbox?.optimisticDismissedIds).toEqual([]);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({
      notifications: authoritative.notifications,
      retainedCount: authoritative.notifications.length,
      dismissAllPending: false,
    });
    expect(dismissNotification).toHaveBeenCalledOnce();
    expect(dismissAllNotifications).toHaveBeenCalledOnce();
  });

  it.each(["success", "rollback"] as const)("holds the captured Clear-all watermark and exposes later overflow on %s", async (outcome) => {
    const rows = Array.from({ length: 100 }, (_, index) => entry(100 - index));
    const initial = inboxSnapshot(rows, { discardedCount: 3 });
    initial.dismissThrough = { order: 100, overflowWatermark: 8 };
    const current = deferred<SessionNotificationInboxSnapshot>();
    const dismissAllNotifications = vi.fn(() => current.promise);
    const dismissNotification = vi.fn(() => Promise.resolve(inboxSnapshot([entry(101)], { inboxRevision: 4, discardedCount: 1 })));
    const afterClear = inboxSnapshot([entry(101)], { inboxRevision: 3, discardedCount: 1 });
    afterClear.dismissThrough = { order: 101, overflowWatermark: 9 };
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(afterClear);
    const harness = createHarness(capableState(), { notificationInbox, dismissAllNotifications, dismissNotification });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const clearing = harness.controller.dismissAll();
    const later = addedEvent(entry(101), 2, 100);
    later.summary.discardedCount = 4;
    later.dismissThrough = { order: 101, overflowWatermark: 9 };
    later.delta = { kind: "added", notification: entry(101), evictedNotificationId: entry(1).id };
    harness.controller.applyInboxEvent("local", later);
    expect(dismissAllNotifications).toHaveBeenCalledExactlyOnceWith({ id: session.id, cwd: session.cwd }, "daemon-a", { order: 100, overflowWatermark: 8 }, "local");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ notifications: [entry(101)], retainedCount: 1, discardedCount: 1, dismissAllPending: true });
    await harness.controller.dismissNotification(entry(101).id);
    await harness.controller.dismissAll();
    expect(dismissNotification).not.toHaveBeenCalled();
    expect(dismissAllNotifications).toHaveBeenCalledOnce();
    if (outcome === "success") current.resolve(afterClear);
    else current.reject(new Error("transport response lost after daemon success"));
    await clearing;
    await vi.waitFor(() => { expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.dismissAllPending).toBe(false); });
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ notifications: [entry(101)], retainedCount: 1, discardedCount: 1 });
    await harness.controller.dismissNotification(entry(101).id);
    expect(dismissNotification).toHaveBeenCalledExactlyOnceWith({ id: session.id, cwd: session.cwd }, "daemon-a", entry(101).id, "local");
  });

  it("reconciles an ambiguous dismissal failure from the authoritative snapshot", async () => {
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockResolvedValueOnce(inboxSnapshot([], { inboxRevision: 2 }));
    const harness = createHarness(capableState(), {
      notificationInbox,
      dismissNotification: vi.fn(() => Promise.reject(new Error("connection lost after server applied dismissal"))),
    });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    await harness.controller.dismissNotification("daemon-a:1");
    expect(notificationInbox).toHaveBeenCalledTimes(2);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([]);
  });

  it("retains same-daemon delivery history across reconnect and establishes replacement snapshots silently", async () => {
    const recovered = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockImplementationOnce(() => recovered.promise)
      .mockResolvedValueOnce(inboxSnapshot([], { inboxRevision: 3 }))
      .mockResolvedValueOnce(inboxSnapshot([entry(3, "error")], { inboxRevision: 1, daemonInstanceId: "daemon-b" }));
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    harness.controller.observeSocketIncarnation(session, "local", 1);
    await harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", addedEvent(entry(2, "warning"), 2, 2), 1);
    const announcements = harness.state.selectedNotificationInbox?.announcements;
    harness.controller.applyInboxEvent("local", {
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 3,
      summary: { sessionId: session.id, cwd: session.cwd, inboxRevision: 3, retainedCount: 2, discardedCount: 0, highestSeverity: "warning" },
      dismissThrough: { order: 2, overflowWatermark: 0 },
      delta: { kind: "resync" },
    }, 1);
    await vi.waitFor(() => { expect(notificationInbox).toHaveBeenCalledTimes(2); });
    recovered.resolve(inboxSnapshot([], { inboxRevision: 3 }));
    await vi.waitFor(() => { expect(harness.state.selectedNotificationInbox?.status).toBe("fresh"); });
    harness.controller.observeSocketIncarnation(session, "local", 2);
    await harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", addedEvent(entry(2, "warning"), 4, 1), 2);
    expect(harness.state.selectedNotificationInbox?.announcements).toEqual(announcements);
    harness.controller.applyInboxEvent("local", { ...addedEvent(entry(2), 5, 2), daemonInstanceId: "daemon-a" }, 1);
    expect(harness.state.selectedNotificationInbox?.announcements).toEqual(announcements);
    harness.controller.applyInboxEvent("local", { ...addedEvent(entry(4, "error"), 2, 2), daemonInstanceId: "daemon-b" }, 2);
    await harness.controller.refreshSelectedSession(session, "local");
    expect(harness.state.selectedNotificationInbox?.announcements).toEqual([]);
  });
});

describe("SessionNotificationController mutation completion ownership", () => {
  it.each([
    [2, "success"],
    [1, "success"],
    [2, "failure"],
    [1, "failure"],
  ] as const)("settles row %s first with the other dismissal ending in %s", async (firstOrder, secondOutcome) => {
    const newer = deferred<SessionNotificationInboxSnapshot>();
    const older = deferred<SessionNotificationInboxSnapshot>();
    let authoritative = inboxSnapshot([entry(2, "warning"), entry(1)], { discardedCount: 3 });
    const harness = createHarness(capableState(), {
      notificationInbox: vi.fn(() => Promise.resolve(authoritative)),
      dismissNotification: vi.fn((_target, _daemon, id) => id === "daemon-a:2" ? newer.promise : older.promise),
    });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const newerAction = harness.controller.dismissNotification("daemon-a:2");
    const olderAction = harness.controller.dismissNotification("daemon-a:1");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ notifications: [], retainedCount: 0, discardedCount: 0 });
    await harness.controller.dismissNotification("daemon-a:2");
    expect(harness.api.dismissNotification).toHaveBeenCalledTimes(2);
    const secondOrder = firstOrder === 2 ? 1 : 2;
    authoritative = inboxSnapshot([entry(secondOrder, secondOrder === 2 ? "warning" : "info")], { inboxRevision: 2, discardedCount: 3 });
    (firstOrder === 2 ? newer : older).resolve(authoritative);
    await (firstOrder === 2 ? newerAction : olderAction);
    expect(harness.state.selectedNotificationInbox?.optimisticDismissedIds).toEqual([`daemon-a:${String(secondOrder)}`]);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.retainedCount).toBe(0);
    if (secondOutcome === "success") {
      authoritative = inboxSnapshot([], { inboxRevision: 3 });
      (secondOrder === 2 ? newer : older).resolve(authoritative);
    } else {
      (secondOrder === 2 ? newer : older).reject(new Error("second row rejected"));
    }
    await (secondOrder === 2 ? newerAction : olderAction);
    expect(harness.state.selectedNotificationInbox?.optimisticDismissedIds).toEqual([]);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ notifications: authoritative.notifications, retainedCount: authoritative.notifications.length, discardedCount: authoritative.summary.discardedCount });
    if (secondOutcome === "failure") expect(harness.state.error).toContain("second row rejected");
  });

  it.each(["success", "failure"] as const)("rejects a retired daemon's mutation %s after replacement", async (outcome) => {
    const oldRead = deferred<SessionNotificationInboxSnapshot>();
    const oldDismissal = deferred<SessionNotificationInboxSnapshot>();
    const newDismissal = deferred<SessionNotificationInboxSnapshot>();
    const replacement = inboxSnapshot([entry(1, "warning", "d2")], { daemonInstanceId: "d2" });
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1, "info", "d1")], { daemonInstanceId: "d1" }))
      .mockImplementationOnce(() => oldRead.promise)
      .mockResolvedValue(replacement);
    const dismissNotification = vi.fn<SessionNotificationApi["dismissNotification"]>()
      .mockImplementationOnce(() => oldDismissal.promise)
      .mockImplementationOnce(() => newDismissal.promise);
    const harness = createHarness(capableState(), { notificationInbox, dismissNotification });
    harness.controller.prepareSelectedSession(session, "local");
    harness.controller.observeSocketIncarnation(session, "local", 1);
    await harness.controller.refreshSelectedSession(session, "local");
    const oldAction = harness.controller.dismissNotification("d1:1");
    const read = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", { ...addedEvent(entry(1, "warning", "d2"), 1, 1), daemonInstanceId: "d2" }, 1);
    const replacementRead = harness.controller.refreshSelectedSession(session, "local");
    expect(notificationInbox).toHaveBeenCalledTimes(3);
    await replacementRead;
    const currentAction = harness.controller.dismissNotification("d2:1");
    if (outcome === "success") {
      oldRead.resolve(inboxSnapshot([], { inboxRevision: 9, daemonInstanceId: "d1" }));
      oldDismissal.resolve(inboxSnapshot([], { inboxRevision: 10, daemonInstanceId: "d1" }));
    } else {
      oldRead.reject(new Error("retired d1 read"));
      oldDismissal.reject(new Error("retired d1 dismissal"));
    }
    await Promise.all([read, oldAction]);
    harness.controller.applyInboxEvent("local", { ...addedEvent(entry(9, "error", "d1"), 9, 1), daemonInstanceId: "d1" }, 1);
    expect(harness.state.selectedNotificationInbox).toMatchObject({ daemonInstanceId: "d2", notifications: replacement.notifications, optimisticDismissedIds: ["d2:1"] });
    expect(harness.controller.failureMessage).toBeUndefined();
    expect(harness.state.error).toBe("");
    expect(harness.onBackgroundError).not.toHaveBeenCalled();
    newDismissal.resolve(inboxSnapshot([], { inboxRevision: 2, daemonInstanceId: "d2" }));
    await currentAction;
  });

  it.each([
    ["cwd", { ...session, cwd: "/other" }],
    ["session ID", { ...session, id: "other" }],
  ] as const)("rejects a mutation snapshot differing in %s before accepting replacement support", async (_field, other) => {
    const initial = inboxSnapshot([entry(1, "info", "d1")], { daemonInstanceId: "d1" });
    const response = inboxSnapshot([entry(1, "warning", "d2")], { daemonInstanceId: "d2", session: other });
    const harness = createHarness(capableState(), {
      notificationInbox: vi.fn(() => Promise.resolve(initial)),
      dismissNotification: vi.fn(() => Promise.resolve(parseSessionNotificationInboxSnapshot(response))),
    });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const generation = harness.controller.runtimeGenerationFor("local");
    await harness.controller.dismissNotification("d1:1");
    expect(harness.controller.runtimeGenerationFor("local")).toBe(generation);
    expect(harness.controller.acceptedSupportFor("local")?.daemonInstanceId).toBe("d1");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual(initial.notifications);
    expect(harness.state.error).toContain("does not match the selected session");
    expect(harness.api.notificationInbox).toHaveBeenCalledTimes(2);
  });

  it("treats a replacement-daemon dismissal response as its undismissed baseline", async () => {
    const replacement = inboxSnapshot([entry(1, "warning", "d2")], { daemonInstanceId: "d2" });
    const harness = createHarness(capableState(), {
      notificationInbox: vi.fn(() => Promise.resolve(inboxSnapshot([entry(1, "info", "d1")], { daemonInstanceId: "d1" }))),
      dismissNotification: vi.fn(() => Promise.resolve(replacement)),
    });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    await harness.controller.dismissNotification("d1:1");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ daemonInstanceId: "d2", notifications: replacement.notifications, retainedCount: 1, announcements: [] });
    expect(harness.state.selectedNotificationInbox?.optimisticDismissedIds).toEqual([]);
    expect(harness.controller.acceptedSupportFor("local")?.daemonInstanceId).toBe("d2");
  });

  it.each(["success", "failure"] as const)("suppresses an offline mutation %s and reconciles on recovery", async (outcome) => {
    const remote: Machine = { ...localMachine, id: "remote", kind: "remote", baseUrl: "https://remote.example.test/" };
    const pending = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockResolvedValueOnce(inboxSnapshot([entry(2, "warning")], { inboxRevision: 3 }));
    const harness = createHarness({ ...capableState(), machines: [localMachine, remote], machineRuntimes: { remote: runtimeWithVersion("1", "remote") } }, { notificationInbox, dismissNotification: vi.fn(() => pending.promise) });
    harness.controller.prepareSelectedSession(session, "remote");
    await harness.controller.refreshSelectedSession(session, "remote");
    const action = harness.controller.dismissNotification("daemon-a:1");
    const previous = harness.state;
    harness.replaceState({ ...previous, machineStatuses: { remote: { machineId: "remote", ok: false, status: "offline", checkedAt: "offline" } } });
    harness.controller.syncEnvironment(previous, harness.state);
    if (outcome === "success") pending.resolve(inboxSnapshot([], { inboxRevision: 2 }));
    else pending.reject(new Error("offline dismissal"));
    await action;
    expect(harness.state.selectedNotificationInbox?.status).toBe("stale");
    expect(harness.state.selectedNotificationInbox?.optimisticDismissedIds).toEqual([]);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toBeUndefined();
    expect(harness.controller.failureMessage).toBeUndefined();
    const offline = harness.state;
    harness.replaceState({ ...offline, machineStatuses: { remote: { machineId: "remote", ok: true, status: "online", checkedAt: "online" } } });
    harness.controller.syncEnvironment(offline, harness.state);
    await harness.controller.refreshSelectedSession(session, "remote");
    expect(notificationInbox).toHaveBeenCalledTimes(2);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([entry(2, "warning")]);
  });
});

describe("SessionNotificationController acceptance boundaries", () => {
  it.each(["initial", "replacement"] as const)("rejects invalid %s join additions and announces a later validated control", async (phase) => {
    for (const invalidation of ["gap", "inconsistent summary"] as const) {
      const pending = deferred<SessionNotificationInboxSnapshot>();
      const daemon = phase === "initial" ? "d1" : "d2";
      const baseline = inboxSnapshot([entry(1, "info", daemon)], { daemonInstanceId: daemon });
      const recovered = inboxSnapshot([entry(3, "info", daemon), entry(1, "info", daemon)], { daemonInstanceId: daemon, inboxRevision: 4 });
      const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>();
      if (phase === "replacement") notificationInbox.mockResolvedValueOnce(inboxSnapshot([entry(1, "info", "d1")], { daemonInstanceId: "d1" }));
      notificationInbox.mockImplementationOnce(() => pending.promise).mockResolvedValue(recovered);
      const harness = createHarness(capableState(), { notificationInbox });
      harness.controller.prepareSelectedSession(session, "local");
      harness.controller.observeSocketIncarnation(session, "local", 1);
      if (phase === "replacement") {
        await harness.controller.refreshSelectedSession(session, "local");
        harness.controller.applyInboxEvent("local", { ...addedEvent(entry(1, "info", daemon), 1, 1), daemonInstanceId: daemon }, 1);
      }
      const read = harness.controller.refreshSelectedSession(session, "local");
      const invalid = { ...addedEvent(entry(3, "info", daemon), invalidation === "gap" ? 3 : 2, invalidation === "gap" ? 2 : 9), daemonInstanceId: daemon };
      harness.controller.applyInboxEvent("local", parseSessionNotificationInboxEvent(invalid), 1);
      pending.resolve(parseSessionNotificationInboxSnapshot(baseline));
      await read;
      expect(harness.state.selectedNotificationInbox?.announcements).toEqual([]);
      harness.controller.applyInboxEvent("local", { ...addedEvent(entry(5, "error", daemon), 5, 3), daemonInstanceId: daemon }, 1);
      expect(harness.state.selectedNotificationInbox?.announcements).toEqual([
        { id: `local:${session.cwd}:${session.id}:${daemon}:${daemon}:5`, severity: "error" },
      ]);
      harness.controller.dispose();
    }
  });

  it("detects confirmed component replacement from the previous environment without a bootstrap sync", () => {
    const previous = { ...capableState(), selectedSession: undefined, machineRuntimes: { local: runtimeWithVersion() } };
    const harness = createHarness(previous);
    expect(harness.controller.runtimeGenerationFor("local")).toBe(0);
    const next = { ...previous, machineRuntimes: { local: runtimeWithVersion("2") } };
    harness.replaceState(next);
    harness.controller.syncEnvironment(previous, next);
    expect(harness.controller.runtimeGenerationFor("local")).toBe(1);
    expect(harness.controller.acceptedSupportFor("local")).toBeUndefined();
  });

  it("advances a removed machine once across later unrelated topology updates", () => {
    const remote: Machine = { ...localMachine, id: "remote", kind: "remote", baseUrl: "https://remote.example.test/" };
    const initial = { ...capableState(), machines: [localMachine, remote] };
    const harness = createHarness(initial);
    expect(harness.controller.runtimeGenerationFor("remote")).toBe(0);
    const removed = { ...initial, machines: [localMachine] };
    harness.replaceState(removed);
    harness.controller.syncEnvironment(initial, removed);
    expect(harness.controller.runtimeGenerationFor("remote")).toBe(1);
    const renamed = { ...removed, machines: [{ ...localMachine, name: "Renamed local" }] };
    harness.replaceState(renamed);
    harness.controller.syncEnvironment(removed, renamed);
    expect(harness.controller.runtimeGenerationFor("remote")).toBe(1);
  });

  it("retains an owed marker until the current environment check permits admission", async () => {
    let checking = true;
    const onProjectionChange = vi.fn();
    const harness = createHarness(capableState(), {}, { isCheckingEnvironment: () => checking, onProjectionChange });
    harness.controller.prepareSelectedSession(session, "local");
    harness.controller.observeSocketIncarnation(session, "local", 1);
    await harness.controller.ensurePostSubscriptionRefresh(session, "local", 1);
    await harness.controller.ensurePostSubscriptionRefresh(session, "local", 1);
    expect(harness.api.notificationInbox).not.toHaveBeenCalled();
    expect(harness.controller.inboxOperation).toBeUndefined();
    checking = false;
    const previous = harness.state;
    harness.replaceState({ ...previous, machineRuntimes: { ...previous.machineRuntimes } });
    harness.controller.syncEnvironment(previous, harness.state);
    expect(harness.controller.inboxOperation).toMatchObject({ target: { machineId: "local", cwd: session.cwd, sessionId: session.id }, selectionGeneration: harness.controller.selectionGeneration });
    await harness.controller.refreshSelectedSession(session, "local");
    await harness.controller.ensurePostSubscriptionRefresh(session, "local", 1);
    expect(harness.api.notificationInbox).toHaveBeenCalledOnce();
    expect(harness.controller.inboxOperation).toBeUndefined();
    expect(onProjectionChange).toHaveBeenCalled();
  });

  it("coalesces repeated resync invalidations and repeated Retry into one trailing admission", async () => {
    const pending = deferred<SessionNotificationInboxSnapshot>();
    const trailing = deferred<SessionNotificationInboxSnapshot>();
    const trailingStarted = deferred<undefined>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(() => { trailingStarted.resolve(undefined); return trailing.promise; });
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const read = harness.controller.refreshSelectedSession(session, "local");
    const retry = harness.controller.refreshSelectedSession(session, "local");
    const resync: SessionNotificationInboxEvent = { ...addedEvent(entry(2), 2, 2), delta: { kind: "resync" } };
    harness.controller.applyInboxEvent("local", resync);
    harness.controller.applyInboxEvent("local", resync);
    harness.controller.applyInboxEvent("local", resync);
    expect(notificationInbox).toHaveBeenCalledTimes(2);
    pending.resolve(inboxSnapshot([entry(1)]));
    await trailingStarted.promise;
    trailing.resolve(inboxSnapshot([entry(2), entry(1)], { inboxRevision: 2 }));
    await Promise.all([read, retry]);
    expect(notificationInbox).toHaveBeenCalledTimes(3);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.retainedCount).toBe(2);
  });

  it("recognizes actual pending starts while allowing ordinary sessions with similar display fields and opaque IDs", async () => {
    expect(isClientPendingStartSessionInfo({ ...session, name: "Creating session…", firstMessage: "Waiting for the backend session to be ready" })).toBe(false);
    const pending = { ...session, clientPendingStart: true, machineId: "local" };
    expect(isClientPendingStartSessionInfo(pending)).toBe(true);
    expect(isClientPendingStartSessionInfo(undefined)).toBe(false);
    const active = { ...session, id: "opaque / id?#你好", name: "Creating session…" };
    const harness = createHarness(capableState(), { notificationInbox: vi.fn(() => Promise.resolve(inboxSnapshot([], { session: active }))) });
    harness.controller.prepareSelectedSession(active, "local");
    await harness.controller.refreshSelectedSession(active, "local");
    expect(harness.api.notificationInbox).toHaveBeenCalledExactlyOnceWith({ id: active.id, cwd: active.cwd }, "local");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.retainedCount).toBe(0);
  });

  it.each(["success", "failure"] as const)("keeps B and C authoritative while A's old work settles with %s", async (outcome) => {
    const a = { ...session, id: "s", cwd: "/a" };
    const b = { ...session, id: "s", cwd: "/b" };
    const c = { ...session, id: "s", cwd: "/other" };
    const remote: Machine = { ...localMachine, id: "remote", kind: "remote", baseUrl: "https://remote.example.test/" };
    const oldRead = deferred<SessionNotificationInboxSnapshot>();
    const oldDismissal = deferred<SessionNotificationInboxSnapshot>();
    const bRead = deferred<SessionNotificationInboxSnapshot>();
    const cRead = deferred<SessionNotificationInboxSnapshot>();
    const aSnapshot = inboxSnapshot([entry(1, "info", "d1")], { daemonInstanceId: "d1", session: a });
    const bSnapshot = inboxSnapshot([entry(2, "warning", "d2")], { daemonInstanceId: "d2", session: b });
    const cSnapshot = inboxSnapshot([entry(3, "error", "d1")], { daemonInstanceId: "d1", session: c });
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockResolvedValueOnce(aSnapshot)
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => bRead.promise)
      .mockImplementationOnce(() => cRead.promise)
      .mockResolvedValueOnce(aSnapshot);
    const harness = createHarness({ ...capableState(), machines: [localMachine, remote], machineRuntimes: { local: runtimeWithVersion(), remote: runtimeWithVersion("1", "remote") } }, {
      notificationInbox,
      dismissNotification: vi.fn(() => oldDismissal.promise),
    });
    harness.controller.prepareSelectedSession(a, "local");
    await harness.controller.refreshSelectedSession(a, "local");
    const dismissal = harness.controller.dismissNotification("d1:1");
    const read = harness.controller.refreshSelectedSession(a, "local");
    harness.controller.prepareSelectedSession(b, "remote");
    const readingB = harness.controller.refreshSelectedSession(b, "remote");
    if (outcome === "success") oldRead.resolve(aSnapshot);
    else oldRead.reject(new Error("retired A read"));
    await read;
    expect(harness.state.selectedNotificationInbox).toMatchObject({ machineId: "remote", cwd: "/b", sessionId: "s", status: "loading", notifications: [] });
    expect(harness.controller.inboxOperation?.target).toEqual({ machineId: "remote", cwd: "/b", sessionId: "s" });
    expect(harness.controller.failureMessage).toBeUndefined();
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toBeUndefined();
    bRead.resolve(bSnapshot);
    await readingB;
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ notifications: bSnapshot.notifications, retainedCount: 1, highestSeverity: "warning" });
    harness.controller.prepareSelectedSession(c, "local");
    const readingC = harness.controller.refreshSelectedSession(c, "local");
    if (outcome === "success") oldDismissal.resolve(inboxSnapshot([], { session: a, daemonInstanceId: "d1", inboxRevision: 2 }));
    else oldDismissal.reject(new Error("retired A dismissal"));
    await dismissal;
    expect(harness.state.selectedNotificationInbox).toMatchObject({ machineId: "local", cwd: "/other", sessionId: "s", status: "loading", notifications: [], optimisticDismissedIds: [] });
    expect(harness.controller.inboxOperation?.target).toEqual({ machineId: "local", cwd: "/other", sessionId: "s" });
    expect(harness.state.error).toBe("");
    expect(harness.onBackgroundError).not.toHaveBeenCalled();
    cRead.resolve(cSnapshot);
    await readingC;
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ notifications: cSnapshot.notifications, retainedCount: 1, highestSeverity: "error" });
    harness.controller.prepareSelectedSession(a, "local");
    await harness.controller.refreshSelectedSession(a, "local");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual(aSnapshot.notifications);
    expect(notificationInbox.mock.calls).toEqual([[{ id: "s", cwd: "/a" }, "local"], [{ id: "s", cwd: "/a" }, "local"], [{ id: "s", cwd: "/b" }, "remote"], [{ id: "s", cwd: "/other" }, "local"], [{ id: "s", cwd: "/a" }, "local"]]);
    expect(harness.api.dismissNotification).toHaveBeenCalledOnce();
    expect(harness.api.dismissAllNotifications).not.toHaveBeenCalled();
  });

  it.each([
    ["machine", "remote", { ...session }],
    ["cwd", "local", { ...session, cwd: "/other" }],
    ["session ID", "local", { ...session, id: "other" }],
  ] as const)("rejects a read and event differing only in %s", async (_field, machineId, other) => {
    const remote: Machine = { ...localMachine, id: "remote", kind: "remote", baseUrl: "https://remote.example.test/" };
    const harness = createHarness({ ...capableState(), machines: [localMachine, remote], machineRuntimes: { local: runtimeWithVersion(), remote: runtimeWithVersion("1", "remote") } });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const before = harness.state.selectedNotificationInbox;
    await harness.controller.refreshSelectedSession(other, machineId);
    harness.controller.applyInboxEvent(machineId, { ...addedEvent(entry(2), 2, 2), summary: { ...addedEvent(entry(2), 2, 2).summary, sessionId: other.id, cwd: other.cwd } });
    expect(harness.api.notificationInbox).toHaveBeenCalledOnce();
    expect(harness.state.selectedNotificationInbox).toBe(before);
    expect(harness.controller.failureMessage).toBeUndefined();
  });

  it.each(["runtime-close", "archive"] as const)("applies a %s clear event without a new request or snapshot announcement", async (reason) => {
    const harness = createHarness();
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    harness.controller.applyInboxEvent("local", parseSessionNotificationInboxEvent({
      type: "notifications.inbox",
      ...inboxSnapshot([], { inboxRevision: 2 }),
      delta: { kind: "cleared", reason },
    }));
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toMatchObject({ notifications: [], retainedCount: 0, discardedCount: 0, announcements: [] });
    expect(harness.api.notificationInbox).toHaveBeenCalledOnce();
  });

  it("keeps an initial failure unavailable and a background failure fresh only with a valid base", async () => {
    const pending = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn<SessionNotificationApi["notificationInbox"]>()
      .mockRejectedValueOnce(new Error("initial read failed"))
      .mockResolvedValueOnce(inboxSnapshot([entry(1)]))
      .mockImplementationOnce(() => pending.promise);
    const harness = createHarness(capableState(), { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    expect(harness.state.selectedNotificationInbox?.status).toBe("stale");
    expect(harness.controller.inboxOperation).toBeUndefined();
    expect(harness.controller.failureMessage).toContain("initial read failed");
    await harness.controller.refreshSelectedSession(session, "local");
    const background = harness.controller.refreshSelectedSession(session, "local");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.retainedCount).toBe(1);
    pending.reject(new Error("background failure"));
    await background;
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.retainedCount).toBe(1);
    expect(harness.controller.failureMessage).toContain("background failure");
    expect(harness.controller.inboxOperation).toBeUndefined();
  });

  it("keeps severity-only announcement identities bounded after 100 accepted live additions", async () => {
    const harness = createHarness(capableState(), { notificationInbox: vi.fn(() => Promise.resolve(inboxSnapshot([]))) });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    for (let order = 1; order <= 101; order += 1) {
      const severity = order === 101 ? "error" : "info";
      const event = addedEvent(entry(order, severity), order + 1, Math.min(order, 100));
      if (order > 100) {
        event.summary.discardedCount = 1;
        event.dismissThrough.overflowWatermark = 1;
        event.delta = { kind: "added", notification: entry(order, severity), evictedNotificationId: entry(1).id };
      }
      harness.controller.applyInboxEvent("local", parseSessionNotificationInboxEvent(event));
    }
    const announcements = harness.state.selectedNotificationInbox?.announcements;
    expect(announcements).toHaveLength(100);
    expect(announcements?.[0]).toEqual({ id: `local:${session.cwd}:${session.id}:daemon-a:daemon-a:2`, severity: "info" });
    expect(announcements?.[99]).toEqual({ id: `local:${session.cwd}:${session.id}:daemon-a:daemon-a:101`, severity: "error" });
    expect(new Set(announcements?.map((announcement) => announcement.id)).size).toBe(100);
    expect(harness.api.notificationInbox).toHaveBeenCalledOnce();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (resolveDeferred === undefined || rejectDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}
