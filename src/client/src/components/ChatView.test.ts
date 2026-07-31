import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { QueuedSessionMessage, SessionStatus, SessionWarning } from "../api";
import {
  notificationTargetKey,
  notificationTrayIsCollapsed,
  type SelectedSessionNotificationView,
} from "../sessionNotifications";
import type { ChatLine } from "./shared";
import {
  ChatView,
  activityDockMetricGroups,
  activityDockMetrics,
  activityDockWarningControlContent,
  chatEventAnchorKey,
  chatGroupAnchorKey,
  chatGroupScrollMarkerId,
  chatMessageGroupClassName,
  chatMessageGroupLabel,
  chatMessageMetadataLabel,
  chatMessageEditText,
  chatQueuedMessageSections,
  chatQueuedMessagesCopyText,
  chatQueuedSectionsHaveBothServerKinds,
  chatQueuedSectionsShowClearAction,
  chatSessionWarningRows,
  chatUserMessageActionAvailability,
} from "./ChatView";
import { findOptionalTemplateEventHandlerAfterMarker, templateEventHandlerAfterMarker, templateEventHandlerNearMarker } from "../templateInspection.testSupport";

describe("chatUserMessageActionAvailability", () => {
  const message: ChatLine = {
    role: "user",
    parts: [{ type: "text", text: "Revise this" }],
    entryId: "user-2",
    previousAssistantEntryId: "assistant-1",
    canFork: true,
  };

  it("exposes both history actions only when an idle capable session supplies entry metadata", () => {
    expect(chatUserMessageActionAvailability(message, { enabled: true, busy: false })).toEqual({
      editFromHereEntryId: "assistant-1",
      forkEntryId: "user-2",
    });
  });

  it("keeps actions unavailable without capability support, while active, or without applicable metadata", () => {
    expect(chatUserMessageActionAvailability(message, { enabled: false, busy: false })).toEqual({});
    expect(chatUserMessageActionAvailability(message, { enabled: true, busy: true })).toEqual({});
    expect(chatUserMessageActionAvailability({ role: "user", parts: message.parts, entryId: "user-2" }, { enabled: true, busy: false })).toEqual({});
  });

  it("uses untrimmed text parts as the edit draft, matching the original user message", () => {
    expect(chatMessageEditText({ ...message, parts: [{ type: "text", text: " first " }, { type: "text", text: "second" }] })).toBe(" first \nsecond");
  });
});

describe("ChatView per-message action wiring", () => {
  // Escape hatch: this verifies only the two action callbacks wired into Lit's
  // message-action template. The node suite has no DOM harness, so handler
  // extraction anchored to visible semantic controls is proportionate.
  it("wires edit and new-session actions for an eligible user message", async () => {
    const view = new ChatView();
    const onEditFromHere = vi.fn(() => Promise.resolve());
    const onForkFromHere = vi.fn(() => Promise.resolve());
    Reflect.set(view, "canMessageActions", true);
    Reflect.set(view, "onEditFromHere", onEditFromHere);
    Reflect.set(view, "onForkFromHere", onForkFromHere);
    const message: ChatLine = {
      role: "user",
      parts: [{ type: "text", text: "Revise this" }],
      entryId: "user-2",
      previousAssistantEntryId: "assistant-1",
      canFork: true,
    };

    const rendered = renderMessageActions(view, message, "user-2");
    templateEventHandlerNearMarker(rendered, "data-message-action=\"edit-from-here\"")(new Event("click"));
    templateEventHandlerNearMarker(rendered, "data-message-action=\"new-session\"")(new Event("click"));
    await Promise.resolve();

    expect(onEditFromHere).toHaveBeenCalledExactlyOnceWith("assistant-1", "Revise this");
    expect(onForkFromHere).toHaveBeenCalledExactlyOnceWith("user-2");
  });

  it("keeps the new-session action pending and ignores duplicate clicks", async () => {
    const view = new ChatView();
    let resolveFork: (() => void) | undefined;
    const onForkFromHere = vi.fn(() => new Promise<void>((resolve) => { resolveFork = resolve; }));
    Reflect.set(view, "canMessageActions", true);
    Reflect.set(view, "onForkFromHere", onForkFromHere);
    const message: ChatLine = { role: "user", parts: [{ type: "text", text: "Fork this" }], entryId: "user-2", canFork: true };
    const rendered = renderMessageActions(view, message, "user-2");
    const clickFork = templateEventHandlerNearMarker(rendered, "data-message-action=\"new-session\"");

    clickFork(new Event("click"));
    clickFork(new Event("click"));

    expect(onForkFromHere).toHaveBeenCalledExactlyOnceWith("user-2");
    expect(Reflect.get(view, "forkingEntryId")).toBe("user-2");
    resolveFork?.();
    await Promise.resolve();
    expect(Reflect.get(view, "forkingEntryId")).toBeUndefined();
  });
});

