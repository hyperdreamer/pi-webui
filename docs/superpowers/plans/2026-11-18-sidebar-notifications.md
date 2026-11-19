# Selected-session notifications in the Activity Rail

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven development controller to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the selected session's notification inbox from chat into one accessible Activity Rail bell, desktop flyout, and compact modal sheet while preserving daemon ownership and current notification behavior.

**Architecture:** Keep `SessionNotificationController` as the sole owner of the selected inbox, request coverage, mutation overlays, and live-delivery cursor. Add a pure availability projection, then have `PiWebUiApp` own surface state, focus intent, and compact-sheet isolation while `ActivityRail` and a focused tray component render the projection. Keep the daemon, wire protocol, API routes, retention limits, and legacy behavior unchanged.

**Tech Stack:** TypeScript, Lit, Vitest, existing session and machine controllers, existing API parsers, existing Activity Rail breakpoint, deterministic Chromium/CDP verification, Changesets.

## Global Constraints

- Read `docs/superpowers/specs/2026-11-18-sidebar-notifications-design.md` at `12090ebd76e8862133b0d648ee63ced686e25852` (SHA-256 `94fa9dbf037ce2a9d2feaac1b3ca963632ff0920255f54f6df62270677a7ed3b`) and `docs/superpowers/specs/2026-11-18-sidebar-notifications-spec.md` at `cd7455a49d7a0b711a748293e30ad7db143e75f8` (SHA-256 `e051e830e37bfcb269ad3b3c1bbb82a1fa1b730a0bcaf4eefb4d1132ee33c645`). The spec's named fixtures and assertions apply in full.
- Use one Core client lane, Tasks 1 → 2 → 3 → 4. The projection, controller publications, rendering and browser assertions depend on one another. Task 5 owns disjoint Documentation files and can proceed from the approved spec. The unchanged SDD controller may also execute all five in source order.
- Verification ownership: Tasks 1–3 cover V3–V5 (eligibility, recovery and supersession), Tasks 2–3 cover V6–V8 and V11–V12 (mutations, lifetime and delivery), and Task 3 covers V1–V2 and V9–V10 (placement, content, interaction and focus). Task 4 owns B1–B4 and the V13 integration commands. Task 5 owns V13 guidance and Changeset. Record actual `npm run verify`, `npm run verify:narrow-navigation-header`, and `npm run verify:sidebar-notifications` results at integration handoff.
- The approved scope is browser presentation and selected-session projection. Keep session-daemon ownership, in-memory lifetime, wire format, APIs, limits, legacy compatibility, and unrelated Activity Rail controls intact. Do not add server, daemon, storage, plugin, or durable notification-history behavior.
- Use `.agents/skills/code-quality-architecture/SKILL.md`, `.agents/skills/testing-guide/SKILL.md`, `.agents/skills/documentation-guide/SKILL.md`, and `.agents/skills/changeset-changelog/SKILL.md` for the corresponding production, test, and documentation work.
- Use Node 22.19 or newer and add no runtime dependencies. Keep browser verification explicit and outside `npm run verify`.
- Keep the fixed notification bell outside `REORDERABLE_IDS` and plugin ordering. Reuse `ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY` and the existing health, runtime, session, and inbox APIs.
- The controller schedules inbox reads on selection, subscription, recovery, or resync. Rendering, opening, closing, and resizing issue zero notification requests. Only explicit dismissal actions initiate mutations.
- Preserve the approved availability distinctions, precedence, target identity `{ machineId, sessionId, cwd }`, selection generations, socket-incarnation coverage, daemon replacement ordering, action overlays, and announcement delivery rules stated in this plan.
- Never execute host power/session-host actions, including reboot, shutdown, poweroff, halt, kexec, system power or sleep verbs, display-manager or graphical-target changes, session termination, or signalling the PM process tree. If a host transition is required, write `reboot-required.json` at the worktree root with `{schema, trigger, evidence, provenance}` and stop.
- Each implementation task commits only the files it owns. Do not edit the approved design or specification to make implementation fit.

## Task 1: Derive notification availability and presentation

**Implementer tier:** Advanced

This task is in the Core client lane and implementation category. It has no task dependency. Its output is the pure projection contract used by controller recovery and app rendering.

**Files:**

- Create: `src/client/src/notificationPresentation.ts`
- Test: `src/client/src/notificationPresentation.test.ts`

**Interfaces:**

- Consumes: `Machine`, `MachineHealth`, `MachineRuntime`, `SessionInfo`, `SelectedSessionNotificationInbox`, `SelectedSessionNotificationView`, `SessionNotificationTarget`, `selectedNotificationView`, `notificationTargetsEqual`, `MachineStatus`, and `PI_WEBUI_CAPABILITIES.sessionsNotifications` from existing modules.
- Produces: `deriveNotificationPresentation(input: NotificationPresentationInputs): NotificationPresentation` and the following exported types. Keep these signatures stable for Tasks 2 and 3.

```ts
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
```

- [ ] **Step 1: Write failing presentation tests**

