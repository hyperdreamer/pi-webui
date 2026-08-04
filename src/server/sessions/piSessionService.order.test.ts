import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionReorderRequest, SessionReorderScope } from "../../shared/apiTypes.js";
import {
  PiSessionService,
  type PiSessionListEntry,
  type PiSessionManagerGateway,
} from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRuntime,
  fakeSessionManager,
  runtimeCreator,
  sessionRecord,
  testModelRuntime,
} from "./piSessionService.testSupport.js";
import {
  SessionMetadataOrderConflictError,
  SessionMetadataStore,
} from "./sessionMetadataStore.js";
import type {
  ArchivedSessionRecord,
  ArchiveSessionInput,
} from "./sessionArchiveStore.js";

const TEST_AGENT_DIR = "/tmp/pi-webui-test-agent";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function operationBarrier(): OperationBarrier {
  return {
    entryCount: 0,
    started: deferred(),
    release: deferred(),
  };
}

interface TestArchiveStore {
  list(): Promise<ArchivedSessionRecord[]>;
  get(sessionId: string): Promise<ArchivedSessionRecord | undefined>;
  archive(input: ArchiveSessionInput): Promise<ArchivedSessionRecord>;
  archiveMany(inputs: readonly ArchiveSessionInput[]): Promise<ArchivedSessionRecord[]>;
  restore(sessionId: string): Promise<void>;
  isArchived(sessionId: string): Promise<boolean>;
}

interface OperationBarrier {
  entryCount: number;
  started: Deferred<void>;
  release: Deferred<void>;
}

interface ServiceHarness {
  root: string;
  service: PiSessionService;
  metadataStore: SessionMetadataStore;
  recordsByCwd: Map<string, PiSessionListEntry[]>;
  archiveRecords: ArchivedSessionRecord[];
  archiveStore: TestArchiveStore;
  archiveCalls: { archive: number; archiveMany: number; restore: number; list: number };
  clearParentBarrier: OperationBarrier | undefined;
  closeActiveCalls: { count: number };
  gatewayCalls: { list: number; listAll: number };
  first: PiSessionListEntry;
  second: PiSessionListEntry;
  dispose(): Promise<void>;
}

interface HarnessOptions {
  metadataStore?: (path: string) => SessionMetadataStore;
  records?: (root: string) => PiSessionListEntry[];
  archivedRecords?: ArchivedSessionRecord[];
  activeSessionId?: string;
  archiveManyBarrier?: OperationBarrier;
  clearParentBarrier?: OperationBarrier;
}

class BlockingMetadataStore extends SessionMetadataStore {
  readonly replaceStarted = deferred();
  readonly mutationCalls = { pin: 0, unpin: 0, clearOrder: 0 };
  private readonly replaceRelease = deferred();

  override async pin(sessionPath: string): Promise<void> {
    this.mutationCalls.pin += 1;
    await super.pin(sessionPath);
  }

  override async unpin(sessionPath: string): Promise<void> {
    this.mutationCalls.unpin += 1;
    await super.unpin(sessionPath);
  }

  override async clearOrder(sessionPath: string): Promise<void> {
    this.mutationCalls.clearOrder += 1;
    await super.clearOrder(sessionPath);
  }

  override async replaceOrder(
    sessionPaths: readonly string[],
    scope: SessionReorderScope,
    pinned: boolean,
  ): Promise<void> {
    this.replaceStarted.resolve();
    await this.replaceRelease.promise;
    await super.replaceOrder(sessionPaths, scope, pinned);
  }

  releaseReplace(): void {
    this.replaceRelease.resolve();
  }
}

class PinConflictMetadataStore extends SessionMetadataStore {
  override replaceOrder(): Promise<void> {
    return Promise.reject(new SessionMetadataOrderConflictError());
  }
}

class AfterReplaceMetadataStore extends SessionMetadataStore {
  constructor(path: string, private readonly afterReplace: () => void) {
    super(path);
  }

  override async replaceOrder(
    sessionPaths: readonly string[],
    scope: SessionReorderScope,
    pinned: boolean,
  ): Promise<void> {
    await super.replaceOrder(sessionPaths, scope, pinned);
    this.afterReplace();
  }
}

class FailingMetadataStore extends SessionMetadataStore {
  override replaceOrder(): Promise<void> {
    return Promise.reject(new Error("metadata persistence failed"));
  }
}