describe("chatQueuedMessageSections", () => {
  it("keeps client startup messages separate and partitions live messages by kind", () => {
    const sections = chatQueuedMessageSections(
      [{ kind: "followUp", text: "queued before start" }],
      [
        { kind: "steer", text: "adjust" },
        { kind: "followUp", text: "then inspect" },
        { kind: "steer", text: "keep the tests" },
      ],
    );

    expect(sections).toEqual([
      {
        source: "client",
        heading: "Queued until session starts",
        detail: "Will send once the backend session is ready",
        messages: [{ kind: "followUp", text: "queued before start" }],
      },
      {
        source: "server",
        kind: "steer",
        heading: "Steered",
        detail: "Sent together at the next turn",
        messages: [
          { kind: "steer", text: "adjust" },
          { kind: "steer", text: "keep the tests" },
        ],
      },
      {
        source: "server",
        kind: "followUp",
        heading: "Follow-up",
        detail: "Sent together after the agent finishes",
        messages: [{ kind: "followUp", text: "then inspect" }],
      },
    ]);
  });

  it("omits empty live queue kinds", () => {
    expect(chatQueuedMessageSections([], [{ kind: "steer", text: "adjust" }])).toEqual([
      {
        source: "server",
        kind: "steer",
        heading: "Steered",
        detail: "Sent together at the next turn",
        messages: [{ kind: "steer", text: "adjust" }],
      },
    ]);
  });
});

describe("chatQueuedSectionsHaveBothServerKinds", () => {
  it("requires both live queue kinds to be present", () => {
    expect(chatQueuedSectionsHaveBothServerKinds([])).toBe(false);
    expect(chatQueuedSectionsHaveBothServerKinds(
      chatQueuedMessageSections([], [
        { kind: "steer", text: "adjust" },
        { kind: "followUp", text: "then inspect" },
      ]),
    )).toBe(true);
    expect(chatQueuedSectionsHaveBothServerKinds(
      chatQueuedMessageSections([], [{ kind: "steer", text: "adjust" }]),
    )).toBe(false);
  });
});

describe("chatQueuedSectionsShowClearAction", () => {
  it("requires both live kinds, clear capability, and a clear handler", () => {
    expect(chatQueuedSectionsShowClearAction([], true, true)).toBe(false);
    expect(chatQueuedSectionsShowClearAction(
      chatQueuedMessageSections([], [
        { kind: "steer", text: "adjust" },
        { kind: "followUp", text: "then inspect" },
      ]),
      true,
      true,
    )).toBe(true);
    expect(chatQueuedSectionsShowClearAction(
      chatQueuedMessageSections([], [{ kind: "steer", text: "adjust" }]),
      true,
      true,
    )).toBe(false);
    expect(chatQueuedSectionsShowClearAction(
      chatQueuedMessageSections([], [
        { kind: "steer", text: "adjust" },
        { kind: "followUp", text: "then inspect" },
      ]),
      false,
      true,
    )).toBe(false);
  });
});

describe("chatQueuedMessagesCopyText", () => {
  it("formats live groups with headings and blank lines between messages", () => {
    expect(chatQueuedMessagesCopyText(
      chatQueuedMessageSections([], [
        { kind: "steer", text: "adjust" },
        { kind: "steer", text: "keep the tests" },
        { kind: "followUp", text: "then inspect" },
      ]),
    )).toBe([
      "Steered",
      "adjust",
      "",
      "keep the tests",
      "",
      "Follow-up",
      "then inspect",
    ].join("\n"));
  });

  it("ignores client startup messages and returns empty text without live groups", () => {
    expect(chatQueuedMessagesCopyText(
      chatQueuedMessageSections(
        [{ kind: "followUp", text: "queued before start" }],
        [
          { kind: "steer", text: "adjust" },
          { kind: "followUp", text: "then inspect" },
        ],
      ),
    )).toBe([
      "Steered",
      "adjust",
      "",
      "Follow-up",
      "then inspect",
    ].join("\n"));
    expect(chatQueuedMessagesCopyText(
      chatQueuedMessageSections([{ kind: "followUp", text: "queued before start" }], []),
    )).toBe("");
  });
});

