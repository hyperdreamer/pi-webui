import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
