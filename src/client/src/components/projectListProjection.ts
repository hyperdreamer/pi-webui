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

/**
 * Order projects for display: pinned above unpinned, and within each cohort
 * running above idle. Source order is preserved inside each of the four
 * resulting groups, so a project moved to the front of `projects.json` by a
 * pin or unpin lands at the top of whichever group it belongs to.
 */
export function displayedProjects(
  projects: readonly Project[],
  queryText: string,
  workspacesByProjectId: Record<string, Workspace[]>,
  activities: Record<string, WorkspaceActivity>,
): Project[] {
  const visible = filterProjects(projects, queryText);
  const prioritizeCohort = (cohort: readonly Project[]): Project[] => prioritizeActiveProjects(cohort, workspacesByProjectId, activities);
  return [
    ...prioritizeCohort(visible.filter((project) => project.pinned === true)),
    ...prioritizeCohort(visible.filter((project) => project.pinned !== true)),
  ];
}
