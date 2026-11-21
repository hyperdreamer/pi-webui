# Browser notifications for idle sessions

Technical specification · 2026-11-21

## 1. Purpose and scope

Add opt-in browser desktop alerts when a selectable session completes active work and becomes idle while the user is looking elsewhere. The daemon-owned unread catalog supplies completion identity through live `sessions.unread` events. Browser notifications cover the connected machines and projects already observed by the application's existing realtime subscriptions.

An eligible completion produces at most one notification construction across tabs in the same browser profile and origin. A focused, visible window actually showing that session suppresses the completion. Successful suppression is recorded across tabs. Browser permission, preference, completion age, snapshot-established alert epoch, and an IndexedDB claim all gate delivery.

The user enables **Browser notifications** in **Settings → Notifications**. Clicking an alert focuses its existing PI WEBUI window and requests the corresponding machine, project, workspace, and session in chat view.

### Non-goals

- Push delivery while every PI WEBUI page is closed, disconnected, suspended, or offline.
- Reconstructing alerts from HTTP snapshots, initial load, route restoration, reconnect, capability negotiation, or already-idle session state.
- Alerts for tracked child sessions excluded from the daemon unread catalog.
- Inferring success, failure, or cancellation from becoming idle.
- Prompt, response, tool-output, extension-message, or severity content in the browser notification payload.
- New server routes, realtime event types, daemon protocols, daemon-loaded modules, service workers, or server-side notification preferences.
- Changes to the in-session notification inbox.

### Inbox separation

Browser notifications are separate from the session notification inbox shown in chat.

The new modules consume completion identity and catalog metadata from `sessions.unread`. They must not import or invoke `SessionNotificationController`, inbox dismissal code, inbox storage, extension-message formatters, or inbox preference helpers. They must not consume `notifications.inbox` or `notifications.summary`, reuse their wording, or reinterpret severity. The settings panel uses the browser-level feature name throughout.

## 2. Repository integration contracts

| Existing surface | Contract for this feature |
| --- | --- |
| `src/shared/apiTypes.ts` | Reuse `SessionUnreadEvent`, `SessionUnreadSummary`, `SessionInfo`, `Project`, and `Workspace`. Feature-local types live in the new client modules. |
| `src/client/src/sessionSocket.ts` | `RealtimeSocket` already receives and validates `sessions.unread`. `parseRealtimeSocketEvent` excludes `notifications.summary`. `SessionSocket` carries session inbox traffic separately. |
| `src/server/realtime/sessionEventHub.ts` | Existing global realtime publication already transports unread events. The controller receives those events through the existing browser subscription. |
| `src/client/src/sessionUnread.ts` | Add the accepted-snapshot subscription specified in section 6. Projection, acknowledgement, ordering, and refresh ownership remain authoritative here. |
| `PiWebUiApp.handleRealtimeEvent` | Capture the selected machine's socket completion before calling `sessionUnread.applyEvent`. Preserve its selected-machine ownership check. |
| `PiWebUiApp.handleMachineActivityEvent` | Capture other subscribed machines' socket completions before calling `sessionUnread.applyEvent`. |
| `syncSessionUnreadMachines` and `renegotiateUnreadMachine` | Deliver the same capability transitions and retained-machine set to the alert controller. Socket reopening sets capability to `unknown`. |
| `PiWebUiApp.isSessionSeen` | Supply the active-chat predicate specified in section 9. Selection alone cannot suppress an alert. |
| `SettingsDialog` | Add a standalone `notifications` route, navigation item, panel mapping, and app-owned browser-notification properties. |
| `speechInputSettingsChannel.ts` | Follow its injected channel factory, guarded decoding, explicit startup, and idempotent cleanup conventions. Use the origin-scoped alert channel specified here. |
| `route.ts`, `settingsRoute.ts`, `appUrl.ts`, `api/urls.ts` | Use their existing browser boundaries and route writers. Dynamic API segments use `encodeURIComponent` and query values use `URLSearchParams`. |

## 3. Module layout and ownership

All paths below are exact. Production modules start effects through explicit calls. Importing a module must not open a database, construct a channel, install listeners, request permission, or display a notification.

| New production file | Responsibility and public exports |
| --- | --- |
| `src/client/src/browserNotifications/preferences.ts` | Version-one preference decoding and fresh storage access. Exports the preference types, storage key, `parseBrowserNotificationPreference`, and `createBrowserNotificationPreferenceStore`. |
| `src/client/src/browserNotifications/completionCandidates.ts` | Pure completion identities, timestamp evaluation, candidate construction, per-machine capabilities, alert epochs, and bounded queues. Exports the domain types, time and queue constants, identity functions, `createBrowserNotificationCandidate`, `evaluateBrowserNotificationTime`, and `BrowserNotificationCandidates`. |
| `src/client/src/browserNotifications/claimStore.ts` | Origin-shared IndexedDB claims, atomic first decisions, conditional `blocked` rewrites, and age-only pruning. Exports store constants, disposition/result/port types, and `createBrowserNotificationClaimStore`. |
| `src/client/src/browserNotifications/viewerQueryChannel.ts` | Origin-scoped viewer queries, current-state replies, query timers, cancellation, and optional preference invalidation broadcasts. Exports message/port types, the reply-window constant, `browserNotificationChannelName`, and `createBrowserNotificationViewerChannel`. |
| `src/client/src/browserNotifications/payload.ts` | Pure approved wording and name fallbacks. Exports `BrowserNotificationNames`, `BrowserNotificationPayload`, and `formatBrowserNotificationPayload`. |
| `src/client/src/browserNotifications/alertTarget.ts` | Click-time target resolution against the requested machine's catalogs. Exports resolver types and `resolveAlertTarget`. |
| `src/client/src/browserNotifications/controller.ts` | Candidate orchestration, four preference gates, permission enable action, availability, notification construction, browser lifecycle, and click delegation. Exports the browser ports, availability/snapshot/result/options types, `BrowserNotificationControllerPort`, and `BrowserNotificationController`. |
| `src/client/src/components/settings/SettingsNotificationsPanel.ts` | Stateless Lit presentation and explicit enable/test actions. Exports `SettingsNotificationsPanel` and registers `settings-notifications-panel`. Reuses `SettingsPanelFrame`. |

Add the following test files alongside those modules.

| New test file | Primary coverage |
| --- | --- |
| `src/client/src/browserNotifications/preferences.test.ts` | Storage format and failure handling. |
| `src/client/src/browserNotifications/completionCandidates.test.ts` | Identity, timestamps, capabilities, epochs, and queues. |
| `src/client/src/browserNotifications/claimStore.test.ts` | Transactions, retained bytes, pruning, quota, and concurrent claim ownership. |
| `src/client/src/browserNotifications/viewerQueryChannel.test.ts` | Message decoding, live replies, timeout, cancellation, and channel degradation. |
| `src/client/src/browserNotifications/payload.test.ts` | Exact payload and fallbacks. |
| `src/client/src/browserNotifications/alertTarget.test.ts` | Catalog resolution and failure reasons. |
| `src/client/src/browserNotifications/controller.test.ts` | End-to-end client orchestration through injected boundaries. |
| `src/client/src/components/settings/SettingsNotificationsPanel.test.ts` | Rendered states and controls. |
| `src/client/src/components/SettingsDialog.notifications.test.ts` | Standalone navigation and panel property forwarding. |
| `src/client/src/components/PiWebUiApp.browserNotifications.test.ts` | Socket receipt, lifecycle, active-chat predicate, settings wiring, and click activation. |

The existing files requiring edits are `sessionUnread.ts`, `sessionUnread.test.ts`, `settingsRoute.ts`, `settingsRoute.test.ts`, `components/SettingsDialog.ts`, `components/PiWebUiApp.ts`, and, where needed to extend existing fixtures, `components/PiWebUiApp.unread.test.ts`. Documentation and release files are specified in section 15.

### Dependency direction

- Preference, candidate, payload, and resolver modules have no Lit dependency.
- The claim store receives an IndexedDB factory and clock. It owns database connections and transactions.
- The viewer channel receives a BroadcastChannel factory, clock, query-ID factory, and current-view predicate. It owns channel callbacks and query timers.
- The controller receives those collaborators plus Notification, document, page events, names, and navigation ports. It owns pending work and browser lifecycle listeners.
- `PiWebUiApp` composes browser adapters and app-state callbacks. `SettingsDialog` and its panel consume controller state and actions.
- Every asynchronous continuation checks its owning controller and machine generation. Machine removal, disabling, and disposal invalidate pending work synchronously.

## 4. Exact local types and exported signatures

These are declaration contracts. Implementations may keep private helpers, with observable behavior governed by the following sections. Cross-module references below denote imports from the owning new module. All timestamps are finite integer milliseconds since the Unix epoch. Every nullable field is explicit. Optional dependencies use `undefined`.

### 4.1 Preferences

`preferences.ts` exports the following declarations.

```ts
export interface BrowserNotificationPreference {
  readonly version: 1;
  readonly enabled: boolean;
}

export type BrowserNotificationPreferenceFailure =
  | "storage-unavailable"
  | "read-failed"
  | "write-failed";

export type BrowserNotificationPreferenceResult =
  | { readonly ok: true; readonly preference: BrowserNotificationPreference }
  | {
      readonly ok: false;
      readonly reason: BrowserNotificationPreferenceFailure;
      readonly preference: BrowserNotificationPreference;
    };

export interface BrowserNotificationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrowserNotificationPreferenceStore {
  read(): BrowserNotificationPreferenceResult;
  write(enabled: boolean): BrowserNotificationPreferenceResult;
}

export declare function parseBrowserNotificationPreference(
  value: string | null,
): BrowserNotificationPreference;

export declare function createBrowserNotificationPreferenceStore(
  storage: BrowserNotificationStorage | undefined,
): BrowserNotificationPreferenceStore;
```

An unsuccessful result always contains `{ version: 1, enabled: false }`. Missing or malformed data decodes to this disabled preference. A valid stored object has exactly the keys `version` and `enabled`, with version `1` and a boolean value. Reading never repairs or writes storage.

### 4.2 Completion candidates and alert epochs

`completionCandidates.ts` imports the existing unread types and `SessionUnreadCapabilityState`, and exports the following declarations.

```ts
export interface BrowserAlertSessionIdentity {
  readonly machineId: string;
  readonly sessionId: string;
  readonly workspacePath: string;
}

export interface BrowserCompletionIdentity extends BrowserAlertSessionIdentity {
  readonly catalogId: string;
  readonly completionOrder: number;
}

export interface BrowserNotificationAlertEpoch {
  readonly machineId: string;
  readonly catalogId: string;
  readonly catalogRevision: number;
}

export interface BrowserNotificationCandidateBase extends BrowserAlertSessionIdentity {
  readonly catalogId: string;
  readonly catalogRevision: number;
  readonly receivedAt: number;
  readonly expiresAt: number;
}

export interface BrowserCompletionCandidate extends BrowserNotificationCandidateBase {
  readonly kind: "completion";
  readonly completionOrder: number;
  readonly unread: Readonly<SessionUnreadSummary>;
  readonly completedAtMs: number;
}

export interface BrowserRemovalCandidate extends BrowserNotificationCandidateBase {
  readonly kind: "removal";
  readonly completionOrder: null;
  readonly unread: null;
  readonly completedAtMs: null;
}

export type BrowserNotificationCandidate =
  | BrowserCompletionCandidate
  | BrowserRemovalCandidate;

export type BrowserNotificationTimeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "older-than-horizon" | "future-clock-skew" };

export type BrowserNotificationCandidateAdmission =
  | { readonly kind: "ready"; readonly candidate: BrowserCompletionCandidate }
  | { readonly kind: "queued"; readonly evicted: BrowserCompletionCandidate | null }
  | { readonly kind: "discarded"; readonly reason: "unsupported" | "expired" };

export declare function browserCompletionIdentity(identity: BrowserCompletionIdentity): string;
export declare function browserAlertSessionIdentity(identity: BrowserAlertSessionIdentity): string;

export declare function createBrowserNotificationCandidate(
  machineId: string,
  event: SessionUnreadEvent,
  receivedAt: number,
): BrowserNotificationCandidate;

export declare function evaluateBrowserNotificationTime(
  candidate: BrowserCompletionCandidate,
  now: number,
): BrowserNotificationTimeResult;

export declare class BrowserNotificationCandidates {
  capability(machineId: string): SessionUnreadCapabilityState;
  setCapability(machineId: string, capability: SessionUnreadCapabilityState): void;
  retainMachines(machineIds: ReadonlySet<string>): void;
  acceptSnapshot(epoch: BrowserNotificationAlertEpoch): void;
  epoch(machineId: string): BrowserNotificationAlertEpoch | undefined;
  admit(candidate: BrowserCompletionCandidate, now: number): BrowserNotificationCandidateAdmission;
  takeReady(machineId: string, now: number): readonly BrowserCompletionCandidate[];
  expire(now: number): void;
  clearPending(): void;
}
```

