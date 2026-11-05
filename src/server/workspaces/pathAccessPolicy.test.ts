import Fastify from "fastify";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Workspace } from "../../shared/apiTypes.js";
import { ProjectService } from "../projects/projectService.js";
import { ProjectStore } from "../storage/projectStore.js";
import { registerWorkspaceExplorerRoutes } from "../workspaceExplorerRoutes.js";
import { readWorkspaceFile } from "./fileContentService.js";
import {
  createPathAccessPolicy,
  isAbsoluteishPath,
  PathAccessRootError,
  PathAccessTargetNotFoundError,
  resolvePathAccessTarget,
  resolveWorkspacePathAccessTarget,
} from "./pathAccessPolicy.js";
import { WorkspaceService } from "./workspaceService.js";

const roots: string[] = [];

async function tempRoot(prefix = "pi-webui-path-access-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("path access policy", () => {
  it("keeps relative requests workspace-local and identifies absolute-ish paths", async () => {
    const workspace = await tempRoot();
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "main.ts"), "export {};\n");
    const policy = await createPathAccessPolicy(workspace, undefined);

    await expect(resolvePathAccessTarget(policy, "./src//main.ts")).resolves.toMatchObject({
      kind: "workspace",
      root: await realpath(workspace),
      target: await realpath(join(workspace, "src", "main.ts")),
      displayPath: "src/main.ts",
    });

    expect(isAbsoluteishPath("src/main.ts")).toBe(false);
    expect(isAbsoluteishPath("/tmp/file.txt")).toBe(true);
    expect(isAbsoluteishPath("~/SDKs/readme.md")).toBe(true);
    expect(isAbsoluteishPath("C:\\Users\\dev\\file.txt")).toBe(true);
    expect(isAbsoluteishPath("\\\\server\\share\\file.txt")).toBe(true);
    await expect(resolvePathAccessTarget(policy, join(workspace, "src", "main.ts"))).rejects.toThrow("Absolute paths are not allowed");
  });

  it("expands and canonicalizes allowed roots before resolving absolute targets", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const sdk = join(home, "SDKs");
    await mkdir(workspace);
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "readme.md"), "sdk docs\n");

    const policy = await createPathAccessPolicy(workspace, { allowedPaths: ["~/SDKs"] }, { homeDir: home });

    expect(policy.allowedRoots).toEqual([{ source: "~/SDKs", path: sdk, realPath: await realpath(sdk) }]);
    await expect(resolvePathAccessTarget(policy, "~/SDKs/readme.md", { homeDir: home })).resolves.toMatchObject({
      kind: "allowed",
      root: await realpath(sdk),
      target: await realpath(join(sdk, "readme.md")),
      displayPath: join(sdk, "readme.md"),
    });
  });

  it("validates configured roots as existing directories", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const fileRoot = join(root, "not-a-directory.txt");
    await mkdir(workspace);
    await writeFile(fileRoot, "not a directory");

    await expect(createPathAccessPolicy(workspace, { allowedPaths: [join(root, "missing")] })).rejects.toThrow("does not exist");
    await expect(createPathAccessPolicy(workspace, { allowedPaths: [fileRoot] })).rejects.toThrow("must be a directory");
    await expect(createPathAccessPolicy(workspace, { allowedPaths: ["relative/root"] })).rejects.toThrow("Allowed path must be absolute or start with ~");
  });

  it("does not validate stale allowed roots for workspace-relative requests", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "local.txt"), "local\n");

    await expect(resolveWorkspacePathAccessTarget(workspace, "local.txt", { allowedPaths: [join(root, "missing")] })).resolves.toMatchObject({
      kind: "workspace",
      target: await realpath(join(workspace, "local.txt")),
      displayPath: "local.txt",
    });
    await expect(resolveWorkspacePathAccessTarget(workspace, join(workspace, "local.txt"), { allowedPaths: [join(root, "missing")] })).rejects.toThrow("does not exist");
  });

  it("denies absolute targets outside allowed roots and through symlink escapes", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const allowed = join(root, "allowed");
    const secret = join(root, "secret");
    await mkdir(workspace);
    await mkdir(allowed);
    await mkdir(secret);
    await writeFile(join(secret, "token.txt"), "secret\n");
    const policy = await createPathAccessPolicy(workspace, { allowedPaths: [allowed] });

    await expect(resolvePathAccessTarget(policy, join(secret, "token.txt"))).rejects.toThrow("Path is outside allowed paths");

    if (await trySymlink(secret, join(allowed, "escape"))) {
      await expect(resolvePathAccessTarget(policy, join(allowed, "escape", "token.txt"))).rejects.toThrow("Path is outside allowed paths");
    }
  });

  it("allows roots configured through symlinks by checking canonical paths", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const realAllowed = join(root, "real-allowed");
    const linkedAllowed = join(root, "linked-allowed");
    await mkdir(workspace);
    await mkdir(realAllowed);
    await writeFile(join(realAllowed, "data.txt"), "allowed\n");
    if (!await trySymlink(realAllowed, linkedAllowed)) return;

    const policy = await createPathAccessPolicy(workspace, { allowedPaths: [linkedAllowed] });

    expect(policy.allowedRoots).toEqual([{ source: linkedAllowed, path: linkedAllowed, realPath: await realpath(realAllowed) }]);
    await expect(resolvePathAccessTarget(policy, join(linkedAllowed, "data.txt"))).resolves.toMatchObject({
      kind: "allowed",
      root: await realpath(realAllowed),
      target: await realpath(join(realAllowed, "data.txt")),
      displayPath: join(linkedAllowed, "data.txt"),
    });
  });
});

