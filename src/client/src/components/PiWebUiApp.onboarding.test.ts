import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionsApi, type PromptAttachment, type Project, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

describe("PiWebUiApp session onboarding", () => {
  it("shows the session start screen only after an opened workspace has loaded an empty session list", () => {
    const app = createApp();
    const ready = onboardingState();

    expect(shouldShowSessionStartScreen(app, ready)).toBe(true);
    expect(shouldShowSessionStartScreen(app, { ...ready, isLoadingSessions: true })).toBe(false);
    expect(shouldShowSessionStartScreen(app, {
      ...ready,
      sessions: [{
        id: "existing-session",
        cwd: ready.selectedWorkspace?.path ?? "/workspace",
        path: "/workspace/existing-session.jsonl",
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-01T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "hello",
      }],
    })).toBe(false);
  });

  it("shows the session start screen when all loaded sessions are archived", () => {
    const app = createApp();
    const ready = onboardingState();

    expect(shouldShowSessionStartScreen(app, {
      ...ready,
      sessions: [{
        id: "archived-session",
        cwd: ready.selectedWorkspace?.path ?? "/workspace",
        path: "/workspace/archived-session.jsonl",
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-01T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "archived hello",
        archived: true,
      }],
    })).toBe(true);
  });

  it("loads defaults only after the empty session list makes the starter visible", async () => {
    const app = createApp();
    const state = onboardingState();
    const loadDefaults = vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterSessionDefaults());
    setAppState(app, { ...state, isLoadingSessions: true });

    applyAppStatePatch(app, { isLoadingSessions: false });

    expect(loadDefaults).toHaveBeenCalledWith(state.selectedWorkspace?.path, "local");
    await Promise.resolve();
    expect(Reflect.get(app, "starterSessionDefaults")).toEqual(starterSessionDefaults());
  });

  it("opens the default model picker without starting a session", async () => {
    const app = createApp();
    const state = onboardingState();
    const controller = appSessionController(app);
    setAppState(app, state);
    if (!Reflect.set(app, "starterSessionDefaults", starterSessionDefaults())) throw new Error("Could not install starter defaults");
    const startSession = vi.spyOn(controller, "startSession").mockResolvedValue(false);

    await startScreenConfigurationHandler(renderSessionStartScreen(app, state), ".onSelectModel=")();

    expect(startSession).not.toHaveBeenCalled();
    expect(Reflect.get(app, "state")).toMatchObject({ modelDialog: { title: "Select Default Model", source: "starter" } });
  });

  it("opens the default thinking picker without starting a session", async () => {
    const app = createApp();
    const state = onboardingState();
    const controller = appSessionController(app);
    setAppState(app, state);
    if (!Reflect.set(app, "starterSessionDefaults", starterSessionDefaults())) throw new Error("Could not install starter defaults");
    const startSession = vi.spyOn(controller, "startSession").mockResolvedValue(false);

    await startScreenConfigurationHandler(renderSessionStartScreen(app, state), ".onSelectThinking=")();

    expect(startSession).not.toHaveBeenCalled();
    expect(Reflect.get(app, "state")).toMatchObject({ thinkingDialog: { title: "Select Default Thinking Level", source: "starter" } });
  });

  it("persists a starter default model without starting a session", async () => {
    const app = createApp();
    const state = onboardingState();
    const defaults = starterSessionDefaults();
    const nextDefaults = { ...defaults, model: { provider: "openai", id: "gpt-next" }, models: [{ provider: "openai", id: "gpt-next" }] };
    const controller = appSessionController(app);
    setAppState(app, state);
    if (!Reflect.set(app, "starterSessionDefaults", defaults)) throw new Error("Could not install starter defaults");
    const startSession = vi.spyOn(controller, "startSession").mockResolvedValue(false);
    const updateDefaults = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(nextDefaults);

    await pickStarterModel(app, "openai/gpt-next");

    expect(updateDefaults).toHaveBeenCalledWith(state.selectedWorkspace?.path, { model: { provider: "openai", modelId: "gpt-next" } }, "local");
    expect(startSession).not.toHaveBeenCalled();
    expect(Reflect.get(app, "starterSessionDefaults")).toEqual(nextDefaults);
  });

  it("persists a starter default thinking level without starting a session", async () => {
    const app = createApp();
    const state = onboardingState();
    const defaults = starterSessionDefaults();
    const nextDefaults = { ...defaults, thinkingLevel: "low" };
    const controller = appSessionController(app);
    setAppState(app, state);
    if (!Reflect.set(app, "starterSessionDefaults", defaults)) throw new Error("Could not install starter defaults");
    const startSession = vi.spyOn(controller, "startSession").mockResolvedValue(false);
    const updateDefaults = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(nextDefaults);

    await pickStarterThinking(app, "low");

    expect(updateDefaults).toHaveBeenCalledWith(state.selectedWorkspace?.path, { thinkingLevel: "low" }, "local");
    expect(startSession).not.toHaveBeenCalled();
    expect(Reflect.get(app, "starterSessionDefaults")).toEqual(nextDefaults);
  });

  it("forwards the first prompt from the start screen to automatic session creation", () => {
    const app = createApp();
    const state = onboardingState();
    setAppState(app, state);
    const controller = appSessionController(app);
    const startSessionWithPrompt = vi.spyOn(controller, "startSessionWithPrompt").mockImplementation((...args) => {
      args[5]?.(false);
      return Promise.resolve(false);
    });
    const focusChatComposer = vi.fn(() => Promise.resolve());
    if (!Reflect.set(app, "focusChatComposer", focusChatComposer)) throw new Error("Could not install prompt focus harness");
    const attachment: PromptAttachment = { kind: "image", mimeType: "image/png", data: "QUJD", name: "sketch.png" };

    // This narrow TemplateResult assertion verifies the child callback boundary;
    // a DOM harness would add disproportionate setup in this node-only suite.
    const onSend = startScreenSendHandler(renderSessionStartScreen(app, state));
    onSend("Sketch a plan", undefined, [attachment], "inline");

    expect(startSessionWithPrompt).toHaveBeenCalledWith("Sketch a plan", undefined, [attachment], "inline", undefined, expect.any(Function));
    expect(focusChatComposer).toHaveBeenCalledOnce();
  });
});

