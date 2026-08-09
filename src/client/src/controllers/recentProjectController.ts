import { HttpRequestError, recentProjectsApi as defaultApi } from "../api";
import type { RecentProjectEntry } from "../../../shared/apiTypes";

const RECORD_OPERATION = "record recent project";

interface RecordWorkIntent {
  projectId: string;
}

export type RecentProjectsState =
  | { kind: "loading" }
  | { kind: "ready"; entries: RecentProjectEntry[] }
  | { kind: "failed"; message: string };

export interface RecentProjectApi {
  recentProjects(machineId?: string): Promise<RecentProjectEntry[]>;
  recordRecentProject(projectId: string, machineId?: string): Promise<RecentProjectEntry[]>;
  removeRecentProject(entryId: string, machineId?: string): Promise<RecentProjectEntry[]>;
}

export type RecentProjectRemovalOutcome =
  | { kind: "removed" }
  | { kind: "registered-conflict"; error: HttpRequestError };

export interface RecentProjectControllerDependencies {
  api?: RecentProjectApi;
  machineId: () => string;
  onChange: (state: RecentProjectsState) => void;
  onBackgroundError?: (operation: string, error: unknown) => void;
  reconcileProjects?: (machineId: string) => boolean | undefined | Promise<boolean | undefined>;
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
  private readonly authoritativeProjectIdByMachine = new Map<string, string>();
  private readonly latestIntentByMachine = new Map<string, RecordWorkIntent>();
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
    // Invalidate pre-load intent and authority synchronously so later accepted
    // work joins the queue instead of being discarded before it can be issued.
    this.latestIntentByMachine.delete(machineId);
    this.authoritativeProjectIdByMachine.delete(machineId);
    this.publish({ kind: "loading" });
    await this.enqueue(machineId, async () => {
      // An operation queued before this load may complete after load issuance
      // and restore authority; clear it once more before the GET attempt. Do not
      // clear a work intent accepted after this load was issued.
      this.authoritativeProjectIdByMachine.delete(machineId);
      try {
        const entries = await this.api.recentProjects(machineId);
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
    if (this.latestIntentByMachine.get(machineId)?.projectId === projectId) return;
    const intent: RecordWorkIntent = { projectId };
    this.latestIntentByMachine.set(machineId, intent);
    const generation = this.generation;
    void this.enqueue(machineId, async () => {
      // Call-time intent and completed authority are deliberately separate: an
      // operation must not mistake its own queued intent for completed work.
      if (this.authoritativeProjectIdByMachine.get(machineId) === projectId) return;
      try {
        const entries = await this.api.recordRecentProject(projectId, machineId);
        this.authoritativeProjectIdByMachine.set(machineId, projectId);
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "ready", entries });
      } catch (error) {
        if (this.latestIntentByMachine.get(machineId) === intent) this.latestIntentByMachine.delete(machineId);
        // Recording is secondary to the work that succeeded; never surface it as
        // a blocking failure or discard the order we already have.
        this.deps.onBackgroundError?.(RECORD_OPERATION, error);
      }
    });
  }

  async removeEntry(entryId: string): Promise<RecentProjectRemovalOutcome> {
    const machineId = this.deps.machineId();
    this.latestIntentByMachine.delete(machineId);
    this.authoritativeProjectIdByMachine.delete(machineId);
    const generation = this.generation;
    let outcome: RecentProjectRemovalOutcome | undefined;
    let failure: Error | undefined;
    await this.enqueue(machineId, async () => {
      try {
        const entries = await this.api.removeRecentProject(entryId, machineId);
        this.authoritativeProjectIdByMachine.delete(machineId);
        if (!this.isStale(generation, machineId)) this.publish({ kind: "ready", entries });
        outcome = { kind: "removed" };
      } catch (error) {
        if (error instanceof HttpRequestError && error.status === 409) {
          const reconciled = await this.reconcileRemovalConflict(machineId);
          if (reconciled) {
            outcome = { kind: "registered-conflict", error };
            return;
          }
        }
        failure = error instanceof Error ? error : new Error(String(error));
      }
    });
    if (failure !== undefined) throw failure;
    if (outcome === undefined) throw new Error("Recent project removal completed without an outcome");
    return outcome;
  }

  private async reconcileRemovalConflict(machineId: string): Promise<boolean> {
    const catalog = Promise.resolve().then(() => this.deps.reconcileProjects?.(machineId));
    const history = Promise.resolve().then(() => this.api.recentProjects(machineId));
    const results = await Promise.allSettled([catalog, history]);
    const [catalogResult, historyResult] = results;
    if (catalogResult.status !== "fulfilled" || catalogResult.value === false || historyResult.status !== "fulfilled") return false;
    this.authoritativeProjectIdByMachine.delete(machineId);
    if (machineId === this.deps.machineId()) {
      this.publish({ kind: "ready", entries: historyResult.value });
    }
    return true;
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
