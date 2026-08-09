import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, oldSession, replacementSession, sessionLookupId, status, workspace, type AppState, type Deferred, type PromptAttachment, type SessionInfo } from "./sessionController.testSupport";

describe("SessionController send queue", () => {
  it("starts a session and delivers the first prompt without requiring a manual session", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const promptCalls: { sessionId: string; text: string }[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      prompt: (session, text) => {
        promptCalls.push({ sessionId: sessionLookupId(session), text });
        return Promise.resolve({ accepted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const startOutcomes: boolean[] = [];
    const startAndSend = controller.startSessionWithPrompt(
      "Help me understand this project",
      undefined,
      undefined,
      "inline",
      undefined,
      (started) => { startOutcomes.push(started); },
    );

    expect(state.selectedSession?.id).toMatch(/^pending-session-/);
    expect(promptCalls).toEqual([]);
    expect(startOutcomes).toEqual([]);

    startRequest.resolve(started);
    await expect(startAndSend).resolves.toBe(true);

    expect(startOutcomes).toEqual([true]);

    expect(promptCalls).toEqual([{ sessionId: started.id, text: "Help me understand this project" }]);
    expect(state.selectedSession?.id).toBe(started.id);
  });

  it("returns false when the started session rejects its initial prompt", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => Promise.resolve(started),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      prompt: () => Promise.reject(new Error("prompt rejected")),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );
    const startOutcomes: boolean[] = [];

    await expect(controller.startSessionWithPrompt(
      "Initial work",
      undefined,
      undefined,
      "inline",
      undefined,
      (startedSuccessfully) => { startOutcomes.push(startedSuccessfully); },
    )).resolves.toBe(false);

    expect(startOutcomes).toEqual([true]);
    expect(state.error).toContain("prompt rejected");
  });

  it("returns false without delivering the initial prompt when session start fails", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const prompt = vi.fn<typeof defaultApi.prompt>();
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => Promise.reject(new Error("start rejected")),
      prompt,
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );
    const startOutcomes: boolean[] = [];

    await expect(controller.startSessionWithPrompt(
      "Initial work",
      undefined,
      undefined,
      "inline",
      undefined,
      (startedSuccessfully) => { startOutcomes.push(startedSuccessfully); },
    )).resolves.toBe(false);

    expect(startOutcomes).toEqual([false]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("toggles the per-session sending state around an inline attachment send and forwards attachments", async () => {
    let resolvePrompt: (() => void) | undefined;
    let promptArgs: { attachments?: PromptAttachment[] } | undefined;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const attachments: PromptAttachment[] = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: (_session, _text, _behavior, _machineId, sentAttachments) => new Promise<{ accepted: true }>((resolve) => {
        promptArgs = { ...(sentAttachments === undefined ? {} : { attachments: sentAttachments }) };
        resolvePrompt = () => { resolve({ accepted: true }); };
      }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const send = controller.send("look", undefined, attachments, "inline");
    const sendingDuringPrompt = state.sendingPrompts;
    resolvePrompt?.();
    await send;

    expect(sendingDuringPrompt).toEqual({ [oldSession.id]: true });
    expect(state.sendingPrompts).toEqual({});
    expect(promptArgs).toEqual({ attachments });
  });

  it("keeps the sending state scoped to the originating session when the user switches away", async () => {
    let resolvePrompt: (() => void) | undefined;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession, replacementSession] };
    const attachments: PromptAttachment[] = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: () => new Promise<{ accepted: true }>((resolve) => { resolvePrompt = () => { resolve({ accepted: true }); }; }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const send = controller.send("look", undefined, attachments, "inline");
    // While the upload is in flight, deselecting must not clear the originating
    // session's sending entry, and it must stay keyed to that session only.
    controller.deselectSession();
    expect(state.sendingPrompts).toEqual({ [oldSession.id]: true });
    expect(state.sendingPrompts[replacementSession.id]).toBeUndefined();
    resolvePrompt?.();
    await send;
    expect(state.sendingPrompts).toEqual({});
  });

  it("uploads to the workspace folder and rewrites the prompt for folder delivery", async () => {
    let savedCalledWith: PromptAttachment[] | undefined;
    let promptText: string | undefined;
    let promptAttachments: PromptAttachment[] | undefined;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const attachments: PromptAttachment[] = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    const api: typeof defaultApi = {
      ...defaultApi,
      saveAttachments: (_session, sent) => { savedCalledWith = sent; return Promise.resolve([{ path: ".pi-webui/attachments/shot.png", mimeType: "image/png", size: 3 }]); },
      prompt: (_session, text, _behavior, _machineId, sentAttachments) => { promptText = text; promptAttachments = sentAttachments; return Promise.resolve({ accepted: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.send("check this", undefined, attachments, "folder");

    expect(savedCalledWith).toEqual(attachments);
    expect(promptText).toBe("check this\n\n@.pi-webui/attachments/shot.png");
    expect(promptAttachments).toBeUndefined();
    expect(state.sendingPrompts).toEqual({});
  });

  it("does not set the sending state for plain text messages", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const seen: Record<string, true>[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: () => { seen.push({ ...state.sendingPrompts }); return Promise.resolve({ accepted: true }); },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.send("hello")).resolves.toBe(true);
    expect(seen).toEqual([{}]);
    expect(state.sendingPrompts).toEqual({});
  });

  it("returns false for no session, an archived session, and a failed prompt delivery", async () => {
    const promptCalls: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: (_session, text) => {
        promptCalls.push(text);
        return Promise.reject(new Error("prompt offline"));
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.send("no session")).resolves.toBe(false);
    state = { ...state, selectedSession: { ...oldSession, archived: true }, sessions: [{ ...oldSession, archived: true }] };
    await expect(controller.send("archived")).resolves.toBe(false);
    state = { ...state, selectedSession: oldSession, sessions: [oldSession] };
    await expect(controller.send("try delivery")).resolves.toBe(false);

    expect(promptCalls).toEqual(["try delivery"]);
    expect(state.error).toContain("prompt offline");
  });

  it("reports shell and command API acceptance through send", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      shell: () => Promise.resolve({ accepted: true }),
      runCommand: () => Promise.reject(new Error("command offline")),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.send("!pwd")).resolves.toBe(true);
    await expect(controller.send("/help")).resolves.toBe(false);
  });

  it("sends slash commands without inserting an optimistic transcript line and toggles the sending state", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    let resolveCommand: (() => void) | undefined;
    const seenDuringCommand: Record<string, true>[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      runCommand: (_session, text) => new Promise((resolve) => {
        seenDuringCommand.push({ ...state.sendingPrompts });
        resolveCommand = () => { resolve(text.startsWith("/skill") ? { type: "done" } : { type: "done", message: "stats" }); };
      }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const run = controller.send("/skill:skill-creator");
    expect(seenDuringCommand).toEqual([{ [oldSession.id]: true }]);
    // No raw command text is added to the transcript; the agent streams the
    // canonical expanded message back instead.
    expect(state.messages).toEqual([]);
    resolveCommand?.();
    await run;
    expect(state.messages).toEqual([]);
    expect(state.sendingPrompts).toEqual({});
  });

  it("queues prompt sends for a pending session start and flushes them after resolution", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const promptCalls: { sessionId: string; text: string; behavior?: "steer" | "followUp" }[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      prompt: (session, text, behavior) => {
        promptCalls.push({ sessionId: sessionLookupId(session), text, ...(behavior === undefined ? {} : { behavior }) });
        return Promise.resolve({ accepted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");

    await controller.send("first");
    await controller.send("second", "steer");

    expect(promptCalls).toEqual([]);
    expect(state.clientQueuedSessionMessages[temporaryId]).toEqual([
      { kind: "followUp", text: "first" },
      { kind: "steer", text: "second" },
    ]);
    expect(state.activity?.detail).toContain("2 queued messages");

    startRequest.resolve(started);
    await start;

    expect(promptCalls).toEqual([
      { sessionId: started.id, text: "first" },
      { sessionId: started.id, text: "second", behavior: "steer" },
    ]);
    expect(state.clientQueuedSessionMessages[temporaryId]).toBeUndefined();
    expect(state.clientQueuedSessionMessages[started.id]).toBeUndefined();
    expect(state.sendingPrompts).toEqual({});
    expect(state.selectedSession?.id).toBe(started.id);
  });

  it("queues slash commands, shell input, and attachments for a pending session start", async () => {
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const calls: string[] = [];
    const promptCalls: { text: string; attachments?: PromptAttachment[] }[] = [];
    const attachments: PromptAttachment[] = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      runCommand: (session, text) => {
        calls.push(`command:${sessionLookupId(session)}:${text}`);
        return Promise.resolve({ type: "done" });
      },
      shell: (session, text) => {
        calls.push(`shell:${sessionLookupId(session)}:${text}`);
        return Promise.resolve({ accepted: true });
      },
      saveAttachments: (session, sentAttachments) => {
        calls.push(`save:${sessionLookupId(session)}:${sentAttachments[0]?.name ?? ""}`);
        return Promise.resolve([{ path: ".pi-webui/attachments/shot.png", mimeType: "image/png", size: 3 }]);
      },
      prompt: (session, text, _behavior, _machineId, sentAttachments) => {
        calls.push(`prompt:${sessionLookupId(session)}:${text}`);
        promptCalls.push({ text, ...(sentAttachments === undefined ? {} : { attachments: sentAttachments }) });
        return Promise.resolve({ accepted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");

    await controller.send("/help");
    await controller.send("!pwd");
    await controller.send("look", undefined, attachments, "inline");
    await controller.send("save", undefined, attachments, "folder");

    expect(calls).toEqual([]);
    expect(state.clientQueuedSessionMessages[temporaryId]).toEqual([
      { kind: "followUp", text: "/help" },
      { kind: "followUp", text: "!pwd" },
      { kind: "followUp", text: "look\n\n[1 attachment queued: shot.png]" },
      { kind: "followUp", text: "save\n\n[1 attachment queued: shot.png]" },
    ]);

    startRequest.resolve(started);
    await start;

    expect(calls).toEqual([
      `command:${started.id}:/help`,
      `shell:${started.id}:!pwd`,
      `prompt:${started.id}:look`,
      `save:${started.id}:shot.png`,
      `prompt:${started.id}:save\n\n@.pi-webui/attachments/shot.png`,
    ]);
    expect(promptCalls).toEqual([
      { text: "look", attachments },
      { text: "save\n\n@.pi-webui/attachments/shot.png" },
    ]);
    expect(state.clientQueuedSessionMessages[started.id]).toBeUndefined();
  });

  it("keeps queued sends visible when backend session creation fails", async () => {
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    await controller.send("recover me");

    startRequest.reject(new Error("backend unavailable"));
    await start;

    expect(state.selectedSession?.id).toBe(temporaryId);
    expect(state.clientQueuedSessionMessages[temporaryId]).toEqual([{ kind: "followUp", text: "recover me" }]);
    expect(state.activity).toMatchObject({ sessionId: temporaryId, phase: "error", label: "Session creation failed" });
    expect(state.activity?.detail).toContain("1 queued message kept below");

    await expect(controller.send("cannot queue after failure")).resolves.toBe(false);

    await controller.deleteCachedNewSession(state.selectedSession);

    expect(state.clientQueuedSessionMessages[temporaryId]).toBeUndefined();
    expect(state.selectedSession).toBeUndefined();
  });

  it("keeps queued sends scoped to their originating pending start", async () => {
    const firstStarted: SessionInfo = { ...oldSession, id: "started-session-1", path: "/tmp/started-session-1.jsonl" };
    const secondStarted: SessionInfo = { ...oldSession, id: "started-session-2", path: "/tmp/started-session-2.jsonl" };
    const startRequests: Deferred<SessionInfo>[] = [];
    const promptCalls: { sessionId: string; text: string }[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => {
        const request = deferred<SessionInfo>();
        startRequests.push(request);
        return request.promise;
      },
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      prompt: (session, text) => {
        promptCalls.push({ sessionId: sessionLookupId(session), text });
        return Promise.resolve({ accepted: true });
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const firstStart = controller.startSession();
    const firstTemporary = state.selectedSession;
    if (firstTemporary === undefined) throw new Error("Expected first temporary session");
    const secondStart = controller.startSession();
    const secondTemporary = state.selectedSession;
    if (secondTemporary === undefined) throw new Error("Expected second temporary session");

    await controller.send("second prompt");
    await controller.selectSession(firstTemporary, { updateUrl: false });
    await controller.send("first prompt");

    startRequests[1]?.resolve(secondStarted);
    await secondStart;

    expect(promptCalls).toEqual([{ sessionId: secondStarted.id, text: "second prompt" }]);
    expect(state.selectedSession?.id).toBe(firstTemporary.id);
    expect(state.clientQueuedSessionMessages[secondStarted.id]).toBeUndefined();
    expect(state.clientQueuedSessionMessages[firstTemporary.id]).toEqual([{ kind: "followUp", text: "first prompt" }]);

    startRequests[0]?.resolve(firstStarted);
    await firstStart;

    expect(promptCalls).toEqual([
      { sessionId: secondStarted.id, text: "second prompt" },
      { sessionId: firstStarted.id, text: "first prompt" },
    ]);
    expect(state.selectedSession?.id).toBe(firstStarted.id);
    expect(state.clientQueuedSessionMessages[firstStarted.id]).toBeUndefined();
  });
});
