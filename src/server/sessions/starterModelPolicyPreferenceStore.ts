import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { piWebUiDataDir } from "../../config.js";
import {
  MODEL_TIERS,
  type ModelTier,
  type LegacyStarterModelPolicyPreference,
} from "../../shared/apiTypes.js";

const STARTER_MODEL_POLICY_PREFERENCE_VERSION = 1;
const STARTER_MODEL_POLICY_PREFERENCE_FILE_MODE = 0o600;

interface StarterModelPolicyPreferenceFile {
  version: typeof STARTER_MODEL_POLICY_PREFERENCE_VERSION;
  workspaces: Record<string, LegacyStarterModelPolicyPreference>;
}

export type StarterModelPolicyPreferenceInspection =
  | { kind: "absent" }
  | { kind: "valid"; preference: LegacyStarterModelPolicyPreference }
  | { kind: "invalid"; reason: string };

export interface StarterModelPolicyPreferencePersistence {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

export class FileStarterModelPolicyPreferencePersistence
implements StarterModelPolicyPreferencePersistence {
  constructor(
    private readonly filePath = defaultStarterModelPolicyPreferenceFilePath(),
    private readonly renameFile: (
      source: string,
      destination: string,
    ) => Promise<void> = rename,
  ) {}

  async load(): Promise<unknown> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return value;
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async save(value: unknown): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: STARTER_MODEL_POLICY_PREFERENCE_FILE_MODE,
        flag: "wx",
      });
      await this.renameFile(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export class StarterModelPolicyPreferenceStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: StarterModelPolicyPreferencePersistence =
      new FileStarterModelPolicyPreferencePersistence(),
  ) {}

  async inspect(cwd: string): Promise<StarterModelPolicyPreferenceInspection> {
    try {
      requireNormalizedAbsoluteCwd(cwd);
      const data = parsePreferenceFile(await this.persistence.load());
      const preference = data.workspaces[cwd];
      return preference === undefined
        ? { kind: "absent" }
        : { kind: "valid", preference: clonePreference(preference) };
    } catch (error: unknown) {
      return { kind: "invalid", reason: errorMessage(error) };
    }
  }

  async replace(cwd: string, value: LegacyStarterModelPolicyPreference): Promise<void> {
    requireNormalizedAbsoluteCwd(cwd);
    const preference = parsePreference(value, "starter preference");
    await this.exclusive(async () => {
      const data = parsePreferenceFile(await this.persistence.load());
      data.workspaces[cwd] = clonePreference(preference);
      await this.persistence.save(data);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function defaultStarterModelPolicyPreferenceFilePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  return join(piWebUiDataDir(env, cwd), "starter-model-policy-preferences.json");
}

function parsePreferenceFile(value: unknown): StarterModelPolicyPreferenceFile {
  if (value === undefined) return emptyPreferenceFile();

  const record = requireRecord(value, "starter model policy preference file must be an object");
  requireExactFields(record, ["version", "workspaces"], [], "starter model policy preference file");
  if (record["version"] !== STARTER_MODEL_POLICY_PREFERENCE_VERSION) {
    throw new Error("unsupported starter model policy preference file version");
  }
  const persistedWorkspaces = requireRecord(
    record["workspaces"],
    "starter model policy preference workspaces must be an object",
  );
  const workspaces = emptyWorkspaceRecord();
  for (const [cwd, preference] of Object.entries(persistedWorkspaces)) {
    requireNormalizedAbsoluteCwd(cwd);
    workspaces[cwd] = parsePreference(preference, `starter preference for ${JSON.stringify(cwd)}`);
  }
  return { version: STARTER_MODEL_POLICY_PREFERENCE_VERSION, workspaces };
}

function emptyPreferenceFile(): StarterModelPolicyPreferenceFile {
  return {
    version: STARTER_MODEL_POLICY_PREFERENCE_VERSION,
    workspaces: emptyWorkspaceRecord(),
  };
}

function emptyWorkspaceRecord(): Record<string, LegacyStarterModelPolicyPreference> {
  const workspaces: Record<string, LegacyStarterModelPolicyPreference> = {};
  Object.setPrototypeOf(workspaces, null);
  return workspaces;
}

function parsePreference(value: unknown, field: string): LegacyStarterModelPolicyPreference {
  const record = requireRecord(value, `${field} must be an object`);
  requireExactFields(record, ["mode"], ["tier"], field);
  const mode = record["mode"];
  if (mode !== "exact" && mode !== "tiered") {
    throw new Error(`${field} mode must be exact or tiered`);
  }
  const tier = record["tier"] === undefined
    ? undefined
    : requireCanonicalTier(record["tier"], `${field} tier`);
  if (mode === "tiered" && tier === undefined) throw new Error(`${field} tier is required in Tiered mode`);
  return tier === undefined ? { mode } : { mode, tier };
}

function clonePreference(preference: LegacyStarterModelPolicyPreference): LegacyStarterModelPolicyPreference {
  return preference.tier === undefined
    ? { mode: preference.mode }
    : { mode: preference.mode, tier: preference.tier };
}

function requireCanonicalTier(value: unknown, field: string): ModelTier {
  for (const tier of MODEL_TIERS) {
    if (value === tier) return tier;
  }
  throw new Error(`${field} must be one of: ${MODEL_TIERS.join(", ")}`);
}

function requireNormalizedAbsoluteCwd(cwd: string): void {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error(`workspace path must be normalized and absolute: ${JSON.stringify(cwd)}`);
  }
}

function requireExactFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknownField = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownField !== undefined) throw new Error(`${field} has unknown field ${JSON.stringify(unknownField)}`);
  const missingField = required.find((key) => !Object.hasOwn(record, key));
  if (missingField !== undefined) throw new Error(`${field} is missing field ${JSON.stringify(missingField)}`);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
