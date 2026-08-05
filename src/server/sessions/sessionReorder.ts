import type {
  SessionInfo,
  SessionOrderEntry,
  SessionRef,
  SessionReorderRequest,
  SessionReorderResponse,
  SessionReorderScope,
} from "../../shared/apiTypes.js";

export type SessionReorderErrorKind = "invalid" | "not-found" | "conflict";

export class SessionReorderDomainError extends Error {
  constructor(readonly kind: SessionReorderErrorKind, message: string) {
    super(message);
    this.name = "SessionReorderDomainError";
  }
}

export interface ValidatedSessionReorder {
  sessionPaths: string[];
  response: SessionReorderResponse;
}

/**
 * Validate a complete reorder request against the full sibling/pin group
 * derived from `catalog`. Requires exact identity-set equality between the
 * submitted ordered sessions and every catalog session currently eligible
 * for `request.scope`/`request.pinned`, so a stale client cannot silently
 * drop or omit a sibling.
 */
export function validateSessionReorder(
  target: SessionRef,
  request: SessionReorderRequest,
  catalog: readonly SessionInfo[],
): ValidatedSessionReorder {
  requireTargetIncluded(target, request);
  requireDistinctIdentities(request.orderedSessions);
  const byIdentity = catalogByIdentity(catalog);
  const resolved = resolveOrderedSessions(request.orderedSessions, byIdentity);
  requireDistinctPaths(request.orderedSessions, resolved);

  const eligible = catalog.filter((session) => isEligibleForScope(session, request.scope, request.pinned));
  const eligibleIdentities = new Set(eligible.map((session) => identityKey(session.cwd, session.id)));
  const submittedIdentities = new Set(request.orderedSessions.map((ref) => identityKey(ref.cwd, ref.id)));

  for (const ref of request.orderedSessions) {
    if (!eligibleIdentities.has(identityKey(ref.cwd, ref.id))) {
      throw new SessionReorderDomainError("conflict", `Session is no longer eligible for this reorder: ${ref.id}`);
    }
  }
  for (const identity of eligibleIdentities) {
    if (!submittedIdentities.has(identity)) {
      throw new SessionReorderDomainError("conflict", "Session group changed during reorder");
    }
  }

  const sessionPaths = resolved.map((session) => session.path);
  const orderedSessions: SessionOrderEntry[] = request.orderedSessions.map((ref, manualOrder) => ({ ...ref, manualOrder }));
  return { sessionPaths, response: { orderedSessions } };
}

/**
 * Post-write guard: repeat the submitted-member existence, persistence,
 * archive, scope, and pin checks against a freshly read catalog, but do not
 * require exact identity-set equality so a session created concurrently with
 * the write remains unordered at the top rather than failing the write.
 */
export function assertSubmittedSessionsCurrent(
  target: SessionRef,
  request: SessionReorderRequest,
  catalog: readonly SessionInfo[],
): void {
  requireTargetIncluded(target, request);
  requireDistinctIdentities(request.orderedSessions);
  const byIdentity = catalogByIdentity(catalog);
  for (const ref of request.orderedSessions) {
    const session = byIdentity.get(identityKey(ref.cwd, ref.id));
    if (session === undefined) throw new SessionReorderDomainError("not-found", `Session not found: ${ref.id}`);
    if (!isEligibleForScope(session, request.scope, request.pinned)) {
      throw new SessionReorderDomainError("conflict", `Session changed during reorder: ${ref.id}`);
    }
  }
}

function requireTargetIncluded(target: SessionRef, request: SessionReorderRequest): void {
  const included = request.orderedSessions.some((ref) => ref.id === target.id && ref.cwd === target.cwd);
  if (!included) throw new SessionReorderDomainError("invalid", "Target session must be included in the ordered sessions");
}

function requireDistinctIdentities(orderedSessions: readonly SessionRef[]): void {
  const identities = new Set<string>();
  for (const ref of orderedSessions) {
    const identity = identityKey(ref.cwd, ref.id);
    if (identities.has(identity)) {
      throw new SessionReorderDomainError("invalid", "Duplicate session reference in reorder request");
    }
    identities.add(identity);
  }
}

function catalogByIdentity(catalog: readonly SessionInfo[]): Map<string, SessionInfo> {
  const byIdentity = new Map<string, SessionInfo>();
  for (const session of catalog) byIdentity.set(identityKey(session.cwd, session.id), session);
  return byIdentity;
}

function resolveOrderedSessions(orderedSessions: readonly SessionRef[], byIdentity: ReadonlyMap<string, SessionInfo>): SessionInfo[] {
  return orderedSessions.map((ref) => {
    const session = byIdentity.get(identityKey(ref.cwd, ref.id));
    if (session === undefined) throw new SessionReorderDomainError("not-found", `Session not found: ${ref.id}`);
    return session;
  });
}

function requireDistinctPaths(orderedSessions: readonly SessionRef[], resolved: readonly SessionInfo[]): void {
  const pathsSeen = new Map<string, SessionRef>();
  for (let index = 0; index < resolved.length; index += 1) {
    const session = resolved[index];
    const ref = orderedSessions[index];
    if (session === undefined || ref === undefined) continue;
    const existing = pathsSeen.get(session.path);
    if (existing !== undefined && (existing.id !== ref.id || existing.cwd !== ref.cwd)) {
      throw new SessionReorderDomainError("invalid", "Distinct sessions resolved to the same persisted path");
    }
    pathsSeen.set(session.path, ref);
  }
}

function isEligibleForScope(session: SessionInfo, scope: SessionReorderScope, pinned: boolean): boolean {
  if (session.archived === true) return false;
  if (session.persisted !== true) return false;
  if ((session.pinned === true) !== pinned) return false;
  if (scope.kind === "root") {
    if (session.parentSessionPath !== undefined) return false;
    return session.cwd === scope.cwd;
  }
  return session.parentSessionPath === scope.parentSessionPath;
}

function identityKey(cwd: string, id: string): string {
  return JSON.stringify([cwd, id]);
}
