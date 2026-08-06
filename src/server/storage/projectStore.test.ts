import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore, projectStorePath } from "./projectStore.js";

describe("projectStorePath", () => {
  it("uses PI_WEBUI_DATA_DIR by default", () => {
    expect(projectStorePath({ PI_WEBUI_DATA_DIR: "demo-data" }, "/tmp/pi-webui")).toBe(resolve("/tmp/pi-webui", "demo-data", "projects.json"));
  });

  it("uses PI_WEBUI_PROJECTS_FILE when configured", () => {
    expect(projectStorePath({ PI_WEBUI_PROJECTS_FILE: "demo/projects.json" }, "/tmp/pi-webui")).toBe(resolve("/tmp/pi-webui", "demo/projects.json"));
  });
});

describe("ProjectStore pin state", () => {
  let tempDir = "";
  let filePath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-webui-project-store-"));
    filePath = join(tempDir, "projects.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("omits pinned for a newly added project", async () => {
    const store = new ProjectStore(filePath);

    const added = await store.add({ path: "/work/alpha" });

    expect(added).not.toHaveProperty("pinned");
    expect(await store.list()).toEqual([added]);
  });

  it("pins a project, moves it to the front, and returns the new order", async () => {
    const store = new ProjectStore(filePath);
    await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const gamma = await store.add({ path: "/work/gamma" });

    const ordered = await store.setPinned(gamma.id, true);

    expect(ordered?.map((project) => project.path)).toEqual(["/work/gamma", "/work/alpha", "/work/beta"]);
    expect(ordered?.[0]).toMatchObject({ id: gamma.id, pinned: true });
    expect(await store.list()).toEqual(ordered);
  });

  it("unpins a project by omitting the flag and still moves it to the front", async () => {
    const store = new ProjectStore(filePath);
    const alpha = await store.add({ path: "/work/alpha" });
    const beta = await store.add({ path: "/work/beta" });
    await store.setPinned(alpha.id, true);
    await store.setPinned(beta.id, true);

    const ordered = await store.setPinned(alpha.id, false);

    expect(ordered?.map((project) => project.id)).toEqual([alpha.id, beta.id]);
    expect(ordered?.[0]).not.toHaveProperty("pinned");
    expect(ordered?.[1]).toMatchObject({ id: beta.id, pinned: true });
  });

  it("resolves to undefined for an unknown project id", async () => {
    const store = new ProjectStore(filePath);
    await store.add({ path: "/work/alpha" });

    expect(await store.setPinned("missing", true)).toBeUndefined();
  });

  it("reads and preserves a pinned flag already present on disk", async () => {
    await writeFile(filePath, `${JSON.stringify({
      projects: [
        { id: "a", name: "alpha", path: "/work/alpha", createdAt: "2026-08-06T00:00:00.000Z" },
        { id: "b", name: "beta", path: "/work/beta", createdAt: "2026-08-06T00:00:00.000Z", pinned: true },
      ],
    })}\n`, "utf8");
    const store = new ProjectStore(filePath);

    expect(await store.list()).toEqual([
      { id: "a", name: "alpha", path: "/work/alpha", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "b", name: "beta", path: "/work/beta", createdAt: "2026-08-06T00:00:00.000Z", pinned: true },
    ]);
  });

  it("rejects a non-boolean pinned value", async () => {
    await writeFile(filePath, `${JSON.stringify({
      projects: [{ id: "a", name: "alpha", path: "/work/alpha", createdAt: "2026-08-06T00:00:00.000Z", pinned: "yes" }],
    })}\n`, "utf8");
    const store = new ProjectStore(filePath);

    await expect(store.list()).rejects.toThrow("Invalid project");
  });

  it("does not lose an update when two mutations overlap", async () => {
    const store = new ProjectStore(filePath);
    const alpha = await store.add({ path: "/work/alpha" });
    const beta = await store.add({ path: "/work/beta" });

    await Promise.all([store.setPinned(alpha.id, true), store.setPinned(beta.id, true)]);

    const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted).toEqual({ projects: await store.list() });
    expect(await store.list()).toHaveLength(2);
    expect((await store.list()).every((project) => project.pinned === true)).toBe(true);
  });
});

describe("ProjectStore durable writes", () => {
  let tempDir = "";
  let filePath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-webui-project-store-"));
    filePath = join(tempDir, "projects.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("preserves a configured symlink and writes through to its target", async () => {
    const targetDir = join(tempDir, "registry");
    const targetPath = join(targetDir, "projects.json");
    await mkdir(targetDir);
    await writeFile(targetPath, `${JSON.stringify({ projects: [] }, null, 2)}\n`, "utf8");
    await symlink(targetPath, filePath);
    const store = new ProjectStore(filePath);

    const project = await store.add({ path: "/work/alpha" });

    expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual({ projects: [project] });
  });

  it.skipIf(process.platform === "win32")("resolves a relative dangling symlink from its physical parent", async () => {
    const physicalRoot = join(tempDir, "physical");
    const physicalNestedDir = join(physicalRoot, "nested");
    const intendedRegistryDir = join(physicalRoot, "registry");
    const lexicalRegistryDir = join(tempDir, "registry");
    const logicalDir = join(tempDir, "logical");
    await mkdir(physicalNestedDir, { recursive: true });
    await mkdir(intendedRegistryDir);
    await mkdir(lexicalRegistryDir);
    await symlink(physicalNestedDir, logicalDir);

    const configuredPath = join(logicalDir, "projects.json");
    const intendedPath = join(intendedRegistryDir, "projects.json");
    const lexicalAlternativePath = join(lexicalRegistryDir, "projects.json");
    await symlink("../registry/projects.json", configuredPath);
    const store = new ProjectStore(configuredPath);

    const project = await store.add({ path: "/work/alpha" });

    expect((await lstat(configuredPath)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(intendedPath, "utf8"))).toEqual({ projects: [project] });
    await expect(readFile(lexicalAlternativePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.list()).toEqual([project]);
    expect(await readdir(intendedRegistryDir)).toEqual(["projects.json"]);
  });

  it.skipIf(process.platform === "win32")("preserves restrictive permissions when replacing an existing registry", async () => {
    await writeFile(filePath, `${JSON.stringify({ projects: [] }, null, 2)}\n`, "utf8");
    await chmod(filePath, 0o600);
    const previousUmask = process.umask(0o022);

    try {
      await new ProjectStore(filePath).add({ path: "/work/alpha" });

      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("leaves no temp file behind after a completed mutation", async () => {
    const store = new ProjectStore(filePath);
    const project = await store.add({ path: "/work/alpha" });
    await store.setPinned(project.id, true);

    const entries = await readdir(tempDir);
    expect(entries).toContain("projects.json");
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("ignores an unrelated pre-existing temp file when reading", async () => {
    await writeFile(join(tempDir, ".projects.json.stale.tmp"), "not json", "utf8");
    const store = new ProjectStore(filePath);
    await store.add({ path: "/work/alpha" });

    expect(await store.list()).toEqual([expect.objectContaining({ path: "/work/alpha" })]);
  });

  it("writes a complete parseable file after a mutation", async () => {
    const store = new ProjectStore(filePath);
    const project = await store.add({ path: "/work/alpha" });
    await store.setPinned(project.id, true);

    const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted).toEqual({ projects: await store.list() });
  });
});
