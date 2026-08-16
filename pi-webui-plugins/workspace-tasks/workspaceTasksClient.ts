import {
  TASKS_CONFIG_PATH,
  parseTasksConfigText,
  serializeWorkspaceTasksConfig,
  type WorkspaceTasksConfig,
} from "./config.js";

export const tasksConfigMissingMessage = "No workspace tasks configured here.";
export const tasksConfigMissingHint = `${TASKS_CONFIG_PATH} is optional. Create it in this workspace if you want custom tasks.`;
export const tasksConfigInvalidMessage = "Workspace tasks configuration is invalid.";
export const tasksConfigInvalidHint = `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`;
export const tasksConfigUnavailableMessage = "Could not load workspace tasks.";
export const tasksConfigRefreshHint = `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`;

export interface WorkspaceTasksFileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface WorkspaceTasksFileReader {
  readFile(path: string): Promise<WorkspaceTasksFileContent>;
}

export interface WorkspaceTasksFiles extends WorkspaceTasksFileReader {
  writeFile(path: string, content: string | Uint8Array): Promise<unknown>;
}

export type WorkspaceTasksSnapshot =
  | { kind: "missing" }
  | { kind: "text"; content: string };

export type WorkspaceTasksConfigLoadResult =
  | { kind: "loaded"; config: WorkspaceTasksConfig; path: string; snapshot: Extract<WorkspaceTasksSnapshot, { kind: "text" }> }
  | { kind: "missing"; message: string; hint: string; snapshot: Extract<WorkspaceTasksSnapshot, { kind: "missing" }> }
  | { kind: "invalid"; message: string; hint: string; detail: string; snapshot: Extract<WorkspaceTasksSnapshot, { kind: "text" }> }
  | { kind: "unavailable"; message: string; hint: string; detail?: string };

export type WorkspaceTasksConfigState = { kind: "loading" } | WorkspaceTasksConfigLoadResult;

export interface WorkspaceTasksCacheEntry {
  state: WorkspaceTasksConfigState;
  refreshRequired: boolean;
}

export type GuardedWorkspaceTasksWriteResult =
  | { kind: "written"; state: Extract<WorkspaceTasksConfigLoadResult, { kind: "loaded" }> }
  | { kind: "conflict"; detail: string }
  | { kind: "preflight-unavailable"; detail: string }
  | { kind: "write-failed"; detail: string }
  | { kind: "written-but-unreloaded"; detail: string };

interface WorkspaceRuntime {
  requestGeneration: number;
  refreshRequired: boolean;
  tail: Promise<void>;
}

interface OperationContext {
  key: string;
  runtime: WorkspaceRuntime;
  generation: number;
  epoch: number;
}

const configCache = new Map<string, WorkspaceTasksCacheEntry>();
const workspaceRuntimes = new Map<string, WorkspaceRuntime>();
const subscribers = new Set<(workspaceKey: string) => void>();
let stateEpoch = 0;

export function loadWorkspaceTasksConfig(
  files: Pick<WorkspaceTasksFiles, "readFile">,
): Promise<WorkspaceTasksConfigLoadResult> {
  return readCurrentWorkspaceTasksConfig(files);
}

export function getWorkspaceTasksCacheEntry(workspaceKey: string): WorkspaceTasksCacheEntry | undefined {
  return configCache.get(workspaceKey);
}

export function ensureWorkspaceTasksConfig(files: WorkspaceTasksFiles, workspaceKey: string): WorkspaceTasksCacheEntry {
  const cached = configCache.get(workspaceKey);
  if (cached !== undefined) return cached;

  const runtime = getWorkspaceRuntime(workspaceKey);
  const loadingEntry: WorkspaceTasksCacheEntry = {
    state: { kind: "loading" },
    refreshRequired: runtime.refreshRequired,
  };
  configCache.set(workspaceKey, loadingEntry);

  void enqueueWorkspaceOperation(workspaceKey, async (operation) => {
    const state = await loadWorkspaceTasksConfigSafely(files);
    if (state.kind === "unavailable") operation.runtime.refreshRequired = true;
    publishState(operation, state, operation.runtime.refreshRequired);
  }).catch(() => undefined);

  return loadingEntry;
}

