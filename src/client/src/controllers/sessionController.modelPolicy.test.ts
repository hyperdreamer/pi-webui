import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { ClientSessionModelPolicyStatus, ExactModelSelection, SessionModelPolicyResponse, SessionModelPolicyUpdate } from "../../../shared/apiTypes";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, runPendingAnimationFrames, sessionLookupId, status, workspace, type AppState, type SessionInfo, type SessionStatus } from "./sessionController.testSupport";

const exact: ExactModelSelection = { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" };

/** The tuple an exact-route mutation (existing model dialog) leaves behind. */
const switchedExact: ExactModelSelection = { model: { provider: "openai", id: "gpt-fast" }, thinkingLevel: "low" };

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

function exactResponse(sessionId: string, selection: ExactModelSelection = exact): SessionModelPolicyResponse {
  return {
    contractVersion: 1,
    policy: { mode: "exact", exact: selection, tier: "advanced" },
    session: policyStatus(sessionId, { mode: "exact", resolved: selection }),
  };
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

  it("re-reads the policy when a live status shows the daemon superseded the held response", async () => {
    const loaded = tieredResponse(selectedSession.id);
    // The existing model dialog's exact route appends a fresh Exact branch and
    // reports it only through the status, so the held tiered response is stale.
    const reread = exactResponse(selectedSession.id, switchedExact);
    const responses = [loaded, reread];
    const modelPolicy = vi.fn(() => Promise.resolve(responses.shift() ?? reread));
    const { controller, state } = harness({ ...defaultApi, modelPolicy });

    await controller.loadModelPolicy();
    expect(state().modelPolicy).toBe(loaded);

    const superseded = policyStatus(selectedSession.id, { mode: "exact", tier: "advanced", resolved: switchedExact });
    controller.applySessionStatus(superseded);

    // The stale remembered branch is dropped immediately; nothing may compose a
    // "switch back to Exact" update from it.
    expect(state().modelPolicy).toBeUndefined();
    expect(state().status).toEqual(superseded);

    await vi.waitFor(() => { expect(modelPolicy).toHaveBeenCalledTimes(2); });
    await vi.waitFor(() => { expect(state().modelPolicy).toBe(reread); });
    expect(state().modelPolicy?.policy?.exact).toEqual(switchedExact);
    expect(state().isLoadingModelPolicy).toBe(false);
  });

  it("keeps the held response when a live status republishes the same policy", async () => {
    const response = tieredResponse(selectedSession.id);
    const modelPolicy = vi.fn(() => Promise.resolve(response));
    const { controller, state } = harness({ ...defaultApi, modelPolicy });

    await controller.loadModelPolicy();
    const live = { ...policyStatus(selectedSession.id), isStreaming: true, cost: 3 };
    controller.applySessionStatus(live);

    expect(state().status).toEqual(live);
    expect(state().modelPolicy).toBe(response);
    expect(modelPolicy).toHaveBeenCalledTimes(1);
  });

  it("keeps a blocked response whose runtime tuple already differs from the remembered branch", async () => {
    // A failed restore leaves the runtime tuple different from the persisted
    // branch. That divergence is the daemon's reported state, not a superseded
    // response, so republishing the same status must not drop or re-read it.
    const blockedRuntime: SessionModelPolicyResponse = {
      contractVersion: 1,
      policy: { mode: "exact", exact, tier: "advanced" },
      session: policyStatus(selectedSession.id, { mode: "exact", resolved: switchedExact, blockedReason: "MODEL_POLICY_BLOCKED: restore unproven" }),
    };
    const modelPolicy = vi.fn(() => Promise.resolve(blockedRuntime));
    const { controller, state } = harness({ ...defaultApi, modelPolicy });

    await controller.loadModelPolicy();
    controller.applySessionStatus({ ...blockedRuntime.session, isStreaming: true });

    expect(state().modelPolicy).toBe(blockedRuntime);
    expect(modelPolicy).toHaveBeenCalledTimes(1);
  });

  it("lets a confirmed save outrank a read issued after it and flushes buffered status first", async () => {
    const confirmed = exactResponse(selectedSession.id, switchedExact);
    const preWrite = tieredResponse(selectedSession.id);
    const save = deferred<SessionModelPolicyResponse>();
    const read = deferred<SessionModelPolicyResponse>();
    const { controller, state } = harness({
      ...defaultApi,
      setModelPolicy: () => save.promise,
      modelPolicy: () => read.promise,
    });

    const saving = controller.saveModelPolicy({ mode: "exact", exact: switchedExact });
    const loading = controller.loadModelPolicy();

    // A read issued mid-save must not clear the response the save is editing.
    expect(state().modelPolicy).toBeUndefined();
    expect(state().isSavingModelPolicy).toBe(true);
    expect(state().isLoadingModelPolicy).toBe(true);

    // A status published before the confirmation but still frame-buffered must
    // not flush afterwards and revert the confirmed policy.
    controller.applyGlobalEvent({ type: "status.update", status: policyStatus(selectedSession.id) });

    // The GET is served before the PUT commits.
    read.resolve(preWrite);
    await loading;

    expect(state().modelPolicy).toBeUndefined();
    expect(state().isLoadingModelPolicy).toBe(false);

    save.resolve(confirmed);
    await saving;

    expect(state().modelPolicy).toBe(confirmed);
    expect(state().status?.modelPolicy?.resolved).toEqual(switchedExact);
    expect(state().isSavingModelPolicy).toBe(false);

    runPendingAnimationFrames();

    expect(state().status?.modelPolicy?.resolved).toEqual(switchedExact);
    expect(state().modelPolicy).toBe(confirmed);
  });

  it("keeps a save rejection visible when a read was issued while the save was in flight", async () => {
    const preWrite = tieredResponse(selectedSession.id);
    const save = deferred<SessionModelPolicyResponse>();
    const read = deferred<SessionModelPolicyResponse>();
    const { controller, state } = harness({
      ...defaultApi,
      setModelPolicy: () => save.promise,
      modelPolicy: () => read.promise,
    }, { modelPolicy: preWrite });

    const saving = controller.saveModelPolicy({ mode: "exact", exact: switchedExact });
    const loading = controller.loadModelPolicy();

    expect(state().modelPolicy).toBe(preWrite);

    read.resolve(preWrite);
    await loading;

    save.reject(new Error("policy write rejected"));
    await saving;

    expect(state().modelPolicyError).toBe("Error: policy write rejected");
    expect(state().isSavingModelPolicy).toBe(false);
    expect(state().isLoadingModelPolicy).toBe(false);
  });

  it("clears its progress flag when the selection is replaced by an equivalent session copy", async () => {
    const read = deferred<SessionModelPolicyResponse>();
    const write = deferred<SessionModelPolicyResponse>();
    const { controller, state, setSelection } = harness({
      ...defaultApi,
      modelPolicy: () => read.promise,
      setModelPolicy: () => write.promise,
    });

    const loading = controller.loadModelPolicy();
    const saving = controller.saveModelPolicy(tieredUpdate);

    // A background session refresh can swap the selected object for a
    // server-archived copy at the same id; the request must still release its
    // progress flag rather than leaving a spinner stuck forever.
    const archivedCopy: SessionInfo = { ...selectedSession, archived: true };
    setSelection({ selectedSession: archivedCopy, sessions: [archivedCopy, otherSession] });

    read.resolve(tieredResponse(selectedSession.id));
    write.resolve(tieredResponse(selectedSession.id));
    await Promise.all([loading, saving]);

    expect(state().isLoadingModelPolicy).toBe(false);
    expect(state().isSavingModelPolicy).toBe(false);
    expect(state().modelPolicy).toBeUndefined();
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
    expect(await start).toBe(true);

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

    const startOutcomes: boolean[] = [];
    const startAndSend = controller.startSessionWithPrompt(
      "Plan the migration",
      undefined,
      undefined,
      "inline",
      tieredUpdate,
      (started) => { startOutcomes.push(started); },
    );

    expect(startCalls).toEqual([tieredUpdate]);
    expect(promptCalls).toEqual([]);
    expect(startOutcomes).toEqual([]);

    startRequest.resolve(selectedSession);
    await expect(startAndSend).resolves.toBeUndefined();

    expect(startOutcomes).toEqual([true]);
    expect(promptCalls).toEqual([{ sessionId: selectedSession.id, text: "Plan the migration" }]);
  });

  it("waits for a successful start result before propagating an initial send rejection", async () => {
    const startRequest = deferred<SessionInfo>();
    const queueError = new Error("queue failed");
    const api = selectionApi({ startSession: () => startRequest.promise });
    const { controller, state } = harness(api, { selectedSession: undefined, sessions: [] });
    vi.spyOn(controller, "send").mockRejectedValue(queueError);

    const lifecycle: string[] = [];
    const startAndSend = controller.startSessionWithPrompt(
      "Plan the migration",
      undefined,
      undefined,
      "inline",
      tieredUpdate,
      (started) => { lifecycle.push(`started:${String(started)}`); },
    );
    let settled = false;
    const observed = startAndSend.then(
      () => {
        settled = true;
        lifecycle.push("resolved");
      },
      () => {
        settled = true;
        lifecycle.push("rejected");
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeStart = settled;

    startRequest.resolve(selectedSession);
    await observed;

    expect(settledBeforeStart).toBe(false);
    await expect(startAndSend).rejects.toBe(queueError);
    expect(lifecycle).toEqual(["started:true", "rejected"]);
    expect(state().selectedSession?.id).toBe(selectedSession.id);
  });

  it("reports false when starter session creation fails", async () => {
    const api = selectionApi({
      startSession: () => Promise.reject(new Error("backend unavailable")),
    });
    const { controller, state } = harness(api, { selectedSession: undefined, sessions: [] });

    const startOutcomes: boolean[] = [];
    await expect(controller.startSessionWithPrompt(
      "Retry the migration",
      undefined,
      undefined,
      "inline",
      tieredUpdate,
      (started) => { startOutcomes.push(started); },
    )).resolves.toBeUndefined();

    expect(startOutcomes).toEqual([false]);

    expect(state().selectedSession?.id).toMatch(/^pending-session-/);
    expect(state().error).toContain("backend unavailable");
  });
});