`workspacePath` is the event's `cwd`. A completion candidate clones only the four `SessionUnreadSummary` fields. Its session, workspace, and order agree with its envelope. A removal candidate is immediately discarded by the controller and never reaches `admit` or the claim store.

`completedAtMs` is parsed once from the daemon's `unread.completedAt`. A nonfinite parse falls back to the candidate's fixed `receivedAt`, with that same fallback used at every later time check. The existing socket parser already rejects noncanonical or unparsable timestamps. Preserve that parser contract. The fallback protects the typed candidate helper and injected callers, and does not authorize malformed socket messages.

`BrowserNotificationCandidates` has no timers, browser storage, channels, or API calls. Methods receive time explicitly. The controller schedules queue cleanup and invokes `expire` when processing or resuming.

### 4.3 Claim store

`claimStore.ts` exports the following declarations.

```ts
export type BrowserNotificationClaimDisposition = "displayed" | "suppressed" | "blocked";

export interface BrowserNotificationClaimRecord {
  readonly disposition: BrowserNotificationClaimDisposition;
  readonly claimedAt: number;
  readonly machineId: string;
  readonly completionOrder: number;
}

export type BrowserNotificationCoordinationFailure =
  | "indexeddb-unavailable"
  | "open-failed"
  | "upgrade-blocked"
  | "write-failed"
  | "quota-exceeded";

export type BrowserNotificationCoordinationState =
  | { readonly state: "checking" }
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: BrowserNotificationCoordinationFailure };

export type BrowserNotificationClaimRejection =
  | "disabled"
  | "older-than-horizon"
  | "future-clock-skew"
  | "epoch-mismatch"
  | "unsupported"
  | "machine-removed"
  | "cancelled"
  | "disposed";

export type BrowserNotificationClaimGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: BrowserNotificationClaimRejection };

export type BrowserNotificationClaimResult =
  | { readonly kind: "claimed"; readonly record: BrowserNotificationClaimRecord }
  | { readonly kind: "existing"; readonly record: BrowserNotificationClaimRecord }
  | { readonly kind: "rejected"; readonly reason: BrowserNotificationClaimRejection }
  | { readonly kind: "unavailable"; readonly reason: BrowserNotificationCoordinationFailure };

export type BrowserNotificationBlockedResult =
  | { readonly kind: "blocked" }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly reason: BrowserNotificationCoordinationFailure };

export type BrowserNotificationPruneResult =
  | { readonly ok: true; readonly removed: number }
  | { readonly ok: false; readonly reason: BrowserNotificationCoordinationFailure };

export interface BrowserNotificationClaimStore {
  readonly coordination: BrowserNotificationCoordinationState;
  open(): Promise<BrowserNotificationCoordinationState>;
  tryClaim(
    candidate: BrowserCompletionCandidate,
    disposition: "displayed" | "suppressed",
    gate: () => BrowserNotificationClaimGateResult,
  ): Promise<BrowserNotificationClaimResult>;
  markBlocked(identity: string, claimedAt: number): Promise<BrowserNotificationBlockedResult>;
  prune(): Promise<BrowserNotificationPruneResult>;
  close(): void;
}

export interface BrowserNotificationClaimStoreOptions {
  readonly indexedDB: Pick<IDBFactory, "open"> | undefined;
  readonly now: () => number;
}

export declare function createBrowserNotificationClaimStore(
  options: BrowserNotificationClaimStoreOptions,
): BrowserNotificationClaimStore;
```

`gate` is synchronous and side-effect-free apart from a fresh preference read. It checks cancellation, preference, current epoch, machine retention, and capability at transaction execution time. The store independently performs the transaction-time horizon check using its injected clock. Store results resolve only after transaction completion or failure.

### 4.4 Viewer-query channel

`viewerQueryChannel.ts` exports the following declarations.

```ts
export interface BrowserNotificationViewerQuery {
  readonly kind: "viewer-query";
  readonly queryId: string;
  readonly identity: string;
}

export interface BrowserNotificationViewerReply {
  readonly kind: "viewer-reply";
  readonly queryId: string;
  readonly viewing: true;
}

export interface BrowserNotificationPreferenceChanged {
  readonly kind: "preference-changed";
  readonly enabled: boolean;
}

export type BrowserNotificationChannelMessage =
  | BrowserNotificationViewerQuery
  | BrowserNotificationViewerReply
  | BrowserNotificationPreferenceChanged;

export interface BrowserNotificationBroadcastChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface BrowserNotificationClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export type BrowserNotificationViewerResult = "viewing" | "not-viewing" | "cancelled";

export interface BrowserNotificationViewerChannel {
  readonly availability: "available" | "unavailable";
  query(identity: BrowserCompletionIdentity, signal: AbortSignal): Promise<BrowserNotificationViewerResult>;
  setClosing(closing: boolean): void;
  publishPreferenceChanged(enabled: boolean): void;
  close(): void;
}

export interface BrowserNotificationViewerChannelOptions {
  readonly origin: string;
  readonly createBroadcastChannel:
    (name: string) => BrowserNotificationBroadcastChannel | undefined;
  readonly clock: BrowserNotificationClock;
  readonly createQueryId: () => string;
  readonly isViewing: (identity: BrowserAlertSessionIdentity) => boolean;
  readonly onPreferenceChanged: () => void;
}

export declare function browserNotificationChannelName(origin: string): string;
export declare function createBrowserNotificationViewerChannel(
  options: BrowserNotificationViewerChannelOptions,
): BrowserNotificationViewerChannel;
```

`identity` on the wire is exactly `browserCompletionIdentity(...)`. Decode it as a JSON array of five elements in the specified order. Require four nonempty strings and a positive safe-integer order. Require canonical round-trip encoding. Unknown kinds, additional message keys, wrong discriminants, empty query IDs, false replies, malformed arrays, and replies for inactive query IDs are ignored. Query IDs are unique across live tabs and pending requests. The production adapter uses `crypto.randomUUID()` and tests inject deterministic unique values.

### 4.5 Payload

`payload.ts` exports the following declarations.

```ts
export interface BrowserNotificationNames {
  readonly sessionName: string | undefined;
  readonly projectName: string | undefined;
}

export interface BrowserNotificationPayload {
  readonly title: string;
  readonly body: "Session is idle";
  readonly tag: string;
  readonly renotify: false;
}

export declare function formatBrowserNotificationPayload(
  identity: BrowserCompletionIdentity,
  names: BrowserNotificationNames,
): BrowserNotificationPayload;
```

### 4.6 Click target

`alertTarget.ts` exports the following declarations.

```ts
export type BrowserAlertTargetFailure =
  | "machine-unavailable"
  | "workspace-missing"
  | "session-missing";

export type ResolveAlertTargetResult =
  | {
      readonly ok: true;
      readonly machineId: string;
      readonly projectId: string;
      readonly workspaceId: string;
      readonly sessionId: string;
    }
  | { readonly ok: false; readonly reason: BrowserAlertTargetFailure };

export interface BrowserAlertTargetCatalog {
  prepareMachine(machineId: string): Promise<boolean>;
  projects(machineId: string): readonly Project[];
  workspaces(machineId: string, projectId: string): readonly Workspace[] | undefined;
  loadWorkspaces(machineId: string, projectId: string): Promise<readonly Workspace[]>;
  loadSessions(machineId: string, workspacePath: string): Promise<readonly SessionInfo[]>;
}

export declare function resolveAlertTarget(
  identity: BrowserAlertSessionIdentity,
  catalog: BrowserAlertTargetCatalog,
): Promise<ResolveAlertTargetResult>;
```

`undefined` from `workspaces` means uncatalogued. An empty array means catalogued with no workspaces. The resolver retains loaded results locally for its one load pass.

### 4.7 Controller and browser ports

`controller.ts` exports the following declarations.

```ts
export interface BrowserNotificationHandle {
  onclick: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface BrowserNotificationApi {
  permission(): NotificationPermission | undefined;
  requestPermission(): Promise<NotificationPermission>;
  create(title: string, options: {
    body: string;
    tag: string;
    renotify: false;
  }): BrowserNotificationHandle;
}

export interface BrowserNotificationDocument {
  readonly visibilityState: DocumentVisibilityState;
  hasFocus(): boolean;
  addEventListener(type: "visibilitychange", listener: EventListener): void;
  removeEventListener(type: "visibilitychange", listener: EventListener): void;
}

export interface BrowserNotificationPageEvents {
  addEventListener(
    type: "storage" | "pageshow" | "pagehide" | "beforeunload",
    listener: EventListener,
  ): void;
  removeEventListener(
    type: "storage" | "pageshow" | "pagehide" | "beforeunload",
    listener: EventListener,
  ): void;
}

export interface BrowserNotificationAvailability {
  readonly notificationApi: "supported" | "unsupported";
  readonly secureContext: boolean;
  readonly permission: NotificationPermission | null;
  readonly preferenceStorage:
    | { readonly state: "available" }
    | { readonly state: "unavailable"; readonly reason: BrowserNotificationPreferenceFailure };
  readonly coordination: BrowserNotificationCoordinationState;
  readonly viewerSuppression: "available" | "unavailable";
  readonly operationError:
    | null
    | "permission-request-failed"
    | "notification-failed"
    | "navigation-failed";
}

export interface BrowserNotificationControllerSnapshot {
  readonly preference: BrowserNotificationPreference;
  readonly availability: BrowserNotificationAvailability;
  readonly enabling: boolean;
  readonly testing: boolean;
  readonly testResult: "idle" | "constructed" | "blocked" | "failed";
}

export type BrowserNotificationTestResult = "constructed" | "blocked" | "failed";

export interface BrowserNotificationControllerPort {
  readonly snapshot: BrowserNotificationControllerSnapshot;
  connect(): void;
  receiveSocketEvent(machineId: string, event: unknown): void;
  acceptSnapshot(epoch: BrowserNotificationAlertEpoch): void;
  setCapability(machineId: string, capability: SessionUnreadCapabilityState): void;
  retainMachines(machineIds: ReadonlySet<string>): void;
  setEnabled(enabled: boolean): Promise<void>;
  refreshAvailability(): Promise<void>;
  sendTestNotification(): Promise<BrowserNotificationTestResult>;
  dispose(): void;
}

export interface BrowserNotificationControllerOptions {
  readonly preferences: BrowserNotificationPreferenceStore;
  readonly candidates: BrowserNotificationCandidates;
  readonly claims: BrowserNotificationClaimStore;
  readonly createViewerChannel: (
    isViewing: (identity: BrowserAlertSessionIdentity) => boolean,
    onPreferenceChanged: () => void,
  ) => BrowserNotificationViewerChannel;
  readonly notification: BrowserNotificationApi | undefined;
  readonly isSecureContext: () => boolean;
  readonly document: BrowserNotificationDocument;
  readonly pageEvents: BrowserNotificationPageEvents;
  readonly clock: BrowserNotificationClock;
  readonly isActiveChat: (identity: BrowserAlertSessionIdentity) => boolean;
  readonly resolveNames: (identity: BrowserAlertSessionIdentity) => BrowserNotificationNames;
  readonly focusWindow: () => void;
  readonly navigate: (identity: BrowserAlertSessionIdentity) => Promise<void>;
  readonly onChange: (snapshot: BrowserNotificationControllerSnapshot) => void;
}

export declare class BrowserNotificationController implements BrowserNotificationControllerPort {
  constructor(options: BrowserNotificationControllerOptions);
  readonly snapshot: BrowserNotificationControllerSnapshot;
  connect(): void;
  receiveSocketEvent(machineId: string, event: unknown): void;
  acceptSnapshot(epoch: BrowserNotificationAlertEpoch): void;
  setCapability(machineId: string, capability: SessionUnreadCapabilityState): void;
  retainMachines(machineIds: ReadonlySet<string>): void;
  setEnabled(enabled: boolean): Promise<void>;
  refreshAvailability(): Promise<void>;
  sendTestNotification(): Promise<BrowserNotificationTestResult>;
  dispose(): void;
}
```

`permission === null` means the API is absent, its permission getter failed, or it returned no usable permission. For every usable API value preserve the browser's exact `default`, `granted`, or `denied` state. Permission and IndexedDB coordination have separate fields and separate remedies.

`refreshAvailability` reads the preference and browser capability/permission again and probes the claim store. It never requests permission or creates a candidate. A failed coordination probe can be retried by subsequent availability refreshes. Permission getter failures and unreadable preference storage are contained locally.