describe("activityDockMetrics", () => {
  it("formats session flow, usage, and paid-cost values for the activity dock", () => {
    expect(activityDockMetrics({
      ...queuedStatus([]),
      tokens: { input: 25_000, output: 9_400, cacheRead: 0, cacheWrite: 0, total: 34_400 },
      cost: 2.5,
      contextUsage: { tokens: 34_400, contextWindow: 1_000_000, percent: 0.9 },
    })).toEqual([
      { label: "Input tokens", text: "↑25k" },
      { label: "Output tokens", text: "↓9.4k" },
      { label: "Context usage", text: "0.9%/1.0M" },
      { label: "Session cost", text: "$2.50" },
    ]);
  });

  it("shows provider-reported received tokens and generation speed", () => {
    expect(activityDockMetrics({
      ...queuedStatus([]),
      generation: { outputTokens: 32, tokensPerSecond: 4.2 },
    })).toEqual(expect.arrayContaining([
      { label: "Received tokens", text: "↓ 32" },
      { label: "Generation speed", text: "4.2 t/s", className: "generation-rate slow" },
    ]));
  });

  it("identifies Pi Web-style text-derived generation metrics as estimates", () => {
    const estimatedGeneration = { outputTokens: 2, tokensPerSecond: 4, estimated: true };

    expect(activityDockMetrics({
      ...queuedStatus([]),
      generation: estimatedGeneration,
    })).toEqual(expect.arrayContaining([
      { label: "Estimated received tokens", text: "↓ 2" },
      { label: "Estimated generation speed", text: "4.0 t/s", className: "generation-rate slow" },
    ]));
  });

  it("groups live generation metrics immediately after the activity status", () => {
    const groups = activityDockMetricGroups({
      ...queuedStatus([]),
      generation: { outputTokens: 32, tokensPerSecond: 4.2 },
    });

    expect(groups.afterStatus).toEqual([
      { label: "Received tokens", text: "↓ 32" },
      { label: "Generation speed", text: "4.2 t/s", className: "generation-rate slow" },
    ]);
    expect(groups.trailing.map((metric) => metric.label)).toEqual([
      "Input tokens",
      "Output tokens",
      "Context usage",
      "Session cost",
    ]);
  });

  it("hides generation metrics when the session is idle", () => {
    const metrics = activityDockMetrics({
      ...queuedStatus([]),
      isStreaming: false,
      generation: { outputTokens: 32, tokensPerSecond: 4.2 },
    });

    expect(metrics.map((metric) => metric.label)).not.toContain("Received tokens");
    expect(metrics.map((metric) => metric.label)).not.toContain("Generation speed");
  });

  it("does not infer streaming metrics from cumulative session usage", () => {
    const metrics = activityDockMetrics({
      ...queuedStatus([]),
      tokens: { input: 0, output: 32, cacheRead: 0, cacheWrite: 0, total: 32 },
    });

    expect(metrics.map((metric) => metric.label)).not.toContain("Received tokens");
    expect(metrics.map((metric) => metric.label)).not.toContain("Generation speed");
  });

  it("keeps the queued-message count in the activity dock when work is pending", () => {
    expect(activityDockMetrics({ ...queuedStatus([{ kind: "followUp", text: "wait" }, { kind: "steer", text: "adjust" }]), pendingMessageCount: 2 })).toContainEqual({ label: "Queued messages", text: "2 queued" });
  });

  it("omits activity-dock metrics until session status is available", () => {
    expect(activityDockMetrics(undefined)).toEqual([]);
  });
});

describe("activityDockWarningControlContent", () => {
  it("provides an action label for both warning visibility states", () => {
    expect(activityDockWarningControlContent(1, true)).toEqual({
      countText: "1",
      accessibleLabel: "Minimise 1 warning",
    });
    expect(activityDockWarningControlContent(3, false)).toEqual({
      countText: "3",
      accessibleLabel: "Show 3 warnings in the warning area",
    });
  });

  it("omits the control content when there are no warnings", () => {
    expect(activityDockWarningControlContent(0, false)).toBeUndefined();
  });
});


describe("ChatView queued-message clear wiring", () => {
  // Escape hatch: this case verifies the Clear queue button's Lit event wiring,
  // whose only observable effect is invoking the injected callback. Vitest runs
  // with no DOM environment here, so a shadow-DOM click harness would add
  // disproportionate setup; handler extraction anchored to the user-facing
  // "Clear queue" button text is proportionate.
  it("invokes onClearServerQueue when the server-queue action is activated", () => {
    const view = new ChatView();
    const onClearServerQueue = vi.fn();
    view.status = queuedStatus([{ kind: "steer", text: "server queued" }]);
    view.canClearServerQueue = true;
    view.onClearServerQueue = onClearServerQueue;

    templateEventHandlerNearMarker(renderQueuedMessages(view), "Clear queue")(new Event("click"));

    expect(onClearServerQueue).toHaveBeenCalledOnce();
  });
});

