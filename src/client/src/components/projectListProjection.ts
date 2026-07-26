import type { Project, Workspace, WorkspaceActivity } from "../api";
import { projectActivityIndicator } from "../workspaceActivity";

export function filterProjects(projects: readonly Project[], queryText: string): Project[] {
  const query = queryText.trim().toLowerCase();
  if (query === "") return [...projects];
  return projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query));
}

export function prioritizeActiveProjects(
  projects: readonly Project[],
  workspacesByProjectId: Record<string, Workspace[]>,
  activities: Record<string, WorkspaceActivity>,
): Project[] {
  const activeProjects: Project[] = [];
  const inactiveProjects: Project[] = [];
  for (const project of projects) {
    const indicator = projectActivityIndicator(project, workspacesByProjectId[project.id] ?? [], activities);
    (indicator === undefined ? inactiveProjects : activeProjects).push(project);
  }
  return [...activeProjects, ...inactiveProjects];
}

export function displayedProjects(
  projects: readonly Project[],
  queryText: string,
  workspacesByProjectId: Record<string, Workspace[]>,
  activities: Record<string, WorkspaceActivity>,
): Project[] {
  return prioritizeActiveProjects(filterProjects(projects, queryText), workspacesByProjectId, activities);
}