const harnesses: ServiceHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("PiSessionService durable session ordering", () => {
  it("persists a normalized root order and returns the assigned positions", async () => {
    const harness = await createHarness();
    const request = rootRequest(harness, [harness.second, harness.first]);

    await expect(harness.service.reorder(
      { id: harness.first.id, cwd: harness.first.cwd },
      request,
    )).resolves.toEqual({
      orderedSessions: [
        { id: harness.second.id, cwd: harness.second.cwd, manualOrder: 0 },
        { id: harness.first.id, cwd: harness.first.cwd, manualOrder: 1 },
      ],
    });

    const snapshot = await harness.metadataStore.snapshot();
    expect(snapshot[harness.second.path]?.order).toEqual({
      position: 0,
      scope: { kind: "root", cwd: "/repo" },
      pinned: false,
    });
    expect(snapshot[harness.first.path]?.order).toEqual({
      position: 1,
      scope: { kind: "root", cwd: "/repo" },
      pinned: false,
    });
    await expect(harness.service.list("/repo")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: harness.second.id, manualOrder: 0 }),
      expect.objectContaining({ id: harness.first.id, manualOrder: 1 }),
    ]));
  });

  it("loads each cross-workspace child catalog from one metadata and archive snapshot", async () => {
    const parentSessionPath = "/sessions/parent.jsonl";
    const harness = await createHarness({
      activeSessionId: "main-child",
      records: (root) => [
        listedSession("main-child", "/repo", join(root, "main-child.jsonl"), { parentSessionPath }),
        listedSession("feature-child", "/feature", join(root, "feature-child.jsonl"), { parentSessionPath }),
      ],
    });
    const metadataSnapshot = vi.spyOn(harness.metadataStore, "snapshot");
    const request: SessionReorderRequest = {
      cwd: "/repo",
      scope: { kind: "children", parentSessionPath },
      pinned: false,
      catalogCwds: ["/repo", "/feature"],
      orderedSessions: [
        { id: "feature-child", cwd: "/feature" },
        { id: "main-child", cwd: "/repo" },
      ],
    };

    await expect(harness.service.reorder(
      { id: "main-child", cwd: "/repo" },
      request,
    )).resolves.toEqual({
      orderedSessions: [
        { id: "feature-child", cwd: "/feature", manualOrder: 0 },
        { id: "main-child", cwd: "/repo", manualOrder: 1 },
      ],
    });

    expect(metadataSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.archiveCalls.list).toBe(2);
  });

  it("rejects a request that omits a current sibling before persisting", async () => {
    const harness = await createHarness();
    const request = rootRequest(harness, [harness.first]);

    await expect(harness.service.reorder(
      { id: harness.first.id, cwd: harness.first.cwd },
      request,
    )).rejects.toMatchObject({ kind: "conflict" });
    await expect(harness.metadataStore.snapshot()).resolves.toEqual({});
  });

  it("converts a final metadata pin race into a reorder conflict", async () => {
    const harness = await createHarness({
      metadataStore: (path) => new PinConflictMetadataStore(path),
    });

    await expect(harness.service.reorder(
      { id: harness.first.id, cwd: harness.first.cwd },
      rootRequest(harness, [harness.second, harness.first]),
    )).rejects.toMatchObject({
      kind: "conflict",
      message: "Session pin state changed during reorder",
    });
  });

  it("allows a concurrently created unordered sibling after the durable write", async () => {
    let afterReplace = (): void => undefined;
    const harness = await createHarness({
      metadataStore: (path) => new AfterReplaceMetadataStore(path, () => { afterReplace(); }),
    });
    const newSibling = listedSession("new", "/repo", join(harness.root, "new.jsonl"));
    afterReplace = () => {
      harness.recordsByCwd.get("/repo")?.push(newSibling);
    };

    await expect(harness.service.reorder(
      { id: harness.first.id, cwd: harness.first.cwd },
      rootRequest(harness, [harness.second, harness.first]),
    )).resolves.toEqual({
      orderedSessions: [
        { id: harness.second.id, cwd: harness.second.cwd, manualOrder: 0 },
        { id: harness.first.id, cwd: harness.first.cwd, manualOrder: 1 },
      ],
    });
  });

  it("propagates a metadata persistence failure without returning a reorder response", async () => {
    const harness = await createHarness({
      metadataStore: (path) => new FailingMetadataStore(path),
    });

    await expect(harness.service.reorder(
      { id: harness.first.id, cwd: harness.first.cwd },
      rootRequest(harness, [harness.second, harness.first]),
    )).rejects.toThrow("metadata persistence failed");
  });

  it("preserves a same-scope manual position through archive and restore", async () => {
    const harness = await createHarness();
    await harness.service.reorder(
      { id: harness.first.id, cwd: harness.first.cwd },
      rootRequest(harness, [harness.second, harness.first]),
    );

    const positioned = await harness.service.list("/repo");
    expect(positioned.find((session) => session.id === harness.first.id)).toMatchObject({
      manualOrder: 1,
    });

    await harness.service.archive({ id: harness.first.id, cwd: harness.first.cwd });

    const archived = (await harness.service.list("/repo"))
      .find((session) => session.id === harness.first.id);
    expect(archived).toMatchObject({ archived: true });
    expect(archived === undefined ? undefined : Object.hasOwn(archived, "manualOrder")).toBe(false);
    expect((await harness.metadataStore.snapshot())[harness.first.path]?.order).toEqual({
      position: 1,
      scope: { kind: "root", cwd: "/repo" },
      pinned: false,
    });

    await harness.service.restore({ id: harness.first.id, cwd: harness.first.cwd });

    const restored = await harness.service.list("/repo");
    expect(restored.find((session) => session.id === harness.second.id)).toMatchObject({ manualOrder: 0 });
    expect(restored.find((session) => session.id === harness.first.id)).toMatchObject({ manualOrder: 1 });
  });

  for (const mutation of queuedMutations()) {
    it(`does not let ${mutation.name} enter its critical body while reorder holds the ordering queue`, async () => {
      const clearParentBarrier = mutation.needsClearParentBarrier === true
        ? operationBarrier()
        : undefined;
      const harness = await createHarness({
        metadataStore: (path) => new BlockingMetadataStore(path),
        ...(mutation.needsArchivedRecord === true ? {
          archivedRecords: [{
            sessionId: "archived",
            cwd: "/repo",
            archivedAt: "2026-01-01T00:00:00.000Z",
            originalPath: join("/sessions", "archived.jsonl"),
          }],
        } : {}),
        ...(clearParentBarrier === undefined ? {} : { clearParentBarrier }),
      });
      if (mutation.needsArchivedRecord !== true)
        await activateFirstSession(harness);
      const metadataStore = blockingMetadataStore(harness);
      const reorder = harness.service.reorder(
        { id: harness.first.id, cwd: harness.first.cwd },
        rootRequest(harness, [harness.second, harness.first]),
      );
      await metadataStore.replaceStarted.promise;

      const operation = mutation.run(harness);
      let reorderError: unknown;
      let operationError: unknown;
      try {
        await flushImmediatePromiseWork();
        expect(mutation.criticalCalls(harness)).toBe(0);
      } finally {
        metadataStore.releaseReplace();
        clearParentBarrier?.release.resolve();
        await reorder.catch((error: unknown) => { reorderError = error; });
        await operation.catch((error: unknown) => { operationError = error; });
      }
      expect(reorderError).toBeUndefined();
      expect(operationError).toBeUndefined();
      expect(mutation.criticalCalls(harness)).toBeGreaterThan(0);
    });
  }

  it("keeps cleanup close and archive phases behind the ordering queue", async () => {
    const archiveManyBarrier = operationBarrier();
    const harness = await createHarness({
      metadataStore: (path) => new BlockingMetadataStore(path),
      archiveManyBarrier,
    });
    await activateFirstSession(harness);
    const metadataStore = blockingMetadataStore(harness);
    const reorder = harness.service.reorder(
      { id: harness.first.id, cwd: harness.first.cwd },
      rootRequest(harness, [harness.second, harness.first]),
    );
    await metadataStore.replaceStarted.promise;

    const cleanup = harness.service.cleanup({
      thresholds: { archiveIdleDays: 1 },
      projectCwds: ["/repo"],
    });
    let reorderError: unknown;
    let cleanupError: unknown;
    try {
      await flushImmediatePromiseWork();
      expect({
        closeActiveCalls: harness.closeActiveCalls.count,
        archiveManyCalls: harness.archiveCalls.archiveMany,
      }).toEqual({ closeActiveCalls: 0, archiveManyCalls: 0 });
    } finally {
      metadataStore.releaseReplace();
      await reorder.catch((error: unknown) => { reorderError = error; });
      await archiveManyBarrier.started.promise;
      archiveManyBarrier.release.resolve();
      await cleanup.catch((error: unknown) => { cleanupError = error; });
    }
    expect(reorderError).toBeUndefined();
    expect(cleanupError).toBeUndefined();
    expect(harness.closeActiveCalls.count).toBeGreaterThan(0);
    expect(harness.archiveCalls.archiveMany).toBeGreaterThan(0);
  });

  it("leaves cleanup preview outside the ordering mutation queue", async () => {
    const harness = await createHarness({
      metadataStore: (path) => new BlockingMetadataStore(path),
    });
    const metadataStore = blockingMetadataStore(harness);
    const reorder = harness.service.reorder(
      { id: harness.first.id, cwd: harness.first.cwd },
      rootRequest(harness, [harness.second, harness.first]),
    );
    await metadataStore.replaceStarted.promise;

    const completedPreview = await settlesWithin(harness.service.cleanupPreview({
      thresholds: { archiveIdleDays: 1 },
      projectCwds: ["/repo"],
    }));
    expect(completedPreview.totals.archiveCount).toBe(2);
    expect(harness.gatewayCalls.listAll).toBeGreaterThan(0);

    metadataStore.releaseReplace();
    await reorder;
  });
});

