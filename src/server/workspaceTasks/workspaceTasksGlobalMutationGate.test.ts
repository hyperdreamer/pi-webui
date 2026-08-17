import { describe, expect, it } from "vitest";
import type { PiWebUiConfigResponse, PiWebUiConfigValues } from "../../shared/apiTypes.js";
import type { PiWebUiConfigService } from "../configRoutes.js";
import type {
  WorkspaceTasksMutationAuthorizer,
  WorkspaceTasksMutationSubject,
} from "./workspaceTasksErrors.js";
import { WorkspaceTasksMoveRecoveryPendingError } from "./workspaceTasksMoveRegistry.js";
import { WorkspaceTasksGlobalMutationGate } from "./workspaceTasksGlobalMutationGate.js";

interface ControlledAuthorizer {
  authorizer: WorkspaceTasksMutationAuthorizer;
  claimError: Error | undefined;
  claimedBeforeMutation: boolean;
  reconciliationError: Error | undefined;
  readonly reconcileCalls: WorkspaceTasksMutationSubject[];
  readonly globalAssertionCalls: number;
}

function responseFor(config: PiWebUiConfigValues): PiWebUiConfigResponse {
  return {
    path: "/tmp/test-config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: {
      host: false,
      port: false,
      allowedHosts: false,
      spawnSessions: false,
      subsessions: false,
      agentCommand: false,
      agentDir: false,
      agentSessionDir: false,
    },
  };
}

function createControlledAuthorizer(): ControlledAuthorizer {
  const state: {
    claimError: Error | undefined;
    claimedBeforeMutation: boolean;
    reconciliationError: Error | undefined;
    reconcileCalls: WorkspaceTasksMutationSubject[];
    globalAssertionCalls: number;
  } = {
    claimError: undefined,
    claimedBeforeMutation: false,
    reconciliationError: undefined,
    reconcileCalls: [],
    globalAssertionCalls: 0,
  };
  const authorizer: WorkspaceTasksMutationAuthorizer = {
    reconcileGlobalMoveClaim: (subject) => {
      state.reconcileCalls.push(subject);
      return state.reconciliationError === undefined
        ? Promise.resolve()
        : Promise.reject(state.reconciliationError);
    },
    assertGlobalMutationAllowed: () => {
      state.globalAssertionCalls += 1;
      if (state.claimedBeforeMutation && state.claimError !== undefined) throw state.claimError;
    },
    assertWorkspaceMutationAllowed: () => undefined,
  };
  return {
    authorizer,
    get claimError() { return state.claimError; },
    set claimError(value) { state.claimError = value; },
    get claimedBeforeMutation() { return state.claimedBeforeMutation; },
    set claimedBeforeMutation(value) { state.claimedBeforeMutation = value; },
    get reconciliationError() { return state.reconciliationError; },
    set reconciliationError(value) { state.reconciliationError = value; },
    get reconcileCalls() { return state.reconcileCalls; },
    get globalAssertionCalls() { return state.globalAssertionCalls; },
  };
}

function memoryConfigService(
  saved: PiWebUiConfigValues,
  beforeUpdate?: () => void,
): PiWebUiConfigService {
  return {
    read: () => responseFor(saved),
    write: (config) => Promise.resolve(responseFor(config)),
    update: (mutate) => {
      beforeUpdate?.();
      const next = mutate(saved);
      Object.assign(saved, next);
      return Promise.resolve(responseFor(saved));
    },
  };
}

function changedGlobalTasks(): PiWebUiConfigValues {
  return {
    plugins: {
      "workspace-tasks": {
        settings: {
          globalTasks: {
            version: 1,
            tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
          },
        },
      },
    },
  };
}

describe("WorkspaceTasksGlobalMutationGate", () => {
  it("reconciles before update and makes the final assertion only for a changed global projection", async () => {
    const control = createControlledAuthorizer();
    const saved: PiWebUiConfigValues = {
      port: 8808,
      plugins: { "workspace-tasks": { settings: { globalTasks: { version: 1, tasks: [] } } } },
    };
    const gated = new WorkspaceTasksGlobalMutationGate(control.authorizer).decorate(memoryConfigService(saved));

    await gated.update((current) => ({ ...current, port: 9000 }));
    expect(control.reconcileCalls).toEqual([{ scope: "global" }]);
    expect(control.globalAssertionCalls).toBe(0);

    await gated.update((current) => ({ ...current, ...changedGlobalTasks() }));
    expect(control.globalAssertionCalls).toBe(1);
  });

  it("detects an in-place global task projection mutation", async () => {
    const control = createControlledAuthorizer();
    const saved: PiWebUiConfigValues = {
      plugins: { "workspace-tasks": { settings: { globalTasks: { version: 1, tasks: [] } } } },
    };
    const gated = new WorkspaceTasksGlobalMutationGate(control.authorizer).decorate(memoryConfigService(saved));

    await gated.update((current) => {
      const workspaceTasks = current.plugins?.["workspace-tasks"];
      if (workspaceTasks?.settings === undefined) throw new Error("Expected Workspace Tasks settings");
      workspaceTasks.settings["globalTasks"] = changedGlobalTasks().plugins?.["workspace-tasks"]?.settings?.["globalTasks"];
      return current;
    });

    expect(control.globalAssertionCalls).toBe(1);
  });

  it("asserts inside the underlying mutation callback when a claim appears after reconciliation", async () => {
    const control = createControlledAuthorizer();
    control.claimError = new WorkspaceTasksMoveRecoveryPendingError();
    const gated = new WorkspaceTasksGlobalMutationGate(control.authorizer).decorate(memoryConfigService({}, () => {
      control.claimedBeforeMutation = true;
    }));

    await expect(gated.update((current) => ({ ...current, ...changedGlobalTasks() }))).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
  });

  it("allows an unrelated update after recovery reconciliation while retaining recovery-pending for a changed task projection", async () => {
    const control = createControlledAuthorizer();
    control.reconciliationError = new WorkspaceTasksMoveRecoveryPendingError();
    const saved: PiWebUiConfigValues = { port: 8808 };
    const gated = new WorkspaceTasksGlobalMutationGate(control.authorizer).decorate(memoryConfigService(saved));

    await expect(gated.update((current) => ({ ...current, port: 9000 }))).resolves.toMatchObject({ config: { port: 9000 } });
    await expect(gated.update((current) => ({ ...current, ...changedGlobalTasks() }))).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
  });

  it("blocks both write entry points during an active claim without exposing config state", async () => {
    const control = createControlledAuthorizer();
    control.claimError = new WorkspaceTasksMoveRecoveryPendingError();
    control.claimedBeforeMutation = true;
    const gated = new WorkspaceTasksGlobalMutationGate(control.authorizer).decorate(memoryConfigService({}));

    await expect(gated.write(changedGlobalTasks())).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
    await expect(gated.update(() => changedGlobalTasks())).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
  });
});