```ts
import { describe, expect, it } from "vitest";
import { deriveNotificationPresentation, type NotificationPresentationInputs } from "./notificationPresentation";
import { installSelectedNotificationSnapshot, type SessionNotificationTarget } from "./sessionNotifications";
import { PI_WEBUI_CAPABILITIES, type Machine, type MachineHealth, type SessionInfo } from "../../shared/apiTypes";

const time = "2026-11-18T00:00:00.000Z";
const localMachine: Machine = { id: "local", name: "Local", kind: "local", createdAt: time, updatedAt: time };
const remoteMachine: Machine = { ...localMachine, id: "remote", name: "Remote", kind: "remote" };
const session: SessionInfo = { id: "s", cwd: "/a", path: "/a/s.jsonl", created: time, modified: time, messageCount: 0, firstMessage: "" };
const targetA: SessionNotificationTarget = { machineId: "local", sessionId: "s", cwd: "/a" };
const targetB: SessionNotificationTarget = { machineId: "remote", sessionId: "s", cwd: "/b" };
const onlineHealth: MachineHealth = { machineId: "remote", ok: true, status: "online", checkedAt: time };
const freshInbox = installSelectedNotificationSnapshot(undefined, targetA, {
  daemonInstanceId: "d1", catalogRevision: 1,
  summary: { sessionId: "s", cwd: "/a", inboxRevision: 1, retainedCount: 0, discardedCount: 0 },
  notifications: [], dismissThrough: { order: 0, overflowWatermark: 0 },
});
const staleInbox = { ...freshInbox, status: "stale" as const };
function inputs(patch: Partial<NotificationPresentationInputs>): NotificationPresentationInputs {
  return {
    selectedSession: session, selectedMachine: localMachine, machineHealth: undefined,
    machineRuntime: { machineId: "local", ok: true, checkedAt: time, capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications] },
    acceptedSupport: undefined, runtimeGeneration: 4, selectionGeneration: 7, inbox: undefined,
    operation: undefined, isClientPendingStart: false, ...patch,
  };
}

describe("deriveNotificationPresentation", () => {
  it("rejects archived, incomplete, and client-pending selections", () => {
    expect(deriveNotificationPresentation(inputs({ selectedSession: undefined }))).toEqual({ kind: "ineligible" });
    expect(deriveNotificationPresentation(inputs({ isClientPendingStart: true }))).toEqual({ kind: "ineligible" });
  });

  it("shows explicit remote offline before inbox or capability state", () => {
    expect(deriveNotificationPresentation(inputs({
      selectedMachine: remoteMachine, selectedSession: { ...session, cwd: "/b" },
      machineHealth: { ...onlineHealth, ok: false, status: "offline" },
      machineRuntime: undefined,
      inbox: freshInbox,
    }))).toMatchObject({ kind: "offline", target: targetB });
  });

  it("accepts support only for the current runtime generation", () => {
    expect(deriveNotificationPresentation(inputs({
      acceptedSupport: { runtimeGeneration: 4, daemonInstanceId: "d1" },
      runtimeGeneration: 4, machineRuntime: undefined,
      inbox: freshInbox,
    })).kind).toBe("fresh");
    expect(deriveNotificationPresentation(inputs({
      acceptedSupport: { runtimeGeneration: 3, daemonInstanceId: "d1" },
      runtimeGeneration: 4,
      machineRuntime: undefined,
    })).kind).toBe("capability-unavailable");
  });

  it("shows only a current admitted operation and never revives stale rows", () => {
    expect(deriveNotificationPresentation(inputs({
      operation: { target: targetA, selectionGeneration: 7, kind: "loading-inbox" },
      selectionGeneration: 7,
    })).kind).toBe("loading");
    expect(deriveNotificationPresentation(inputs({
      operation: { target: targetA, selectionGeneration: 6, kind: "loading-inbox" },
      selectionGeneration: 7,
      inbox: staleInbox,
    })).kind).toBe("unavailable");
  });
});
```

Use valid existing notification fixture builders and add cases for missing machine/session ID/cwd, archived sessions, local reachability, remote `unknown`, `offline`, and `error`, successful supported runtime, successful unsupported runtime, failed or absent runtime negotiation, matching and mismatching daemon evidence, matching fresh inbox, stale/missing inbox, and every operation kind. Assert full target equality includes machine, cwd, and session ID. Assert a still-current fresh view stays `fresh` while a background operation runs.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- --run src/client/src/notificationPresentation.test.ts`
Expected: FAIL because the presentation module and exported types do not exist.

- [ ] **Step 3: Implement the pure projection**

Implement only the exported types and `deriveNotificationPresentation`. Derive eligibility from the active selected session, selected machine, nonempty session ID and cwd, archive state, and the explicit `isClientPendingStart` input. Task 3 supplies that flag from the existing `isClientPendingStartSessionInfo` predicate. Apply this precedence:

1. Ineligible selection returns `ineligible`.
2. An explicitly unreachable remote returns `offline`, preserving a current `checking-health` operation indicator. Reuse the existing reachability rule so remote `unknown` remains eligible and local remains reachable.
3. Current-generation accepted support or a successful runtime capability establishes `supported`. A successful runtime without the capability establishes `unsupported` when no matching accepted evidence applies. Missing or failed negotiation without current accepted evidence yields `capability-unavailable`.
4. A matching fresh inbox yields `fresh`, even while a current request is pending.
5. Without a fresh inbox, show `loading` only for a current matching `loading-inbox` operation. Show a current health or capability check in its corresponding state. Stale, missing, or nominally loading data without a current admitted operation yields `unavailable`.

Discard every operation whose target or selection generation does not exactly match. Use `selectedNotificationView` only for a fresh matching inbox. Never expose counts or rows from offline, unsupported, stale, or mismatched state. Keep the helper pure and free of transport and DOM access.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `npm test -- --run src/client/src/notificationPresentation.test.ts`
Expected: PASS for all precedence and identity cases.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/notificationPresentation.ts src/client/src/notificationPresentation.test.ts
git commit -m "feat(notifications): derive selected inbox availability"
```

## Task 2: Make inbox recovery and mutations generation-safe

**Implementer tier:** Capable

This task is in the Core client lane and implementation category. It depends on Task 1 for `AcceptedNotificationSupport`. It owns selected-inbox requests, runtime support evidence, socket coverage, daemon ordering, mutations, and announcement delivery. Tasks 3 and 4 consume this task's public behavior.

**Files:**

- Modify: `src/client/src/controllers/sessionNotificationController.ts:1-357`
- Modify: `src/client/src/controllers/sessionController.ts:43-2629`
- Modify: `src/client/src/controllers/machineController.ts:1-221`
- Modify: `src/client/src/sessionSocket.ts:11-94`
- Modify: `src/client/src/controllers/sessionController.testSupport.ts:40-96` (the existing `EmitSocket` test adapter)
- Modify: `src/client/src/sessionNotifications.ts:1-299`
- Test: `src/client/src/controllers/sessionNotificationController.test.ts:1-352`
- Test: `src/client/src/controllers/sessionController.notifications.test.ts:1-145`
- Regression (run as written): `src/client/src/controllers/sessionController.extensionEntries.test.ts`
- Test: `src/client/src/controllers/machineController.test.ts`
- Test: `src/client/src/sessionSocket.test.ts`
- Test: `src/client/src/sessionNotifications.test.ts`

**Interfaces:**

- Consumes: `AcceptedNotificationSupport = { runtimeGeneration: number; daemonInstanceId?: string }` and `NotificationOperationRecord = { target: SessionNotificationTarget; selectionGeneration: number; kind: "checking-health" | "checking-capability" | "loading-inbox" }` from Task 1. Use the existing `SessionNotificationApi` methods `notificationInbox(session: SessionLookup, machineId?: string)`, `dismissNotification(session: SessionLookup, daemonInstanceId: string, notificationId: string, machineId?: string)` and `dismissAllNotifications(session: SessionLookup, daemonInstanceId: string, through: SessionNotificationDismissThrough, machineId?: string)`. All return `Promise<SessionNotificationInboxSnapshot>`. Always pass the `{ id, cwd }` form of `SessionLookup` and the captured machine ID.
- Produces: the following controller accessors and recovery entry points for Tasks 3 and 4. Preserve the existing API client signatures and server routes.

