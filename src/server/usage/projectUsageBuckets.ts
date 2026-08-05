import { resolve, sep } from "node:path";

export type ProjectUsageBucket = "live" | "retired" | "archived";

export interface UsageCandidate {
  sessionId: string;
  path: string;
  cwd: string;
  bucket: ProjectUsageBucket;
}

export interface CandidateInput {
  sessionId: string;
  path: string;
  cwd: string;
  archived?: boolean;
}

export interface ProjectUsageScope {
  projectPath: string;
  liveCwds: readonly string[];
}

/**
 * True when `cwd` is the project directory or sits beneath it.
 *
 * The separator check is load-bearing: a plain string prefix would place a
 * sibling checkout such as `/dev/pi-webui-browser-fix` inside `/dev/pi-webui`
 * and silently inflate the project's totals.
 */
export function isWithinProject(projectPath: string, cwd: string): boolean {
  const root = resolve(projectPath);
  const candidate = resolve(cwd);
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function bucketFor(input: { cwd: string; archived?: boolean }, scope: ProjectUsageScope): ProjectUsageBucket | undefined {
  if (!isWithinProject(scope.projectPath, input.cwd)) return undefined;
  if (input.archived === true) return "archived";
  const live = scope.liveCwds.some((liveCwd) => resolve(liveCwd) === resolve(input.cwd));
  return live ? "live" : "retired";
}

/**
 * Bucket every candidate, dropping out-of-scope sessions and deduplicating by
 * session id. Deduplication is required because archiving moves a session file
 * without changing its id, so the same session can be discovered twice.
 */
export function assignBuckets(inputs: readonly CandidateInput[], scope: ProjectUsageScope): UsageCandidate[] {
  const seen = new Set<string>();
  const candidates: UsageCandidate[] = [];
  for (const input of inputs) {
    if (seen.has(input.sessionId)) continue;
    const bucket = bucketFor(input, scope);
    if (bucket === undefined) continue;
    seen.add(input.sessionId);
    candidates.push({ sessionId: input.sessionId, path: input.path, cwd: input.cwd, bucket });
  }
  return candidates;
}
