// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationPresentation } from "../notificationPresentation";
import type { SelectedSessionNotificationView } from "../sessionNotifications";
import { SessionNotificationTray } from "./SessionNotificationTray";

const target = { machineId: "local", sessionId: "session-1", cwd: "/repo" };

function freshView(total: number): SelectedSessionNotificationView {
  return {
    ...target,
    daemonInstanceId: "daemon-a",
    notifications: total === 0 ? [] : [{
      id: "daemon-a:1",
      order: 1,
      receivedAt: "2026-11-18T12:00:00.000Z",
      severity: "warning",
      message: "Build failed",
      truncated: true,
    }],
    retainedCount: total === 0 ? 0 : 1,
    discardedCount: total > 1 ? total - 1 : 0,
    ...(total === 0 ? {} : { highestSeverity: "warning" as const }),
    dismissThrough: { order: total === 0 ? 0 : 1, overflowWatermark: total > 1 ? total - 1 : 0 },
    pendingDismissedIds: new Set(),
    dismissAllPending: false,
    announcements: [],
  };
}

function freshViewWithRows(): SelectedSessionNotificationView {
  const first = {
    id: "daemon-a:1",
    order: 1,
    receivedAt: "2026-11-18T12:00:00.000Z",
    severity: "warning" as const,
    message: "First failure",
    truncated: false,
  };
  const second = { ...first, id: "daemon-a:2", order: 2, message: "Second failure" };
  return {
    ...target,
    daemonInstanceId: "daemon-a",
    notifications: [first, second],
    retainedCount: 2,
    discardedCount: 0,
    highestSeverity: "warning",
    dismissThrough: { order: 0, overflowWatermark: 0 },
    pendingDismissedIds: new Set(),
    dismissAllPending: false,
    announcements: [],
  };
}
function presentation(kind: NotificationPresentation["kind"]): NotificationPresentation {
  if (kind === "ineligible") return { kind };
  if (kind === "unsupported") return { kind, target };
  if (kind === "fresh") return { kind, target, view: freshView(0), operation: "idle" };
  return { kind, target, operation: kind === "loading" ? "loading-inbox" : "idle" };
}


async function mount(configure: (tray: SessionNotificationTray) => void): Promise<SessionNotificationTray> {
  const tray = new SessionNotificationTray();
  configure(tray);
  document.body.append(tray);
  await tray.updateComplete;
  return tray;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("SessionNotificationTray", () => {
  it("renders every availability state without owning inbox requests", async () => {
    for (const kind of ["ineligible", "offline", "capability-unavailable", "unsupported", "loading", "unavailable"] as const) {
      const tray = await mount((instance) => {
        instance.presentation = presentation(kind);
        instance.sessionTitle = "Build session";
        instance.open = true;
      });
      expect(tray.shadowRoot?.textContent).toContain(kind === "ineligible" ? "Notifications" : kind === "unsupported" ? "does not support" : kind === "offline" ? "offline" : kind === "loading" ? "Loading" : kind === "capability-unavailable" ? "support" : "unavailable");
      expect(tray.shadowRoot?.querySelector("button.notification-retry") !== null).toBe(!["ineligible", "unsupported", "loading"].includes(kind));
    }
  });

  it("renders fresh rows, overflow, truncation, empty state, and action callbacks", async () => {
    const onDismiss = vi.fn();
    const onDismissAll = vi.fn();
    const onClose = vi.fn();
    const tray = await mount((instance) => {
      instance.presentation = {
        kind: "fresh",
        target,
        view: freshView(103),
        operation: "idle",
      };
      instance.sessionTitle = "Build session";
      instance.open = true;
      instance.onDismiss = onDismiss;
      instance.onDismissAll = onDismissAll;
      instance.onClose = onClose;
    });

    expect(tray.shadowRoot?.querySelector(".notification-heading")?.textContent).toContain("Build session");
    expect(tray.shadowRoot?.textContent).toContain("103");
    expect(tray.shadowRoot?.textContent).toContain("older notifications not shown");
    expect(tray.shadowRoot?.textContent).toContain("Message truncated at 8 KiB.");
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-row-dismiss")?.click();
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-clear")?.click();
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-close")?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onDismissAll).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    tray.presentation = { kind: "fresh", target, view: freshView(0), operation: "idle" };
    await tray.updateComplete;
    expect(tray.shadowRoot?.textContent).toContain("No notifications");
  });

  it("honors an app focus intent when the focused dismiss control disappears", async () => {
    const tray = await mount((instance) => {
      instance.presentation = { kind: "fresh", target, view: freshViewWithRows(), operation: "idle" };
      instance.open = true;
      instance.onDismiss = vi.fn();
    });
    const firstDismiss = tray.shadowRoot?.querySelectorAll<HTMLButtonElement>(".notification-row-dismiss")[0];
    const secondDismiss = tray.shadowRoot?.querySelectorAll<HTMLButtonElement>(".notification-row-dismiss")[1];
    if (firstDismiss === undefined || secondDismiss === undefined) throw new Error("Expected two dismiss controls");
    firstDismiss.focus();
    tray.onValidateFocusIntent = () => true;
    tray.focusIntent = {
      token: 1,
      surfaceGeneration: 1,
      selectionGeneration: 1,
      target,
      destination: "equivalent-control",
      control: { role: "dismiss", notificationId: "daemon-a:2" },
    };
    const updatedView = freshViewWithRows();
    updatedView.notifications = updatedView.notifications.slice(1);
    updatedView.retainedCount = 1;
    tray.presentation = { kind: "fresh", target, view: updatedView, operation: "idle" };
    await tray.updateComplete;
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector("button[data-notification-id='daemon-a:2']"));
  });

  it("moves focus to the heading when availability removes the focused control", async () => {
    const tray = await mount((instance) => {
      instance.presentation = { kind: "fresh", target, view: freshView(1), operation: "idle" };
      instance.open = true;
      instance.onDismiss = vi.fn();
    });
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-row-dismiss")?.focus();
    tray.presentation = { kind: "offline", target, operation: "idle" };
    await tray.updateComplete;
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector("[data-notification-focus='heading']"));
  });

  it("cycles sheet Tab and Shift+Tab through enabled controls", async () => {
    const tray = await mount((instance) => {
      instance.presentation = { kind: "fresh", target, view: freshView(1), operation: "idle" };
      instance.mode = "sheet";
      instance.open = true;
      instance.onDismiss = vi.fn();
      instance.onDismissAll = vi.fn();
    });
    const clear = tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-clear");
    const last = tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-row-dismiss");
    if (clear === null || clear === undefined || last === null || last === undefined) throw new Error("Expected sheet controls");
    last.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(tray.shadowRoot?.activeElement).toBe(clear);
    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    clear.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(tray.shadowRoot?.activeElement).toBe(last);
  });

  it("focuses the requested heading only while the tray is open", async () => {
    const tray = await mount((instance) => {
      instance.presentation = { kind: "fresh", target, view: freshView(1), operation: "idle" };
      instance.open = true;
    });
    tray.focusIntent = { token: 1, surfaceGeneration: 1, selectionGeneration: 1, target, destination: "heading" };
    await tray.updateComplete;
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector("[data-notification-focus='heading']"));
    tray.shadowRoot?.querySelector<HTMLButtonElement>(".notification-close")?.focus();
    tray.open = false;
    tray.focusIntent = { ...tray.focusIntent, token: 2 };
    await tray.updateComplete;
    expect(tray.shadowRoot?.activeElement).toBe(tray.shadowRoot?.querySelector(".notification-close"));
  });
});