```ts
// SessionNotificationController
get selectionGeneration(): number
get inboxOperation(): NotificationOperationRecord | undefined
get failureMessage(): string | undefined
runtimeGenerationFor(machineId: string): number
acceptedSupportFor(machineId: string): AcceptedNotificationSupport | undefined
refreshSelectedSession(session: SessionRef, machineId: string): Promise<void>
observeSocketIncarnation(session: SessionRef, machineId: string, socketIncarnation: number): void
ensurePostSubscriptionRefresh(session: SessionRef, machineId: string, socketIncarnation: number): Promise<void>
applyInboxEvent(machineId: string, event: SessionNotificationInboxEvent, socketIncarnation?: number): void
dismissNotification(notificationId: string): Promise<void>
dismissAll(): Promise<void>

export interface MachineRefreshOwnership {
  isCurrent(): boolean;
  onError?(error: unknown): void;
}

refreshMachineHealth(machineId?: string, ownership?: MachineRefreshOwnership): Promise<MachineHealth | undefined>
refreshMachineRuntime(machineId?: string, ownership?: MachineRefreshOwnership): Promise<MachineRuntime | undefined>

export function isClientPendingStartSessionInfo(session: SessionInfo | undefined): session is ClientPendingStartSessionInfo;
```

Extend `SessionNotificationControllerDependencies` with `onProjectionChange?(): void` and `isCheckingEnvironment?(target: SessionNotificationTarget, selectionGeneration: number): boolean`. Notify on read admission, settlement, generation/support or current failure changes even when inbox rows are identical. The latter predicate lets the app finish an explicit health/runtime retry before environment synchronization admits its inbox read. Default it to false for existing callers. `inboxOperation` is present only during an admitted inbox request. `failureMessage` is scoped to the current selection and cleared on rebind. `SelectedSessionNotificationInbox.announcements` exposes stable `{ id: string; severity: SessionNotificationSeverity }` records independently of `selectedNotificationView()`.

Add `observeSocketIncarnation` and `ensurePostSubscriptionRefresh` to `SessionNotificationSessionBridge` with the signatures above. Use `(event: SessionUiEvent, socketIncarnation: number) => void` in `SessionSocket.connect`, `setHandler` and `SessionEventSocket`. Add an optional final `onIncarnation?: (socketIncarnation: number) => void` argument to `connect`, called synchronously on each socket construction, including reconnect. Keep other socket consumers and the separate `RealtimeSocket` compatible. Update `EmitSocket` to pass that token on delivery and to allocate a fresh one on reconnect. The controller's announcement cursor tracks target, daemon, highest established order and at most `SESSION_NOTIFICATION_LIMIT` recent IDs.

- [ ] **Step 1: Add failing controller and socket tests**

Add deferred-promise tests through public controller and session-selection entry points. Cover the following contracts before implementation:

- `runtimeGenerationFor` starts per machine, advances on confirmed runtime-version or daemon replacement and machine removal, and does not advance on a successful refresh of the same runtime. `acceptedSupportFor` is restricted to the current generation and daemon. A transient negotiation failure retains same-runtime evidence.
- `MachineController` health and runtime recovery accept an optional ownership guard and owner error reporter. A superseded result or rejection publishes neither its result nor global error. Same-machine overlapping health checks preserve the newest admitted observation. Existing unowned callers keep their current result and error behavior.
- The exported pending-start predicate recognizes the actual `ClientPendingStartSessionInfo` shape. Ordinary active sessions with similar display fields remain eligible.
- Initial selection, raw socket OPEN, `session.subscribed`, duplicate subscription markers, reconnect, and selection changes produce the required coverage. For each socket incarnation, exactly one inbox read is admitted after the subscription marker. A pre-marker read still pending queues one trailing read. A pre-marker response that settles before the marker does not cover it. A read already admitted after the marker satisfies it. Duplicate markers join the same coverage. Repeated invalidations during one read reserve at most one trailing request.
- Refresh joins preserve an established same-daemon cursor. Ordered events received during a same-daemon join are validated against the pre-refresh base and can be announced once even when the eventual snapshot also contains them. Initial or replacement snapshots establish a silent baseline from retained row orders and `dismissThrough.order`. Snapshot rows never create announcements.
- Stale target, socket, daemon, selection generation, request, or mutation completions cannot publish rows, errors, support evidence, cleanup another generation's pending operation, or restore retired state. Same-daemon older snapshots cannot replace newer revisions.
- Individual dismissal overlays are independent and can overlap for distinct IDs. Clear all can start while a row dismissal is pending, captures a copied watermark, and pauses all new dismissals until it settles. Rows above its watermark remain visible and counted with disabled controls. Success, failure, and either completion order remove only the completing operation's overlay. A reused notification ID after same-target reselection remains owned by its new operation.
- A later live row and overflow beyond the captured `dismissThrough` pair remain visible. A transport failure after server-side success reconciles from the authoritative snapshot. A response from a replacement daemon never implies its requested dismissal took effect.
- Accepted live additions append one severity-only node keyed by target, daemon, and actual notification ID. Same or lower order, duplicate IDs, snapshots, stale events, gaps, inconsistent summaries, old sockets, and retired daemon events append nothing. Same-daemon refresh, reconnect, temporary staleness, and responsive rendering preserve node identities. Confirmed replacement resets the delivery identity and establishes a new snapshot baseline.

Use the spec's targets A `{machineId:"local", cwd:"/a", sessionId:"s"}`, B `{machineId:"remote", cwd:"/b", sessionId:"s"}`, and C `{machineId:"local", cwd:"/other", sessionId:"s"}`. Also vary just the machine with the same cwd and session ID, and just the session ID with the same machine and cwd. Session IDs are opaque nonempty strings. For each missing machine, empty ID/cwd, archived or client-pending selection, drive admission and assert zero reads and mutations. A→B→A only reads each daemon-owned inbox. Drive runtime-close and archive clear events, recovery and incapable legacy output. Hold A's work through selection of B and C and assert target, rows, error, operation and count after each settlement.

Replace the existing first-OPEN test in `sessionController.notifications.test.ts`. Construct a real `SessionNotificationController` as the `SessionController` bridge. Use its injected `SessionNotificationApi` with deferred snapshots, the existing `EmitSocket`, and `defaultApi` with controlled transcript/status/extension responses. The socket `open()` already models raw OPEN. With the selection read held, assert one call before and after `open()`. In one case resolve the read, await selection, then `emit({type:"session.subscribed"})`. In another emit the marker twice before resolving the read. Both must finish at two calls and show the row created in the subscription gap. Repeat at reconnect and while transcript work is still held. Count actual API admissions and deliver outcomes through the selected socket. In the joined and steady-state paths, check that the same marker also reaches the existing extension-entry barrier read. Keep the two legacy-output tests and update the exact `applyInboxEvent` invocation assertion to include the delivering socket's token.

Use the existing helpers in `sessionNotificationController.test.ts` to pin the duplicate-marker race at the API boundary:

