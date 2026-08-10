import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, FakeSocket, emptyPage, oldSession, replacementSession, sessionLookupId, status, workspace, type AppState, type MessagePage, type SessionStatus } from "./sessionController.testSupport";

interface JoinReads {
  messageSignals: (AbortSignal | undefined)[];
  statusSignals: (AbortSignal | undefined)[];
  snapshotSignals: (AbortSignal | undefined)[];
}

/**
 * A join whose transcript read never settles unless its signal aborts, so a
 * test can observe what switching away does to the abandoned session's reads.
 */
function pendingJoinApi(reads: JoinReads): typeof defaultApi {
  return {
    ...defaultApi,
    messages: (_session, _options, _machineId, signal) => {
      reads.messageSignals.push(signal);
      return new Promise<MessagePage>((_resolve, reject) => {
        signal?.addEventListener("abort", () => { reject(asError(signal.reason)); });
      });
    },
    status: (session, _machineId, signal) => {
      reads.statusSignals.push(signal);
      return Promise.resolve(status(sessionLookupId(session)));
    },
    streamSnapshot: (_session, _machineId, signal) => {
      reads.snapshotSignals.push(signal);
      return Promise.resolve({ seq: 0, partial: null });
    },
    thinkingLevels: () => Promise.resolve({ levels: [] }),
  };
}

function controllerWith(api: typeof defaultApi, seed: Partial<AppState> = {}) {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, replacementSession], ...seed };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket() },
  );
  return { controller, state: () => state };
}

function emptyReads(): JoinReads {
  return { messageSignals: [], statusSignals: [], snapshotSignals: [] };
}

describe("SessionController selection load cancellation", () => {
  it("aborts an unfinished transcript read when another session is selected", async () => {
    const reads = emptyReads();
    const { controller } = controllerWith(pendingJoinApi(reads));

    void controller.selectSession(oldSession, { updateUrl: false });
    await Promise.resolve();
    expect(reads.messageSignals).toHaveLength(1);
    expect(reads.messageSignals[0]?.aborted).toBe(false);

    void controller.selectSession(replacementSession, { updateUrl: false });
    await Promise.resolve();

    expect(reads.messageSignals[0]?.aborted).toBe(true);
    expect(reads.messageSignals[1]?.aborted).toBe(false);
  });

  it("passes the same selection signal to every read of one join", async () => {
    const reads = emptyReads();
    const { controller } = controllerWith(pendingJoinApi(reads));

    void controller.selectSession(oldSession, { updateUrl: false });
    await Promise.resolve();

    const signal = reads.messageSignals[0];
    expect(signal).toBeDefined();
    expect(reads.statusSignals[0]).toBe(signal);
    expect(reads.snapshotSignals[0]).toBe(signal);
  });

  // Deselecting runs on every project and workspace change, so it is the hook
  // that must cancel an abandoned session's reads.
  it("aborts an unfinished transcript read when the active session is cleared", async () => {
    const reads = emptyReads();
    const { controller } = controllerWith(pendingJoinApi(reads));

    void controller.selectSession(oldSession, { updateUrl: false });
    await Promise.resolve();

    controller.clearActiveSession();

    expect(reads.messageSignals[0]?.aborted).toBe(true);
  });

  it("reports no error when a superseded join is aborted", async () => {
    const reads = emptyReads();
    const { controller, state } = controllerWith(pendingJoinApi(reads));

    const superseded = controller.selectSession(oldSession, { updateUrl: false });
    await Promise.resolve();
    void controller.selectSession(replacementSession, { updateUrl: false });
    await superseded;

    expect(state().error).toBe("");
  });

  it("does not abort the newly selected session's own join", async () => {
    const reads = emptyReads();
    const { controller, state } = controllerWith({
      ...pendingJoinApi(reads),
      messages: (session, _options, _machineId, signal) => {
        reads.messageSignals.push(signal);
        if (sessionLookupId(session) === replacementSession.id) return Promise.resolve(emptyPage);
        return new Promise<MessagePage>((_resolve, reject) => {
          signal?.addEventListener("abort", () => { reject(asError(signal.reason)); });
        });
      },
    });

    const superseded = controller.selectSession(oldSession, { updateUrl: false });
    await Promise.resolve();
    const current = controller.selectSession(replacementSession, { updateUrl: false });
    await Promise.allSettled([superseded, current]);

    expect(state().selectedSession?.id).toBe(replacementSession.id);
    expect(state().error).toBe("");
  });

  /**
   * The refresh coordinator re-runs a trailing pass for the same session key. A
   * signal captured when the closure was built would already be aborted by the
   * time that pass runs, cancelling the live selection's own refresh. The signal
   * must therefore be read per attempt.
   */
  it("gives a trailing refresh pass the currently open signal, not a superseded one", async () => {
    const reads = emptyReads();
    const firstPage = deferred<MessagePage>();
    let messageCalls = 0;
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: (_session, _options, _machineId, signal) => {
        messageCalls += 1;
        reads.messageSignals.push(signal);
        if (messageCalls === 1) return firstPage.promise;
        return Promise.resolve(emptyPage);
      },
      status: (session): Promise<SessionStatus> => Promise.resolve(status(sessionLookupId(session))),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const { controller, state } = controllerWith(api, { selectedSession: oldSession });

    const inFlight = controller.refreshSelectedSession();
    await Promise.resolve();
    expect(messageCalls).toBe(1);

    // Re-selecting the same session opens a new load and registers a trailing
    // refresh against the in-flight pass.
    const reselect = controller.selectSession(oldSession, { updateUrl: false });
    firstPage.resolve(emptyPage);
    await Promise.allSettled([inFlight, reselect]);

    const trailingSignal = reads.messageSignals.at(-1);
    expect(messageCalls).toBeGreaterThan(1);
    expect(trailingSignal?.aborted).toBe(false);
    expect(state().error).toBe("");
  });

  it("reports no error when an in-flight refresh is aborted", async () => {
    const reads = emptyReads();
    let joinCompleted = false;
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: (_session, _options, _machineId, signal) => {
        reads.messageSignals.push(signal);
        // The initial join resolves so a selection is properly established; the
        // later refresh stays in flight until its signal aborts.
        if (!joinCompleted) {
          joinCompleted = true;
          return Promise.resolve(emptyPage);
        }
        return new Promise<MessagePage>((_resolve, reject) => {
          signal?.addEventListener("abort", () => { reject(asError(signal.reason)); });
        });
      },
      status: (session): Promise<SessionStatus> => Promise.resolve(status(sessionLookupId(session))),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const { controller, state } = controllerWith(api);

    await controller.selectSession(oldSession, { updateUrl: false });
    const inFlight = controller.refreshSelectedSession();
    await Promise.resolve();

    controller.clearActiveSession();
    await inFlight;

    expect(reads.messageSignals.at(-1)?.aborted).toBe(true);
    expect(state().error).toBe("");
  });
});

/**
 * A cancelled fetch rejects with the signal's reason; typed as `Error` so the
 * fake reads like the real transport and satisfies promise-rejection linting.
 */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
