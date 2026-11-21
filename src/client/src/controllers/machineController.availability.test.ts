import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { api, type Machine, type MachineHealth, type MachineRuntime } from "../api";
import { initialAppState, type AppState } from "../appState";
import { deriveNotificationPresentation } from "../notificationPresentation";
import { PI_WEBUI_CAPABILITIES, type SessionInfo, type SessionNotificationInboxSnapshot } from "../../../shared/apiTypes";
import { MachineController } from "./machineController";
import { SessionNotificationController } from "./sessionNotificationController";

const local: Machine = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: "now",
  updatedAt: "now",
};
const remote: Machine = {
  id: "remote",
  name: "Remote",
  kind: "remote",
  baseUrl: "https://remote.example.test",
  createdAt: "now",
  updatedAt: "now",
};
const session: SessionInfo = {
  id: "selected",
  cwd: "/repo",
  path: "/sessions/selected.jsonl",
  created: "now",
  modified: "now",
  messageCount: 0,
  firstMessage: "Selected session",
};
const snapshot: SessionNotificationInboxSnapshot = {
  daemonInstanceId: "daemon-current",
  catalogRevision: 1,
  summary: {
    sessionId: session.id,
    cwd: session.cwd,
    inboxRevision: 1,
    retainedCount: 1,
    discardedCount: 0,
    highestSeverity: "info",
  },
  notifications: [{
    id: "daemon-current:1",
    order: 1,
    severity: "info",
    message: "Current notification",
    truncated: false,
    receivedAt: "2026-11-18T12:00:00.000Z",
  }],
  dismissThrough: { order: 1, overflowWatermark: 0 },
};

function health(checkedAt: string, online: boolean, machineId = remote.id): MachineHealth {
  return { machineId, checkedAt, ok: online, status: online ? "online" : "offline" };
}