The browser adapter binds `Notification.permission`, `Notification.requestPermission()`, and `new Notification(...)`. Tests inject the entire port. Browser globals are accessed in app composition, with getters/factory access guarded against exceptions.

`connect` is idempotent for a live instance. It initializes storage/capability state, opens coordination, creates the viewer channel, and installs page/document listeners. `dispose` is idempotent and terminal for that instance. An app element reconnect creates a fresh controller and reattaches the snapshot listener. Disposal synchronously clears queues, aborts queries, cancels timers, removes listeners, closes the channel, and detaches or closes owned notification handles. Track outstanding claim operations through their post-commit finalizers. Close the claim store after those finalizers settle so an already completing winning transaction can still be rewritten to `blocked`. Disposal prevents any new claim operation or notification construction.

## 5. Constants, storage, and identity

| Owner | Exported constant or storage surface | Exact value |
| --- | --- | --- |
| `completionCandidates.ts` | `ALERT_DELIVERY_HORIZON_MS` | `86_400_000` milliseconds, equal to 24 hours |
| `completionCandidates.ts` | `MAX_CLOCK_SKEW_MS` | `300_000` milliseconds, equal to 5 minutes |
| `completionCandidates.ts` | `MAX_QUEUED_CANDIDATES_PER_MACHINE` | `32` |
| `completionCandidates.ts` | `CANDIDATE_LIFETIME_MS` | `30_000` milliseconds |
| `claimStore.ts` | `CLAIM_RETENTION_MS` | `ALERT_DELIVERY_HORIZON_MS + 2 * MAX_CLOCK_SKEW_MS`, equal to `87_000_000` milliseconds |
| `preferences.ts` | `BROWSER_NOTIFICATION_PREFERENCE_KEY` | `pi-webui-browser-notifications-v1` |
| `claimStore.ts` | `BROWSER_NOTIFICATION_DB_NAME` | `pi-webui-browser-notifications` |
| `claimStore.ts` | `BROWSER_NOTIFICATION_DB_VERSION` | `1` |
| `claimStore.ts` | `BROWSER_NOTIFICATION_CLAIMS_STORE` | `claims` |
| `claimStore.ts` | Object-store schema | Version-one database upgrade creates `claims` with out-of-line string keys, `keyPath === null`, and `autoIncrement === false`. There are no indexes. |
| `viewerQueryChannel.ts` | `VIEWER_REPLY_WINDOW_MS` | `250` milliseconds |
| Viewer channel | Channel name | `pi-webui:browser-notifications:${window.location.origin}` |
| Preference | Serialized enabled value | `{"version":1,"enabled":true}` |
| Preference | Serialized disabled value | `{"version":1,"enabled":false}` |

There is one localStorage preference key and one IndexedDB database per browser profile and origin. No additional focus, viewer, completion-watermark, or preference keys are introduced. The claim-record schema version is the IndexedDB version `1`.

The structured completion identity is `JSON.stringify([machineId, catalogId, sessionId, workspacePath, completionOrder])`. The selected-session identity is `JSON.stringify([machineId, sessionId, workspacePath])`. All comparisons use these structured identities or exact component equality. Catalog revision participates in validation metadata and never changes a completion's claim key. Paths containing pipes, colons, backslashes, quotes, or Unicode retain their exact identity.

The production channel factory receives `window.location.origin` directly. Every PI WEBUI mount under that origin shares viewer coordination, preference storage, and claims, including `/` and `/nested/pi-webui/`.

## 6. Snapshot-accepted seam and socket integration

Add the following public subscription to `SessionUnreadController` in `sessionUnread.ts`.

```ts
export interface SessionUnreadSnapshotAccepted {
  readonly machineId: string;
  readonly catalogId: string;
  readonly catalogRevision: number;
}

export type SessionUnreadSnapshotAcceptedListener =
  (snapshot: SessionUnreadSnapshotAccepted) => void;

// Public method on SessionUnreadController.
onSnapshotAccepted(listener: SessionUnreadSnapshotAcceptedListener): () => void;
```

Maintain a private listener set. Registration returns an idempotent unsubscribe function and performs no initial replay.

Fire listeners synchronously exactly once at the accepted exit of `applyNetworkSnapshot`, after its existing projection/status handling. The callback carries the accepted HTTP snapshot's `catalogId` and `catalogRevision`, together with `state.machineId`. It covers both `unreadCatalog` responses and acknowledgement responses accepted through that method. A valid same-catalog snapshot can be accepted even when a newer projection revision is retained or no projection change occurs, and still fires the callback. Observed socket replay cannot replace the callback's HTTP provenance.

The early rejection branch for an ambiguous concurrent epoch, observer overflow, or an observed different-catalog event does not fire the callback. Responses invalidated by removal, unsupported capability, or request generation never reach the accepted exit. A listener exception is caught per listener and reported through a local guarded warning, allowing the unread operation and other listeners to complete.

Socket application never installs an alert epoch. `applyEvent`, its catalog-reset branch, `onChange`, `projection()`, stale/loading changes, and socket events replayed around a snapshot cannot independently publish an accepted snapshot. The alert controller installs epochs exclusively from `onSnapshotAccepted`.

### App wiring

1. On connection, create/connect the browser controller and subscribe `sessionUnread.onSnapshotAccepted(snapshot => browserNotifications.acceptSnapshot(snapshot))`. Retain the unsubscribe function for disconnect. Keep the app's controller field `undefined` outside its connected lifetime, and make socket forwarding conditional on that field being present so existing disconnected component fixtures can still exercise unread projection behavior.
2. At both unread socket handlers, call `browserNotifications.receiveSocketEvent(machineId, event)` before `sessionUnread.applyEvent(machineId, event)`. The alert method is synchronous at receipt and catches boundary errors. Its later work is detached with contained rejection handling, allowing projection application in the same handler turn.
3. The boundary checks for `type === "sessions.unread"`, uses the existing validated unread parser, and copies only the allowed candidate fields. Unrelated or malformed messages exit before candidate creation.
4. Mirror every capability update to both controllers, including direct `unknown` writes at negotiation start and failure. Mirror retained machine IDs and empty retention at disconnect. Candidate admission uses the alert module's mirrored capability.
5. HTTP responses flow only through the snapshot subscription. Route restoration, read acknowledgements, resume, and reconnect cannot synthesize candidates.
6. On disconnect, unsubscribe before clearing unread machines and dispose the browser controller. Existing pending unread responses keep their own generation checks.

The existing `onChange` invocation conditions and projection algorithms retain their present contract. The new listener observes an additional source-specific seam. Existing unread tests must still pass, including gap recovery, event replay, stale acknowledgement handling, unsupported peers, and exact acknowledgement orders.

## 7. Candidate state machine

A candidate starts only at live socket receipt, before any unread projection effect. Fresh preference state and machine capability are checked before candidate construction. Capability defaults to `unknown` for a retained machine that has not completed negotiation.

| Current state or input | Guard/action | Next state or durable effect |
| --- | --- | --- |
| Socket receipt | Preference disabled or unreadable | Discard before candidate creation. Zero claim writes. |
| Socket receipt | Machine capability `unsupported` | Discard before candidate creation. Zero claim writes. |
| Socket receipt | Notification API unsupported, insecure context, or permission other than `granted` | Refresh the corresponding availability state and discard before candidate creation. Zero claim writes. |
| Socket receipt | Capability `unknown` or `supported`, preference enabled, valid unread event, usable browser delivery | Construct the candidate with receipt time and `expiresAt = receivedAt + 30_000`. |
| Candidate `kind === "removal"` | `unread === null` | Terminal discard. Zero queue admissions or claims. |
| Completion candidate | Matching snapshot-established epoch exists | Validate immediately, regardless of projection presence, freshness, loading, or revision gaps. |
| Completion candidate | Epoch absent or catalog differs | Queue for that machine. |
| Queue insertion | Thirty-two entries already queued | Evict the earliest received queued entry, then append the new entry. Keep exactly 32. Ties use insertion order. |
| Queued entry | `now >= expiresAt` | Discard. At exactly 30 seconds the entry is expired. |
| Accepted snapshot | Install or replace the machine epoch | Remove expired queued entries, discard entries whose fresh preference gate fails, and take matching entries for validation in FIFO order. Different-catalog entries continue waiting within their original lifetime. |
| Capability becomes `unknown` | Reconnect or runtime renegotiation | Retain the epoch and queue. Matching candidates continue immediately. |
| Capability becomes `supported` | Negotiation succeeds | Preserve the snapshot-only epoch rule. Process any matching queued candidates. |
| Capability becomes `unsupported` | Negotiation completes without unread support | Clear that machine's epoch and queued candidates, and cancel its pending work. |
| Machine removed | Retained set excludes the machine | Clear its epoch, queue, timers, and pending queries. Invalidate its generation. |
| Feature disabled | Local action or fresh storage read | Clear all queues and cancel all in-flight queries. Invalidate pending delivery ownership. |
| Validation | Preference disabled, unsupported/removed machine, stale ownership, or invalid time | Terminal discard before claim. |
| Validation | Matching epoch, valid time, enabled preference | Evaluate local viewer, then remote viewers when needed. |
| Viewer found | Preference and ownership still valid | Attempt atomic `suppressed` claim and finish silently. |
| Viewer window ends with no positive reply | Preference and ownership still valid | Attempt atomic `displayed` claim. |
| Claim result `existing` | Any of the three dispositions | Finish silently. |
| Claim result `rejected` or `unavailable` | No committed winning record | Finish silently. Publish availability only for a coordination failure. |
| Winning claim committed | Post-commit gate succeeds | Construct the notification for a `displayed` decision. A `suppressed` decision finishes silently. |
| Winning claim committed | Post-commit gate fails | Retain the record and rewrite its disposition to `blocked`. Finish silently. |
| Controller disposed | All pending states | Abandon pending work. An eventual winning commit is retained and marked `blocked`. |

`CANDIDATE_LIFETIME_MS` bounds waiting for a matching epoch. Once validation removes a candidate from that queue, the three delivery-horizon checks govern asynchronous viewer/transaction/construction stages. Queue expiry must not replace any of those checks.

`takeReady` drains only matching, unexpired queued entries and removes them from the queue. `admit` expires old queued entries before applying capacity. `acceptSnapshot` ignores snapshots for a removed or unsupported machine. The controller schedules cleanup at the earliest queued deadline and rechecks after resume even when background timers were throttled.

Repeated socket deliveries can be coalesced in memory by full completion identity while work is pending. IndexedDB remains the authority across tabs and after pending work ends. A new completion order produces a new identity, including for the same session. No global, catalog-wide, or per-session watermark can reject an otherwise unhandled completion.

## 8. Claims, delivery horizon, retention, and suspension

### 8.1 Time rules

A completion is within its delivery window when both inequalities hold.

- `now - completedAtMs <= ALERT_DELIVERY_HORIZON_MS`
- `completedAtMs - now <= MAX_CLOCK_SKEW_MS`

Equality is eligible at both boundaries. One millisecond beyond either boundary rejects. Unparsable daemon time uses the fixed receipt-time fallback from section 4.2. A browser clock ahead of the daemon shortens the window. A daemon timestamp too far ahead fails closed.

Evaluate the horizon at exactly these three decision stages, each using a fresh clock read.

| Stage | Required observation | Expired/future outcome |
| --- | --- | --- |
| Candidate validation | Before a viewer query or claim call | Zero claims and zero notifications. |
| Claim transaction | In the `get` success callback, after transaction serialization and immediately before writing an absent record | Zero new record and zero notifications. |
| Immediately before construction | After the winning transaction commits, after name resolution, with no intervening `await` before `notification.create` | Retain the committed record, rewrite to `blocked`, and construct zero notifications. |

Time rejection before a write creates no claim. Time rejection after commit never deletes the committed claim. Preference disable after commit has the same retained-`blocked` behavior. Post-commit epoch/ownership invalidation, lost permission, or disposal also produces a silent retained `blocked` decision.

### 8.2 Atomic claim transaction

For either `displayed` or `suppressed`, `tryClaim` performs one `readwrite` transaction over the `claims` store.

1. Open the database, with schema creation confined to the version-one upgrade. Resolve open, blocked-upgrade, and transaction failures into availability results.
2. Compute the structured identity from the candidate. Open a `readwrite` transaction and call `get(identity)`.
3. If any record exists, return `existing` after transaction completion. Preserve its disposition and timestamp.
4. If absent, evaluate the supplied synchronous gate and the store's fresh transaction-time horizon check immediately before writing. A rejected gate/time result finishes with zero writes.
5. Write the absent record using `add(record, identity)`, with the requested disposition, `claimedAt = now`, machine ID, and completion order. The read and write occur inside this one serialized transaction.
6. Resolve `claimed` only from `transaction.oncomplete`. A successful request followed by abort is an unavailable result and permits zero notification constructions.