export function refreshWorkspaceTasksConfig(files: WorkspaceTasksFiles, workspaceKey: string): Promise<WorkspaceTasksConfigLoadResult> {
  return enqueueWorkspaceOperation(
    workspaceKey,
    async (operation) => {
      const state = await loadWorkspaceTasksConfigSafely(files);
      operation.runtime.refreshRequired = state.kind === "unavailable";
      publishState(operation, state, operation.runtime.refreshRequired);
      return state;
    },
    (operation) => {
      if (!isCurrentOperation(operation)) return;
      configCache.set(workspaceKey, {
        state: { kind: "loading" },
        refreshRequired: operation.runtime.refreshRequired,
      });
    },
  );
}

export function guardedWriteWorkspaceTasksConfig(
  files: WorkspaceTasksFiles,
  workspaceKey: string,
  sourceSnapshot: WorkspaceTasksSnapshot,
  nextConfig: WorkspaceTasksConfig,
): Promise<GuardedWorkspaceTasksWriteResult> {
  return enqueueWorkspaceOperation(workspaceKey, async (operation) => {
    if (operation.runtime.refreshRequired) {
      return blockMutation(operation, "A successful Refresh is required before another workspace task mutation.");
    }

    const preflight = await loadWorkspaceTasksConfigSafely(files);
    if (preflight.kind === "unavailable") {
      return blockMutation(operation, unavailableDetail(preflight));
    }
    const currentSnapshot = preflight.snapshot;
    if (!snapshotsEqual(sourceSnapshot, currentSnapshot)) {
      return blockMutation(operation, `The ${TASKS_CONFIG_PATH} file changed outside this panel. Refresh before trying again.`, "conflict");
    }

    const payload = serializeWorkspaceTasksConfig(nextConfig);
    try {
      await files.writeFile(TASKS_CONFIG_PATH, payload);
    } catch (error) {
      return blockMutation(operation, `Unable to write ${TASKS_CONFIG_PATH}: ${formatUnknownError(error)}`, "write-failed");
    }

    const postWrite = await loadWorkspaceTasksConfigSafely(files);
    if (postWrite.kind === "loaded" && postWrite.snapshot.content === payload) {
      operation.runtime.refreshRequired = false;
      publishState(operation, postWrite, false);
      return { kind: "written", state: postWrite };
    }

    const detail = postWriteReloadDetail(postWrite);
    blockMutation(operation, detail, undefined, postWrite);
    return { kind: "written-but-unreloaded", detail };
  });
}

