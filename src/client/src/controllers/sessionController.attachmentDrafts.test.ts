import { beforeEach, describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { PromptAttachmentDraftStore, type PendingAttachment } from "../promptAttachmentDrafts";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, MemoryStorage, oldSession, sessionKey, sessionLookupId, status, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

function attachment(id: string, name: string): PendingAttachment {
  return { id, kind: "image", name, mimeType: "image/png", data: "UE5H", size: 3 };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("SessionController attachment draft lifecycle", () => {
  it("moves an attachment draft from a temporary id to the resolved session id", async () => {
    const attachmentDrafts = new PromptAttachmentDraftStore();
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), attachmentDrafts },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected a temporary session id");
    attachmentDrafts.write(sessionKey(temporaryId), { attachments: [attachment("attachment-1", "queued.png")] });

    startRequest.resolve(started);
    await start;

    expect(attachmentDrafts.read(sessionKey(temporaryId)).attachments).toEqual([]);
    expect(attachmentDrafts.read(sessionKey("started-session")).attachments.map((item) => item.name)).toEqual(["queued.png"]);
  });

  it("clears the attachment draft of a discarded transient session", async () => {
    const attachmentDrafts = new PromptAttachmentDraftStore();
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      stop: () => Promise.resolve({ stopped: true }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), attachmentDrafts },
    );

    void controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected a temporary session id");
    attachmentDrafts.write(sessionKey(temporaryId), { attachments: [attachment("attachment-1", "abandoned.png")] });

    await controller.deleteCachedNewSession(state.selectedSession);

    expect(attachmentDrafts.hasEntry(sessionKey(temporaryId))).toBe(false);
  });
});