Keep all transaction requests in IndexedDB callbacks. Network calls, viewer waits, timer waits, and unrelated awaited promises occur outside the transaction. Atomicity depends on the browser serializing overlapping `readwrite` transactions for this object store. A separate readonly lookup followed by a write transaction cannot satisfy the claim contract.

A `displayed` record reserves the sole construction attempt before construction occurs. `suppressed` records a terminal viewer decision. `blocked` records a committed attempt cancelled or failed before successful construction. Existing records of every disposition prevent another attempt.

`markBlocked(identity, claimedAt)` uses a second `readwrite` transaction, reads the record, and replaces only its disposition when its original `claimedAt` matches. It preserves `claimedAt`, machine ID, and order. A missing record or timestamp mismatch returns `absent` and creates nothing. A mismatched existing record is preserved. A failed rewrite reports coordination unavailability and retains any previously committed record. Delivery stays suppressed.

### 8.3 Suppression persistence

A local or remote positive viewer decision invokes `tryClaim(candidate, "suppressed", gate)` before abandoning that completion. If another tab already recorded it, the existing record satisfies completion handling. If the suppression write fails, construct zero notifications and report unavailable coordination. A viewer match never falls through to display after a storage failure.

The synchronous preference/ownership gate can cancel a suppression attempt before a record is written. Such a completion follows the disabled or cancelled lifecycle, with zero claims. An enabled, eligible positive viewer decision always attempts its durable `suppressed` decision.

### 8.4 Pruning

`prune` uses one `readwrite` cursor pass over `claims`, with a fixed cutoff `now() - CLAIM_RETENTION_MS` captured when the pass starts. Delete only records whose `claimedAt < cutoff`. At exactly the retention bound a record remains. Future-dated records remain. There is no count-based eviction and no deletion on catalog replacement, machine removal, preference changes, notification close, or tab closure.

Run pruning after a successful open during controller connection and on page resume/availability refresh. A pruning error reports coordination unavailability and suppresses new delivery until coordination is available. A later pass can retry. Pruning and claiming share the object store's transaction serialization.

The extra two clock-skew allowances retain claims strictly longer than the completion horizon. A suspended candidate rechecks time inside its eventual transaction even if another tab pruned the old record while it slept.

### 8.5 Fail-closed storage

Missing IndexedDB, blocked upgrades, open failures, aborted writes, and quota exhaustion prevent display. There is no in-memory or localStorage substitute for the atomic claim. Quota handling cannot delete a younger claim to make room. Permission can remain `granted` while coordination is unavailable.

## 9. Viewer coordination and lifecycle

### 9.1 Reply predicate

The controller supplies the viewer channel with a callback evaluated afresh for each query. A reply is positive only when all of the following are true at reply time.

1. The controller is connected, its channel is open, and its closing flag is false.
2. A fresh preference read is enabled.
3. The document is `visible` and `document.hasFocus()` is true.
4. Selected machine, session ID, and session `cwd` exactly match the requested identity.
5. The application's existing active-chat predicate is true.

In `PiWebUiApp`, widen the parameter type of `isSessionSeen` to `Pick<SessionInfo, "id" | "cwd">` so both read acknowledgement and browser viewing can call the same predicate. Its decision still checks `unreadConnected`, selected identity, `committedChatIdentity`, `readyChatIdentity`, `isChatObscured()`, and responsive visibility.

The responsive branch uses the current app contract. `mainView === "chat"` is visible. Navigation view is visible alongside chat when `!appShell.isMobileNavigationLayout`. A workspace tool view counts as viewing only when the actual desktop side-by-side layout exposes chat through `isDesktopSideBySideLayout()`. A tool covering chat at narrower widths cannot suppress.

`isChatObscured` includes settings, compact or expanded Activity Rail overlays, session cleanup/history, models/skills/plugins/system prompt dialogs, action palette, project browser/statistics, session browser, project/machine dialogs, command/tree/model/thinking/theme/auth dialogs, Git Update Manager, terminal modal, and the recent-project dialog. Use that function so additions to its obscuring set affect both acknowledgement and suppression.

### 9.2 Query protocol

- Evaluate the handling tab's own live viewer predicate first. A true result goes directly to the `suppressed` claim without broadcasting.
- Otherwise register a pending query, then broadcast `{ kind: "viewer-query", queryId, identity }` using the structured completion key.
- Wait at most `VIEWER_REPLY_WINDOW_MS`, measured from query publication with the injected clock. At 249 ms the query remains pending. At 250 ms it settles with `not-viewing` if no positive reply arrived.
- Any valid matching `{ kind: "viewer-reply", queryId, viewing: true }` received while pending settles `viewing`. Cancel its timer and persist the suppressed decision.
- A live responder computes current state and sends only positive replies. It keeps responding after its own candidate was suppressed or displayed.
- A reply for another query, a late reply, a malformed reply, or a remembered focus state cannot affect a settled query.
- Disabling, removing the candidate's machine, closing the page, and disposal cancel pending queries. Cancellation never becomes `not-viewing`.

If channel creation or posting fails, or BroadcastChannel is absent, set viewer suppression availability to `unavailable`. Resolve eligible queries with `not-viewing` and continue through the IndexedDB claim. The local viewer predicate still applies. Settings explains the cross-window limitation.

### 9.3 Closing flag

| Browser event | Synchronous action |
| --- | --- |
| `pagehide` | Set closing true and call `viewerChannel.setClosing(true)` before asynchronous cleanup. Cancel local pending candidate queries. |
| `beforeunload` | Set closing true and stop positive replies immediately. |
| `pageshow` with `persisted === true` | Clear closing and call `setClosing(false)`, then refresh preference/availability and expire queues. Resume responding from current state. |
| Ordinary `pageshow` | Refresh preference/availability and queue expiry. Initial connection already starts with closing false. |
| Controller disposal | Mark terminally closed, cancel requests, detach handlers, and close the channel. |

Keep the channel available across back-forward-cache suspension so a persisted `pageshow` can resume it. A closing responder must ignore an arriving query even if its previous focus state was true. Visibility/focus is read synchronously when responding, so a delayed blur publication has no authority. There is no stored viewer lease or heartbeat.

## 10. Preference and permission lifecycle

### Four fresh preference gates

| Gate | Fresh read and action |
| --- | --- |
| Socket admission | Read the origin-scoped preference before creating a candidate. Disabled/unreadable means no candidate and no claim. |
| Queued validation | Read again as a queued candidate is taken for validation. Disabled/unreadable discards it. Immediate validation also reads current state. |
| Immediately before claiming | Read after the viewer result and again through the synchronous transaction gate when serialization permits the write. A disable invalidates the query generation even if re-enable occurs before its promise settles. |
| After claim resolution | Read immediately before construction. A disable during transaction completion creates zero notifications and rewrites the retained winning record to `blocked`. |

Disabling synchronously clears queues and cancels pending queries before storage or async work. Persist `enabled: false` without requesting permission. If a storage write fails, this controller latches disabled until a successful explicit preference write, and exposes the storage error. Fresh reads continue, with the error latch forcing a disabled result. A failed write is never reported as a successfully synchronized preference change.

On `storage` for this key or `key === null`, `visibilitychange`, and every `pageshow`, reread storage and capability/permission. A successfully changed preference broadcasts `{ kind: "preference-changed", enabled }` as a latency optimisation. Receipt of that message triggers a fresh read and does not trust its boolean as stored authority. Storage reads at all four gates preserve cross-tab correctness when broadcasts are absent or delayed.

A tab with a disabled or unreadable preference never replies `viewing: true`. Enabling affects future live events and candidates admitted under a continuously enabled generation. Re-enabling cannot revive discarded work or replay a blocked/suppressed/displayed claim.

### Explicit enable action

`setEnabled(true)` is called directly from the switch's user change handler. Read support, secure context, permission, and storage access synchronously. When permission is `default`, invoke `requestPermission()` in that activation turn, before the first awaited operation. Opening Settings, refreshing availability, receiving an event, testing, page resume, or observing another tab's enable never requests permission.

| Observed state | Enable behavior and persisted result |
| --- | --- |
| Notification API absent | Report unsupported. Keep disabled. Zero permission calls. |
| Insecure context | Report secure-context requirement. Keep disabled. Zero permission calls. Use the browser's `isSecureContext` value, including loopback exemptions. |
| Permission unavailable | Show unavailable permission. Keep disabled. Zero constructor calls. |
| Permission `default` | Request once for this explicit action. Keep disabled if the result is still `default`. |
| Permission `denied` | Keep disabled and show site/OS permission guidance. An enable action cannot bypass the browser restriction. |
| Permission `granted` | Persist enabled after this action remains current. Coordination availability independently gates delivery. |
| Request rejects or throws | Keep disabled, show `permission-request-failed`, and contain the rejection. |
| Preference persistence fails | Effective preference disabled with storage error. |

A second disable or controller disposal invalidates an in-flight permission request. A late `granted` response cannot write enabled afterward. When a later availability refresh observes permission revoked to `default`, `denied`, or unavailable, stop pending delivery and normalize this controller's preference to disabled through the same storage path. A new explicit enable is required after permission becomes usable again.

## 11. Notification construction and payload

### 11.1 Exact names and wording

Resolve names from already available metadata for the candidate's machine and exact workspace. A metadata lookup failure falls through to deterministic names and never blocks delivery.

