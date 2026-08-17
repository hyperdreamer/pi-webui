import type { WorkspacePanelTerminal } from "@hyperdreamer/pi-webui/plugin-api";
import type { WorkspaceTask, WorkspaceTaskRef } from "@pi-webui/workspace-tasks-domain";

export function runWorkspaceTaskInTerminal(
  terminal: WorkspacePanelTerminal,
  ref: WorkspaceTaskRef,
  task: WorkspaceTask,
): ReturnType<WorkspacePanelTerminal["runCommand"]> {
  return terminal.runCommand({
    title: task.title,
    command: task.command,
    open: true,
    metadata: {
      "pi.plugin": "workspace-tasks",
      "task.scope": ref.scope,
      "task.id": ref.id,
    },
  });
}