```ts
it("reserves one post-subscription read while the selection read is pending", async () => {
  const first = deferred<SessionNotificationInboxSnapshot>();
  const catchUp = deferred<SessionNotificationInboxSnapshot>();
  const firstStarted = deferred<void>();
  const catchUpStarted = deferred<void>();
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
  const gapRow = entry(1, "warning");
  catchUp.resolve(inboxSnapshot([gapRow], { inboxRevision: 2 }));
  await Promise.all([selectionRead, marker, duplicate]);
  expect(notificationInbox).toHaveBeenCalledTimes(2);
  expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([gapRow]);
});
```

For V6–V7, hold a dismissal of row X, start Clear all, resolve and reject each in both orders. Separately start Clear all **first** with 100 valid rows ordered 100…1, discarded count 3 and `dismissThrough = {order:100, overflowWatermark:8}`. Add row 101, evict row 1 and advance the watermark to 9. Verify the captured request still carries 100/8, and that the effective view contains row 101 plus **one** discarded item. Calling `dismissNotification` for row 101 and repeating Clear all must issue zero extra requests during the hold. Test both success and rollback followed by a dismissal carrying row 101's exact ID. Use valid timestamps such as `new Date(Date.UTC(2026, 10, 18, 0, 0, order)).toISOString()` even above order 59. Check highest severity, newest-first rows, last-visible-row optimistic counts and a transport rejection after the daemon already applied a dismissal. Drive races with explicit response/event barriers.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `npm test -- --run src/client/src/controllers/sessionNotificationController.test.ts src/client/src/controllers/sessionController.notifications.test.ts src/client/src/controllers/machineController.test.ts src/client/src/sessionSocket.test.ts src/client/src/sessionNotifications.test.ts`
Expected: FAIL on missing generation/coverage ownership, admission ordering, stale completion, and announcement contracts.

- [ ] **Step 3: Implement guarded machine recovery and session eligibility**

Extend existing machine health and runtime refresh paths with optional `MachineRefreshOwnership`. Evaluate `isCurrent()` before publishing either a result or an error. Route an owned failure to `onError` and return `undefined`, preserving default global error behavior for existing callers. Add health sequencing so an older same-machine result cannot overwrite a newer observation. Preserve runtime sequencing and treat superseded refreshes as `undefined`.

Export the existing `isClientPendingStartSessionInfo` predicate. In `prepareSelectedSession` advance the generation on every call and build a target only for an eligible session with a matching machine and nonempty machine/session ID and cwd. Use the same eligibility conditions at admission, including direct controller entry points. Pin each identity field independently in tests. Preserve the existing handling of opaque IDs and cwd strings. Compare confirmed component runtime versions and accepted daemon observations, retaining the last successful observation across transient failures. `checkedAt` and `generatedAt` changes alone cannot advance the runtime generation.

- [ ] **Step 4: Implement selection, subscription, and daemon ordering**

Extend `SessionSocket`'s internal event callback with a monotonic socket-incarnation argument. Increment it for each constructed socket and retain the current socket identity check before invoking callbacks. Do not alter the wire event or server protocol.

In `selectSession`, use the same dispatcher in the temporary join handler and both steady-state `setHandler` paths, including recovery after a failed join. Handle `notifications.inbox` once at receipt. A `session.subscribed` marker serves two readers: start notification coverage before transcript buffering or sequence filtering, then forward the original marker through the existing join/`applyEvent` path exactly once. Its `session.subscribed` branch calls `refreshSelectedExtensionEntries()` even when the notification bridge is absent. Keep the extension read at its existing point in that path and preserve its stream-generation and read-revision guards.

```ts
const routeSelectedEvent = (
  event: SessionUiEvent,
  socketIncarnation: number,
  forward: (event: SessionUiEvent) => void,
): void => {
  if (event.type === "notifications.inbox") {
    this.notifications?.applyInboxEvent(machineId, event, socketIncarnation);
    return;
  }
  if (event.type === "session.subscribed") {
    void this.notifications?.ensurePostSubscriptionRefresh(session, machineId, socketIncarnation);
  }
  forward(event);
};
```

Use `forward` to push to the **current** `joinBuffer` during the join and to call `applyEvent` afterward. Replaying a buffered marker runs only its extension-entry path. Pass the sixth `connect` callback to `observeSocketIncarnation`. Keep the initial selection read and ordinary explicit selected refreshes. Remove notification admission from `onInitialOpen` and from the transcript refresh invoked by raw reconnect. Reconnect still resets the extension baseline and refreshes transcript and extension entries. Update the bridge fakes to the extended signatures.

Record coverage at actual inbox API admission as `(selectionGeneration, socketIncarnation, firstMarkerSeen)`. On the first marker, join a read admitted after it, reserve exactly one trailing read if the running one predates it, or start the catch-up if the slot is free. At admission, check current target, reachability, support, and the app's `isCheckingEnvironment` guard. Retain an owed marker across a temporary admission block and recheck those conditions before starting the read. A late pre-marker response cannot satisfy it. A repeated Retry joins the matching promise. A gap or `resync` can invalidate that read once. Publish the operation before invoking the API and clear it by operation identity in `finally`.

Keep the selected target and selection generation authoritative. On selection preparation or clear, retire prior request and announcement identity synchronously. On daemon replacement, invalidate older requests and mutation operations, retire old overlays/support/cursor, mark the projection stale, and reconcile by a current snapshot. Reject events and responses from an old socket or daemon. Invalidate accepted support for confirmed runtime replacement before accepting evidence for the replacement.

- [ ] **Step 5: Implement reducer reconciliation, mutation overlays, and live delivery**

Keep the authoritative inbox separate from operation-owned overlays. Capture `{target, selectionGeneration, daemonInstanceId, operationId}` at mutation admission. Capture a copy of the authoritative `dismissThrough` pair for Clear all and use it unchanged for the existing API call. Accept a mutation only from a matching fresh view with current reachability and support. Use operation-owned finalization so an old request cannot clear newer pending state.

For each refresh, capture target, selection generation, socket incarnation, current daemon, and pre-refresh revision. Buffer incoming events at the existing join seam. Validate same-daemon additions in order from the established pre-refresh base before reconciling a snapshot whose revision is not older. For initial selection or daemon replacement, use the accepted snapshot as the silent announcement baseline, then consider only validated later events. Coalesce retries with an in-flight read and reserve one trailing read only for a real invalidation, including subscription coverage, a gap, `resync`, or inconsistent summary.

On read failure, end the operation and publish the current error. Preserve a still-fresh matching base if the target, daemon, reachability, capability and freshness are all still valid. A missing or invalidated base remains unavailable with Retry. Test both failure paths.

Move announcement production to the controller's accepted-live-event path. Keep a bounded recent ID set and monotonic order cursor for the current target and daemon. Retain severity-only keyed nodes across refresh, stale-to-fresh recovery, and same-daemon reconnect. Snapshot installation preserves same-daemon nodes and resets them only for selection or daemon replacement. Keep the existing `notificationAnnouncementLabel` severity wording.

