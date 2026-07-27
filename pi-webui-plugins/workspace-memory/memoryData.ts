/** A single agent-memory entry as returned by the server API. */
export interface MemoryEntry {
  id: string;
  content: string;
  category?: string;
  created?: string;
  last?: string;
  failureReason?: string;
}
