import { api as defaultApi, type Machine, type SessionInfo } from "../api";
import type { AppState } from "../appState";
import {
  applySelectedNotificationEvent,
  installSelectedNotificationSnapshot,
  loadingSelectedNotificationInbox,
  notificationTargetsEqual,
  selectedNotificationView,
  type SelectedSessionNotificationInbox,
  type SessionNotificationTarget,
} from "../sessionNotifications";
import { PI_WEBUI_CAPABILITIES, supportsPiWebUiCapability } from "../../../shared/capabilities";
import {
  SESSION_NOTIFICATION_LIMIT,
  type SessionNotificationInboxEvent,
  type SessionNotificationInboxSnapshot,
  type SessionRef,
} from "../../../shared/apiTypes";
import type { AcceptedNotificationSupport, NotificationOperationRecord } from "../notificationPresentation";
import type { GetState, SetState } from "./types";

export interface SessionNotificationApi {
  notificationInbox: typeof defaultApi.notificationInbox;
  dismissNotification: typeof defaultApi.dismissNotification;
  dismissAllNotifications: typeof defaultApi.dismissAllNotifications;
}

export interface SessionNotificationControllerDependencies {
  api?: SessionNotificationApi;
  onBackgroundError?: (message: string, error: unknown) => void;
  onProjectionChange?: () => void;
  isCheckingEnvironment?: (target: SessionNotificationTarget, selectionGeneration: number) => boolean;
}

interface SelectedJoin {
  generation: number;
  target: SessionNotificationTarget;
  events: SessionNotificationInboxEvent[];
}

interface SelectedRefreshOperation {
  id: number;
  generation: number;
  target: SessionNotificationTarget;
  promise: Promise<void>;
  trailing: boolean;
  socketIncarnation: number | undefined;
  markerSeenAtAdmission: boolean;
}

interface SocketCoverage {
  markerSeen: boolean;
  readAdmission?: { operationId: number; markerSeen: boolean };
}

type MutationKind = "notification" | "all";

interface MutationOperation {
  id: number;
  kind: MutationKind;
  target: SessionNotificationTarget;
  generation: number;
  daemonInstanceId: string;
  notificationId?: string;
  through?: { order: number; overflowWatermark: number };
}

interface AnnouncementCursor {
  target: SessionNotificationTarget;
  daemonInstanceId: string;
  highestOrder: number;
  recentIds: string[];
}

/**
 * Owns the browser projection of the selected session's notification inbox.
 *
 * The daemon remains authoritative. This controller keeps the authoritative
 * snapshot separate from browser-owned mutation overlays so every async result
 * can be checked against the operation that admitted it before it publishes.
 */