Preserve effective overlay semantics for retained and discarded counts. A pending Clear all hides only rows and discarded count through its captured pair. A later order or watermark remains visible. An individual pending ID hides only itself. Clear all disables all row actions during its operation while leaving newer rows visible. On success, install only a current matching response at least as recent as the authoritative base. On current failure, remove only the owner's overlay, report the failure and refresh if eligible. An authoritative event may already reflect the operation, but the Clear all admission gate stays closed until its request settles. Re-enable dismissal of visible nonpending rows on either outcome. If reachability or support was lost meanwhile, release only that operation, suppress its response, mark stale and refresh on recovery. Treat a different-daemon response as replacement evidence only for a still-current request. Retire the old identity before accepting replacement support and preserve the replacement daemon's rows. An old `finally` must leave a new same-ID operation intact.

- [ ] **Step 6: Run focused tests and verify type safety**

Run: `npm test -- --run src/client/src/controllers/sessionNotificationController.test.ts src/client/src/controllers/sessionController.notifications.test.ts src/client/src/controllers/sessionController.extensionEntries.test.ts src/client/src/controllers/machineController.test.ts src/client/src/sessionSocket.test.ts src/client/src/sessionNotifications.test.ts`
Expected: PASS for notification coverage, the existing “re-reads extension entries once the subscription is reported live” test and reconnect ordering, support generation, replacement, mutation completion orders, reducer reconciliation, and announcement identity.

Run: `npm run typecheck`
Expected: PASS with the socket callback and controller signatures consumed consistently.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/controllers/sessionNotificationController.ts src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.testSupport.ts src/client/src/controllers/machineController.ts src/client/src/sessionSocket.ts src/client/src/sessionNotifications.ts src/client/src/controllers/sessionNotificationController.test.ts src/client/src/controllers/sessionController.notifications.test.ts src/client/src/controllers/machineController.test.ts src/client/src/sessionSocket.test.ts src/client/src/sessionNotifications.test.ts
git commit -m "fix(notifications): guard selected inbox recovery and mutations"
```

## Task 3: Move the inbox into the Activity Rail

**Implementer tier:** Capable

This task is in the Core client lane and implementation category. It depends on Tasks 1 and 2. It owns the tray, bell and compact launcher rendering, removal of the chat inbox, app-level surface/focus/isolation state, and existing component-level regression coverage.

**Files:**

- Create: `src/client/src/components/SessionNotificationTray.ts`
- Test: `src/client/src/components/SessionNotificationTray.test.ts`
- Create: `src/client/src/components/PiWebUiApp.notifications.test.ts`
- Modify: `src/client/src/components/ActivityRail.ts:1-566`
- Modify: `src/client/src/components/ChatView.ts:1-940`
- Modify: `src/client/src/components/PiWebUiApp.ts:1-5382`
- Modify: `src/client/src/components/appShell/AppContextBar.ts:1-234`
- Modify: `src/client/src/components/shared.ts:526-586` (relocate notification-specific styles, preserve shared utilities)
- Modify: `src/client/src/sessionNotifications.ts:220-251` (retire chat-only collapse helpers once their callers move)
- Test: `src/client/src/sessionNotifications.test.ts:151-205`
- Test: `src/client/src/components/ActivityRail.test.ts:1-664`
- Test: `src/client/src/components/ActivityRail.compactFocus.test.ts:1-60`
- Test: `src/client/src/components/ChatView.test.ts:1-1339`
- Test: `src/client/src/components/PiWebUiApp.activityRail.test.ts:1-468`
- Test: `src/client/src/components/PiWebUiApp.activityRail.focus.test.ts:1-253`
- Test: `src/client/src/components/appShell/AppContextBar.test.ts`

**Interfaces:**

- Consumes: `deriveNotificationPresentation(input: NotificationPresentationInputs): NotificationPresentation` from `notificationPresentation.ts`. Supply `selectedSession`, `selectedMachine`, `machineHealth`, `machineRuntime`, `acceptedSupport`, `runtimeGeneration`, `selectionGeneration`, `inbox`, `operation`, and `isClientPendingStart`. Switch on `kind` (`ineligible`, `offline`, `capability-unavailable`, `unsupported`, `loading`, `unavailable`, `fresh`). Only `fresh` has `view: SelectedSessionNotificationView`. `operation` is `NotificationOperationRecord | undefined`, where a record has `target`, `selectionGeneration`, and `kind` equal to `checking-health`, `checking-capability`, or `loading-inbox`.
- Consumes: `SessionNotificationController.selectionGeneration: number`, `inboxOperation: NotificationOperationRecord | undefined`, `failureMessage: string | undefined`, `runtimeGenerationFor(machineId: string): number`, `acceptedSupportFor(machineId: string): AcceptedNotificationSupport | undefined` (`{runtimeGeneration: number; daemonInstanceId?: string}`), `refreshSelectedSession(session: SessionRef, machineId: string): Promise<void>`, `dismissNotification(notificationId: string): Promise<void>` and `dismissAll(): Promise<void>`. Wire its `onProjectionChange?(): void` to Lit `requestUpdate()` and its `isCheckingEnvironment?(target: SessionNotificationTarget, selectionGeneration: number): boolean` to the app's current recovery record. Read `selectedNotificationInbox.announcements` independently of freshness.
- Consumes: `isClientPendingStartSessionInfo(session: SessionInfo | undefined): session is ClientPendingStartSessionInfo`, `refreshMachineHealth(machineId?: string, ownership?: MachineRefreshOwnership): Promise<MachineHealth | undefined>` and `refreshMachineRuntime(machineId?: string, ownership?: MachineRefreshOwnership): Promise<MachineRuntime | undefined>` where `MachineRefreshOwnership = {isCurrent(): boolean; onError?(error: unknown): void}`. Use `sessionLabel(session: SessionInfo): string` for the title and `ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY` for mode.
- Produces: `SessionNotificationTray` as a projection-only component with these inputs. `PiWebUiApp` owns open state, operation state, focus intent, modal isolation, and actions. `ActivityRail` owns no inbox cache or transport.

```ts
interface NotificationTrayInputs {
  presentation: NotificationPresentation;
  sessionTitle: string;
  errorMessage: string | undefined;
  mode: "flyout" | "sheet";
  open: boolean;
  focusIntent: NotificationSurfaceFocusIntent | undefined;
  onDismiss(notificationId: string): void;
  onDismissAll(): void;
  onRetry(): void;
  onClose(): void;
}

type NotificationFocusTarget =
  | { kind: "notification"; notificationId: string }
  | { kind: "header" };

