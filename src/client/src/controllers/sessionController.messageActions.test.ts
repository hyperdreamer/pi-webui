import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { loadDraft } from "../promptDraftStorage";
import { SessionController } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";
import {
  defaultApi,
  FakeSocket,
  MemoryStorage,
  oldSession,
  sessionKey,
  status,
  workspace,
  type AppState,
  type MessagePage,
} from "./sessionController.testSupport";

function page(text: string): MessagePage {
  return { messages: [{ role: "assistant", content: text }], start: 0, total: 1 };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("SessionController per-message actions", () => {
  it("navigates from a user message, refreshes history, and restores its text to the editor", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const replacePromptEditorText = vi.fn();
    const editFromHere = vi.fn<typeof defaultApi.editFromHere>(() => Promise.resolve({ cancelled: false }));
    const api: typeof defaultApi = {
      ...defaultApi,
      editFromHere,
      messages: () => Promise.resolve(page("branch before the selected user message")),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    await controller.editFromHere("assistant-entry-1", "Revise this request");

    expect(editFromHere).toHaveBeenCalledExactlyOnceWith(oldSession, "assistant-entry-1", "local");
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "branch before the selected user message" }] }]);
    expect(loadDraft(sessionKey(oldSession.id))).toBe("Revise this request");
    expect(replacePromptEditorText).toHaveBeenCalledExactlyOnceWith({
      machineId: "local",
      sessionId: oldSession.id,
      text: "Revise this request",
    });
  });

  it("selects the independent session returned by a user-message fork", async () => {
    const forkedSession = {
      ...oldSession,
      id: "forked-session",
      path: "/tmp/forked-session.jsonl",
      messageCount: 2,
      firstMessage: "Start here",
      parentSessionPath: oldSession.path,
    };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const forkFromHere = vi.fn<typeof defaultApi.forkFromHere>(() => Promise.resolve({ cancelled: false, session: forkedSession }));
    const api: typeof defaultApi = {
      ...defaultApi,
      forkFromHere,
      messages: (session) => Promise.resolve(page(`history for ${typeof session === "string" ? session : session.id}`)),
      status: (session) => Promise.resolve(status(typeof session === "string" ? session : session.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const socket = new FakeSocket();
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket },
    );

    await controller.forkFromHere("user-entry-2");

    expect(forkFromHere).toHaveBeenCalledExactlyOnceWith(oldSession, "user-entry-2", "local");
    expect(state.selectedSession).toEqual(forkedSession);
    expect(state.sessions[0]).toEqual(forkedSession);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "history for forked-session" }] }]);
    expect(socket.connectedSessionIds).toEqual(["forked-session"]);
  });
});