export class SessionNotificationController {
  private readonly api: SessionNotificationApi;
  private readonly onBackgroundError: (message: string, error: unknown) => void;
  private readonly onProjectionChange: () => void;
  private readonly isCheckingEnvironment: (target: SessionNotificationTarget, selectionGeneration: number) => boolean;
  private readonly acceptedSupportByMachine = new Map<string, AcceptedNotificationSupport>();
  private readonly runtimeGenerationByMachine = new Map<string, number>();
  private readonly runtimeIdentityByMachine = new Map<string, string>();
  private readonly knownMachineIds = new Set<string>();
  private selectedTarget: SessionNotificationTarget | undefined;
  private selectedGeneration = 0;
  private selectedJoin: SelectedJoin | undefined;
  private selectedRefresh: SelectedRefreshOperation | undefined;
  private authoritativeInbox: SelectedSessionNotificationInbox | undefined;
  private announcementCursor: AnnouncementCursor | undefined;
  private currentSocketIncarnation: number | undefined;
  private readonly socketCoverage = new Map<number, SocketCoverage>();
  private readonly retiredDaemonIds = new Set<string>();
  private nextOperationId = 0;
  private readonly mutationOperations = new Map<number, MutationOperation>();
  private failure: string | undefined;
  private disposed = false;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    dependencies: SessionNotificationControllerDependencies = {},
  ) {
    this.api = dependencies.api ?? defaultApi;
    this.onBackgroundError = dependencies.onBackgroundError ?? ((message, error) => { console.warn(message, error); });
    this.onProjectionChange = dependencies.onProjectionChange ?? (() => undefined);
    this.isCheckingEnvironment = dependencies.isCheckingEnvironment ?? (() => false);
  }

  get selectionGeneration(): number {
    return this.selectedGeneration;
  }

  get inboxOperation(): NotificationOperationRecord | undefined {
    const operation = this.selectedRefresh;
    if (operation === undefined) return undefined;
    if (operation.generation !== this.selectedGeneration || !this.isCurrentTarget(operation.target, operation.generation)) return undefined;
    return { target: operation.target, selectionGeneration: operation.generation, kind: "loading-inbox" };
  }

  get failureMessage(): string | undefined {
    return this.failure;
  }

  runtimeGenerationFor(machineId: string): number {
    this.knownMachineIds.add(machineId);
    const generation = this.runtimeGenerationByMachine.get(machineId);
    if (generation !== undefined) return generation;
    this.runtimeGenerationByMachine.set(machineId, 0);
    return 0;
  }

  acceptedSupportFor(machineId: string): AcceptedNotificationSupport | undefined {
    const support = this.acceptedSupportByMachine.get(machineId);
    if (support?.runtimeGeneration !== this.runtimeGenerationFor(machineId)) return undefined;
    return { ...support };
  }

  dispose(): void {
    this.disposed = true;
    this.selectedGeneration += 1;
    this.selectedTarget = undefined;
    this.selectedJoin = undefined;
    this.selectedRefresh = undefined;
    this.authoritativeInbox = undefined;
    this.announcementCursor = undefined;
    this.currentSocketIncarnation = undefined;
    this.socketCoverage.clear();
    this.retiredDaemonIds.clear();
    this.acceptedSupportByMachine.clear();
    this.mutationOperations.clear();
    this.failure = undefined;
    this.publishProjection();
  }

  prepareSelectedSession(session: SessionInfo, machineId: string): void {
    this.retireSelection();
    const eligible = isEligibleSession(session, machineId) && this.machineConfigured(machineId);
    this.selectedTarget = eligible ? { machineId, sessionId: session.id, cwd: session.cwd } : undefined;
    if (this.selectedTarget !== undefined && this.machineSupportsNotifications(machineId)) {
      this.authoritativeInbox = loadingSelectedNotificationInbox(this.selectedTarget);
    }
    this.publishProjection();
  }

  clearSelectedSession(): void {
    this.retireSelection();
    this.publishProjection();
  }

  refreshSelectedSession(session: SessionRef, machineId: string): Promise<void> {
    const target = this.selectedTarget;
    if (!this.machineConfigured(machineId) || !this.isCurrentSessionRef(target, session, machineId) || !this.machineSupportsNotifications(machineId) || !this.machineIsReachable(machineId)) return Promise.resolve();
    if (this.isCheckingEnvironment(target, this.selectedGeneration)) return Promise.resolve();

    const existing = this.selectedRefresh;
    if (existing?.generation === this.selectedGeneration && notificationTargetsEqual(existing.target, target)) return existing.promise;

    this.ensureSelectedProjection(target);
    const operation: SelectedRefreshOperation = {
      id: ++this.nextOperationId,
      generation: this.selectedGeneration,
      target,
      promise: Promise.resolve(),
      trailing: false,
      socketIncarnation: this.currentSocketIncarnation,
      markerSeenAtAdmission: this.markerSeenFor(this.currentSocketIncarnation),
    };
    this.selectedRefresh = operation;
    this.recordReadAdmission(operation);
    this.publishProjection();
    operation.promise = this.runSelectedRefresh(operation).finally(() => {
      if (this.selectedRefresh === operation) {
        this.selectedRefresh = undefined;
        this.publishProjection();
      }
    });
    return operation.promise;
  }

  observeSocketIncarnation(session: SessionRef, machineId: string, socketIncarnation: number): void {
    if (!this.isCurrentSessionRef(this.selectedTarget, session, machineId)) return;
    this.currentSocketIncarnation = socketIncarnation;
    this.socketCoverage.set(socketIncarnation, { markerSeen: false });
    this.retainCurrentSocketCoverage();
  }

  ensurePostSubscriptionRefresh(session: SessionRef, machineId: string, socketIncarnation: number): Promise<void> {
    const target = this.selectedTarget;
    if (!this.isCurrentSessionRef(target, session, machineId)) return Promise.resolve();
    if (this.currentSocketIncarnation !== undefined && this.currentSocketIncarnation !== socketIncarnation) return Promise.resolve();
    this.currentSocketIncarnation = socketIncarnation;
    const coverage = this.socketCoverage.get(socketIncarnation) ?? { markerSeen: false };
    coverage.markerSeen = true;
    this.socketCoverage.set(socketIncarnation, coverage);
    const operation = this.selectedRefresh;
    if (operation?.generation === this.selectedGeneration && notificationTargetsEqual(operation.target, target)) {
      if (operation.socketIncarnation === socketIncarnation && !operation.markerSeenAtAdmission) operation.trailing = true;
      return operation.promise;
    }
    if (!this.machineSupportsNotifications(machineId) || !this.machineIsReachable(machineId) || this.isCheckingEnvironment(target, this.selectedGeneration)) return Promise.resolve();
    return this.refreshSelectedSession(session, machineId);
  }

  applyInboxEvent(machineId: string, event: SessionNotificationInboxEvent, socketIncarnation?: number): void {
    const target = this.selectedTarget;
    if (target?.machineId !== machineId) return;
    if (target.sessionId !== event.summary.sessionId || target.cwd !== event.summary.cwd) return;
    if (socketIncarnation !== undefined && this.currentSocketIncarnation !== undefined && socketIncarnation !== this.currentSocketIncarnation) return;
    if (this.retiredDaemonIds.has(event.daemonInstanceId)) return;

    const current = this.authoritativeInbox;
    if (current?.daemonInstanceId !== undefined && current.daemonInstanceId !== event.daemonInstanceId) {
      this.retireDaemon(event.daemonInstanceId);
    }
    this.acceptSupport(machineId, event.daemonInstanceId);
    const join = this.selectedJoin;
    if (join?.generation === this.selectedGeneration && notificationTargetsEqual(join.target, target)) {
      join.events.push(event);
      if (event.delta.kind === "resync" && this.selectedRefresh !== undefined) this.selectedRefresh.trailing = true;
      return;
    }

    const result = applySelectedNotificationEvent(this.authoritativeInbox, target, event);
    if (result.needsRefresh) {
      if (this.selectedRefresh !== undefined) this.selectedRefresh.trailing = true;
      else this.scheduleSelectedRefresh(target);
    }
    if (!result.changed) return;
    const next = result.needsRefresh ? result.value : this.acceptLiveAnnouncement(result.value, event);
    this.authoritativeInbox = next;
    this.publishProjection();
  }

  syncEnvironment(previous: AppState, next: AppState): void {
    if (this.disposed) return;
    this.updateRuntimeGenerations(previous, next);
    if (previous.machines !== next.machines) this.pruneRemovedMachines(next.machines);

    const environmentChanged = previous.machines !== next.machines
      || previous.machineStatuses !== next.machineStatuses
      || previous.machineRuntimes !== next.machineRuntimes;
    const selected = this.selectedTarget;
    if (!environmentChanged || selected === undefined) return;
    if (!this.machineConfigured(selected.machineId)) {
      this.retireMutationsForUnavailableTarget();
      this.markSelectedStale(selected);
      return;
    }

    const wasEligible = this.machineSupportsNotificationsInState(previous, selected.machineId)
      && this.machineIsReachableInState(previous, selected.machineId);
    const eligible = this.machineSupportsNotifications(selected.machineId) && this.machineIsReachable(selected.machineId);
    if (!eligible) {
      this.retireMutationsForUnavailableTarget();
      this.markSelectedStale(selected);
      return;
    }

    this.ensureSelectedProjection(selected);
    if (!wasEligible || this.getState().selectedNotificationInbox?.status !== "fresh") {
      void this.refreshSelectedSession({ id: selected.sessionId, cwd: selected.cwd }, selected.machineId);
    }
  }

  shouldFilterLegacyNotification(machineId: string, notificationId: string | undefined): boolean {
    return notificationId !== undefined && notificationId !== "" && this.machineSupportsNotifications(machineId);
  }

  async dismissNotification(notificationId: string): Promise<void> {
    const target = this.selectedTarget;
    const inbox = this.authoritativeInbox;
    const view = selectedNotificationView(this.getState().selectedNotificationInbox);
    if (target === undefined || inbox === undefined || view === undefined || this.dismissAllIsPending(target) || this.hasPendingNotification(target, notificationId)) return;
    if (!view.notifications.some((notification) => notification.id === notificationId)) return;
    if (!this.machineSupportsNotifications(target.machineId) || !this.machineIsReachable(target.machineId)) return;

    const operation: MutationOperation = {
      id: ++this.nextOperationId,
      kind: "notification",
      target,
      generation: this.selectedGeneration,
      daemonInstanceId: view.daemonInstanceId,
      notificationId,
    };
    this.mutationOperations.set(operation.id, operation);
    this.publishProjection();
    try {
      const snapshot = await this.api.dismissNotification({ id: target.sessionId, cwd: target.cwd }, operation.daemonInstanceId, notificationId, target.machineId);
      this.finishMutation(operation, snapshot);
    } catch (error) {
      await this.failMutation(operation, `Failed to dismiss notification: ${errorMessage(error)}`, error);
    }
  }

  async dismissAll(): Promise<void> {
    const target = this.selectedTarget;
    const inbox = this.authoritativeInbox;
    const view = selectedNotificationView(this.getState().selectedNotificationInbox);
    if (target === undefined || inbox === undefined || view === undefined || this.dismissAllIsPending(target) || view.retainedCount + view.discardedCount === 0) return;
    if (!this.machineSupportsNotifications(target.machineId) || !this.machineIsReachable(target.machineId)) return;

    const through = { ...inbox.dismissThrough };
    const operation: MutationOperation = {
      id: ++this.nextOperationId,
      kind: "all",
      target,
      generation: this.selectedGeneration,
      daemonInstanceId: view.daemonInstanceId,
      through,
    };
    this.mutationOperations.set(operation.id, operation);
    this.publishProjection();
    try {
      const snapshot = await this.api.dismissAllNotifications({ id: target.sessionId, cwd: target.cwd }, operation.daemonInstanceId, through, target.machineId);
      this.finishMutation(operation, snapshot);
    } catch (error) {
      await this.failMutation(operation, `Failed to dismiss session notifications: ${errorMessage(error)}`, error);
    }
  }

  private async runSelectedRefresh(operation: SelectedRefreshOperation): Promise<void> {
    do {
      operation.trailing = false;
      const join: SelectedJoin = { generation: operation.generation, target: operation.target, events: [] };
      this.selectedJoin = join;
      const coverage = this.socketCoverage.get(operation.socketIncarnation ?? -1);
      if (coverage !== undefined) coverage.readAdmission = { operationId: operation.id, markerSeen: operation.markerSeenAtAdmission };
      try {
        const snapshot = await this.api.notificationInbox({ id: operation.target.sessionId, cwd: operation.target.cwd }, operation.target.machineId);
        if (!this.isCurrentTarget(operation.target, operation.generation)) return;
        if (this.retiredDaemonIds.has(snapshot.daemonInstanceId)) {
          operation.trailing = true;
          continue;
        }
        if (!this.machineSupportsNotifications(operation.target.machineId) || !this.machineIsReachable(operation.target.machineId)) {
          this.markSelectedStale(operation.target);
          return;
        }

        const previousDaemon = this.authoritativeInbox?.daemonInstanceId;
        const establishedSameDaemon = this.authoritativeInbox?.status === "fresh"
          && this.authoritativeInbox.summary !== undefined
          && previousDaemon === snapshot.daemonInstanceId;
        const replacement = previousDaemon !== undefined && previousDaemon !== snapshot.daemonInstanceId;
        let validatedJoin = this.authoritativeInbox;
        if (establishedSameDaemon && validatedJoin !== undefined) {
          for (const event of [...join.events].sort((left, right) => left.summary.inboxRevision - right.summary.inboxRevision)) {
            const result = applySelectedNotificationEvent(validatedJoin, operation.target, event);
            if (result.needsRefresh) operation.trailing = true;
            if (result.changed && !result.needsRefresh) validatedJoin = this.acceptLiveAnnouncement(result.value, event);
          }
        }
        if (replacement) this.retireDaemon(snapshot.daemonInstanceId, false);
        this.acceptSupport(operation.target.machineId, snapshot.daemonInstanceId);
        const current = this.authoritativeInbox;
        let inbox = current === undefined || shouldInstallSelectedSnapshot(current, operation.target, snapshot)
          ? installSelectedNotificationSnapshot(current, operation.target, snapshot)
          : current;
        if (current === undefined || replacement || !establishedSameDaemon || inbox.daemonInstanceId !== current.daemonInstanceId) this.establishAnnouncementBaseline(inbox);
        if (establishedSameDaemon && validatedJoin !== undefined) inbox = { ...inbox, announcements: validatedJoin.announcements };
        for (const event of [...join.events].sort((left, right) => left.summary.inboxRevision - right.summary.inboxRevision)) {
          const result = applySelectedNotificationEvent(inbox, operation.target, event);
          if (result.needsRefresh) operation.trailing = true;
          if (!result.changed) continue;
          inbox = { ...result.value, announcements: inbox.announcements };
          if (!establishedSameDaemon) inbox = this.acceptLiveAnnouncement(inbox, event);
        }
        this.absorbSnapshotIntoAnnouncementCursor(inbox);
        this.authoritativeInbox = inbox;
        this.failure = undefined;
        this.publishProjection();
      } catch (error) {
        if (this.isCurrentTarget(operation.target, operation.generation)) {
          const current = this.authoritativeInbox;
          if (current === undefined || selectedNotificationView(current) === undefined) this.markSelectedStale(operation.target);
          this.failure = `Failed to refresh notifications for session ${operation.target.sessionId}: ${errorMessage(error)}`;
          this.setState({ error: this.failure });
          this.onBackgroundError(`Failed to refresh notifications for session ${operation.target.sessionId}`, error);
          this.publishProjection();
        }
        return;
      } finally {
        if (this.selectedJoin === join) this.selectedJoin = undefined;
      }
    } while (operation.trailing && this.isCurrentTarget(operation.target, operation.generation) && this.machineIsReachable(operation.target.machineId));
  }

  private finishMutation(operation: MutationOperation, snapshot: SessionNotificationInboxSnapshot): void {
    if (!this.isCurrentMutation(operation)) return;
    this.mutationOperations.delete(operation.id);
    if (!this.machineSupportsNotifications(operation.target.machineId) || !this.machineIsReachable(operation.target.machineId)) {
      this.markSelectedStale(operation.target);
      this.publishProjection();
      return;
    }
    if (this.authoritativeInbox?.daemonInstanceId !== undefined && this.authoritativeInbox.daemonInstanceId !== snapshot.daemonInstanceId) {
      this.retireDaemon(snapshot.daemonInstanceId, false);
      this.acceptSupport(operation.target.machineId, snapshot.daemonInstanceId);
      this.authoritativeInbox = installSelectedNotificationSnapshot(undefined, operation.target, snapshot);
      this.establishAnnouncementBaseline(this.authoritativeInbox);
      this.publishProjection();
      return;
    }
    const current = this.authoritativeInbox;
    if (current !== undefined && shouldInstallSelectedSnapshot(current, operation.target, snapshot)) {
      this.authoritativeInbox = installSelectedNotificationSnapshot(current, operation.target, snapshot);
    }
    this.failure = undefined;
    this.publishProjection();
  }

  private async failMutation(operation: MutationOperation, message: string, error: unknown): Promise<void> {
    if (!this.isCurrentMutation(operation)) return;
    this.mutationOperations.delete(operation.id);
    this.failure = message;
    this.setState({ error: message });
    this.publishProjection();
    this.onBackgroundError(message, error);
    if (this.isCurrentTarget(operation.target, operation.generation) && this.machineSupportsNotifications(operation.target.machineId) && this.machineIsReachable(operation.target.machineId)) {
      await this.refreshSelectedSession({ id: operation.target.sessionId, cwd: operation.target.cwd }, operation.target.machineId);
    }
  }

  private isCurrentMutation(operation: MutationOperation): boolean {
    return this.mutationOperations.get(operation.id) === operation
      && this.isCurrentTarget(operation.target, operation.generation)
      && this.authoritativeInbox?.daemonInstanceId === operation.daemonInstanceId;
  }

  private publishProjection(): void {
    const base = this.authoritativeInbox;
    if (base === undefined) {
      this.setState({ selectedNotificationInbox: undefined });
      this.onProjectionChange();
      return;
    }
    const target = targetFromInbox(base);
    const active = [...this.mutationOperations.values()].filter((operation) => operation.generation === this.selectedGeneration
      && notificationTargetsEqual(operation.target, target)
      && operation.daemonInstanceId === base.daemonInstanceId);
    const dismissed = active.flatMap((operation) => operation.kind === "notification" && operation.notificationId !== undefined ? [operation.notificationId] : []);
    const clear = active.find((operation) => operation.kind === "all");
    const projected: SelectedSessionNotificationInbox = {
      ...base,
      optimisticDismissedIds: [...new Set(dismissed)],
      ...(clear?.through === undefined ? {} : { optimisticDismissAllThrough: { ...clear.through } }),
    };
    this.setState({ selectedNotificationInbox: projected });
    this.onProjectionChange();
  }

  private ensureSelectedProjection(target: SessionNotificationTarget): void {
    if (this.authoritativeInbox === undefined || !notificationTargetsEqual(this.authoritativeInbox, target)) {
      this.authoritativeInbox = loadingSelectedNotificationInbox(target);
      this.publishProjection();
    }
  }

  private scheduleSelectedRefresh(target: SessionNotificationTarget): void {
    queueMicrotask(() => {
      if (!this.disposed && this.isCurrentTarget(target, this.selectedGeneration)) void this.refreshSelectedSession({ id: target.sessionId, cwd: target.cwd }, target.machineId);
    });
  }

  private markSelectedStale(target: SessionNotificationTarget): void {
    const current = this.authoritativeInbox;
    if (current === undefined || !notificationTargetsEqual(current, target) || current.status === "stale") return;
    this.authoritativeInbox = { ...current, status: "stale" };
    this.publishProjection();
  }

  private acceptLiveAnnouncement(inbox: SelectedSessionNotificationInbox, event: SessionNotificationInboxEvent): SelectedSessionNotificationInbox {
    if (event.delta.kind !== "added") return inbox;
    const notification = event.delta.notification;
    const cursor = this.announcementCursor;
    if (cursor === undefined || !notificationTargetsEqual(cursor.target, targetFromInbox(inbox)) || cursor.daemonInstanceId !== event.daemonInstanceId) return inbox;
    if (notification.order <= cursor.highestOrder || cursor.recentIds.includes(notification.id)) return inbox;
    cursor.highestOrder = notification.order;
    cursor.recentIds = [...cursor.recentIds.filter((id) => id !== notification.id), notification.id].slice(-SESSION_NOTIFICATION_LIMIT);
    return { ...inbox, announcements: [...inbox.announcements, { id: announcementId(inbox, notification.id), severity: notification.severity }].slice(-SESSION_NOTIFICATION_LIMIT) };
  }

  private absorbSnapshotIntoAnnouncementCursor(inbox: SelectedSessionNotificationInbox): void {
    const cursor = this.announcementCursor;
    if (cursor === undefined || inbox.daemonInstanceId === undefined || cursor.daemonInstanceId !== inbox.daemonInstanceId || !notificationTargetsEqual(cursor.target, targetFromInbox(inbox))) return;
    cursor.highestOrder = Math.max(cursor.highestOrder, inbox.dismissThrough.order, ...inbox.notifications.map((notification) => notification.order));
    cursor.recentIds = [...new Set([...cursor.recentIds, ...inbox.notifications.map((notification) => notification.id)])].slice(-SESSION_NOTIFICATION_LIMIT);
  }
  private establishAnnouncementBaseline(inbox: SelectedSessionNotificationInbox): void {
    if (inbox.daemonInstanceId === undefined) {
      this.announcementCursor = undefined;
      return;
    }
    const orders = inbox.notifications.map((notification) => notification.order);
    this.announcementCursor = {
      target: targetFromInbox(inbox),
      daemonInstanceId: inbox.daemonInstanceId,
      highestOrder: Math.max(inbox.dismissThrough.order, ...orders, 0),
      recentIds: inbox.notifications.map((notification) => notification.id).slice(-SESSION_NOTIFICATION_LIMIT),
    };
  }

  private acceptSupport(machineId: string, daemonInstanceId: string): void {
    const support = { runtimeGeneration: this.runtimeGenerationFor(machineId), daemonInstanceId };
    const previous = this.acceptedSupportByMachine.get(machineId);
    if (previous?.runtimeGeneration === support.runtimeGeneration && previous.daemonInstanceId === support.daemonInstanceId) return;
    this.acceptedSupportByMachine.set(machineId, support);
    this.onProjectionChange();
  }

  private retireDaemon(nextDaemon: string, reserveTrailingRead = true): void {
    const machineId = this.selectedTarget?.machineId;
    if (machineId === undefined) return;
    const currentDaemon = this.authoritativeInbox?.daemonInstanceId;
    if (currentDaemon === undefined || currentDaemon === nextDaemon) return;
    this.retiredDaemonIds.add(currentDaemon);
    if (reserveTrailingRead && this.selectedRefresh !== undefined) this.selectedRefresh.trailing = true;
    this.advanceRuntimeGeneration(machineId);
    this.acceptedSupportByMachine.delete(machineId);
    this.mutationOperations.clear();
    this.announcementCursor = undefined;
    const target = this.selectedTarget;
    if (target !== undefined) this.authoritativeInbox = { ...loadingSelectedNotificationInbox(target), status: "stale" };
    this.onProjectionChange();
  }

  private retireSelection(): void {
    this.selectedGeneration += 1;
    this.selectedTarget = undefined;
    this.selectedJoin = undefined;
    this.selectedRefresh = undefined;
    this.authoritativeInbox = undefined;
    this.announcementCursor = undefined;
    this.currentSocketIncarnation = undefined;
    this.socketCoverage.clear();
    this.retiredDaemonIds.clear();
    this.mutationOperations.clear();
    this.failure = undefined;
  }

  private retireMutationsForUnavailableTarget(): void {
    if (this.selectedTarget === undefined) return;
    for (const [id, operation] of this.mutationOperations.entries()) {
      if (operation.generation === this.selectedGeneration && notificationTargetsEqual(operation.target, this.selectedTarget)) this.mutationOperations.delete(id);
    }
  }

  private recordReadAdmission(operation: SelectedRefreshOperation): void {
    const coverage = this.socketCoverage.get(operation.socketIncarnation ?? -1);
    if (coverage !== undefined) coverage.readAdmission = { operationId: operation.id, markerSeen: operation.markerSeenAtAdmission };
  }

  private markerSeenFor(socketIncarnation: number | undefined): boolean {
    return socketIncarnation !== undefined && this.socketCoverage.get(socketIncarnation)?.markerSeen === true;
  }

  private retainCurrentSocketCoverage(): void {
    if (this.socketCoverage.size <= 4) return;
    const current = this.currentSocketIncarnation;
    for (const incarnation of this.socketCoverage.keys()) {
      if (incarnation !== current && this.socketCoverage.size > 4) this.socketCoverage.delete(incarnation);
    }
  }

  private dismissAllIsPending(target: SessionNotificationTarget): boolean {
    return [...this.mutationOperations.values()].some((operation) => operation.kind === "all"
      && operation.generation === this.selectedGeneration
      && notificationTargetsEqual(operation.target, target));
  }

  private hasPendingNotification(target: SessionNotificationTarget, notificationId: string): boolean {
    return [...this.mutationOperations.values()].some((operation) => operation.kind === "notification"
      && operation.notificationId === notificationId
      && operation.generation === this.selectedGeneration
      && notificationTargetsEqual(operation.target, target));
  }

  private isCurrentSessionRef(target: SessionNotificationTarget | undefined, session: SessionRef, machineId: string): target is SessionNotificationTarget {
    return target?.machineId === machineId && target.sessionId === session.id && target.cwd === session.cwd && session.id !== "" && session.cwd !== "";
  }

  private isCurrentTarget(target: SessionNotificationTarget, generation: number): boolean {
    return !this.disposed && generation === this.selectedGeneration && this.selectedTarget !== undefined && notificationTargetsEqual(this.selectedTarget, target);
  }

  private machineConfigured(machineId: string): boolean {
    return this.getState().machines.some((machine) => machine.id === machineId);
  }

  private machineSupportsNotifications(machineId: string): boolean {
    return this.machineSupportsNotificationsInState(this.getState(), machineId);
  }

  private machineSupportsNotificationsInState(state: AppState, machineId: string): boolean {
    const accepted = this.acceptedSupportByMachine.get(machineId);
    if (accepted?.runtimeGeneration === this.runtimeGenerationFor(machineId)) return true;
    const runtime = state.machineRuntimes[machineId];
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsNotifications);
  }

  private machineIsReachable(machineId: string): boolean {
    return this.machineIsReachableInState(this.getState(), machineId);
  }

  private machineIsReachableInState(state: AppState, machineId: string): boolean {
    const machine = state.machines.find((candidate) => candidate.id === machineId);
    if (machineId !== "local" && machine === undefined) return false;
    if (machineId === "local" || machine?.kind === "local") return true;
    const status = state.machineStatuses[machineId]?.status ?? machine?.status;
    return status === undefined || status === "unknown" || status === "online";
  }

  private updateRuntimeGenerations(previous: AppState, next: AppState): void {
    const machineIds = new Set([...Object.keys(previous.machineRuntimes), ...Object.keys(next.machineRuntimes)]);
    for (const machineId of machineIds) {
      const runtime = next.machineRuntimes[machineId];
      if (runtime?.ok !== true) continue;
      const identity = runtimeIdentity(runtime);
      if (identity === undefined) continue;
      const prior = this.runtimeIdentityByMachine.get(machineId);
      if (prior === undefined) {
        this.runtimeIdentityByMachine.set(machineId, identity);
        continue;
      }
      if (prior !== identity) {
        this.runtimeIdentityByMachine.set(machineId, identity);
        this.advanceRuntimeGeneration(machineId);
      }
    }
  }

  private advanceRuntimeGeneration(machineId: string): void {
    this.knownMachineIds.add(machineId);
    this.runtimeGenerationByMachine.set(machineId, this.runtimeGenerationFor(machineId) + 1);
    this.acceptedSupportByMachine.delete(machineId);
    if (this.selectedTarget?.machineId === machineId) {
      this.mutationOperations.clear();
      this.announcementCursor = undefined;
      this.markSelectedStale(this.selectedTarget);
    }
    this.onProjectionChange();
  }

  private pruneRemovedMachines(machines: readonly Machine[]): void {
    const machineIds = new Set(machines.map((machine) => machine.id));
    if (machineIds.size === 0) machineIds.add("local");
    const knownMachineIds = new Set([...this.knownMachineIds, ...this.acceptedSupportByMachine.keys(), ...this.runtimeGenerationByMachine.keys(), ...this.runtimeIdentityByMachine.keys()]);
    for (const machineId of knownMachineIds) {
      if (!machineIds.has(machineId)) {
        this.advanceRuntimeGeneration(machineId);
        this.runtimeIdentityByMachine.delete(machineId);
      }
    }
  }
}