function queuedMutations(): {
  name: string;
  needsArchivedRecord?: boolean;
  needsClearParentBarrier?: boolean;
  criticalCalls(harness: ServiceHarness): number;
  run(harness: ServiceHarness): Promise<unknown>;
}[] {
  return [
  {
    name: "pin",
    criticalCalls: (harness) => harnessPinCalls(harness),
    run: async (harness) => { await harness.service.pin({ id: harness.first.id, cwd: harness.first.cwd }); },
  },
  {
    name: "unpin",
    criticalCalls: (harness) => harnessUnpinCalls(harness),
    run: async (harness) => { await harness.service.unpin({ id: harness.first.id, cwd: harness.first.cwd }); },
  },
  {
    name: "detach-parent",
    needsClearParentBarrier: true,
    criticalCalls: (harness) => harness.clearParentBarrier?.entryCount ?? 0,
    run: async (harness) => { await harness.service.detachParent({ id: harness.first.id, cwd: harness.first.cwd }); },
  },
  {
    name: "archive",
    criticalCalls: (harness) => harness.archiveCalls.archive,
    run: async (harness) => { await harness.service.archive({ id: harness.first.id, cwd: harness.first.cwd }); },
  },
  {
    name: "bulk archive",
    criticalCalls: (harness) => harness.archiveCalls.archiveMany,
    run: async (harness) => { await harness.service.archiveMany([{ id: harness.first.id, cwd: harness.first.cwd }]); },
  },
  {
    name: "archive tree",
    criticalCalls: (harness) => harness.archiveCalls.archiveMany,
    run: async (harness) => { await harness.service.archiveTree({ id: harness.first.id, cwd: harness.first.cwd }); },
  },
  {
    name: "restore",
    needsArchivedRecord: true,
    criticalCalls: (harness) => harness.archiveCalls.restore,
    run: async (harness) => { await harness.service.restore({ id: "archived", cwd: "/repo" }); },
  },
  ];
}

