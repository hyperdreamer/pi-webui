import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, type Stats } from "node:fs";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadPiWebUiConfig, piWebUiDataDir, piWebUiConfigPath, readRawSpeechInputSubtree, savePiWebUiConfig, type LoadOptions, type LoadedPiWebUiConfig } from "./config.js";
import type { PiWebUiConfigValues } from "./shared/apiTypes.js";

/**
 * Typed contention failure: the SQLite acquisition budget was exhausted. Config,
 * model-tier, and utility-model mutation routes map this to a safe 503.
 */
export class PiWebUiConfigMutationBusyError extends Error {
  readonly code = "PI_WEBUI_CONFIG_BUSY";

  constructor() {
    super("PI WEBUI config is busy. Try again.");
  }
}

export const PI_WEBUI_CONFIG_MUTATION_LOCK_TIMEOUT_MS = 10_000;
export const PI_WEBUI_CONFIG_MUTATION_RETRY_MS = 25;

export interface PiWebUiConfigMutationSnapshot {
  loaded: LoadedPiWebUiConfig;
  /** Opaque speech-input CAS revision; stable for unchanged speech content. */
  speechInputRevision: string;
}

export interface PiWebUiConfigMutationCoordinator {
  read(): Promise<PiWebUiConfigMutationSnapshot>;
  mutate(
    mutate: (current: PiWebUiConfigMutationSnapshot) => PiWebUiConfigValues,
    options?: { rotateSpeechInputRevision?: boolean },
  ): Promise<PiWebUiConfigMutationSnapshot>;
}

export interface PiWebUiConfigLockState {
  speechInputRevision: string;
  fileFingerprint: string;
}

export interface PiWebUiConfigLockDatabase {
  beginImmediate(): void;
  readState(): PiWebUiConfigLockState | undefined;
  writeState(state: PiWebUiConfigLockState): void;
  commit(): void;
  rollback(): void;
  close(): void;
}