| Value | Resolution order |
| --- | --- |
| Session display name | Nonempty trimmed `SessionInfo.name`, otherwise `Session ${shortId}`. `shortId` is the first eight Unicode code points of `sessionId`, or the entire ID when shorter. |
| Project display name | Nonempty trimmed `Project.name` for the project containing the exact workspace path, otherwise the workspace basename, otherwise `Project`. |
| Workspace basename | Remove trailing `/` and `\`, take the final component across either separator, and treat an empty result or bare drive designator such as `C:` as unavailable. |
| Title | `${sessionDisplayName} — ${projectDisplayName}` |
| Body | `Session is idle` |
| Tag | `pi-webui:browser-notifications:${browserCompletionIdentity(candidate)}` |
| `renotify` | `false` |

Collapse CR, LF, and tab runs in resolved display names to one space after trimming. Session metadata resolution reads only `id`, `cwd`, and `name`. Project resolution reads its name and workspace membership. `SessionInfo.firstMessage` is never a name fallback.

No prompt, assistant response, tool output, extension text, or severity ever enters the payload. Payload construction is an allowlist of session name, project name, approved idle wording, and the identity-only tag. Browser options contain exactly `body`, `tag`, and `renotify`. Navigation identity stays in the click closure. No event object or transcript is attached as notification data.

The unique completion tag avoids grouping independent completion identities. Duplicate prevention remains the committed claim. A later completion of the same session has a different tag and claim.

### 11.2 Construction and handlers

1. Obtain a winning committed `displayed` claim.
2. Resolve names synchronously with guarded fallback handling.
3. Check live ownership, capability, epoch, preference, API/secure-context/permission, and the final horizon. With all gates passing, call the injected Notification constructor in the same synchronous continuation.
4. Bind `onclick`, `onclose`, and `onerror` on the returned handle and track it locally for cleanup.

On click, prevent the default action when available and synchronously attempt `focusWindow()` before asynchronous catalog work. Close the alert, then invoke app navigation with the captured machine/session/workspace identity. Close again through guarded finalization if needed so every outcome closes it. Contain focus, close, and navigation errors. A failed focus attempt still permits target navigation to run in the owning browsing context.

`onclose` detaches handlers and removes the handle from the controller's local set. It performs no claim deletion, acknowledgement, inbox dismissal, or requeue. Constructor errors or `onerror` set `operationError: "notification-failed"` and conditionally mark the claim `blocked`. Keep the durable claim after failure so a replay cannot produce another construction attempt. Errors in finalization cannot escape to realtime processing.

### 11.3 Explicit test notification

`sendTestNotification` requires effective enabled preference, secure context, supported API, granted permission, and available IndexedDB coordination. Otherwise it returns `blocked` without prompting. It constructs the fixed title `Test session — PI WEBUI`, body `Session is idle`, tag `pi-webui:browser-notifications:test`, and `renotify: false`.

This user action creates no completion candidate, epoch, claim, or unread acknowledgement. It bypasses viewer suppression so a user can exercise the browser surface from Settings. Its click focuses the window and closes the alert. It has no session navigation target. A successful constructor returns `constructed` and sets test feedback to `constructed`. A constructor failure returns `failed`. A later error event changes the snapshot's test feedback to `failed`, while an already settled return value retains its original result. The panel labels this as a test and does not claim that the OS displayed a banner.

## 12. Click navigation

### 12.1 Resolution

`resolveAlertTarget` runs only on click, using the captured machine ID, session ID, and workspace path. It never derives project or workspace IDs from names, path delimiters, or the notification title.

| Stage | Required operation | Failure |
| --- | --- | --- |
| Machine | `prepareMachine` verifies machine registry membership, selects a different machine with `machines.selectMachine(machine, { updateUrl: false })`, and awaits its project catalog and runtime result. For an already selected machine it awaits any needed catalog/runtime preparation. | Unknown/removed machine, offline/unusable runtime, or machine preparation failure → `machine-unavailable`. |
| Workspace | Iterate the requested machine's projects in catalog order. For each, use its catalogued workspace list or await one `workspacesApi.workspaces(projectId, machineId)` load. Match `workspace.path === identity.workspacePath` and its project membership. Stop at the first exact match. | No match after one pass, including inaccessible lists → `workspace-missing`. |
| Session | Await `sessionsApi.sessions(workspace.path, machineId)` for that exact workspace. Require both `id === identity.sessionId` and `cwd === identity.workspacePath`. | Missing session or list failure → `session-missing`. |
| Result | Return all four resolved identifiers. | Each failure contains only the named reason. |

Workspace loads are bounded to at most one per project during a resolution. An empty catalogued list is used as such. An uncatalogued project is loaded in its catalog position even if a later project's cached list contains a match. This preserves deterministic catalog-order selection. Catalog lookups for delivery-time wording never initiate this click-time navigation or load pass.

### 12.2 App activation sequence

Implement private app glue `activateBrowserNotificationTarget(identity: BrowserAlertSessionIdentity): Promise<void>` and `dismissBrowserNotificationOverlays(): void` in `PiWebUiApp.ts`. Extend `PiWebUiAppDependencies` with `createBrowserNotificationController?: (options: BrowserNotificationControllerOptions) => BrowserNotificationControllerPort` for boundary tests.

1. Cancel pending keyboard/navigation selection and capture the resulting `navigationSelectionSeq` plus the app's route-restoration generation as this activation's ownership. A newer navigation, route restoration, or click invalidates it. Check ownership after every await and before every subsequent app mutation, selection call, notice, or final route write. Enter the existing route-restoration guard for the full resolution/selection attempt and balance it in `finally`.
2. Resolve the alert target through the catalog port. Its machine preparation uses `updateUrl: false` and awaits the runtime because `MachineController.selectMachine` currently starts runtime refresh in the background. Require the runtime's machine ID to match, `ok === true`, and the selected machine and applied project catalog to still belong to this activation. A needed explicit `projects.loadProjects()` must return true. Catalog-port closures check activation ownership before publishing or returning state.
3. On failure, publish the corresponding explicit unavailable-target notice and finish. On success, dismiss every surface currently covered by `isChatObscured()` before selecting chat.
4. Close Settings and remove its `settings` parameter using `writeSettingsSection(undefined, { replace: true })`. Reuse close helpers for Activity Rail, terminal modal, recent-project, statistics, cleanup/history, browser, auth, tree, and other dialogs so their cleanup and async generations are honored. Clear the corresponding remaining app/dialog flags. Closing a UI surface must use its existing UI-close lifecycle.
5. Set `mainView: "chat"` through state without an intermediate route write. Update relevant polling through existing app helpers. This explicitly leaves any full-width workspace tool surface.
6. Verify the resolved machine is still selected and registered, or select it through `MachineController` with URL writing disabled and revalidate its catalogs. Select the resolved project through `workspaces.selectProject(project, { workspaceId, sessionId, updateUrl: false })`. This project path sets the selected project and normally selects its requested workspace.
7. Ensure the resolved workspace is selected through `workspaces.selectWorkspace(workspace, { sessionId, updateUrl: false })` when project selection has not already selected it with the requested session. Set chat view explicitly again after awaited selection. `selectWorkspace` by itself sets neither the selected project nor chat view.
8. Before writing any target route, compare selected machine ID, project ID, workspace ID, workspace path, session ID, session `cwd`, and `mainView === "chat"` against the resolved target and original workspace path. Verify the activation generation still owns the operation. A selection fallback to another session fails this comparison.
9. Write the complete successful route with `writeRoute({ machineId, projectId, workspaceId, sessionId, tool: undefined, view: "chat" })`. Use the established machine-navigation-memory update and workspace-surface query cleanup helpers. The writer encodes query values and omits the local-machine parameter according to its existing convention.
10. If a target disappeared or selected state mismatches, publish the appropriate notice and perform zero target-route writes. Intermediate machine/project state may have loaded, but the URL must never advertise a partially selected target. Finally exit the restoration guard and allow normal ready-chat/read-acknowledgement behavior.

While an alert activation owns the navigation generation, defer app `updateUrl` calls from nested selection work until step 9. This includes the existing default-project selection performed by `ProjectController.loadProjects` for an empty project catalog. The route-restoration guard also prevents workspace-surface query writes during selection. A newer user navigation invalidates the alert's deferral so its ordinary route writes can proceed. Pass `updateUrl: false` through the explicit selection calls and perform the final complete target write only after equality checks.

`restoreRouteFor` remains the general restoration path. Alert activation uses validated target selection and final equality checks because the general path can retain an existing view or stop at a missing project. `selectSessionFromNavigation` remains a navigation precedent, with its same-workspace fast path and cross-workspace `selectWorkspace` behavior.

### 12.3 User-visible notices

Use the existing app error notice surface for click-target failures. Ordinary availability errors stay in browser-notification Settings state.

| Reason or post-selection failure | Exact notice |
| --- | --- |
| `machine-unavailable` or machine disappears during selection | `The machine for this browser notification is unavailable.` |
| `workspace-missing`, missing project, or workspace mismatch | `The workspace for this browser notification is no longer available.` |
| `session-missing` or selected-session mismatch | `The session for this browser notification is no longer available.` |
| Unexpected activation exception | `Could not open the session for this browser notification.` |

A superseded activation must not overwrite a newer selection or write a route. Any unexpected navigation exception also sets browser-notification `operationError: "navigation-failed"`. The notification closes for successful, failed, and superseded activation.

## 13. Settings route, panel, and controls

### 13.1 Route and property wiring

Add `"notifications"` to `SettingsSection`. `parseSettingsSection("notifications")` returns it, and `readSettingsSection`/`writeSettingsSection` use `?settings=notifications` with the current pathname, hash, and other query fields preserved.

Add the Settings navigation item immediately after General with label **Notifications** and detail **This browser**. Add `"settings-notifications-panel"` to `SettingsPanelTag` and map `activeSettingsPanelTag("notifications")` to it. `renderActiveSection` renders exactly that panel for this route.

Add these app-fed properties to `SettingsDialog` and forward them to the panel.

```ts
browserNotificationState: BrowserNotificationControllerSnapshot | undefined;
onSetBrowserNotificationsEnabled?: (enabled: boolean) => Promise<void>;
onTestBrowserNotification?: () => Promise<BrowserNotificationTestResult>;
```

`SettingsNotificationsPanel` exposes the following Lit properties and element declaration.

```ts
@property({ attribute: false })
state: BrowserNotificationControllerSnapshot | undefined;

@property({ attribute: false })
onSetEnabled?: (enabled: boolean) => Promise<void>;

@property({ attribute: false })
onTest?: () => Promise<BrowserNotificationTestResult>;

declare global {
  interface HTMLElementTagNameMap {
    "settings-notifications-panel": SettingsNotificationsPanel;
  }
}
```

The component uses `settings-panel-frame` with heading **Browser notifications**. Its direct-control layout groups the switch, permission/availability status, test action, conditions, and delivery limit. The app owns state and actions across Settings mount/unmount. The panel requires no server config response and its feature controls are independent of selected-machine settings loaders.

### 13.2 Required copy and controls

Always display the exact separation sentence `Browser notifications are separate from the session notification inbox shown in chat.`

| Element | Required behavior/copy |
| --- | --- |
| Scope description | `Applies to this browser profile and origin, across connected machines and projects.` |
| Enable control | Checkbox with `role="switch"` and accessible label `Enable browser notifications`. Checked from effective preference. Change invokes `onSetEnabled(checked)` directly in the user activation turn. |
| Permission row | Label `Browser permission`, with `Not requested`, `Granted`, `Blocked`, or `Unavailable` for `default`, `granted`, `denied`, or `null`. |
| Permission prompt pending | Status `Waiting for browser permission…`. The switch prevents duplicate enable actions. Turning an enabled feature off remains available. |
| Test control | Button `Send test notification`. Disabled while testing/enabling, feature disabled, API unavailable, insecure, permission other than granted, or coordination other than available. |
| Test pending | Status `Creating test notification…`. |
| Test constructed | Status `Test notification created.` |
| Test blocked | Status `Enable browser notifications and allow browser permission before testing.` Use the specific availability notice as well when coordination/support prevents the test. |
| Test failed | Error `The browser could not create the test notification.` |
| Alert conditions | `Alerts appear when a session becomes idle while you are looking elsewhere. A focused, visible window showing that session suppresses its alert.` |
| Delivery limit | `Requires an open, connected PI WEBUI page. Closed, suspended, disconnected, or offline pages cannot receive live completions. Alerts are not reconstructed from page load or reconnect.` |
| Content description | `Alerts contain the session name, project name, and “Session is idle”.` |

### 13.3 Availability messages and control states

Show concurrent restrictions independently, especially permission and IndexedDB availability. Use `SettingsNotice` entries with `availability`/`error` for blocking failures and `warning` for the viewer-channel limitation. Render status and error feedback through the frame's roles.

| State | Required visible message and enable behavior |
| --- | --- |
| State not yet supplied | `Checking browser notification availability…`. Disable enable and test. |
| Preference disabled, usable environment | Switch off. Permission row remains visible. Enable requests permission only under the rules in section 10. |
| Enabled, granted, coordinated | Switch on, permission `Granted`, test enabled while idle. |
| API unsupported | `Browser notifications are unavailable because this browser does not support the Notification API.` Disable enabling and test. |
| Insecure context | `Browser notifications require a secure context. Use HTTPS outside localhost or loopback.` Disable enabling and test. |
| Permission default | `Enable browser notifications to request permission.` Switch off. |
| Permission denied | `This browser blocks notifications for PI WEBUI. Allow notifications in this site's browser permissions and check your operating system's notification settings, then enable browser notifications again.` Switch off and prevent permission re-prompt. |
| Permission unavailable | `Browser notification permission is unavailable in this context.` Disable enabling and test. |
| Preference storage failure | `Browser notification preferences could not be saved or read. Browser notifications are off in this page.` Effective switch off. A successful explicit preference write can recover the local error latch. |
| Coordination checking | `Checking cross-window duplicate prevention…`. Test disabled and automatic delivery gated. |
| IndexedDB unavailable/open/upgrade/write failure | `Browser notifications are unavailable because cross-window duplicate prevention could not access browser storage.` Test disabled. Preserve permission as reported. |
| Quota exceeded | `Browser notifications are unavailable because browser storage is full. Free site storage before trying again.` Test disabled. Preserve younger claims. |
| Viewer channel unavailable | `Cross-window viewer suppression is unavailable in this browser. Duplicate prevention still applies.` Delivery and test can remain available through IndexedDB. |
| Permission request failure | `The browser could not request notification permission.` Keep preference disabled. |
| Notification construction/display failure | `The browser could not create or display a notification.` Preserve the claim and report the operation error locally. |
| Navigation failure | `Could not open the session for this browser notification.` Also show the app's click notice from section 12.3. |

If a previously enabled environment becomes unavailable, the user can always turn the feature off. Disable restrictions apply to an off-to-on action. There is no extra Save action, per-machine preference, severity selector, or inbox-message preview in this panel.

## 14. Error handling

| Condition | Detection | User-visible state | Alert suppressed |
| --- | --- | --- | --- |
| Notification absent | Guarded construction of the browser port | API unsupported message and disabled enable/test | Yes, before claim/construction |
| Insecure context | Fresh injected `isSecureContext()` | Secure-context message | Yes, zero permission calls |
| Permission default | Fresh permission getter | `Not requested` with explicit-enable guidance | Yes, until an explicit enable grants permission |
| Permission denied | Getter or explicit permission result | `Blocked` with site and OS settings guidance, effective preference disabled | Yes |
| Permission unavailable/getter throws | Missing or unusable permission value, caught boundary error | Permission unavailable message | Yes |
| Permission request throws/rejects | Explicit-enable promise rejection | `permission-request-failed` | Yes |
| Preference read/write failure | Guarded localStorage access | Preference storage unavailable, effective disabled | Yes, with post-commit `blocked` rewrite when applicable |
| IndexedDB absent | Factory unavailable | Coordination unavailable, separate permission row | Yes |
| IndexedDB open failure | Open request throws or errors | Coordination `open-failed` | Yes |
| Upgrade blocked | Open request `blocked` or upgrade failure | Coordination `upgrade-blocked` or `open-failed` | Yes |
| Claim/prune/rewrite transaction fails | Request/transaction error or abort, even after request success | Coordination `write-failed` | Yes. A previous committed claim is retained. |
| Origin quota exhausted | `QuotaExceededError` from request, transaction, or open | Coordination `quota-exceeded` and storage-full guidance | Yes, zero notification construction |
| BroadcastChannel absent | Factory returns undefined | Viewer suppression unavailable warning | Remote-viewer suppression skipped. Local viewing and claim duplicate prevention still apply. |
| Channel creation/posting throws | Guarded factory/postMessage | Same viewer suppression warning | Claim-based delivery can proceed if other gates pass. |
| Malformed unread event | Existing parser rejects type/identity/order/timestamp/limits | No feature-level notice | Yes, zero candidates and claims |
| Inbox/content-bearing unrelated event | Event kind rejected before candidate construction | No browser-notification state change | Yes, zero candidates and claims |
| Malformed channel message | Strict kind/field/identity decoding | No notice | Cannot produce or suppress an alert through a reply |
| Outside horizon/future skew | Three required time checks | No error notice | Yes, with stage-appropriate absent or blocked claim |
| Viewer found | Fresh local predicate or timely valid reply | No error notice | Yes, durable `suppressed` decision required |
| Duplicate completion | Existing claim in transaction | No error notice | Yes |
| Notification constructor throws | Guarded `notification.create` | Local `notification-failed` | Yes, retained claim marked `blocked` |
| Notification error event | Handle `onerror` | Same local delivery error | Construction already attempted. Claim prevents another attempt. |
| Target unavailable | Resolution or final selection verification | Explicit app notice for its reason | Alert closes. No target route is written. |
| Click/focus/close handler failure | Guarded browser and app callbacks | Local operation error and app notice for navigation failure | No replay or new claim. Realtime processing continues. |

An open request that later succeeds after its blocked/open attempt was abandoned closes that late connection instead of resurrecting a disposed store. Close database connections on `versionchange`. Database failures never escape socket handlers or change unread projections/session operation.

## 15. Documentation and release deliverables

The implementation adds an FAQ contents link `#browser-notifications` and an `<article id="browser-notifications" class="faq-item">` headed **Browser notifications** in `docs/faq.html`, following the page's existing article structure. Cover the following user-facing points in that entry.

