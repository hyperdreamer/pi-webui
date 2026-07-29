/** A single agent-memory entry as returned by the server API. */
export interface MemoryEntry {
  id: string;
  content: string;
  category?: string;
  created?: string;
  last?: string;
  failureReason?: string;
}

/**
 * The subset of core AppState.memory that this bundled plugin consumes.
 * Defined locally so the plugin stays within the public plugin API boundary.
 */
export type MemoryWorkspaceState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
      refreshError?: string;
    }
  | { kind: "error"; message: string };