export interface PiWebUiConfigFileIdentity {
  exists: boolean;
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface PiWebUiConfigMutationCoordinatorOptions {
  config?: LoadOptions;
  /** Injected data-directory path before canonicalization. */
  dataDir?: string;
  now?: () => number;
  scheduleRetry?: (callback: () => void, delayMs: number) => () => void;
  openDatabase?: (path: string) => PiWebUiConfigLockDatabase;
  readFileIdentity?: (path: string) => PiWebUiConfigFileIdentity;
  createRevision?: () => string;
}

const CONFIG_MUTATIONS_CHILD = "config-mutations";
const STATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS configMutationState (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  speechInputRevision TEXT NOT NULL,
  fileFingerprint TEXT NOT NULL
)`;

export function piWebUiConfigMutationDatabasePath(configPath: string, dataDir: string): string {
  const digest = createHash("sha256").update(configPath).digest("hex");
  return join(dataDir, CONFIG_MUTATIONS_CHILD, `${digest}.sqlite`);
}

export function createPiWebUiConfigMutationCoordinator(options: PiWebUiConfigMutationCoordinatorOptions = {}): PiWebUiConfigMutationCoordinator {
  const configOptions: LoadOptions = options.config ?? {};
  const env = configOptions.env ?? process.env;
  const cwd = configOptions.cwd ?? process.cwd();
  const resolvedConfigPath = piWebUiConfigPath(env, cwd);
  const dataDirInput = options.dataDir === undefined ? piWebUiDataDir(env, cwd) : resolve(cwd, options.dataDir);
  mkdirSync(dataDirInput, { recursive: true });
  const canonicalDataDir = realpathSync(dataDirInput);
  validateCanonicalDataRoot(canonicalDataDir);
  const mutationsDir = join(canonicalDataDir, CONFIG_MUTATIONS_CHILD);
  ensureConfigMutationsChild(mutationsDir);
  const databasePath = piWebUiConfigMutationDatabasePath(resolvedConfigPath, canonicalDataDir);
  const now = options.now ?? (() => performance.now());
  const scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry;
  const openDatabase = options.openDatabase ?? defaultOpenDatabase;
  const readFileIdentity = options.readFileIdentity ?? defaultReadFileIdentity;
  const createRevision = options.createRevision ?? randomUUID;

  async function withAcquiredTransaction<T>(run: (db: PiWebUiConfigLockDatabase) => T): Promise<T> {
    // One monotonic ten-second budget for the entire acquisition; wall-clock
    // adjustments cannot shorten or stretch it, and it is never reset between
    // retries.
    const deadline = now() + PI_WEBUI_CONFIG_MUTATION_LOCK_TIMEOUT_MS;
    for (;;) {
      // Enforced before every attempt and again after every retry wake.
      if (now() > deadline) throw new PiWebUiConfigMutationBusyError();
      let db: PiWebUiConfigLockDatabase | undefined;
      let acquired = false;
      try {
        // Database opening and setup are part of the guarded attempt: SQLite
        // can report busy from setup PRAGMAs as well as from BEGIN IMMEDIATE.
        db = openDatabase(databasePath);
        db.beginImmediate();
        acquired = true;
        return run(db);
      } catch (error) {
        try {
          // Roll back only an uncommitted acquired transaction; a setup
          // failure never reaches rollback.
          if (acquired && db !== undefined) db.rollback();
        } catch {
          // Close-only cleanup; the acquisition failure is what matters.
        }
        if (isSqliteBusy(error)) {
          if (now() >= deadline) throw new PiWebUiConfigMutationBusyError();
          // Bound the retry delay to the remaining budget so a slow retry can
          // never overshoot the deadline.
          const remainingBudget = Math.max(0, deadline - now());
          await scheduleRetryOnce(Math.min(PI_WEBUI_CONFIG_MUTATION_RETRY_MS, remainingBudget));
          continue;
        }
        throw error;
      } finally {
        // Every attempt closes its own handle, success or failure, so a
        // long-lived process leaks no descriptor per coordinated operation.
        db?.close();
      }
    }
  }

  function scheduleRetryOnce(delayMs: number): Promise<void> {
    return new Promise<void>((resolveRetry) => {
      scheduleRetry(resolveRetry, delayMs);
    });
  }

  function readSnapshot(db: PiWebUiConfigLockDatabase): PiWebUiConfigMutationSnapshot {
    const loaded = loadPiWebUiConfig(configOptions);
    if (loaded.path !== resolvedConfigPath) {
      throw new Error("PI WEBUI config path changed during coordinated access");
    }
    const fingerprint = fingerprintFor(readFileIdentity(resolvedConfigPath));
    const stored = db.readState();
    let speechInputRevision: string;
    if (stored?.fileFingerprint !== fingerprint) {
      // Offline/manual replacement or a crash after JSON rename leaves stale
      // state; conservative rotation repairs the CAS revision.
      speechInputRevision = createRevision();
      db.writeState({ speechInputRevision, fileFingerprint: fingerprint });
    } else {
      speechInputRevision = stored.speechInputRevision;
    }
    return { loaded, speechInputRevision };
  }

  return {
    read: () => withAcquiredTransaction((db) => {
      const snapshot = readSnapshot(db);
      db.commit();
      return snapshot;
    }),

    mutate: (mutate, mutationOptions = {}) => withAcquiredTransaction((db) => {
      const before = readSnapshot(db);
      const next = mutate(before);
      // Compare the raw persisted speech subtree, never the parsed form:
      // canonicalization or trimming from an unrelated write still counts as
      // a persisted change and conservatively rotates the CAS revision.
      const beforeRawSpeech = readRawSpeechInputSubtree(resolvedConfigPath);
      savePiWebUiConfig(next, configOptions);
      const after = loadPiWebUiConfig(configOptions);
      if (after.path !== resolvedConfigPath) {
        throw new Error("PI WEBUI config path changed during coordinated mutation");
      }
      const identity = readFileIdentity(resolvedConfigPath);
      const fingerprint = fingerprintFor(identity);
      const afterRawSpeech = readRawSpeechInputSubtree(resolvedConfigPath);
      const speechChanged = !sameRawSpeechInput(beforeRawSpeech, afterRawSpeech);
      const rotateSpeechInputRevision = speechChanged || mutationOptions.rotateSpeechInputRevision === true;
      const speechInputRevision = rotateSpeechInputRevision ? createRevision() : before.speechInputRevision;
      db.writeState({ speechInputRevision, fileFingerprint: fingerprint });
      db.commit();
      return { loaded: after, speechInputRevision };
    }),
  };
}

/**
 * Field-by-field structural equality of the raw persisted speech subtree,
 * order-independent and tolerant of unknown keys, so canonicalization or
 * trimming performed by an unrelated write is still detected as a change.
 */
function sameRawSpeechInput(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRawRecord(a) || !isRawRecord(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!sameRawSpeechInput(a[key], b[key])) return false;
  }
  return true;
}

function isRawRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprintFor(identity: PiWebUiConfigFileIdentity): string {
  const hash = createHash("sha256");
  hash.update("exists");
  hash.update(identity.exists ? "1" : "0");
  hash.update("device");
  hash.update(identity.device);
  hash.update("inode");
  hash.update(identity.inode);
  hash.update("size");
  hash.update(identity.size);
  hash.update("mtimeNs");
  hash.update(identity.mtimeNs);
  hash.update("ctimeNs");
  hash.update(identity.ctimeNs);
  return hash.digest("hex");
}

function defaultReadFileIdentity(path: string): PiWebUiConfigFileIdentity {
  try {
    const stats = statSync(path, { bigint: true });
    return {
      exists: true,
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
    };
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { exists: false, device: "", inode: "", size: "", mtimeNs: "", ctimeNs: "" };
    }
    throw error;
  }
}

function validateCanonicalDataRoot(canonicalDataDir: string): void {
  const metadata = statSync(canonicalDataDir);
  if (!metadata.isDirectory()) throw new Error("PI WEBUI data directory must be a directory");
  if (process.platform === "win32") return;
  if (metadata.uid !== (process.geteuid?.() ?? -1)) {
    throw new Error("PI WEBUI data directory must be owned by the PI WEBUI user");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("PI WEBUI data directory must not be group or other writable");
  }
}

function ensureConfigMutationsChild(childDir: string): void {
  let metadata: Stats;
  try {
    metadata = lstatSync(childDir);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    mkdirSync(childDir, { mode: 0o700 });
    chmodSync(childDir, 0o700);
    return;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error("PI WEBUI config mutation directory must not be a symbolic link");
  }
  if (!metadata.isDirectory()) {
    throw new Error("PI WEBUI config mutation directory must be a directory");
  }
  if (process.platform !== "win32") {
    if (metadata.uid !== (process.geteuid?.() ?? -1)) {
      throw new Error("PI WEBUI config mutation directory must be owned by the PI WEBUI user");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("PI WEBUI config mutation directory must not be group or other writable");
    }
  }
}

/**
 * Validate and prepare the private database file before SQLite opens it:
 * reject symlinks, non-regular files, wrong-owner files, and multi-link
 * files; precreate an absent file exclusively at 0600; tighten an accepted
 * existing file to 0600.
 */
function validateAndPrepareDatabaseFile(path: string): void {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    try {
      const fd = openSync(path, "wx", 0o600);
      closeSync(fd);
    } catch (precreateError) {
      if (!isNodeErrorWithCode(precreateError, "EEXIST")) throw precreateError;
    }
    metadata = lstatSync(path);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error("PI WEBUI config mutation database must not be a symbolic link");
  }
  if (!metadata.isFile()) {
    throw new Error("PI WEBUI config mutation database must be a regular file");
  }
  if (process.platform !== "win32" && metadata.uid !== (process.geteuid?.() ?? -1)) {
    throw new Error("PI WEBUI config mutation database must be owned by the PI WEBUI user");
  }
  if (metadata.nlink !== 1) {
    throw new Error("PI WEBUI config mutation database must not have hard links");
  }
  chmodSync(path, 0o600);
}

class SqliteConfigMutationLockDatabase implements PiWebUiConfigLockDatabase {
  constructor(private readonly db: DatabaseSync) {}

  beginImmediate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    // The one-row state table is created only inside the transaction, so a
    // busy failure can never leave a half-initialized schema behind.
    this.db.exec(STATE_TABLE_SQL);
  }

  readState(): PiWebUiConfigLockState | undefined {
    const row = this.db.prepare("SELECT speechInputRevision, fileFingerprint FROM configMutationState WHERE id = 1").get();
    if (!isStateRow(row)) return undefined;
    return { speechInputRevision: row.speechInputRevision, fileFingerprint: row.fileFingerprint };
  }

  writeState(state: PiWebUiConfigLockState): void {
    this.db.prepare(
      "INSERT INTO configMutationState (id, speechInputRevision, fileFingerprint) VALUES (1, ?, ?) "
      + "ON CONFLICT(id) DO UPDATE SET speechInputRevision = excluded.speechInputRevision, fileFingerprint = excluded.fileFingerprint",
    ).run(state.speechInputRevision, state.fileFingerprint);
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  close(): void {
    this.db.close();
  }
}

function defaultOpenDatabase(path: string): PiWebUiConfigLockDatabase {
  validateAndPrepareDatabaseFile(path);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    // Nonblocking acquisition: SQLite reports SQLITE_BUSY immediately so this
    // process can close the handle and retry on the event loop instead of
    // blocking the gateway on an in-flight transaction elsewhere.
    db.exec("PRAGMA busy_timeout = 0");
    // The rollback journal stays inside the private owned child directory.
    db.exec("PRAGMA journal_mode = DELETE");
    return new SqliteConfigMutationLockDatabase(db);
  } catch (error) {
    // A busy failure during setup (for example the journal-mode change needs
    // the exclusive lock) must still close the constructed handle before the
    // coordinator retries.
    db?.close();
    throw error;
  }
}

function isStateRow(value: unknown): value is { speechInputRevision: string; fileFingerprint: string } {
  if (typeof value !== "object" || value === null) return false;
  if (!("speechInputRevision" in value) || !("fileFingerprint" in value)) return false;
  return typeof value.speechInputRevision === "string" && typeof value.fileFingerprint === "string";
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && "errcode" in error && typeof error.errcode === "number" && error.errcode === 5;
}

function defaultScheduleRetry(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(timer);
  };
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