type NotificationSurfaceFocusIntent = {
  token: number;
  surfaceGeneration: number;
  selectionGeneration: number;
  target: SessionNotificationTarget;
  destination: "heading" | "equivalent-control" | "trigger";
  control?: { role: "dismiss" | "clear-all" | "retry" | "close"; notificationId?: string };
};
```

Use `button.icon-button.notifications-button` for the bell and the existing `button.activity-rail-action-button` for the compact launcher. Compute the full effective count once with `notificationInboxTotalCount(view)` for `fresh`. Give both controls the selected-session context and full count in their accessible names, including zero. Hide a zero badge, show `99+` above 99 and use availability wording for other states. `ActivityRail.renderRailContents()` ends with spacer → optional Reload → Notifications → Settings. The last three controls are outside drag/drop and plugin order. Give the actual open region/dialog a stable element in the app's shadow root, a common ancestor scope for both buttons. On the rendered buttons set `ariaControlsElements` to that element, update `aria-expanded` for the visible surface/drawer, and check the resolved controls relation in Chromium. Keep the launcher's ordinary open/close rail action and wording discoverable in its accessible name.

- [ ] **Step 1: Add failing tray, rail, context-bar, and app tests**

Use mounted Lit controls and `await updateComplete` as in `ActivityRail.test.ts` and `PiWebUiApp.activityRail.focus.test.ts`. For window capture and disconnect tests exercise the real app lifecycle with controlled external inputs. For template-only tests use the repository's template inspection helpers. Cover these cases.

- The old `ChatView` inbox, collapse control, and chat live regions disappear. Session warning rows, speech errors, action-blocking errors, and chat output remain in their current contexts. Legacy notification-tagged command output is filtered only under the existing supported-runtime rule.
- The tray renders ineligible, offline, capability-unavailable, unsupported, loading, unavailable, fresh-zero, and fresh-nonzero states from its input. Fresh rows retain severity, readable received time, truncation notice, overflow wording, and existing descriptive dismiss labels. A fresh empty inbox stays open and shows an explicit empty state.
- Adapt all three existing `ActivityRail.test.ts` cases: “keeps reload in one fixed slot between the spacer and settings” (before and after `railOrder` changes), “keeps reload in the fixed slot with and without plugin controls”, and “renders reload in the compact drawer using the same fixed slot”. Rename the first to describe the new neighbors. Update all four old Reload→Settings assertions at baseline lines 566/572/588/600 to pin both adjacencies below. Keep every spacer→Reload check, and check the sequence with plugin items present and after removal. Preserve the `beforeEach` `matchMedia` stub and compact override used by these mounted tests. With Reload hidden assert spacer → Notifications → Settings. Check drag/drop metadata and badge boundaries 0, 1, 99, 100 and 103.

  ```ts
  const bell = railRoot(rail).querySelector<HTMLButtonElement>("button.notifications-button");
  expect(bell).toBeInstanceOf(HTMLButtonElement);
  expect(reloadButton(rail).nextElementSibling).toBe(bell);
  expect(bell?.nextElementSibling).toBe(railRoot(rail).querySelector("button.settings-button"));
  ```
- The compact launcher exposes the same availability and count, including zero in its accessible name, and its control relationship resolves to the current rail dialog/sheet target.
- Desktop keyboard activation focuses the heading, pointer activation keeps pointer focus behavior, Escape/close/toggle restore only the current visible launcher, and outside pointer close preserves the clicked destination's focus.
- Compact activation closes the compact rail before focusing the sheet heading. The sheet traps Tab and Shift+Tab among connected enabled controls and returns to the heading when it contains no other enabled control. Inert state and prior inert values are restored on close, selection ineligibility, resize, and disconnect.
- The capture-phase `PiWebUiApp.onKeyDown` closes the compact notification sheet on Escape before active speech cancellation or any background action. Other covered global shortcuts are suppressed. Sheet controls and Tab handling still work. Desktop background shortcuts remain available, while controls focused inside the flyout do not invoke background shortcuts.
- Selection changes rebind title, state, count, rows, actions, and target immediately. A pending or archived selection disables the bell and closes the surface with visible focus fallback. Availability changes that remove a focused control move focus to the tray heading. Deferred focus callbacks are cancelled by later user focus, pointer/keyboard intent, close, selection, layout handoff, or another modal.
- Optimistic row removal uses pre-removal order to focus the next row's dismiss control, then the previous row, then the heading. Clear all focuses the heading. A later mutation success or rollback never steals focus from the composer or another surface.
- Drive Retry from the rendered tray through the real machine and notification controllers. Hold health and runtime separately. Offline→offline, failed health, failed or superseded runtime, and confirmed unsupported must leave a settled explanation with zero inbox calls. Offline→online→supported and unknown→supported each admit one read. Multiple Retry/open/render operations join it. Test late resolution/rejection from A after selecting B and C. Include the window where health is published before the runtime check settles. Confirm legacy output from an incapable runtime still appears.
- Drive both V6 action orders through actual buttons. After row-first dismissal start Clear all and verify focus and counts through both settlements. For Clear-all-first, hold the response, add a post-watermark row and inspect its visible disabled dismiss control. After success and rollback separately, click its re-enabled control and assert the API call's machine, `{id, cwd}`, daemon and notification ID. Check focus for first, middle and last rows and for a later move to the composer.
- For V11–V12 retain references to the app's polite/assertive elements and prior keyed children. Drive accepted info, warning and error adds while closed, a duplicate ID at a higher revision, an addition covered by a same-daemon joined snapshot, staleness/recovery, resize and reconnect. Compare actual DOM nodes by identity, observe exactly one severity-only append per accepted ID, bound the **combined** children to `SESSION_NOTIFICATION_LIMIT`, and establish a silent new baseline on reselection/replacement. Confirm the next accepted addition is delivered once.
- Responsive handoff keeps one list, target, count, and announcement identity. Desktop-to-compact closes the compact rail and installs isolation before focus transfer. Compact-to-desktop removes isolation and focuses the equivalent connected control or the heading. Closing afterward returns to the current-layout launcher without reopening the rail.

- [ ] **Step 2: Run the focused component tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/SessionNotificationTray.test.ts src/client/src/components/PiWebUiApp.notifications.test.ts src/client/src/components/ActivityRail.test.ts src/client/src/components/ActivityRail.compactFocus.test.ts src/client/src/components/ChatView.test.ts src/client/src/components/PiWebUiApp.activityRail.test.ts src/client/src/components/PiWebUiApp.activityRail.focus.test.ts src/client/src/components/appShell/AppContextBar.test.ts`
Expected: FAIL because the tray, bell, compact count, relocated ownership, and focus/isolation wiring are absent.

- [ ] **Step 3: Build the projection-only tray and fixed bell**

Create `SessionNotificationTray` with no API client, socket, persistence, or inbox cache. Render availability states, the selected-session heading, close control, one notification list, overflow indication, Clear all, row dismiss actions, and the explicit empty state. Expose current controls for the app's focus-intent contract. Keep severity labels, time formatting, truncation wording, overflow wording, and dismiss labels from existing helpers.

