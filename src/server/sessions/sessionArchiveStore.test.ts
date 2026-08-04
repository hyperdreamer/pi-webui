import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSessionArchiveFilePath, SessionArchiveStore } from "./sessionArchiveStore.js";
import { SESSION_CREATION_SOURCE_CUSTOM_TYPE, serializeSessionCreationSource } from "./sessionCreationSource.js";

const tempRoots: string[] = [];

describe("defaultSessionArchiveFilePath", () => {
  it("uses PI_WEBUI_DATA_DIR when configured", () => {
    expect(defaultSessionArchiveFilePath({ PI_WEBUI_DATA_DIR: "managed-state" }, "/tmp/pi-webui")).toBe(resolve("/tmp/pi-webui", "managed-state", "archived-sessions.json"));
  });

  it("preserves the ~/.pi-webui default when PI_WEBUI_DATA_DIR is unset", () => {
    expect(defaultSessionArchiveFilePath({}, "/tmp/pi-webui")).toBe(join(homedir(), ".pi-webui", "archived-sessions.json"));
  });
});

describe("SessionArchiveStore", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("stores its default index and archived files under PI_WEBUI_DATA_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-archive-data-dir-"));
    tempRoots.push(root);
    const dataDir = join(root, "managed-state");
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourcePath = join(activeDir, "2026-01-01_managed.jsonl");
    await writeFile(sourcePath, "session contents\n", "utf8");
    vi.stubEnv("PI_WEBUI_DATA_DIR", dataDir);

    const store = new SessionArchiveStore();
    const record = await store.archive({
      sessionId: "managed",
      cwd: "/workspace",
      path: sourcePath,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 1,
      firstMessage: "hello",
    });

    const archivePath = join(dataDir, "archived-sessions", "2026-01-01_managed.jsonl");
    expect(record.archivePath).toBe(archivePath);
    await expect(readFile(archivePath, "utf8")).resolves.toBe("session contents\n");
    await expect(readFile(join(dataDir, "archived-sessions.json"), "utf8")).resolves.toContain('"sessionId": "managed"');
  });

  it("moves archived session files out of the active session directory and restores them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-archive-"));
    tempRoots.push(root);
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourcePath = join(activeDir, "2026-01-01_s1.jsonl");
    await writeFile(sourcePath, "session contents\n", "utf8");

    const store = new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archived-files"));
    const record = await store.archive({
      sessionId: "s1",
      cwd: "/workspace",
      path: sourcePath,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 2,
      firstMessage: "hello",
    });

    expect(await exists(sourcePath)).toBe(false);
    expect(record.originalPath).toBe(sourcePath);
    expect(record.archivePath).toBeDefined();
    if (record.archivePath === undefined) throw new Error("Expected archive path");
    expect(await readFile(record.archivePath, "utf8")).toBe("session contents\n");
    await expect(store.list()).resolves.toMatchObject([{ sessionId: "s1", originalPath: sourcePath, archivePath: record.archivePath, messageCount: 2 }]);

    await store.restore("s1");

    expect(await readFile(sourcePath, "utf8")).toBe("session contents\n");
    expect(await exists(record.archivePath)).toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("round trips creation source through the archive index and preserves its JSONL marker on restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-archive-source-"));
    tempRoots.push(root);
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourcePath = join(activeDir, "2026-01-01_plus.jsonl");
    const contents = [
      JSON.stringify({ type: "session", version: 3, id: "plus", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" }),
      JSON.stringify({ type: "custom", id: "source-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", customType: SESSION_CREATION_SOURCE_CUSTOM_TYPE, data: serializeSessionCreationSource("session-list-plus") }),
      "",
    ].join("\n");
    await writeFile(sourcePath, contents, "utf8");

    const archiveFile = join(root, "archived-sessions.json");
    const store = new SessionArchiveStore(archiveFile, join(root, "archived-files"));
    const record = await store.archive({
      sessionId: "plus",
      cwd: "/workspace",
      path: sourcePath,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 0,
      firstMessage: "",
      creationSource: "session-list-plus",
    });

    expect(record.creationSource).toBe("session-list-plus");
    await expect(store.list()).resolves.toMatchObject([
      { sessionId: "plus", creationSource: "session-list-plus" },
    ]);
    await expect(readFile(archiveFile, "utf8")).resolves.toContain(
      '"creationSource": "session-list-plus"'
    );

    await store.restore("plus");

    await expect(readFile(sourcePath, "utf8")).resolves.toBe(contents);
  });

  it("does not project an unknown creation source from the archive index", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-archive-invalid-source-"));
    tempRoots.push(root);
    const archiveFile = join(root, "archived-sessions.json");
    await writeFile(archiveFile, JSON.stringify({
      sessions: [{
        sessionId: "legacy",
        cwd: "/workspace",
        archivedAt: "2026-01-01T00:00:00.000Z",
        creationSource: "unknown",
      }],
    }), "utf8");
    const store = new SessionArchiveStore(archiveFile, join(root, "archived-files"));

    const [record] = await store.list();
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty("creationSource");
  });

  it("permanently deletes archived session files and records", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-archive-delete-"));
    tempRoots.push(root);
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourcePath = join(activeDir, "2026-01-01_s1.jsonl");
    await writeFile(sourcePath, "session contents\n", "utf8");

    const store = new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archived-files"));
    const record = await store.archive({
      sessionId: "s1",
      cwd: "/workspace",
      path: sourcePath,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 2,
      firstMessage: "hello",
    });

    if (record.archivePath === undefined) throw new Error("Expected archive path");
    await store.deleteArchived("s1");

    expect(await exists(sourcePath)).toBe(false);
    expect(await exists(record.archivePath)).toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("archives and permanently deletes sessions in batches", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-archive-batch-"));
    tempRoots.push(root);
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourceA = join(activeDir, "2026-01-01_a.jsonl");
    const sourceB = join(activeDir, "2026-01-01_b.jsonl");
    await writeFile(sourceA, "a\n", "utf8");
    await writeFile(sourceB, "b\n", "utf8");

    const store = new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archived-files"));
    const records = await store.archiveMany([
      {
        sessionId: "a",
        cwd: "/workspace",
        path: sourceA,
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:01:00.000Z",
        messageCount: 1,
        firstMessage: "a",
      },
      {
        sessionId: "b",
        cwd: "/workspace",
        path: sourceB,
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:02:00.000Z",
        messageCount: 2,
        firstMessage: "b",
      },
    ]);

    expect(records.map((record) => record.sessionId)).toEqual(["a", "b"]);
    expect(await exists(sourceA)).toBe(false);
    expect(await exists(sourceB)).toBe(false);
    await expect(store.list()).resolves.toMatchObject([{ sessionId: "a" }, { sessionId: "b" }]);

    const archivePaths = records.map((record) => record.archivePath);
    if (archivePaths.some((path) => path === undefined)) throw new Error("Expected archive paths");
    await expect(store.deleteArchivedMany(["a", "b", "missing"])).resolves.toEqual(["a", "b"]);
    for (const archivePath of archivePaths) {
      if (archivePath === undefined) throw new Error("Expected archive path");
      expect(await exists(archivePath)).toBe(false);
    }
    await expect(store.list()).resolves.toEqual([]);
  });

  it("prefers exact persisted session IDs over prefix matches and canonicalizes stored cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-archive-prefix-"));
    tempRoots.push(root);
    const archiveFile = join(root, "archived-sessions.json");
    const rawCwd = join(root, "workspace", "..", "workspace");
    await writeFile(archiveFile, JSON.stringify({
      sessions: [
        {
          sessionId: "abc123",
          cwd: rawCwd,
          archivedAt: "2026-01-01T00:00:00.000Z",
          originalPath: "/sessions/abc123.jsonl",
          archivePath: "/archive/abc123.jsonl",
          messageCount: 3,
          firstMessage: "prefix",
          name: "Prefix match",
          parentSessionPath: "/sessions/root.jsonl",
        },
        {
          sessionId: "abc",
          cwd: rawCwd,
          archivedAt: "2026-01-01T00:00:00.000Z",
          originalPath: "/sessions/abc.jsonl",
          archivePath: "/archive/abc.jsonl",
          messageCount: 1,
          firstMessage: "exact",
        },
      ],
    }), "utf8");

    const store = new SessionArchiveStore(archiveFile, join(root, "archived-files"));

    await expect(store.get("abc")).resolves.toMatchObject({
      sessionId: "abc",
      cwd: resolve(rawCwd),
      firstMessage: "exact",
    });
    await expect(store.get("abc1")).resolves.toMatchObject({
      sessionId: "abc123",
      cwd: resolve(rawCwd),
      firstMessage: "prefix",
      name: "Prefix match",
      parentSessionPath: "/sessions/root.jsonl",
    });
    await expect(store.isArchived("abc1")).resolves.toBe(true);
    await expect(store.isArchived("missing")).resolves.toBe(false);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
