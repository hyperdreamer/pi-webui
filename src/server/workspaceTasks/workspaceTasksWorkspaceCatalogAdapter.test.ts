import { describe, expect, it } from "vitest";
import type { WorkspaceCatalogAddress } from "../../shared/apiTypes.js";
import { serializeWorkspaceTasksConfig, type WorkspaceTasksConfig } from "../../shared/workspaceTasks.js";
import {
  WorkspaceTasksRevisionConflictError,
  WorkspaceTasksUnknownOutcomeError,
  type WorkspaceTasksMovePermit,
  type WorkspaceTasksMutationAuthorizer,
} from "./workspaceTasksErrors.js";
import {
  createWorkspaceTasksWorkspaceCatalogAdapter,
  type WorkspaceTasksWorkspaceCatalogAdapter,
  type WorkspaceTasksWorkspaceFileRead,
  type WorkspaceTasksWorkspaceFilePublicationHooks,
  type WorkspaceTasksWorkspaceFileResolver,
  type WorkspaceTasksWorkspaceMutationCoordinator,
} from "./workspaceTasksWorkspaceCatalogAdapter.js";

describe("WorkspaceTasksWorkspaceCatalogAdapter", () => {
  it("loads valid v1 text and preserves missing as a distinct response", async () => {
    const address = addressFor("workspace");
    const files = new FakeWorkspaceFiles({ [key(address)]: { kind: "missing", revision: "missing-revision" } });
    const adapter = createAdapter(files);

    await expect(adapter.read(address)).resolves.toMatchObject({
      kind: "missing",
      revision: "missing-revision",
    });

    files.set(address, present(catalogWithTask("build"), "source-revision"));
    await expect(adapter.read(address)).resolves.toEqual({
      kind: "loaded",
      config: catalogWithTask("build"),
      revision: "source-revision",
    });
  });

  it("reports invalid source text without a revision and maps raw failures to unavailable", async () => {
    const address = addressFor("workspace");
    const files = new FakeWorkspaceFiles({
      [key(address)]: presentBytes(Buffer.from("{\"version\":2,\"tasks\":[]}\n", "utf8"), "invalid-revision"),
    });
    const adapter = createAdapter(files);

    const invalid = await adapter.read(address);
    expect(invalid.kind).toBe("invalid");
    if (invalid.kind === "invalid") expect(invalid.detail).not.toBe("");
    expect(invalid).not.toHaveProperty("revision");

    files.readFailure = new Error("permission denied");
    await expect(adapter.read(address)).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("checks the expected revision and performs zero writes on a conflict", async () => {
    const address = addressFor("workspace");
    const current = catalogWithTask("build");
    const files = new FakeWorkspaceFiles({ [key(address)]: present(current, "current-revision") });
    const coordinator = new RecordingWorkspaceMutationCoordinator();
    const adapter = createAdapter(files, { coordinator });

    await expect(adapter.replace(address, { expectedRevision: "stale-revision", config: catalogWithTask("test") }))
      .rejects.toBeInstanceOf(WorkspaceTasksRevisionConflictError);

    expect(files.publishCalls).toBe(0);
    expect(coordinator.addresses).toEqual([address]);
  });

  it("asserts the exact workspace intent inside the queue immediately before publication", async () => {
    const address = addressFor("workspace");
    const current = catalogWithTask("build");
    const replacement = catalogWithTask("test");
    const files = new FakeWorkspaceFiles({ [key(address)]: present(current, "current-revision") });
    const authorizer = new TestAuthorizer();
    const blocked = new Error("late move claim");
    const coordinator = new RecordingWorkspaceMutationCoordinator();
    coordinator.onOperationEntry = () => {
      authorizer.assertionError = blocked;
    };
    const adapter = createAdapter(files, { coordinator, authorizer });

    await expect(adapter.replace(address, { expectedRevision: "current-revision", config: replacement }))
      .rejects.toBe(blocked);

    expect(authorizer.reconciled).toEqual([{ scope: "workspace", address }]);
    expect(authorizer.intents).toHaveLength(1);
    expect(files.publishCalls).toBe(0);
  });

  it("rejects a permit paired with another address, revision, or canonical catalog", async () => {
    const first = addressFor("first");
    const second = addressFor("second");
    const permit = testPermit();
    const authorizer = new TestAuthorizer();
    const files = new FakeWorkspaceFiles({
      [key(first)]: present(catalogWithTask("build"), "first-revision"),
      [key(second)]: present(catalogWithTask("build"), "second-revision"),
    });
    const adapter = createAdapter(files, { authorizer });
    authorizer.expectedPermit = permit;
    authorizer.expectedIntent = {
      scope: "workspace",
      address: first,
      expectedRevision: "first-revision",
      config: catalogWithTask("test"),
    };

    await expect(adapter.replace(second, { expectedRevision: "second-revision", config: catalogWithTask("test") }, { permit }))
      .rejects.toThrow("permit did not authorize");
    expect(files.publishCalls).toBe(0);
  });

  it("acknowledges after rename and reports verification failures as unknown outcome", async () => {
    const address = addressFor("workspace");
    const current = catalogWithTask("build");
    const replacement = catalogWithTask("test");
    const files = new FakeWorkspaceFiles({ [key(address)]: present(current, "current-revision") });
    files.afterPublish = () => {
      files.set(address, present(catalogWithTask("external"), "external-revision"));
    };
    const adapter = createAdapter(files);
    const events: string[] = [];

    await expect(adapter.replace(address, { expectedRevision: "current-revision", config: replacement }, {
      onWriteAcknowledged: () => events.push("acknowledged"),
      onWriteOutcomeUnknown: () => events.push("unknown"),
    })).rejects.toBeInstanceOf(WorkspaceTasksUnknownOutcomeError);

    expect(events).toEqual(["acknowledged", "unknown"]);
  });

  it("maps final rename failures after publication attempt to unknown outcome", async () => {
    const address = addressFor("workspace");
    const files = new FakeWorkspaceFiles({ [key(address)]: present(catalogWithTask("build"), "current-revision") });
    files.publishFailure = { phase: "after-publication", error: new Error("rename failed") };
    const adapter = createAdapter(files);
    const events: string[] = [];

    await expect(adapter.replace(address, { expectedRevision: "current-revision", config: catalogWithTask("test") }, {
      onWriteAcknowledged: () => events.push("acknowledged"),
      onWriteOutcomeUnknown: () => events.push("unknown"),
    })).rejects.toBeInstanceOf(WorkspaceTasksUnknownOutcomeError);

    expect(events).toEqual(["unknown"]);
  });

  it("serializes same-address operations FIFO while allowing independent addresses to proceed", async () => {
    const first = addressFor("first");
    const second = addressFor("second");
    const coordinator = new RecordingWorkspaceMutationCoordinator();
    const files = new FakeWorkspaceFiles({
      [key(first)]: present(catalogWithTask("first"), "first-revision"),
      [key(second)]: present(catalogWithTask("second"), "second-revision"),
    });
    const adapter = createAdapter(files, { coordinator });
    const firstGate = deferred<true>();
    const order: string[] = [];
    coordinator.operationGate = async (address) => {
      order.push(`${address.workspaceId}:start`);
      if (address.workspaceId === "first" && order.filter((entry) => entry === "first:start").length === 1) await firstGate.promise;
      order.push(`${address.workspaceId}:end`);
    };

    const firstWrite = adapter.replace(first, { expectedRevision: "first-revision", config: catalogWithTask("first-next") });
    const secondWrite = adapter.replace(second, { expectedRevision: "second-revision", config: catalogWithTask("second-next") });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first:start", "second:start", "second:end"]);
    firstGate.resolve(true);
    await Promise.all([firstWrite, secondWrite]);
    expect(order).toEqual(["first:start", "second:start", "second:end", "first:end"]);
  });
});

class FakeWorkspaceFiles implements WorkspaceTasksWorkspaceFileResolver {
  publishCalls = 0;
  readFailure: Error | undefined;
  publishFailure: { phase: "before-publication" | "after-publication"; error: Error } | undefined;
  afterPublish: (() => void) | undefined;

  constructor(private readonly entries: Record<string, WorkspaceTasksWorkspaceFileRead>) {}

  set(address: WorkspaceCatalogAddress, entry: WorkspaceTasksWorkspaceFileRead): void {
    this.entries[key(address)] = entry;
  }

  readCatalog(address: WorkspaceCatalogAddress): Promise<WorkspaceTasksWorkspaceFileRead> {
    if (this.readFailure !== undefined) return Promise.reject(this.readFailure);
    return Promise.resolve(this.entries[key(address)] ?? { kind: "missing", revision: "missing" });
  }

  publishCatalog(
    address: WorkspaceCatalogAddress,
    bytes: Buffer,
    hooks: WorkspaceTasksWorkspaceFilePublicationHooks = {},
  ): Promise<void> {
    this.publishCalls += 1;
    if (this.publishFailure?.phase === "before-publication") return Promise.reject(this.publishFailure.error);
    hooks.onPublicationAttempt?.();
    if (this.publishFailure?.phase === "after-publication") return Promise.reject(this.publishFailure.error);
    this.entries[key(address)] = presentBytes(bytes, `published-${String(this.publishCalls)}`);
    hooks.onPublished?.();
    this.afterPublish?.();
    return Promise.resolve();
  }

  writeExplorerTaskFile(): never {
    throw new Error("not used");
  }

  deleteExplorerTaskFile(): never {
    throw new Error("not used");
  }

  moveExplorerTaskFile(): never {
    throw new Error("not used");
  }
}

class RecordingWorkspaceMutationCoordinator implements WorkspaceTasksWorkspaceMutationCoordinator {
  addresses: WorkspaceCatalogAddress[] = [];
  onOperationEntry: (() => void) | undefined;
  operationGate: ((address: WorkspaceCatalogAddress) => Promise<void>) | undefined;
  private tails = new Map<string, Promise<void>>();

  async run<T>(address: WorkspaceCatalogAddress, operation: () => Promise<T>): Promise<T> {
    this.addresses.push(address);
    const previous = this.tails.get(key(address)) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key(address), previous.then(() => current));
    await previous;
    this.onOperationEntry?.();
    await this.operationGate?.(address);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class TestAuthorizer implements Pick<WorkspaceTasksMutationAuthorizer, "reconcileGlobalMoveClaim" | "assertWorkspaceMutationAllowed"> {
  reconciled: { scope: "workspace"; address: WorkspaceCatalogAddress }[] = [];
  intents: unknown[] = [];
  assertionError: Error | undefined;
  expectedPermit: WorkspaceTasksMovePermit | undefined;
  expectedIntent: unknown;

  reconcileGlobalMoveClaim(subject: { scope: "workspace"; address: WorkspaceCatalogAddress }): Promise<void> {
    this.reconciled.push(subject);
    return Promise.resolve();
  }

  assertGlobalMutationAllowed(): void {
    // Global assertions are outside this workspace-adapter test double.
  }

  assertWorkspaceMutationAllowed(address: WorkspaceCatalogAddress, intent: unknown, permit?: WorkspaceTasksMovePermit): void {
    this.intents.push(intent);
    if (this.assertionError !== undefined) throw this.assertionError;
    if (this.expectedIntent !== undefined && (permit !== this.expectedPermit || JSON.stringify(intent) !== JSON.stringify(this.expectedIntent))) {
      throw new Error("permit did not authorize");
    }
    void address;
  }
}

function createAdapter(
  files: WorkspaceTasksWorkspaceFileResolver,
  overrides: {
    coordinator?: WorkspaceTasksWorkspaceMutationCoordinator;
    authorizer?: TestAuthorizer;
  } = {},
): WorkspaceTasksWorkspaceCatalogAdapter {
  return createWorkspaceTasksWorkspaceCatalogAdapter({
    files,
    authorizer: overrides.authorizer ?? new TestAuthorizer(),
    workspaceMutations: overrides.coordinator ?? new RecordingWorkspaceMutationCoordinator(),
  });
}

function addressFor(workspaceId: string): WorkspaceCatalogAddress {
  return { projectId: "project", workspaceId };
}

function key(address: WorkspaceCatalogAddress): string {
  return `${address.projectId}:${address.workspaceId}`;
}

function present(config: WorkspaceTasksConfig, revision: string): WorkspaceTasksWorkspaceFileRead {
  return presentBytes(Buffer.from(serializeWorkspaceTasksConfig(config), "utf8"), revision);
}

function presentBytes(bytes: Buffer, revision: string): WorkspaceTasksWorkspaceFileRead {
  return { kind: "present", bytes, revision };
}

function catalogWithTask(id: string): WorkspaceTasksConfig {
  return { version: 1, tasks: [{ id, title: id, command: `npm run ${id}`, confirm: false }] };
}

function testPermit(): WorkspaceTasksMovePermit {
  const candidate: unknown = {};
  if (!isTestPermit(candidate)) throw new Error("test permit could not be created");
  return candidate;
}

function isTestPermit(value: unknown): value is WorkspaceTasksMovePermit {
  return typeof value === "object" && value !== null;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
