import type { SessionInfo } from "./api";
import { sessionLabel } from "./sessionLabels";
import type { SessionRow } from "./sessionTreeRows";

export function hasSessionSearchQuery(query: string): boolean {
  return query.trim() !== "";
}

export function filterSessionRows(rows: readonly SessionRow[], query: string): SessionRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return [...rows];

  const byPath = new Map(rows.map((row) => [row.session.path, row]));
  const visiblePaths = new Set<string>();
  for (const row of rows) {
    if (!sessionSearchText(row.session).includes(normalizedQuery)) continue;
    let path: string | undefined = row.session.path;
    const seenPaths = new Set<string>();
    while (path !== undefined && !seenPaths.has(path)) {
      seenPaths.add(path);
      const current = byPath.get(path);
      if (current === undefined) break;
      visiblePaths.add(path);
      path = current.session.parentSessionPath;
    }
  }
  return rows.filter((row) => visiblePaths.has(row.session.path));
}

function sessionSearchText(session: SessionInfo): string {
  return [sessionLabel(session), session.firstMessage, session.id, session.cwd].join("\n").toLocaleLowerCase();
}
