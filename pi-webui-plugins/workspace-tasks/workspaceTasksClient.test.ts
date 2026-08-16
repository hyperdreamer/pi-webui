import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TASKS_CONFIG_PATH,
  emptyWorkspaceTasksConfig,
  serializeWorkspaceTasksConfig,
  type WorkspaceTasksConfig,
} from "./config";
import {
  clearWorkspaceTasksStateForTesting,
  ensureWorkspaceTasksConfig,
  getWorkspaceTasksCacheEntry,
  guardedWriteWorkspaceTasksConfig,
  loadWorkspaceTasksConfig,
  refreshWorkspaceTasksConfig,
  subscribeWorkspaceTasksConfig,
  type WorkspaceTasksFileContent,
  type WorkspaceTasksFiles,
  type WorkspaceTasksSnapshot,
} from "./workspaceTasksClient";

const emptySource = JSON.stringify({ version: 1, tasks: [] });
const invalidSource = JSON.stringify({ version: 2, tasks: [] });
const nextConfig: WorkspaceTasksConfig = {
  version: 1,
  tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
};
const nextPayload = serializeWorkspaceTasksConfig(nextConfig);
const missingSnapshot: WorkspaceTasksSnapshot = { kind: "missing" };

describe("workspace tasks client", () => {
  beforeEach(() => {
    clearWorkspaceTasksStateForTesting();
  });

  it("loads the configured path through the public workspace file helper", async () => {
    const readFile = vi.fn<WorkspaceTasksFiles["readFile"]>(() => Promise.resolve(textFile(emptySource)));

    await loadWorkspaceTasksConfig({ readFile });

    expect(readFile).toHaveBeenCalledWith(TASKS_CONFIG_PATH);
  });

  it("loads a valid config and retains its exact text snapshot", async () => {
    const content = JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build" }] });

    await expect(loadWorkspaceTasksConfig({ readFile: () => Promise.resolve(textFile(content)) })).resolves.toEqual({
      kind: "loaded",
      path: TASKS_CONFIG_PATH,
      config: {
        version: 1,
        tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
      },
      snapshot: { kind: "text", content },
    });
  });

  it.each([
    ["Path does not exist", new Error("Path does not exist")],
    ["ENOENT code", errorWithCode("workspace file unavailable", "ENOENT")],
    ["case-insensitive no-such-file message", new Error("No Such File Or Directory: .pi-webui/tasks.json")],
    ["case-insensitive no-such-file code", errorWithCode("missing", "NO SUCH FILE OR DIRECTORY")],
  ])("classifies %s as a missing optional config", async (_label, error) => {
    const files = { readFile: () => Promise.reject(error) };

    await expect(loadWorkspaceTasksConfig(files)).resolves.toEqual({
      kind: "missing",
      message: "No workspace tasks configured here.",
      hint: `${TASKS_CONFIG_PATH} is optional. Create it in this workspace if you want custom tasks.`,
      snapshot: { kind: "missing" },
    });
  });

  it("classifies complete invalid text separately and retains its exact snapshot", async () => {
    await expect(loadWorkspaceTasksConfig({ readFile: () => Promise.resolve(textFile(invalidSource)) })).resolves.toEqual({
      kind: "invalid",
      message: "Workspace tasks configuration is invalid.",
      hint: `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`,
      detail: "Config version must be 1",
      snapshot: { kind: "text", content: invalidSource },
    });
  });

  it("classifies binary content as unavailable without a mutation snapshot", async () => {
    await expect(loadWorkspaceTasksConfig({ readFile: () => Promise.resolve({ content: "not text", truncated: false, binary: true }) })).resolves.toEqual({
      kind: "unavailable",
      message: "Could not load workspace tasks.",
      hint: `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`,
      detail: `${TASKS_CONFIG_PATH} must be a text file`,
    });
  });

  it("classifies truncated content as unavailable without a mutation snapshot", async () => {
    await expect(loadWorkspaceTasksConfig({ readFile: () => Promise.resolve({ content: "partial", truncated: true, binary: false }) })).resolves.toEqual({
      kind: "unavailable",
      message: "Could not load workspace tasks.",
      hint: `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`,
      detail: `${TASKS_CONFIG_PATH} is too large and was truncated`,
    });
  });

  it("returns an unavailable result for an ordinary read failure", async () => {
    await expect(loadWorkspaceTasksConfig({ readFile: () => Promise.reject(new Error("permission denied")) })).resolves.toEqual({
      kind: "unavailable",
      message: "Could not load workspace tasks.",
      hint: `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`,
      detail: `Unable to read ${TASKS_CONFIG_PATH}: permission denied`,
    });
  });

  it("publishes one authoritative cache entry for a cache-miss load", async () => {
    const files = memoryFiles(emptySource);
    const notifications: string[] = [];
    const unsubscribe = subscribeWorkspaceTasksConfig((workspaceKey) => notifications.push(workspaceKey));

    expect(ensureWorkspaceTasksConfig(files, "workspace-1")).toEqual({
      state: { kind: "loading" },
      refreshRequired: false,
    });
    await settle();

    expect(getWorkspaceTasksCacheEntry("workspace-1")).toEqual({
      state: {
        kind: "loaded",
        path: TASKS_CONFIG_PATH,
        config: emptyWorkspaceTasksConfig,
        snapshot: { kind: "text", content: emptySource },
      },
      refreshRequired: false,
    });
    expect(notifications).toEqual(["workspace-1"]);
    unsubscribe();
  });

  it("writes once after a matching text preflight and verifies the canonical post-write snapshot", async () => {
    const files = memoryFiles(emptySource);

    await expect(guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig)).resolves.toEqual({
      kind: "written",
      state: {
        kind: "loaded",
        path: TASKS_CONFIG_PATH,
        config: nextConfig,
        snapshot: { kind: "text", content: nextPayload },
      },
    });
    expect(files.writes).toEqual([nextPayload]);
    expect(files.content).toBe(nextPayload);
  });

  it("creates the file after a matching missing preflight", async () => {
    const files = memoryFiles();

    const result = await guardedWriteWorkspaceTasksConfig(files, "workspace-1", { kind: "missing" }, nextConfig);

    expect(result.kind).toBe("written");
    expect(files.writes).toEqual([nextPayload]);
    expect(files.content).toBe(nextPayload);
  });

  it.each([
    ["changed text", memoryFiles(`${emptySource}\n`), textSnapshot(emptySource)],
    ["loaded snapshot now missing", memoryFiles(), textSnapshot(emptySource)],
    ["missing snapshot now created", memoryFiles(emptySource), missingSnapshot],
  ])("refuses a %s conflict without writing", async (_label, files, sourceSnapshot) => {
    const result = await guardedWriteWorkspaceTasksConfig(files, "workspace-1", sourceSnapshot, nextConfig);

    expect(result.kind).toBe("conflict");
    expect(files.writes).toHaveLength(0);
  });

  it.each([
    ["read error", memoryFiles(emptySource, { kind: "error", error: new Error("offline") })],
    ["binary content", memoryFiles(emptySource, { kind: "value", value: { content: "binary", truncated: false, binary: true } })],
    ["truncated content", memoryFiles(emptySource, { kind: "value", value: { content: "partial", truncated: true, binary: false } })],
  ])("returns preflight-unavailable for %s without writing", async (_label, files) => {
    const result = await guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig);

    expect(result.kind).toBe("preflight-unavailable");
    expect(files.writes).toHaveLength(0);
  });

  it("returns write-failed when the write adapter rejects", async () => {
    const files = memoryFiles(emptySource);
    files.writeError = new Error("disk full");

    const result = await guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig);

    expect(result).toEqual({ kind: "write-failed", detail: `Unable to write ${TASKS_CONFIG_PATH}: disk full` });
    expect(files.writes).toEqual([nextPayload]);
    expect(files.readFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["read rejection", (files: MemoryFiles) => { files.afterWrite = () => { files.readSteps.push({ kind: "error", error: new Error("offline") }); }; }],
    ["invalid text", (files: MemoryFiles) => { files.afterWrite = () => { files.content = invalidSource; }; }],
    ["missing file", (files: MemoryFiles) => { files.afterWrite = () => { files.content = undefined; }; }],
    ["different valid text", (files: MemoryFiles) => { files.afterWrite = () => { files.content = emptySource; }; }],
  ])("classifies a successful write with an unreloadable %s result", async (_label, prepare) => {
    const files = memoryFiles(emptySource);
    prepare(files);

    const result = await guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig);

    expect(result.kind).toBe("written-but-unreloaded");
    expect(files.writes).toEqual([nextPayload]);
  });

  it("allows reset of a matching invalid text snapshot", async () => {
    const files = memoryFiles(invalidSource);

    const result = await guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(invalidSource), emptyWorkspaceTasksConfig);

    expect(result.kind).toBe("written");
    expect(files.writes).toEqual([serializeWorkspaceTasksConfig(emptyWorkspaceTasksConfig)]);
    expect(files.content).toBe(serializeWorkspaceTasksConfig(emptyWorkspaceTasksConfig));
  });

  it("rejects a mutation queued after a conflict before another read or write", async () => {
    const files = memoryFiles(`${emptySource}\n`);
    const first = guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig);
    const second = guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig);

    await expect(first).resolves.toMatchObject({ kind: "conflict" });
    await expect(second).resolves.toMatchObject({ kind: "preflight-unavailable" });
    expect(files.readFile).toHaveBeenCalledTimes(1);
    expect(files.writes).toHaveLength(0);
  });

  it("unblocks later mutations after a successful explicit refresh", async () => {
    const files = memoryFiles(`${emptySource}\n`);
    await guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig);

    files.content = emptySource;
    await expect(refreshWorkspaceTasksConfig(files, "workspace-1")).resolves.toMatchObject({ kind: "loaded" });
    await expect(guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig)).resolves.toMatchObject({ kind: "written" });
    expect(files.writes).toHaveLength(1);
  });

  it("keeps the mutation gate blocked after an unavailable explicit refresh", async () => {
    const files = memoryFiles(`${emptySource}\n`);
    await guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig);

    files.readSteps.push({ kind: "error", error: new Error("offline") });
    await expect(refreshWorkspaceTasksConfig(files, "workspace-1")).resolves.toMatchObject({ kind: "unavailable" });
    files.content = emptySource;

    await expect(guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig)).resolves.toMatchObject({ kind: "preflight-unavailable" });
    expect(files.writes).toHaveLength(0);
    expect(files.readFile).toHaveBeenCalledTimes(2);
  });

  it("runs a refresh requested during a write after post-write verification", async () => {
    const files = memoryFiles(emptySource);
    const writeStarted = deferred<true>();
    const writeGate = deferred<true>();
    files.onWriteStarted = () => { writeStarted.resolve(true); };
    files.writeGate = writeGate.promise;

    const mutation = guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig);
    await writeStarted.promise;
    const refresh = refreshWorkspaceTasksConfig(files, "workspace-1");

    expect(files.readFile).toHaveBeenCalledTimes(1);
    writeGate.resolve(true);
    await expect(mutation).resolves.toMatchObject({ kind: "written" });
    await expect(refresh).resolves.toMatchObject({ kind: "loaded" });
    expect(files.readFile).toHaveBeenCalledTimes(3);
  });

  it("serializes same-key operations without blocking a different workspace key", async () => {
    const firstRead = deferred<WorkspaceTasksFileContent>();
    const firstFiles = memoryFiles(emptySource, { kind: "promise", promise: firstRead.promise });
    const otherFiles = memoryFiles(emptySource);

    const first = refreshWorkspaceTasksConfig(firstFiles, "workspace-1");
    const second = refreshWorkspaceTasksConfig(firstFiles, "workspace-1");
    const other = refreshWorkspaceTasksConfig(otherFiles, "workspace-2");

    await expect(other).resolves.toMatchObject({ kind: "loaded" });
    expect(firstFiles.readFile).toHaveBeenCalledTimes(1);
    firstRead.resolve(textFile(emptySource));
    await expect(first).resolves.toMatchObject({ kind: "loaded" });
    await expect(second).resolves.toMatchObject({ kind: "loaded" });
    expect(firstFiles.readFile).toHaveBeenCalledTimes(2);
  });

  it("suppresses pending load publication and notification after cache clear", async () => {
    const pendingRead = deferred<WorkspaceTasksFileContent>();
    const files = memoryFiles(emptySource, { kind: "promise", promise: pendingRead.promise });
    const notifications: string[] = [];
    const unsubscribe = subscribeWorkspaceTasksConfig((workspaceKey) => notifications.push(workspaceKey));

    ensureWorkspaceTasksConfig(files, "workspace-1");
    clearWorkspaceTasksStateForTesting();
    pendingRead.resolve(textFile(emptySource));
    await settle();

    expect(getWorkspaceTasksCacheEntry("workspace-1")).toBeUndefined();
    expect(notifications).toEqual([]);
    unsubscribe();
  });

  it("cleans up a rejected mutation queue so a later refresh can proceed", async () => {
    const files = memoryFiles(emptySource);
    files.writeError = new Error("adapter rejected");

    await expect(guardedWriteWorkspaceTasksConfig(files, "workspace-1", textSnapshot(emptySource), nextConfig)).resolves.toMatchObject({ kind: "write-failed" });
    files.writeError = undefined;
    await expect(refreshWorkspaceTasksConfig(files, "workspace-1")).resolves.toMatchObject({ kind: "loaded" });
    expect(files.readFile).toHaveBeenCalledTimes(2);
  });
});

