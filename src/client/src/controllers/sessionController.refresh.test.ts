import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, FakeSocket, oldSession, replacementSession, sessionLookupId, status, workspace, type AppState, type MessagePage, type SessionStatus } from "./sessionController.testSupport";

function page(text: string, total: number): MessagePage {
  return { messages: [{ role: "assistant", content: text }], start: 0, total };
}

describe("SessionController selected-session refresh", () => {
  it("signals selection readiness only after the initial transcript join succeeds", async () => {
    const messages = deferred<MessagePage>();
    const selectedStatus = deferred<SessionStatus>();
    const ready: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => messages.promise,
      status: () => selectedStatus.promise,
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket: new FakeSocket(),
        onSelectedSessionReady: ({ machineId, session }) => { ready.push(`${machineId}:${session.id}`); },
      },
    );

    const selecting = controller.selectSession(oldSession, { updateUrl: false });
    await Promise.resolve();
    expect(ready).toEqual([]);

    messages.resolve(page("ready", 1));
    selectedStatus.resolve(status(oldSession.id));
    await selecting;

    expect(ready).toEqual([`local:${oldSession.id}`]);
  });

  it("shares same-turn requests and runs one trailing refresh requested during the active fetch", async () => {
    const firstPage = deferred<MessagePage>();
    const firstStatus = deferred<SessionStatus>();
    const trailingPage = deferred<MessagePage>();
    const trailingStatus = deferred<SessionStatus>();
    const trailingStarted = deferred<undefined>();
    let messageCalls = 0;
    let statusCalls = 0;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => {
        messageCalls += 1;
        if (messageCalls === 2) trailingStarted.resolve(undefined);
        return messageCalls === 1 ? firstPage.promise : trailingPage.promise;
      },
      status: () => {
        statusCalls += 1;
        return statusCalls === 1 ? firstStatus.promise : trailingStatus.promise;
      },
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const first = controller.refreshSelectedSession();
    const duplicate = controller.refreshSelectedSession();
    await Promise.resolve();

    expect(messageCalls).toBe(1);
    expect(statusCalls).toBe(1);

    const later = controller.refreshSelectedSession();
    const laterDuplicate = controller.refreshSelectedSession();
    firstPage.resolve(page("stale", 1));
    firstStatus.resolve({ ...status(oldSession.id), messageCount: 1 });
    await trailingStarted.promise;

    expect(messageCalls).toBe(2);
    expect(statusCalls).toBe(2);

    trailingPage.resolve(page("fresh", 2));
    trailingStatus.resolve({ ...status(oldSession.id), messageCount: 2 });
    await Promise.all([first, duplicate, later, laterDuplicate]);

    expect(messageCalls).toBe(2);
    expect(statusCalls).toBe(2);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "fresh" }] }]);
    expect(state.status?.messageCount).toBe(2);
  });

  it("does not apply an older refresh after the user selects another session", async () => {
    const stalePage = deferred<MessagePage>();
    const staleStatus = deferred<SessionStatus>();
    const replacementPage = page("replacement", 1);
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession, replacementSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: (session) => sessionLookupId(session) === oldSession.id ? stalePage.promise : Promise.resolve(replacementPage),
      status: (session) => sessionLookupId(session) === oldSession.id ? staleStatus.promise : Promise.resolve(status(replacementSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const staleRefresh = controller.refreshSelectedSession();
    await Promise.resolve();
    await controller.selectSession(replacementSession, { updateUrl: false });
    stalePage.resolve(page("old response", 1));
    staleStatus.resolve({ ...status(oldSession.id), messageCount: 1 });
    await staleRefresh;

    expect(state.selectedSession?.id).toBe(replacementSession.id);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "replacement" }] }]);
    expect(state.status?.sessionId).toBe(replacementSession.id);
  });

  it("fetches the join-time stream snapshot alongside messages and status on refresh", async () => {
    // Leg 3 contract: the snapshot is fetched for the selected session on the join
    // refresh path. Seeding/watermark application is deliberately NOT asserted here
    // (that is Leg 4); this only guards that the data is fetched.
    const snapshotLookups: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(page("live", 1)),
      status: () => Promise.resolve({ ...status(oldSession.id), isStreaming: true }),
      streamSnapshot: (session) => {
        snapshotLookups.push(sessionLookupId(session));
        return Promise.resolve({ seq: 5, partial: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.refreshSelectedSession();

    expect(snapshotLookups).toEqual([oldSession.id]);
  });

  it("preserveSelection list application reconciles rows without session lifecycle effects", async () => {
    const selected = { ...oldSession, id: "session-1" };
    const archivedSelected = { ...selected, archived: true, archivedAt: "now" };
    const other = { ...oldSession, id: "session-2", path: "/tmp/session-2.jsonl" };
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: selected,
      sessions: [selected],
      projectSessions: [selected],
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );
    const lifecycleCalls: string[] = [];
    vi.spyOn(controller, "selectSession").mockImplementation((session) => {
      lifecycleCalls.push(`select:${session.id}`);
      return Promise.resolve();
    });
    vi.spyOn(controller, "deselectSession").mockImplementation(() => { lifecycleCalls.push("deselect"); });
    vi.spyOn(controller, "clearActiveSession").mockImplementation(() => { lifecycleCalls.push("clear"); });

    await controller.applyRefreshedSessionLists(
      [{ cwd: workspace.path, sessions: [archivedSelected] }],
      "local",
      { preserveSelection: true },
    );

    expect(state.selectedSession?.id).toBe("session-1");
    expect(lifecycleCalls).toEqual([]);
    expect(state.sessions).toEqual([archivedSelected]);
    expect(state.projectSessions).toEqual([archivedSelected]);

    await controller.applyRefreshedSessionLists([{ cwd: workspace.path, sessions: [other] }], "local");

    expect(lifecycleCalls).not.toEqual([]);
  });

  it("post mutation reconciliation uses foreground intent even when fire and forget", async () => {
    vi.useFakeTimers();
    try {
      const refreshCalls: { intent: string | undefined }[] = [];
      let acceptedMutationRefreshCompleted = false;
      let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
      const controller = new SessionController(
        () => state,
        (patch) => { state = { ...state, ...patch }; },
        () => undefined,
        undefined,
        {
          socket: new FakeSocket(),
          refreshSessionLists: (cwds, machineId, intent) => {
            void cwds;
            void machineId;
            refreshCalls.push({ intent });
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                acceptedMutationRefreshCompleted = true;
                resolve();
              }, 20_000);
            });
          },
        },
      );

      controller.revalidateSessionListsAfterCommit(oldSession.cwd, "local");

      expect(refreshCalls).toContainEqual({ intent: "foreground" });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(acceptedMutationRefreshCompleted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
