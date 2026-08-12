import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENT_PROJECT_LIMIT } from "../../shared/apiTypes.js";
import { ProjectStore } from "./projectStore.js";

let tempDir = "";
let filePath = "";
let clock = 0;

function storeWithClock(): ProjectStore {
  clock = 0;
  return new ProjectStore(filePath, () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readRaw(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error("expected a JSON object");
  return parsed;
}

function storedEntry(index: number): { id: string; name: string; path: string; lastUsedAt: string } {
  return {
    id: `entry-${String(index)}`,
    name: `project-${String(index)}`,
    path: `/work/project-${String(index)}`,
    lastUsedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

function storedEntries(count: number): ReturnType<typeof storedEntry>[] {
  return Array.from({ length: count }, (_, index) => storedEntry(index));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-recent-projects-"));
  filePath = join(tempDir, "projects.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ProjectStore recent history", () => {
  it("starts empty and loads a document that has no history field", async () => {
    await writeFile(filePath, `${JSON.stringify({ projects: [] })}\n`, "utf8");
    expect(await storeWithClock().listRecent()).toEqual([]);
  });

  it("records a newly added project at the top with a server timestamp", async () => {
    const store = storeWithClock();
    await store.add({ path: "/work/alpha" });
    const beta = await store.add({ path: "/work/beta" });

    const entries = await store.listRecent();

    expect(entries.map((entry) => entry.path)).toEqual(["/work/beta", "/work/alpha"]);
    expect(entries[0]).toMatchObject({ name: "beta", lastUsedAt: "2026-01-01T00:00:04.000Z" });
    expect(entries[0]?.id).not.toBe(beta.id);
  });

  it("re-adding a registered path keeps one entry and moves it to the top", async () => {
    const store = storeWithClock();
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const first = await store.listRecent();

    const readded = await store.add({ path: "/work/alpha" });
    const entries = await store.listRecent();

    expect(readded.id).toBe(alpha.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(entries[0]?.id).toBe(first.find((entry) => entry.path === "/work/alpha")?.id);
  });

  it("touches a registered project, preserving the entry id and updating the name", async () => {
    const store = storeWithClock();
    const alpha = await store.add({ name: "Alpha", path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const before = await store.listRecent();

    const entries = await store.touchRecent(alpha.id);

    expect(entries?.map((entry) => entry.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(entries?.[0]?.id).toBe(before.find((entry) => entry.path === "/work/alpha")?.id);
    expect(entries?.[0]?.name).toBe("Alpha");
    expect(await store.listRecent()).toEqual(entries);
  });

  it("returns undefined when touching an unknown project", async () => {
    expect(await storeWithClock().touchRecent("missing")).toBeUndefined();
  });
});

describe("ProjectStore recent history retention", () => {
  it(`keeps at most ${String(RECENT_PROJECT_LIMIT)} entries and evicts the oldest`, async () => {
    const store = storeWithClock();
    for (let index = 0; index <= RECENT_PROJECT_LIMIT; index += 1) {
      await store.add({ path: `/work/project-${String(index)}` });
    }

    const entries = await store.listRecent();

    expect(entries).toHaveLength(RECENT_PROJECT_LIMIT);
    expect(entries[0]?.path).toBe(`/work/project-${String(RECENT_PROJECT_LIMIT)}`);
    expect(entries.some((entry) => entry.path === "/work/project-0")).toBe(false);
  });

  it("keeps history when a project, a tree, or a pin state changes", async () => {
    const store = storeWithClock();
    const root = await store.add({ path: "/work/root" });
    const child = await store.add({ path: "/work/root/child" });
    const other = await store.add({ path: "/work/other" });

    await store.setPinned(other.id, true);
    expect((await store.listRecent()).map((entry) => entry.path)).toEqual(["/work/other", "/work/root/child", "/work/root"]);

    await store.remove(other.id);
    await store.removeTree(root.id);

    expect(await store.list()).toEqual([]);
    expect((await store.listRecent()).map((entry) => entry.path)).toEqual(["/work/other", "/work/root/child", "/work/root"]);
    expect(child.id).not.toBe(root.id);
  });

  it("removes a registered entry and recreates it after meaningful work", async () => {
    const store = storeWithClock();
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const entry = (await store.listRecent()).find((candidate) => candidate.path === "/work/alpha");
    if (entry === undefined) throw new Error("expected an entry for the registered project");

    const removal = await store.removeRecent(entry.id);

    expect(removal).toEqual({
      kind: "removed",
      entries: [expect.objectContaining({ path: "/work/beta" })],
    });
    expect((await store.list()).map((project) => project.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(await store.removeRecent(entry.id)).toEqual({ kind: "not-found" });

    const recreated = await store.touchRecent(alpha.id);

    expect(recreated?.map((candidate) => candidate.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(recreated?.[0]?.id).not.toBe(entry.id);
  });

  it("removes a closed entry", async () => {
    const store = storeWithClock();
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const entry = (await store.listRecent()).find((candidate) => candidate.path === "/work/alpha");
    if (entry === undefined) throw new Error("expected an entry for the registered project");
    await store.remove(alpha.id);

    const removal = await store.removeRecent(entry.id);

    expect(removal.kind).toBe("removed");
    expect((await store.listRecent()).map((candidate) => candidate.path)).toEqual(["/work/beta"]);
  });
});

describe("ProjectStore malformed recent history", () => {
  const corrupt = { projects: [{ id: "p1", name: "alpha", path: "/work/alpha", createdAt: "2026-01-01T00:00:00.000Z" }], recentProjects: "not-an-array" };

  it("still reads registered projects", async () => {
    await writeFile(filePath, `${JSON.stringify(corrupt)}\n`, "utf8");

    expect((await storeWithClock().list()).map((project) => project.path)).toEqual(["/work/alpha"]);
  });

  it("reports the history failure instead of returning an empty list", async () => {
    await writeFile(filePath, `${JSON.stringify(corrupt)}\n`, "utf8");

    await expect(storeWithClock().listRecent()).rejects.toThrow(/recent/i);
  });

  it.each([
    ["a malformed timestamp", [{ ...storedEntry(0), lastUsedAt: "not-a-timestamp" }]],
    ["a noncanonical timestamp", [{ ...storedEntry(0), lastUsedAt: "2026-01-01T00:00:00Z" }]],
    ["more than the history limit", storedEntries(RECENT_PROJECT_LIMIT + 1)],
    ["a duplicate id", [storedEntry(0), { ...storedEntry(1), id: storedEntry(0).id }]],
    ["a duplicate path", [storedEntry(0), { ...storedEntry(1), path: storedEntry(0).path }]],
  ])("quarantines %s without hiding registered projects or rewriting raw history", async (_label, recentProjects) => {
    const document = { ...corrupt, recentProjects };
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    const store = storeWithClock();

    expect((await store.list()).map((project) => project.path)).toEqual(["/work/alpha"]);
    await expect(store.listRecent()).rejects.toThrow(/recent projects.*malformed/i);

    await store.add({ path: "/work/beta" });

    const raw = await readRaw();
    expect(raw["recentProjects"]).toEqual(recentProjects);
    expect((await store.list()).map((project) => project.path)).toEqual(["/work/alpha", "/work/beta"]);
  });

  it("accepts exactly the maximum number of valid unique history entries", async () => {
    const recentProjects = storedEntries(RECENT_PROJECT_LIMIT);
    await writeFile(filePath, `${JSON.stringify({ projects: [], recentProjects })}\n`, "utf8");

    await expect(storeWithClock().listRecent()).resolves.toEqual(recentProjects);
  });

  it.each([
    ["null", null],
    ["a non-array value", "not-an-array"],
  ])("preserves %s history through a later registry write", async (_label, recentProjects) => {
    await writeFile(filePath, `${JSON.stringify({ ...corrupt, recentProjects })}\n`, "utf8");
    const store = storeWithClock();

    await store.add({ path: "/work/beta" });

    const raw = await readRaw();
    expect(raw["recentProjects"]).toBe(recentProjects);
    const projects = raw["projects"];
    const paths = Array.isArray(projects) ? projects.map((project: unknown) => (isRecord(project) && typeof project["path"] === "string" ? project["path"] : undefined)) : [];
    expect(paths.filter((path) => path !== undefined)).toEqual(["/work/alpha", "/work/beta"]);
  });

  it.each([
    ["null", null],
    ["a malformed object", { unexpected: true }],
  ])("rejects history mutations and preserves %s history verbatim", async (_label, recentProjects) => {
    const original = `${JSON.stringify({ ...corrupt, recentProjects }, null, 2)}\n`;
    await writeFile(filePath, original, "utf8");
    const store = storeWithClock();

    await expect(store.touchRecent("p1")).rejects.toThrow(/recent projects.*malformed/i);
    await expect(store.removeRecent("missing-entry")).rejects.toThrow(/recent projects.*malformed/i);

    expect(await readFile(filePath, "utf8")).toBe(original);
  });
});
