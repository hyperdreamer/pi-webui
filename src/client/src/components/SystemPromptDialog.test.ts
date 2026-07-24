import { describe, expect, it, vi } from "vitest";
import { sessionsApi, type Machine, type SessionInfo } from "../api";
import { SystemPromptDialog } from "./SystemPromptDialog";

type SystemPromptApi = Pick<typeof sessionsApi, "systemPrompt">;

const session: SessionInfo = {
  id: "session-a",
  cwd: "/work/project-a",
  path: "/sessions/session-a.jsonl",
  created: "2026-06-04T00:00:00.000Z",
  modified: "2026-06-04T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "Show the system prompt",
};

describe("system-prompt-dialog", () => {
  it("loads the selected session's current prompt from the selected machine", async () => {
    const promptApi: SystemPromptApi = { systemPrompt: vi.fn<SystemPromptApi["systemPrompt"]>().mockResolvedValue({ systemPrompt: "Follow AGENTS.md." }) };
    const dialog = configuredDialog(promptApi);

    await callDialogPromise(dialog, "loadSystemPrompt");

    expect(promptApi.systemPrompt).toHaveBeenCalledWith(session, "remote-a");
    expect(Reflect.get(dialog, "systemPrompt")).toBe("Follow AGENTS.md.");
  });

  it("preserves empty and not-yet-loaded prompts for the source-compatible display states", async () => {
    const promptApi: SystemPromptApi = {
      systemPrompt: vi.fn<SystemPromptApi["systemPrompt"]>()
        .mockResolvedValueOnce({ systemPrompt: "" })
        .mockResolvedValueOnce({}),
    };
    const dialog = configuredDialog(promptApi);

    await callDialogPromise(dialog, "loadSystemPrompt");
    expect(Reflect.get(dialog, "systemPrompt")).toBe("");

    await callDialogPromise(dialog, "loadSystemPrompt");
    expect(Reflect.get(dialog, "systemPrompt")).toBeUndefined();
  });
});

function configuredDialog(sessionsApi: SystemPromptApi): SystemPromptDialog {
  const dialog = new SystemPromptDialog();
  dialog.machine = machine("remote-a");
  dialog.session = session;
  dialog.sessionsApi = sessionsApi;
  return dialog;
}

function machine(id: string): Machine {
  return {
    id,
    name: "Remote build host",
    kind: "remote",
    baseUrl: "https://remote.example.test/",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

async function callDialogPromise(dialog: SystemPromptDialog, methodName: string): Promise<void> {
  const method: unknown = Reflect.get(dialog, methodName);
  if (typeof method !== "function") throw new Error(`SystemPromptDialog.${methodName} is not callable`);
  const result: unknown = method.call(dialog);
  if (!(result instanceof Promise)) throw new Error(`SystemPromptDialog.${methodName} did not return a promise`);
  await result;
}
