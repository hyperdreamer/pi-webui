// @vitest-environment jsdom

import { render, type TemplateResult } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { PiWebUiApp } from "./PiWebUiApp";
import type { ChatView } from "./ChatView";
import type { SessionInfo, Workspace } from "../../../shared/apiTypes";

let container: HTMLDivElement;
let base: HTMLBaseElement;

const desktopMediaQuery = (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

beforeEach(() => {
  // jsdom's matchMedia is present but unusable; the app guards on presence.
  vi.stubGlobal("matchMedia", desktopMediaQuery);
  vi.stubEnv("BASE_URL", "./");
  base = document.createElement("base");
  base.href = "https://gateway.example/tools/pi/";
  document.head.append(base);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(null, container);
  document.body.replaceChildren();
  base.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function workspace(id: string, path: string, projectId = "project /?"): Workspace {
  return { id, path, projectId, label: id, isMain: false, isGitRepo: false, isGitWorktree: false };
}

const session: SessionInfo = {
  id: "session-1",
  cwd: "/second",
  path: "/second/session.jsonl",
  created: "2026-11-04T00:00:00.000Z",
  modified: "2026-11-04T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

function stateFixture(): AppState {
  const state = initialAppState();
  state.selectedProject = { id: "project /?", name: "project", path: "/first", createdAt: "2026-11-04T00:00:00.000Z" };
  state.workspaces = [workspace("first", "/first"), workspace("workspace ?/", "/second")];
  state.selectedWorkspace = state.workspaces[0];
  state.selectedSession = session;
  state.selectedMachine = {
    id: "remote /?",
    kind: "remote",
    name: "remote",
    baseUrl: "https://machine.example:9999",
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
  return state;
}

type RenderChatView = (state: AppState, session: SessionInfo) => TemplateResult;

function isRenderChatView(value: unknown): value is RenderChatView {
  return typeof value === "function";
}

async function chat(app: PiWebUiApp, state: AppState, selected: SessionInfo = session): Promise<ChatView> {
  Reflect.set(app, "state", state);
  const boundary: unknown = Reflect.get(app, "renderChatView");
  if (!isRenderChatView(boundary)) throw new Error("PiWebUiApp.renderChatView is not callable");
  render(boundary.call(app, state, selected), container);
  const child = container.querySelector<ChatView>("chat-view");
  if (child === null) throw new Error("Missing real chat-view template");
  await child.updateComplete;
  return child;
}

it("binds selected remote session workspace and machine ownership to the rendered chat view", async () => {
  const child = await chat(new PiWebUiApp(), stateFixture());

  expect(child.resolveFileLink?.("/second/a.html")).toBe(
    "https://gateway.example/tools/pi/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view?path=a.html",
  );
});

it("derives nested application exclusion from the effective AppUrlContext", async () => {
  const child = await chat(new PiWebUiApp(), stateFixture());

  expect(child.resolveFileLink?.("/tools/pi/report.html")).toBeUndefined();
  const result = child.resolveFileLink?.("/second/a.html");
  expect(new URL(result ?? "").pathname).toBe(
    "/tools/pi/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view",
  );
});

it("binds undefined when session cwd or selected-project ownership has no match", async () => {
  for (const change of [
    (state: AppState) => { state.selectedProject = undefined; },
    (state: AppState) => { state.workspaces = [workspace("other", "/unmatched")]; },
    (state: AppState) => { state.workspaces = [workspace("other", "/second", "another-project")]; },
    (state: AppState) => { state.workspaces = [workspace("", "/second")]; },
  ]) {
    const state = stateFixture();
    change(state);
    expect((await chat(new PiWebUiApp(), state)).resolveFileLink).toBeUndefined();
  }
});

it("replaces resolver identity for adjacent transitions with other tuple fields held fixed", async () => {
  // cwd plus its matching workspace path change; every id stays fixed.
  const cwdApp = new PiWebUiApp();
  const first = (await chat(cwdApp, stateFixture())).resolveFileLink;
  expect(first).toBeDefined();
  expect(new URL(first?.("/second/a.html") ?? "").searchParams.get("path")).toBe("a.html");

  const movedState: AppState = {
    ...stateFixture(),
    workspaces: [workspace("workspace ?/", "/third"), workspace("first", "/first")],
  };
  const movedSession = { ...session, cwd: "/third" };
  const moved = (await chat(cwdApp, movedState, movedSession)).resolveFileLink;
  expect(moved).not.toBe(first);
  const movedUrl = new URL(moved?.("/third/a.html") ?? "");
  expect(movedUrl.pathname).toContain("/workspaces/workspace%20%3F%2F/file/view");
  expect(movedUrl.searchParams.get("path")).toBe("a.html");

  // project ownership changes; session, cwd, workspace, and machine ids stay fixed.
  const projectApp = new PiWebUiApp();
  const projectFirst = (await chat(projectApp, stateFixture())).resolveFileLink;
  const projectState: AppState = {
    ...stateFixture(),
    selectedProject: { id: "another-project", name: "another", path: "/first", createdAt: "2026-11-04T00:00:00.000Z" },
    workspaces: [workspace("workspace ?/", "/second", "another-project"), workspace("first", "/first", "another-project")],
  };
  const project = (await chat(projectApp, projectState)).resolveFileLink;
  expect(project).not.toBe(projectFirst);
  const projectUrl = new URL(project?.("/second/a.html") ?? "");
  expect(projectUrl.pathname).toContain("/projects/another-project/");
  expect(projectUrl.searchParams.get("path")).toBe("a.html");

  // Exact A -> unavailable -> A must clear the memo so the second A is fresh.
  for (const becomeUnavailable of [
    (state: AppState) => { state.selectedProject = undefined; },
    (state: AppState) => { state.workspaces = [workspace("other", "/unmatched")]; },
  ]) {
    const app = new PiWebUiApp();
    const state = stateFixture();
    const original = (await chat(app, state)).resolveFileLink;
    expect(original).toBeDefined();
    const unavailable = stateFixture();
    becomeUnavailable(unavailable);
    expect((await chat(app, unavailable)).resolveFileLink).toBeUndefined();
    const reenabled = (await chat(app, state)).resolveFileLink;
    expect(reenabled).toBeDefined();
    expect(reenabled).not.toBe(original);
    expect(new URL(reenabled?.("/second/a.html") ?? "").searchParams.get("path")).toBe("a.html");
  }
});

it("reuses resolver identity only while its complete ownership tuple is equal", async () => {
  const app = new PiWebUiApp();
  const state = stateFixture();
  const first = (await chat(app, state)).resolveFileLink;
  expect(first).toBeDefined();

  const equal = { ...state, workspaces: state.workspaces.map((candidate) => ({ ...candidate })), isLoadingProjects: true };
  expect((await chat(app, equal)).resolveFileLink).toBe(first);

  const otherSession = { ...session, id: "session-2" };
  const second = (await chat(app, equal, otherSession)).resolveFileLink;
  expect(second).not.toBe(first);

  const changedWorkspace = { ...equal, workspaces: [workspace("new", "/second")] };
  const third = (await chat(app, changedWorkspace, otherSession)).resolveFileLink;
  expect(third).not.toBe(second);
  expect(third?.("a.html")).toContain("/workspaces/new/");

  const local = { ...changedWorkspace, selectedMachine: undefined };
  const fourth = (await chat(app, local, otherSession)).resolveFileLink;
  expect(fourth).not.toBe(third);
  expect(fourth?.("a.html")).toContain("/machines/local/");

  // A matching cwd change replaces identity even when the new workspace matches.
  const movedState = { ...state, workspaces: [workspace("moved", "/third")] };
  const movedSession = { ...session, id: "session-3", cwd: "/third" };
  const moved = (await chat(app, movedState, movedSession)).resolveFileLink;
  expect(moved).not.toBe(first);
  expect(moved?.("a.html")).toContain("/workspaces/moved/");
  const movedEqual = { ...movedState, workspaces: movedState.workspaces.map((candidate) => ({ ...candidate })) };
  expect((await chat(app, movedEqual, movedSession)).resolveFileLink).toBe(moved);

  // A changed selected-project id with a matching workspace replaces identity.
  const otherProjectState: AppState = {
    ...state,
    selectedProject: { id: "another-project", name: "another", path: "/first", createdAt: "2026-11-04T00:00:00.000Z" },
    workspaces: [workspace("workspace ?/", "/second", "another-project")],
  };
  const otherProject = (await chat(app, otherProjectState)).resolveFileLink;
  expect(otherProject).not.toBe(first);
  expect(otherProject?.("a.html")).toContain("/projects/another-project/");

  // Losing ownership clears it; re-enabling builds a fresh resolver.
  expect((await chat(app, { ...state, workspaces: [workspace("other", "/unmatched")] })).resolveFileLink).toBeUndefined();
  const reenabled = (await chat(app, state)).resolveFileLink;
  expect(reenabled).toBeDefined();
  expect(reenabled).not.toBe(first);
});

it("binds undefined for an empty session cwd", async () => {
  const child = await chat(new PiWebUiApp(), stateFixture(), { ...session, cwd: "" });

  expect(child.resolveFileLink).toBeUndefined();
});

it("does not read browser URL state before a document and complete ownership exist", async () => {
  vi.stubGlobal("document", undefined);
  let app: PiWebUiApp;
  try {
    app = new PiWebUiApp();
  } finally {
    vi.unstubAllGlobals();
    vi.stubGlobal("matchMedia", desktopMediaQuery);
  }

  const noOwnership = stateFixture();
  noOwnership.workspaces = [workspace("other", "/unmatched")];
  expect((await chat(app, noOwnership)).resolveFileLink).toBeUndefined();

  const restored = await chat(app, stateFixture());
  expect(restored.resolveFileLink?.("/second/a.html")).toContain("/workspaces/workspace%20%3F%2F/file/view?path=a.html");
});