export function subscribeWorkspaceTasksConfig(listener: (workspaceKey: string) => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function clearWorkspaceTasksStateForTesting(): void {
  stateEpoch += 1;
  configCache.clear();
  workspaceRuntimes.clear();
}

async function readCurrentWorkspaceTasksConfig(
  files: Pick<WorkspaceTasksFiles, "readFile">,
): Promise<WorkspaceTasksConfigLoadResult> {
  let file: WorkspaceTasksFileContent;
  try {
    file = await files.readFile(TASKS_CONFIG_PATH);
  } catch (error) {
    if (isMissingWorkspaceFileError(error)) return missing();
    return unavailable(`Unable to read ${TASKS_CONFIG_PATH}: ${formatUnknownError(error)}`);
  }

  if (file.binary) return unavailable(`${TASKS_CONFIG_PATH} must be a text file`);
  if (file.truncated) return unavailable(`${TASKS_CONFIG_PATH} is too large and was truncated`);

  const result = parseTasksConfigText(file.content);
  if (!result.ok) {
    return {
      kind: "invalid",
      message: tasksConfigInvalidMessage,
      hint: tasksConfigInvalidHint,
      detail: result.error,
      snapshot: { kind: "text", content: file.content },
    };
  }
  return {
    kind: "loaded",
    config: result.config,
    path: TASKS_CONFIG_PATH,
    snapshot: { kind: "text", content: file.content },
  };
}

async function loadWorkspaceTasksConfigSafely(
  files: Pick<WorkspaceTasksFiles, "readFile">,
): Promise<WorkspaceTasksConfigLoadResult> {
  try {
    return await readCurrentWorkspaceTasksConfig(files);
  } catch (error) {
    return unavailable(`Unable to read ${TASKS_CONFIG_PATH}: ${formatUnknownError(error)}`);
  }
}

function enqueueWorkspaceOperation<T>(
  workspaceKey: string,
  operation: (context: OperationContext) => Promise<T>,
  onRequest?: (context: OperationContext) => void,
): Promise<T> {
  const runtime = getWorkspaceRuntime(workspaceKey);
  const context: OperationContext = {
    key: workspaceKey,
    runtime,
    generation: runtime.requestGeneration + 1,
    epoch: stateEpoch,
  };
  runtime.requestGeneration = context.generation;
  onRequest?.(context);

  const result = runtime.tail.then(() => operation(context));
  runtime.tail = result.then(() => undefined, () => undefined);
  return result;
}

function getWorkspaceRuntime(workspaceKey: string): WorkspaceRuntime {
  const existing = workspaceRuntimes.get(workspaceKey);
  if (existing !== undefined) return existing;
  const runtime: WorkspaceRuntime = {
    requestGeneration: 0,
    refreshRequired: false,
    tail: Promise.resolve(),
  };
  workspaceRuntimes.set(workspaceKey, runtime);
  return runtime;
}

function publishState(
  operation: OperationContext,
  state: WorkspaceTasksConfigLoadResult,
  refreshRequired: boolean,
): void {
  if (!isCurrentOperation(operation)) return;
  configCache.set(operation.key, { state, refreshRequired });
  notifySubscribers(operation.key);
}

function blockMutation(
  operation: OperationContext,
  detail: string,
  kind: "conflict" | "write-failed" | "preflight-unavailable" = "preflight-unavailable",
  postWriteState?: WorkspaceTasksConfigLoadResult,
): GuardedWorkspaceTasksWriteResult {
  operation.runtime.refreshRequired = true;
  if (isCurrentOperation(operation)) {
    const existing = configCache.get(operation.key);
    if (postWriteState !== undefined) {
      configCache.set(operation.key, { state: postWriteState, refreshRequired: true });
    } else if (existing !== undefined) {
      configCache.set(operation.key, { ...existing, refreshRequired: true });
    }
    notifySubscribers(operation.key);
  }
  return { kind, detail };
}

function isCurrentOperation(operation: OperationContext): boolean {
  return operation.epoch === stateEpoch
    && workspaceRuntimes.get(operation.key) === operation.runtime
    && operation.runtime.requestGeneration === operation.generation;
}

function notifySubscribers(workspaceKey: string): void {
  for (const listener of subscribers) listener(workspaceKey);
}

function snapshotsEqual(left: WorkspaceTasksSnapshot, right: WorkspaceTasksSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" || right.kind === "missing") return true;
  return left.content === right.content;
}

function postWriteReloadDetail(result: WorkspaceTasksConfigLoadResult): string {
  if (result.kind === "loaded") return `Unable to reload ${TASKS_CONFIG_PATH}: the post-write snapshot did not match the canonical payload.`;
  if (result.kind === "missing") return `Unable to reload ${TASKS_CONFIG_PATH}: the file is missing after the write.`;
  if (result.kind === "invalid") return `Unable to reload ${TASKS_CONFIG_PATH}: ${result.detail}`;
  return `Unable to reload ${TASKS_CONFIG_PATH}: ${unavailableDetail(result)}`;
}

function missing(): Extract<WorkspaceTasksConfigLoadResult, { kind: "missing" }> {
  return {
    kind: "missing",
    message: tasksConfigMissingMessage,
    hint: tasksConfigMissingHint,
    snapshot: { kind: "missing" },
  };
}

function unavailable(detail: string): Extract<WorkspaceTasksConfigLoadResult, { kind: "unavailable" }> {
  return {
    kind: "unavailable",
    message: tasksConfigUnavailableMessage,
    hint: tasksConfigRefreshHint,
    detail,
  };
}

function unavailableDetail(result: Extract<WorkspaceTasksConfigLoadResult, { kind: "unavailable" }>): string {
  return result.detail ?? tasksConfigUnavailableMessage;
}

function isMissingWorkspaceFileError(error: unknown): boolean {
  const message = errorField(error, "message");
  const code = errorField(error, "code");
  return message === "Path does not exist"
    || code?.toLowerCase() === "enoent"
    || message?.toLowerCase() === "enoent"
    || message?.toLowerCase().includes("no such file or directory") === true
    || code?.toLowerCase().includes("no such file or directory") === true;
}

function errorField(error: unknown, field: "message" | "code"): string | undefined {
  if (typeof error === "object" && error !== null && hasStringField(error, field)) return error[field];
  return error instanceof Error && field === "message" ? error.message : undefined;
}

function hasStringField(value: object, field: string): value is Record<string, string> {
  return field in value && typeof Reflect.get(value, field) === "string";
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
