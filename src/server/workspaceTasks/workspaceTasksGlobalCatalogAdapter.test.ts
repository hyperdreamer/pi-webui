import { describe, expect, it } from "vitest";
import type { PiWebUiConfigMutationCoordinator, PiWebUiConfigMutationOptions, PiWebUiConfigMutationSnapshot } from "../../configMutationCoordinator.js";
import { PiWebUiConfigMutationBusyError } from "../../configMutationCoordinator.js";
import type { WorkspaceCatalogAddress, PiWebUiConfigValues } from "../../shared/apiTypes.js";
import { WORKSPACE_TASKS_CATALOG_MAX_BYTES, type WorkspaceTasksConfig } from "../../shared/workspaceTasks.js";
import {
  WorkspaceTasksInvalidCatalogError,
  WorkspaceTasksRevisionConflictError,
  WorkspaceTasksUnavailableError,
  WorkspaceTasksUnknownOutcomeError,
  type WorkspaceTasksMovePermit,
  type WorkspaceTasksMutationAuthorizer,
  type WorkspaceTasksMoveObservationPort,
  type WorkspaceTasksMutationSubject,
  type WorkspaceTasksMoveWriteIntent,
} from "./workspaceTasksErrors.js";
import { createWorkspaceTasksGlobalCatalogAdapter } from "./workspaceTasksGlobalCatalogAdapter.js";