async function createHarness(options: HarnessOptions = {}): Promise<ServiceHarness> {
  const root = await mkdtemp(join(tmpdir(), "pi-webui-session-order-"));
  const metadataPath = join(root, "session-metadata.json");
  const records = options.records?.(root) ?? [
    listedSession("first", "/repo", join(root, "first.jsonl")),
    listedSession("second", "/repo", join(root, "second.jsonl")),
  ];
  const first = records[0];
  const second = records[1];
  if (first === undefined || second === undefined) {
    throw new Error("Order harness requires at least two sessions");
  }
  const activeSessionId = options.activeSessionId ?? first.id;
  const active = records.find((record) => record.id === activeSessionId);
  if (active === undefined) throw new Error(`Missing active session: ${activeSessionId}`);

  await writeFile(active.path, `${JSON.stringify({ type: "session", id: active.id })}\n`, "utf8");
  const metadataStore = options.metadataStore?.(metadataPath) ?? new SessionMetadataStore(metadataPath);
  const recordsByCwd = new Map<string, PiSessionListEntry[]>();
  for (const record of records) {
    const list = recordsByCwd.get(record.cwd) ?? [];
    list.push(record);
    recordsByCwd.set(record.cwd, list);
  }
  const archiveRecords = [...(options.archivedRecords ?? [])];
  const archiveCalls = { archive: 0, archiveMany: 0, restore: 0, list: 0 };
  const clearParentBarrier = options.clearParentBarrier;
  const closeActiveCalls = { count: 0 };
  const archiveStore: TestArchiveStore = {
    list: () => {
      archiveCalls.list += 1;
      return Promise.resolve([...archiveRecords]);
    },
    get: (sessionId) => Promise.resolve(archiveRecords.find((record) => (
      record.sessionId === sessionId || record.sessionId.startsWith(sessionId)
    ))),
    archive: (input) => {
      archiveCalls.archive += 1;
      const record = archivedRecord(input, root);
      const existing = archiveRecords.findIndex((candidate) => candidate.sessionId === record.sessionId);
      if (existing === -1) archiveRecords.push(record);
      else archiveRecords[existing] = record;
      return Promise.resolve(record);
    },
    archiveMany: async (inputs) => {
      archiveCalls.archiveMany += 1;
      if (options.archiveManyBarrier !== undefined) {
        options.archiveManyBarrier.entryCount += 1;
        options.archiveManyBarrier.started.resolve();
        await options.archiveManyBarrier.release.promise;
      }
      return Promise.all(inputs.map((input) => archiveStore.archive(input)));
    },
    restore: (sessionId) => {
      archiveCalls.restore += 1;
      const index = archiveRecords.findIndex((record) => record.sessionId === sessionId);
      if (index !== -1) archiveRecords.splice(index, 1);
      return Promise.resolve();
    },
    isArchived: (sessionId) => Promise.resolve(archiveRecords.some((record) => record.sessionId === sessionId)),
  };
  const header: { parentSession?: string } = {};
  const sessionManager = fakeSessionManager(active.cwd, {
    getCwd: () => active.cwd,
    getSessionId: () => active.id,
    getSessionFile: () => active.path,
    getHeader: () => header,
  });
  const runtime = fakeRuntime(active.id, {
    sessionManager,
    sessionFile: active.path,
    abort: () => {
      closeActiveCalls.count += 1;
      return Promise.resolve();
    },
  });
  const gatewayCalls = { list: 0, listAll: 0 };
  const gateway: PiSessionManagerGateway = {
    create: () => sessionManager,
    list: (cwd) => {
      gatewayCalls.list += 1;
      return Promise.resolve([...(recordsByCwd.get(cwd) ?? [])]);
    },
    listAll: () => {
      gatewayCalls.listAll += 1;
      return Promise.resolve([...recordsByCwd.values()].flat());
    },
    open: () => sessionManager,
  };
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(runtime.runtime),
    sessionManager: gateway,
    archiveStore,
    metadataStore,
    ...(clearParentBarrier === undefined ? {} : {
      clearParentSession: async () => {
        clearParentBarrier.entryCount += 1;
        clearParentBarrier.started.resolve();
        await clearParentBarrier.release.promise;
      },
    }),
    heartbeatIntervalMs: 60_000,
  });
  const harness: ServiceHarness = {
    root,
    service,
    metadataStore,
    recordsByCwd,
    archiveRecords,
    archiveStore,
    archiveCalls,
    clearParentBarrier,
    closeActiveCalls,
    gatewayCalls,
    first,
    second,
    async dispose() {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

function listedSession(
  id: string,
  cwd: string,
  path: string,
  patch: Partial<PiSessionListEntry> = {},
): PiSessionListEntry {
  return { ...sessionRecord(id, cwd), path, ...patch };
}

function archivedRecord(input: ArchiveSessionInput, root: string): ArchivedSessionRecord {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    archivedAt: "2026-08-04T00:00:00.000Z",
    originalPath: input.path,
    archivePath: join(root, "archive", `${input.sessionId}.jsonl`),
    created: input.created,
    modified: input.modified,
    messageCount: input.messageCount,
    firstMessage: input.firstMessage,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.parentSessionPath === undefined ? {} : { parentSessionPath: input.parentSessionPath }),
  };
}

