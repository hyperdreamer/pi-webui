import { describe, expect, it, vi } from "vitest";
import type {
  ClientSessionModelPolicyStatus,
  StarterModelPolicyPreference,
} from "../../../shared/apiTypes";
import { initialAppState } from "../appState";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import {
  defaultApi,
  deferred,
  emptyPage,
  FakeSocket,
  fullStarterModelPolicyPreference,
  oldSession,
  runPendingAnimationFrames,
  sessionLookupId,
  status,
  workspace,
  type AppState,
  type SessionInfo,
  type SessionStatus,
} from "./sessionController.testSupport";

const REQUESTED_EXACT: StarterModelPolicyPreference = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
};
const SUBSTITUTED_POLICY: ClientSessionModelPolicyStatus = {
  mode: "exact",
  resolved: { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "off" },
  ladderValid: true,
};

function startedSession(): SessionInfo {
  return { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl", creationSource: "session-list-plus" };
}

function substitutedStatus(sessionId: string): SessionStatus {
  return {
    ...status(sessionId),
    modelPolicy: SUBSTITUTED_POLICY,
  };
}

function exactStatus(sessionId: string, selection: StarterModelPolicyPreference["exact"], mode: "exact" | "tiered" = "exact"): SessionStatus {
  return {
    ...status(sessionId),
    modelPolicy: { mode, resolved: { model: { ...selection.model }, thinkingLevel: selection.thinkingLevel }, ladderValid: true },
  };
}

function applySessionStatus(controller: SessionController, value: SessionStatus): void {
  const method: unknown = Reflect.get(controller, "applyStatus");
  if (typeof method !== "function") throw new Error("SessionController.applyStatus is not callable");
  Reflect.apply(method, controller, [value]);
}

function substitutionHarness(
  apiOverrides: Partial<typeof defaultApi>,
  onStarterModelPolicySubstitution: NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]> = () => undefined,
): {
  controller: SessionController;
  state: () => AppState;
} {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
  const api: typeof defaultApi = {
    ...defaultApi,
    messages: () => Promise.resolve(emptyPage),
    status: (session) => Promise.resolve(status(sessionLookupId(session))),
    streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    ...apiOverrides,
  };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket(), onStarterModelPolicySubstitution },
  );
  return { controller, state: () => state };
}

describe("SessionController starter policy substitution detection", () => {
  it("emits one event for a different exact tuple", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);

    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).toHaveBeenCalledOnce();
    const event = substitution.mock.calls[0]?.[0];
    if (event === undefined) throw new Error("Expected a substitution event");
    expect(event.machineId).toBe("local");
    expect(event.session).toEqual(started);
    expect(event.session).not.toBe(started);
    expect(event.requestedPolicy).toEqual(REQUESTED_EXACT);
    expect(event.requestedPolicy).not.toBe(REQUESTED_EXACT);
    expect(event.confirmed).toEqual({
      mode: "exact",
      resolved: { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "off" },
    });
  });

  it("consumes a matching exact status so a later substitution emits nothing", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, exactStatus(started.id, REQUESTED_EXACT.exact));
    expect(substitution).not.toHaveBeenCalled();

    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).not.toHaveBeenCalled();
  });

  it("emits one event for a tiered request that persisted exact", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(fullStarterModelPolicyPreference);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).toHaveBeenCalledOnce();
  });

  it("does not emit for a tiered status", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(fullStarterModelPolicyPreference);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, {
      ...status(started.id),
      modelPolicy: {
        mode: "tiered",
        tier: "advanced",
        resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
        ladderValid: true,
      },
    });

    expect(substitution).not.toHaveBeenCalled();
  });

  it("reconciles a status applied before the HTTP response resolves", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();

    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).not.toHaveBeenCalled();

    startRequest.resolve(started);
    await start;

    expect(substitution).toHaveBeenCalledOnce();
  });

  it("waits for a buffered status to be applied", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();

    startRequest.resolve(started);
    await start;

    // The status is buffered behind a frame, so the check stays pending until
    // the frame applies it.
    harness.controller.applyGlobalEvent({ type: "status.update", status: substitutedStatus(started.id) });
    expect(substitution).not.toHaveBeenCalled();

    runPendingAnimationFrames();
    expect(substitution).toHaveBeenCalledOnce();
  });

  it("stays pending until a status carries a model policy", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, status(started.id));
    expect(substitution).not.toHaveBeenCalled();

    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).toHaveBeenCalledOnce();
  });

  it("never captures a discarded pending start", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({
      startPlusSession: () => startRequest.promise,
      stop: () => Promise.resolve({ stopped: true }),
    }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const selected = harness.state().selectedSession;
    if (selected === undefined) throw new Error("Expected a pending session row");
    await harness.controller.deleteCachedNewSession(selected);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).not.toHaveBeenCalled();
  });

  it("never captures a legacy start with plus provenance", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const started = startedSession();
    const harness = substitutionHarness({ startSession: () => Promise.resolve(started) }, substitution);

    await harness.controller.startSession();
    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).not.toHaveBeenCalled();
  });

  it("captures once when the broadcast precedes the HTTP response", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const started = startedSession();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({
      startPlusSession: () => {
        harness.controller.applyGlobalEvent({ type: "session.created", session: started });
        return startRequest.promise;
      },
    }, substitution);

    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).toHaveBeenCalledOnce();

    startRequest.resolve(started);
    await start;
    harness.controller.applyGlobalEvent({ type: "session.created", session: started });
    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).toHaveBeenCalledOnce();
  });

  it("does not capture a session outside the pending start's cwd", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const started = startedSession();
    const other = { ...started, id: "other-session", path: "/tmp/other-session.jsonl", cwd: "/other" };
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);

    // The broadcast belongs to another workspace, so it must not be correlated
    // with this pending start; a status for it decides nothing.
    harness.controller.applyGlobalEvent({ type: "session.created", session: other });
    startRequest.resolve(started);
    await start;
    applySessionStatus(harness.controller, substitutedStatus(other.id));

    expect(substitution).not.toHaveBeenCalled();
  });

  it("treats a same-model different-level status as a substitution", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    const started = startedSession();
    startRequest.resolve(started);
    await start;

    applySessionStatus(harness.controller, {
      ...status(started.id),
      modelPolicy: {
        mode: "exact",
        resolved: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "off" },
        ladderValid: true,
      },
    });

    expect(substitution).toHaveBeenCalledOnce();
    expect(substitution.mock.calls[0]?.[0].confirmed.resolved).toEqual({
      model: { provider: "openai", id: "gpt-default" },
      thinkingLevel: "off",
    });
  });

  it("emits exactly one event when both capture points and a second status race", async () => {
    const substitution = vi.fn<NonNullable<SessionControllerDependencies["onStarterModelPolicySubstitution"]>>();
    const startRequest = deferred<SessionInfo>();
    const harness = substitutionHarness({ startPlusSession: () => startRequest.promise }, substitution);
    const started = startedSession();

    const start = harness.controller.startPlusSession(REQUESTED_EXACT);
    harness.controller.applyGlobalEvent({ type: "session.created", session: started });
    applySessionStatus(harness.controller, substitutedStatus(started.id));
    expect(substitution).toHaveBeenCalledOnce();

    startRequest.resolve(started);
    await start;
    applySessionStatus(harness.controller, substitutedStatus(started.id));

    expect(substitution).toHaveBeenCalledOnce();
  });
});
