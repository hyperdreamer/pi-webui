import type { WorkspacePanelTerminal } from "@hyperdreamer/pi-webui/plugin-api";
import type { WorkspaceTask } from "./config.js";

export function runWorkspaceTaskInTerminal(terminal: WorkspacePanelTerminal, task: WorkspaceTask): ReturnType<WorkspacePanelTerminal["runCommand"]> {
  return terminal.runCommand({
    title: task.title,
    command: task.command,
    open: true,
    metadata: {
      "pi.plugin": "workspace-tasks",
      "task.id": task.id,
    },
  });
}
