// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { MachineRuntime, SessionNotification, SessionNotificationInboxEvent, SessionNotificationInboxSnapshot } from "../../../shared/apiTypes";
import { SESSION_NOTIFICATION_LIMIT } from "../../../shared/apiTypes";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/apiTypes";
import { api, type Machine, type SessionInfo } from "../api";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { MachineController } from "../controllers/machineController";
import { SessionController } from "../controllers/sessionController";
import type { SelectedSessionNotificationInbox } from "../sessionNotifications";
import { ActivityRail } from "./ActivityRail";
import { AppContextBar } from "./appShell/AppContextBar";
import { PiWebUiApp } from "./PiWebUiApp";
import { SessionNotificationTray } from "./SessionNotificationTray";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);

const machine: Machine = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: "now",
  updatedAt: "now",
};
const session: SessionInfo = {
  id: "session-a",
  cwd: "/repo",
  path: "/sessions/session-a.jsonl",
  created: "now",
  modified: "now",
  messageCount: 0,
  firstMessage: "Build session",
};
let mountedApp: PiWebUiApp | undefined;

function setState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Unable to set app fixture state");
}

function patchAppState(app: PiWebUiApp, patch: Partial<AppState>): void {
  const set: unknown = Reflect.get(app, "setState");
  if (typeof set !== "function") throw new Error("Expected application state publisher");
  set.call(app, patch);
}

function setLayout(app: PiWebUiApp, desktop: boolean): void {
  const shell: unknown = Reflect.get(app, "appShell");
  if (typeof shell !== "object" || shell === null || !Reflect.set(shell, "isDesktopActivityRailLayout", desktop)) {
    throw new Error("Unable to set app layout fixture");
  }
}

function notificationTray(app: PiWebUiApp): SessionNotificationTray {
  const element = app.shadowRoot?.querySelector("session-notification-tray");
  if (!(element instanceof SessionNotificationTray)) throw new Error("Expected SessionNotificationTray");
  return element;
}

type GlobalKeyDownHandler = (event: KeyboardEvent) => void;

function isGlobalKeyDownHandler(value: unknown): value is GlobalKeyDownHandler {
  return typeof value === "function";
}

function installAppKeyCapture(app: PiWebUiApp): () => void {
  const handler: unknown = Reflect.get(app, "onKeyDown");
  if (!isGlobalKeyDownHandler(handler)) throw new Error("Expected the application key handler");
  window.addEventListener("keydown", handler, true);
  return () => {
    window.removeEventListener("keydown", handler, true);
  };
}

async function mountApp(state = initialAppState(), desktop = true): Promise<PiWebUiApp> {
  const app = new PiWebUiApp();
  // Keep the unrelated unread-capability negotiation from competing with these controlled retries.
  Reflect.set(app, "renegotiateUnreadMachine", () => Promise.resolve());
  setState(app, state);
  setLayout(app, desktop);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: desktop, media: "(min-width: 1181px)", onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true }) });
  mountedApp = app;
  vi.spyOn(PiWebUiApp.prototype, "connectedCallback").mockImplementation(function (this: PiWebUiApp): void {
    LitElement.prototype.connectedCallback.call(this);
  });
  vi.spyOn(PiWebUiApp.prototype, "disconnectedCallback").mockImplementation(function (this: PiWebUiApp): void {
    LitElement.prototype.disconnectedCallback.call(this);
  });
  document.body.append(app);
  await app.updateComplete;
  return app;
}

async function mountRealLifecycleApp(state: AppState, desktop: boolean): Promise<PiWebUiApp> {
  const app = new PiWebUiApp({
    speechInputApi: { settings: () => Promise.reject(new Error("Test speech settings unavailable")) },
    createSpeechInputSettingsChannel: () => ({ publish: () => undefined, close: () => undefined }),
  });
  setState(app, state);
  setLayout(app, desktop);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: desktop, media: "", onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true }) });
  // The app lifecycle and capture listeners stay real. Stub its existing startup IO seams.
  for (const name of ["connectRealtime", "synchronizeProjectCatalogPolling", "syncWindowTitle"]) Reflect.set(app, name, () => undefined);
  for (const name of ["renegotiateUnreadMachines", "renegotiateUnreadMachine", "refreshWorkspaceActivity", "loadClientConfig", "ensureGatewayPluginsLoaded", "loadProjectsAndRestoreRoute"]) Reflect.set(app, name, () => Promise.resolve());
  const hostSpeech: unknown = Reflect.get(app, "hostSpeech");
  const recentProjects: unknown = Reflect.get(app, "recentProjects");
  if (typeof hostSpeech !== "object" || hostSpeech === null || typeof recentProjects !== "object" || recentProjects === null) throw new Error("Expected startup IO controllers");
  Reflect.set(hostSpeech, "refreshStatus", () => Promise.resolve());
  Reflect.set(recentProjects, "load", () => Promise.resolve());
  mountedApp = app;
  document.body.append(app);
  await app.updateComplete;
  return app;
}

function rail(app: PiWebUiApp): ActivityRail {
  const element = app.shadowRoot?.querySelector("activity-rail");
  if (!(element instanceof ActivityRail)) throw new Error("Expected ActivityRail");
  return element;
}

function contextBar(app: PiWebUiApp): AppContextBar {
  const element = app.shadowRoot?.querySelector("app-context-bar");
  if (!(element instanceof AppContextBar)) throw new Error("Expected AppContextBar");
  return element;
}

function notificationInbox(sessionInfo: SessionInfo, total = 1): SelectedSessionNotificationInbox {
  const retainedCount = Math.min(total, 100);
  const discardedCount = Math.max(total - 100, 0);
  const notifications = Array.from({ length: retainedCount }, (_unused, index) => ({
    id: `daemon-a:${String(index + 1)}`,
    order: index + 1,
    receivedAt: "2026-11-18T12:00:00.000Z",
    severity: "warning" as const,
    message: "Build failed",
    truncated: false,
  }));
  return {
    machineId: "local",
    sessionId: sessionInfo.id,
    cwd: sessionInfo.cwd,
    status: "fresh",
    daemonInstanceId: "daemon-a",
    catalogRevision: 1,
    summary: { sessionId: sessionInfo.id, cwd: sessionInfo.cwd, inboxRevision: 1, retainedCount, discardedCount, ...(total === 0 ? {} : { highestSeverity: "warning" as const }) },
    notifications,
    dismissThrough: { order: retainedCount, overflowWatermark: discardedCount },
    optimisticDismissedIds: [],
    announcements: [],
  };
}

function selectedState(selectedSession: SessionInfo = session, total = 1): AppState {
  const runtime: MachineRuntime = {
    machineId: "local",
    ok: true,
    checkedAt: "now",
    capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications],
  };
  return { ...initialAppState(), machines: [machine], selectedMachine: machine, selectedSession, sessions: [selectedSession], machineRuntimes: { local: runtime }, selectedNotificationInbox: notificationInbox(selectedSession, total) };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

function appNotifications(app: PiWebUiApp): SessionNotificationController {
  const controller: unknown = Reflect.get(app, "notifications");
  if (!(controller instanceof SessionNotificationController)) throw new Error("Expected notification controller");
  return controller;
}

function currentAppState(app: PiWebUiApp): AppState {
  const value: unknown = Reflect.get(app, "state");
  if (!isAppState(value)) throw new Error("Expected application state");
  return value;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "machines"))
    && typeof Reflect.get(value, "machineRuntimes") === "object" && typeof Reflect.get(value, "machineStatuses") === "object";
}

