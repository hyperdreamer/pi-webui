import { isWorkspaceTaskId, type WorkspaceTask } from "@pi-webui/workspace-tasks-domain";

export type WorkspaceTaskDraftField = "title" | "command" | "id";

export interface WorkspaceTaskDraft {
  id: string;
  title: string;
  command: string;
  description: string;
  group: string;
  confirm: boolean;
  global: boolean;
}

export type WorkspaceTaskDraftErrors = Partial<Record<WorkspaceTaskDraftField, string>>;

export type ValidateWorkspaceTaskDraftResult =
  | { ok: true; task: WorkspaceTask }
  | { ok: false; errors: WorkspaceTaskDraftErrors };

export function suggestWorkspaceTaskId(title: string): string {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (id === "") return "task";
  return /^\d/u.test(id) ? `task-${id}` : id;
}

export function validateAndNormalizeDraft(
  draft: WorkspaceTaskDraft,
  existingTasks: readonly WorkspaceTask[],
  originalIndex?: number,
): ValidateWorkspaceTaskDraftResult {
  const id = draft.id.trim();
  const title = draft.title.trim();
  const description = draft.description.trim();
  const group = draft.group.trim();
  const errors: WorkspaceTaskDraftErrors = {};

  if (id === "") {
    errors.id = "ID is required.";
  } else if (!isWorkspaceTaskId(id)) {
    errors.id = "ID must match ^[a-z][a-z0-9.-]*$.";
  } else if (existingTasks.some((task, index) => index !== originalIndex && task.id === id)) {
    errors.id = `Task ID "${id}" already exists.`;
  }

  if (title === "") errors.title = "Title is required.";
  if (draft.command.trim() === "") errors.command = "Command script is required.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    task: {
      id,
      title,
      command: draft.command,
      ...(description === "" ? {} : { description }),
      ...(group === "" ? {} : { group }),
      confirm: draft.confirm,
    },
  };
}
