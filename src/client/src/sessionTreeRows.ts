import type { SessionInfo } from "./api";

export interface SessionRow {
  session: SessionInfo;
  depth: number;
  hasMissingParent: boolean;
  external: boolean;
  hasChildren: boolean;
  folded: boolean;
}

export interface SessionRowsOptions {
  currentWorkspacePath?: string;
  knownWorkspacePaths?: ReadonlySet<string>;
  foldedSessionPaths?: ReadonlySet<string>;
}

function availableSessionTreeSessions(sessions: readonly SessionInfo[], options: SessionRowsOptions): SessionInfo[] {
  if (options.knownWorkspacePaths === undefined) return [...sessions];
  return sessions.filter((session) => session.cwd === options.currentWorkspacePath || options.knownWorkspacePaths?.has(session.cwd) === true);
}

/**
 * Projects a session catalog into the tree visible from a workspace. Parents
 * and children may live in different project workspaces, so the projection
 * retains the full related family while marking external rows for the caller.
 */
export function sessionRowsForCurrentTree(sessions: SessionInfo[], options: SessionRowsOptions = {}): SessionRow[] {
  const availableSessions = availableSessionTreeSessions(sessions, options);
  const byPath = new Map(availableSessions.map((session) => [session.path, session]));
  const childrenByPath = sessionChildrenByParentPath(availableSessions, byPath);
  const anchorPaths = availableSessions
    .filter((session) => options.currentWorkspacePath === undefined ? session.archived !== true : session.cwd === options.currentWorkspacePath)
    .map((session) => session.path);
  const relatedPaths = relatedSessionPaths(anchorPaths, byPath, childrenByPath);
  const visiblePaths = unarchivedPathsWithAncestors(relatedPaths, byPath);
  return sessionRows(availableSessions.filter((session) => visiblePaths.has(session.path)), options);
}

export function sessionRowsForSearch(sessions: SessionInfo[], options: SessionRowsOptions = {}): SessionRow[] {
  const { foldedSessionPaths: _ignoredFoldedPaths, ...visibilityOptions } = options;
  void _ignoredFoldedPaths;
  return sessionRows(availableSessionTreeSessions(sessions, visibilityOptions), visibilityOptions);
}

export function sessionRows(sessions: SessionInfo[], options: SessionRowsOptions = {}): SessionRow[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  const childrenByPath = sessionChildrenByParentPath(sessions, byPath);
  const roots = sessions.filter((session) => {
    const parentPath = session.parentSessionPath;
    return parentPath === undefined || !byPath.has(parentPath);
  });

  // Pinned sessions sort before unpinned, preserving existing order within each group.
  roots.sort(compareSessionPinnedFirst);

  const rows: SessionRow[] = [];
  const visit = (session: SessionInfo, depth: number, stack: Set<string>) => {
    if (stack.has(session.path)) return;
    const parentPath = session.parentSessionPath;
    const children = childrenByPath.get(session.path) ?? [];
    const folded = options.foldedSessionPaths?.has(session.path) === true;
    rows.push({
      session,
      depth,
      hasMissingParent: parentPath !== undefined && !byPath.has(parentPath),
      external: options.currentWorkspacePath !== undefined && session.cwd !== options.currentWorkspacePath,
      hasChildren: children.length > 0,
      folded,
    });
    if (folded) return;
    const nextStack = new Set(stack);
    nextStack.add(session.path);
    children.sort(compareSessionPinnedFirst);
    for (const child of children) visit(child, depth + 1, nextStack);
  };
  for (const root of roots) visit(root, 0, new Set());
  return rows;
}

function sessionChildrenByParentPath(sessions: readonly SessionInfo[], byPath: ReadonlyMap<string, SessionInfo>): Map<string, SessionInfo[]> {
  const childrenByPath = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const parentPath = session.parentSessionPath;
    if (parentPath === undefined || !byPath.has(parentPath)) continue;
    const children = childrenByPath.get(parentPath) ?? [];
    children.push(session);
    childrenByPath.set(parentPath, children);
  }
  return childrenByPath;
}

function relatedSessionPaths(
  anchorPaths: readonly string[],
  byPath: ReadonlyMap<string, SessionInfo>,
  childrenByPath: ReadonlyMap<string, readonly SessionInfo[]>,
): Set<string> {
  const relatedPaths = new Set<string>();
  const pendingPaths = [...anchorPaths];
  while (pendingPaths.length > 0) {
    const path = pendingPaths.pop();
    if (path === undefined || relatedPaths.has(path)) continue;
    const session = byPath.get(path);
    if (session === undefined) continue;
    relatedPaths.add(path);
    if (session.parentSessionPath !== undefined) pendingPaths.push(session.parentSessionPath);
    for (const child of childrenByPath.get(path) ?? []) pendingPaths.push(child.path);
  }
  return relatedPaths;
}

function unarchivedPathsWithAncestors(relatedPaths: ReadonlySet<string>, byPath: ReadonlyMap<string, SessionInfo>): Set<string> {
  const visiblePaths = new Set<string>();
  for (const path of relatedPaths) {
    const session = byPath.get(path);
    if (session?.archived === true) continue;
    visiblePaths.add(path);
    let parentPath = session?.parentSessionPath;
    const seenPaths = new Set<string>([path]);
    while (parentPath !== undefined && relatedPaths.has(parentPath) && !seenPaths.has(parentPath)) {
      seenPaths.add(parentPath);
      const parent = byPath.get(parentPath);
      if (parent === undefined) break;
      visiblePaths.add(parentPath);
      parentPath = parent.parentSessionPath;
    }
  }
  return visiblePaths;
}

function compareSessionPinnedFirst(a: SessionInfo, b: SessionInfo): number {
  const aPinned = a.pinned === true;
  const bPinned = b.pinned === true;
  if (aPinned && !bPinned) return -1;
  if (!aPinned && bPinned) return 1;
  return 0;
}
