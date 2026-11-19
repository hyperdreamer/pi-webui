import { PI_WEBUI_CAPABILITIES } from "../../shared/apiTypes";
import { supportsPiWebUiCapability } from "../../shared/capabilities";
import type { Machine, MachineHealth, MachineRuntime, SessionInfo } from "./api";
import {
  notificationTargetsEqual,
  selectedNotificationView,
  type SelectedSessionNotificationInbox,
  type SelectedSessionNotificationView,
  type SessionNotificationTarget,
} from "./sessionNotifications";

export type NotificationCapability = "unknown" | "supported" | "unsupported";
export type NotificationOperation = "idle" | "checking-health" | "checking-capability" | "loading-inbox";

export interface AcceptedNotificationSupport {
  runtimeGeneration: number;
  daemonInstanceId?: string;
}

export interface NotificationOperationRecord {
  target: SessionNotificationTarget;
  selectionGeneration: number;
  kind: Exclude<NotificationOperation, "idle">;
}

export interface NotificationPresentationInputs {
  selectedSession: SessionInfo | undefined;
  selectedMachine: Machine | undefined;
  machineHealth: MachineHealth | undefined;
  machineRuntime: MachineRuntime | undefined;
  acceptedSupport: AcceptedNotificationSupport | undefined;
  runtimeGeneration: number;
  selectionGeneration: number;
  inbox: SelectedSessionNotificationInbox | undefined;
  operation: NotificationOperationRecord | undefined;
  isClientPendingStart: boolean;
}

export type NotificationPresentation =
  | { kind: "ineligible" }
  | { kind: "offline"; target: SessionNotificationTarget; operation: NotificationOperation }
  | { kind: "capability-unavailable"; target: SessionNotificationTarget; operation: NotificationOperation }
  | { kind: "unsupported"; target: SessionNotificationTarget }
  | { kind: "loading"; target: SessionNotificationTarget; operation: NotificationOperation }
  | { kind: "unavailable"; target: SessionNotificationTarget; operation: NotificationOperation }
  | { kind: "fresh"; target: SessionNotificationTarget; view: SelectedSessionNotificationView; operation: NotificationOperation };

export function deriveNotificationPresentation(input: NotificationPresentationInputs): NotificationPresentation {
  const { selectedMachine, selectedSession } = input;
  if (selectedMachine === undefined
    || selectedMachine.id.length === 0
    || selectedSession === undefined
    || selectedSession.id.length === 0
    || selectedSession.cwd.length === 0
    || selectedSession.archived === true
    || input.isClientPendingStart) {
    return { kind: "ineligible" };
  }

  const target: SessionNotificationTarget = {
    machineId: selectedMachine.id,
    sessionId: selectedSession.id,
    cwd: selectedSession.cwd,
  };
  const currentOperation = operationForTarget(input, target);

  if (!isMachineReachable(selectedMachine, input.machineHealth)) {
    return {
      kind: "offline",
      target,
      operation: currentOperation === "checking-health" ? currentOperation : "idle",
    };
  }

  const runtime = input.machineRuntime?.machineId === selectedMachine.id ? input.machineRuntime : undefined;
  const acceptedSupport = hasCurrentAcceptedSupport(input);
  const runtimeSupportsNotifications = runtime?.ok === true
    && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsNotifications);

  let capability: NotificationCapability;
  if (acceptedSupport || runtimeSupportsNotifications) {
    capability = "supported";
  } else if (runtime?.ok === true) {
    capability = "unsupported";
  } else {
    capability = "unknown";
  }

  if (capability === "unsupported") return { kind: "unsupported", target };
  if (capability === "unknown") {
    const capabilityOperation = currentOperation === "loading-inbox" ? "idle" : currentOperation ?? "idle";
    return { kind: "capability-unavailable", target, operation: capabilityOperation };
  }

  const inboxMatchesTarget = input.inbox !== undefined && notificationTargetsEqual(input.inbox, target);
  const acceptedDaemonId = input.acceptedSupport?.runtimeGeneration === input.runtimeGeneration
    ? input.acceptedSupport.daemonInstanceId
    : undefined;
  const inboxMatchesAcceptedDaemon = acceptedDaemonId === undefined
    || input.inbox?.daemonInstanceId === acceptedDaemonId;
  const view = inboxMatchesTarget && inboxMatchesAcceptedDaemon ? selectedNotificationView(input.inbox) : undefined;
  if (view !== undefined && notificationTargetsEqual(view, target)) {
    return { kind: "fresh", target, view, operation: currentOperation ?? "idle" };
  }

  if (currentOperation === "loading-inbox") {
    return { kind: "loading", target, operation: currentOperation };
  }

  return { kind: "unavailable", target, operation: currentOperation ?? "idle" };
}

function operationForTarget(input: NotificationPresentationInputs, target: SessionNotificationTarget): NotificationOperationRecord["kind"] | undefined {
  const operation = input.operation;
  if (operation?.selectionGeneration !== input.selectionGeneration) return undefined;
  if (!notificationTargetsEqual(operation.target, target)) return undefined;
  return operation.kind;
}

function hasCurrentAcceptedSupport(input: NotificationPresentationInputs): boolean {
  return input.acceptedSupport?.runtimeGeneration === input.runtimeGeneration;
}

function isMachineReachable(machine: Machine, health: MachineHealth | undefined): boolean {
  if (machine.id === "local" || machine.kind === "local") return true;

  const healthStatus = health?.machineId === machine.id ? health.status : undefined;
  const status = healthStatus ?? machine.status;
  return status === undefined || status === "unknown" || status === "online";
}
