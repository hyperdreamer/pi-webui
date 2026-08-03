import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { piWebUiDataDir } from "../../config.js";
import {
  MODEL_TIERS,
  type LegacyStarterModelPolicyPreference,
  type ModelTier,
  type StarterModelPolicyPreference,
} from "../../shared/apiTypes.js";

const STARTER_MODEL_POLICY_PREFERENCE_VERSION = 2;
const STARTER_MODEL_POLICY_PREFERENCE_FILE_MODE = 0o600;

type StoredWorkspaceEntry =
  | { kind: "full"; policy: StarterModelPolicyPreference }
  | { kind: "legacy-v1"; preference: LegacyStarterModelPolicyPreference };

interface StarterModelPolicyPreferenceFile {
  version: typeof STARTER_MODEL_POLICY_PREFERENCE_VERSION;
  workspaces: Record<string, StoredWorkspaceEntry>;
}

interface ParsedPreferenceFile {
  workspaces: Record<string, StoredWorkspaceEntry>;
}

export type StarterPreferenceInspection =
  | { kind: "absent" }
  | { kind: "legacy-v1"; preference: LegacyStarterModelPolicyPreference }
  | { kind: "full"; preference: StarterModelPolicyPreference }
  | { kind: "invalid"; reason: string };

export type StarterPreferenceWrite =
  | { kind: "legacy-v1"; preference: LegacyStarterModelPolicyPreference }
  | { kind: "full"; preference: StarterModelPolicyPreference };

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

  async inspect(cwd: string): Promise<StarterPreferenceInspection> {
    try {
      requireNormalizedAbsoluteCwd(cwd);
      const data = parsePreferenceFile(await this.persistence.load());
      const entry = data.workspaces[cwd];
      if (entry === undefined) return { kind: "absent" };
      return entry.kind === "full"
        ? { kind: "full", preference: cloneFullPreference(entry.policy) }
        : { kind: "legacy-v1", preference: cloneLegacyPreference(entry.preference) };
    } catch (error: unknown) {
      return { kind: "invalid", reason: errorMessage(error) };
    }
  }

  async replace(cwd: string, write: StarterPreferenceWrite): Promise<void> {
    requireNormalizedAbsoluteCwd(cwd);
    const entry = parsePreferenceWrite(write);
    await this.exclusive(async () => {
      const data = parsePreferenceFile(await this.persistence.load());
      data.workspaces[cwd] = cloneStoredEntry(entry);
      await this.persistence.save(serializePreferenceFile(data));
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

function parsePreferenceFile(value: unknown): ParsedPreferenceFile {
  if (value === undefined) return { workspaces: emptyWorkspaceRecord() };

  const record = requireRecord(value, "starter model policy preference file must be an object");
  requireExactFields(record, ["version", "workspaces"], [], "starter model policy preference file");
  const persistedWorkspaces = requireRecord(
    record["workspaces"],
    "starter model policy preference workspaces must be an object",
  );
  if (record["version"] === 1) return parseVersionOneWorkspaces(persistedWorkspaces);
  if (record["version"] === STARTER_MODEL_POLICY_PREFERENCE_VERSION) {
    return parseVersionTwoWorkspaces(persistedWorkspaces);
  }
  throw new Error("unsupported starter model policy preference file version");
}

function parseVersionOneWorkspaces(
  persistedWorkspaces: Record<string, unknown>,
): ParsedPreferenceFile {
  const workspaces = emptyWorkspaceRecord();
  for (const [cwd, preference] of Object.entries(persistedWorkspaces)) {
    requireNormalizedAbsoluteCwd(cwd);
    workspaces[cwd] = {
      kind: "legacy-v1",
      preference: parseLegacyPreference(
        preference,
        `starter preference for ${JSON.stringify(cwd)}`,
      ),
    };
  }
  return { workspaces };
}

function parseVersionTwoWorkspaces(
  persistedWorkspaces: Record<string, unknown>,
): ParsedPreferenceFile {
  const workspaces = emptyWorkspaceRecord();
  for (const [cwd, entry] of Object.entries(persistedWorkspaces)) {
    requireNormalizedAbsoluteCwd(cwd);
    workspaces[cwd] = parseStoredEntry(
      entry,
      `starter preference entry for ${JSON.stringify(cwd)}`,
    );
  }
  return { workspaces };
}

function parseStoredEntry(value: unknown, field: string): StoredWorkspaceEntry {
  const record = requireRecord(value, `${field} must be an object`);
  const kind = record["kind"];
  if (kind === "legacy-v1") {
    requireExactFields(record, ["kind", "preference"], [], field);
    return {
      kind,
      preference: parseLegacyPreference(record["preference"], `${field} preference`),
    };
  }
  if (kind === "full") {
    requireExactFields(record, ["kind", "policy"], [], field);
    return {
      kind,
      policy: parseFullPreference(record["policy"], `${field} policy`),
    };
  }
  throw new Error(`${field} kind must be full or legacy-v1`);
}

function parsePreferenceWrite(value: unknown): StoredWorkspaceEntry {
  const field = "starter preference write";
  const record = requireRecord(value, `${field} must be an object`);
  const kind = record["kind"];
  if (kind === "legacy-v1") {
    requireExactFields(record, ["kind", "preference"], [], field);
    return {
      kind,
      preference: parseLegacyPreference(record["preference"], `${field} preference`),
    };
  }
  if (kind === "full") {
    requireExactFields(record, ["kind", "preference"], [], field);
    return {
      kind,
      policy: parseFullPreference(record["preference"], `${field} preference`),
    };
  }
  throw new Error(`${field} kind must be full or legacy-v1`);
}

function serializePreferenceFile(data: ParsedPreferenceFile): StarterModelPolicyPreferenceFile {
  const workspaces: Record<string, StoredWorkspaceEntry> = {};
  for (const [cwd, entry] of Object.entries(data.workspaces)) {
    workspaces[cwd] = cloneStoredEntry(entry);
  }
  return { version: STARTER_MODEL_POLICY_PREFERENCE_VERSION, workspaces };
}

function emptyWorkspaceRecord(): Record<string, StoredWorkspaceEntry> {
  const workspaces: Record<string, StoredWorkspaceEntry> = {};
  Object.setPrototypeOf(workspaces, null);
  return workspaces;
}

function parseLegacyPreference(
  value: unknown,
  field: string,
): LegacyStarterModelPolicyPreference {
  const record = requireRecord(value, `${field} must be an object`);
  requireExactFields(record, ["mode"], ["tier"], field);
  const mode = parseMode(record["mode"], `${field} mode`);
  const tier = record["tier"] === undefined
    ? undefined
    : requireCanonicalTier(record["tier"], `${field} tier`);
  if (mode === "tiered" && tier === undefined) {
    throw new Error(`${field} tier is required in Tiered mode`);
  }
  return tier === undefined ? { mode } : { mode, tier };
}

function parseFullPreference(value: unknown, field: string): StarterModelPolicyPreference {
  const record = requireRecord(value, `${field} must be an object`);
  requireExactFields(record, ["mode", "exact"], ["tier"], field);
  const mode = parseMode(record["mode"], `${field} mode`);
  const exact = parseExactSelection(record["exact"], `${field} exact`);
  const tier = record["tier"] === undefined
    ? undefined
    : requireCanonicalTier(record["tier"], `${field} tier`);
  if (mode === "tiered" && tier === undefined) {
    throw new Error(`${field} tier is required in Tiered mode`);
  }
  return tier === undefined ? { mode, exact } : { mode, exact, tier };
}

function parseExactSelection(
  value: unknown,
  field: string,
): StarterModelPolicyPreference["exact"] {
  const record = requireRecord(value, `${field} must be an object`);
  requireExactFields(record, ["model", "thinkingLevel"], [], field);
  const model = requireRecord(record["model"], `${field} model must be an object`);
  requireExactFields(model, ["provider", "id"], [], `${field} model`);
  return {
    model: {
      provider: requireNonBlankString(model["provider"], `${field} model provider`),
      id: requireNonBlankString(model["id"], `${field} model id`),
    },
    thinkingLevel: requireNonBlankString(
      record["thinkingLevel"],
      `${field} thinking level`,
    ),
  };
}

function parseMode(
  value: unknown,
  field: string,
): LegacyStarterModelPolicyPreference["mode"] {
  if (value !== "exact" && value !== "tiered") {
    throw new Error(`${field} must be exact or tiered`);
  }
  return value;
}

function cloneStoredEntry(entry: StoredWorkspaceEntry): StoredWorkspaceEntry {
  return entry.kind === "full"
    ? { kind: "full", policy: cloneFullPreference(entry.policy) }
    : { kind: "legacy-v1", preference: cloneLegacyPreference(entry.preference) };
}

function cloneLegacyPreference(
  preference: LegacyStarterModelPolicyPreference,
): LegacyStarterModelPolicyPreference {
  return preference.tier === undefined
    ? { mode: preference.mode }
    : { mode: preference.mode, tier: preference.tier };
}

function cloneFullPreference(
  preference: StarterModelPolicyPreference,
): StarterModelPolicyPreference {
  const exact = {
    model: {
      provider: preference.exact.model.provider,
      id: preference.exact.model.id,
    },
    thinkingLevel: preference.exact.thinkingLevel,
  };
  return preference.tier === undefined
    ? { mode: preference.mode, exact }
    : { mode: preference.mode, exact, tier: preference.tier };
}

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-blank string`);
  }
  return value;
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
  if (unknownField !== undefined) {
    throw new Error(`${field} has unknown field ${JSON.stringify(unknownField)}`);
  }
  const missingField = required.find((key) => !Object.hasOwn(record, key));
  if (missingField !== undefined) {
    throw new Error(`${field} is missing field ${JSON.stringify(missingField)}`);
  }
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