describe("WorkspaceTasksGlobalCatalogAdapter", () => {
  it("defines one observation port that returns both catalog scopes", async () => {
    const address: WorkspaceCatalogAddress = { projectId: "project", workspaceId: "workspace" };
    let observedAddress: WorkspaceCatalogAddress | undefined;
    const observationPort: WorkspaceTasksMoveObservationPort = {
      observe: (receivedAddress) => {
        observedAddress = receivedAddress;
        return Promise.resolve({
          workspace: { kind: "loaded", config: catalogWithTask("build"), revision: "workspace-revision" },
          global: { kind: "loaded", config: emptyCatalog(), revision: "global-revision" },
        });
      },
    };

    const observed = await observationPort.observe(address);

    expect(observedAddress).toEqual(address);
    expect(observed).toEqual({
      workspace: { kind: "loaded", config: catalogWithTask("build"), revision: "workspace-revision" },
      global: { kind: "loaded", config: emptyCatalog(), revision: "global-revision" },
    });
  });

  it("gives absent and explicit empty global catalogs the same revision", async () => {
    const coordinator = new ControlledCoordinator({ port: 9000 });
    const adapter = createAdapter(coordinator);

    const absent = await adapter.read();
    coordinator.setConfig({
      port: 9000,
      plugins: { "workspace-tasks": { settings: { globalTasks: emptyCatalog() } } },
    });
    const explicit = await adapter.read();

    expect(absent).toEqual({ kind: "loaded", config: emptyCatalog(), revision: explicit.kind === "loaded" ? explicit.revision : "" });
    expect(explicit).toMatchObject({ kind: "loaded", config: emptyCatalog() });
  });

  it("keeps a semantic global revision across unrelated config changes", async () => {
    const catalog = catalogWithTask("build");
    const coordinator = new ControlledCoordinator({
      port: 9000,
      plugins: { "workspace-tasks": { settings: { globalTasks: catalog } } },
    });
    const adapter = createAdapter(coordinator);

    const before = await adapter.read();
    coordinator.setConfig({
      port: 9001,
      plugins: {
        "workspace-tasks": { enabled: false, settings: { globalTasks: catalog, retainedSetting: "yes" } },
        "other-plugin": { settings: { preserved: true } },
      },
    });
    const after = await adapter.read();

    expect(before).toMatchObject({ kind: "loaded", config: catalog });
    expect(after).toMatchObject({ kind: "loaded", config: catalog });
    expect(after.kind === "loaded" && before.kind === "loaded" ? after.revision : "").toBe(before.kind === "loaded" ? before.revision : "");
  });

  it.each([
    ["malformed", { version: 2, tasks: [] }],
    ["oversized", oversizedCatalog()],
  ])("reports an existing %s global catalog as invalid and blocks replacement", async (_kind, globalTasks) => {
    const coordinator = new ControlledCoordinator({
      plugins: { "workspace-tasks": { settings: { globalTasks } } },
    });
    const adapter = createAdapter(coordinator);

    await expect(adapter.read()).resolves.toMatchObject({ kind: "invalid" });
    await expect(adapter.replace({ expectedRevision: "revision", config: emptyCatalog() })).rejects.toBeInstanceOf(WorkspaceTasksInvalidCatalogError);
    expect(coordinator.writes).toBe(0);
  });

  it("rejects a mismatched expected revision without writing", async () => {
    const coordinator = new ControlledCoordinator({
      plugins: { "workspace-tasks": { settings: { globalTasks: catalogWithTask("build") } } },
    });
    const adapter = createAdapter(coordinator);

    await expect(adapter.replace({ expectedRevision: "stale-revision", config: catalogWithTask("test") }))
      .rejects.toBeInstanceOf(WorkspaceTasksRevisionConflictError);
    expect(coordinator.writes).toBe(0);
  });

  it("keeps the same revision and performs no write for an equal semantic replacement", async () => {
    const catalog = catalogWithTask("build");
    const coordinator = new ControlledCoordinator({
      plugins: { "workspace-tasks": { settings: { globalTasks: catalog } } },
    });
    const authorizer = new TestAuthorizer();
    const adapter = createAdapter(coordinator, authorizer);
    const current = await adapter.read();
    if (current.kind !== "loaded") throw new Error("expected loaded catalog");

    const replacement = await adapter.replace({ expectedRevision: current.revision, config: catalog });

    expect(replacement).toEqual(current);
    expect(coordinator.writes).toBe(0);
    expect(authorizer.globalIntents).toEqual([]);
  });

  it("replaces only globalTasks while preserving the surrounding config", async () => {
    const initial = catalogWithTask("build");
    const replacement = catalogWithTask("test");
    const initialConfig: PiWebUiConfigValues = {
      port: 9000,
      plugins: {
        "workspace-tasks": {
          enabled: false,
          unknownPluginField: { retained: true },
          settings: { retainedSetting: "keep", globalTasks: initial },
        },
        "other-plugin": { enabled: true, settings: { unrelated: "value" } },
      },
    };
    const coordinator = new ControlledCoordinator(initialConfig);
    const authorizer = new TestAuthorizer();
    const adapter = createAdapter(coordinator, authorizer);
    const current = await adapter.read();
    if (current.kind !== "loaded") throw new Error("expected loaded catalog");

    const result = await adapter.replace({ expectedRevision: current.revision, config: replacement });

    expect(result).toMatchObject({ kind: "loaded", config: replacement });
    expect(coordinator.writes).toBe(1);
    expect(coordinator.snapshot.loaded.config).toEqual({
      ...initialConfig,
      plugins: {
        ...initialConfig.plugins,
        "workspace-tasks": {
          ...initialConfig.plugins?.["workspace-tasks"],
          settings: { retainedSetting: "keep", globalTasks: replacement },
        },
      },
    });
    expect(authorizer.globalIntents).toEqual([{
      scope: "global",
      expectedRevision: current.revision,
      config: replacement,
    }]);
  });

  it("rechecks the authorizer inside the coordinator after asynchronous reconciliation", async () => {
    const coordinator = new ControlledCoordinator({
      plugins: { "workspace-tasks": { settings: { globalTasks: emptyCatalog() } } },
    });
    const authorizer = new TestAuthorizer();
    const blocked = new Error("move recovery pending");
    authorizer.onReconciled = () => {
      authorizer.globalAssertionError = blocked;
    };
    const adapter = createAdapter(coordinator, authorizer);
    const current = await adapter.read();
    if (current.kind !== "loaded") throw new Error("expected loaded catalog");

    await expect(adapter.replace({ expectedRevision: current.revision, config: catalogWithTask("build") })).rejects.toBe(blocked);
    expect(authorizer.reconciledSubjects).toEqual([{ scope: "global" }]);
    expect(authorizer.globalIntents).toHaveLength(1);
    expect(coordinator.writes).toBe(0);
  });

  it("does not let a move permit authorize a different catalog or revision", async () => {
    const coordinator = new ControlledCoordinator({
      plugins: { "workspace-tasks": { settings: { globalTasks: emptyCatalog() } } },
    });
    const authorizer = new TestAuthorizer();
    const permit = testMovePermit();
    const adapter = createAdapter(coordinator, authorizer);
    const current = await adapter.read();
    if (current.kind !== "loaded") throw new Error("expected loaded catalog");
    authorizer.expectedPermit = permit;
    authorizer.expectedIntent = {
      scope: "global",
      expectedRevision: current.revision,
      config: catalogWithTask("build"),
    };

    await expect(adapter.replace({ expectedRevision: current.revision, config: catalogWithTask("test") }, { permit }))
      .rejects.toThrow("permit did not authorize");
    await expect(adapter.replace({ expectedRevision: "other-revision", config: catalogWithTask("build") }, { permit }))
      .rejects.toBeInstanceOf(WorkspaceTasksRevisionConflictError);
    expect(coordinator.writes).toBe(0);
  });

  it("acknowledges a published write before a post-save verification failure", async () => {
    const coordinator = new ControlledCoordinator({
      plugins: { "workspace-tasks": { settings: { globalTasks: emptyCatalog() } } },
    });
    coordinator.mutationFailure = { phase: "after-saved", error: new Error("post-save reload failure") };
    const adapter = createAdapter(coordinator);
    const current = await adapter.read();
    if (current.kind !== "loaded") throw new Error("expected loaded catalog");
    const events: string[] = [];

    await expect(adapter.replace({ expectedRevision: current.revision, config: catalogWithTask("build") }, {
      onWriteAcknowledged: () => {
        events.push("acknowledged");
      },
      onWriteOutcomeUnknown: () => {
        events.push("unknown");
      },
    })).rejects.toBeInstanceOf(WorkspaceTasksUnavailableError);

    expect(events).toEqual(["acknowledged"]);
  });

  it("marks a failed final rename as an unknown write outcome", async () => {
    const coordinator = new ControlledCoordinator({
      plugins: { "workspace-tasks": { settings: { globalTasks: emptyCatalog() } } },
    });
    coordinator.mutationFailure = { phase: "after-publication", error: new Error("rename failed") };
    const adapter = createAdapter(coordinator);
    const current = await adapter.read();
    if (current.kind !== "loaded") throw new Error("expected loaded catalog");
    const events: string[] = [];

    await expect(adapter.replace({ expectedRevision: current.revision, config: catalogWithTask("build") }, {
      onWriteAcknowledged: () => {
        events.push("acknowledged");
      },
      onWriteOutcomeUnknown: () => {
        events.push("unknown");
      },
    })).rejects.toBeInstanceOf(WorkspaceTasksUnknownOutcomeError);

    expect(events).toEqual(["unknown"]);
  });

  it.each([
    ["busy", new PiWebUiConfigMutationBusyError()],
    ["parse", new Error("config parse failure")],
    ["pre-publication write", new Error("write failure")],
  ])("maps a %s persistence failure to a safe unavailable error", async (_kind, error) => {
    const coordinator = new ControlledCoordinator({
      plugins: { "workspace-tasks": { settings: { globalTasks: emptyCatalog() } } },
    });
    coordinator.mutationFailure = { phase: "before-publication", error };
    const adapter = createAdapter(coordinator);
    const current = await adapter.read();
    if (current.kind !== "loaded") throw new Error("expected loaded catalog");

    await expect(adapter.replace({ expectedRevision: current.revision, config: catalogWithTask("build") }))
      .rejects.toBeInstanceOf(WorkspaceTasksUnavailableError);
  });
});

