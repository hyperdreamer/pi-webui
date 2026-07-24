import type { MachineRuntime, SessionInfo, SessionStatus } from "./api";
import { isCachedNewSessionInfo } from "./cachedNewSessions";
import { PI_WEBUI_CAPABILITIES, supportsPiWebUiCapability } from "../../shared/capabilities";

export type SessionPersistenceState = "persisted" | "transient" | "unknown";

export interface SessionPersistenceOptions {
  /**
   * True when the selected runtime advertises reliable persisted/transient
   * session state. Legacy federated runtimes omit this field, so missing data
   * must preserve the old "listed sessions are persisted" behavior.
   */
  authoritative?: boolean;
}

export function hasAuthoritativeSessionPersistence(runtime: Pick<MachineRuntime, "ok" | "capabilities"> | undefined): boolean {
  return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsPersistedState);
}

export function sessionPersistenceOptionsForRuntime(runtime: Pick<MachineRuntime, "ok" | "capabilities"> | undefined): SessionPersistenceOptions {
  return { authoritative: hasAuthoritativeSessionPersistence(runtime) };
}

export function sessionPersistenceState(session: SessionInfo | undefined, status?: SessionStatus, options: SessionPersistenceOptions = {}): SessionPersistenceState {
  if (session === undefined) return "unknown";
  const statusPersisted = status?.sessionId === session.id ? status.persisted : undefined;
  const persisted = statusPersisted ?? session.persisted;
  if (persisted === true) return "persisted";
  if (persisted === false || isCachedNewSessionInfo(session)) return "transient";
  if (options.authoritative !== true) return "persisted";
  return "unknown";
}

export function isArchivableSessionInfo(session: SessionInfo | undefined, status?: SessionStatus, options?: SessionPersistenceOptions): boolean {
  return session !== undefined && session.archived !== true && sessionPersistenceState(session, status, options) === "persisted";
}

export function isTransientNewSessionInfo(session: SessionInfo | undefined, status?: SessionStatus, options?: SessionPersistenceOptions): boolean {
  return session !== undefined && session.archived !== true && sessionPersistenceState(session, status, options) === "transient";
}
