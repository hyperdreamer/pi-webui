export const TASKS_CONFIG_PATH = ".pi-webui/tasks.json";
export const WORKSPACE_TASKS_CONFIG_VERSION = 1;
export const WORKSPACE_TASKS_CATALOG_MAX_BYTES = 512 * 1024;

const workspaceTaskIdPattern = /^[a-z][a-z0-9.-]*$/u;

export type WorkspaceTaskScope = "global" | "workspace";

export interface WorkspaceTaskRef {
  scope: WorkspaceTaskScope;
  id: string;
}

export interface WorkspaceTask {
  id: string;
  title: string;
  command: string;
  description?: string;
  group?: string;
  confirm: boolean;
}

export interface WorkspaceTasksConfig {
  version: typeof WORKSPACE_TASKS_CONFIG_VERSION;
  tasks: WorkspaceTask[];
}

export type ParseWorkspaceTasksConfigResult =
  | { ok: true; config: WorkspaceTasksConfig }
  | { ok: false; error: string };

export function parseWorkspaceTasksConfig(value: unknown): ParseWorkspaceTasksConfigResult {
  if (!isRecord(value)) return invalid("Config must be an object");
  if (value["version"] !== WORKSPACE_TASKS_CONFIG_VERSION) return invalid("Config version must be 1");

  const tasks = value["tasks"];
  if (!Array.isArray(tasks)) return invalid("Config tasks must be an array");

  const ids = new Set<string>();
  const parsedTasks: WorkspaceTask[] = [];
  for (const [index, task] of tasks.entries()) {
    const parsedTask = parseTask(task, index);
    if (!parsedTask.ok) return parsedTask;
    if (ids.has(parsedTask.task.id)) return invalid(`Duplicate task id: ${parsedTask.task.id}`);
    ids.add(parsedTask.task.id);
    parsedTasks.push(parsedTask.task);
  }

  return {
    ok: true,
    config: {
      version: WORKSPACE_TASKS_CONFIG_VERSION,
      tasks: parsedTasks,
    },
  };
}

export function parseWorkspaceTasksConfigText(text: string): ParseWorkspaceTasksConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalid(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseWorkspaceTasksConfig(parsed);
}

export function serializeWorkspaceTasksConfig(config: WorkspaceTasksConfig): string {
  const canonicalConfig = {
    version: config.version,
    tasks: config.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      command: task.command,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.group === undefined ? {} : { group: task.group }),
      confirm: task.confirm,
    })),
  };
  return `${JSON.stringify(canonicalConfig, null, 2)}\n`;
}

export function workspaceTasksCanonicalByteLength(config: WorkspaceTasksConfig): number {
  return new TextEncoder().encode(serializeWorkspaceTasksConfig(config)).byteLength;
}

export function assertWorkspaceTasksCatalogSize(config: WorkspaceTasksConfig): void {
  const byteLength = workspaceTasksCanonicalByteLength(config);
  if (byteLength > WORKSPACE_TASKS_CATALOG_MAX_BYTES) {
    throw new RangeError(
      `Workspace tasks catalog is ${String(byteLength)} bytes; maximum is ${String(WORKSPACE_TASKS_CATALOG_MAX_BYTES)} bytes`,
    );
  }
}

export function isWorkspaceTaskId(value: string): boolean {
  return workspaceTaskIdPattern.test(value);
}

export function workspaceTaskRefKey(ref: WorkspaceTaskRef): string {
  assertWorkspaceTaskScope(ref.scope);
  assertWorkspaceTaskId(ref.id);
  return `${ref.scope}:${ref.id}`;
}

export function parseWorkspaceTaskRefKey(key: string): WorkspaceTaskRef {
  const parts = key.split(":");
  if (parts.length !== 2) throw new Error(`Invalid workspace task reference key: ${key}`);

  const [scope, id] = parts;
  assertWorkspaceTaskScope(scope);
  assertWorkspaceTaskId(id);
  return { scope, id };
}

export function workspaceTaskGroupKey(scope: WorkspaceTaskScope, group: string): string {
  assertWorkspaceTaskScope(scope);
  if (typeof group !== "string") throw new TypeError("Workspace task group must be a string");
  return JSON.stringify([scope, group]);
}

export function appendWorkspaceTask(config: WorkspaceTasksConfig, task: WorkspaceTask): WorkspaceTasksConfig {
  return { version: config.version, tasks: [...config.tasks, task] };
}