- Enable through **Settings → Notifications → Enable browser notifications**. The preference belongs to the browser profile and origin.
- Browser permission is prompted only from enabling. Explain browser site permission denial and operating-system notification controls.
- Secure context is required, with localhost/loopback exemptions reported by the browser.
- Live alerts require an open, connected page. Explain suspended, offline, disconnected, closed-page, reload, and reconnect limits.
- Alerts say **Session is idle**, contain session/project names, and focus/navigate on click. Becoming idle carries no outcome verdict.
- Include the exact separation sentence from section 13.
- IndexedDB availability and quota gate duplicate prevention. BroadcastChannel absence limits cross-window viewer suppression.

The feature preference's canonical user instructions live in this FAQ entry. Repository configuration remains the existing global/project configuration model. The browser preference has no config-file key, environment variable, config API mutation, or `$PI_WEBUI_DATA_DIR` state file. Documentation scope for `docs/config.md` and `docs/config.html` is zero edits for this feature.

Create `.changeset/idle-session-browser-notifications.md` during implementation with this exact fragment.

```md
---
"@hyperdreamer/pi-webui": minor
---

Add opt-in browser notifications when sessions become idle, with cross-tab duplicate prevention and click navigation to the session.
```

The bump is `minor` because this adds a backward-compatible user-facing capability. `.changeset/config.json` continues to supply the package's release tooling configuration. Changelog generation occurs through the existing Changesets release process.

| File | Update scope |
| --- | --- |
| `README.md` | None. Preserve the existing quick start and product overview byte-for-byte. |
| `CHANGELOG.md` | Generated at release time. |
| Package version and lockfile | Release preparation owns versioning. |

The implementation loads entirely through the web/UI path. The UI/API reload path is sufficient for activation. Session-daemon restart requirements introduced by other features remain documented in their own operational guidance.

## 16. Verification plan

### 16.1 Harness and commands

Use colocated `*.test.ts` files, Vitest `describe`/`it`/`expect`/`vi`, typed local fixtures, controllable promises, and fake clocks. Tests run in the current default Node environment unless a component needs real DOM interaction, in which case use `// @vitest-environment jsdom`. Existing `vitest.config.ts` discovers `src/**/*.test.ts`, defaults to one worker, and has no global setup requirement for this feature.

Controller tests inject preference storage, candidate queue, claim store, viewer channel, Notification port, document focus/visibility, page events, and clock. Claim-store tests exercise the real store adapter with an injected transaction-capable IndexedDB fake, including transaction completion, abort, serialization, and direct raw-record inspection. Controller fakes model only external boundaries. Browser checks below prove native IndexedDB and Notification behavior.

Reuse existing component DOM harness conventions from `SettingsSessiondPanel.test.ts` and existing app state fixtures. Prefer real shadow-DOM change/click events for the new panel. `activeSettingsPanelTag` is the dialog routing assertion. Use template handler extraction only for a narrow wiring assertion satisfying the repository testing-guide conditions, with the required explanation and semantic marker. Focus, geometry, responsive visibility, and desktop notification behavior require Chromium evidence.

Run focused checks first with `npm test -- --run <test-file>`, then `npm run typecheck` and focused ESLint. Use `npm run verify:fast` for broad routine implementation feedback. Use `npm run verify` for final integration validation. Run a full suite with exclusive heavy-work ownership to avoid the repository's timing-sensitive resource contention.

The following tables prescribe exact `it` names. Each name belongs to the listed file. All fixtures use enabled preference, granted permission, valid epoch, available coordination, and a non-viewing document unless a row overrides them. Let `T0 = Date.parse("2026-11-21T12:00:00.000Z")`, `H = ALERT_DELIVERY_HORIZON_MS`, `S = MAX_CLOCK_SKEW_MS`, and `R = CLAIM_RETENTION_MS`.

### 16.2 Preference tests

File `src/client/src/browserNotifications/preferences.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `preference_defaults_to_disabled` | Empty storage, malformed JSON, wrong version, nonboolean enabled, extra keys | Read each fixture | Every result decodes to `{ version: 1, enabled: false }`. Reading performs zero writes. |
| `preference_round_trips_origin_storage` | Typed storage map | Write true, read, write false, read | Exactly one key is used. Stored bytes equal the two specified JSON strings and read values match. |
| `preference_storage_failure_fails_disabled` | Missing storage and throwing get/set adapters | Read/write | Failure reason matches operation and effective preference is false. Exceptions do not escape. A failed disable latches false until a successful explicit write. |

### 16.3 Candidate and epoch tests

File `src/client/src/browserNotifications/completionCandidates.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `structured_identity_is_machine_and_workspace_scoped` | Same session ID across two machines and two workspaces | Encode completion and selected-session identities | Keys equal the specified JSON arrays. All distinct tuples have distinct keys. |
| `pipe_and_quote_bearing_paths_are_unambiguous` | Paths `/a\|b:c/"d"` and tuples that collide under delimiter joining | Encode/decode | Round-trip components equal input byte-for-byte and different tuples yield different keys. |
| `candidate_uses_receipt_time_for_unparsable_timestamp` | Typed event with unparsable `completedAt`, receipt `T0` | Construct and evaluate later | `completedAtMs === T0`, with no fallback recomputation as time advances. |
| `candidate_time_boundaries_are_exact` | Completion ages `H`, `H + 1`, future offsets `S`, `S + 1` | Evaluate at `T0` | Results are eligible, `older-than-horizon`, eligible, `future-clock-skew` respectively. |
| `candidate_waits_for_matching_snapshot_epoch` | Capability unknown, no epoch | Admit A, accept B, drain, accept A, drain | Admission queued, B yields zero ready entries, A yields exactly the original candidate once. |
| `queued_candidate_expires_at_thirty_seconds` | Two independent copies of a candidate queued at `T0` | Install matching epoch and drain the first at `T0 + 29_999`, and the second at `T0 + 30_000` | First yields exactly its original candidate once. Second yields zero candidates at exact expiry. |
| `queue_is_fifo_bounded_to_thirty_two` | Thirty-three ordered unmatched candidates | Admit all | Last admission reports the first candidate as evicted. Matching snapshot drains exactly candidates 2 through 33 in order. |
| `unknown_retains_epoch_and_supported_does_not_create_one` | Accepted A, then unknown, plus a separate machine without an epoch | Admit A while unknown, set other machine supported | A is ready. The other machine's epoch remains undefined. |
| `unsupported_and_removed_machines_clear_state` | Two machines with epochs and unmatched queues | Set one unsupported and remove the other | Epochs undefined, drained queues empty, future unsupported admission discarded. |

### 16.4 Accepted-snapshot seam tests

File `src/client/src/sessionUnread.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `snapshot_accepted_fires_for_http_sources_only` | Listener and fake unread/ack API | Apply socket reset/event, accept GET snapshot, accept ack snapshot | Zero callbacks for sockets, one callback per accepted HTTP response with exact machine/catalog/revision. |
| `snapshot_accepted_fires_without_projection_change` | Current same-catalog projection newer than accepted HTTP snapshot | Accept same-catalog snapshot whose projection loses the revision comparison | Listener fires once with HTTP snapshot revision and the newer projection remains authoritative. |
| `snapshot_accepted_ignores_rejected_and_invalidated_responses` | Ambiguous epoch, overflowing observer, mixed observed catalogs, removed machine, unsupported generation | Complete each deferred response | Rejected/invalidated responses produce zero accepted callbacks. Existing refresh/generation behavior is preserved. |
| `snapshot_listener_unsubscribe_and_error_are_contained` | Throwing listener, healthy listener, unsubscribed listener | Accept snapshot and unsubscribe twice | Healthy listener called once, unsubscribed listener zero calls, unread refresh resolves and projection matches the accepted snapshot. |

### 16.5 Claim-store tests

File `src/client/src/browserNotifications/claimStore.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `claim_schema_is_origin_shared_version_one` | Injected IndexedDB factory | Open twice through independent store instances | Database name/version and store schema exactly match section 5. Both connections observe the same record. |
| `claim_read_and_write_share_one_transaction` | Absent key and a transaction-observing fake | `tryClaim` | The same `readwrite` transaction performs `get` before `add`. Result is pending until `oncomplete`, then exactly one record exists with all four fields. |
| `claim_race_has_one_winner` | Two store instances sharing a serialized database and one candidate | Start both claims concurrently | Exactly one `claimed`, one `existing`, and one raw record. Controller integration constructs only for the winner. |
| `reverse_order_commits_preserve_independent_completions` | Sessions A order 20 and B order 10 in two tabs | Commit A before B | Both raw keys contain distinct displayed records with orders 20 and 10. Replaying either returns existing. |
| `retention_prunes_strictly_by_age` | Target record claimed at `T0` and younger control record | Prune/read at `T0 + R - 1`, `T0 + R`, and `T0 + R + 1` | Target present, present, absent respectively. Last pass reports exactly one removal and retains the younger control byte-for-byte. |
| `more_than_two_thousand_claims_remain_inside_horizon` | 2,001 distinct sequential completions within H | Commit all, prune, replay the first | All 2,001 raw records remain. Replay returns `existing` for the first identity. |
| `mark_blocked_preserves_claim_identity_and_age` | Winning displayed claim | Rewrite with matching claimedAt, then inspect | Exact same key and timestamp/machine/order, disposition `blocked`. Wrong claimedAt and missing-key rewrites create no new record. |
| `claim_store_open_upgrade_write_and_quota_fail_closed` | Parameterized missing factory, open error, blocked upgrade, add error, transaction abort, quota error | Open/claim/prune as appropriate | Result reason matches failure. No successful claim is returned for aborted work. Quota never evicts retained younger records. |
| `claim_transaction_rechecks_horizon_before_write` | Candidate valid at validation, transaction held before its absent-key write | Advance to H + 1 and release | Result `rejected` with `older-than-horizon` and raw key absent. |
| `claim_post_request_abort_never_authorizes_delivery` | Successful add request followed by transaction abort | Settle transaction | Result `unavailable`, raw record absent, zero construction permission for caller. |
| `late_open_and_versionchange_close_connections` | Deferred open after failed/closed ownership and a live connection | Complete late open or dispatch versionchange | Late connection is closed, disposed store stays closed, and a versionchange closes the active connection. |

