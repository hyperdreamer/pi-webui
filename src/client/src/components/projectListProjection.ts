import type { Project, Workspace, WorkspaceActivity } from "../api";
import { isDirectoryAncestor, projectDescendantIds } from "../../../shared/projectAncestry";
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

export interface ProjectTreeRow {
  project: Project;
  depth: number;
  hasChildren: boolean;
  folded: boolean;
}

export interface ProjectTreeOptions {
  queryText?: string;
  selectedProjectId?: string;
  expandedProjectIds?: ReadonlySet<string>;
  workspacesByProjectId?: Record<string, Workspace[]>;
  activities?: Record<string, WorkspaceActivity>;
}

interface ProjectHierarchy {
  parentIdByProjectId: Map<string, string>;
  childIdsByParentId: Map<string, string[]>;
}

/**
 * Nearest registered ancestor wins, so the longest matching ancestor path is
 * the parent. Strict ancestry guarantees a parent path is shorter than its
 * child's, so the relation cannot contain a cycle.
 */
function projectHierarchy(projects: readonly Project[]): ProjectHierarchy {
  const parentIdByProjectId = new Map<string, string>();
  const childIdsByParentId = new Map<string, string[]>();

  for (const project of projects) {
    let parent: Project | undefined;
    for (const candidate of projects) {
      if (candidate.id === project.id) continue;
      if (!isDirectoryAncestor(candidate.path, project.path)) continue;
      if (parent === undefined || candidate.path.length > parent.path.length) parent = candidate;
    }
    if (parent === undefined) continue;
    parentIdByProjectId.set(project.id, parent.id);
    childIdsByParentId.set(parent.id, [...(childIdsByParentId.get(parent.id) ?? []), project.id]);
  }

  return { parentIdByProjectId, childIdsByParentId };
}

function ancestorIds(projectId: string, parentIdByProjectId: ReadonlyMap<string, string>): string[] {
  const ancestors: string[] = [];
  const seen = new Set<string>([projectId]);
  let current = parentIdByProjectId.get(projectId);
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    ancestors.push(current);
    current = parentIdByProjectId.get(current);
  }
  return ancestors;
}

function depthByProjectId(
  projects: readonly Project[],
  parentIdByProjectId: ReadonlyMap<string, string>,
): Map<string, number> {
  const depths = new Map<string, number>();
  for (const project of projects) {
    depths.set(project.id, ancestorIds(project.id, parentIdByProjectId).length);
  }
  return depths;
}

/**
 * Visible rows under an active query: every match plus its registered
 * ancestors, so a nested match keeps its directory context. Fold state is
 * deliberately ignored here and left untouched by the caller.
 */
function searchVisibleIds(
  projects: readonly Project[],
  queryText: string,
  parentIdByProjectId: ReadonlyMap<string, string>,
): Set<string> {
  const visible = new Set<string>();
  for (const match of filterProjects(projects, queryText)) {
    visible.add(match.id);
    for (const ancestorId of ancestorIds(match.id, parentIdByProjectId)) visible.add(ancestorId);
  }
  return visible;
}

/**
 * Visible rows under normal fold state. Ancestors of the selected project are
 * treated as open for this projection only, which never writes back into the
 * caller's remembered expansion set.
 */
function foldVisibleIds(
  projects: readonly Project[],
  hierarchy: ProjectHierarchy,
  expandedProjectIds: ReadonlySet<string>,
  selectedProjectId: string | undefined,
): Set<string> {
  const forcedOpenIds = new Set(
    selectedProjectId === undefined
      ? []
      : ancestorIds(selectedProjectId, hierarchy.parentIdByProjectId),
  );

  const visible = new Set<string>();
  const visit = (projectId: string): void => {
    if (visible.has(projectId)) return;
    visible.add(projectId);
    if (!expandedProjectIds.has(projectId) && !forcedOpenIds.has(projectId)) return;
    for (const childId of hierarchy.childIdsByParentId.get(projectId) ?? []) visit(childId);
  };

  for (const project of projects) {
    if (hierarchy.parentIdByProjectId.has(project.id)) continue;
    visit(project.id);
  }
  return visible;
}

/**
 * Flatten the project catalog into pre-order display rows. Each sibling group
 * is ordered by the existing pinned/active/source rules, so directory
 * structure outranks pinning without changing how peers sort.
 */
export function projectTreeRows(
  projects: readonly Project[],
  options: ProjectTreeOptions = {},
): ProjectTreeRow[] {
  const {
    queryText = "",
    selectedProjectId,
    expandedProjectIds = new Set<string>(),
    workspacesByProjectId = {},
    activities = {},
  } = options;

  const hierarchy = projectHierarchy(projects);
  const searching = queryText.trim() !== "";
  const visibleIds = searching
    ? searchVisibleIds(projects, queryText, hierarchy.parentIdByProjectId)
    : foldVisibleIds(projects, hierarchy, expandedProjectIds, selectedProjectId);
  const depths = depthByProjectId(projects, hierarchy.parentIdByProjectId);
  const projectsById = new Map(projects.map((project) => [project.id, project]));

  const rows: ProjectTreeRow[] = [];
  const emitGroup = (group: readonly Project[]): void => {
    for (const project of displayedProjects(group, "", workspacesByProjectId, activities)) {
      if (!visibleIds.has(project.id)) continue;
      const childIds = hierarchy.childIdsByParentId.get(project.id) ?? [];
      const hasChildren = childIds.length > 0;
      const visibleChildren = childIds
        .map((childId) => projectsById.get(childId))
        .filter((child): child is Project => child !== undefined && visibleIds.has(child.id));
      rows.push({
        project,
        depth: depths.get(project.id) ?? 0,
        hasChildren,
        folded: !searching && hasChildren && visibleChildren.length === 0,
      });
      if (visibleChildren.length > 0) emitGroup(visibleChildren);
    }
  };

  emitGroup(projects.filter((project) => !hierarchy.parentIdByProjectId.has(project.id)));
  return rows;
}

/** The target plus every descendant, for confirmation counts and close-with-subprojects. Delegates to the shared rule so the client count and the server removal set cannot diverge. */
export function projectSubtreeIds(projects: readonly Project[], targetId: string): string[] {
  if (!projects.some((project) => project.id === targetId)) return [];
  return [targetId, ...projectDescendantIds(projects, targetId)];
}
