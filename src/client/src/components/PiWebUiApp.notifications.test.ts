// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { MachineRuntime } from "../../../shared/apiTypes";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/apiTypes";
import { api, type Machine, type SessionInfo } from "../api";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
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

  it("removes the chat-owned inbox tray, collapse controls, and duplicate live regions", async () => {
    const app = await mountApp(selectedState());
    const chat = app.shadowRoot?.querySelector("chat-view");
    expect(chat?.shadowRoot?.querySelector(".notification-tray")).toBeNull();
    expect(chat?.shadowRoot?.querySelector(".notification-toggle")).toBeNull();
    expect(chat?.shadowRoot?.querySelector(".notification-live")).toBeNull();
  });
});