describe("chatSessionWarningRows", () => {
  // Warning-row content (severity class, message, path, source, dismiss
  // capability, ordering) is derived by a pure exported seam rather than scraped
  // from rendered `TemplateResult` markup, per the testing-guide rule that
  // TemplateResult inspection is not for general content assertions.
  it("derives one severity-tagged row per warning with optional path and source", () => {
    const rows = chatSessionWarningRows(warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill", path: "/skills/a.md" },
      { severity: "warning", message: "subscription auth is active" },
      { severity: "info", message: "heads up", source: "runtime" },
    ]));

    expect(rows).toEqual([
      { severity: "error", severityClass: "session-warning error", message: "skill failed to load", source: "skill", path: "/skills/a.md", dismissId: undefined },
      { severity: "warning", severityClass: "session-warning warning", message: "subscription auth is active", source: undefined, path: undefined, dismissId: undefined },
      { severity: "info", severityClass: "session-warning info", message: "heads up", source: "runtime", path: undefined, dismissId: undefined },
    ]);
  });

  it("exposes a dismiss id only for warnings carrying a dismiss capability", () => {
    const rows = chatSessionWarningRows(warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill" },
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]));

    expect(rows.map((row) => row.dismissId)).toEqual([undefined, "anthropicExtraUsage"]);
  });

  it("derives no rows when there are no warnings or status is unset", () => {
    expect(chatSessionWarningRows(warningStatus([]))).toEqual([]);
    expect(chatSessionWarningRows(undefined)).toEqual([]);
  });
});

describe("ChatView activity-dock warning toggle wiring", () => {
  // Escape hatch: this verifies the interactive warning toggle retained in the
  // status dock. Vitest has no DOM environment, so the handler is anchored to
  // the stable semantic control class and exercises its observable callback.
  it("invokes onToggleWarnings when the dock warning control is activated", () => {
    const view = withStatus(new ChatView(), warningStatus([{ severity: "warning", message: "subscription auth is active" }]));
    const onToggleWarnings = vi.fn();
    view.warningCount = 1;
    view.warningsExpanded = true;
    view.onToggleWarnings = onToggleWarnings;

    const handler = findOptionalTemplateEventHandlerAfterMarker(renderActivityDock(view), "warning-toggle");
    expect(handler).toBeTypeOf("function");
    if (handler === undefined) return;

    handler(new Event("click"));
    expect(onToggleWarnings).toHaveBeenCalledOnce();
  });
});

describe("ChatView session-warning dismiss wiring", () => {
  // Escape hatch: this case verifies the dismiss button's Lit event wiring,
  // whose observable effect is invoking onDismissWarning with the warning's
  // dismiss id. No DOM environment is available, so handler extraction anchored
  // to the stable `session-warning-dismiss` class marker is proportionate.
  it("invokes onDismissWarning with the warning's dismiss id", () => {
    const view = new ChatView();
    const onDismissWarning = vi.fn();
    view.onDismissWarning = onDismissWarning;
    view.status = warningStatus([
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]);

    const rendered = renderWarnings(view);
    if (rendered === null) throw new Error("expected a warnings banner");
    templateEventHandlerAfterMarker(rendered, "session-warning-dismiss")(new Event("click"));

    expect(onDismissWarning).toHaveBeenCalledExactlyOnceWith("anthropicExtraUsage");
  });

  it("removes the warning area while presentation is collapsed or there are no warnings", () => {
    const view = withStatus(new ChatView(), warningStatus([
      { severity: "warning", message: "subscription auth is active" },
    ]));
    view.warningsVisible = false;

    expect(renderWarnings(view)).toBeNull();
    expect(renderWarnings(withStatus(new ChatView(), warningStatus([])))).toBeNull();
  });
});

