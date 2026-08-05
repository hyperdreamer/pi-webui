import { mkdtemp, readFile, readdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionUsageCacheStore, type SessionUsageScanner } from "./sessionUsageCacheStore";
import { scanSessionUsage } from "./sessionUsageScanner";

// Wrap the store's rename so the atomic-write failure path can be driven
// deterministically: every flush still renames through the real filesystem,
// and the failure test faults exactly one call.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

interface ScanCall {
  startOffset: number;
  bytesScanned: number;
}

function header(id: string, paddingLength = 0): string {
  return JSON.stringify({
    type: "session",
    id,
    cwd: "/repo",
    ...(paddingLength === 0 ? {} : { padding: "x".repeat(paddingLength) }),
  });
}

function assistantLine(input: number, cost: number): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } });
}

/** Record where scans begin while still computing real totals. */
function recordingScanner(record: ScanCall[]): SessionUsageScanner {
  return async (path, startOffset) => {
    const result = await scanSessionUsage(path, startOffset);
    record.push({ startOffset, bytesScanned: result.bytesScanned });
    return result;
  };
}

async function tempPaths(): Promise<{ cachePath: string; sessionPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "usage-cache-"));
  return { cachePath: join(dir, "usage-cache.json"), sessionPath: join(dir, "session.jsonl") };
}

describe("SessionUsageCacheStore", () => {
  it("scans on first read and reuses the cache when the file is unchanged", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const calls: ScanCall[] = [];
    const store = new SessionUsageCacheStore(cachePath, recordingScanner(calls));

    const first = await store.totalsFor("s1", sessionPath);
    expect(first.input).toBe(10);
    expect(first.cost).toBeCloseTo(0.1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.startOffset).toBe(0);

    await store.flush();
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ sessions: { s1: { input: 10 } } });

    // Same size and mtime: the cached totals are reused without another scan.
    const reused = await store.totalsFor("s1", sessionPath);
    expect(reused.input).toBe(10);
    expect(calls).toHaveLength(1);

    // A fresh instance loads the persisted entry instead of rescanning.
    const reopenedCalls: ScanCall[] = [];
    const reopened = new SessionUsageCacheStore(cachePath, recordingScanner(reopenedCalls));
    expect((await reopened.totalsFor("s1", sessionPath)).input).toBe(10);
    expect(reopenedCalls).toEqual([]);
  });

  it("adds only appended usage when the file grows", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    const base = `${header("s1")}\n${assistantLine(10, 0.1)}\n`;
    await writeFile(sessionPath, base, "utf8");
    const calls: ScanCall[] = [];
    const store = new SessionUsageCacheStore(cachePath, recordingScanner(calls));
    await store.totalsFor("s1", sessionPath);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.startOffset).toBe(0);

    await writeFile(sessionPath, `${base}${assistantLine(5, 0.2)}\n`, "utf8");
    const grown = await store.totalsFor("s1", sessionPath);
    expect(grown.input).toBe(15);
    expect(grown.cost).toBeCloseTo(0.3);
    // The incremental scan resumes at the previously stored offset.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.startOffset).toBe(calls[0]?.bytesScanned);
  });

  it("rescans from zero when the file shrinks", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const calls: ScanCall[] = [];
    const store = new SessionUsageCacheStore(cachePath, recordingScanner(calls));
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(20);

    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(3, 0.05)}\n`, "utf8");
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.startOffset).toBe(0);
  });

  it("rescans when the header id changes", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const calls: ScanCall[] = [];
    const store = new SessionUsageCacheStore(cachePath, recordingScanner(calls));
    await store.totalsFor("s1", sessionPath);

    const replaced = `${header("s2")}\n${assistantLine(4, 0.4)}\n${assistantLine(4, 0.4)}\n`;
    await writeFile(sessionPath, replaced, "utf8");
    const after = await store.totalsFor("s1", sessionPath);
    expect(after.input).toBe(8);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.startOffset).toBe(0);
  });

  it("rescans from zero when a larger replacement changes a multi-chunk header id", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    const paddingLength = 3 * 4 * 1024;
    const original = `${header("s1", paddingLength)}\n${assistantLine(10, 0.1)}\n`;
    await writeFile(sessionPath, original, "utf8");
    const calls: ScanCall[] = [];
    const store = new SessionUsageCacheStore(cachePath, recordingScanner(calls));
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(10);

    const replacement = `${header("s2", paddingLength + 512)}\n${assistantLine(4, 0.4)}\n${assistantLine(4, 0.4)}\n`;
    expect(Buffer.byteLength(replacement, "utf8")).toBeGreaterThan(Buffer.byteLength(original, "utf8"));
    await writeFile(sessionPath, replacement, "utf8");

    const after = await store.totalsFor("s1", sessionPath);
    expect(after.input).toBe(8);
    expect(after.cost).toBeCloseTo(0.8);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.startOffset).toBe(0);
  });

  it("rescans from zero when the file is rewritten to the same size under the same header id", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    const original = `${header("s1")}\n${assistantLine(10, 0.1)}\n`;
    await writeFile(sessionPath, original, "utf8");
    const calls: ScanCall[] = [];
    const store = new SessionUsageCacheStore(cachePath, recordingScanner(calls));
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(10);

    // Same byte length, same header id, newer mtime, different totals.
    const replacement = `${header("s1")}\n${assistantLine(20, 0.2)}\n`;
    expect(Buffer.byteLength(replacement, "utf8")).toBe(Buffer.byteLength(original, "utf8"));
    await writeFile(sessionPath, replacement, "utf8");
    await utimes(sessionPath, new Date(), new Date(Date.now() + 5000));

    const after = await store.totalsFor("s1", sessionPath);
    expect(after.input).toBe(20);
    expect(after.cost).toBeCloseTo(0.2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.startOffset).toBe(0);
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
    const leftovers = (await readdir(dirname(cachePath))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("keeps a previously persisted cache readable when a flush fails before the rename", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(1, 0.01)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    await store.totalsFor("s1", sessionPath);
    await store.flush();
    const persisted = await readFile(cachePath, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({ sessions: { s1: { input: 1 } } });

    // Make the store dirty again so the next flush attempts a write.
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(1, 0.01)}\n${assistantLine(2, 0.02)}\n`, "utf8");
    await store.totalsFor("s1", sessionPath);

    vi.mocked(rename).mockRejectedValueOnce(new Error("simulated rename failure"));
    await expect(store.flush()).rejects.toThrow("simulated rename failure");

    // The failing flush never touched the persisted target...
    await expect(readFile(cachePath, "utf8")).resolves.toBe(persisted);
    // ...and the temp file was cleaned up.
    const leftovers = (await readdir(dirname(cachePath))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
