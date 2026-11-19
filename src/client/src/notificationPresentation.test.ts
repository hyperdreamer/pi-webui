import { describe, expect, it } from "vitest";
import {
  PI_WEBUI_CAPABILITIES,
  type Machine,
  type MachineHealth,
  type MachineRuntime,
  type SessionInfo,
  type SessionNotification,
  type SessionNotificationInboxSnapshot,
} from "../../shared/apiTypes";
import {
  deriveNotificationPresentation,
  type NotificationPresentationInputs,
} from "./notificationPresentation";
import {
  installSelectedNotificationSnapshot,
  type SelectedSessionNotificationInbox,
  type SessionNotificationTarget,
} from "./sessionNotifications";

const time = "2026-11-18T00:00:00.000Z";
const localMachine: Machine = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: time,
  updatedAt: time,
};
const remoteMachine: Machine = {
  ...localMachine,
  id: "remote",
  name: "Remote",
  kind: "remote",
};
const session: SessionInfo = {
  id: "s",
  cwd: "/a",
  path: "/a/s.jsonl",
  created: time,
  modified: time,
  messageCount: 0,
  firstMessage: "",
};
const targetA: SessionNotificationTarget = { machineId: "local", sessionId: "s", cwd: "/a" };
const targetB: SessionNotificationTarget = { machineId: "remote", sessionId: "s", cwd: "/b" };
const targetC: SessionNotificationTarget = { machineId: "local", sessionId: "s", cwd: "/other" };
const targetDifferentSession: SessionNotificationTarget = { machineId: "local", sessionId: "other", cwd: "/a" };
const onlineHealth: MachineHealth = { machineId: "remote", ok: true, status: "online", checkedAt: time };
const supportedRuntime: MachineRuntime = {
  machineId: "local",
  ok: true,
  checkedAt: time,
  capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications],
};
const unsupportedRuntime: MachineRuntime = {
  ...supportedRuntime,
  capabilities: [],
};
const notification: SessionNotification = {
  id: "d1:1",
  message: "Build finished",
  truncated: false,
  severity: "info",
  receivedAt: time,
  order: 1,
};

function snapshot(
  target: SessionNotificationTarget,
  overrides: Partial<SessionNotificationInboxSnapshot> = {},
): SessionNotificationInboxSnapshot {
  const notifications = overrides.notifications ?? [];
  return {
    daemonInstanceId: "d1",
    catalogRevision: 1,
    summary: {
      sessionId: target.sessionId,
      cwd: target.cwd,
      inboxRevision: 1,
      retainedCount: notifications.length,
      discardedCount: 0,
      ...(notifications.length === 0 ? {} : { highestSeverity: "info" as const }),
    },
    notifications,
    dismissThrough: { order: notifications[0]?.order ?? 0, overflowWatermark: 0 },
    ...overrides,
  };
}

function freshInbox(target: SessionNotificationTarget = targetA): SelectedSessionNotificationInbox {
  return installSelectedNotificationSnapshot(undefined, target, snapshot(target, { notifications: [notification] }));
}

function inputs(patch: Partial<NotificationPresentationInputs> = {}): NotificationPresentationInputs {
  return {
    selectedSession: session,
    selectedMachine: localMachine,
    machineHealth: undefined,
    machineRuntime: supportedRuntime,
    acceptedSupport: undefined,
    runtimeGeneration: 4,
    selectionGeneration: 7,
    inbox: undefined,
    operation: undefined,
    isClientPendingStart: false,
    ...patch,
  };
}

