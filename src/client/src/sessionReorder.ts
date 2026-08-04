import { SESSION_REORDER_LIMIT, type SessionReorderRequest } from "../../shared/apiTypes";
import type { SessionInfo } from "./api";
import type { SessionRow } from "./sessionTreeRows";

export const SESSION_REORDER_DRAG_THRESHOLD_PX = 6;
export const SESSION_REORDER_EDGE_ZONE_PX = 32;
export const SESSION_REORDER_MAX_SCROLL_PX = 12;

export interface SessionReorderPeerRect {
  sessionPath: string;
  top: number;
  bottom: number;
}

export function eligibleSessionReorderGroup(
  rows: readonly SessionRow[],
  selected: SessionInfo,
  currentWorkspacePath: string | undefined,
): SessionInfo[] {
  const selectedRow = rows.find((row) => sameSession(row.session, selected));
  if (selectedRow === undefined
    || selectedRow.external
    || selectedRow.hasMissingParent
    || !isReorderableSession(selectedRow.session)) return [];

  const pinned = selected.pinned === true;
  if (selected.parentSessionPath === undefined) {
    if (selectedRow.depth !== 0 || selected.cwd !== currentWorkspacePath) return [];
    return rows
      .filter((row) => row.depth === 0
        && !row.external
        && row.session.cwd === selected.cwd
        && row.session.parentSessionPath === undefined
        && (row.session.pinned === true) === pinned
        && isReorderableSession(row.session))
      .map((row) => row.session);
  }

  return rows
    .filter((row) => row.depth > 0
      && !row.hasMissingParent
      && row.session.parentSessionPath === selected.parentSessionPath
      && (row.session.pinned === true) === pinned
      && isReorderableSession(row.session))
    .map((row) => row.session);
}

export function sessionReorderRequest(
  selected: SessionInfo,
  group: readonly SessionInfo[],
  catalogCwds: readonly string[],
): SessionReorderRequest {
  const uniqueCatalogCwds = [...new Set(catalogCwds)];
  if (group.length > SESSION_REORDER_LIMIT || uniqueCatalogCwds.length > SESSION_REORDER_LIMIT) {
    throw new Error(`Session reorder exceeds the ${String(SESSION_REORDER_LIMIT)}-entry limit`);
  }
  return {
    cwd: selected.cwd,
    scope: selected.parentSessionPath === undefined
      ? { kind: "root", cwd: selected.cwd }
      : { kind: "children", parentSessionPath: selected.parentSessionPath },
    pinned: selected.pinned === true,
    catalogCwds: uniqueCatalogCwds,
    orderedSessions: group.map(({ id, cwd }) => ({ id, cwd })),
  };
}

export function moveSessionInGroup(
  group: readonly SessionInfo[],
  selectedId: string,
  insertionIndex: number,
): SessionInfo[] {
  const selectedIndex = group.findIndex((session) => session.id === selectedId);
  if (selectedIndex === -1) return [...group];
  const selected = group[selectedIndex];
  if (selected === undefined) return [...group];
  const remaining = group.filter((_session, index) => index !== selectedIndex);
  const clampedIndex = Math.max(0, Math.min(Math.trunc(insertionIndex), remaining.length));
  return [...remaining.slice(0, clampedIndex), selected, ...remaining.slice(clampedIndex)];
}

export function sessionReorderInsertionIndex(
  pointerY: number,
  peerRects: readonly SessionReorderPeerRect[],
): number {
  const index = peerRects.findIndex((rect) => pointerY < rect.top + (rect.bottom - rect.top) / 2);
  return index === -1 ? peerRects.length : index;
}

export function sessionReorderThresholdReached(
  origin: { x: number; y: number },
  current: { x: number; y: number },
): boolean {
  return Math.hypot(current.x - origin.x, current.y - origin.y) >= SESSION_REORDER_DRAG_THRESHOLD_PX;
}

export function sessionReorderSubtreePaths(rows: readonly SessionRow[], sessionPath: string): string[] {
  const startIndex = rows.findIndex((row) => row.session.path === sessionPath);
  if (startIndex === -1) return [];
  const root = rows[startIndex];
  if (root === undefined) return [];
  const paths: string[] = [];
  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (index !== startIndex && row.depth <= root.depth) break;
    paths.push(row.session.path);
  }
  return paths;
}

export function sessionReorderEdgeScrollDelta(pointerY: number, top: number, bottom: number): number {
  if (pointerY < top + SESSION_REORDER_EDGE_ZONE_PX) {
    const proximity = Math.min(1, (top + SESSION_REORDER_EDGE_ZONE_PX - pointerY) / SESSION_REORDER_EDGE_ZONE_PX);
    return -Math.ceil(proximity * SESSION_REORDER_MAX_SCROLL_PX);
  }
  if (pointerY > bottom - SESSION_REORDER_EDGE_ZONE_PX) {
    const proximity = Math.min(1, (pointerY - (bottom - SESSION_REORDER_EDGE_ZONE_PX)) / SESSION_REORDER_EDGE_ZONE_PX);
    return Math.ceil(proximity * SESSION_REORDER_MAX_SCROLL_PX);
  }
  return 0;
}

function isReorderableSession(session: SessionInfo): boolean {
  return session.persisted === true && session.archived !== true;
}

function sameSession(left: SessionInfo, right: SessionInfo): boolean {
  return left.id === right.id && left.cwd === right.cwd && left.path === right.path;
}