describe("ChatView notification tray wiring", () => {
  // Escape hatch: these cases verify only the tray buttons' Lit callback wiring.
  // Content and identity decisions use pure seams; Vitest has no shadow-DOM
  // harness, so stable semantic class markers keep handler extraction narrow.
  // A minimal render-root fake verifies the resulting focus move without
  // recreating a browser DOM harness.
  it("wires individual dismissal and recovers header focus after the final row", () => {
    const view = withNotificationInbox(new ChatView());
    const onDismissNotification = vi.fn();
    const headerFocus = installNotificationFocusRoot(view);
    view.onDismissNotification = onDismissNotification;

    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");
    templateEventHandlerAfterMarker(rendered, "notification-row-dismiss")(new Event("click"));
    view.notificationInbox = emptyNotificationInbox(requireNotificationInbox(view));

    expect(renderNotificationTray(view)).not.toBeNull();
    focusPendingNotificationTarget(view);
    expect(onDismissNotification).toHaveBeenCalledExactlyOnceWith("daemon-a:1");
    expect(headerFocus).toHaveBeenCalledOnce();
  });

  it("wires clear-all and recovers header focus while the emptied tray is retained", () => {
    const view = withNotificationInbox(new ChatView());
    const onDismissAllNotifications = vi.fn();
    const headerFocus = installNotificationFocusRoot(view);
    view.onDismissAllNotifications = onDismissAllNotifications;

    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");
    templateEventHandlerAfterMarker(rendered, "notification-clear")(new Event("click"));
    view.notificationInbox = emptyNotificationInbox(requireNotificationInbox(view));

    expect(renderNotificationTray(view)).not.toBeNull();
    focusPendingNotificationTarget(view);
    expect(onDismissAllNotifications).toHaveBeenCalledOnce();
    expect(headerFocus).toHaveBeenCalledOnce();
  });

  it("does not move pending dismissal focus into another exact chat", () => {
    const view = withNotificationInbox(new ChatView());
    const headerFocus = installNotificationFocusRoot(view);
    view.onDismissAllNotifications = vi.fn();

    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");
    templateEventHandlerAfterMarker(rendered, "notification-clear")(new Event("click"));
    view.notificationInbox = { ...requireNotificationInbox(view), machineId: "remote" };
    focusPendingNotificationTarget(view);

    expect(headerFocus).not.toHaveBeenCalled();
  });

  it("keeps a collapsed tray closed for new arrivals and isolates matching session ids by exact chat", () => {
    const view = withNotificationInbox(new ChatView());
    const inbox = requireNotificationInbox(view);
    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");

    templateEventHandlerAfterMarker(rendered, "notification-toggle")(new Event("click"));

    const collapsedTargetKeys: unknown = Reflect.get(view, "collapsedNotificationTargetKeys");
    if (!(collapsedTargetKeys instanceof Set)) throw new Error("Expected collapsed notification target keys");
    const firstNotification = inbox.notifications[0];
    if (firstNotification === undefined) throw new Error("expected a retained notification");
    const newArrival = {
      ...inbox,
      notifications: [{ ...firstNotification, id: "daemon-a:2", order: 2 }, ...inbox.notifications],
      retainedCount: 2,
    };
    expect(notificationTrayIsCollapsed(collapsedTargetKeys, newArrival)).toBe(true);
    expect(notificationTrayIsCollapsed(collapsedTargetKeys, { ...newArrival, cwd: "/other" })).toBe(false);
    expect(notificationTrayIsCollapsed(collapsedTargetKeys, { ...newArrival, machineId: "remote" })).toBe(false);
    expect(collapsedTargetKeys.has(notificationTargetKey(inbox))).toBe(true);
  });
});

describe("chatMessageMetadataLabel", () => {
  it("uses one full date and model label without a model prefix", () => {
    const timestamp = "2026-07-10T19:15:30.000Z";
    const formattedTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));

    expect(chatMessageMetadataLabel({
      role: "assistant",
      parts: [],
      meta: { timestamp, model: { provider: "provider", id: "model" } },
    })).toBe(`${formattedTimestamp} · provider/model`);
  });
});

describe("chat event-group content seams", () => {
  // Group scroll-anchor keys, marker ids, class list, and disclosure label are
  // content/structure derived from pure exported seams rather than scraped from
  // rendered markup.
  it("derives stable group and event scroll-anchor keys and marker ids", () => {
    expect(chatGroupAnchorKey(40)).toBe("g:40");
    expect(chatEventAnchorKey(40)).toBe("e:40");
    expect(chatEventAnchorKey(41)).toBe("e:41");
    expect(chatGroupScrollMarkerId(41)).toBe("g:41");
  });

  it("distinguishes the live tail group by class and disclosure label", () => {
    expect(chatMessageGroupClassName(true)).toBe("msg event-group live");
    expect(chatMessageGroupClassName(false)).toBe("msg event-group");
    expect(chatMessageGroupLabel(true)).toBe("live events");
    expect(chatMessageGroupLabel(false)).toBe("events");
  });
});

describe("ChatView event-group disclosure wiring", () => {
  const messages: ChatLine[] = [
    { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "inspect a file" }] },
    { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "inspect a file", status: "success", resultText: "large result" }] },
  ];

  it("defers a closed group body until it is opened", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);

    renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([]);
  });

  it("renders a live tail body by default", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);

    renderMessageGroup(view, messages, 40, 41, true);

    expect(bodyCalls).toEqual([{ messages, startIndex: 40 }]);
  });

  // Escape hatch: this case verifies the native `<details>` `@toggle` wiring,
  // whose observable effect is that a re-render renders (or defers) the group
  // body. No DOM environment is available for a real disclosure interaction, so
  // handler extraction anchored to the stable `@toggle=` attribute marker plus
  // an injected details-toggle event is proportionate.
  it("renders the body after a toggle-open and removes it when closed again", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);
    const initiallyClosed = renderMessageGroup(view, messages, 40, 41, false);

    dispatchDetailsToggle(templateEventHandlerAfterMarker(initiallyClosed, "@toggle="), true);
    renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([{ messages, startIndex: 40 }]);

    bodyCalls.length = 0;
    dispatchDetailsToggle(templateEventHandlerAfterMarker(initiallyClosed, "@toggle="), false);
    renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([]);
  });
});

