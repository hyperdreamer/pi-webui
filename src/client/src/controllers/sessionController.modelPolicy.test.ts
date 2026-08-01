import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { ClientSessionModelPolicyStatus, ExactModelSelection, SessionModelPolicyResponse, SessionModelPolicyUpdate } from "../../../shared/apiTypes";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, sessionLookupId, status, workspace, type AppState, type SessionInfo, type SessionStatus } from "./sessionController.testSupport";

const exact: ExactModelSelection = { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" };

const policyWorkspace: AppState["selectedWorkspace"] = { ...workspace, path: "/work" };

const selectedSession: SessionInfo = {
  id: "s-1",
  path: "/tmp/s-1.jsonl",
  cwd: "/work",
  created: "2026-07-31T00:00:00.000Z",
  modified: "2026-07-31T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

const otherSession: SessionInfo = { ...selectedSession, id: "s-2", path: "/tmp/s-2.jsonl" };

const tieredUpdate: SessionModelPolicyUpdate = { mode: "tiered", tier: "advanced" };

function machine(id: string): NonNullable<AppState["selectedMachine"]> {
  return { id, name: id, kind: "remote", createdAt: "now", updatedAt: "now" };
}

function policyStatus(sessionId: string, overrides: Partial<ClientSessionModelPolicyStatus> = {}): SessionStatus {
  return { ...status(sessionId), modelPolicy: { mode: "tiered", tier: "advanced", resolved: exact, ladderValid: true, ...overrides } };
}

function tieredResponse(sessionId: string): SessionModelPolicyResponse {
  return { contractVersion: 1, policy: { mode: "tiered", exact, tier: "advanced" }, session: policyStatus(sessionId) };
}

interface Harness {
  controller: SessionController;
  state: () => AppState;
  setSelection: (patch: Partial<AppState>) => void;
}

function harness(api: typeof defaultApi, initial: Partial<AppState> = {}): Harness {
  let state: AppState = {
    ...initialAppState(),
    selectedMachine: machine("remote"),
    selectedWorkspace: policyWorkspace,
    selectedSession,
    sessions: [selectedSession, otherSession],
    ...initial,
  };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket() },
  );
  return { controller, state: () => state, setSelection: (patch) => { state = { ...state, ...patch }; } };
}

function selectionApi(overrides: Partial<typeof defaultApi> = {}): typeof defaultApi {
  return {
    ...defaultApi,
    messages: () => Promise.resolve(emptyPage),
    status: (session) => Promise.resolve(status(sessionLookupId(session))),
    streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    ...overrides,
  };
}

