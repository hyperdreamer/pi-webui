import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Machine, Project, SessionInfo, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "./sessionController";
import { FakeSocket } from "./sessionController.testSupport";
import { WorkspaceController } from "./workspaceController";

const project: Project = { id: "project", name: "project", path: "/project", createdAt: "now" };
const main: Workspace = { id: "main", projectId: project.id, path: project.path, label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
const sibling: Workspace = { ...main, id: "sibling", path: "/sibling", isMain: false, isGitWorktree: true };
const parent = session("parent", main.path);
const child = { ...session("child", sibling.path), parentSessionPath: parent.path };
const remote: Machine = { id: "remote", name: "remote", kind: "remote", createdAt: "now", updatedAt: "now" };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("workspace session list invalidation", () => {
  it("replaces only affected lists, updating cross-workspace children without reloading the parent list", async () => {
    const h = harness(() => Promise.resolve([]));
    await settle(h.controller.refreshSessionLists([sibling.path]));
    expect(h.list).toHaveBeenCalledExactlyOnceWith(sibling.path, "local");
    expect(h.state.sessions).toEqual([parent]);
    expect(h.state.projectSessions).toEqual([parent]);
  });

  it("calibrates archive and restore metadata in both lists and the current selection", async () => {
    const archived = { ...parent, archived: true, archivedAt: "now" };
    const h = harness(() => Promise.resolve([archived]), { selectedSession: parent });
    await settle(h.controller.refreshSessionLists([main.path]));
    expect(h.state.sessions).toEqual([archived]);
    expect(h.state.projectSessions).toEqual([child, archived]);
    expect(h.state.selectedSession).toEqual(archived);
    h.list.mockResolvedValue([parent]);
    await settle(h.controller.refreshSessionLists([main.path]));
    expect(h.state.selectedSession).toEqual(parent);
  });

  it("clears a deleted selection and its URL when no sessions remain", async () => {
    const h = harness(() => Promise.resolve([]), { selectedSession: parent });
    await settle(h.controller.refreshSessionLists([main.path]));
    expect(h.state.selectedSession).toBeUndefined();
    expect(h.state.sessions).toEqual([]);
    expect(h.state.projectSessions).toEqual([child]);
    expect(h.updateUrl).toHaveBeenCalled();
  });

  it("selects a valid remaining session after deleting the current selection", async () => {
    const remaining = session("remaining", main.path);
    const h = harness(() => Promise.resolve([remaining]), { selectedSession: parent });
    await settle(h.controller.refreshSessionLists([main.path]));
    expect(h.select).toHaveBeenCalledWith(remaining);
    expect(h.state.selectedSession).toEqual(remaining);
  });

  it("coalesces notifications across separate tasks in a short burst", async () => {
    const h = harness(() => Promise.resolve([]));
    const first = h.controller.refreshSessionLists([sibling.path]);
    await vi.advanceTimersByTimeAsync(10);
    const second = h.controller.refreshSessionLists([sibling.path]);
    await vi.advanceTimersByTimeAsync(10);
    const third = h.controller.refreshSessionLists([sibling.path]);
    await settle(Promise.all([first, second, third]));
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("runs a trailing authoritative read when another mutation occurs during a request", async () => {
    const pending = deferred<SessionInfo[]>();
    const h = harness(() => pending.promise);
    const refreshing = h.controller.refreshSessionLists([sibling.path]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.list).toHaveBeenCalledTimes(1);
    void h.controller.refreshSessionLists([sibling.path]);
    h.list.mockResolvedValue([]);
    pending.resolve([child]);
    await settle(refreshing);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.state.projectSessions).toEqual([parent]);
  });

  it.each(["machine", "project", "workspace", "same-workspace-reselection"] as const)("rejects a late response after %s changes", async (change) => {
    const pending = deferred<SessionInfo[]>();
    const h = harness(() => pending.promise);
    const refreshing = h.controller.refreshSessionLists([sibling.path]);
    await vi.advanceTimersByTimeAsync(50);
    if (change === "machine") h.state.selectedMachine = remote;
    if (change === "project") h.state.selectedProject = { ...project, id: "other" };
    if (change === "workspace") h.state.selectedWorkspace = sibling;
    if (change === "same-workspace-reselection") {
      h.list.mockImplementation((cwd) => Promise.resolve(cwd === main.path ? [parent] : [child]));
      await h.controller.selectWorkspace(main);
    }
    h.state.projectSessions = [parent, child];
    pending.resolve([]);
    await settle(refreshing);
    expect(h.state.projectSessions).toEqual([parent, child]);
  });

  it("ignores unrelated CWDs and events from an unselected machine", async () => {
    const h = harness(() => Promise.resolve([]));
    await settle(Promise.all([
      h.controller.refreshSessionLists(["/unrelated"]),
      h.controller.refreshSessionLists([main.path], "remote"),
    ]));
    expect(h.list).not.toHaveBeenCalled();
  });

  it("refreshes all relevant lists on reconnect, preserving successful reads if a sibling fails", async () => {
    const h = harness((cwd) => cwd === sibling.path ? Promise.reject(new Error("unavailable")) : Promise.resolve([]));
    await settle(h.controller.refreshSessionLists());
    expect(h.list.mock.calls.map(([cwd]) => cwd)).toEqual([main.path, sibling.path]);
    expect(h.state.sessions).toEqual([]);
    expect(h.state.projectSessions).toEqual([child]);
    expect(h.onError).toHaveBeenCalledWith("refresh invalidated session list", expect.any(Error));
  });

  it("does not let an older initial sibling catalog read resurrect a deleted child", async () => {
    const initialSibling = deferred<SessionInfo[]>();
    const h = harness((cwd) => Promise.resolve(cwd === main.path ? [parent] : []));
    h.list.mockImplementationOnce(() => Promise.resolve([parent])).mockImplementationOnce(() => initialSibling.promise);
    await h.controller.selectWorkspace(main);
    expect(h.list).toHaveBeenCalledTimes(2);
    await settle(h.controller.refreshSessionLists([sibling.path]));
    initialSibling.resolve([child]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.projectSessions).toEqual([parent]);
  });

  it("does not let topology hydration overwrite a later authoritative empty list", async () => {
    const hydration = deferred<SessionInfo[]>();
    const h = harness(() => Promise.resolve([]), { workspaces: [main], projectSessions: [parent] });
    h.list.mockImplementationOnce(() => hydration.promise);
    const reconciling = h.controller.reconcileProjectCatalog({ machineId: "local", project, workspaces: [main, sibling] });
    expect(h.list).toHaveBeenCalledTimes(1);
    await settle(h.controller.refreshSessionLists([sibling.path]));
    hydration.resolve([child]);
    await reconciling;
    expect(h.state.projectSessions).toEqual([parent]);
  });

  it("retains invalidations arriving during foreground loading and calibrates after it settles", async () => {
    const foreground = deferred<SessionInfo[]>();
    const h = harness(() => Promise.resolve([]));
    h.list.mockImplementationOnce(() => foreground.promise);
    const selecting = h.controller.selectWorkspace(main);
    await settle(h.controller.refreshSessionLists([main.path], undefined, "background"));
    expect(h.list).toHaveBeenCalledTimes(1);
    foreground.resolve([parent]);
    await selecting;
    await vi.runAllTimersAsync();
    expect(h.state.sessions).toEqual([]);
    expect(h.state.projectSessions).not.toContainEqual(parent);
  });

  it("drops in-flight results after disposal", async () => {
    const pending = deferred<SessionInfo[]>();
    const h = harness(() => pending.promise);
    const refreshing = h.controller.refreshSessionLists([sibling.path]);
    await vi.advanceTimersByTimeAsync(50);
    h.controller.dispose();
    pending.resolve([]);
    await settle(refreshing);
    expect(h.state.projectSessions).toEqual([parent, child]);
  });

  it("drops scheduled work after disposal", async () => {
    const h = harness(() => Promise.resolve([]));
    const refreshing = h.controller.refreshSessionLists();
    h.controller.dispose();
    await settle(refreshing);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.state.projectSessions).toEqual([parent, child]);
  });
});

function harness(listSessions: (cwd: string) => Promise<SessionInfo[]>, patch: Partial<AppState> = {}) {
  const state: AppState = { ...initialAppState(), projects: [project], selectedProject: project, selectedWorkspace: main, workspaces: [main, sibling], sessions: [parent], projectSessions: [parent, child], ...patch };
  const setState = (patch: Partial<AppState>) => { Object.assign(state, patch); };
  const updateUrl = vi.fn();
  const sessions = new SessionController(() => state, setState, updateUrl, undefined, { socket: new FakeSocket() });
  // Selection loading is a separate contract; keep this fixture focused on list reconciliation.
  const select = vi.spyOn(sessions, "selectSession").mockImplementation((selected) => { state.selectedSession = selected; return Promise.resolve(); });
  const list = vi.fn(listSessions);
  const onError = vi.fn();
  const controller = new WorkspaceController(() => state, setState, updateUrl, sessions, undefined, { api: { sessions: list, workspaces: () => Promise.resolve([main, sibling]) }, onBackgroundError: onError });
  return { controller, sessions, state, list, select, updateUrl, onError };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

function session(id: string, cwd: string): SessionInfo {
  return { id, cwd, path: `/sessions/${id}.jsonl`, persisted: true, created: "now", modified: "now", messageCount: 1, firstMessage: id };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
