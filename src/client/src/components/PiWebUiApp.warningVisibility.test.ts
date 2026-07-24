import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
// Template inspection is proportionate here because this test verifies only the
// sibling-component callback/property wiring in a node environment without DOM.
import { templateValueAfterMarker, templateValuesAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp session-warning visibility wiring", () => {
  it("keeps the warning control in the activity dock and toggles the warning area", () => {
    const app = createApp();
    const state = stateWithWarnings();
    setAppState(app, state);
    syncWarningVisibility(app);

    const visibleChatView = renderChatView(app, state);
    expect(templateValueAfterMarker(visibleChatView, ".warningsVisible=")).toBe(true);
    expect(templateValuesAfterMarker(visibleChatView, ".warningCount=")).toEqual([2]);
    expect(templateValuesAfterMarker(visibleChatView, ".warningsExpanded=")).toEqual([true]);

    templateCallbackAfterMarker(visibleChatView, ".onToggleWarnings=")();

    const collapsedChatView = renderChatView(app, state);
    expect(templateValueAfterMarker(collapsedChatView, ".warningsVisible=")).toBe(false);
    expect(templateValuesAfterMarker(collapsedChatView, ".warningCount=")).toEqual([2]);
    expect(templateValuesAfterMarker(collapsedChatView, ".warningsExpanded=")).toEqual([false]);

    const otherState = stateWithWarnings("session-2");
    setAppState(app, otherState);
    syncWarningVisibility(app);
    expect(templateValueAfterMarker(renderChatView(app, otherState), ".warningsVisible=")).toBe(true);

    const returningState = { ...state, status: undefined };
    setAppState(app, returningState);
    syncWarningVisibility(app);
    const noStatusChatView = renderChatView(app, returningState);
    expect(templateValueAfterMarker(noStatusChatView, ".warningsVisible=")).toBe(true);
    expect(templateValuesAfterMarker(noStatusChatView, ".warningCount=")).toEqual([0]);

    setAppState(app, state);
    syncWarningVisibility(app);
    const returnedChatView = renderChatView(app, state);
    expect(templateValueAfterMarker(returnedChatView, ".warningsVisible=")).toBe(false);
    expect(templateValuesAfterMarker(returnedChatView, ".warningCount=")).toEqual([2]);
    expect(templateValuesAfterMarker(returnedChatView, ".warningsExpanded=")).toEqual([false]);

    templateCallbackAfterMarker(returnedChatView, ".onToggleWarnings=")();

    const restoredChatView = renderChatView(app, state);
    expect(templateValueAfterMarker(restoredChatView, ".warningsVisible=")).toBe(true);
    expect(templateValuesAfterMarker(restoredChatView, ".warningCount=")).toEqual([2]);
    expect(templateValuesAfterMarker(restoredChatView, ".warningsExpanded=")).toEqual([true]);
  });
});

type RenderChatView = (this: PiWebUiApp, state: AppState, session: SessionInfo) => TemplateResult;
type SyncWarningVisibility = (this: PiWebUiApp) => void;
type WarningVisibilityCallback = () => void;

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebUiApp();
}

function stateWithWarnings(sessionId = "session-1"): AppState {
  const selectedSession: SessionInfo = {
    id: sessionId,
    cwd: "/repo",
    path: `/repo/${sessionId}.jsonl`,
    created: "2026-07-14T00:00:00.000Z",
    modified: "2026-07-14T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
  return {
    ...initialAppState(),
    selectedSession,
    status: warningStatus(sessionId),
  };
}

function warningStatus(sessionId: string): SessionStatus {
  return {
    sessionId,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    warnings: [
      { severity: "warning", message: "subscription auth is active" },
      { severity: "error", message: "skill failed to load" },
    ],
  };
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function syncWarningVisibility(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "syncSessionWarningVisibility");
  if (!isSyncWarningVisibility(method)) throw new Error("PiWebUiApp.syncSessionWarningVisibility is not callable");
  method.call(app);
}

function renderChatView(app: PiWebUiApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderChatView");
  if (!isRenderChatView(method)) throw new Error("PiWebUiApp.renderChatView is not callable");
  const session = state.selectedSession;
  if (session === undefined) throw new Error("Expected a selected session");
  return method.call(app, state, session);
}

function templateCallbackAfterMarker(template: TemplateResult, marker: string): WarningVisibilityCallback {
  const value = templateValueAfterMarker(template, marker);
  if (!isWarningVisibilityCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function isRenderChatView(value: unknown): value is RenderChatView {
  return typeof value === "function";
}

function isSyncWarningVisibility(value: unknown): value is SyncWarningVisibility {
  return typeof value === "function";
}

function isWarningVisibilityCallback(value: unknown): value is WarningVisibilityCallback {
  return typeof value === "function";
}