describe("typed path access failures", () => {
  it("wrap target ENOENT and ENOTDIR as PathAccessTargetNotFoundError", async () => {
    const workspace = await tempRoot();
    const allowed = await tempRoot();
    for (const root of [workspace, allowed]) await writeFile(join(root, "ordinary.txt"), "file");
    for (const root of [workspace, allowed]) {
      for (const request of ["missing.html", "ordinary.txt/child.html"]) {
        const absolute = join(root, request);
        let nodeMessage: string | undefined;
        try {
          await realpath(absolute);
        } catch (error) {
          if (error instanceof Error) nodeMessage = error.message;
        }
        const error = await resolveWorkspacePathAccessTarget(workspace, root === workspace ? request : absolute, { allowedPaths: [allowed] }).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(PathAccessTargetNotFoundError);
        expect(error).not.toBeInstanceOf(PathAccessRootError);
        expect(error).toHaveProperty("message", request === "missing.html" ? "Path does not exist" : nodeMessage);
      }
    }
  });

  it("wrap root canonicalization failures as PathAccessRootError", async () => {
    const workspace = await tempRoot();
    const root = await tempRoot();
    const ordinary = join(root, "ordinary.txt");
    await writeFile(ordinary, "file");
    for (const bad of [join(root, "missing"), ordinary]) {
      for (const operation of [
        () => resolveWorkspacePathAccessTarget(bad, "a.html"),
        () => resolveWorkspacePathAccessTarget(workspace, join(bad, "a.html"), { allowedPaths: [bad] }),
      ]) {
        const error = await operation().catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(PathAccessRootError);
        expect(error).not.toBeInstanceOf(PathAccessTargetNotFoundError);
        expect(error).toHaveProperty("message", expect.stringMatching(/does not exist|must be a directory/u));
      }
    }
  });

  it("wrap root failures as PathAccessRootError, never as the target type", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const workspace = await tempRoot();
    const root = await tempRoot();
    const cycle = join(root, "cycle");
    await symlink(cycle, cycle);
    const blocked = join(root, "blocked");
    await mkdir(blocked);
    await mkdir(join(blocked, "child"));
    await chmod(blocked, 0);
    try {
      for (const bad of [cycle, join(blocked, "child")]) {
        // Permission assertions require an unprivileged process; never count a root-user pass as denial evidence.
        if (bad !== cycle && process.getuid?.() === 0) continue;
        for (const operation of [
          () => resolveWorkspacePathAccessTarget(bad, "a.html"),
          () => resolveWorkspacePathAccessTarget(workspace, join(bad, "a.html"), { allowedPaths: [bad] }),
        ]) {
          const error = await operation().catch((reason: unknown) => reason);
          expect(error).toBeInstanceOf(PathAccessRootError);
          expect(error).not.toBeInstanceOf(PathAccessTargetNotFoundError);
        }
      }
      if (process.getuid?.() !== 0) {
        const error = await resolveWorkspacePathAccessTarget(blocked, "child/a.html").catch((reason: unknown) => reason);
        expect(error).not.toBeInstanceOf(PathAccessRootError);
        expect(error).toHaveProperty("code", "EACCES");
      }
    } finally {
      await chmod(blocked, 0o700);
    }
  });

  it("keep existing Explorer error messages unchanged", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "ordinary.txt"), "file");
    for (const path of ["missing.html", "ordinary.txt/child.html"]) {
      let original = "Path does not exist";
      if (path.includes("/")) {
        try {
          await realpath(join(root, path));
        } catch (error) {
          if (error instanceof Error) original = error.message;
        }
      }
      const error = await readWorkspaceFile(root, path).catch((reason: unknown) => reason);
      expect(error).toHaveProperty("message", original);
      expect(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })).toBe(JSON.stringify({ error: original }));

      const response = await injectExplorerFile(root, path);
      expect(response.statusCode).toBe(400);
      expect(response.body).toBe(JSON.stringify({ error: original }));
    }
  });
});

async function injectExplorerFile(root: string, path: string): Promise<{ statusCode: number; body: string }> {
  const app = Fastify({ logger: false });
  const project: Project = { id: "p1", name: "Project", path: root, createdAt: "2026-11-04T00:00:00.000Z" };
  const workspace: Workspace = { id: "w1", projectId: project.id, path: root, label: "main", isMain: true, isGitRepo: false, isGitWorktree: false };
  registerWorkspaceExplorerRoutes(app, fakeProjects(project), fakeWorkspaces(workspace), "/api");
  try {
    const response = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(path)}` });
    return { statusCode: response.statusCode, body: response.body };
  } finally {
    await app.close();
  }
}

function fakeProjects(project: Project): ProjectService {
  return new FakeProjectService(project);
}

function fakeWorkspaces(workspace: Workspace): WorkspaceService {
  return new FakeWorkspaceService(workspace);
}

class FakeProjectService extends ProjectService {
  constructor(private readonly project: Project) {
    super(new ProjectStore("/dev/null"));
  }

  override requireProject(projectId: string): Promise<Project> {
    return projectId === this.project.id ? Promise.resolve(this.project) : Promise.reject(new Error("Project not found"));
  }
}

class FakeWorkspaceService extends WorkspaceService {
  constructor(private readonly workspace: Workspace) {
    super();
  }

  override list(): Promise<Workspace[]> {
    return Promise.resolve([this.workspace]);
  }
}

async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "dir");
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "EPERM") || isNodeErrorWithCode(error, "EACCES")) return false;
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
