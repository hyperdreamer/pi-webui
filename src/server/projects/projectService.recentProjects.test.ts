import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/projectStore.js";
import { ProjectNotFoundError, ProjectService, RecentProjectRegisteredError } from "./projectService.js";

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

  it("rejects recording work for an unknown project", async () => {
    await expect(service.recordRecent("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("removes a closed entry and rejects removing a registered or unknown one", async () => {
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const entry = (await service.listRecent()).find((candidate) => candidate.path === "/work/alpha");
    if (entry === undefined) throw new Error("expected an entry for the registered project");

    await expect(service.removeRecent(entry.id)).rejects.toBeInstanceOf(RecentProjectRegisteredError);
    await expect(service.removeRecent("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);

    await service.close(alpha.id);

    expect((await service.removeRecent(entry.id)).map((candidate) => candidate.path)).toEqual(["/work/beta"]);
  });
});
