import { describe, expect, it, vi } from "vitest";
import type { TerminalCommandRun, WorkspacePanelTerminal } from "@hyperdreamer/pi-webui/plugin-api";
import { type WorkspaceTask, type WorkspaceTaskRef } from "../../src/shared/workspaceTasks";
import { runWorkspaceTaskInTerminal } from "./taskRunner";

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
  metadata: { "pi.plugin": "workspace-tasks", "task.scope": "global", "task.id": "build" },
};

describe("task runner", () => {
  it.each([
    ["global", { scope: "global", id: "build" }],
    ["workspace", { scope: "workspace", id: "build" }],
  ] as const)("forwards one exact multiline command and metadata for the %s scope", async (_scope, ref) => {
    const command = "  export BUILD_MODE=ci\nprintf '%s\\n' \"$BUILD_MODE\"\n";
    const task: WorkspaceTask = { id: ref.id, title: "Verify", command, confirm: false };
    const runCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>(() => Promise.resolve({
      run: { ...run, title: task.title, command, metadata: { "pi.plugin": "workspace-tasks", "task.scope": ref.scope, "task.id": ref.id } },
      completed: Promise.resolve({ ...run, title: task.title, command, metadata: { "pi.plugin": "workspace-tasks", "task.scope": ref.scope, "task.id": ref.id } }),
    }));

    await runWorkspaceTaskInTerminal({ runCommand, open: vi.fn() }, ref, task);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith({
      title: "Verify",
      command,
      open: true,
      metadata: { "pi.plugin": "workspace-tasks", "task.scope": ref.scope, "task.id": ref.id },
    });
  });

  it("accepts a WorkspaceTaskRef rather than a bare ID", async () => {
    const ref: WorkspaceTaskRef = { scope: "workspace", id: "build" };
    const task: WorkspaceTask = { id: "build", title: "Build", command: "npm run build", confirm: false };
    const runCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>(() => Promise.resolve({ run, completed: Promise.resolve(run) }));

    const handle = await runWorkspaceTaskInTerminal({ runCommand, open: vi.fn() }, ref, task);

    expect(handle.run).toEqual(run);
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { "pi.plugin": "workspace-tasks", "task.scope": "workspace", "task.id": "build" },
    }));
  });
});