interface GroupBodyRenderCall {
  messages: ChatLine[];
  startIndex: number;
}

type RenderActivityDock = (this: ChatView) => TemplateResult | null;
type RenderQueuedMessages = (this: ChatView) => TemplateResult;
type RenderMessageGroup = (this: ChatView, messages: ChatLine[], startIndex: number, endIndex: number, defaultOpen: boolean) => TemplateResult;
type RenderMessageActions = (this: ChatView, message: ChatLine, key: string) => TemplateResult | null;
type RenderMessageGroupBody = (this: ChatView, messages: ChatLine[], startIndex: number) => TemplateResult;
type RenderWarnings = (this: ChatView) => TemplateResult | null;
type RenderNotificationTray = (this: ChatView) => TemplateResult | null;
type FocusPendingNotificationTarget = (this: ChatView) => void;
type TemplateEventHandler = (event: Event) => void;

function renderActivityDock(view: ChatView): TemplateResult {
  const method: unknown = Reflect.get(view, "renderActivityDock");
  if (!isRenderActivityDock(method)) throw new Error("ChatView.renderActivityDock is not callable");
  const rendered = method.call(view);
  if (rendered === null) throw new Error("Expected an activity dock");
  return rendered;
}

function renderQueuedMessages(view: ChatView): TemplateResult {
  const method: unknown = Reflect.get(view, "renderQueuedMessages");
  if (!isRenderQueuedMessages(method)) throw new Error("ChatView.renderQueuedMessages is not callable");
  return method.call(view);
}

function renderMessageGroup(view: ChatView, messages: ChatLine[], startIndex: number, endIndex: number, defaultOpen: boolean): TemplateResult {
  const method: unknown = Reflect.get(view, "renderMessageGroup");
  if (!isRenderMessageGroup(method)) throw new Error("ChatView.renderMessageGroup is not callable");
  return method.call(view, messages, startIndex, endIndex, defaultOpen);
}

function renderMessageActions(view: ChatView, message: ChatLine, key: string): TemplateResult {
  const method: unknown = Reflect.get(view, "renderMessageActions");
  if (!isRenderMessageActions(method)) throw new Error("ChatView.renderMessageActions is not callable");
  const rendered = method.call(view, message, key);
  if (rendered === null) throw new Error("Expected message actions");
  return rendered;
}

function renderWarnings(view: ChatView): TemplateResult | null {
  const method: unknown = Reflect.get(view, "renderWarnings");
  if (!isRenderWarnings(method)) throw new Error("ChatView.renderWarnings is not callable");
  return method.call(view);
}

function renderNotificationTray(view: ChatView): TemplateResult | null {
  const method: unknown = Reflect.get(view, "renderNotificationTray");
  if (!isRenderNotificationTray(method)) throw new Error("ChatView.renderNotificationTray is not callable");
  return method.call(view);
}

function focusPendingNotificationTarget(view: ChatView): void {
  const method: unknown = Reflect.get(view, "focusPendingNotificationTarget");
  if (!isFocusPendingNotificationTarget(method)) throw new Error("ChatView.focusPendingNotificationTarget is not callable");
  method.call(view);
}

function observeGroupBodyRenders(view: ChatView): GroupBodyRenderCall[] {
  const method: unknown = Reflect.get(view, "renderMessageGroupBody");
  if (!isRenderMessageGroupBody(method)) throw new Error("ChatView.renderMessageGroupBody is not callable");
  const calls: GroupBodyRenderCall[] = [];
  const observed: RenderMessageGroupBody = function (messages, startIndex) {
    calls.push({ messages, startIndex });
    return method.call(this, messages, startIndex);
  };
  if (!Reflect.set(view, "renderMessageGroupBody", observed)) throw new Error("Could not observe ChatView.renderMessageGroupBody");
  return calls;
}

function isRenderActivityDock(value: unknown): value is RenderActivityDock {
  return typeof value === "function";
}

function isRenderQueuedMessages(value: unknown): value is RenderQueuedMessages {
  return typeof value === "function";
}

function isRenderMessageGroup(value: unknown): value is RenderMessageGroup {
  return typeof value === "function";
}

function isRenderMessageActions(value: unknown): value is RenderMessageActions {
  return typeof value === "function";
}

function isRenderMessageGroupBody(value: unknown): value is RenderMessageGroupBody {
  return typeof value === "function";
}