type ApplyAppStatePatch = (this: PiWebUiApp, patch: Partial<AppState>) => void;
type ShouldShowSessionStartScreen = (this: PiWebUiApp, state: AppState) => boolean;
type RenderSessionStartScreen = (this: PiWebUiApp, state: AppState) => TemplateResult;
type StartScreenSendHandler = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery?: PromptAttachmentDelivery) => void;
type StartScreenConfigurationHandler = () => void | Promise<void>;

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebUiApp();
}

function onboardingState(): AppState {
  const project: Project = { id: "project-1", name: "workspace", path: "/workspace", createdAt: "2026-08-01T00:00:00.000Z" };
  const workspace: Workspace = {
    id: "workspace-1",
    projectId: project.id,
    path: project.path,
    label: project.name,
    isMain: true,
    isGitRepo: false,
    isGitWorktree: false,
  };
  return { ...initialAppState(), projects: [project], selectedProject: project, selectedWorkspace: workspace, isLoadingSessions: false };
}

function starterSessionDefaults() {
  return {
    model: { provider: "openai", id: "gpt-default" },
    thinkingLevel: "high",
    models: [{ provider: "openai", id: "gpt-default" }],
    thinkingLevels: ["off", "low", "high"],
  };
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function appSessionController(app: PiWebUiApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebUiApp SessionController was unavailable");
  return controller;
}

function applyAppStatePatch(app: PiWebUiApp, patch: Partial<AppState>): void {
  const method: unknown = Reflect.get(app, "setState");
  if (!isApplyAppStatePatch(method)) throw new Error("PiWebUiApp.setState is not callable");
  method.call(app, patch);
}

function shouldShowSessionStartScreen(app: PiWebUiApp, state: AppState): boolean {
  const method: unknown = Reflect.get(app, "shouldShowSessionStartScreen");
  if (!isShouldShowSessionStartScreen(method)) throw new Error("PiWebUiApp.shouldShowSessionStartScreen is not callable");
  return method.call(app, state);
}

function renderSessionStartScreen(app: PiWebUiApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderSessionStartScreen");
  if (!isRenderSessionStartScreen(method)) throw new Error("PiWebUiApp.renderSessionStartScreen is not callable");
  return method.call(app, state);
}

function startScreenSendHandler(template: TemplateResult): StartScreenSendHandler {
  const handler = templateValueAfterMarker(template, ".onSend=");
  if (!isStartScreenSendHandler(handler)) throw new Error("Start screen send handler was unavailable");
  return handler;
}

type PickStarterConfiguration = (this: PiWebUiApp, value: string) => Promise<void>;

function pickStarterModel(app: PiWebUiApp, value: string): Promise<void> {
  return pickStarterConfiguration(app, "pickStarterModel", value);
}

function pickStarterThinking(app: PiWebUiApp, value: string): Promise<void> {
  return pickStarterConfiguration(app, "pickStarterThinking", value);
}

function pickStarterConfiguration(app: PiWebUiApp, methodName: "pickStarterModel" | "pickStarterThinking", value: string): Promise<void> {
  const method: unknown = Reflect.get(app, methodName);
  if (!isPickStarterConfiguration(method)) throw new Error(`PiWebUiApp.${methodName} is not callable`);
  return method.call(app, value);
}

function startScreenConfigurationHandler(template: TemplateResult, property: ".onSelectModel=" | ".onSelectThinking="): StartScreenConfigurationHandler {
  const handler = templateValueAfterMarker(template, property);
  if (!isStartScreenConfigurationHandler(handler)) throw new Error("Start screen configuration handler was unavailable");
  return handler;
}

function isApplyAppStatePatch(value: unknown): value is ApplyAppStatePatch {
  return typeof value === "function";
}

function isShouldShowSessionStartScreen(value: unknown): value is ShouldShowSessionStartScreen {
  return typeof value === "function";
}

function isRenderSessionStartScreen(value: unknown): value is RenderSessionStartScreen {
  return typeof value === "function";
}

function isStartScreenSendHandler(value: unknown): value is StartScreenSendHandler {
  return typeof value === "function";
}

function isStartScreenConfigurationHandler(value: unknown): value is StartScreenConfigurationHandler {
  return typeof value === "function";
}

function isPickStarterConfiguration(value: unknown): value is PickStarterConfiguration {
  return typeof value === "function";
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
