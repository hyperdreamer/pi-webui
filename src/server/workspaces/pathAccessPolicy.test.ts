import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPathAccessPolicy, isAbsoluteishPath, resolvePathAccessTarget, resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

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