type ReadStep =
  | { kind: "value"; value: WorkspaceTasksFileContent }
  | { kind: "error"; error: Error }
  | { kind: "promise"; promise: Promise<WorkspaceTasksFileContent> };

class MemoryFiles implements WorkspaceTasksFiles {
  content: string | undefined;
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly readSteps: ReadStep[] = [];
  writeError: Error | undefined;
  afterWrite: ((content: string) => void) | undefined;
  writeGate: Promise<true> | undefined;
  onWriteStarted: (() => void) | undefined;
  readonly readFile = vi.fn<WorkspaceTasksFiles["readFile"]>((path) => {
    this.reads.push(path);
    const step = this.readSteps.shift();
    if (step?.kind === "error") return Promise.reject(step.error);
    if (step?.kind === "promise") return step.promise;
    if (step?.kind === "value") return Promise.resolve(step.value);
    if (this.content === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve(textFile(this.content));
  });
  readonly writeFile = vi.fn<WorkspaceTasksFiles["writeFile"]>(async (_path, content) => {
    const serialized = typeof content === "string" ? content : new TextDecoder().decode(content);
    this.writes.push(serialized);
    if (this.writeError !== undefined) throw this.writeError;
    this.content = serialized;
    this.afterWrite?.(serialized);
    this.onWriteStarted?.();
    await this.writeGate;
    return { ok: true };
  });

  constructor(content?: string, initialReadStep?: ReadStep) {
    this.content = content;
    if (initialReadStep !== undefined) this.readSteps.push(initialReadStep);
  }
}

type MemoryFilesFactory = (content?: string, initialReadStep?: ReadStep) => MemoryFiles;
const memoryFiles: MemoryFilesFactory = (content, initialReadStep) => new MemoryFiles(content, initialReadStep);

function textFile(content: string): WorkspaceTasksFileContent {
  return { content, truncated: false, binary: false };
}

function errorWithCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function textSnapshot(content: string): WorkspaceTasksSnapshot {
  return { kind: "text", content };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