function notification(order: number, severity: SessionNotification["severity"] = "info", daemon = "daemon-a"): SessionNotification {
  return { id: `${daemon}:${String(order)}`, order, severity, message: `Private ${String(order)}`, truncated: false, receivedAt: "2026-11-18T12:00:00.000Z" };
}

function snapshot(rows: SessionNotification[], revision = 1, selected = session, daemon = "daemon-a"): SessionNotificationInboxSnapshot {
  const highestSeverity = rows.some((row) => row.severity === "error") ? "error"
    : rows.some((row) => row.severity === "warning") ? "warning" : rows.length > 0 ? "info" : undefined;
  return {
    daemonInstanceId: daemon,
    catalogRevision: revision,
    summary: { sessionId: selected.id, cwd: selected.cwd, inboxRevision: revision, retainedCount: rows.length, discardedCount: 0, ...(highestSeverity === undefined ? {} : { highestSeverity }) },
    notifications: rows,
    dismissThrough: { order: Math.max(0, ...rows.map((row) => row.order)), overflowWatermark: 0 },
  };
}

function addition(row: SessionNotification, rows: SessionNotification[], revision: number, selected = session, daemon = "daemon-a"): SessionNotificationInboxEvent {
  const current = snapshot(rows, revision, selected, daemon);
  return { type: "notifications.inbox", daemonInstanceId: daemon, catalogRevision: revision, summary: current.summary, dismissThrough: current.dismissThrough, delta: { kind: "added", notification: row } };
}

async function renderNotifications(app: PiWebUiApp): Promise<SessionNotificationTray> {
  await app.updateComplete;
  const tray = notificationTray(app);
  await tray.updateComplete;
  await rail(app).updateComplete;
  return tray;
}

async function openNotifications(app: PiWebUiApp): Promise<SessionNotificationTray> {
  await renderNotifications(app);
  const bell = rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button");
  if (bell === null || bell === undefined) throw new Error("Expected notification bell");
  bell.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 0 }));
  return renderNotifications(app);
}

function rowButton(tray: SessionNotificationTray, id: string): HTMLButtonElement {
  const row = [...(tray.shadowRoot?.querySelectorAll<HTMLElement>(".notification-row") ?? [])].find((item) => item.dataset["notificationId"] === id);
  const button = row?.querySelector<HTMLButtonElement>(".notification-row-dismiss");
  if (button === null || button === undefined) throw new Error(`Expected dismiss button for ${id}`);
  return button;
}

function retryOperation(app: PiWebUiApp): Promise<void> {
  const operation: unknown = Reflect.get(app, "notificationEnvironmentRetry");
  if (!(operation instanceof Promise)) throw new Error("Expected notification Retry operation");
  return operation;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, media: "", onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true }) });
});

afterEach(async () => {
  document.body.replaceChildren();
  await mountedApp?.updateComplete;
  await Promise.resolve();
  mountedApp = undefined;
  vi.restoreAllMocks();
});

