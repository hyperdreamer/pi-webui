import { HttpRequestError, recentProjectsApi as defaultApi } from "../api";
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
  reconcileProjects?: (machineId: string) => void | Promise<void>;
}

/**
 * Owns per-machine recent-project history: loading, mutation serialization, and
 * stale-response suppression. The server is authoritative for order, so every
 * mutation response replaces local state rather than being merged.
 */
export class RecentProjectController {
  private readonly api: RecentProjectApi;
  private current: RecentProjectsState = { kind: "loading" };
  private readonly queuesByMachine = new Map<string, Promise<void>>();
  private readonly newestProjectIdByMachine = new Map<string, string>();
  private generation = 0;

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
    await this.enqueue(machineId, async () => {
      try {
        const entries = await this.api.recentProjects(machineId);
        this.newestProjectIdByMachine.delete(machineId);
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "ready", entries });
      } catch (error) {
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "failed", message: errorMessage(error) });
      }
    });
  }

  retry(): Promise<void> {
    return this.load();
  }

  /**
   * Record meaningful user work. Terminal input calls this per keystroke, so the
   * newest-entry check is synchronous and happens before any request. The check
   * is only an optimization: the store dedupes by path when this belief is stale.
   */
  recordWork(projectId: string, machineId = this.deps.machineId()): void {
    if (this.isAlreadyNewest(projectId, machineId)) return;
    const generation = this.generation;
    void this.enqueue(machineId, async () => {
      // A burst of calls for the same project can be queued before the first
      // response publishes the newest-project belief; re-check at run time so
      // no redundant request is ever issued.
      if (this.isAlreadyNewest(projectId, machineId)) return;
      try {
        const entries = await this.api.recordRecentProject(projectId, machineId);
        this.newestProjectIdByMachine.set(machineId, projectId);
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "ready", entries });
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
    await this.enqueue(machineId, async () => {
      try {
        const entries = await this.api.removeRecentProject(entryId, machineId);
        this.newestProjectIdByMachine.delete(machineId);
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "ready", entries });
      } catch (error) {
        if (error instanceof HttpRequestError && error.status === 409) {
          await this.reconcileRemovalConflict(machineId);
        }
        failure = error instanceof Error ? error : new Error(String(error));
      }
    });
    if (failure !== undefined) throw failure;
  }

  private isAlreadyNewest(projectId: string, machineId: string): boolean {
    return this.newestProjectIdByMachine.get(machineId) === projectId;
  }

  private async reconcileRemovalConflict(machineId: string): Promise<void> {
    const catalog = Promise.resolve().then(() => this.deps.reconcileProjects?.(machineId));
    const history = Promise.resolve().then(() => this.api.recentProjects(machineId));
    const results = await Promise.allSettled([catalog, history]);
    const historyResult = results[1];
    if (historyResult.status !== "fulfilled") return;
    this.newestProjectIdByMachine.delete(machineId);
    if (machineId === this.deps.machineId()) {
      this.publish({ kind: "ready", entries: historyResult.value });
    }
  }

  private enqueue(machineId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queuesByMachine.get(machineId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.catch(() => undefined);
    this.queuesByMachine.set(machineId, settled);
    void settled.then(() => {
      if (this.queuesByMachine.get(machineId) === settled) this.queuesByMachine.delete(machineId);
    });
    return run;
  }

  private isStale(generation: number, machineId: string): boolean {
    return generation !== this.generation || machineId !== this.deps.machineId();
  }

  private publish(state: RecentProjectsState): void {
    this.current = state;
    this.deps.onChange(state);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