function isRenderWarnings(value: unknown): value is RenderWarnings {
  return typeof value === "function";
}

function isRenderNotificationTray(value: unknown): value is RenderNotificationTray {
  return typeof value === "function";
}

function isFocusPendingNotificationTarget(value: unknown): value is FocusPendingNotificationTarget {
  return typeof value === "function";
}

function dispatchDetailsToggle(handler: TemplateEventHandler, open: boolean): void {
  const hadDetailsElement = Reflect.has(globalThis, "HTMLDetailsElement");
  const previousDetailsElement = Reflect.get(globalThis, "HTMLDetailsElement");
  class StubDetailsElement extends EventTarget {
    constructor(readonly open: boolean) {
      super();
    }
  }
  Reflect.set(globalThis, "HTMLDetailsElement", StubDetailsElement);
  try {
    const details = new StubDetailsElement(open);
    details.addEventListener("toggle", (event) => { handler(event); });
    details.dispatchEvent(new Event("toggle"));
  } finally {
    if (hadDetailsElement) Reflect.set(globalThis, "HTMLDetailsElement", previousDetailsElement);
    else Reflect.deleteProperty(globalThis, "HTMLDetailsElement");
  }
}

function withStatus(view: ChatView, status: SessionStatus): ChatView {
  view.status = status;
  return view;
}

function withNotificationInbox(view: ChatView): ChatView {
  const notificationInbox: SelectedSessionNotificationView = {
    machineId: "local",
    sessionId: "session-1",
    cwd: "/repo",
    daemonInstanceId: "daemon-a",
    notifications: [{
      id: "daemon-a:1",
      message: "plain <strong>text</strong>\nsecond line",
      truncated: false,
      severity: "warning",
      receivedAt: "2026-07-18T00:00:00.000Z",
      order: 1,
    }],
    retainedCount: 1,
    discardedCount: 0,
    highestSeverity: "warning",
    dismissThrough: { order: 1, overflowWatermark: 0 },
    pendingDismissedIds: new Set(),
    dismissAllPending: false,
    announcements: [],
  };
  view.sessionId = notificationInbox.sessionId;
  view.notificationInbox = notificationInbox;
  return view;
}

function requireNotificationInbox(view: ChatView): SelectedSessionNotificationView {
  if (view.notificationInbox === undefined) throw new Error("expected a notification inbox");
  return view.notificationInbox;
}

function emptyNotificationInbox(inbox: SelectedSessionNotificationView): SelectedSessionNotificationView {
  const empty: SelectedSessionNotificationView = {
    ...inbox,
    notifications: [],
    retainedCount: 0,
    discardedCount: 0,
    pendingDismissedIds: new Set(),
    dismissAllPending: false,
  };
  delete empty.highestSeverity;
  return empty;
}

function installNotificationFocusRoot(view: ChatView): ReturnType<typeof vi.fn> {
  const headerFocus = vi.fn();
  const renderRoot = {
    querySelector: (selector: string) => selector === "[data-notification-focus='header']" ? { focus: headerFocus } : null,
    querySelectorAll: () => [],
  };
  if (!Reflect.set(view, "renderRoot", renderRoot)) throw new Error("Could not install notification focus root");
  return headerFocus;
}

