import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import {
  listDefaultPiSessionDirs,
  listSessionFilesInDir,
  SessionDirResolver,
  type SessionDirResolverOptions,
} from "../sessions/piSessionManagerGateway.js";
import type { ProjectUsageHeaderSession } from "./projectUsageService.js";
import { readSessionHeader, type SessionHeaderSummary } from "./sessionUsageScanner.js";

type SessionHeaderReader = (path: string) => Promise<SessionHeaderSummary | undefined>;

export async function listProjectUsageSessionHeadersInDir(
  sessionDir: string,
  readHeader: SessionHeaderReader = readSessionHeader,
): Promise<ProjectUsageHeaderSession[]> {
  const candidates: ProjectUsageHeaderSession[] = [];
  for (const path of await listSessionFilesInDir(sessionDir)) {
    const header = await readHeader(path);
    if (header?.cwd === undefined) continue;
    candidates.push({ sessionId: header.id, path, cwd: canonicalizeStoredCwd(header.cwd) });
  }
  return candidates;
}

export class ProjectUsageSessionHeaderSource {
  private readonly resolver: SessionDirResolver;

  constructor(
    options: SessionDirResolverOptions,
    private readonly readHeader: SessionHeaderReader = readSessionHeader,
  ) {
    this.resolver = new SessionDirResolver(options);
  }

  async listForCwd(cwd: string): Promise<ProjectUsageHeaderSession[]> {
    const candidates = await listProjectUsageSessionHeadersInDir(this.resolver.resolve(cwd).sessionDir, this.readHeader);
    return candidates.filter((candidate) => candidate.cwd !== "" && cwdPathsEqual(candidate.cwd, cwd));
  }

  async listAll(): Promise<ProjectUsageHeaderSession[]> {
    const candidates: ProjectUsageHeaderSession[] = [];
    for (const sessionDir of await listDefaultPiSessionDirs(this.resolver.defaultSessionsRoot())) {
      candidates.push(...await listProjectUsageSessionHeadersInDir(sessionDir, this.readHeader));
    }
    const envSessionDir = this.resolver.globalEnvSessionDir();
    if (envSessionDir !== undefined) {
      candidates.push(...await listProjectUsageSessionHeadersInDir(envSessionDir, this.readHeader));
    }
    return uniqueCandidatesByPath(candidates);
  }
}

function uniqueCandidatesByPath(candidates: readonly ProjectUsageHeaderSession[]): ProjectUsageHeaderSession[] {
  const byPath = new Map<string, ProjectUsageHeaderSession>();
  for (const candidate of candidates) byPath.set(candidate.path, candidate);
  return [...byPath.values()];
}
