import type { SessionActivity, SessionInfo, SessionStatus } from "./api";
import { isCachedNewSessionInfo } from "./cachedNewSessions";
import { isSessionActive } from "../../shared/activity";

export type DirectSessionActivityIndicatorKind = "session" | "sending" | "unread";
export type SessionActivityIndicatorKind = DirectSessionActivityIndicatorKind | "descendant" | "attention";

export interface SessionActivityIndicator {
  kind: SessionActivityIndicatorKind;
  label: string;
  count?: number;
}

export interface SessionActivityRuntime {
  statuses?: Readonly<Record<string, SessionStatus>>;
  activities?: Readonly<Record<string, SessionActivity>>;
  sending?: Readonly<Record<string, true>>;
  unreadSessionIds?: ReadonlySet<string>;
}

export type SessionActivityResolver = (session: SessionInfo) => SessionActivityIndicator[];

/**
 * Reports direct work for a session row. It deliberately does not inspect child
 * sessions so callers that need a tree-aware presentation can use
 * {@link sessionActivityIndicators} instead.
 */
export function sessionRowActivityKind(
  session: SessionInfo,
  status: SessionStatus | undefined,
  activity: SessionActivity | undefined,
  sending: boolean,
  unread = false,
): DirectSessionActivityIndicatorKind | undefined {
  if (!canShowSessionActivity(session)) return undefined;
  if (sending) return "sending";
  if (isSessionActive(status, activity)) return "session";
  return unread ? "unread" : undefined;
}

/**
 * Prepares tree-aware activity lookup for rendering several rows from the same
 * session collection. The collection is indexed once when the resolver is made.
 */
export function createSessionActivityResolver(
  sessions: readonly SessionInfo[],
  runtime: SessionActivityRuntime = {},
): SessionActivityResolver {
  const childrenByParentPath = indexSessionActivity(sessions);
  return (session) => canShowSessionActivity(session)
    ? sessionActivityIndicatorsFromIndex(session, childrenByParentPath, runtime)
    : [];
}

/**
 * Produces an accessible, tree-aware activity presentation for one session.
 * Descendant work is counted recursively so an idle root remains visibly active
 * while any tracked child or grandchild continues working.
 */
export function sessionActivityIndicators(
  session: SessionInfo,
  sessions: readonly SessionInfo[],
  runtime: SessionActivityRuntime = {},
): SessionActivityIndicator[] {
  if (!canShowSessionActivity(session)) return [];
  return sessionActivityIndicatorsFromIndex(session, indexSessionActivity(sessions), runtime);
}

function sessionActivityIndicatorsFromIndex(
  session: SessionInfo,
  childrenByParentPath: ReadonlyMap<string, readonly SessionInfo[]>,
  runtime: SessionActivityRuntime,
): SessionActivityIndicator[] {
  const ownKind = sessionRowActivityKind(
    session,
    runtime.statuses?.[session.id],
    runtime.activities?.[session.id],
    runtime.sending?.[session.id] === true,
    runtime.unreadSessionIds?.has(session.id) === true,
  );
  const ownAttention = sessionNeedsAttention(session, runtime);
  const descendants = descendantActivityCounts(session, childrenByParentPath, runtime);
  const indicators: SessionActivityIndicator[] = [];

  const attentionCount = descendants.attentionCount + (ownAttention ? 1 : 0);
  if (attentionCount > 0) {
    indicators.push({
      kind: "attention",
      ...(descendants.attentionCount === 0 ? {} : { count: attentionCount }),
      label: attentionLabel(ownAttention, descendants.attentionCount),
    });
  }

  if (ownKind === "sending") indicators.push({ kind: "sending", label: "Sending message" });
  else if (ownKind === "session") indicators.push({ kind: "session", label: "This session is working" });

  if (descendants.workingCount > 0) {
    indicators.push({
      kind: "descendant",
      count: descendants.workingCount,
      label: pluralizedSubsessionLabel(descendants.workingCount, "working"),
    });
  }

  if (ownKind === "unread") indicators.push({ kind: "unread", label: "Unread session activity" });
  return indicators;
}

function indexSessionActivity(sessions: readonly SessionInfo[]): ReadonlyMap<string, readonly SessionInfo[]> {
  const sessionsByPath = new Map<string, SessionInfo>();
  for (const candidate of sessions) sessionsByPath.set(candidate.path, candidate);

  const childrenByParentPath = new Map<string, SessionInfo[]>();
  for (const candidate of sessionsByPath.values()) {
    const parentPath = candidate.parentSessionPath;
    if (parentPath === undefined || !sessionsByPath.has(parentPath)) continue;
    const children = childrenByParentPath.get(parentPath) ?? [];
    children.push(candidate);
    childrenByParentPath.set(parentPath, children);
  }
  return childrenByParentPath;
}

function descendantActivityCounts(
  session: SessionInfo,
  childrenByParentPath: ReadonlyMap<string, readonly SessionInfo[]>,
  runtime: SessionActivityRuntime,
): { workingCount: number; attentionCount: number } {
  let workingCount = 0;
  let attentionCount = 0;
  const visit = (parentPath: string, ancestors: ReadonlySet<string>): void => {
    for (const child of childrenByParentPath.get(parentPath) ?? []) {
      if (ancestors.has(child.path) || !canShowSessionActivity(child)) continue;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(child.path);
      const kind = sessionRowActivityKind(
        child,
        runtime.statuses?.[child.id],
        runtime.activities?.[child.id],
        runtime.sending?.[child.id] === true,
        runtime.unreadSessionIds?.has(child.id) === true,
      );
      if (kind === "sending" || kind === "session") workingCount += 1;
      if (sessionNeedsAttention(child, runtime)) attentionCount += 1;
      visit(child.path, nextAncestors);
    }
  };

  visit(session.path, new Set([session.path]));
  return { workingCount, attentionCount };
}

function canShowSessionActivity(session: SessionInfo): boolean {
  return !isCachedNewSessionInfo(session) && session.archived !== true;
}

function sessionNeedsAttention(session: SessionInfo, runtime: SessionActivityRuntime): boolean {
  if (!canShowSessionActivity(session)) return false;
  if (runtime.activities?.[session.id]?.phase === "error") return true;
  return runtime.statuses?.[session.id]?.warnings?.some((warning) => warning.severity === "warning" || warning.severity === "error") === true;
}

function attentionLabel(ownAttention: boolean, descendantAttentionCount: number): string {
  if (ownAttention && descendantAttentionCount === 0) return "This session needs attention";
  if (!ownAttention) return subsessionsNeedAttentionLabel(descendantAttentionCount);
  return `This session and ${String(descendantAttentionCount)} ${descendantAttentionCount === 1 ? "subsession" : "subsessions"} need attention`;
}

function subsessionsNeedAttentionLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "subsession needs" : "subsessions need"} attention`;
}

function pluralizedSubsessionLabel(count: number, suffix: string): string {
  return `${String(count)} ${count === 1 ? "subsession" : "subsessions"} ${suffix}`;
}