export function replaceWorkspaceTaskAt(
  config: WorkspaceTasksConfig,
  index: number,
  task: WorkspaceTask,
): WorkspaceTasksConfig {
  assertWorkspaceTaskIndex(config, index);
  return {
    version: config.version,
    tasks: [...config.tasks.slice(0, index), task, ...config.tasks.slice(index + 1)],
  };
}

export function removeWorkspaceTaskAt(config: WorkspaceTasksConfig, index: number): WorkspaceTasksConfig {
  assertWorkspaceTaskIndex(config, index);
  return {
    version: config.version,
    tasks: [...config.tasks.slice(0, index), ...config.tasks.slice(index + 1)],
  };
}

export function deriveWorkspaceTaskMove(input: {
  source: { ref: WorkspaceTaskRef; config: WorkspaceTasksConfig };
  destination: { scope: WorkspaceTaskScope; config: WorkspaceTasksConfig; task: WorkspaceTask };
}): { sourceAfter: WorkspaceTasksConfig; destinationAfter: WorkspaceTasksConfig } {
  assertWorkspaceTaskScope(input.source.ref.scope);
  assertWorkspaceTaskId(input.source.ref.id);
  assertWorkspaceTaskScope(input.destination.scope);
  assertWorkspaceTaskId(input.destination.task.id);

  if (input.source.ref.scope === input.destination.scope) {
    throw new Error("Workspace task moves must cross scopes");
  }

  const sourceIndex = input.source.config.tasks.findIndex((task) => task.id === input.source.ref.id);
  if (sourceIndex === -1) {
    throw new Error(`Source workspace task not found: ${input.source.ref.id}`);
  }

  if (input.destination.config.tasks.some((task) => task.id === input.destination.task.id)) {
    throw new Error(`Destination workspace task already exists: ${input.destination.task.id}`);
  }

  const sourceAfter = removeWorkspaceTaskAt(input.source.config, sourceIndex);
  const destinationAfter = appendWorkspaceTask(input.destination.config, input.destination.task);
  assertWorkspaceTasksCatalogSize(sourceAfter);
  assertWorkspaceTasksCatalogSize(destinationAfter);
  return { sourceAfter, destinationAfter };
}

type ParseTaskResult =
  | { ok: true; task: WorkspaceTask }
  | { ok: false; error: string };

function parseTask(value: unknown, index: number): ParseTaskResult {
  const label = `Task ${String(index + 1)}`;
  if (!isRecord(value)) return invalid(`${label} must be an object`);

  const id = requireNonEmptyString(value, "id", label);
  if (!id.ok) return id;
  if (!isWorkspaceTaskId(id.value)) return invalid(`${label} id must match ${workspaceTaskIdPattern.source}`);

  const title = requireNonEmptyString(value, "title", label);
  if (!title.ok) return title;

  const command = requireNonEmptyString(value, "command", label);
  if (!command.ok) return command;

  const description = optionalNonEmptyString(value, "description", label);
  if (!description.ok) return description;

  const group = optionalNonEmptyString(value, "group", label);
  if (!group.ok) return group;

  const confirm = value["confirm"];
  if (confirm !== undefined && typeof confirm !== "boolean") {
    return invalid(`${label} confirm must be a boolean`);
  }

  return {
    ok: true,
    task: {
      id: id.value,
      title: title.value,
      command: command.value,
      ...(description.value === undefined ? {} : { description: description.value }),
      ...(group.value === undefined ? {} : { group: group.value }),
      confirm: confirm ?? false,
    },
  };
}

type StringFieldResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

type OptionalStringFieldResult =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

function requireNonEmptyString(record: Record<string, unknown>, key: string, label: string): StringFieldResult {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${label} ${key} must be a non-empty string`);
  }
  return { ok: true, value };
}

function optionalNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): OptionalStringFieldResult {
  const value = record[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${label} ${key} must be a non-empty string when provided`);
  }
  return { ok: true, value };
}

function assertWorkspaceTaskIndex(config: WorkspaceTasksConfig, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= config.tasks.length) {
    throw new RangeError(`Task index ${String(index)} is out of range`);
  }
}

function assertWorkspaceTaskScope(scope: unknown): asserts scope is WorkspaceTaskScope {
  if (!isWorkspaceTaskScope(scope)) {
    throw new Error(`Invalid workspace task scope: ${String(scope)}`);
  }
}

function assertWorkspaceTaskId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !isWorkspaceTaskId(id)) {
    throw new Error(`Invalid workspace task id: ${String(id)}`);
  }
}

function isWorkspaceTaskScope(value: unknown): value is WorkspaceTaskScope {
  return value === "global" || value === "workspace";
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
