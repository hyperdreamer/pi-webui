import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionUsageCacheStore } from "./sessionUsageCacheStore";

function header(id: string): string {
  return JSON.stringify({ type: "session", id, cwd: "/repo" });
}

function assistantLine(input: number, cost: number): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } });
}

async function tempPaths(): Promise<{ cachePath: string; sessionPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "usage-cache-"));
  return { cachePath: join(dir, "usage-cache.json"), sessionPath: join(dir, "session.jsonl") };
}

describe("SessionUsageCacheStore", () => {
  it("scans on first read and reuses the cache when the file is unchanged", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);

    const first = await store.totalsFor("s1", sessionPath);
    expect(first.input).toBe(10);
    expect(first.cost).toBeCloseTo(0.1);

    await store.flush();
    const persisted: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    expect(persisted).toMatchObject({ sessions: { s1: { input: 10 } } });

    const reused = await store.totalsFor("s1", sessionPath);
    expect(reused.input).toBe(10);
  });

  it("adds only appended usage when the file grows", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    const base = `${header("s1")}\n${assistantLine(10, 0.1)}\n`;
    await writeFile(sessionPath, base, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    await store.totalsFor("s1", sessionPath);

    await writeFile(sessionPath, `${base}${assistantLine(5, 0.2)}\n`, "utf8");
    const grown = await store.totalsFor("s1", sessionPath);
    expect(grown.input).toBe(15);
    expect(grown.cost).toBeCloseTo(0.3);
  });

  it("rescans from zero when the file shrinks", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(20);

    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(3, 0.05)}\n`, "utf8");
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(3);
  });

  it("rescans when the header id changes", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    await store.totalsFor("s1", sessionPath);

    const replaced = `${header("s2")}\n${assistantLine(4, 0.4)}\n${assistantLine(4, 0.4)}\n`;
    await writeFile(sessionPath, replaced, "utf8");
    const after = await store.totalsFor("s1", sessionPath);
    expect(after.input).toBe(8);
  });

  it("treats an unreadable cache file as empty", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(cachePath, "{ not json", "utf8");
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(6, 0.6)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(6);
  });

  it("returns zero totals for a missing session file", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    const store = new SessionUsageCacheStore(cachePath);
    const totals = await store.totalsFor("gone", `${sessionPath}.missing`);
    expect(totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("persists atomically, leaving no temp files behind", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(1, 0.01)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    await store.totalsFor("s1", sessionPath);
    await store.flush();
    await expect(stat(cachePath)).resolves.toBeDefined();
    const snapshot = await store.snapshot();
    expect(Object.keys(snapshot)).toEqual(["s1"]);
  });
});