interface MutationFailure {
  phase: "before-publication" | "after-publication" | "after-saved";
  error: Error;
}

class ControlledCoordinator implements PiWebUiConfigMutationCoordinator {
  writes = 0;
  readFailure: Error | undefined;
  mutationFailure: MutationFailure | undefined;
  snapshot: PiWebUiConfigMutationSnapshot;

  constructor(config: PiWebUiConfigValues) {
    this.snapshot = snapshotFor(config);
  }

  setConfig(config: PiWebUiConfigValues): void {
    this.snapshot = snapshotFor(config);
  }

  read(): Promise<PiWebUiConfigMutationSnapshot> {
    if (this.readFailure !== undefined) return Promise.reject(this.readFailure);
    return Promise.resolve(this.snapshot);
  }

  mutate(
    mutate: (current: PiWebUiConfigMutationSnapshot) => PiWebUiConfigValues,
    options: PiWebUiConfigMutationOptions = {},
  ): Promise<PiWebUiConfigMutationSnapshot> {
    try {
      const before = this.snapshot;
      const next = mutate(before);
      if (options.shouldSave?.(before, next) === false) return Promise.resolve(before);

      this.writes += 1;
      if (this.mutationFailure?.phase === "before-publication") throw this.mutationFailure.error;
      options.onPublicationAttempt?.();
      if (this.mutationFailure?.phase === "after-publication") throw this.mutationFailure.error;
      this.snapshot = snapshotFor(next);
      options.onSaved?.();
      if (this.mutationFailure?.phase === "after-saved") throw this.mutationFailure.error;
      return Promise.resolve(this.snapshot);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

class TestAuthorizer implements WorkspaceTasksMutationAuthorizer {
  reconciledSubjects: WorkspaceTasksMutationSubject[] = [];
  globalIntents: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>[] = [];
  onReconciled: (() => void) | undefined;
  globalAssertionError: Error | undefined;
  expectedPermit: WorkspaceTasksMovePermit | undefined;
  expectedIntent: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }> | undefined;

  reconcileGlobalMoveClaim(subject: WorkspaceTasksMutationSubject, permit?: WorkspaceTasksMovePermit): Promise<void> {
    this.reconciledSubjects.push(subject);
    void permit;
    this.onReconciled?.();
    return Promise.resolve();
  }

  assertGlobalMutationAllowed(
    intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>,
    permit?: WorkspaceTasksMovePermit,
  ): void {
    if (intent !== undefined) this.globalIntents.push(intent);
    if (this.globalAssertionError !== undefined) throw this.globalAssertionError;
    if (this.expectedIntent !== undefined && (permit !== this.expectedPermit || !sameIntent(intent, this.expectedIntent))) {
      throw new Error("permit did not authorize this exact global write");
    }
  }

  assertWorkspaceMutationAllowed(
    address: WorkspaceCatalogAddress,
    intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }>,
    permit?: WorkspaceTasksMovePermit,
  ): void {
    void address;
    void intent;
    void permit;
  }
}

function createAdapter(coordinator: PiWebUiConfigMutationCoordinator, authorizer = new TestAuthorizer()) {
  return createWorkspaceTasksGlobalCatalogAdapter({ coordinator, authorizer });
}

function snapshotFor(config: PiWebUiConfigValues): PiWebUiConfigMutationSnapshot {
  return {
    loaded: {
      path: "/temporary/config.json",
      exists: true,
      config,
    },
    speechInputRevision: "speech-revision",
  };
}

function emptyCatalog(): WorkspaceTasksConfig {
  return { version: 1, tasks: [] };
}

function catalogWithTask(id: string): WorkspaceTasksConfig {
  return {
    version: 1,
    tasks: [{ id, title: `${id} task`, command: `npm run ${id}`, confirm: false }],
  };
}

function oversizedCatalog(): WorkspaceTasksConfig {
  return {
    version: 1,
    tasks: [{ id: "oversized", title: "Oversized", command: "x".repeat(WORKSPACE_TASKS_CATALOG_MAX_BYTES), confirm: false }],
  };
}

/** The registry is the only production issuer; this only models its opaque output. */
function testMovePermit(): WorkspaceTasksMovePermit {
  const candidate: unknown = {};
  if (!isTestMovePermit(candidate)) throw new Error("test permit could not be created");
  return candidate;
}

function isTestMovePermit(value: unknown): value is WorkspaceTasksMovePermit {
  return typeof value === "object" && value !== null;
}

function sameIntent(
  left: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }> | undefined,
  right: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>,
): boolean {
  return left?.expectedRevision === right.expectedRevision
    && JSON.stringify(left.config) === JSON.stringify(right.config);
}