function isEligibleSession(session: SessionInfo, machineId: string): boolean {
  return machineId !== "" && session.id !== "" && session.cwd !== "" && session.archived !== true && !isClientPendingStartSessionInfo(session);
}

function isClientPendingStartSessionInfo(session: SessionInfo | undefined): boolean {
  return session !== undefined
    && "clientPendingStart" in session
    && session.clientPendingStart === true
    && "machineId" in session
    && typeof session.machineId === "string";
}

function targetFromInbox(inbox: SelectedSessionNotificationInbox): SessionNotificationTarget {
  return { machineId: inbox.machineId, sessionId: inbox.sessionId, cwd: inbox.cwd };
}

function shouldInstallSelectedSnapshot(
  current: SelectedSessionNotificationInbox,
  target: SessionNotificationTarget,
  snapshot: SessionNotificationInboxSnapshot,
): boolean {
  return !notificationTargetsEqual(current, target)
    || current.daemonInstanceId !== snapshot.daemonInstanceId
    || current.summary === undefined
    || snapshot.summary.inboxRevision >= current.summary.inboxRevision;
}

function announcementId(inbox: SelectedSessionNotificationInbox, notificationId: string): string {
  return `${inbox.machineId}:${inbox.cwd}:${inbox.sessionId}:${inbox.daemonInstanceId ?? ""}:${notificationId}`;
}

function runtimeIdentity(runtime: AppState["machineRuntimes"][string]): string | undefined {
  if (!runtime.ok) return undefined;
  return JSON.stringify({
    packageName: runtime.packageName,
    web: runtime.components?.web.runtimeVersion,
    sessiond: runtime.components?.sessiond.runtimeVersion,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { isClientPendingStartSessionInfo };
