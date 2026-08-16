import { describe, expect, it, vi } from "vitest";
import type { TerminalCommandRun, WorkspacePanelTerminal } from "@hyperdreamer/pi-webui/plugin-api";
import { runWorkspaceTaskInTerminal } from "./taskRunner";
import type { WorkspaceTask } from "./config";

const run: TerminalCommandRun = {
  id: "run1",
  origin: "workspace-tasks",
  projectId: "project/1",
  workspaceId: "workspace 1",
  terminalId: "term1",
  title: "Build",
  command: "npm run build",
  status: "running",
  createdAt: "2026-05-25T00:00:00.000Z",
  metadata: { "pi.plugin": "workspace-tasks", "task.id": "build" },
};

describe("task runner", () => {
  it("forwards one multiline command without trimming or splitting", async () => {
    const command = "  export BUILD_MODE=ci\nprintf '%s\\n' \"$BUILD_MODE\"\n";
    const task: WorkspaceTask = { id: "verify", title: "Verify", command, confirm: false };
    const runCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>(() => Promise.resolve({
      run: { ...run, command },
      completed: Promise.resolve({ ...run, command }),
    }));

    await runWorkspaceTaskInTerminal({ runCommand, open: vi.fn() }, task);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith({
      title: "Verify",
      command,
      open: true,
      metadata: { "pi.plugin": "workspace-tasks", "task.id": "verify" },
    });
  });

  it("starts workspace tasks through the public workspace terminal helper", async () => {
    const task: WorkspaceTask = { id: "build", title: "Build", command: "npm run build", confirm: false };
    const runCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>(() => Promise.resolve({ run, completed: Promise.resolve(run) }));
    const terminal: WorkspacePanelTerminal = {
      runCommand,
      open: vi.fn(),
    };

    const handle = await runWorkspaceTaskInTerminal(terminal, task);

    expect(handle.run).toEqual(run);
    await expect(handle.completed).resolves.toEqual(run);
    expect(runCommand).toHaveBeenCalledWith({
      title: "Build",
      command: "npm run build",
      open: true,
      metadata: { "pi.plugin": "workspace-tasks", "task.id": "build" },
    });
  });
});
