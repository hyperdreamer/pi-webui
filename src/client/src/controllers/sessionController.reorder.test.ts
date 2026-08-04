import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { SessionInfo, SessionReorderRequest, SessionReorderResponse, Workspace } from "../api";
import type { AppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, FakeSocket, workspace } from "./sessionController.testSupport";

const first = session("first");
const second = session("second");

function machine(id: string): NonNullable<AppState["selectedMachine"]> {
  return { id, name: id, kind: "remote", createdAt: "now", updatedAt: "now" };
}

function session(id: string, cwd = "/repo", patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    cwd,
    path: `/sessions/${id}.jsonl`,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: id,
    ...patch,
  };
}

function request(order: readonly SessionInfo[]): SessionReorderRequest {
  return {
    cwd: first.cwd,
    scope: { kind: "root", cwd: first.cwd },
    pinned: false,
    catalogCwds: [first.cwd],
    orderedSessions: order.map(({ id, cwd }) => ({ id, cwd })),
  };
}

function createHarness(
  apiPatch: Partial<typeof defaultApi>,
  refreshProjectSessionCatalog: () => void | Promise<void> = () => undefined,
) {
  let state: AppState = {
    ...initialAppState(),
    selectedWorkspace: workspace,
    selectedSession: first,
    sessions: [first, second],
    projectSessions: [first, second],
  };
  const api: typeof defaultApi = { ...defaultApi, ...apiPatch };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket(), refreshProjectSessionCatalog },
  );
  return {
    controller,
    state: () => state,
    mutateState: (mutate: (current: AppState) => AppState) => { state = mutate(state); },
  };
}

