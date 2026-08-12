import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/projectStore.js";
import { ProjectNotFoundError, ProjectService } from "./projectService.js";

let tempDir = "";
let service: ProjectService;
let store: ProjectStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-recent-service-"));
  store = new ProjectStore(join(tempDir, "projects.json"));
  service = new ProjectService(store);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ProjectService recent history", () => {
  it("lists history recorded by registration", async () => {
    const project = await store.add({ path: "/work/alpha" });

    expect((await service.listRecent()).map((entry) => entry.path)).toEqual(["/work/alpha"]);
    expect(project.path).toBe("/work/alpha");
  });

  it("records work on a registered project and returns the new order", async () => {
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });

    expect((await service.recordRecent(alpha.id)).map((entry) => entry.path)).toEqual(["/work/alpha", "/work/beta"]);
  });

  it("reopens a trailing-separator input through one canonical history entry", async () => {
    const projectDir = join(tempDir, "alpha");
    await mkdir(projectDir);
    const canonicalPath = await realpath(projectDir);
    const first = await service.add({ path: projectDir });
    const firstHistory = await service.listRecent();
    await service.close(first.id);

    const reopened = await service.add({ path: `${projectDir}${sep}` });
    const history = await service.listRecent();

    expect(reopened.path).toBe(canonicalPath);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: firstHistory[0]?.id, path: canonicalPath });
  });

  it.skipIf(process.platform === "win32")("reopens a symlink input through one canonical history entry", async () => {
    const projectDir = join(tempDir, "alpha");
    const linkedProjectDir = join(tempDir, "linked-alpha");
    await mkdir(projectDir);
    await symlink(projectDir, linkedProjectDir, "dir");
    const canonicalPath = await realpath(projectDir);
    const first = await service.add({ path: projectDir });
    const firstHistory = await service.listRecent();
    await service.close(first.id);

    const reopened = await service.add({ path: linkedProjectDir });
    const history = await service.listRecent();

    expect(reopened.path).toBe(canonicalPath);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: firstHistory[0]?.id, path: canonicalPath });
  });

  it("rejects recording work for an unknown project", async () => {
    await expect(service.recordRecent("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("removes a registered entry, keeps the project registered, and recreates the entry after work", async () => {
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const entry = (await service.listRecent()).find((candidate) => candidate.path === "/work/alpha");
    if (entry === undefined) throw new Error("expected an entry for the registered project");

    expect((await service.removeRecent(entry.id)).map((candidate) => candidate.path)).toEqual(["/work/beta"]);
    expect((await service.list()).map((project) => project.path)).toEqual(["/work/alpha", "/work/beta"]);
    await expect(service.removeRecent("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);

    const recreated = await service.recordRecent(alpha.id);

    expect(recreated.map((candidate) => candidate.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(recreated[0]?.id).not.toBe(entry.id);
  });

  it("removes a closed entry", async () => {
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const entry = (await service.listRecent()).find((candidate) => candidate.path === "/work/alpha");
    if (entry === undefined) throw new Error("expected an entry for the registered project");
    await service.close(alpha.id);

    expect((await service.removeRecent(entry.id)).map((candidate) => candidate.path)).toEqual(["/work/beta"]);
  });
});