describe("deriveNotificationPresentation", () => {
  it("rejects incomplete, archived, and client-pending selections", () => {
    expect(deriveNotificationPresentation(inputs({ selectedSession: undefined }))).toEqual({ kind: "ineligible" });
    expect(deriveNotificationPresentation(inputs({ selectedMachine: undefined }))).toEqual({ kind: "ineligible" });
    expect(deriveNotificationPresentation(inputs({ selectedSession: { ...session, id: "" } }))).toEqual({ kind: "ineligible" });
    expect(deriveNotificationPresentation(inputs({ selectedSession: { ...session, cwd: "" } }))).toEqual({ kind: "ineligible" });
    expect(deriveNotificationPresentation(inputs({ selectedSession: { ...session, archived: true } }))).toEqual({ kind: "ineligible" });
    expect(deriveNotificationPresentation(inputs({ isClientPendingStart: true }))).toEqual({ kind: "ineligible" });
  });

  it("uses the selected machine and session to build the full target", () => {
    const result = deriveNotificationPresentation(inputs({
      selectedMachine: remoteMachine,
      selectedSession: { ...session, cwd: "/b" },
      machineRuntime: { ...supportedRuntime, machineId: "remote" },
      inbox: freshInbox(targetB),
    }));

    expect(result).toMatchObject({ kind: "fresh", target: targetB });
  });

  it("prioritizes explicitly unreachable remote machines over capability and inbox state", () => {
    for (const status of ["offline", "error"] as const) {
      const result = deriveNotificationPresentation(inputs({
        selectedMachine: remoteMachine,
        selectedSession: { ...session, cwd: "/b" },
        machineHealth: { ...onlineHealth, ok: false, status },
        machineRuntime: undefined,
        inbox: freshInbox(targetB),
      }));

      expect(result).toEqual({ kind: "offline", target: targetB, operation: "idle" });
    }
  });

  it("keeps remote unknown and local machines reachable", () => {
    expect(deriveNotificationPresentation(inputs({
      selectedMachine: { ...remoteMachine, status: "unknown" },
      selectedSession: { ...session, cwd: "/b" },
      machineHealth: undefined,
      machineRuntime: { ...supportedRuntime, machineId: "remote" },
    })).kind).toBe("unavailable");

    expect(deriveNotificationPresentation(inputs({
      machineHealth: { machineId: "local", ok: false, status: "offline", checkedAt: time },
      inbox: freshInbox(),
    })).kind).toBe("fresh");
  });

  it("ignores health and runtime observations for a different machine", () => {
    const result = deriveNotificationPresentation(inputs({
      selectedMachine: remoteMachine,
      selectedSession: { ...session, cwd: "/b" },
      machineHealth: { machineId: "local", ok: false, status: "offline", checkedAt: time },
      machineRuntime: supportedRuntime,
    }));

    expect(result).toEqual({ kind: "capability-unavailable", target: targetB, operation: "idle" });
  });

  it("accepts current-generation capability negotiation and accepted support", () => {
    expect(deriveNotificationPresentation(inputs({ inbox: freshInbox() })).kind).toBe("fresh");
    expect(deriveNotificationPresentation(inputs({
      machineRuntime: undefined,
      acceptedSupport: { runtimeGeneration: 4, daemonInstanceId: "d1" },
      inbox: freshInbox(),
    })).kind).toBe("fresh");
    expect(deriveNotificationPresentation(inputs({
      machineRuntime: undefined,
      acceptedSupport: { runtimeGeneration: 4 },
      inbox: undefined,
    }))).toEqual({ kind: "unavailable", target: targetA, operation: "idle" });
  });

  it("requires accepted daemon evidence to match the selected inbox daemon", () => {
    const mismatchedDaemonInbox = installSelectedNotificationSnapshot(undefined, targetA, snapshot(targetA, {
      daemonInstanceId: "d2",
      notifications: [notification],
    }));

    expect(deriveNotificationPresentation(inputs({
      machineRuntime: undefined,
      acceptedSupport: { runtimeGeneration: 4, daemonInstanceId: "d1" },
      inbox: mismatchedDaemonInbox,
    }))).toEqual({ kind: "unavailable", target: targetA, operation: "idle" });

    expect(deriveNotificationPresentation(inputs({
      machineRuntime: undefined,
      acceptedSupport: { runtimeGeneration: 4, daemonInstanceId: "d2" },
      inbox: mismatchedDaemonInbox,
    })).kind).toBe("fresh");
  });

  it("rejects a fresh inbox from a daemon that conflicts with current accepted evidence", () => {
    const result = deriveNotificationPresentation(inputs({
      acceptedSupport: { runtimeGeneration: 4, daemonInstanceId: "d2" },
      inbox: freshInbox(),
    }));

    expect(result).toEqual({ kind: "unavailable", target: targetA, operation: "idle" });
    expect(result).not.toHaveProperty("view");
  });

  it("keeps replacement support and the admitted loading state despite stale old-daemon data", () => {
    const staleOldDaemonInbox = { ...freshInbox(), status: "stale" as const };
    const operation = { target: targetA, selectionGeneration: 7, kind: "loading-inbox" as const };

    for (const machineRuntime of [undefined, unsupportedRuntime]) {
      expect(deriveNotificationPresentation(inputs({
        machineRuntime,
        acceptedSupport: { runtimeGeneration: 4, daemonInstanceId: "d2" },
        inbox: staleOldDaemonInbox,
        operation,
      }))).toEqual({ kind: "loading", target: targetA, operation: "loading-inbox" });
    }
  });

  it("does not use stale accepted evidence or failed and absent runtime negotiation", () => {
    for (const patch of [
      { machineRuntime: undefined, acceptedSupport: { runtimeGeneration: 3, daemonInstanceId: "d1" } },
      { machineRuntime: { ...supportedRuntime, ok: false }, acceptedSupport: undefined },
      { machineRuntime: undefined, acceptedSupport: undefined },
    ]) {
      expect(deriveNotificationPresentation(inputs(patch))).toEqual({
        kind: "capability-unavailable",
        target: targetA,
        operation: "idle",
      });
    }
  });

  it("reports a successful runtime without notification support as unsupported", () => {
    expect(deriveNotificationPresentation(inputs({
      machineRuntime: unsupportedRuntime,
      inbox: freshInbox(),
    }))).toEqual({ kind: "unsupported", target: targetA });
  });

  it("keeps current accepted support authoritative over a successful unsupported runtime", () => {
    expect(deriveNotificationPresentation(inputs({
      machineRuntime: unsupportedRuntime,
      acceptedSupport: { runtimeGeneration: 4, daemonInstanceId: "d1" },
      inbox: freshInbox(),
    })).kind).toBe("fresh");
  });

  it("shows a current capability check only while its matching operation is active", () => {
    expect(deriveNotificationPresentation(inputs({
      machineRuntime: undefined,
      operation: { target: targetA, selectionGeneration: 7, kind: "checking-capability" },
    }))).toEqual({ kind: "capability-unavailable", target: targetA, operation: "checking-capability" });

    expect(deriveNotificationPresentation(inputs({
      machineRuntime: undefined,
      operation: { target: targetA, selectionGeneration: 7, kind: "loading-inbox" },
    }))).toEqual({ kind: "capability-unavailable", target: targetA, operation: "idle" });

    expect(deriveNotificationPresentation(inputs({
      machineRuntime: undefined,
      operation: { target: targetA, selectionGeneration: 6, kind: "checking-capability" },
    }))).toEqual({ kind: "capability-unavailable", target: targetA, operation: "idle" });
  });

  it("preserves a current health check when an explicitly offline remote is retried", () => {
    expect(deriveNotificationPresentation(inputs({
      selectedMachine: remoteMachine,
      selectedSession: { ...session, cwd: "/b" },
      machineHealth: { ...onlineHealth, ok: false, status: "offline" },
      machineRuntime: undefined,
      operation: { target: targetB, selectionGeneration: 7, kind: "checking-health" },
    }))).toEqual({ kind: "offline", target: targetB, operation: "checking-health" });
  });

  it("requires a fresh inbox to match machine, cwd, and session ID exactly", () => {
    const mismatches: { selectedMachine?: Machine; selectedSession?: SessionInfo; machineRuntime?: MachineRuntime }[] = [
      { selectedMachine: remoteMachine, selectedSession: { ...session, cwd: "/b" }, machineRuntime: { ...supportedRuntime, machineId: "remote" } },
      { selectedSession: { ...session, cwd: "/other" } },
      { selectedSession: { ...session, id: "other" } },
    ];

    for (const mismatch of mismatches) {
      const result = deriveNotificationPresentation(inputs({
        ...mismatch,
        inbox: freshInbox(),
      }));
      expect(result.kind).toBe("unavailable");
      expect(result).not.toHaveProperty("view");
    }

    expect(deriveNotificationPresentation(inputs({ inbox: freshInbox(targetC) })).kind).toBe("unavailable");
    expect(deriveNotificationPresentation(inputs({ inbox: freshInbox(targetDifferentSession) })).kind).toBe("unavailable");
  });

  it("shows fresh data only for a current matching snapshot", () => {
    const inbox = freshInbox();
    const result = deriveNotificationPresentation(inputs({ inbox }));

    expect(result).toMatchObject({ kind: "fresh", target: targetA });
    if (result.kind === "fresh") {
      expect(result.view.notifications).toEqual([notification]);
      expect(result.view.machineId).toBe(targetA.machineId);
      expect(result.view.cwd).toBe(targetA.cwd);
      expect(result.view.sessionId).toBe(targetA.sessionId);
    }
  });

  it("shows stale, missing, and nominally loading inboxes as unavailable without an admitted read", () => {
    const fresh = freshInbox();
    const stale = { ...fresh, status: "stale" as const };
    const nominalLoading = { ...fresh, status: "loading" as const };

    for (const inbox of [undefined, stale, nominalLoading]) {
      const result = deriveNotificationPresentation(inputs({ inbox }));
      expect(result).toEqual({ kind: "unavailable", target: targetA, operation: "idle" });
      expect(result).not.toHaveProperty("view");
    }
  });

  it("shows loading only for a current matching inbox operation", () => {
    const staleInbox = { ...freshInbox(), status: "stale" as const };
    const currentRead = { target: targetA, selectionGeneration: 7, kind: "loading-inbox" as const };

    expect(deriveNotificationPresentation(inputs({
      inbox: staleInbox,
      operation: currentRead,
    }))).toEqual({ kind: "loading", target: targetA, operation: "loading-inbox" });

    for (const operation of [
      { target: targetB, selectionGeneration: 7, kind: "loading-inbox" as const },
      { target: targetC, selectionGeneration: 7, kind: "loading-inbox" as const },
      { target: targetDifferentSession, selectionGeneration: 7, kind: "loading-inbox" as const },
      { target: targetA, selectionGeneration: 6, kind: "loading-inbox" as const },
    ]) {
      expect(deriveNotificationPresentation(inputs({ inbox: staleInbox, operation }))).toEqual({
        kind: "unavailable",
        target: targetA,
        operation: "idle",
      });
    }
  });

  it("keeps a current fresh view visible while any background operation runs", () => {
    for (const kind of ["checking-health", "checking-capability", "loading-inbox"] as const) {
      const result = deriveNotificationPresentation(inputs({
        inbox: freshInbox(),
        operation: { target: targetA, selectionGeneration: 7, kind },
      }));

      expect(result.kind).toBe("fresh");
      if (result.kind === "fresh") expect(result.operation).toBe(kind);
    }
  });

  it("retains current health and capability operation indicators without reviving stale rows", () => {
    for (const kind of ["checking-health", "checking-capability"] as const) {
      const result = deriveNotificationPresentation(inputs({
        inbox: { ...freshInbox(), status: "stale" },
        operation: { target: targetA, selectionGeneration: 7, kind },
      }));

      expect(result).toEqual({ kind: "unavailable", target: targetA, operation: kind });
      expect(result).not.toHaveProperty("view");
    }
  });
});
