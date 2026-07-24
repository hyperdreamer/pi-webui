import type { Project, Workspace } from "../types.js";
import { cwdPathsEqual } from "../workingDirectory.js";

/**
 * Decision describing whether a LLM-spawned session may target a given cwd.
 *
 * - `allowed: true` carries the canonical workspace path to start the session in
 *   (always one of the project's known workspace paths, so it is guaranteed
 *   visible in the web UI).
 * - `not-registered` means the spawning session's cwd belongs to no registered
 *   project, so spawning must be refused to preserve visibility.
 * - `out-of-project` means the requested cwd is not a workspace of the spawning
 *   session's project; `allowedCwds` lists the valid targets for the caller to
 *   surface.
 */
export type SpawnTargetDecision =
  | { allowed: true; cwd: string }
  | { allowed: false; reason: "not-registered" }
  | { allowed: false; reason: "out-of-project"; allowedCwds: string[] };

/**
 * Owns the rule that keeps LLM-spawned sessions visible: a spawned session may
 * only target a workspace (worktree, or root) of the registered project that
 * owns the spawning session. The rule is evaluated live so a worktree the agent
 * just created with `git worktree add` is included.
 */
export interface SpawnTargetResolver {
  /**
   * Decide whether a session spawned from `spawningCwd` may target
   * `requestedCwd` (defaulting to `spawningCwd` when omitted), returning the
   * canonical target cwd when allowed.
   */
  resolveSpawnTarget(spawningCwd: string, requestedCwd: string | undefined): Promise<SpawnTargetDecision>;
}

interface ProjectLister {
  list(): Promise<Project[]>;
}

interface WorkspaceLister {
  list(project: Project): Promise<Workspace[]>;
}

export interface ProjectScopedSpawnTargetResolverDeps {
  projects: ProjectLister;
  workspaces: WorkspaceLister;
}

/**
 * Default resolver composing the project registry and live worktree discovery.
 * It finds the registered project whose current workspace set contains the
 * spawning session's cwd, then validates the requested target against that set.
 */
export class ProjectScopedSpawnTargetResolver implements SpawnTargetResolver {
  constructor(private readonly deps: ProjectScopedSpawnTargetResolverDeps) {}

  async resolveSpawnTarget(spawningCwd: string, requestedCwd: string | undefined): Promise<SpawnTargetDecision> {
    const allowedCwds = await this.allowedSpawnTargets(spawningCwd);
    if (allowedCwds === undefined) return { allowed: false, reason: "not-registered" };
    const target = requestedCwd === undefined || requestedCwd === "" ? spawningCwd : requestedCwd;
    const match = allowedCwds.find((path) => cwdPathsEqual(path, target));
    if (match === undefined) return { allowed: false, reason: "out-of-project", allowedCwds };
    return { allowed: true, cwd: match };
  }

  /**
   * Workspace paths of the registered project that owns `spawningCwd`, or
   * `undefined` when no registered project contains it.
   */
  private async allowedSpawnTargets(spawningCwd: string): Promise<string[] | undefined> {
    const projects = await this.deps.projects.list();
    for (const project of projects) {
      const workspaces = await this.deps.workspaces.list(project);
      const paths = workspaces.map((workspace) => workspace.path);
      if (paths.some((path) => cwdPathsEqual(path, spawningCwd))) return paths;
    }
    return undefined;
  }
}