describe("SessionController session reorder", () => {
  it("optimistically updates every catalog and merges the authoritative response", async () => {
    const submittedAlreadyCorrect = session("already-correct", "/repo", { manualOrder: 2 });
    const unsubmitted = session("unsubmitted", "/repo", { manualOrder: 8 });
    const projectSubmittedAlreadyCorrect = session("already-correct", "/repo", { manualOrder: 2 });
    const projectUnsubmitted = session("unsubmitted", "/repo", { manualOrder: 8 });
    const pending = deferred<SessionReorderResponse>();
    const reorder = vi.fn(() => pending.promise);
    const harness = createHarness({ reorder });
    harness.mutateState((state) => ({
      ...state,
      sessions: [first, second, submittedAlreadyCorrect, unsubmitted],
      projectSessions: [first, second, projectSubmittedAlreadyCorrect, projectUnsubmitted],
    }));
    const running = harness.controller.reorderSession(first, request([second, first, submittedAlreadyCorrect]));

    expect(harness.state().sessions.map(({ id, manualOrder }) => [id, manualOrder])).toEqual([
      ["first", 1], ["second", 0], ["already-correct", 2], ["unsubmitted", 8],
    ]);
    expect(harness.state().projectSessions.map(({ id, manualOrder }) => [id, manualOrder])).toEqual([
      ["first", 1], ["second", 0], ["already-correct", 2], ["unsubmitted", 8],
    ]);
    expect(harness.state().sessions.find(({ id }) => id === submittedAlreadyCorrect.id))
      .toBe(submittedAlreadyCorrect);
    expect(harness.state().sessions.find(({ id }) => id === unsubmitted.id)).toBe(unsubmitted);
    expect(harness.state().projectSessions.find(({ id }) => id === projectSubmittedAlreadyCorrect.id))
      .toBe(projectSubmittedAlreadyCorrect);
    expect(harness.state().projectSessions.find(({ id }) => id === projectUnsubmitted.id))
      .toBe(projectUnsubmitted);
    expect(harness.state().selectedSession).toMatchObject({ id: "first", manualOrder: 1 });

    pending.resolve({ orderedSessions: [
      { id: "second", cwd: "/repo", manualOrder: 4 },
      { id: "first", cwd: "/repo", manualOrder: 5 },
      { id: "already-correct", cwd: "/repo", manualOrder: 2 },
    ] });
    await running;

    expect(harness.state().sessions.map(({ id, manualOrder }) => [id, manualOrder])).toEqual([
      ["first", 5], ["second", 4], ["already-correct", 2], ["unsubmitted", 8],
    ]);
    expect(harness.state().projectSessions.map(({ id, manualOrder }) => [id, manualOrder])).toEqual([
      ["first", 5], ["second", 4], ["already-correct", 2], ["unsubmitted", 8],
    ]);
    expect(harness.state().sessions.find(({ id }) => id === submittedAlreadyCorrect.id))
      .toBe(submittedAlreadyCorrect);
    expect(harness.state().sessions.find(({ id }) => id === unsubmitted.id)).toBe(unsubmitted);
    expect(harness.state().projectSessions.find(({ id }) => id === projectSubmittedAlreadyCorrect.id))
      .toBe(projectSubmittedAlreadyCorrect);
    expect(harness.state().projectSessions.find(({ id }) => id === projectUnsubmitted.id))
      .toBe(projectUnsubmitted);
    expect(harness.state().selectedSession).toMatchObject({ id: "first", manualOrder: 5 });
  });

  it("allows one in-flight reorder and recovers failed or ambiguous commits from catalogs", async () => {
    const pending = deferred<SessionReorderResponse>();
    const reorder = vi.fn(() => pending.promise);
    const sessions = vi.fn(() => Promise.resolve([first, { ...second, manualOrder: 0 }]));
    const refreshProjectSessionCatalog = vi.fn(() => Promise.resolve());
    const harness = createHarness({ reorder, sessions }, refreshProjectSessionCatalog);

    const firstRun = harness.controller.reorderSession(first, request([second, first]));
    await harness.controller.reorderSession(first, request([first, second]));
    expect(reorder).toHaveBeenCalledOnce();
    pending.reject(new Error("response lost"));
    await firstRun;

    expect(sessions).toHaveBeenCalledWith("/repo", "local");
    expect(refreshProjectSessionCatalog).toHaveBeenCalledOnce();
    expect(harness.state().error).toContain("response lost");
  });

  it("ignores an authoritative completion after the selected machine changes", async () => {
    const pending = deferred<SessionReorderResponse>();
    const harness = createHarness({ reorder: () => pending.promise });
    const running = harness.controller.reorderSession(first, request([second, first]));
    const remoteMachine = machine("remote");
    harness.mutateState((state) => ({ ...state, selectedMachine: remoteMachine }));
    const replacementState = harness.state();

    pending.resolve({ orderedSessions: [
      { id: "second", cwd: "/repo", manualOrder: 4 },
      { id: "first", cwd: "/repo", manualOrder: 5 },
    ] });
    await running;

    expect(harness.state()).toBe(replacementState);
    expect(harness.state().selectedMachine).toBe(remoteMachine);
    expect(harness.state().selectedWorkspace).toBe(workspace);
  });

  it("does not write a stale reorder failure after clearing the active session", async () => {
    const pending = deferred<SessionReorderResponse>();
    const sessions = vi.fn(() => Promise.resolve([]));
    const refreshProjectSessionCatalog = vi.fn(() => Promise.resolve());
    const harness = createHarness({ reorder: () => pending.promise, sessions }, refreshProjectSessionCatalog);
    const running = harness.controller.reorderSession(first, request([second, first]));
    const replacement = session("replacement");

    harness.controller.clearActiveSession();
    harness.mutateState((state) => ({
      ...state,
      sessions: [replacement],
      projectSessions: [replacement],
      selectedSession: replacement,
      error: "replacement error",
    }));
    pending.reject(new Error("response lost"));
    await running;

    expect(harness.state().sessions).toEqual([replacement]);
    expect(harness.state().sessions[0]).toBe(replacement);
    expect(harness.state().projectSessions).toEqual([replacement]);
    expect(harness.state().projectSessions[0]).toBe(replacement);
    expect(harness.state().selectedSession).toBe(replacement);
    expect(harness.state().error).toBe("replacement error");
    expect(sessions).not.toHaveBeenCalled();
    expect(refreshProjectSessionCatalog).not.toHaveBeenCalled();
  });

  it("ignores an authoritative completion after the workspace changes", async () => {
    const pending = deferred<SessionReorderResponse>();
    const harness = createHarness({ reorder: () => pending.promise });
    const running = harness.controller.reorderSession(first, request([second, first]));
    const otherWorkspace: Workspace = { ...workspace, id: "other", path: "/other" };
    const other = session("other", "/other");
    harness.mutateState((state) => ({
      ...state,
      selectedWorkspace: otherWorkspace,
      selectedSession: other,
      sessions: [other],
      projectSessions: [other],
    }));

    pending.resolve({ orderedSessions: [
      { id: "second", cwd: "/repo", manualOrder: 0 },
      { id: "first", cwd: "/repo", manualOrder: 1 },
    ] });
    await running;

    expect(harness.state().selectedSession).toEqual(other);
    expect(harness.state().sessions).toEqual([other]);
  });

  it("rolls back only order fields when recovery refreshes also fail", async () => {
    const pending = deferred<SessionReorderResponse>();
    const sessions = vi.fn(() => Promise.reject(new Error("workspace refresh failed")));
    const refreshProjectSessionCatalog = vi.fn(() => Promise.reject(new Error("project refresh failed")));
    const harness = createHarness({ reorder: () => pending.promise, sessions }, refreshProjectSessionCatalog);
    const orderedFirst = { ...first, manualOrder: 7 };
    harness.mutateState((state) => ({
      ...state,
      sessions: [orderedFirst, second],
      projectSessions: [orderedFirst, second],
      selectedSession: orderedFirst,
    }));
    const running = harness.controller.reorderSession(orderedFirst, request([second, orderedFirst]));
    const extra = session("extra");
    harness.mutateState((state) => ({
      ...state,
      sessions: [
        ...state.sessions.map((item) => item.id === first.id ? { ...item, name: "Renamed concurrently" } : item),
        extra,
      ],
      projectSessions: [
        ...state.projectSessions.map((item) => item.id === first.id ? { ...item, name: "Renamed concurrently" } : item),
        extra,
      ],
      selectedSession: state.selectedSession === undefined
        ? undefined
        : { ...state.selectedSession, name: "Renamed concurrently" },
    }));

    pending.reject(new Error("response lost"));
    await running;

    const restoredFirst = harness.state().sessions.find(({ id }) => id === first.id);
    const restoredSecond = harness.state().sessions.find(({ id }) => id === second.id);
    expect(restoredFirst).toMatchObject({ name: "Renamed concurrently", manualOrder: 7 });
    expect(restoredSecond).not.toHaveProperty("manualOrder");
    expect(harness.state().sessions).toContain(extra);
    expect(harness.state().projectSessions).toContain(extra);
    expect(harness.state().selectedSession).toMatchObject({
      name: "Renamed concurrently",
      manualOrder: 7,
    });
    expect(sessions).toHaveBeenCalledOnce();
    expect(refreshProjectSessionCatalog).toHaveBeenCalledOnce();
  });

  it("removes a child's manual order after detaching it", async () => {
    const detachParent = vi.fn(() => Promise.resolve({ detached: true as const }));
    const child = {
      ...first,
      parentSessionPath: "/sessions/parent.jsonl",
      manualOrder: 3,
    };
    const harness = createHarness({ detachParent });
    harness.mutateState((state) => ({
      ...state,
      sessions: [child, second],
      projectSessions: [child, second],
      selectedSession: child,
    }));

    await harness.controller.detachParent(child);

    expect(detachParent).toHaveBeenCalledWith(child, "local");
    expect(harness.state().selectedSession).not.toHaveProperty("parentSessionPath");
    expect(harness.state().selectedSession).not.toHaveProperty("manualOrder");
    expect(harness.state().sessions.find(({ id }) => id === child.id))
      .not.toHaveProperty("manualOrder");
    expect(harness.state().projectSessions.find(({ id }) => id === child.id))
      .not.toHaveProperty("manualOrder");
  });
});
