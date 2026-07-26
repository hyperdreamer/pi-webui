import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { Project, SessionInfo, Workspace } from "../api";
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { WorkspaceController } from "../controllers/workspaceController";
import { PiWebUiApp } from "./PiWebUiApp";

type RenderNavigationPanel = (this: PiWebUiApp) => TemplateResult;
type SelectSessionCallback = (session: SessionInfo) => Promise<void> | void;

describe("PiWebUiApp cross-workspace session navigation", () => {
  it("opens the session's workspace before selecting a linked session", async () => {
    const app = createApp();
    const project: Project = { id: "project-1", name: "repo", path: "/repo", createdAt: "now" };
    const main = workspace(project, "workspace-main", "/repo");
    const feature = workspace(project, "workspace-feature", "/repo-feature");
    const parent = session("parent", main.path);
    const child = session("child", feature.path, { parentSessionPath: parent.path });
    if (!Reflect.set(app, "state", {
      ...initialAppState(),
      projects: [project],
      selectedProject: project,
      workspaces: [main, feature],
      selectedWorkspace: main,
      sessions: [parent],
      projectSessions: [parent, child],
    })) throw new Error("Could not set app state");
    if (!Reflect.set(app, "selectNavigationItem", async (_section: string, _target: string, action: () => Promise<void>) => { await action(); })) {
      throw new Error("Could not install navigation selection harness");
    }
    const workspaces: unknown = Reflect.get(app, "workspaces");
    if (!(workspaces instanceof WorkspaceController)) throw new Error("Workspace controller was unavailable");
    const selectWorkspace = vi.spyOn(workspaces, "selectWorkspace").mockResolvedValue(undefined);

    const onSelectSession = selectSessionCallback(renderNavigationPanel(app));
    await onSelectSession(child);

    expect(selectWorkspace).toHaveBeenCalledWith(feature, { sessionId: child.id });
  });
});

function createApp(): PiWebUiApp {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebUiApp();
}

function renderNavigationPanel(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "renderNavigationPanel");
  if (!isRenderNavigationPanel(method)) throw new Error("PiWebUiApp.renderNavigationPanel is not callable");
  return method.call(app);
}

function selectSessionCallback(template: TemplateResult): SelectSessionCallback {
  const callback = templateValueAfterMarker(template, ".onSelectSession=");
  if (!isSelectSessionCallback(callback)) throw new Error("Expected session selection callback");
  return callback;
}

function isRenderNavigationPanel(value: unknown): value is RenderNavigationPanel {
  return typeof value === "function";
}

function isSelectSessionCallback(value: unknown): value is SelectSessionCallback {
  return typeof value === "function";
}

function workspace(project: Project, id: string, path: string): Workspace {
  return {
    id,
    projectId: project.id,
    path,
    label: id,
    isMain: path === project.path,
    isGitRepo: true,
    isGitWorktree: true,
  };
}

function session(id: string, cwd: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