### 16.6 Viewer channel tests

File `src/client/src/browserNotifications/viewerQueryChannel.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `viewer_query_message_and_origin_channel_are_exact` | Root and nested mounts with the same origin, third mount on another origin | Create channels and query | Same-origin names both equal the exact origin-scoped name. Different origin differs. Query has exactly kind/queryId/structured identity. |
| `viewer_reply_window_is_two_hundred_fifty_milliseconds` | No responding viewer and fake clock | Advance 249 ms then 1 ms | Promise pending at 249, settles `not-viewing` at 250, pending entry/timer removed. |
| `positive_viewer_reply_settles_only_matching_query` | Two pending IDs | Send false, malformed, wrong-ID, positive matching, then late reply | Only timely matching `viewing: true` settles viewing. Other query stays pending until its own deadline. |
| `viewer_replies_use_current_state_after_blur` | Predicate initially true, then false without a publication | Deliver query after blur | Zero positive replies. A later fresh true predicate replies with exact shape. |
| `closing_channel_never_replies` | Current predicate true | Set closing and deliver query | Zero replies. Clear closing and deliver another query, exactly one positive reply. |
| `responder_survives_its_own_suppression` | Channel with a true current viewer | Finish a local candidate, then deliver foreign queries | Replies remain available independently of candidate lifetime. |
| `disabled_or_cancelled_queries_cannot_suppress` | Current disabled callback and abortable query | Deliver query, then abort pending request | Zero positive replies, pending result `cancelled`, timer removed. |
| `broadcast_channel_failure_preserves_claim_path` | Missing factory and throwing constructor/postMessage | Query | Availability unavailable and result `not-viewing`, with no exception. |
| `preference_broadcast_is_invalidation_only` | Stored preference false, incoming enabled true message | Deliver message | Callback triggers a fresh read and never installs the message boolean as preference authority. |
| `malformed_channel_messages_are_ignored` | Unknown kinds, extra keys, noncanonical identities, invalid orders/query IDs | Deliver each | Zero replies and zero pending-query settlement from invalid messages. |

### 16.7 Controller tests

File `src/client/src/browserNotifications/controller.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `permission_is_requested_only_on_explicit_enable` | Permission default and disabled storage | Connect, refresh, deliver socket event, send test, then call enable from a simulated gesture | Zero permission calls before enable, exactly one at enable before awaiting coordination, enabled persisted only after granted. |
| `denied_default_unsupported_and_insecure_states_are_silent` | Each permission/support/context restriction | Enable and deliver completion | Exact availability state, effective preference false for failed enable, zero notification construction. Missing API/insecure state requests permission zero times. |
| `permission_result_cannot_reenable_after_disable` | Deferred permission response | Enable, disable, resolve granted | Preference remains false, enabling false, zero revived candidates. |
| `snapshot_reload_reconnect_and_already_idle_are_silent` | Snapshot containing unread completions and no live socket delivery | Connect, accept snapshot, renegotiate, reload fixture | Zero candidates admitted, zero claim calls, zero notifications. |
| `live_completion_is_captured_before_projection_application` | Valid socket completion and ordered spies | Invoke receipt followed by unread application | Candidate captures machine and whitelisted fields before projection mutation. A later null clear does not erase that candidate. |
| `completion_during_capability_renegotiation_is_admitted` | Matching retained A epoch, capability transitions supported → unknown | Deliver A completion before negotiation settles | One candidate and one winning claim, exactly one notification. Unknown creates no wait for a new snapshot. |
| `capability_unsupported_discards_queued_candidates` | Unmatched queued completion during unknown | Resolve unsupported, deliver another event, later accept snapshot | Queue cleared, epoch cleared, no new candidate for unsupported receipt, zero claims and notifications. |
| `queued_completion_alerts_when_initial_epoch_lands` | Enabled unknown machine without epoch | Deliver completion, accept matching snapshot within 30 s | No claim before snapshot, one claim and notification after acceptance. |
| `expired_candidate_and_removed_machine_are_discarded` | Queued candidate and in-flight viewer query | Expire first at 30 s, remove machine for second | No claims/construction after either cancellation, with no later snapshot resurrection. |
| `queue_overflow_evicts_oldest_and_alerts_newest` | Thirty-three unique candidates without epoch | Deliver all, install matching epoch | Zero claims for oldest, exactly 32 successful claims/notifications for candidates 2–33, including newest. |
| `gapped_live_event_uses_snapshot_epoch_independently_of_projection` | Epoch A retained, projection missing/loading/stale or revision gap | Deliver matching A completion | One eligible claim and notification despite the projection gap. Projection still performs its ordinary refresh. |
| `superseded_epoch_event_stays_silent` | Epoch B accepted, delayed event for A | Deliver A and advance its queue beyond 30 s | Zero claim writes and notifications, epoch remains B. |
| `epoch_is_rechecked_after_async_delay` | A candidate waiting on viewer reply with epoch A | Accept B before reply window completes | Zero claim writes/constructions. Socket projection changes alone cannot move epoch back to A. |
| `null_and_removal_events_are_silent` | Valid unread null events | Receive them | No completion queue entry, claim, or notification. |
| `candidate_older_than_horizon_is_rejected` | Matching epoch and timestamp T0 - H - 1 | Receive event at T0 | Candidate fails validation before any viewer query or tryClaim call. Zero records and notifications. |
| `daemon_clock_boundaries_are_exact` | Completed times T0 - H, T0 - H - 1, T0 + S, T0 + S + 1, with wall clock fixed at T0 and viewer channel unavailable | Deliver distinct identities without a viewer wait | Exactly the H and S boundary identities construct. Their one-ms-outside peers create zero records. |
| `local_viewer_suppression_is_durable` | Current local viewer true | Deliver completion and replay it after leaving chat | First claim disposition suppressed, zero broadcasts, replay remains silent. |
| `remote_viewer_suppression_survives_viewer_closure` | Background handler, remote positive viewer | Deliver, persist suppression, close viewer, replay from third tab | Raw claim disposition suppressed before abandonment, replay existing, zero notifications across tabs. |
| `suppression_write_failure_never_falls_through_to_display` | Positive viewer and failing suppression transaction | Deliver | Zero notifications and coordination unavailable. |
| `hidden_unfocused_and_other_session_windows_do_not_suppress` | Each visibility/focus/identity mismatch | Deliver current completion | No positive local reply and exactly one eligible notification per distinct identity. |
| `closing_and_bfcache_viewer_lifecycle_is_current` | Focused visible viewer with page event source | pagehide/query, persisted pageshow/query, beforeunload/query | Reply counts zero, one, zero in those stages. Restored viewer uses fresh preference. |
| `two_background_tabs_construct_once` | Two controllers, same live completion, no viewer | Race both handlers and commit claims | Exactly one notification construction total and one raw claim. |
| `missing_channel_keeps_cross_tab_duplicate_prevention` | Two controllers, shared claims, unavailable BroadcastChannel, no local viewer | Deliver the same completion to both | Exactly one notification and one raw claim. Both snapshots report viewer suppression unavailable. |
| `independent_sessions_alert_when_claims_commit_in_reverse_order` | Two controllers with sessions A order 20 and B order 10, B waiting before claim execution | Commit A, then release B | Exactly two notifications and two distinct displayed records. No order watermark rejects B. |
| `later_completion_of_same_session_alerts_again` | One session, same catalog/workspace, completion orders 1 and 2 | Deliver each completion and replay both | Exactly two constructions with distinct claim keys and tags. Replays create zero additional notifications. |
| `metadata_lookup_failure_uses_fallbacks` | Throwing name resolver | Deliver a valid live completion | Exactly one fallback notification with approved wording, one displayed claim, and no lookup failure escaping the controller. |
| `tab_closure_after_claim_does_not_release_identity` | Controller wins a claim, constructs once, then closes | Replay in another controller | Exactly one construction total and the original durable record prevents another attempt. |
| `disable_during_viewer_query_abandons_without_claim` | Pending query | Disable then re-enable before settling old query | Zero claim writes/constructions from old generation, queue empty. |
| `disable_before_claim_commit_retains_blocked_record` | Deferred transaction completion after valid write | Disable before transaction commit, finish commit, re-enable and redeliver | Zero notifications, retained blocked record with original claimedAt, replay remains silent. |
| `preference_updates_across_tabs_without_channel` | Shared storage, two controllers, unavailable channel | Enable in one, dispatch storage event in other, then disable while other's query is pending | Fresh reads converge, disable cancels pending work, zero late alerts. |
| `preference_resume_and_visibility_refresh_are_fresh` | Storage changed without receiving a broadcast | Dispatch visibilitychange and ordinary/persisted pageshow | Each event reads current preference and permission. Disabled state clears queued work. |
| `fresh_gate_read_blocks_even_before_storage_event` | Candidate in progress, shared key becomes false | Resume at each of four gates without dispatching storage event | Admission/validation/preclaim create no record. Post-commit creates no notification and retains blocked record. |
| `coordination_failures_are_separate_from_permission` | Permission granted, IDB open/write/quota failure | Deliver completion | Permission remains granted, coordination unavailable with exact cause, zero notifications. |
| `notification_errors_are_contained_and_recorded` | Constructor throws, then separate fixture emits onerror | Deliver and replay each | Realtime caller returns normally, local operation error set, retained blocked claim, no replay construction. |
| `test_notification_is_explicit_and_content_limited` | Eligible settings state | Send test and click it | Exact test payload, one focus and close, zero permission/candidate/claim/navigation calls. Blocked states construct zero. |
| `inbox_and_transcript_content_never_enters_browser_alerts` | notifications.inbox/summary fixtures with extension text/severity, prompt/message.append, assistant.delta, tool.end, command.output, extension entries, followed by valid unread with forbidden extra fields | Feed every fixture through receiveSocketEvent | Unrelated events create zero candidates/claims. Valid unread creates only whitelisted candidate fields, and exact title/body contain session/project names and idle wording with none of the forbidden fixture markers. |
| `dispose_cancels_pending_work_and_removes_listeners` | Queued entry, pending query, completing claim, open channel and handles | Dispose twice and settle pending work | Listeners/timers removed once, channel/store closed, no new construction, any winning late commit retained blocked. |

The following three suspension tests also belong to `controller.test.ts` and are mandatory under their exact names.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `suspension_between_validation_and_transaction` | Candidate completed at T0, validation succeeds at T0, absent claim key, transaction execution held | Advance clock to T0 + H + 1 after validation and before the transaction's write callback, then release it | Zero notifications and raw key absent. Verify transaction-time check rejected before `add`. |
| `suspension_between_commit_and_construction` | Candidate completed at T0, winning record committed at T0, promise continuation held | Advance to T0 + H + 1 after commit and before construction, then release continuation | Zero notifications, same raw key retained, disposition blocked, claimedAt still T0. |
| `suspension_across_pruning_and_resume` | Existing claim at T0, duplicate candidate validates at T0, claim transaction delayed before execution | Advance to T0 + R + 1, explicitly prune from another connection, assert old key absent, then resume delayed transaction | Zero notifications and raw key remains absent with zero newly added records. Transaction-time horizon rejection is observed even though preconstruction would also reject. |

For the suspension fixtures, keep preference enabled, epoch matching, machine retained, and permission granted. The candidate has left the epoch queue, so queue expiry cannot mask the horizon check. The controller's claim fake must invoke the real time rule at transaction execution, or the integration fixture must run the real store over its controlled IndexedDB factory.

Prove check independence with disposable local mutations during implementation verification. Removing validation-time checking fails `candidate_older_than_horizon_is_rejected` on query/claim entry. Removing transaction-time checking fails both transaction suspension tests on raw record presence. Removing preconstruction checking fails `suspension_between_commit_and_construction` on constructor count. Removing the `blocked` rewrite fails that test on disposition. Restore each mutation and rerun the relevant green control.

### 16.8 Payload and resolver tests