Add `renderNotificationButton()` between the optional `renderReloadButton()` and `renderSettingsButton()` in `renderRailContents()`. Reuse the rail's icon-button, theme and badge styles. Move tray-only CSS from `components/shared.ts` into the tray's Lit styles, preserving wrapping, scrolling, coarse-pointer targets and truncation/overflow wording. Keep the surface host mounted while closed. Its one list uses `ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY` for flyout versus sheet mode.

Add the compact badge and accessible availability/count data to `AppContextBar`'s existing rail launcher. Pass the app-owned surface element down to both controls for their ARIA element reflection. Expose the notification surface's actual labelled `region` (desktop) or `dialog` with `aria-modal="true"` (compact) in that common root. Give the heading `tabindex="-1"` and use a visible close control in both modes.

- [ ] **Step 4: Move ownership and focus/isolation coordination into PiWebUiApp**

Compose the operation input from the app-owned health/runtime retry and `notifications.inboxOperation`. Use the controller's `selectionGeneration` on each preparation, including same-key reselection. Re-evaluate the target and ownership after every await and before reporting an error or clearing a pending record. For `offline` Retry, set the health operation, call `refreshMachineHealth(machineId, ownership)` and end on `undefined`, failed health or explicit offline status. After successful health, switch the **same** owned operation to capability checking before calling `refreshMachineRuntime(machineId, ownership)`. Start unknown-capability Retry at that runtime step. A failed or superseded negotiation ends the flow. Re-evaluate accepted/negotiated support and reachability. Release the matching environment-check guard and call `refreshSelectedSession({id: target.sessionId, cwd: target.cwd}, target.machineId)` once if eligible. A supported unavailable inbox can enter directly at that last step. Guard automatic reads from machine-state publications during the chain. Render current recovery or mutation failure in the tray. Reuse `isClientPendingStartSessionInfo` and the pure projection for both launchers and tray.

Have the app own surface open state and generation, focus-intent token, saved trigger/modality, operation state, and isolation restoration. On compact activation, suppress compact-rail launcher's ordinary focus restoration, close the rail, then focus the sheet heading after connection. Place the surface and stable announcer outside the `.shell` subtree. For a compact sheet, save and set `.shell.inert` (and any other covered interactive root), restore its previous value on every exit, and trap Tab/Shift+Tab among connected enabled sheet controls. In `PiWebUiApp.onKeyDown` at window capture, check an open surface's Escape before `promptEditor.cancelSpeechInput()`, prevent and stop it, then close. For other keys suppress covered global actions in compact mode and let sheet controls receive their own events. On desktop preserve uncovered chat shortcuts and close on outside pointer input using `event.composedPath()` without cancelling the click or restoring focus.

Implement focus handoff by control role and notification ID. In the app's `onDismiss(notificationId)` handler, read the current fresh view and compute `notificationFocusTargetAfterDismiss(view.notifications, notificationId)` before optimistic removal. Schedule recovery only when the removed row owned focus. Before deferred focus, verify the selection target, selection generation, surface generation, intent token, layout, connection, enabled state, and that later user input has not superseded the intent. Ineligibility closes the surface and selects a connected visible fallback. Opening another app modal closes the desktop flyout without returning focus over that modal.

Remove the notification tray props, collapse state/control, and live-region rendering from `ChatView`. Remove its now-unused collapse helpers and corresponding collapse-only tests while retaining exact-target equality and focus-order coverage. Reuse `NotificationFocusTarget` and `notificationFocusTargetAfterDismiss` from `sessionNotifications.ts`. Keep warnings and other notices intact. Mount one app-owned pair of polite/assertive live regions for the app lifetime, outside chat, tray scrolling, and hidden surface content. Render bounded severity-only announcement records with stable keys. Error severity uses assertive and info/warning use polite. Do not move focus or open a surface on arrival.

- [ ] **Step 5: Run focused tests and verify preserved component behavior**

Run: `npm test -- --run src/client/src/sessionNotifications.test.ts src/client/src/components/SessionNotificationTray.test.ts src/client/src/components/PiWebUiApp.notifications.test.ts src/client/src/components/ActivityRail.test.ts src/client/src/components/ActivityRail.compactFocus.test.ts src/client/src/components/ChatView.test.ts src/client/src/components/PiWebUiApp.activityRail.test.ts src/client/src/components/PiWebUiApp.activityRail.focus.test.ts src/client/src/components/appShell/AppContextBar.test.ts`
Expected: PASS, including unrelated warning, speech, action, legacy output, rail ordering, and focus regressions.

