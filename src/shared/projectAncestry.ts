export interface ProjectPathRef {
  id: string;
  path: string;
}

function isSeparator(character: string | undefined): boolean {
  return character === "/" || character === "\\";
}

/**
 * Strip one trailing separator so `/work/` and `/work` compare equal. A bare
 * root normalizes to `""`, which makes the separator-boundary check below work
 * for `/work` and `C:\work` without special-casing roots.
 */
function normalizeForComparison(path: string): string {
  if (path.length > 0 && isSeparator(path.at(-1))) return path.slice(0, -1);
  return path;
}

/** True when `parentPath` is a strict directory ancestor of `childPath`. Case-sensitive by design. */
export function isDirectoryAncestor(parentPath: string, childPath: string): boolean {
  // Checked before normalization: a bare root legitimately normalizes to "",
  // so guarding afterwards would reject `/` and `C:\`. A blank path carries no
  // directory at all, and treating it as an ancestor would make it adopt every
  // absolute path — including in the server's atomic removal set.
  if (parentPath.trim() === "" || childPath.trim() === "") return false;
  const parent = normalizeForComparison(parentPath);
  const child = normalizeForComparison(childPath);
  if (parent === child) return false;
  if (!child.startsWith(parent)) return false;
  return isSeparator(child[parent.length]);
}

/**
 * Every descendant of `targetId` at any depth. Ancestry is transitive, so a
 * single pass over strict ancestors finds deep descendants without walking a
 * parent map.
 */
export function projectDescendantIds(
  projects: readonly ProjectPathRef[],
  targetId: string,
): string[] {
  const target = projects.find((project) => project.id === targetId);
  if (target === undefined) return [];
  return projects
    .filter((project) => project.id !== targetId && isDirectoryAncestor(target.path, project.path))
    .map((project) => project.id);
}