File `src/client/src/browserNotifications/payload.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `payload_contains_only_names_and_idle_wording` | Named session/project with unrelated transcript and severity fixture markers | Format | Exact approved title/body, exact completion tag, renotify false, and exactly the four payload fields. |
| `name_fallbacks_never_use_first_message` | Missing/blank names, short and long IDs, Unix/Windows workspace paths and roots | Format each | Session uses exact eight-code-point fallback, project uses specified basename or Project, and no firstMessage text appears. |

File `src/client/src/browserNotifications/alertTarget.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `resolve_selected_machine_target` | Prepared selected machine and exact workspace/session | Resolve | Exact success union with four identifiers, session verified by both ID and cwd. |
| `resolve_nonselected_machine_loads_catalogs_in_order` | Target machine differs, projects A/B/C, A uncatalogued and B contains path | Resolve | Machine preparation completes first, A loaded once before considering B, session load uses target machine/path, exact target returned. |
| `resolver_load_pass_is_bounded_and_exact` | Multiple uncatalogued projects, similarly named or prefix paths | Resolve | Each project loaded at most once, exact path match only, catalog order determines the first valid match. |
| `resolve_machine_unavailable` | Unknown machine, offline runtime, or rejected preparation | Resolve each | `{ ok: false, reason: "machine-unavailable" }`, zero workspace/session loads after failure. |
| `resolve_workspace_missing` | No exact path or every needed list fails | Resolve | `{ ok: false, reason: "workspace-missing" }` after bounded pass. |
| `resolve_session_missing` | Missing ID, same ID at different cwd, or list failure | Resolve each | `{ ok: false, reason: "session-missing" }`. |

### 16.9 App and Settings boundary tests

File `src/client/src/components/PiWebUiApp.browserNotifications.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `app_forwards_selected_and_other_machine_socket_receipts` | Injected controller and selected/nonselected unread events | Invoke both existing socket handlers | Correct machine/event forwarded exactly once before unread applyEvent, with no inbox forwarding. |
| `app_forwards_snapshots_capabilities_and_retained_machines` | Real unread controller with deferred snapshot and injected alert controller | Reopen/renegotiate, accept snapshot, downgrade/remove, disconnect | Exact unknown/supported/unsupported and retained-ID transitions, accepted HTTP callback only, unsubscribe/dispose on disconnect. |
| `viewer_uses_committed_ready_and_unobscured_chat` | Selected identity with committed/ready independently absent, then present | Invoke supplied predicate | False until both committed and ready identities match. Settings/modal/tool-cover cases false. Visible chat true with current focus. |
| `same_id_on_another_machine_or_workspace_is_not_viewing` | Same ID, differing machine/path | Query supplied predicate | Only the exact three-part identity can return true. |
| `responsive_viewer_predicate_preserves_app_contract` | Injected desktop/mobile layout flags | Evaluate chat, navigation, and workspace-tool states | Chat true, mobile navigation false, wider navigation true, covered tool false, actual side-by-side tool/chat true. Native layout is verified separately below. |
| `click_activation_dismisses_settings_and_tool_and_writes_chat_route` | Settings open, workspace tool selected, resolvable machine/project/workspace/session | Activate alert | Focus/close occur, settings parameter removed, every active obscuring overlay dismissed, chat selected, ordered machine/project/workspace selection, exact resolved route written once after final verification. |
| `click_activation_reports_each_unavailable_target` | One fixture per failure reason | Activate | Exact corresponding notice, notification closed, zero target-route writes. |
| `click_activation_verifies_selection_before_route_write` | Session disappears during selection or selection chooses a fallback | Complete awaited selection | Failure notice, zero target-route writes, notification closed. |
| `empty_machine_default_project_cannot_write_partial_alert_route` | Target machine has an empty project catalog and the existing load path selects its default project, but alert workspace is absent | Activate and finish catalog loading | Workspace unavailable notice and zero target-route writes, including nested default-selection updateUrl calls. |
| `click_activation_supersession_cannot_write_stale_route` | Deferred first activation, newer user selection or second activation | Settle first last | First performs zero stale route writes and cannot overwrite newer selected state. |
| `click_route_preserves_nested_mount_and_encoding` | URL under `/nested/pi-webui/`, dynamic IDs containing spaces, slash, question mark, Unicode, and hash | Activate success | Pathname remains nested mount, readRoute returns exact IDs, settings removed, view chat, no origin-root API reference. |
| `settings_receives_origin_scoped_controller_state` | Local then remote selected machine, settings notifications | Render/dialog action | Same controller snapshot/actions forwarded for either selection. Opening/closing Settings does not reset preference or controller. |

File `src/client/src/settingsRoute.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `notifications_settings_route_round_trips` | Nested URL with existing project/session/hash | Parse, read, write notifications, close with replace | notifications round-trips, other fields and mount retained, only settings parameter removed on close. Existing aliases still pass. |

File `src/client/src/components/SettingsDialog.notifications.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `notifications_is_a_standalone_settings_panel` | Dialog in notifications section | Inspect public mapping and render with DOM | activeSettingsPanelTag gives settings-notifications-panel, Notifications nav entry detail This browser, exactly that panel mounted. |
| `notifications_panel_forwards_app_state_and_actions` | Snapshot and callback spies | Change enable and click test through mounted panel | Exact supplied snapshot and callback arguments propagate once, with zero permission calls from mounting. |

File `src/client/src/components/settings/SettingsNotificationsPanel.test.ts`.

| Test name | Fixture | Action | Exact assertion |
| --- | --- | --- | --- |
| `panel_contains_exact_separation_and_delivery_copy` | Supplied normal snapshot | Mount and read shadow DOM | Exact separation sentence, scope, conditions, payload wording, and delivery-limit copy present. |
| `panel_renders_all_availability_states` | Every state in section 13.3, including granted plus coordination failure | Mount/update | Required messages and switch/test disabled states match the table. Permission and storage errors both remain visible. |
| `panel_enable_action_keeps_user_activation_timing` | Default permission and callback spy | Dispatch real switch change | Callback invoked synchronously before event handler returns, no automatic enable on mount. |
| `panel_test_action_reports_constructed_blocked_and_failed` | Eligible, blocked, and failed controller outcomes | Click test or update feedback | Exact labels/statuses, pending disables duplicate test, zero callback for disabled button. |
| `panel_disable_is_available_for_previously_enabled_unavailable_state` | Enabled snapshot whose environment loses support/coordination | Turn off | Disable action runs and test stays disabled. |

Run existing `PiWebUiApp.unread.test.ts`, `sessionNotifications.test.ts`, `controllers/sessionNotificationController.test.ts`, `controllers/sessionController.notifications.test.ts`, `sessionSocket.test.ts`, `route.test.ts`, and existing Settings tests as regression coverage. Existing inbox tests retain their independent `notifications.*` and content assertions. The negative browser isolation test complements those observers.

### 16.10 Real-browser acceptance

Use Chromium on a secure origin with an OS desktop notification surface for construction/click checks. Use two independent pages in the same browser context/profile for tab races and an additional context for origin/profile isolation. Exercise existing live unread delivery through normal session work or controlled existing socket fixtures. Never turn a snapshot into a candidate to manufacture acceptance.

| Scenario | Fixture and action | Exact observation |
| --- | --- | --- |
| Permission gating | Fresh origin with permission default, open Settings and receive completions, then explicitly enable | Zero permission prompts before enable. One browser permission flow from enable. Denial keeps switch off. Grant permits subsequent live completion. |
| Focused viewer plus background receiver | Two tabs receive same completion, one focused/visible with exact ready chat and one backgrounded | Zero desktop alert constructions across both, one retained terminal suppressed claim. |
| Two background receivers | Both tabs receive same live completion with no focused matching viewer | Exactly one native notification construction across both and one claim record. |
| Tool covers focused chat | Focused session tab selects a full-width workspace tool at a viewport below side-by-side threshold, second tab backgrounded | Exactly one notification. Measured chat visibility/predicate confirms the tool actually covers chat. |
| Side-by-side chat remains visible | Focused session at actual desktop side-by-side width with a tool alongside it | Zero notifications and suppressed claim. Inspect rendered visibility together with the active-chat predicate. |
| Viewer blurs just before completion | Matching focused viewer loses focus before another tab handles the completion | Exactly one notification, regardless of delayed focus-state publication. |
| Viewer closes just before completion | Matching focused viewer closes, other tab receives completion | Exactly one notification, with zero positive reply from closing page. |
| Superseded catalog | Install epoch B through accepted HTTP snapshot, deliver deferred A completion | Zero notifications and no A claim after queue expiry. |
| Durable viewer replay | Suppress via remote viewer, close that viewer, replay to another tab | Zero notifications and retained suppressed record. |
| Click activation | Native alert while Settings and a tool cover chat, target on another machine/project/workspace | Click focuses owning window, closes alert, dismisses overlays, selects exact target chat, and writes complete encoded route after verification. |
| Missing click target | Remove machine/workspace/session before clicking in separate fixtures | Exact unavailable notice, closed notification, zero partial target-route writes. |
| Back-forward cache | Navigate viewer away and restore with persisted pageshow, then query | Closing page sends zero positive replies. Restored page answers from fresh focus/visibility/preference. |
| Origin sharing across mounts | Two mounts at `/` and `/nested/pi-webui/` under one origin receive the same identity | Shared preference/DB/channel and exactly one claim. Click retains the owning mount. |
| Different origin/profile | Same identity in isolated origin or browser context | Preference and claims are isolated to their profile/origin. |
| Nested deployment | Run under canonical `/nested/pi-webui/`, activate target with special-character identifiers | All API/socket references resolve within the mount once, route values round-trip, no leading-root owned path leaks. |

Record viewport, actual focus/visibility, received completion identity, notification construction count, raw claim disposition, and final route for each scenario. For native delivery and clicks, observe the Notification surface and operating-system interaction. A mock constructor or jsdom layout assertion cannot replace those scenarios.

## 17. Ordered implementation checklist

Each step is suitable for a planner task. Advance after its focused tests and applicable typecheck/lint pass. Cross-cutting verification and browser acceptance complete the final step.

| Order | Files touched | Work | Required passing checks before proceeding |
| --- | --- | --- | --- |
| 1 | `src/client/src/browserNotifications/preferences.ts`, `preferences.test.ts`, `completionCandidates.ts`, `completionCandidates.test.ts` | Establish constants, exact types, preference format, pure identities/time rules, capability/epoch/queue behavior. | Sections 16.2 and 16.3, typecheck, focused ESLint. |
| 2 | `src/client/src/sessionUnread.ts`, `sessionUnread.test.ts` | Add accepted-snapshot listener without altering projection authority. | Section 16.4 and the full existing sessionUnread tests. |
| 3 | `src/client/src/browserNotifications/claimStore.ts`, `claimStore.test.ts` | Implement serialized claims, prewrite horizon check, blocked rewriting, age-only retention, and storage failures. | Section 16.5, direct retention boundary inspection, race/abort controls. |
| 4 | `src/client/src/browserNotifications/viewerQueryChannel.ts`, `viewerQueryChannel.test.ts` | Implement origin channel, strict messages, current-view replies, 250 ms wait, cancellation, and optional broadcasts. | Section 16.6, including exact timeout and malformed-message boundaries. |
| 5 | `src/client/src/browserNotifications/payload.ts`, `payload.test.ts`, `controller.ts`, `controller.test.ts` | Compose four preference gates, three horizon checks, permission enable action, claims, suppression, notifications, test action, and disposal. | Sections 16.7 and payload tests, all three suspension tests, negative inbox-isolation test, and check-independence mutation controls. |
| 6 | `src/client/src/browserNotifications/alertTarget.ts`, `alertTarget.test.ts` | Implement bounded machine/workspace/session resolution through existing catalog APIs. | Resolver tests in section 16.8, all failure unions and order/load bounds. |
| 7 | `src/client/src/components/PiWebUiApp.ts`, `PiWebUiApp.browserNotifications.test.ts`, `PiWebUiApp.unread.test.ts` where fixture extension is needed | Compose browser adapters, wire socket/snapshot/capability lifecycle, share active-chat predicate, and implement verified click activation. | App boundary tests in section 16.9 plus existing unread, cross-workspace navigation, route, socket, and inbox tests. |
| 8 | `src/client/src/settingsRoute.ts`, `settingsRoute.test.ts`, `src/client/src/components/SettingsDialog.ts`, `SettingsDialog.notifications.test.ts`, `settings/SettingsNotificationsPanel.ts`, `settings/SettingsNotificationsPanel.test.ts` | Add route/nav/panel and all browser-level status/control wiring. | Remaining section 16.9 tests, existing Settings tests, typecheck, lint. |
| 9 | `docs/faq.html`, `.changeset/idle-session-browser-notifications.md` | Add canonical FAQ guidance and minor feature fragment. Review doc links/copy and release summary. | FAQ anchor/link inspection, fragment metadata inspection, `git diff --check`, and zero README diff. |
| 10 | Files from steps 1–9 only, as required for acceptance repairs | Run broad integration and Chromium scenarios, repair any failed acceptance behavior within this contract. | `npm run verify`, every section 16.10 scenario, exact raw-record and route evidence, and final scope review. |

## 18. Open questions

None.
