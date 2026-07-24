import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../api";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, FakeSocket, oldSession, replacementSession, workspace, type AppState } from "./sessionController.testSupport";

describe("SessionController session renaming", () => {
  it("renames an unselected session without changing the current chat", async () => {
    const renamedSession = { ...replacementSession, name: "Renamed from list" };
    const result: CommandResult = { type: "done", session: renamedSession };
    const runCommand = vi.fn(() => Promise.resolve(result));
    const api: typeof defaultApi = { ...defaultApi, runCommand };
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession, replacementSession],
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.renameSession(replacementSession, "Renamed from list");

    expect(runCommand).toHaveBeenCalledWith(replacementSession, "/name Renamed from list", "local");
    expect(state.sessions).toEqual([oldSession, renamedSession]);
    expect(state.selectedSession).toEqual(oldSession);
  });
});