describe("SessionController model policy state", () => {
  it("loads the selected session's policy and applies the confirmed status", async () => {
    const response = tieredResponse(selectedSession.id);
    const modelPolicy = vi.fn(() => Promise.resolve(response));
    const { controller, state } = harness({ ...defaultApi, modelPolicy });

    const loading = controller.loadModelPolicy();
    expect(state().isLoadingModelPolicy).toBe(true);
    await loading;

    expect(modelPolicy).toHaveBeenCalledWith({ id: "s-1", cwd: "/work" }, "remote");
    expect(state().modelPolicy?.policy?.mode).toBe("tiered");
    expect(state().status?.modelPolicy?.tier).toBe("advanced");
    expect(state().sessionStatuses[selectedSession.id]?.modelPolicy?.resolved).toEqual(exact);
    expect(state().isLoadingModelPolicy).toBe(false);
    expect(state().modelPolicyError).toBeUndefined();
  });

  it("clears a stale response and error before loading and reports failures through the feature error", async () => {
    const request = deferred<SessionModelPolicyResponse>();
    const { controller, state } = harness({ ...defaultApi, modelPolicy: () => request.promise }, {
      modelPolicy: tieredResponse(selectedSession.id),
      modelPolicyError: "earlier failure",
    });

    const loading = controller.loadModelPolicy();

    expect(state().modelPolicy).toBeUndefined();
    expect(state().modelPolicyError).toBeUndefined();

    request.reject(new Error("policy read failed"));
    await loading;

    expect(state().modelPolicyError).toBe("Error: policy read failed");
    expect(state().modelPolicy).toBeUndefined();
    expect(state().isLoadingModelPolicy).toBe(false);
    expect(state().error).toBe("");
  });

  it("saves a policy, keeps the displayed response until confirmation, and applies the returned status", async () => {
    const previous = tieredResponse(selectedSession.id);
    const confirmed: SessionModelPolicyResponse = {
      contractVersion: 1,
      policy: { mode: "exact", exact, tier: "advanced" },
      session: policyStatus(selectedSession.id, { mode: "exact" }),
    };
    const request = deferred<SessionModelPolicyResponse>();
    const setModelPolicy = vi.fn(() => request.promise);
    const { controller, state } = harness({ ...defaultApi, setModelPolicy }, { modelPolicy: previous });

    const saving = controller.saveModelPolicy({ mode: "exact", exact });

    expect(state().isSavingModelPolicy).toBe(true);
    expect(state().modelPolicy).toBe(previous);

    request.resolve(confirmed);
    await saving;

    expect(setModelPolicy).toHaveBeenCalledWith({ id: "s-1", cwd: "/work" }, { mode: "exact", exact }, "remote");
    expect(state().modelPolicy).toBe(confirmed);
    expect(state().status).toEqual(confirmed.session);
    expect(state().isSavingModelPolicy).toBe(false);
    expect(state().modelPolicyError).toBeUndefined();
  });

  it("ignores a policy read that resolves after the selection changed", async () => {
    const request = deferred<SessionModelPolicyResponse>();
    const api = selectionApi({ modelPolicy: () => request.promise });
    const { controller, state } = harness(api);

    const loading = controller.loadModelPolicy();
    await controller.selectSession(otherSession);

    expect(state().modelPolicy).toBeUndefined();
    expect(state().isLoadingModelPolicy).toBe(false);

    request.resolve(tieredResponse(selectedSession.id));
    await loading;

    expect(state().selectedSession?.id).toBe(otherSession.id);
    expect(state().modelPolicy).toBeUndefined();
    expect(state().status?.modelPolicy).toBeUndefined();
    expect(state().isLoadingModelPolicy).toBe(false);
  });

  it("ignores a policy read that resolves after a newer save confirmed a policy", async () => {
    const stale = tieredResponse(selectedSession.id);
    const confirmed: SessionModelPolicyResponse = {
      contractVersion: 1,
      policy: { mode: "exact", exact, tier: "advanced" },
      session: policyStatus(selectedSession.id, { mode: "exact" }),
    };
    const read = deferred<SessionModelPolicyResponse>();
    const { controller, state } = harness({
      ...defaultApi,
      modelPolicy: () => read.promise,
      setModelPolicy: () => Promise.resolve(confirmed),
    });

    const loading = controller.loadModelPolicy();
    await controller.saveModelPolicy({ mode: "exact", exact });

    expect(state().modelPolicy).toBe(confirmed);

    read.resolve(stale);
    await loading;

    expect(state().modelPolicy).toBe(confirmed);
    expect(state().status?.modelPolicy?.mode).toBe("exact");
    expect(state().isLoadingModelPolicy).toBe(false);
  });

  it("does not overwrite a newly selected session's policy error with a stale save failure", async () => {
    const request = deferred<SessionModelPolicyResponse>();
    const api = selectionApi({ setModelPolicy: () => request.promise });
    const { controller, state, setSelection } = harness(api);

    const saving = controller.saveModelPolicy(tieredUpdate);
    await controller.selectSession(otherSession);
    setSelection({ modelPolicyError: "s-2 save failed" });

    request.reject(new Error("s-1 save failed"));
    await saving;

    expect(state().modelPolicyError).toBe("s-2 save failed");
    expect(state().isSavingModelPolicy).toBe(false);
  });

  it("clears policy state when selecting a different session and when deselecting", async () => {
    const api = selectionApi({ modelPolicy: () => Promise.resolve(tieredResponse(selectedSession.id)) });
    const { controller, state } = harness(api);

    await controller.loadModelPolicy();
    expect(state().modelPolicy?.policy?.exact).toEqual(exact);

    await controller.selectSession(otherSession);

    expect(state().modelPolicy).toBeUndefined();
    expect(state().modelPolicyError).toBeUndefined();
    expect(state().isLoadingModelPolicy).toBe(false);
    expect(state().isSavingModelPolicy).toBe(false);

    await controller.loadModelPolicy();
    controller.deselectSession();

    expect(state().modelPolicy).toBeUndefined();
    expect(state().modelPolicyError).toBeUndefined();
  });

  it("keeps a repair response with an omitted policy visible without client-side repair", async () => {
    const blocked: SessionModelPolicyResponse = {
      contractVersion: 1,
      session: policyStatus(selectedSession.id, { ladderValid: false, blockedReason: "Persisted policy entry is malformed" }),
    };
    const setModelPolicy = vi.fn(() => Promise.resolve(blocked));
    const { controller, state } = harness({ ...defaultApi, modelPolicy: () => Promise.resolve(blocked), setModelPolicy });

    await controller.loadModelPolicy();

    expect(state().modelPolicy).toBe(blocked);
    expect(state().modelPolicy?.policy).toBeUndefined();
    expect(state().status?.modelPolicy?.blockedReason).toBe("Persisted policy entry is malformed");
    expect(state().modelPolicyError).toBeUndefined();
    expect(setModelPolicy).not.toHaveBeenCalled();
  });

  it("keeps a later live status update coherent with the loaded policy response", async () => {
    const response = tieredResponse(selectedSession.id);
    const { controller, state } = harness({ ...defaultApi, modelPolicy: () => Promise.resolve(response) });

    await controller.loadModelPolicy();
    const live = policyStatus(selectedSession.id, { mode: "exact", tier: "advanced" });
    controller.applySessionStatus(live);

    expect(state().status).toEqual(live);
    expect(state().modelPolicy).toBe(response);
  });

  it("does not request policy for an archived, unselected, or client-pending session", async () => {
    const modelPolicy = vi.fn(() => Promise.resolve(tieredResponse(selectedSession.id)));
    const setModelPolicy = vi.fn(() => Promise.resolve(tieredResponse(selectedSession.id)));
    const startRequest = deferred<SessionInfo>();
    const api = selectionApi({ modelPolicy, setModelPolicy, startSession: () => startRequest.promise });
    const archived: SessionInfo = { ...selectedSession, archived: true };
    const { controller, state, setSelection } = harness(api, { selectedSession: undefined });

    await controller.loadModelPolicy();
    await controller.saveModelPolicy(tieredUpdate);

    setSelection({ selectedSession: archived, sessions: [archived] });
    await controller.loadModelPolicy();
    await controller.saveModelPolicy(tieredUpdate);

    setSelection({ selectedSession: undefined, sessions: [] });
    const start = controller.startSession();
    expect(state().selectedSession?.id).toMatch(/^pending-session-/);
    await controller.loadModelPolicy();
    await controller.saveModelPolicy(tieredUpdate);

    expect(modelPolicy).not.toHaveBeenCalled();
    expect(setModelPolicy).not.toHaveBeenCalled();
    expect(state().modelPolicy).toBeUndefined();
    expect(state().isLoadingModelPolicy).toBe(false);
    expect(state().isSavingModelPolicy).toBe(false);

    startRequest.resolve(selectedSession);
    await start;
  });

  it("hands a starter policy snapshot to the start request exactly once", async () => {
    const startCalls: { cwd: string; machineId: string | undefined; modelPolicy: SessionModelPolicyUpdate | undefined }[] = [];
    const startRequest = deferred<SessionInfo>();
    const api = selectionApi({
      startSession: (cwd, machineId, modelPolicy) => {
        startCalls.push({ cwd, machineId, modelPolicy });
        return startRequest.promise;
      },
    });
    const { controller } = harness(api, { selectedSession: undefined, sessions: [] });

    const start = controller.startSession(tieredUpdate);
    startRequest.resolve(selectedSession);
    await start;

    expect(startCalls).toEqual([{ cwd: "/work", machineId: "remote", modelPolicy: tieredUpdate }]);
    expect(startCalls[0]?.modelPolicy).toBe(tieredUpdate);
  });

  it("forwards the starter policy and queues the initial prompt until the start resolves", async () => {
    const startCalls: (SessionModelPolicyUpdate | undefined)[] = [];
    const promptCalls: { sessionId: string; text: string }[] = [];
    const startRequest = deferred<SessionInfo>();
    const api = selectionApi({
      startSession: (_cwd, _machineId, modelPolicy) => {
        startCalls.push(modelPolicy);
        return startRequest.promise;
      },
      prompt: (session, text) => {
        promptCalls.push({ sessionId: sessionLookupId(session), text });
        return Promise.resolve({ accepted: true } as const);
      },
    });
    const { controller } = harness(api, { selectedSession: undefined, sessions: [] });

    const startAndSend = controller.startSessionWithPrompt("Plan the migration", undefined, undefined, "inline", tieredUpdate);

    expect(startCalls).toEqual([tieredUpdate]);
    expect(promptCalls).toEqual([]);

    startRequest.resolve(selectedSession);
    await startAndSend;

    expect(promptCalls).toEqual([{ sessionId: selectedSession.id, text: "Plan the migration" }]);
  });
});
