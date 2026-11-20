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
import { isClientPendingStartSessionInfo } from "./sessionController";
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
  socketIncarnation: number | undefined;
  events: SessionNotificationInboxEvent[];
}

interface SelectedRefreshOperation {
  generation: number;
  runtimeGeneration: number;
  target: SessionNotificationTarget;
  promise: Promise<void>;
  trailing: boolean;
}

interface SocketCoverage {
  incarnation: number;
  markerSeen: boolean;
  postMarkerAdmission?: SelectedRefreshOperation;
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
  private selectedTarget: SessionNotificationTarget | undefined;
  private selectedGeneration = 0;
  private selectedJoin: SelectedJoin | undefined;
  private selectedRefresh: SelectedRefreshOperation | undefined;
  private authoritativeInbox: SelectedSessionNotificationInbox | undefined;
  private announcementCursor: AnnouncementCursor | undefined;
  private socketCoverage: SocketCoverage | undefined;
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
    if (operation === undefined || this.selectedJoin?.socketIncarnation !== this.socketCoverage?.incarnation) return undefined;
    if (!this.isCurrentRefresh(operation)) return undefined;
    return { target: operation.target, selectionGeneration: operation.generation, kind: "loading-inbox" };
  }

  get failureMessage(): string | undefined {
    return this.failure;
  }

  runtimeGenerationFor(machineId: string): number {
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
    this.socketCoverage = undefined;
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
    if (!this.isCurrentSessionRef(target, session, machineId) || !this.canRead(target, this.selectedGeneration)) return Promise.resolve();
    if (this.selectedRefresh !== undefined) return this.selectedRefresh.promise;

    this.ensureSelectedProjection(target);
    const operation: SelectedRefreshOperation = {
      generation: this.selectedGeneration,
      runtimeGeneration: this.runtimeGenerationFor(machineId),
      target,
      promise: Promise.resolve(),
      trailing: false,
    };
    this.selectedRefresh = operation;
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
    if (this.socketCoverage !== undefined && this.socketCoverage.incarnation >= socketIncarnation) return;
    this.socketCoverage = { incarnation: socketIncarnation, markerSeen: false };
    if (this.selectedRefresh !== undefined) this.onProjectionChange();
  }

  ensurePostSubscriptionRefresh(session: SessionRef, machineId: string, socketIncarnation: number): Promise<void> {
    if (!this.isCurrentSessionRef(this.selectedTarget, session, machineId)) return Promise.resolve();
    this.socketCoverage ??= { incarnation: socketIncarnation, markerSeen: false };
    const coverage = this.socketCoverage;
    if (coverage.incarnation !== socketIncarnation) return Promise.resolve();
    coverage.markerSeen = true;
    if (coverage.postMarkerAdmission !== undefined) {
      return this.selectedRefresh === coverage.postMarkerAdmission ? coverage.postMarkerAdmission.promise : Promise.resolve();
    }
    // The marker remains owed while the slot is occupied or admission is blocked.
    return this.refreshSelectedSession(session, machineId);
  }

  applyInboxEvent(machineId: string, event: SessionNotificationInboxEvent, socketIncarnation?: number): void {
    const target = this.selectedTarget;
    if (target?.machineId !== machineId) return;
    if (target.sessionId !== event.summary.sessionId || target.cwd !== event.summary.cwd) return;
    const currentSocket = this.socketCoverage?.incarnation;
    if (socketIncarnation !== undefined && currentSocket !== undefined && socketIncarnation !== currentSocket) return;
    if (!this.machineConfigured(machineId) || !this.machineIsReachable(machineId) || this.retiredDaemonIds.has(event.daemonInstanceId)) return;

    const replaced = this.observeDaemon(target, event.daemonInstanceId);
    const join = this.selectedJoin;
    if (join !== undefined && join.socketIncarnation === currentSocket) {
      join.events.push(event);
      if (event.delta.kind === "resync" && this.selectedRefresh !== undefined) this.selectedRefresh.trailing = true;
      return;
    }

    const result = applySelectedNotificationEvent(this.authoritativeInbox, target, event);
    if (result.needsRefresh) {
      if (this.selectedRefresh !== undefined) this.selectedRefresh.trailing = true;
      else this.scheduleSelectedRefresh(target);
    }
    if (!result.changed && !replaced) return;
    const next = result.needsRefresh ? result.value : this.acceptLiveAnnouncement(result.value, event);
    this.authoritativeInbox = next;
    this.publishProjection();
  }

  syncEnvironment(previous: AppState, next: AppState): void {
    if (this.disposed) return;
    this.updateRuntimeGenerations(previous, next);
    if (previous.machines !== next.machines) this.pruneRemovedMachines(previous.machines, next.machines);

    const environmentChanged = previous.machines !== next.machines
      || previous.machineStatuses !== next.machineStatuses
      || previous.machineRuntimes !== next.machineRuntimes;
    const selected = this.selectedTarget;
    if (!environmentChanged || selected === undefined) return;
    if (!this.machineConfigured(selected.machineId)) {
      this.retireRefresh();
      this.retireMutationsForUnavailableTarget();
      this.markSelectedStale(selected);
      return;
    }

    const wasEligible = this.machineSupportsNotificationsInState(previous, selected.machineId)
      && this.machineIsReachableInState(previous, selected.machineId);
    const eligible = this.machineSupportsNotifications(selected.machineId) && this.machineIsReachable(selected.machineId);
    if (!eligible) {
      this.retireRefresh();
      this.retireMutationsForUnavailableTarget();
      this.markSelectedStale(selected);
      return;
    }

    this.ensureSelectedProjection(selected);
    if (!wasEligible || this.hasOwedSubscriptionRead() || this.getState().selectedNotificationInbox?.status !== "fresh") {
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
    const { target } = operation;
    do {
      operation.trailing = false;
      const coverage = this.socketCoverage;
      const join: SelectedJoin = { socketIncarnation: coverage?.incarnation, events: [] };
      const base = this.authoritativeInbox;
      const daemonAtAdmission = this.observedDaemon(target.machineId);
      this.selectedJoin = join;
      if (coverage?.markerSeen === true) coverage.postMarkerAdmission = operation;
      try {
        this.publishProjection();
        const snapshot = await this.api.notificationInbox({ id: target.sessionId, cwd: target.cwd }, target.machineId);
        if (!this.ownsRefreshPass(operation, join)) continue;
        const observedDaemon = this.observedDaemon(target.machineId);
        if (this.retiredDaemonIds.has(snapshot.daemonInstanceId)
          || (daemonAtAdmission !== observedDaemon && snapshot.daemonInstanceId !== observedDaemon)) {
          this.markSelectedStale(target);
          operation.trailing = daemonAtAdmission !== observedDaemon;
          continue;
        }
        if (snapshot.summary.sessionId !== target.sessionId || snapshot.summary.cwd !== target.cwd) {
          throw new Error("Notification inbox snapshot does not match the selected session");
        }
        this.installRefreshSnapshot(operation, base, snapshot, join.events);
      } catch (error) {
        if (!this.ownsRefreshPass(operation, join)) continue;
        this.reconcileFailedJoin(target, base, join.events);
        this.failure = `Failed to refresh notifications for session ${target.sessionId}: ${errorMessage(error)}`;
        this.setState({ error: this.failure });
        this.onBackgroundError(`Failed to refresh notifications for session ${target.sessionId}`, error);
        this.publishProjection();
        // A failed invalidation remains available for Retry. A subscription
        // marker still needs its first admission even if the pre-marker read failed.
        operation.trailing = false;
      } finally {
        if (this.selectedJoin === join) this.selectedJoin = undefined;
      }
    } while ((operation.trailing || this.hasOwedSubscriptionRead())
      && this.isCurrentRefresh(operation) && this.canRead(target, operation.generation));
  }

  private installRefreshSnapshot(
    operation: SelectedRefreshOperation,
    base: SelectedSessionNotificationInbox | undefined,
    snapshot: SessionNotificationInboxSnapshot,
    events: readonly SessionNotificationInboxEvent[],
  ): void {
    const { target } = operation;
    const ordered = orderedDaemonEvents(events, snapshot.daemonInstanceId);
    // The snapshot can already contain a live addition received during the read.
    const validated = base?.status === "fresh" && base.daemonInstanceId === snapshot.daemonInstanceId
      ? this.replayJoin(base, target, ordered, true)
      : undefined;
    this.observeDaemon(target, snapshot.daemonInstanceId, operation);
    const current = this.authoritativeInbox;
    let inbox = current === undefined || shouldInstallSelectedSnapshot(current, target, snapshot)
      ? installSelectedNotificationSnapshot(current, target, snapshot)
      : current;
    this.absorbSnapshotIntoAnnouncementCursor(inbox);
    if (validated !== undefined) inbox = { ...inbox, announcements: validated.inbox.announcements };
    const replay = this.replayJoin(inbox, target, ordered, validated === undefined);
    this.authoritativeInbox = replay.inbox;
    operation.trailing ||= replay.needsRefresh;
    this.failure = undefined;
    this.publishProjection();
  }

  private reconcileFailedJoin(
    target: SessionNotificationTarget,
    base: SelectedSessionNotificationInbox | undefined,
    events: readonly SessionNotificationInboxEvent[],
  ): void {
    const current = this.authoritativeInbox;
    if (base?.status !== "fresh" || current?.status !== "fresh" || base.daemonInstanceId !== current.daemonInstanceId) {
      this.markSelectedStale(target);
      return;
    }
    const ordered = orderedDaemonEvents(events, base.daemonInstanceId);
    const validated = this.replayJoin(base, target, ordered, true);
    // Preserve any newer mutation response installed during the read.
    this.authoritativeInbox = this.replayJoin({ ...current, announcements: validated.inbox.announcements }, target, ordered, false).inbox;
  }

  private replayJoin(
    base: SelectedSessionNotificationInbox,
    target: SessionNotificationTarget,
    events: readonly SessionNotificationInboxEvent[],
    announce: boolean,
  ): { inbox: SelectedSessionNotificationInbox; needsRefresh: boolean } {
    let inbox = base;
    for (const event of events) {
      const result = applySelectedNotificationEvent(inbox, target, event);
      if (result.needsRefresh) return { inbox: result.value, needsRefresh: true };
      if (result.changed) inbox = announce ? this.acceptLiveAnnouncement(result.value, event) : result.value;
    }
    return { inbox, needsRefresh: false };
  }

  private finishMutation(operation: MutationOperation, snapshot: SessionNotificationInboxSnapshot): void {
    if (!this.isCurrentMutation(operation)) return;
    if (snapshot.summary.sessionId !== operation.target.sessionId || snapshot.summary.cwd !== operation.target.cwd) {
      throw new Error("Notification inbox snapshot does not match the selected session");
    }
    this.mutationOperations.delete(operation.id);
    if (!this.machineSupportsNotifications(operation.target.machineId) || !this.machineIsReachable(operation.target.machineId)) {
      this.markSelectedStale(operation.target);
      this.publishProjection();
      return;
    }
    const current = this.authoritativeInbox;
    if (this.retiredDaemonIds.has(snapshot.daemonInstanceId)) {
      this.publishProjection();
      return;
    }
    this.observeDaemon(operation.target, snapshot.daemonInstanceId);
    if (current !== undefined && shouldInstallSelectedSnapshot(current, operation.target, snapshot)) {
      this.authoritativeInbox = installSelectedNotificationSnapshot(this.authoritativeInbox, operation.target, snapshot);
      this.absorbSnapshotIntoAnnouncementCursor(this.authoritativeInbox);
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
    const generation = this.selectedGeneration;
    queueMicrotask(() => {
      if (this.isCurrentTarget(target, generation)) void this.refreshSelectedSession({ id: target.sessionId, cwd: target.cwd }, target.machineId);
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
    cursor.recentIds = [...cursor.recentIds, notification.id].slice(-SESSION_NOTIFICATION_LIMIT);
    return { ...inbox, announcements: [...inbox.announcements, { id: announcementId(inbox, notification.id), severity: notification.severity }].slice(-SESSION_NOTIFICATION_LIMIT) };
  }

  private absorbSnapshotIntoAnnouncementCursor(inbox: SelectedSessionNotificationInbox): void {
    if (inbox.daemonInstanceId === undefined) return;
    const highestOrder = Math.max(inbox.dismissThrough.order, ...inbox.notifications.map((notification) => notification.order));
    const cursor = this.announcementCursor;
    if (cursor?.daemonInstanceId === inbox.daemonInstanceId && notificationTargetsEqual(cursor.target, inbox)) {
      cursor.highestOrder = Math.max(cursor.highestOrder, highestOrder);
      return;
    }
    this.announcementCursor = {
      target: targetFromInbox(inbox),
      daemonInstanceId: inbox.daemonInstanceId,
      highestOrder,
      recentIds: [],
    };
  }

  private acceptSupport(machineId: string, daemonInstanceId: string): void {
    const support = { runtimeGeneration: this.runtimeGenerationFor(machineId), daemonInstanceId };
    const previous = this.acceptedSupportByMachine.get(machineId);
    if (previous?.runtimeGeneration === support.runtimeGeneration && previous.daemonInstanceId === support.daemonInstanceId) return;
    this.acceptedSupportByMachine.set(machineId, support);
    this.onProjectionChange();
  }

  private observedDaemon(machineId: string): string | undefined {
    return this.acceptedSupportFor(machineId)?.daemonInstanceId ?? this.authoritativeInbox?.daemonInstanceId;
  }

  private observeDaemon(target: SessionNotificationTarget, nextDaemon: string, owner?: SelectedRefreshOperation): boolean {
    const currentDaemon = this.observedDaemon(target.machineId);
    const replaced = currentDaemon !== undefined && currentDaemon !== nextDaemon;
    if (replaced) {
      this.retiredDaemonIds.add(currentDaemon);
      this.announcementCursor = undefined;
      this.mutationOperations.clear();
      this.authoritativeInbox = { ...loadingSelectedNotificationInbox(target), status: "stale" };
      this.advanceRuntimeGeneration(target.machineId, owner);
    }
    this.acceptSupport(target.machineId, nextDaemon);
    return replaced;
  }

  private retireRefresh(): void {
    this.selectedRefresh = undefined;
    this.selectedJoin = undefined;
  }

  private isCurrentRefresh(operation: SelectedRefreshOperation): boolean {
    return this.selectedRefresh === operation
      && this.isCurrentTarget(operation.target, operation.generation)
      && this.runtimeGenerationFor(operation.target.machineId) === operation.runtimeGeneration;
  }

  private ownsRefreshPass(operation: SelectedRefreshOperation, join: SelectedJoin): boolean {
    return this.isCurrentRefresh(operation)
      && this.selectedJoin === join
      && join.socketIncarnation === this.socketCoverage?.incarnation
      && this.machineConfigured(operation.target.machineId)
      && this.machineSupportsNotifications(operation.target.machineId)
      && this.machineIsReachable(operation.target.machineId);
  }

  private canRead(target: SessionNotificationTarget, generation: number): boolean {
    return this.isCurrentTarget(target, generation)
      && this.machineConfigured(target.machineId)
      && this.machineSupportsNotifications(target.machineId)
      && this.machineIsReachable(target.machineId)
      && !this.isCheckingEnvironment(target, generation);
  }

  private hasOwedSubscriptionRead(): boolean {
    return this.socketCoverage?.markerSeen === true && this.socketCoverage.postMarkerAdmission === undefined;
  }

  private retireSelection(): void {
    this.selectedGeneration += 1;
    this.selectedTarget = undefined;
    this.selectedJoin = undefined;
    this.selectedRefresh = undefined;
    this.authoritativeInbox = undefined;
    this.announcementCursor = undefined;
    this.socketCoverage = undefined;
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
      const previousRuntime = previous.machineRuntimes[machineId];
      const prior = this.runtimeIdentityByMachine.get(machineId)
        ?? (previousRuntime === undefined ? undefined : runtimeIdentity(previousRuntime));
      this.runtimeIdentityByMachine.set(machineId, identity);
      if (prior !== undefined && prior !== identity) this.advanceRuntimeGeneration(machineId);
    }
  }

  private advanceRuntimeGeneration(machineId: string, owner?: SelectedRefreshOperation): void {
    this.runtimeGenerationByMachine.set(machineId, this.runtimeGenerationFor(machineId) + 1);
    this.acceptedSupportByMachine.delete(machineId);
    if (this.selectedTarget?.machineId === machineId) {
      if (this.selectedRefresh !== owner) this.retireRefresh();
      if (owner !== undefined) owner.runtimeGeneration = this.runtimeGenerationFor(machineId);
      this.mutationOperations.clear();
      this.markSelectedStale(this.selectedTarget);
    }
    this.onProjectionChange();
  }

  private pruneRemovedMachines(previousMachines: readonly Machine[], machines: readonly Machine[]): void {
    const machineIds = new Set(machines.map((machine) => machine.id));
    for (const { id: machineId } of previousMachines) {
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

function orderedDaemonEvents(events: readonly SessionNotificationInboxEvent[], daemonInstanceId: string | undefined): SessionNotificationInboxEvent[] {
  return events.filter((event) => event.daemonInstanceId === daemonInstanceId)
    .sort((left, right) => left.summary.inboxRevision - right.summary.inboxRevision);
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
