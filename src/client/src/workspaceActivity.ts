import type { ActivityIndicatorKind } from "./components/activityBadge";
import type { Project, Workspace, WorkspaceActivity } from "./api";

export function workspaceActivityFor(workspace: Workspace, activities: Record<string, WorkspaceActivity>): WorkspaceActivity | undefined {
  return activities[workspace.path];
}

export function workspaceActivityIndicator(activity: WorkspaceActivity | undefined): ActivityIndicatorKind | undefined {
  if (activity?.hasSessionActivity === true) return "session";
  if (activity?.hasTerminalActivity === true) return "terminal";
  return undefined;
}

export function projectActivityIndicator(project: Project, knownWorkspaces: Workspace[], activities: Record<string, WorkspaceActivity>): ActivityIndicatorKind | undefined {
  return workspaceActivitiesIndicator(matchedProjectActivities(project, knownWorkspaces, activities));
}

export function projectOwnsWorkspacePath(project: Project, knownWorkspaces: readonly Workspace[], cwd: string): boolean {
  return knownWorkspaces.some((workspace) => workspace.projectId === project.id && workspace.path === cwd)
    || cwd === project.path
    || cwd.startsWith(`${project.path}/`);
}

export function machineActivityIndicator(activities: Record<string, WorkspaceActivity> | undefined): ActivityIndicatorKind | undefined {
  return workspaceActivitiesIndicator(Object.values(activities ?? {}));
}

function workspaceActivitiesIndicator(activities: WorkspaceActivity[]): ActivityIndicatorKind | undefined {
  if (activities.some((activity) => activity.hasSessionActivity)) return "session";
  if (activities.some((activity) => activity.hasTerminalActivity)) return "terminal";
  return undefined;
}

function matchedProjectActivities(project: Project, knownWorkspaces: Workspace[], activities: Record<string, WorkspaceActivity>): WorkspaceActivity[] {
  return Object.values(activities).filter((activity) => projectOwnsWorkspacePath(project, knownWorkspaces, activity.cwd));
}