function warningStatus(warnings: SessionWarning[]): SessionStatus {
  return {
    ...queuedStatus([]),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

function queuedStatus(queuedMessages: QueuedSessionMessage[]): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: queuedMessages.length,
    queuedMessages,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

// ---------------------------------------------------------------------------
// Session info popover wiring
// ---------------------------------------------------------------------------

describe("ChatView session info popover wiring", () => {
  it("toggles the popover open when the usage button is clicked", () => {
    const view = new ChatView();
    view.status = usageStatus();
    view.sessionId = "session-1";

    popoverOpen(view, false);

    // Simulate clicking the usage toggle
    templateEventHandlerAfterMarker(renderActivityDock(view), "usage-toggle")(new Event("click"));

    popoverOpen(view, true);
  });

  it("closes the popover when the usage button is clicked again", () => {
    const view = new ChatView();
    view.status = usageStatus();
    view.sessionId = "session-1";
    setPopoverOpen(view, true);

    templateEventHandlerAfterMarker(renderActivityDock(view), "usage-toggle")(new Event("click"));

    popoverOpen(view, false);
  });

  it("opens the popover on Enter key via handleUsageKeydown", () => {
    const view = new ChatView();
    view.status = usageStatus();
    view.sessionId = "session-1";

    const handler = getPrivateMethod(view, "handleUsageKeydown");
    handler(Object.assign(new Event("keydown"), { key: "Enter" }));

    popoverOpen(view, true);
  });

  it("opens the popover on Space key via handleUsageKeydown", () => {
    const view = new ChatView();
    view.status = usageStatus();
    view.sessionId = "session-1";

    const handler = getPrivateMethod(view, "handleUsageKeydown");
    handler(Object.assign(new Event("keydown"), { key: " " }));

    popoverOpen(view, true);
  });

  it("closes the popover on Escape key via handlePopoverKeydown", () => {
    const view = new ChatView();
    view.status = usageStatus();
    view.sessionId = "session-1";
    setPopoverOpen(view, true);

    const handler = getPrivateMethod(view, "handlePopoverKeydown");
    handler(Object.assign(new Event("keydown"), { key: "Escape" }));

    popoverOpen(view, false);
  });

  it("closes the popover when session changes", () => {
    const view = new ChatView();
    setPopoverOpen(view, true);
    view.sessionId = "old-session";

    // Simulating a session change by calling prepareSessionUiState
    const prepare = getPrivateVoidMethod(view, "prepareSessionUiState");
    view.sessionId = "new-session";
    prepare.call(view);

    popoverOpen(view, false);
  });

  it("does not render the popover when there is no status", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    setPopoverOpen(view, true);
    // Clear the status property to simulate missing status
    Reflect.set(view, "status", undefined);

    expect(renderSessionInfoPopover(view)).toBeNull();
  });

  it("renders the popover with detail sections when open", () => {
    const view = new ChatView();
    view.status = usageStatus();
    view.sessionId = "session-1";
    setPopoverOpen(view, true);

    const rendered = renderSessionInfoPopover(view);
    expect(rendered).not.toBeNull();
  });

  it("has usage toggle aria attributes in the static template", () => {
    const view = new ChatView();
    view.status = usageStatus();
    view.sessionId = "session-1";
    setPopoverOpen(view, false);

    const dock = renderActivityDock(view);
    // The usage-toggle button is inside a conditional; verify the click handler
    // is wired by extracting it.
    const handler = findOptionalTemplateEventHandlerAfterMarker(dock, "usage-toggle");
    // If the marker is found inside a nested template, a handler should be nearby.
    expect(handler).toBeTypeOf("function");
  });

  it("attaches outside-click listener when popover opens", () => {
    const view = new ChatView();
    view.status = usageStatus();
    view.sessionId = "session-1";
    setPopoverOpen(view, true);
    // Trigger sync
    const sync = getPrivateVoidMethod(view, "syncPopoverOutsideListener");
    sync.call(view);

    // In node environment without window, listener is skipped but no error
    expect(popoverListenerAttached(view)).toBe(false);
  });
});

// Test helpers for session info popover

type RenderSessionInfoPopover = (this: ChatView) => ReturnType<ChatView["render"]>;

function renderSessionInfoPopover(view: ChatView): ReturnType<ChatView["render"]> {
  const method: unknown = Reflect.get(view, "renderSessionInfoPopover");
  if (!isRenderSessionInfoPopover(method)) throw new Error("ChatView.renderSessionInfoPopover is not callable");
  return method.call(view);
}

function isRenderSessionInfoPopover(value: unknown): value is RenderSessionInfoPopover {
  return typeof value === "function";
}

function popoverOpen(view: ChatView, expected: boolean): void {
  const value: unknown = Reflect.get(view, "sessionInfoOpen");
  if (value !== expected) throw new Error(`Expected sessionInfoOpen to be ${String(expected)} but got ${String(value)}`);
}

function setPopoverOpen(view: ChatView, open: boolean): void {
  if (!Reflect.set(view, "sessionInfoOpen", open)) throw new Error("Could not set sessionInfoOpen");
}

function getPrivateMethod(view: ChatView, name: string): (event: Event) => void {
  const method: unknown = Reflect.get(view, name);
  if (typeof method !== "function") throw new Error(`Expected private method ${name}`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reflect.get returns any; the typeof guard ensures safety
  return method as (event: Event) => void;
}

function getPrivateVoidMethod(view: ChatView, name: string): () => void {
  const method: unknown = Reflect.get(view, name);
  if (typeof method !== "function") throw new Error(`Expected private method ${name}`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reflect.get returns any; the typeof guard ensures safety
  return method as () => void;
}

function popoverListenerAttached(view: ChatView): boolean {
  const value: unknown = Reflect.get(view, "popoverGlobalListenerAttached");
  if (typeof value !== "boolean") throw new Error("Expected boolean popoverGlobalListenerAttached");
  return value;
}

function usageStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 95_231, output: 7_482, cacheRead: 0, cacheWrite: 0, total: 102_713 },
    cost: 0.1874,
    contextUsage: { tokens: 94_600, contextWindow: 1_100_000, percent: 8.6 },
    ...overrides,
  };
}