function runtime(checkedAt: string, supported: boolean, machineId = remote.id): MachineRuntime {
  const capabilities = supported ? [PI_WEBUI_CAPABILITIES.sessionsNotifications] : [];
  return {
    machineId,
    checkedAt,
    ok: true,
    packageName: "@hyperdreamer/pi-webui",
    capabilities,
    components: {
      web: { component: "web", label: "Web", runtimeVersion: supported ? "2" : "1", available: true, capabilities },
      sessiond: { component: "sessiond", label: "Daemon", runtimeVersion: supported ? "2" : "1", available: true, capabilities },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

// loadMachines detaches its bulk reads. A new event-loop turn drains their
// resolved promise continuations, including the aggregate publication.
function flushBackgroundReads(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function harness(initialState = initialAppState()) {
  let state: AppState = initialState;
  const setState = (patch: Partial<AppState>) => {
    const previous = state;
    state = { ...state, ...patch };
    notifications.syncEnvironment(previous, state);
  };
  const notifications = new SessionNotificationController(() => state, setState, {
    api: {
      notificationInbox: vi.fn(() => Promise.resolve(snapshot)),
      dismissNotification: vi.fn(() => Promise.resolve(snapshot)),
      dismissAllNotifications: vi.fn(() => Promise.resolve(snapshot)),
    },
  });
  onTestFinished(() => { notifications.dispose(); });
  const machines = new MachineController(() => state, setState, vi.fn(), { loadProjects: vi.fn() });
  const presentation = () => deriveNotificationPresentation({
    selectedSession: state.selectedSession,
    selectedMachine: state.selectedMachine,
    machineHealth: state.machineStatuses[remote.id],
    machineRuntime: state.machineRuntimes[remote.id],
    acceptedSupport: notifications.acceptedSupportFor(remote.id),
    runtimeGeneration: notifications.runtimeGenerationFor(remote.id),
    selectionGeneration: notifications.selectionGeneration,
    inbox: state.selectedNotificationInbox,
    operation: notifications.inboxOperation,
    isClientPendingStart: false,
  });
  return {
    machines,
    notifications,
    presentation,
    get state() { return state; },
    select() {
      setState({ selectedSession: session, sessions: [session] });
      notifications.prepareSelectedSession(session, remote.id);
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("MachineController startup availability", () => {
  it.each(["bulk-first", "bulk-last", "aggregate-held"] as const)("preserves recovered notification health with %s completion", async (order) => {
    const bulk = deferred<MachineHealth>();
    const sibling = deferred<MachineHealth>();
    vi.spyOn(api, "machines").mockResolvedValue(order === "aggregate-held" ? [remote, local] : [remote]);
    vi.spyOn(api, "health")
      .mockResolvedValueOnce(health("route-offline", false))
      .mockReturnValueOnce(bulk.promise)
      .mockImplementation((machineId) => machineId === local.id ? sibling.promise : Promise.resolve(health("new-recovery", true)));
    vi.spyOn(api, "runtime").mockImplementation((machineId) => Promise.resolve(runtime("current", true, machineId)));
    const app = harness();
    await app.machines.loadMachines(remote.id);
    app.select();
    expect(app.presentation().kind).toBe("offline");

    if (order !== "bulk-last") {
      bulk.resolve(health("old-bulk", false));
      await flushBackgroundReads();
      if (order === "aggregate-held") expect(app.state.machineStatuses[remote.id]?.checkedAt).toBe("route-offline");
    }
    expect(await app.machines.refreshMachineHealth(remote.id, { isCurrent: () => true })).toEqual(health("new-recovery", true));
    await app.notifications.refreshSelectedSession(session, remote.id);
    expect(app.presentation().kind).toBe("fresh");

    if (order === "bulk-last") bulk.resolve(health("old-bulk", false));
    if (order === "aggregate-held") sibling.resolve(health("sibling-settled", true, local.id));
    await flushBackgroundReads();

    expect(app.presentation()).toMatchObject({ kind: "fresh", view: { retainedCount: 1, notifications: [{ message: "Current notification" }] } });
    expect(app.state.machineStatuses[remote.id]?.checkedAt).toBe("new-recovery");
    if (order === "aggregate-held") expect(app.state.machineStatuses[local.id]?.checkedAt).toBe("sibling-settled");
  });

  it.each(["bulk-first", "bulk-last", "aggregate-held"] as const)("preserves recovered notification runtime with %s completion", async (order) => {
    const bulk = deferred<MachineRuntime>();
    const sibling = deferred<MachineRuntime>();
    vi.spyOn(api, "machines").mockResolvedValue(order === "aggregate-held" ? [remote, local] : [remote]);
    vi.spyOn(api, "health").mockImplementation((machineId) => Promise.resolve(health("online", true, machineId)));
    vi.spyOn(api, "runtime")
      .mockReturnValueOnce(bulk.promise)
      .mockImplementation((machineId) => machineId === local.id ? sibling.promise : Promise.resolve(runtime("new-recovery", true)));
    const app = harness();
    await app.machines.loadMachines(remote.id);
    app.select();
    expect(app.presentation().kind).toBe("capability-unavailable");

    if (order !== "bulk-last") {
      bulk.resolve(runtime("old-bulk", false));
      await flushBackgroundReads();
      if (order === "aggregate-held") expect(app.state.machineRuntimes[remote.id]).toBeUndefined();
    }
    expect(await app.machines.refreshMachineRuntime(remote.id, { isCurrent: () => true })).toEqual(runtime("new-recovery", true));
    await app.notifications.refreshSelectedSession(session, remote.id);
    expect(app.presentation().kind).toBe("fresh");

    if (order === "bulk-last") bulk.resolve(runtime("old-bulk", false));
    if (order === "aggregate-held") sibling.resolve(runtime("sibling-settled", true, local.id));
    await flushBackgroundReads();

    expect(app.presentation()).toMatchObject({ kind: "fresh", view: { retainedCount: 1, notifications: [{ message: "Current notification" }] } });
    expect(app.state.machineRuntimes[remote.id]?.checkedAt).toBe("new-recovery");
    if (order === "aggregate-held") expect(app.state.machineRuntimes[local.id]?.checkedAt).toBe("sibling-settled");
  });

  it.each([
    ["health", "single-first"],
    ["health", "single-last"],
    ["runtime", "single-first"],
    ["runtime", "single-last"],
  ] as const)("supersedes an older single-machine %s read when startup begins with %s completion", async (kind, order) => {
    const older = deferred<MachineHealth & MachineRuntime>();
    const bulk = deferred<MachineHealth & MachineRuntime>();
    const oldObservation: MachineHealth & MachineRuntime = { machineId: local.id, ok: true, checkedAt: "old-single", status: "online", capabilities: [] };
    const currentObservation = { ...oldObservation, checkedAt: "new-startup" };
    vi.spyOn(api, "machines").mockResolvedValue([local]);
    vi.spyOn(api, "health").mockResolvedValue(health("other-boundary", true, local.id));
    vi.spyOn(api, "runtime").mockResolvedValue(runtime("other-boundary", true, local.id));
    vi.spyOn(api, kind).mockReturnValueOnce(older.promise).mockReturnValueOnce(bulk.promise);
    const app = harness({ ...initialAppState(), machines: [local], selectedMachine: local });

    const reading = kind === "health" ? app.machines.refreshMachineHealth(local.id) : app.machines.refreshMachineRuntime(local.id);
    await app.machines.loadMachines();
    if (order === "single-first") {
      older.resolve(oldObservation);
      expect(await reading).toBeUndefined();
      expect(kind === "health" ? app.state.machineStatuses[local.id] : app.state.machineRuntimes[local.id]).toBeUndefined();
    }
    bulk.resolve(currentObservation);
    await flushBackgroundReads();
    expect(kind === "health" ? app.state.machineStatuses[local.id] : app.state.machineRuntimes[local.id]).toEqual(currentObservation);
    if (order === "single-last") {
      older.resolve(oldObservation);
      expect(await reading).toBeUndefined();
    }
    expect(kind === "health" ? app.state.machineStatuses[local.id] : app.state.machineRuntimes[local.id]).toEqual(currentObservation);
    expect(app.state.error).toBe("");
  });

  it.each([
    ["health", "removed"],
    ["health", "replaced"],
    ["runtime", "removed"],
    ["runtime", "replaced"],
  ] as const)("discards a settled startup %s observation for a %s machine while its aggregate is held", async (kind, change) => {
    const bulk = deferred<MachineHealth & MachineRuntime>();
    const sibling = deferred<MachineHealth & MachineRuntime>();
    vi.spyOn(api, "machines").mockResolvedValue([remote, local]);
    vi.spyOn(api, "health").mockImplementation((machineId) => Promise.resolve(health("other-boundary", true, machineId)));
    vi.spyOn(api, "runtime").mockImplementation((machineId) => Promise.resolve(runtime("other-boundary", true, machineId)));
    vi.spyOn(api, kind).mockImplementation((machineId: string) => machineId === remote.id ? bulk.promise : sibling.promise);
    vi.spyOn(api, "deleteMachine").mockResolvedValue({ deleted: true });
    const replacement = { ...remote, baseUrl: "https://replacement.example.test", updatedAt: "after-startup" };
    vi.spyOn(api, "updateMachine").mockResolvedValue(replacement);
    const app = harness();
    await app.machines.loadMachines();

    bulk.resolve({ machineId: remote.id, ok: true, checkedAt: "retired-record", status: "online", capabilities: [] });
    await flushBackgroundReads();
    expect(kind === "health" ? app.state.machineStatuses[remote.id] : app.state.machineRuntimes[remote.id]).toBeUndefined();
    if (change === "removed") await app.machines.deleteMachine(remote);
    else await app.machines.updateMachine(remote.id, { baseUrl: replacement.baseUrl });
    sibling.resolve({ machineId: local.id, ok: true, checkedAt: "sibling-settled", status: "online", capabilities: [] });
    await flushBackgroundReads();

    expect(kind === "health" ? app.state.machineStatuses[remote.id] : app.state.machineRuntimes[remote.id]).toBeUndefined();
    expect(kind === "health" ? app.state.machineStatuses[local.id]?.checkedAt : app.state.machineRuntimes[local.id]?.checkedAt).toBe("sibling-settled");
    expect(app.state.machines).toEqual(change === "removed" ? [local] : [replacement, local]);
    expect(app.state.error).toBe("");
  });

  it.each(["health", "runtime"] as const)("publishes successful startup %s observations after another machine rejects without reporting a global error", async (kind) => {
    const bulk = deferred<MachineHealth & MachineRuntime>();
    const sibling = deferred<MachineHealth & MachineRuntime>();
    vi.spyOn(api, "machines").mockResolvedValue([remote, local]);
    vi.spyOn(api, "health").mockImplementation((machineId) => Promise.resolve(health("other-boundary", true, machineId)));
    vi.spyOn(api, "runtime").mockImplementation((machineId) => Promise.resolve(runtime("other-boundary", true, machineId)));
    vi.spyOn(api, kind).mockImplementation((machineId: string) => machineId === remote.id ? bulk.promise : sibling.promise);
    const app = harness();
    await app.machines.loadMachines();

    bulk.resolve({ machineId: remote.id, ok: true, checkedAt: "successful-startup", status: "online", capabilities: [] });
    await flushBackgroundReads();
    expect(kind === "health" ? app.state.machineStatuses[remote.id] : app.state.machineRuntimes[remote.id]).toBeUndefined();
    sibling.reject(new Error("Other machine unavailable"));
    await flushBackgroundReads();

    expect(kind === "health" ? app.state.machineStatuses[remote.id]?.checkedAt : app.state.machineRuntimes[remote.id]?.checkedAt).toBe("successful-startup");
    expect(kind === "health" ? app.state.machineStatuses[local.id] : app.state.machineRuntimes[local.id]).toBeUndefined();
    expect(app.state.error).toBe("");
  });
});