describe("PiWebUiApp selected-session notification surface", () => {
  it("renders a disabled bell without an eligible selected session", async () => {
    const app = await mountApp();
    await rail(app).updateComplete;
    const bell = rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button");
    expect(bell?.disabled).toBe(true);
    expect(app.shadowRoot?.querySelector("session-notification-tray")).not.toBeNull();
    expect(app.shadowRoot?.querySelectorAll("[aria-live='polite'], [aria-live='assertive']")).toHaveLength(2);
  });

  it("keeps the selected session's fresh count in the bell and compact launcher", async () => {
    const app = await mountApp(selectedState(), false);
    await app.updateComplete;
    await contextBar(app).updateComplete;

    const launcher = contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button");
    expect(launcher?.getAttribute("aria-label")).toContain("1");
    expect(launcher?.ariaControlsElements?.[0]).toBe(notificationTray(app));
    expect(launcher?.getAttribute("aria-expanded")).toBe("false");
    const notificationsRail = rail(app);
    notificationsRail.compactOpen = true;
    await notificationsRail.updateComplete;
    await app.updateComplete;
    const bell = notificationsRail.shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button");
    expect(bell?.getAttribute("aria-label")).toContain("Build session");
    expect(bell?.getAttribute("aria-expanded")).toBe("false");
    expect(notificationsRail.shadowRoot?.querySelector(".rail-badge")?.textContent).toBe("1");
  });

  it("opens the desktop flyout by keyboard with a working control relation and restores focus on Escape", async () => {
    const app = await mountApp(selectedState());
    const notificationsRail = rail(app);
    await notificationsRail.updateComplete;
    const bell = notificationsRail.shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button");
    const tray = notificationTray(app);
    if (bell === null || bell === undefined) throw new Error("Expected the notification bell");
    bell.focus();
    bell.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 0 }));
    await app.updateComplete;
    await tray.updateComplete;
    expect(bell.getAttribute("aria-expanded")).toBe("true");
    expect(bell.ariaControlsElements?.[0]).toBe(tray);
    expect(tray.getAttribute("role")).toBe("region");
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector("[data-notification-focus='heading']"));

    const removeCapture = installAppKeyCapture(app);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true });
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-close")?.dispatchEvent(escape);
    removeCapture();
    await app.updateComplete;
    await Promise.resolve();
    expect(escape.defaultPrevented).toBe(true);
    expect(bell.getAttribute("aria-expanded")).toBe("false");
    expect(notificationsRail.shadowRoot?.activeElement).toBe(bell);
  });

  it("preserves pointer focus when opening the desktop flyout", async () => {
    const app = await mountApp(selectedState());
    const notificationsRail = rail(app);
    await notificationsRail.updateComplete;
    const bell = notificationsRail.shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button");
    if (bell === null || bell === undefined) throw new Error("Expected the notification bell");
    bell.focus();
    bell.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    await app.updateComplete;
    await notificationTray(app).updateComplete;
    expect(notificationsRail.shadowRoot?.activeElement).toBe(bell);
  });

  it("opens a compact modal sheet with isolation and suppresses covered shortcuts before speech cancellation", async () => {
    const app = await mountApp(selectedState(), false);
    const launcher = contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button");
    if (launcher === null || launcher === undefined) throw new Error("Expected the compact activity rail launcher");
    launcher.click();
    await app.updateComplete;
    const notificationsRail = rail(app);
    await notificationsRail.updateComplete;
    await app.updateComplete;
    expect(contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button")?.ariaControlsElements?.[0]).toBe(notificationsRail.shadowRoot?.querySelector(".compact-rail-dialog"));
    expect(contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button")?.getAttribute("aria-expanded")).toBe("true");
    notificationsRail.shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button")?.click();
    await app.updateComplete;
    const tray = notificationTray(app);
    await tray.updateComplete;
    const shell = app.shadowRoot?.querySelector<HTMLElement>(".shell");
    expect(tray.getAttribute("role")).toBe("dialog");
    expect(tray.getAttribute("aria-modal")).toBe("true");
    expect(shell?.inert).toBe(true);
    expect(contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button")?.ariaControlsElements?.[0]).toBe(tray);
    expect(contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button")?.getAttribute("aria-expanded")).toBe("true");
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector("[data-notification-focus='heading']"));

    const promptEditor = { cancelSpeechInput: vi.fn(() => true) };
    Reflect.set(app, "promptEditor", promptEditor);
    const removeCapture = installAppKeyCapture(app);
    const sheetKeyListener = vi.fn();
    const closeButton = tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-close");
    closeButton?.addEventListener("keydown", sheetKeyListener);
    const key = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, composed: true });
    closeButton?.dispatchEvent(key);
    removeCapture();
    expect(sheetKeyListener).toHaveBeenCalledOnce();
    expect(promptEditor.cancelSpeechInput).not.toHaveBeenCalled();
    expect(key.defaultPrevented).toBe(false);

    const removeEscapeCapture = installAppKeyCapture(app);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true });
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-close")?.dispatchEvent(escape);
    removeEscapeCapture();
    await app.updateComplete;
    await Promise.resolve();
    expect(escape.defaultPrevented).toBe(true);
    expect(promptEditor.cancelSpeechInput).not.toHaveBeenCalled();
    expect(Boolean(shell?.inert)).toBe(false);
    expect(contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button")?.getAttribute("aria-expanded")).toBe("false");
    expect(contextBar(app).shadowRoot?.activeElement).toBe(launcher);
  });

  it("closes the compact sheet when its backdrop is pressed and leaves the destination focus alone", async () => {
    const app = await mountApp(selectedState(), false);
    const launcher = contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button");
    if (launcher === null || launcher === undefined) throw new Error("Expected the compact activity rail launcher");
    launcher.click();
    await app.updateComplete;
    const notificationsRail = rail(app);
    await notificationsRail.updateComplete;
    notificationsRail.shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button")?.click();
    await app.updateComplete;
    const surface = app.shadowRoot?.querySelector<HTMLElement>(".notification-surface");
    const event = new PointerEvent("pointerdown", { bubbles: true, composed: true });
    surface?.dispatchEvent(event);
    await app.updateComplete;
    await Promise.resolve();
    expect(surface?.hidden).toBe(true);
    expect(contextBar(app).shadowRoot?.activeElement).toBe(launcher);
  });

  it("closes an ineligible selection and restores a focusable fallback", async () => {
    const app = await mountApp(selectedState());
    const bell = rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button");
    bell?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 0 }));
    await app.updateComplete;
    await notificationTray(app).updateComplete;
    setState(app, selectedState({ ...session, archived: true }));
    await app.updateComplete;
    await Promise.resolve();
    await rail(app).updateComplete;
    expect(app.shadowRoot?.querySelector<HTMLElement>(".notification-surface")?.hidden).toBe(true);
    expect(rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button")?.disabled).toBe(true);
    expect(app.shadowRoot?.activeElement).toBe(app.shadowRoot?.querySelector("main"));
  });

  it("removes compact isolation when the open surface switches to desktop", async () => {
    const app = await mountApp(selectedState(), false);
    contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button")?.click();
    await app.updateComplete;
    await rail(app).updateComplete;
    rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button")?.click();
    await app.updateComplete;
    const shell = app.shadowRoot?.querySelector<HTMLElement>(".shell");
    expect(shell?.inert).toBe(true);
    setLayout(app, true);
    app.requestUpdate();
    await app.updateComplete;
    await notificationTray(app).updateComplete;
    expect(Boolean(shell?.inert)).toBe(false);
    expect(notificationTray(app).mode).toBe("flyout");
    expect(app.shadowRoot?.querySelector<HTMLElement>(".notification-surface")?.hidden).toBe(false);
  });

  it("settles an offline Retry without requesting an inbox", async () => {
    const remote = { ...machine, id: "remote", name: "Remote", kind: "remote" as const };
    const offline = { machineId: "remote", ok: false, checkedAt: "now", status: "offline" as const };
    const health = vi.spyOn(api, "health").mockResolvedValue(offline);
    const inboxRead = vi.spyOn(api, "notificationInbox");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const state = selectedState();
    const app = await mountApp({ ...state, machines: [remote], selectedMachine: remote, machineStatuses: { remote: offline }, machineRuntimes: {}, selectedNotificationInbox: undefined });
    const controller: unknown = Reflect.get(app, "notifications");
    if (!(controller instanceof SessionNotificationController)) throw new Error("Expected notification controller");
    controller.prepareSelectedSession(session, "remote");
    await app.updateComplete;
    rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button")?.click();
    await app.updateComplete;
    const tray = notificationTray(app);
    await tray.updateComplete;
    const retry = tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry");
    if (retry === null || retry === undefined) throw new Error("Expected Retry");
    retry.click();
    expect(health).toHaveBeenCalledOnce();
    await health.mock.results[0]?.value;
    await Promise.resolve();
    await app.updateComplete;
    await tray.updateComplete;
    expect(tray.shadowRoot?.textContent).toContain("remain unavailable");
    expect(inboxRead).not.toHaveBeenCalled();
  });

  it("removes a failed Retry alert when the same selected machine recovers", async () => {
    const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
    const offline = { machineId: "remote", ok: false, checkedAt: "before", status: "offline" as const };
    const online = { machineId: "remote", ok: true, checkedAt: "after", status: "online" as const };
    const state = selectedState();
    const remoteInbox = { ...notificationInbox(session), machineId: "remote" };
    if (remoteInbox.daemonInstanceId === undefined || remoteInbox.summary === undefined) throw new Error("Expected inbox fixture");
    vi.spyOn(api, "health").mockRejectedValueOnce(new Error("health failed")).mockResolvedValueOnce(online);
    const inboxRead = vi.spyOn(api, "notificationInbox").mockResolvedValue({
      daemonInstanceId: remoteInbox.daemonInstanceId,
      catalogRevision: remoteInbox.catalogRevision,
      summary: remoteInbox.summary,
      notifications: remoteInbox.notifications,
      dismissThrough: remoteInbox.dismissThrough,
    });
    const app = await mountApp({
      ...state,
      machines: [remote],
      selectedMachine: remote,
      machineStatuses: { remote: offline },
      machineRuntimes: { remote: { machineId: "remote", ok: true, checkedAt: "now", capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications] } },
      selectedNotificationInbox: undefined,
    });
    const controller: unknown = Reflect.get(app, "notifications");
    const machines: unknown = Reflect.get(app, "machines");
    if (!(controller instanceof SessionNotificationController) || !(machines instanceof MachineController)) throw new Error("Expected app controllers");
    controller.prepareSelectedSession(session, "remote");
    await app.updateComplete;
    rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button")?.click();
    await app.updateComplete;
    const tray = notificationTray(app);
    await tray.updateComplete;
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    const retry: unknown = Reflect.get(app, "notificationEnvironmentRetry");
    if (!(retry instanceof Promise)) throw new Error("Expected Retry operation");
    await retry;
    await app.updateComplete;
    await tray.updateComplete;
    expect(tray.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain("health failed");
    expect(inboxRead).not.toHaveBeenCalled();

    await machines.refreshMachineHealth("remote");
    await controller.refreshSelectedSession(session, "remote");
    await app.updateComplete;
    await tray.updateComplete;
    expect(inboxRead).toHaveBeenCalledOnce();
    expect(tray.shadowRoot?.textContent).toContain("Build failed");
    expect(tray.shadowRoot?.querySelector("[role='alert']")).toBeNull();
  });

  it("clears a capability failure after the current runtime is successfully renegotiated", async () => {
    const runtime = { machineId: "local", ok: true, checkedAt: "after", capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications] };
    vi.spyOn(api, "runtime").mockRejectedValueOnce(new Error("runtime failed")).mockResolvedValueOnce(runtime);
    const inboxRead = vi.spyOn(api, "notificationInbox").mockResolvedValue(snapshot([notification(1)]));
    const app = await mountApp({ ...selectedState(), machineRuntimes: {}, selectedNotificationInbox: undefined });
    const controller = appNotifications(app);
    const machines: unknown = Reflect.get(app, "machines");
    if (!(machines instanceof MachineController)) throw new Error("Expected machine controller");
    controller.prepareSelectedSession(session, "local");
    const tray = await openNotifications(app);
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    await retryOperation(app);
    await renderNotifications(app);
    expect(tray.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain("runtime failed");
    expect(inboxRead).not.toHaveBeenCalled();
    await machines.refreshMachineRuntime("local");
    await controller.refreshSelectedSession(session, "local");
    await renderNotifications(app);
    expect(inboxRead).toHaveBeenCalledOnce();
    expect(tray.shadowRoot?.textContent).toContain("Private 1");
    expect(tray.shadowRoot?.querySelector("[role='alert']")).toBeNull();
  });

  it("keeps a staged offline recovery guarded until health, capability, and one joined inbox read settle", async () => {
    const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
    const offline = { machineId: "remote", ok: false, checkedAt: "before", status: "offline" as const };
    const health = deferred<Awaited<ReturnType<typeof api.health>>>();
    const runtime = deferred<MachineRuntime>();
    const inbox = deferred<SessionNotificationInboxSnapshot>();
    const healthCall = vi.spyOn(api, "health").mockReturnValue(health.promise);
    const runtimeCall = vi.spyOn(api, "runtime").mockReturnValue(runtime.promise);
    const inboxCall = vi.spyOn(api, "notificationInbox").mockReturnValue(inbox.promise);
    const app = await mountApp({ ...selectedState(), machines: [remote], selectedMachine: remote, machineStatuses: { remote: offline }, machineRuntimes: {}, selectedNotificationInbox: undefined });
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "remote");
    const tray = await openNotifications(app);
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    const retry = retryOperation(app);
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    expect(healthCall).toHaveBeenCalledOnce();
    expect(runtimeCall).not.toHaveBeenCalled();
    expect(inboxCall).not.toHaveBeenCalled();

    health.resolve({ machineId: "remote", ok: true, checkedAt: "after", status: "online" });
    await vi.waitFor(() => { expect(runtimeCall).toHaveBeenCalledOnce(); });
    await renderNotifications(app);
    expect(inboxCall).not.toHaveBeenCalled();
    expect(tray.shadowRoot?.textContent).toContain("Checking notification support");
    app.requestUpdate();
    await renderNotifications(app);
    expect(inboxCall).not.toHaveBeenCalled();

    runtime.resolve({ machineId: "remote", ok: true, checkedAt: "after", capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications] });
    await vi.waitFor(() => { expect(inboxCall).toHaveBeenCalledOnce(); });
    expect(inboxCall).toHaveBeenCalledWith({ id: session.id, cwd: session.cwd }, "remote");
    const joined = controller.refreshSelectedSession(session, "remote");
    expect(inboxCall).toHaveBeenCalledOnce();
    inbox.resolve(snapshot([notification(1)]));
    await Promise.all([retry, joined]);
    await renderNotifications(app);
    expect(tray.shadowRoot?.textContent).toContain("Private 1");
    expect(tray.shadowRoot?.querySelector("[role='alert']")).toBeNull();
  });

  it.each(["health-failure", "runtime-failure", "unsupported"] as const)("settles %s without an inbox request", async (outcome) => {
    const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
    const offline = { machineId: "remote", ok: false, checkedAt: "before", status: "offline" as const };
    const health = vi.spyOn(api, "health");
    if (outcome === "health-failure") health.mockRejectedValue(new Error("health unavailable"));
    else health.mockResolvedValue({ machineId: "remote", ok: true, checkedAt: "after", status: "online" });
    const runtime = vi.spyOn(api, "runtime");
    if (outcome === "runtime-failure") runtime.mockRejectedValue(new Error("runtime unavailable"));
    else runtime.mockResolvedValue({ machineId: "remote", ok: true, checkedAt: "after", capabilities: [] });
    const inbox = vi.spyOn(api, "notificationInbox");
    const app = await mountApp({ ...selectedState(), machines: [remote], selectedMachine: remote, machineStatuses: { remote: offline }, machineRuntimes: {}, selectedNotificationInbox: undefined });
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "remote");
    const tray = await openNotifications(app);
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    await retryOperation(app);
    await renderNotifications(app);
    expect(inbox).not.toHaveBeenCalled();
    expect(tray.shadowRoot?.textContent).toContain(outcome === "unsupported" ? "does not support" : "unavailable");
    expect(tray.shadowRoot?.textContent).not.toContain("Checking notification support");
    expect(controller.shouldFilterLegacyNotification("remote", "legacy-id")).toBe(false);
  });

  it("negotiates unknown capability before admitting a single inbox read", async () => {
    const runtime = deferred<MachineRuntime>();
    const runtimeCall = vi.spyOn(api, "runtime").mockReturnValue(runtime.promise);
    const inboxCall = vi.spyOn(api, "notificationInbox").mockResolvedValue(snapshot([notification(1)]));
    const app = await mountApp({ ...selectedState(), machineRuntimes: {}, selectedNotificationInbox: undefined });
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "local");
    const tray = await openNotifications(app);
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    const retry = retryOperation(app);
    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(inboxCall).not.toHaveBeenCalled();
    runtime.resolve({ machineId: "local", ok: true, checkedAt: "after", capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications] });
    await retry;
    await renderNotifications(app);
    expect(inboxCall).toHaveBeenCalledOnce();
    expect(tray.shadowRoot?.textContent).toContain("Private 1");
  });

  it.each(["resolve-old-runtime", "reject-old-runtime"] as const)("keeps C authoritative when A and B Retry operations settle late: %s", async (outcome) => {
    const a: SessionInfo = { ...session, id: "s", cwd: "/a", firstMessage: "Session A" };
    const b: SessionInfo = { ...session, id: "s", cwd: "/b", firstMessage: "Session B" };
    const c: SessionInfo = { ...session, id: "s", cwd: "/other", firstMessage: "Session C" };
    const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
    const offline = { machineId: "remote", ok: false, checkedAt: "before", status: "offline" as const };
    const oldRuntime = deferred<MachineRuntime>();
    const currentRuntime = deferred<MachineRuntime>();
    const oldHealth = deferred<Awaited<ReturnType<typeof api.health>>>();
    const never = new Promise<never>(() => undefined);
    vi.spyOn(api, "runtime").mockReturnValueOnce(oldRuntime.promise).mockReturnValueOnce(currentRuntime.promise);
    vi.spyOn(api, "health").mockReturnValue(oldHealth.promise);
    const inboxRead = vi.spyOn(api, "notificationInbox").mockResolvedValue(snapshot([notification(1)], 1, c));
    vi.spyOn(api, "messages").mockReturnValue(never);
    vi.spyOn(api, "status").mockReturnValue(never);
    vi.spyOn(api, "streamSnapshot").mockReturnValue(never);
    vi.spyOn(api, "extensionEntries").mockReturnValue(never);
    const app = await mountRealLifecycleApp({ ...selectedState(a), machines: [machine, remote], machineStatuses: { remote: offline }, machineRuntimes: {}, selectedNotificationInbox: undefined }, true);
    Reflect.set(app, "syncMachineActivitySubscriptions", () => undefined);
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("Expected session controller");
    const socket: unknown = Reflect.get(sessions, "socket");
    if (typeof socket !== "object" || socket === null) throw new Error("Expected session socket");
    Reflect.set(socket, "connect", () => undefined);
    Reflect.set(socket, "close", () => undefined);
    void sessions.selectSession(a, { updateUrl: false });
    const tray = await openNotifications(app);
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    const retryA = retryOperation(app);
    expect(inboxRead).not.toHaveBeenCalled();

    patchAppState(app, { selectedMachine: remote });
    void sessions.selectSession(b, { updateUrl: false });
    await renderNotifications(app);
    expect(tray.shadowRoot?.textContent).toContain("Session B");
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    const retryB = retryOperation(app);
    patchAppState(app, { selectedMachine: machine });
    void sessions.selectSession(c, { updateUrl: false });
    await renderNotifications(app);
    expect(tray.shadowRoot?.textContent).toContain("Session C");
    expect(tray.shadowRoot?.textContent).not.toContain("Session B");
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-retry")?.click();
    const retryC = retryOperation(app);
    currentRuntime.resolve({ machineId: "local", ok: true, checkedAt: "current", capabilities: [PI_WEBUI_CAPABILITIES.sessionsNotifications] });
    await retryC;
    await renderNotifications(app);
    expect(inboxRead).toHaveBeenCalledExactlyOnceWith({ id: "s", cwd: "/other" }, "local");
    expect(tray.shadowRoot?.textContent).toContain("Private 1");
    const beforeLateResults = currentAppState(app);
    if (outcome === "resolve-old-runtime") {
      oldRuntime.resolve({ machineId: "local", ok: true, checkedAt: "old", capabilities: [] });
      oldHealth.reject(new Error("late B failure"));
    } else {
      oldRuntime.reject(new Error("late A failure"));
      oldHealth.resolve({ machineId: "remote", ok: true, checkedAt: "old", status: "online" });
    }
    await Promise.all([retryA, retryB]);
    await renderNotifications(app);
    const state = currentAppState(app);
    expect(state.error).toBe(beforeLateResults.error);
    expect(state.machineRuntimes["local"]?.checkedAt).toBe("current");
    expect(state.machineStatuses["remote"]?.status).toBe("offline");
    expect(tray.shadowRoot?.textContent).toContain("Session C");
    expect(tray.shadowRoot?.textContent).toContain("Private 1");
    expect(tray.shadowRoot?.querySelector("[role='alert']")).toBeNull();
    expect(inboxRead).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)("ignores A's late inbox %s after selection moves through B to C", async (outcome) => {
    const a: SessionInfo = { ...session, id: "s", cwd: "/a", firstMessage: "Session A" };
    const b: SessionInfo = { ...session, id: "s", cwd: "/b", firstMessage: "Session B" };
    const c: SessionInfo = { ...session, id: "s", cwd: "/other", firstMessage: "Session C" };
    const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
    const oldInbox = deferred<SessionNotificationInboxSnapshot>();
    const never = new Promise<never>(() => undefined);
    const inboxRead = vi.spyOn(api, "notificationInbox").mockReturnValueOnce(oldInbox.promise).mockResolvedValueOnce(snapshot([notification(2)], 1, c));
    vi.spyOn(api, "messages").mockReturnValue(never);
    vi.spyOn(api, "status").mockReturnValue(never);
    vi.spyOn(api, "streamSnapshot").mockReturnValue(never);
    vi.spyOn(api, "extensionEntries").mockReturnValue(never);
    const state = selectedState(a);
    const app = await mountRealLifecycleApp({ ...state, machines: [machine, remote], machineStatuses: { remote: { machineId: "remote", ok: false, checkedAt: "now", status: "offline" } }, selectedNotificationInbox: undefined }, true);
    Reflect.set(app, "syncMachineActivitySubscriptions", () => undefined);
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("Expected session controller");
    const socket: unknown = Reflect.get(sessions, "socket");
    if (typeof socket !== "object" || socket === null) throw new Error("Expected session socket");
    Reflect.set(socket, "connect", () => undefined);
    Reflect.set(socket, "close", () => undefined);
    void sessions.selectSession(a, { updateUrl: false });
    const tray = await openNotifications(app);
    expect(inboxRead).toHaveBeenCalledExactlyOnceWith({ id: "s", cwd: "/a" }, "local");
    patchAppState(app, { selectedMachine: remote });
    void sessions.selectSession(b, { updateUrl: false });
    await renderNotifications(app);
    expect(tray.shadowRoot?.textContent).toContain("Session B");
    expect(tray.shadowRoot?.textContent).toContain("offline");
    patchAppState(app, { selectedMachine: machine });
    void sessions.selectSession(c, { updateUrl: false });
    await vi.waitFor(() => { expect(inboxRead).toHaveBeenCalledTimes(2); });
    await appNotifications(app).refreshSelectedSession(c, "local");
    await renderNotifications(app);
    expect(tray.shadowRoot?.textContent).toContain("Session C");
    expect(tray.shadowRoot?.textContent).toContain("Private 2");
    if (outcome === "resolve") oldInbox.resolve(snapshot([notification(9)], 1, a));
    else oldInbox.reject(new Error("late inbox failure"));
    await oldInbox.promise.catch(() => undefined);
    await renderNotifications(app);
    expect(tray.shadowRoot?.textContent).toContain("Session C");
    expect(tray.shadowRoot?.textContent).toContain("Private 2");
    expect(tray.shadowRoot?.textContent).not.toContain("Private 9");
    expect(tray.shadowRoot?.querySelector("[role='alert']")).toBeNull();
    expect(inboxRead).toHaveBeenCalledTimes(2);
  });

  it("retains announcement nodes across duplicate events and opening the surface", async () => {
    const state = selectedState();
    const inbox = state.selectedNotificationInbox;
    if (inbox?.daemonInstanceId === undefined || inbox.summary === undefined) throw new Error("Expected fresh inbox fixture");
    vi.spyOn(api, "notificationInbox").mockResolvedValue({
      daemonInstanceId: inbox.daemonInstanceId,
      catalogRevision: inbox.catalogRevision,
      summary: inbox.summary,
      notifications: inbox.notifications,
      dismissThrough: inbox.dismissThrough,
    });
    const app = await mountApp({ ...state, selectedNotificationInbox: undefined });
    const controller: unknown = Reflect.get(app, "notifications");
    if (!(controller instanceof SessionNotificationController)) throw new Error("Expected notification controller");
    controller.prepareSelectedSession(session, "local");
    await controller.refreshSelectedSession(session, "local");
    await app.updateComplete;
    const polite = app.shadowRoot?.querySelector("[aria-live='polite']");
    const assertive = app.shadowRoot?.querySelector("[aria-live='assertive']");
    const first = inbox.notifications[0];
    if (first === undefined) throw new Error("Expected notification fixture");
    const addition = { ...first, id: "daemon-a:2", order: 2, severity: "error" as const, message: "private details" };
    const event = {
      type: "notifications.inbox" as const,
      daemonInstanceId: inbox.daemonInstanceId,
      catalogRevision: 2,
      summary: { ...inbox.summary, inboxRevision: 2, retainedCount: 2, highestSeverity: "error" as const },
      dismissThrough: { order: 2, overflowWatermark: 0 },
      delta: { kind: "added" as const, notification: addition },
    };
    controller.applyInboxEvent("local", event);
    await app.updateComplete;
    const announcement = assertive?.querySelector("[data-announcement-id]");
    expect(announcement).not.toBeNull();
    expect(announcement?.textContent).not.toContain("private details");
    controller.applyInboxEvent("local", event);
    await app.updateComplete;
    const bell = rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button");
    bell?.click();
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector("[aria-live='polite']")).toBe(polite);
    expect(app.shadowRoot?.querySelector("[aria-live='assertive']")).toBe(assertive);
    expect(assertive?.querySelectorAll("[data-announcement-id]")).toHaveLength(1);
    expect(assertive?.querySelector("[data-announcement-id]")).toBe(announcement);
  });

  it("preserves severity-only announcement nodes through joins, stale recovery, reconnect, and replacement", async () => {
    const first = notification(1);
    const inbox = vi.spyOn(api, "notificationInbox").mockResolvedValue(snapshot([first]));
    const app = await mountRealLifecycleApp({ ...selectedState(), selectedNotificationInbox: undefined }, true);
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "local");
    controller.observeSocketIncarnation(session, "local", 1);
    await controller.refreshSelectedSession(session, "local");
    await renderNotifications(app);
    const polite = app.shadowRoot?.querySelector("[aria-live='polite']");
    const assertive = app.shadowRoot?.querySelector("[aria-live='assertive']");
    if (polite === null || polite === undefined || assertive === null || assertive === undefined) throw new Error("Expected live regions");
    let rows = [first];
    const captured: Element[] = [];
    for (const [order, severity] of [[2, "info"], [3, "warning"], [4, "error"]] as const) {
      const row = notification(order, severity);
      rows = [row, ...rows];
      controller.applyInboxEvent("local", addition(row, rows, order), 1);
      await renderNotifications(app);
      const region = severity === "error" ? assertive : polite;
      const node = region.lastElementChild;
      if (node === null) throw new Error("Expected announcement");
      expect(node.textContent).toBe(`${severity === "info" ? "Info" : severity === "warning" ? "Warning" : "Error"} notification received.`);
      expect(node.textContent).not.toContain("Private");
      captured.push(node);
    }
    expect(polite.children).toHaveLength(2);
    expect(assertive.children).toHaveLength(1);
    controller.applyInboxEvent("local", addition(notification(4, "error"), rows, 4), 1);
    await renderNotifications(app);
    expect(assertive.children).toHaveLength(1);
    expect(assertive.firstElementChild).toBe(captured[2]);

    const joined = deferred<SessionNotificationInboxSnapshot>();
    inbox.mockReturnValueOnce(joined.promise);
    const refresh = controller.refreshSelectedSession(session, "local");
    const joinedRow = notification(5, "warning");
    rows = [joinedRow, ...rows];
    controller.applyInboxEvent("local", addition(joinedRow, rows, 5), 1);
    joined.resolve(snapshot(rows, 5));
    await refresh;
    await renderNotifications(app);
    expect(polite.children).toHaveLength(3);
    const joinedNode = polite.lastElementChild;
    expect(joinedNode?.textContent).toBe("Warning notification received.");
    expect(polite.children[0]).toBe(captured[0]);
    expect(polite.children[1]).toBe(captured[1]);

    const recovery = deferred<SessionNotificationInboxSnapshot>();
    inbox.mockReturnValueOnce(recovery.promise);
    controller.applyInboxEvent("local", addition(joinedRow, rows, 6), 1);
    await vi.waitFor(() => { expect(inbox).toHaveBeenCalledTimes(3); });
    await renderNotifications(app);
    expect(polite.lastElementChild).toBe(joinedNode);
    recovery.resolve(snapshot(rows, 6));
    await controller.refreshSelectedSession(session, "local");
    await renderNotifications(app);
    expect(polite.children).toHaveLength(3);
    expect(polite.lastElementChild).toBe(joinedNode);

    await openNotifications(app);
    setLayout(app, false);
    app.requestUpdate();
    await renderNotifications(app);
    setLayout(app, true);
    app.requestUpdate();
    await renderNotifications(app);
    expect(app.shadowRoot?.querySelector("[aria-live='polite']")).toBe(polite);
    expect(app.shadowRoot?.querySelector("[aria-live='assertive']")).toBe(assertive);
    expect(polite.firstElementChild).toBe(captured[0]);
    expect(assertive.firstElementChild).toBe(captured[2]);

    const reconnect = deferred<SessionNotificationInboxSnapshot>();
    inbox.mockReturnValueOnce(reconnect.promise);
    controller.observeSocketIncarnation(session, "local", 2);
    const reconnectRead = controller.ensurePostSubscriptionRefresh(session, "local", 2);
    controller.applyInboxEvent("local", addition(notification(6), [notification(6), ...rows], 7), 1);
    reconnect.resolve(snapshot(rows, 6));
    await reconnectRead;
    await renderNotifications(app);
    expect(polite.lastElementChild).toBe(joinedNode);
    expect(polite.children).toHaveLength(3);
    expect(assertive.firstElementChild).toBe(captured[2]);

    const replacement = deferred<SessionNotificationInboxSnapshot>();
    inbox.mockReturnValueOnce(replacement.promise);
    const replacementBase = notification(1, "info", "daemon-b");
    controller.applyInboxEvent("local", addition(replacementBase, [replacementBase], 1, session, "daemon-b"), 2);
    await vi.waitFor(() => { expect(inbox).toHaveBeenCalledTimes(5); });
    replacement.resolve(snapshot([replacementBase], 1, session, "daemon-b"));
    await controller.refreshSelectedSession(session, "local");
    await renderNotifications(app);
    expect(app.shadowRoot?.querySelector("[aria-live='polite']")).toBe(polite);
    expect(app.shadowRoot?.querySelector("[aria-live='assertive']")).toBe(assertive);
    expect(polite.children).toHaveLength(0);
    expect(assertive.children).toHaveLength(0);
    controller.applyInboxEvent("local", addition(notification(6), [notification(6), ...rows], 7), 1);
    const newRow = notification(2, "error", "daemon-b");
    controller.applyInboxEvent("local", addition(newRow, [newRow, replacementBase], 2, session, "daemon-b"), 2);
    await renderNotifications(app);
    expect(assertive.children).toHaveLength(1);
    expect(assertive.firstElementChild?.textContent).toBe("Error notification received.");
    expect(polite.children).toHaveLength(0);
    inbox.mockResolvedValueOnce(snapshot([newRow, replacementBase], 2, session, "daemon-b"));
    controller.prepareSelectedSession(session, "local");
    await controller.refreshSelectedSession(session, "local");
    await renderNotifications(app);
    expect(polite.children).toHaveLength(0);
    expect(assertive.children).toHaveLength(0);
    const afterReselection = notification(3, "warning", "daemon-b");
    controller.applyInboxEvent("local", addition(afterReselection, [afterReselection, newRow, replacementBase], 3, session, "daemon-b"));
    await renderNotifications(app);
    expect(polite.children).toHaveLength(1);
    expect(polite.firstElementChild?.textContent).toBe("Warning notification received.");
  });

  it("bounds the combined polite and assertive announcement nodes", async () => {
    const baseline = notification(1);
    vi.spyOn(api, "notificationInbox").mockResolvedValue(snapshot([baseline]));
    const app = await mountApp({ ...selectedState(), selectedNotificationInbox: undefined });
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "local");
    await controller.refreshSelectedSession(session, "local");
    await renderNotifications(app);
    let rows = [baseline];
    for (let order = 2; order <= SESSION_NOTIFICATION_LIMIT + 3; order += 1) {
      const row = notification(order, order % 2 === 0 ? "error" : "info");
      const evicted = rows.length === SESSION_NOTIFICATION_LIMIT ? rows[rows.length - 1] : undefined;
      rows = [row, ...rows].slice(0, SESSION_NOTIFICATION_LIMIT);
      const event = addition(row, rows, order);
      if (evicted !== undefined && event.delta.kind === "added") event.delta.evictedNotificationId = evicted.id;
      controller.applyInboxEvent("local", event);
      await renderNotifications(app);
    }
    const polite = app.shadowRoot?.querySelector("[aria-live='polite']");
    const assertive = app.shadowRoot?.querySelector("[aria-live='assertive']");
    expect((polite?.children.length ?? 0) + (assertive?.children.length ?? 0)).toBe(SESSION_NOTIFICATION_LIMIT);
    expect(polite?.textContent).not.toContain("Private");
    expect(assertive?.textContent).not.toContain("Private");
  });

  it.each(["row-first", "clear-first"] as const)("preserves row-first dismissal overlays when %s settles first", async (settlementOrder) => {
    const newest = notification(3);
    const oldest = notification(1);
    const rows = [newest, notification(2), oldest];
    const rowResult = deferred<SessionNotificationInboxSnapshot>();
    const clearResult = deferred<SessionNotificationInboxSnapshot>();
    vi.spyOn(api, "notificationInbox").mockResolvedValue(snapshot(rows));
    const dismiss = vi.spyOn(api, "dismissNotification").mockReturnValue(rowResult.promise);
    const clear = vi.spyOn(api, "dismissAllNotifications").mockReturnValue(clearResult.promise);
    const app = await mountRealLifecycleApp({ ...selectedState(), selectedNotificationInbox: undefined }, true);
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "local");
    await controller.refreshSelectedSession(session, "local");
    const tray = await openNotifications(app);
    rowButton(tray, "daemon-a:2").focus();
    rowButton(tray, "daemon-a:2").click();
    await renderNotifications(app);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith({ id: session.id, cwd: session.cwd }, "daemon-a", "daemon-a:2", "local");
    expect(tray.shadowRoot?.activeElement).toBe(rowButton(tray, "daemon-a:1"));
    expect(tray.shadowRoot?.querySelectorAll(".notification-row")).toHaveLength(2);
    expect(rail(app).shadowRoot?.querySelector(".notifications-button")?.getAttribute("aria-label")).toContain("2 notifications");
    const clearButton = tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-clear");
    clearButton?.focus();
    clearButton?.click();
    await renderNotifications(app);
    expect(clear).toHaveBeenCalledExactlyOnceWith({ id: session.id, cwd: session.cwd }, "daemon-a", { order: 3, overflowWatermark: 0 }, "local");
    expect(tray.shadowRoot?.querySelectorAll(".notification-row")).toHaveLength(0);
    expect(rail(app).shadowRoot?.querySelector(".notifications-button")?.getAttribute("aria-label")).toContain("0 notifications");
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector(".notification-heading"));
    const first = settlementOrder === "row-first" ? rowResult : clearResult;
    const second = settlementOrder === "row-first" ? clearResult : rowResult;
    first.resolve(settlementOrder === "row-first" ? snapshot([newest, oldest], 2) : snapshot([], 3));
    await first.promise;
    await renderNotifications(app);
    expect(tray.shadowRoot?.querySelectorAll(".notification-row")).toHaveLength(0);
    second.resolve(settlementOrder === "row-first" ? snapshot([], 3) : snapshot([newest, oldest], 2));
    await second.promise;
    await renderNotifications(app);
    expect(tray.shadowRoot?.querySelectorAll(".notification-row")).toHaveLength(0);
    expect(tray.shadowRoot?.textContent).toContain("No notifications");
  });

  it.each([
    { failure: "row", first: "row" },
    { failure: "row", first: "clear" },
    { failure: "clear", first: "row" },
    { failure: "clear", first: "clear" },
  ] as const)("reconciles a $failure failure when the $first operation settles first", async ({ failure, first }) => {
    const newest = notification(3);
    const oldest = notification(1);
    const rows = [newest, notification(2), oldest];
    const rowResult = deferred<SessionNotificationInboxSnapshot>();
    const clearResult = deferred<SessionNotificationInboxSnapshot>();
    const recovery = deferred<SessionNotificationInboxSnapshot>();
    const reads = vi.spyOn(api, "notificationInbox").mockResolvedValueOnce(snapshot(rows)).mockReturnValue(recovery.promise);
    vi.spyOn(api, "dismissNotification").mockReturnValue(rowResult.promise);
    vi.spyOn(api, "dismissAllNotifications").mockReturnValue(clearResult.promise);
    const app = await mountRealLifecycleApp({ ...selectedState(), selectedNotificationInbox: undefined }, true);
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "local");
    await controller.refreshSelectedSession(session, "local");
    const tray = await openNotifications(app);
    rowButton(tray, "daemon-a:2").focus();
    rowButton(tray, "daemon-a:2").click();
    await renderNotifications(app);
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-clear")?.click();
    await renderNotifications(app);
    const composer = document.createElement("button");
    document.body.append(composer);
    composer.focus();
    const settle = async (which: "row" | "clear"): Promise<void> => {
      const result = which === "row" ? rowResult : clearResult;
      if (which === failure) result.reject(new Error(`${which} failed`));
      else result.resolve(which === "row" ? snapshot([newest, oldest], 2) : snapshot([], 3));
      await result.promise.catch(() => undefined);
      await renderNotifications(app);
      expect(document.activeElement).toBe(composer);
    };
    await settle(first);
    await settle(first === "row" ? "clear" : "row");
    await vi.waitFor(() => { expect(reads).toHaveBeenCalledTimes(2); });
    recovery.resolve(failure === "row" ? snapshot([], 3) : snapshot([newest, oldest], 2));
    await recovery.promise;
    await renderNotifications(app);
    expect(tray.shadowRoot?.querySelectorAll(".notification-row")).toHaveLength(failure === "row" ? 0 : 2);
    expect(document.activeElement).toBe(composer);
  });

  it.each(["success", "rollback"] as const)("reenables post-watermark row dismissal after Clear all %s", async (outcome) => {
    const rows = [notification(2), notification(1)];
    const added = notification(3, "warning");
    const allResult = deferred<SessionNotificationInboxSnapshot>();
    const rowResult = deferred<SessionNotificationInboxSnapshot>();
    const reads = vi.spyOn(api, "notificationInbox").mockResolvedValueOnce(snapshot(rows)).mockResolvedValue(snapshot([added, ...rows], 2));
    const clear = vi.spyOn(api, "dismissAllNotifications").mockReturnValue(allResult.promise);
    const dismiss = vi.spyOn(api, "dismissNotification").mockReturnValue(rowResult.promise);
    const app = await mountRealLifecycleApp({ ...selectedState(), selectedNotificationInbox: undefined }, true);
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "local");
    await controller.refreshSelectedSession(session, "local");
    const tray = await openNotifications(app);
    const clearButton = tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-clear");
    clearButton?.focus();
    clearButton?.click();
    await renderNotifications(app);
    expect(clear).toHaveBeenCalledExactlyOnceWith({ id: session.id, cwd: session.cwd }, "daemon-a", { order: 2, overflowWatermark: 0 }, "local");
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector(".notification-heading"));
    controller.applyInboxEvent("local", addition(added, [added, ...rows], 2));
    await renderNotifications(app);
    expect(tray.shadowRoot?.querySelectorAll(".notification-row")).toHaveLength(1);
    expect(rail(app).shadowRoot?.querySelector(".notifications-button")?.getAttribute("aria-label")).toContain("1 notifications");
    expect(rowButton(tray, added.id).disabled).toBe(true);
    rowButton(tray, added.id).click();
    await controller.dismissNotification(added.id);
    expect(dismiss).not.toHaveBeenCalled();
    if (outcome === "success") allResult.resolve(snapshot([added], 3));
    else allResult.reject(new Error("clear failed"));
    await allResult.promise.catch(() => undefined);
    if (outcome === "rollback") await vi.waitFor(() => { expect(reads).toHaveBeenCalledTimes(2); });
    await renderNotifications(app);
    await vi.waitFor(() => { expect(rowButton(tray, added.id).disabled).toBe(false); });
    const composer = document.createElement("button");
    document.body.append(composer);
    rowButton(tray, added.id).focus();
    rowButton(tray, added.id).click();
    expect(dismiss).toHaveBeenCalledExactlyOnceWith({ id: session.id, cwd: session.cwd }, "daemon-a", added.id, "local");
    composer.focus();
    if (outcome === "success") rowResult.resolve(snapshot([], 4));
    else rowResult.reject(new Error("row failed"));
    await rowResult.promise.catch(() => undefined);
    if (outcome === "rollback") await vi.waitFor(() => { expect(reads).toHaveBeenCalledTimes(3); });
    await renderNotifications(app);
    expect(document.activeElement).toBe(composer);
  });

  it.each([
    { removed: 3, expected: 2 },
    { removed: 2, expected: 1 },
    { removed: 1, expected: 2 },
  ])("moves focus from row $removed to row $expected on optimistic dismissal", async ({ removed, expected }) => {
    const rows = [notification(3), notification(2), notification(1)];
    const pending = deferred<SessionNotificationInboxSnapshot>();
    vi.spyOn(api, "notificationInbox").mockResolvedValue(snapshot(rows));
    vi.spyOn(api, "dismissNotification").mockReturnValue(pending.promise);
    const app = await mountRealLifecycleApp({ ...selectedState(), selectedNotificationInbox: undefined }, true);
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "local");
    await controller.refreshSelectedSession(session, "local");
    const tray = await openNotifications(app);
    rowButton(tray, `daemon-a:${String(removed)}`).focus();
    rowButton(tray, `daemon-a:${String(removed)}`).click();
    await renderNotifications(app);
    expect(tray.shadowRoot?.activeElement).toBe(rowButton(tray, `daemon-a:${String(expected)}`));
    pending.resolve(snapshot(rows.filter((row) => row.order !== removed), 2));
    await pending.promise;
  });

  it("focuses the heading after the last row is optimistically dismissed", async () => {
    const pending = deferred<SessionNotificationInboxSnapshot>();
    vi.spyOn(api, "notificationInbox").mockResolvedValue(snapshot([notification(1)]));
    vi.spyOn(api, "dismissNotification").mockReturnValue(pending.promise);
    const app = await mountRealLifecycleApp({ ...selectedState(), selectedNotificationInbox: undefined }, true);
    const controller = appNotifications(app);
    controller.prepareSelectedSession(session, "local");
    await controller.refreshSelectedSession(session, "local");
    const tray = await openNotifications(app);
    rowButton(tray, "daemon-a:1").focus();
    rowButton(tray, "daemon-a:1").click();
    await renderNotifications(app);
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector(".notification-heading"));
    expect(tray.shadowRoot?.textContent).toContain("No notifications");
    pending.resolve(snapshot([], 2));
    await pending.promise;
  });

  it("preserves outside pointer and newer modal focus when closing the desktop flyout", async () => {
    const app = await mountRealLifecycleApp(selectedState(), true);
    const tray = await openNotifications(app);
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector(".notification-heading"));
    const destination = document.createElement("button");
    document.body.append(destination);
    const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true });
    destination.dispatchEvent(pointer);
    destination.focus();
    await renderNotifications(app);
    expect(pointer.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(destination);
    expect(app.shadowRoot?.querySelector<HTMLElement>(".notification-surface")?.hidden).toBe(true);
    await openNotifications(app);
    Reflect.set(app, "settingsSection", "general");
    destination.focus();
    await renderNotifications(app);
    expect(app.shadowRoot?.querySelector<HTMLElement>(".notification-surface")?.hidden).toBe(true);
    expect(document.activeElement).toBe(destination);
  });

  it("registers capture listeners through the real lifecycle and restores isolation on disconnect", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const app = await mountRealLifecycleApp(selectedState(), false);
    const shell = app.shadowRoot?.querySelector<HTMLElement>(".shell");
    if (shell === null || shell === undefined) throw new Error("Expected shell");
    shell.inert = true;
    shell.setAttribute("aria-hidden", "previous");
    const launcher = contextBar(app).shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button");
    if (launcher === null || launcher === undefined) throw new Error("Expected launcher");
    launcher.click();
    await renderNotifications(app);
    rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button")?.click();
    const tray = await renderNotifications(app);
    expect(shell.inert).toBe(true);
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    const heading = tray.shadowRoot?.querySelector<HTMLElement>(".notification-heading");
    const close = tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-close");
    if (heading === null || heading === undefined || close === null || close === undefined) throw new Error("Expected sheet controls");
    heading.focus();
    const backwards = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true, composed: true });
    heading.dispatchEvent(backwards);
    expect(backwards.defaultPrevented).toBe(true);
    expect(tray.shadowRoot?.activeElement).toBe(rowButton(tray, "daemon-a:1"));
    rowButton(tray, "daemon-a:1").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, composed: true }));
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector(".notification-clear"));
    const speech = { cancelSpeechInput: vi.fn(() => true) };
    Reflect.set(app, "promptEditor", speech);
    const shortcut = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true, composed: true });
    document.body.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true });
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-close")?.dispatchEvent(escape);
    await renderNotifications(app);
    expect(escape.defaultPrevented).toBe(true);
    expect(speech.cancelSpeechInput).not.toHaveBeenCalled();
    expect(shell.inert).toBe(true);
    expect(shell.getAttribute("aria-hidden")).toBe("previous");

    launcher.click();
    await renderNotifications(app);
    rail(app).shadowRoot?.querySelector<HTMLButtonElement>(".notifications-button")?.click();
    await renderNotifications(app);
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    app.remove();
    expect(shell.inert).toBe(true);
    expect(shell.getAttribute("aria-hidden")).toBe("previous");
    const keyRegistration = added.mock.calls.find(([type]) => type === "keydown");
    if (keyRegistration === undefined) throw new Error("Expected keydown registration");
    expect(removed.mock.calls.some(([type, handler, options]) => type === "keydown" && handler === keyRegistration[1] && options === keyRegistration[2])).toBe(true);
    for (const type of ["pointerdown", "focusin"]) {
      const registration = added.mock.calls.find(([eventType]) => eventType === type);
      if (registration === undefined) throw new Error(`Expected ${type} registration`);
      expect(removed.mock.calls.some(([eventType, handler, options]) => eventType === type && handler === registration[1] && options === registration[2])).toBe(true);
    }
    const afterDisconnect = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(afterDisconnect);
    expect(afterDisconnect.defaultPrevented).toBe(false);
  });

  it("removes the chat-owned inbox tray, collapse controls, and duplicate live regions", async () => {
    const app = await mountApp(selectedState());
    const chat = app.shadowRoot?.querySelector("chat-view");
    expect(chat?.shadowRoot?.querySelector(".notification-tray")).toBeNull();
    expect(chat?.shadowRoot?.querySelector(".notification-toggle")).toBeNull();
    expect(chat?.shadowRoot?.querySelector(".notification-live")).toBeNull();
  });
});
