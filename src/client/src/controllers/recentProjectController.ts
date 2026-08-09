import { recentProjectsApi as defaultApi } from "../api";
import type { RecentProjectEntry } from "../../../shared/apiTypes";

const RECORD_OPERATION = "record recent project";

export type RecentProjectsState =
  | { kind: "loading" }
  | { kind: "ready"; entries: RecentProjectEntry[] }
  | { kind: "failed"; message: string };

export interface RecentProjectApi {
  recentProjects(machineId?: string): Promise<RecentProjectEntry[]>;
  recordRecentProject(projectId: string, machineId?: string): Promise<RecentProjectEntry[]>;
  removeRecentProject(entryId: string, machineId?: string): Promise<RecentProjectEntry[]>;
}

export interface RecentProjectControllerDependencies {
  api?: RecentProjectApi;
  machineId: () => string;
  onChange: (state: RecentProjectsState) => void;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

/**
 * Owns per-machine recent-project history: loading, mutation serialization, and
 * stale-response suppression. The server is authoritative for order, so every
 * mutation response replaces local state rather than being merged.
 */
export class RecentProjectController {
  private readonly api: RecentProjectApi;
  private current: RecentProjectsState = { kind: "loading" };
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private newestProjectId: string | undefined;

  constructor(private readonly deps: RecentProjectControllerDependencies) {
    this.api = deps.api ?? defaultApi;
  }

  get state(): RecentProjectsState {
    return this.current;
  }

  async load(): Promise<void> {
    const machineId = this.deps.machineId();
    const generation = ++this.generation;
    this.publish({ kind: "loading" });
    try {
      const entries = await this.api.recentProjects(machineId);
      if (this.isStale(generation, machineId)) return;
      this.publish({ kind: "ready", entries });
    } catch (error) {
      if (this.isStale(generation, machineId)) return;
      this.publish({ kind: "failed", message: errorMessage(error) });
    }
  }

  retry(): Promise<void> {
    return this.load();
  }

  /**
   * Record meaningful user work. Terminal input calls this per keystroke, so the
   * newest-entry check is synchronous and happens before any request. The check
   * is only an optimization: the store dedupes by path when this belief is stale.
   */
  recordWork(projectId: string): void {
    if (this.isAlreadyNewest(projectId)) return;
    const machineId = this.deps.machineId();
    const generation = this.generation;
    void this.enqueue(async () => {
      // A burst of calls for the same project can be queued before the first
      // response publishes the newest-project belief; re-check at run time so
      // no redundant request is ever issued.
      if (this.isAlreadyNewest(projectId)) return;
      try {
        const entries = await this.api.recordRecentProject(projectId, machineId);
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "ready", entries });
        this.newestProjectId = projectId;
      } catch (error) {
        // Recording is secondary to the work that succeeded; never surface it as
        // a blocking failure or discard the order we already have.
        this.deps.onBackgroundError?.(RECORD_OPERATION, error);
      }
    });
  }

  async removeEntry(entryId: string): Promise<void> {
    const machineId = this.deps.machineId();
    const generation = this.generation;
    let failure: Error | undefined;
    await this.enqueue(async () => {
      try {
        const entries = await this.api.removeRecentProject(entryId, machineId);
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "ready", entries });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    });
    if (failure !== undefined) throw failure;
  }

  private isAlreadyNewest(projectId: string): boolean {
    return this.newestProjectId === projectId;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private isStale(generation: number, machineId: string): boolean {
    return generation !== this.generation || machineId !== this.deps.machineId();
  }

  private publish(state: RecentProjectsState): void {
    this.current = state;
    this.newestProjectId = undefined;
    this.deps.onChange(state);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