Run: `npm run typecheck`
Expected: PASS for tray props, focus intent, application callbacks, and cross-root element references.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/sessionNotifications.ts src/client/src/sessionNotifications.test.ts src/client/src/components/shared.ts src/client/src/components/SessionNotificationTray.ts src/client/src/components/SessionNotificationTray.test.ts src/client/src/components/PiWebUiApp.notifications.test.ts src/client/src/components/ActivityRail.ts src/client/src/components/ChatView.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/appShell/AppContextBar.ts src/client/src/components/ActivityRail.test.ts src/client/src/components/ActivityRail.compactFocus.test.ts src/client/src/components/ChatView.test.ts src/client/src/components/PiWebUiApp.activityRail.test.ts src/client/src/components/PiWebUiApp.activityRail.focus.test.ts src/client/src/components/appShell/AppContextBar.test.ts
git commit -m "feat(notifications): move selected inbox to Activity Rail"
```

## Task 4: Verify responsive behavior and accessibility in Chromium

**Implementer tier:** Capable

This task is in the Core client lane and browser-acceptance category. It depends on Task 3. It adds a deterministic browser gate and verifies B1–B4 through the production components, responsive styles, and native browser focus/event behavior.

**Files:**

- Create: `scripts/verify-sidebar-notifications.mjs`
- Modify: `scripts/verify-narrow-navigation-header.mjs:1622-1678` (`runRefreshPlacement`) and `scripts/verify-narrow-navigation-header.mjs:2172-2215` (`refreshState`)
- Modify: `package.json:35-65`

**Interfaces:**

- Consumes: the rendered `button.notifications-button`, `button.activity-rail-action-button`, `button.rail-reload-button`, `button.settings-button`, labelled region/dialog and polite/assertive regions. Exercise the production `PiWebUiApp` through browser actions, the real notification HTTP clients and their validated snapshots, and socket `session.subscribed` / `notifications.inbox` frames. Use the deterministic Chromium/CDP, temporary Vite server, startup/deadline and `CHROME_BIN`/`findChrome()` patterns from `scripts/verify-narrow-navigation-header.mjs` and `scripts/capture-screenshots.mjs`.
- Produces: `npm run verify:sidebar-notifications`, a no-skip browser acceptance gate outside `npm run verify`.

- [ ] **Step 1: Write the failing browser assertions**

Create a browser fixture that enters through the real `PiWebUiApp` and production components, uses controllable API/socket responses at existing client boundaries, and records calls and announcement-node identities. Do not replace the tray or bypass controller admission with a test-only presentation path. Use native Chromium layout, media queries, pointer/keyboard input, focus movement, and the accessibility tree.

Install the `verify:sidebar-notifications` package command with the runnable fixture and assertions. In the existing `refreshState()` switch compact-launcher lookup to `contextRoot.querySelector("button.activity-rail-action-button")`, including for focus/coordinate reads. Use that class for interaction in both gates. Check the bell's actual accessibility-tree name for the full notification count and selected title, and check the compact launcher's accessible name separately. Keep selection of a clickable element independent of its dynamic label.

Assert all of the following:

- **B1 desktop:** At 1440×900 and 1181px, the fixed bell sits immediately above Settings and below reload when enabled. The nonmodal flyout overlays available navigation space without changing chat geometry, dimming or isolating the background, clipping long messages/actions, or trapping focus. Verify list scrolling, outside pointer close that preserves focus at the clicked destination, and continued composer interaction. Inspect the accessible name, full count, expanded state, and launcher-to-surface relationship.
- **B2 compact:** At 1180px and 390×844, the compact launcher count is correct. Activating the bell closes the rail, opens a viewport-filling safe-area-aware modal sheet, and focuses its heading. Native Tab/Shift+Tab stay within connected enabled controls. Verify long-content scrolling, inert background pointer/focus behavior, suppressed app shortcuts, and Escape closing the sheet before active speech cancellation. Close restores focus to the visible compact launcher.
- **B3 breakpoint handoff:** With a row control focused, resize across 1181px in both directions. Verify one visible list, equivalent focus or heading fallback, modal isolation in compact mode, unchanged target/count, zero dismiss calls, and restoration to the current-layout launcher on close. Repeat with desktop-background focus, a pending mutation, and a missing/disabled equivalent control.
- **B4 announcements and accessibility tree:** Observe the single mounted polite/assertive regions with the tray closed and across open, close, resize, stale recovery, same-daemon reconnect, selection change, and daemon replacement. Verify one append per accepted live ID and no snapshot replay. Confirm severity-only labels, real region/dialog roles, full accessible counts, expanded state, cross-root launcher relationship, and covered-background isolation.
- Verify two selected targets with equal session IDs and different machine/cwd, including immediate title/row rebinding and no old-target action. Verify availability state, retry path, Clear all watermark, and accepted live addition through the browser fixture.

Use deterministic event barriers and explicit response release. Do not use timing sleeps as correctness assertions. The script fails with actionable diagnostics when Chromium is missing and has no skip path.

- [ ] **Step 2: Observe the old placement regression**

Run: `npm run verify:narrow-navigation-header` after fixing launcher lookup but before changing the placement assertion. Expected: the opened PWA drawer reaches the Reload→Settings adjacency check and fails there because the bell is now between them. A missing executable, selector or package script is a fixture error. Run the new `npm run verify:sidebar-notifications` against Task 3. If an assertion already passes, exercise it against a disposable negative control (for placement, temporarily swap the bell and Settings in the rendered fixture) and require a placement failure. Restore the fixture for acceptance.

- [ ] **Step 3: Update the existing Chromium order check and finish the new gate**

In `runRefreshPlacement`, compute `bellIndex = opened.railChildren.indexOf("icon-button notifications-button")`. Assert all four nodes are present. In the open drawer with rail Reload enabled, enforce the full sequence with these checks.

```js
assert.ok(bellIndex >= 0, "missing Notifications button");
assert.equal(reloadIndex, spacerIndex + 1);
assert.equal(bellIndex, reloadIndex + 1);
assert.equal(settingsIndex, bellIndex + 1);
```

Preserve the existing PWA/ordinary-tab and desktop/drawer/mobile visibility, context-bar reload, and native click/keyboard checks. Use explicit CDP input, connection/render barriers, timeout diagnostics and `finally` cleanup for the temporary Vite server, browser and profile. Keep both Chromium commands explicit and outside `npm run verify`.

- [ ] **Step 4: Run Chromium acceptance and the full project verification**

Run: `npm run verify:sidebar-notifications`
Expected: PASS for B1–B4 at the specified widths and interactions, with every launched browser/server process cleaned up.

Run: `npm run verify:narrow-navigation-header`
Expected: PASS for all prior geometry and native-input cases and the revised PWA fixed order.

Run: `npm test -- --run src/client/src/api/clients.test.ts src/client/src/api/parsers.test.ts`
Expected: PASS including encoded machine/session paths, cwd, watermarks and strict notification parsing.

Run: `npm run verify`
Expected: PASS for typecheck, lint, Knip, and the serial Vitest suite.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-sidebar-notifications.mjs scripts/verify-narrow-navigation-header.mjs package.json
git commit -m "test(notifications): verify responsive Activity Rail in Chromium"
```

## Task 5: Update navigation guidance and release notes

**Implementer tier:** Standard

This task is in the Documentation lane and documentation/release-note category. It has no task dependency because the approved behavior and placement are fully specified. Its files are disjoint from the Core client lane, so it can run independently.

**Files:**

- Modify: `docs/navigation-panel.md:1-31`
- Create: `.changeset/sidebar-notifications.md`

**Interfaces:**

- Consumes: the approved user-visible behavior in the pinned design/specification and the existing concise navigation guide.
- Produces: corrected navigation and reload placement guidance plus one scoped Changeset for `@hyperdreamer/pi-webui`. Do not edit `CHANGELOG.md`, which is generated during release.

- [ ] **Step 1: Add the Changeset and update the navigation guide**

Update `docs/navigation-panel.md` with the fixed Activity Rail bell, compact launcher, selected-session count/title, desktop flyout and compact sheet, availability/retry states, dismissal behavior, and daemon-owned in-memory lifetime. Correct the PWA reload ordering to reload, bell, Settings when reload is visible, and keep existing navigation width and machine-switcher guidance accurate. Keep detail in this document and preserve the README boundary.

Use this Changeset content in `.changeset/sidebar-notifications.md`.

```md
---
"@hyperdreamer/pi-webui": minor
---

View and dismiss the selected session's notifications from the Activity Rail. The bell opens a desktop flyout or a full-screen sheet on smaller screens.
```

- [ ] **Step 2: Validate documentation formatting and Changeset metadata**

Run: `git diff --check`
Expected: PASS with no whitespace errors.

Run: `npm run changeset -- status`
Expected: PASS and the new Changeset is recognized for the package.

Review the guide against Task 3's implemented labels and placement after integration. Keep any required wording changes inside these two owned files.

- [ ] **Step 3: Commit**

```bash
git add docs/navigation-panel.md .changeset/sidebar-notifications.md
git commit -m "docs(notifications): document Activity Rail inbox"
```
