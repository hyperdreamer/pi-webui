import { assignBuckets, type CandidateInput, type ProjectUsageBucket } from "./projectUsageBuckets.js";
import { addUsageTotals, emptyUsageTotals, type UsageTotals } from "./sessionUsageScanner.js";

export interface ProjectUsageScopeRequest {
  projectPath: string;
  liveCwds: readonly string[];
}

export interface ProjectUsageBucketTotals extends UsageTotals {
  sessionCount: number;
}

export interface ProjectUsageReport {
  projectPath: string;
  buckets: Record<ProjectUsageBucket, ProjectUsageBucketTotals>;
  total: ProjectUsageBucketTotals;
  generatedAt: string;
}

export interface ProjectUsageStoreSession {
  id: string;
  path: string;
  cwd: string;
}

export interface ProjectUsageArchivedSession {
  sessionId: string;
  cwd: string;
  archivePath?: string;
  originalPath?: string;
}

export interface ProjectUsageCandidateSource {
  listForCwd(cwd: string): Promise<ProjectUsageStoreSession[]>;
  listAll(): Promise<ProjectUsageStoreSession[]>;
  listArchived(): Promise<ProjectUsageArchivedSession[]>;
}

export interface ProjectUsageCache {
  totalsFor(sessionId: string, path: string): Promise<UsageTotals>;
  flush(): Promise<void>;
}

export interface ProjectUsageServiceOptions {
  candidates: ProjectUsageCandidateSource;
  cache: ProjectUsageCache;
  now?: () => Date;
}

function emptyBucketTotals(): ProjectUsageBucketTotals {
  return { ...emptyUsageTotals(), sessionCount: 0 };
}

function addToBucket(bucket: ProjectUsageBucketTotals, totals: UsageTotals): ProjectUsageBucketTotals {
  return { ...addUsageTotals(bucket, totals), sessionCount: bucket.sessionCount + 1 };
}

/**
 * Assemble a project's usage report on demand.
 *
 * No project-level total is persisted, because bucket assignment depends on
 * scope resolved at request time: which worktrees exist now and which sessions
 * are archived now. Only per-session totals are cached.
 */
export class ProjectUsageService {
  private readonly inFlight = new Map<string, Promise<ProjectUsageReport>>();

  constructor(private readonly options: ProjectUsageServiceOptions) {}

  async report(scope: ProjectUsageScopeRequest): Promise<ProjectUsageReport> {
    const existing = this.inFlight.get(scope.projectPath);
    if (existing !== undefined) return existing;

    const run = this.buildReport(scope).finally(() => {
      this.inFlight.delete(scope.projectPath);
    });
    this.inFlight.set(scope.projectPath, run);
    return run;
  }

  async count(scope: ProjectUsageScopeRequest): Promise<number> {
    return (await this.collectInScopeCandidates(scope)).length;
  }

  private async buildReport(scope: ProjectUsageScopeRequest): Promise<ProjectUsageReport> {
    try {
      const candidates = await this.collectInScopeCandidates(scope);

      const buckets: Record<ProjectUsageBucket, ProjectUsageBucketTotals> = {
        live: emptyBucketTotals(),
        retired: emptyBucketTotals(),
        archived: emptyBucketTotals(),
      };
      let total = emptyBucketTotals();

      // Sequential on purpose: interleaving many multi-megabyte session streams
      // multiplies memory and lengthens event-loop turns for live sessions.
      for (const candidate of candidates) {
        const totals = await this.options.cache.totalsFor(candidate.sessionId, candidate.path);
        buckets[candidate.bucket] = addToBucket(buckets[candidate.bucket], totals);
        total = addToBucket(total, totals);
      }

      const now = this.options.now?.() ?? new Date();
      return { projectPath: scope.projectPath, buckets, total, generatedAt: now.toISOString() };
    } finally {
      await this.options.cache.flush();
    }
  }

  private async collectInScopeCandidates(scope: ProjectUsageScopeRequest) {
    const inputs = await this.collectCandidates(scope);
    return assignBuckets(inputs, { projectPath: scope.projectPath, liveCwds: scope.liveCwds });
  }

  private async collectCandidates(scope: ProjectUsageScopeRequest): Promise<CandidateInput[]> {
    const [archived, history, live] = await Promise.all([
      this.options.candidates.listArchived(),
      this.options.candidates.listAll(),
      Promise.all(scope.liveCwds.map((cwd) => this.options.candidates.listForCwd(cwd))),
    ]);

    // Archived first so a session that also still appears in the Pi store keeps
    // its archive classification and archive file path.
    return [
      ...archived.map((record) => ({
        sessionId: record.sessionId,
        path: record.archivePath ?? record.originalPath ?? "",
        cwd: record.cwd,
        archived: true,
      })),
      ...live.flat().map((session) => ({ sessionId: session.id, path: session.path, cwd: session.cwd })),
      ...history.map((session) => ({ sessionId: session.id, path: session.path, cwd: session.cwd })),
    ];
  }
}