function rootRequest(
  harness: ServiceHarness,
  ordered: readonly PiSessionListEntry[],
): SessionReorderRequest {
  return {
    cwd: "/repo",
    scope: { kind: "root", cwd: "/repo" },
    pinned: false,
    catalogCwds: ["/repo"],
    orderedSessions: ordered.map((session) => ({ id: session.id, cwd: session.cwd })),
  };
}

function blockingMetadataStore(harness: ServiceHarness): BlockingMetadataStore {
  if (!(harness.metadataStore instanceof BlockingMetadataStore)) {
    throw new Error("Expected blocking metadata store");
  }
  return harness.metadataStore;
}

function harnessPinCalls(harness: ServiceHarness): number {
  return blockingMetadataStore(harness).mutationCalls.pin;
}

function harnessUnpinCalls(harness: ServiceHarness): number {
  return blockingMetadataStore(harness).mutationCalls.unpin;
}

async function activateFirstSession(harness: ServiceHarness): Promise<void> {
  await harness.service.status({ id: harness.first.id, cwd: harness.first.cwd });
}

/** The harness resolves dependencies immediately, so the next check phase drains their promise continuations. */
async function flushImmediatePromiseWork(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

async function settlesWithin<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Operation did not settle while reorder was blocked"));
        }, 1_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
