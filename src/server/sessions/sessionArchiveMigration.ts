import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { piWebUiDataDir } from "../../config.js";
import { parseSessionArchiveFile, type ArchivedSessionRecord } from "./sessionArchiveStore.js";

export type LegacySessionArchiveMigrationSkipReason =
  | "data-dir-not-configured"
  | "data-dir-not-distinct"
  | "legacy-index-missing"
  | "legacy-index-invalid"
  | "destination-index-exists"
  | "destination-archive-not-empty-or-invalid"
  | "legacy-archive-layout-invalid"
  | "archive-record-conflict"
  | "inspection-failed";

export interface LegacySessionArchiveMigrationSkipped {
  status: "skipped";
  reason: LegacySessionArchiveMigrationSkipReason;
  error?: unknown;
}

export type LegacySessionArchiveMigrationPreflight =
  | LegacySessionArchiveMigrationSkipped
  | {
    status: "eligible";
    legacyIndexPath: string;
    destinationIndexPath: string;
    archiveFileCount: number;
  };

export type LegacySessionArchiveMigrationPhase = "stage" | "publish-files" | "commit-index";

export type LegacySessionArchiveMigrationResult =
  | LegacySessionArchiveMigrationSkipped
  | {
    status: "failed";
    phase: LegacySessionArchiveMigrationPhase;
    error: unknown;
    rollbackErrors: unknown[];
  }
  | {
    status: "migrated";
    archiveFileCount: number;
    cleanup: "complete";
  }
  | {
    status: "migrated";
    archiveFileCount: number;
    cleanup: "incomplete";
    cleanupErrors: unknown[];
  };

export interface SessionArchiveMigrationReadHandle {
  read(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface SessionArchiveMigrationFileSystem {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<Dirent[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  copyFile(source: string, destination: string, mode: number): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  link(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rmOwnedTree(path: string): Promise<void>;
  open(path: string): Promise<SessionArchiveMigrationReadHandle>;
}

export interface LegacySessionArchiveMigrationOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  createAttemptId?: () => string;
  fileSystem?: Partial<SessionArchiveMigrationFileSystem>;
}

interface PlannedArchiveFile {
  sourcePath: string;
  destinationPath: string;
  fileName: string;
}

interface MigrationPlan {
  legacyRoot: string;
  canonicalLegacyRoot: string;
  legacyIndexPath: string;
  legacyArchiveDir: string;
  canonicalLegacyArchiveDir: string;
  legacyArchiveDirExists: boolean;
  destinationRoot: string;
  canonicalDestinationRoot: string;
  destinationIndexPath: string;
  destinationArchiveDir: string;
  canonicalDestinationArchiveDir: string;
  destinationArchiveDirExists: boolean;
  sourceIndexContents: string;
  destinationIndexContents: string;
  files: PlannedArchiveFile[];
  platform: NodeJS.Platform;
}

interface InternalEligiblePreflight {
  status: "eligible";
  plan: MigrationPlan;
}

type InternalPreflight = LegacySessionArchiveMigrationSkipped | InternalEligiblePreflight;

const defaultFileSystem: SessionArchiveMigrationFileSystem = {
  lstat: async (path) => lstat(path),
  realpath: async (path) => realpath(path),
  readFile: async (path) => readFile(path, "utf8"),
  readdir: async (path) => readdir(path, { withFileTypes: true }),
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  copyFile: async (source, destination, mode) => copyFile(source, destination, mode),
  writeFile: async (path, contents) => {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  },
  link: async (source, destination) => link(source, destination),
  unlink: async (path) => unlink(path),
  rmdir: async (path) => rmdir(path),
  rmOwnedTree: async (path) => {
    await rm(path, { recursive: true, force: true });
  },
  open: async (path) => open(path, "r"),
};

export async function inspectLegacySessionArchiveMigration(
  options: LegacySessionArchiveMigrationOptions = {},
): Promise<LegacySessionArchiveMigrationPreflight> {
  const preflight = await buildMigrationPreflight(options, migrationFileSystem(options));
  if (preflight.status === "skipped") return preflight;
  return {
    status: "eligible",
    legacyIndexPath: preflight.plan.legacyIndexPath,
    destinationIndexPath: preflight.plan.destinationIndexPath,
    archiveFileCount: preflight.plan.files.length,
  };
}

export async function migrateLegacySessionArchive(
  options: LegacySessionArchiveMigrationOptions = {},
): Promise<LegacySessionArchiveMigrationResult> {
  const fileSystem = migrationFileSystem(options);
  const preflight = await buildMigrationPreflight(options, fileSystem);
  if (preflight.status === "skipped") return preflight;

  const plan = preflight.plan;
  let phase: LegacySessionArchiveMigrationPhase = "stage";
  let stagingRoot: string | undefined;
  let stagingCreated = false;
  let destinationArchiveCreated = false;
  const ownedDestinationFiles: string[] = [];

  try {
    await fileSystem.mkdir(plan.destinationRoot, { recursive: true });
    const currentDestinationRoot = await canonicalizeAllowMissing(plan.destinationRoot, fileSystem);
    if (!pathsEqual(currentDestinationRoot, plan.canonicalDestinationRoot, plan.platform)) {
      throw new Error("Destination data root changed after migration preflight");
    }
    await assertDestinationStateUnchanged(plan, fileSystem);

    const attemptId = safeAttemptId((options.createAttemptId ?? randomUUID)());
    // Keep staging beside, not inside, the authoritative archive directory so an
    // interrupted staging copy cannot be mistaken for destination archive data.
    stagingRoot = join(plan.destinationRoot, `.archived-sessions-migration-${attemptId}`);
    await fileSystem.mkdir(stagingRoot);
    stagingCreated = true;
    const stagingFilesDir = join(stagingRoot, "files");
    await fileSystem.mkdir(stagingFilesDir);

    const stagedFiles = new Map<string, string>();
    for (const file of plan.files) {
      const stagedPath = join(stagingFilesDir, file.fileName);
      await fileSystem.copyFile(file.sourcePath, stagedPath, constants.COPYFILE_EXCL);
      if (!await filesEqual(file.sourcePath, stagedPath, fileSystem)) {
        throw new Error(`Staged archive file verification failed: ${file.fileName}`);
      }
      stagedFiles.set(file.destinationPath, stagedPath);
    }

    const stagedIndexPath = join(stagingRoot, "archived-sessions.json");
    await fileSystem.writeFile(stagedIndexPath, plan.destinationIndexContents);
    if (await fileSystem.readFile(stagedIndexPath) !== plan.destinationIndexContents) {
      throw new Error("Staged archive index verification failed");
    }

    phase = "publish-files";
    await assertDestinationStateUnchanged(plan, fileSystem);
    if (plan.files.length > 0 && !plan.destinationArchiveDirExists) {
      await fileSystem.mkdir(plan.destinationArchiveDir);
      destinationArchiveCreated = true;
    }

    for (const file of plan.files) {
      const stagedPath = stagedFiles.get(file.destinationPath);
      if (stagedPath === undefined) throw new Error(`Missing staged archive file: ${file.fileName}`);
      try {
        await fileSystem.copyFile(stagedPath, file.destinationPath, constants.COPYFILE_EXCL);
        ownedDestinationFiles.push(file.destinationPath);
      } catch (error: unknown) {
        if (!isNodeErrorWithCode(error, "EEXIST")) ownedDestinationFiles.push(file.destinationPath);
        throw error;
      }
      if (!await filesEqual(stagedPath, file.destinationPath, fileSystem)) {
        throw new Error(`Published archive file verification failed: ${file.fileName}`);
      }
    }

    phase = "commit-index";
    await assertPlanReadyToCommit(plan, stagedIndexPath, fileSystem);
    // A same-directory hard link atomically publishes the already-verified index
    // and, unlike rename on POSIX, fails rather than replacing an existing index.
    await fileSystem.link(stagedIndexPath, plan.destinationIndexPath);
  } catch (error: unknown) {
    const rollbackErrors = await rollbackUncommittedDestination({
      stagingRoot,
      stagingCreated,
      destinationArchiveDir: plan.destinationArchiveDir,
      destinationArchiveCreated,
      ownedDestinationFiles,
    }, fileSystem);
    return { status: "failed", phase, error, rollbackErrors };
  }

  const cleanupErrors: unknown[] = [];
  try {
    await fileSystem.rmOwnedTree(stagingRoot);
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  cleanupErrors.push(...await removeCommittedLegacyState(plan, fileSystem));

  return cleanupErrors.length === 0
    ? { status: "migrated", archiveFileCount: plan.files.length, cleanup: "complete" }
    : { status: "migrated", archiveFileCount: plan.files.length, cleanup: "incomplete", cleanupErrors };
}

async function buildMigrationPreflight(
  options: LegacySessionArchiveMigrationOptions,
  fileSystem: SessionArchiveMigrationFileSystem,
): Promise<InternalPreflight> {
  const env = options.env ?? process.env;
  const configuredDataDir = env["PI_WEBUI_DATA_DIR"];
  if (configuredDataDir === undefined || configuredDataDir.trim() === "") {
    return migrationSkipped("data-dir-not-configured");
  }

  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const legacyRoot = resolve(options.homeDir ?? homedir(), ".pi-webui");
  const destinationRoot = piWebUiDataDir(env, cwd);
  const legacyIndexPath = join(legacyRoot, "archived-sessions.json");
  const legacyArchiveDir = join(legacyRoot, "archived-sessions");
  const destinationIndexPath = join(destinationRoot, "archived-sessions.json");
  const destinationArchiveDir = join(destinationRoot, "archived-sessions");

  try {
    const canonicalLegacyRoot = await canonicalizeAllowMissing(legacyRoot, fileSystem);
    const canonicalDestinationRoot = await canonicalizeAllowMissing(destinationRoot, fileSystem);
    if (pathsEqual(canonicalLegacyRoot, canonicalDestinationRoot, platform)) {
      return migrationSkipped("data-dir-not-distinct");
    }

    const legacyIndexStats = await lstatIfExists(legacyIndexPath, fileSystem);
    if (legacyIndexStats === undefined) return migrationSkipped("legacy-index-missing");
    if (!legacyIndexStats.isFile() || legacyIndexStats.isSymbolicLink()) {
      return migrationSkipped("legacy-index-invalid");
    }

    const sourceIndexContents = await fileSystem.readFile(legacyIndexPath);
    const parsedDocument = parseArchiveDocument(sourceIndexContents);
    if (parsedDocument === undefined) return migrationSkipped("legacy-index-invalid");

    if (await lstatIfExists(destinationIndexPath, fileSystem) !== undefined) {
      return migrationSkipped("destination-index-exists");
    }

    const destinationArchiveStats = await lstatIfExists(destinationArchiveDir, fileSystem);
    let destinationArchiveDirExists = false;
    if (destinationArchiveStats !== undefined) {
      if (!destinationArchiveStats.isDirectory() || destinationArchiveStats.isSymbolicLink()) {
        return migrationSkipped("destination-archive-not-empty-or-invalid");
      }
      if ((await fileSystem.readdir(destinationArchiveDir)).length !== 0) {
        return migrationSkipped("destination-archive-not-empty-or-invalid");
      }
      destinationArchiveDirExists = true;
    }

    const legacyArchiveStats = await lstatIfExists(legacyArchiveDir, fileSystem);
    if (legacyArchiveStats !== undefined && (!legacyArchiveStats.isDirectory() || legacyArchiveStats.isSymbolicLink())) {
      return migrationSkipped("legacy-archive-layout-invalid");
    }
    const legacyArchiveDirExists = legacyArchiveStats !== undefined;
    const canonicalLegacyArchiveDir = legacyArchiveDirExists
      ? await fileSystem.realpath(legacyArchiveDir)
      : await canonicalizeAllowMissing(legacyArchiveDir, fileSystem);
    const canonicalDestinationArchiveDir = destinationArchiveDirExists
      ? await fileSystem.realpath(destinationArchiveDir)
      : join(canonicalDestinationRoot, "archived-sessions");
    if (pathsOverlap(canonicalLegacyArchiveDir, canonicalDestinationArchiveDir, platform)) {
      return migrationSkipped("data-dir-not-distinct");
    }

    const plannedFiles = await planArchiveFiles({
      sessions: parsedDocument.sessions,
      legacyArchiveDir,
      canonicalLegacyArchiveDir,
      legacyArchiveDirExists,
      destinationArchiveDir,
      canonicalDestinationArchiveDir,
      platform,
    }, fileSystem);
    if (plannedFiles.status === "skipped") return plannedFiles;

    if (!await legacyDirectoryMatchesPlan(legacyArchiveDir, legacyArchiveDirExists, plannedFiles.files, platform, fileSystem)) {
      return migrationSkipped("legacy-archive-layout-invalid");
    }

    const rewrittenSessions = parsedDocument.rawSessions.map((record, index) => {
      const destinationPath = plannedFiles.destinationPathsByRecord[index];
      return destinationPath === undefined ? record : { ...record, archivePath: destinationPath };
    });
    const destinationIndexContents = `${JSON.stringify({ ...parsedDocument.rawDocument, sessions: rewrittenSessions }, null, 2)}\n`;

    return {
      status: "eligible",
      plan: {
        legacyRoot,
        canonicalLegacyRoot,
        legacyIndexPath,
        legacyArchiveDir,
        canonicalLegacyArchiveDir,
        legacyArchiveDirExists,
        destinationRoot,
        canonicalDestinationRoot,
        destinationIndexPath,
        destinationArchiveDir,
        canonicalDestinationArchiveDir,
        destinationArchiveDirExists,
        sourceIndexContents,
        destinationIndexContents,
        files: plannedFiles.files,
        platform,
      },
    };
  } catch (error: unknown) {
    return migrationSkipped("inspection-failed", error);
  }
}

interface ParsedArchiveDocument {
  rawDocument: Record<string, unknown>;
  rawSessions: Record<string, unknown>[];
  sessions: ArchivedSessionRecord[];
}

function parseArchiveDocument(contents: string): ParsedArchiveDocument | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value)) return undefined;
    const rawSessions = recordArray(value["sessions"]);
    if (rawSessions === undefined) return undefined;
    const archive = parseSessionArchiveFile(value);
    return { rawDocument: value, rawSessions, sessions: archive.sessions };
  } catch {
    return undefined;
  }
}

async function planArchiveFiles(
  input: {
    sessions: ArchivedSessionRecord[];
    legacyArchiveDir: string;
    canonicalLegacyArchiveDir: string;
    legacyArchiveDirExists: boolean;
    destinationArchiveDir: string;
    canonicalDestinationArchiveDir: string;
    platform: NodeJS.Platform;
  },
  fileSystem: SessionArchiveMigrationFileSystem,
): Promise<LegacySessionArchiveMigrationSkipped | { status: "planned"; files: PlannedArchiveFile[]; destinationPathsByRecord: (string | undefined)[] }> {
  const sessionIds = new Set<string>();
  const sourcePaths = new Set<string>();
  const destinationPaths = new Set<string>();
  const destinationPathsByRecord: (string | undefined)[] = Array.from({ length: input.sessions.length });
  const files: PlannedArchiveFile[] = [];

  for (const [index, session] of input.sessions.entries()) {
    if (session.sessionId.trim() === "" || sessionIds.has(session.sessionId)) {
      return migrationSkipped("archive-record-conflict");
    }
    sessionIds.add(session.sessionId);

    if (session.archivePath === undefined) continue;
    if (!input.legacyArchiveDirExists || !isAbsolute(session.archivePath)) {
      return migrationSkipped("legacy-archive-layout-invalid");
    }

    const sourcePath = resolve(session.archivePath);
    if (!pathsEqual(dirname(sourcePath), input.legacyArchiveDir, input.platform)) {
      return migrationSkipped("legacy-archive-layout-invalid");
    }
    const sourceStats = await lstatIfExists(sourcePath, fileSystem);
    if (sourceStats === undefined || !sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      return migrationSkipped("legacy-archive-layout-invalid");
    }
    const canonicalSourcePath = await fileSystem.realpath(sourcePath);
    if (!pathsEqual(dirname(canonicalSourcePath), input.canonicalLegacyArchiveDir, input.platform)) {
      return migrationSkipped("legacy-archive-layout-invalid");
    }

    const fileName = basename(sourcePath);
    const destinationPath = join(input.destinationArchiveDir, fileName);
    const canonicalDestinationPath = join(input.canonicalDestinationArchiveDir, fileName);
    const sourceKey = pathKey(canonicalSourcePath, input.platform);
    const destinationKey = collisionKey(canonicalDestinationPath);
    if (sourcePaths.has(sourceKey) || destinationPaths.has(destinationKey)) {
      return migrationSkipped("archive-record-conflict");
    }
    sourcePaths.add(sourceKey);
    destinationPaths.add(destinationKey);
    destinationPathsByRecord[index] = destinationPath;
    files.push({ sourcePath, destinationPath, fileName });
  }

  return { status: "planned", files, destinationPathsByRecord };
}

async function legacyDirectoryMatchesPlan(
  legacyArchiveDir: string,
  legacyArchiveDirExists: boolean,
  files: PlannedArchiveFile[],
  platform: NodeJS.Platform,
  fileSystem: SessionArchiveMigrationFileSystem,
): Promise<boolean> {
  const archiveStats = await lstatIfExists(legacyArchiveDir, fileSystem);
  if (!legacyArchiveDirExists) return archiveStats === undefined && files.length === 0;
  if (archiveStats === undefined || !archiveStats.isDirectory() || archiveStats.isSymbolicLink()) return false;
  const entries = await fileSystem.readdir(legacyArchiveDir);
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) return false;
  const actualNames = new Set(entries.map((entry) => pathNameKey(entry.name, platform)));
  const expectedNames = new Set(files.map((file) => pathNameKey(file.fileName, platform)));
  if (actualNames.size !== entries.length || expectedNames.size !== files.length || actualNames.size !== expectedNames.size) return false;
  return [...expectedNames].every((name) => actualNames.has(name));
}

async function assertDestinationStateUnchanged(
  plan: MigrationPlan,
  fileSystem: SessionArchiveMigrationFileSystem,
): Promise<void> {
  if (await lstatIfExists(plan.destinationIndexPath, fileSystem) !== undefined) {
    throw new Error("Destination archive index appeared after migration preflight");
  }
  const archiveStats = await lstatIfExists(plan.destinationArchiveDir, fileSystem);
  if (!plan.destinationArchiveDirExists) {
    if (archiveStats !== undefined) throw new Error("Destination archive directory appeared after migration preflight");
    return;
  }
  if (archiveStats === undefined || !archiveStats.isDirectory() || archiveStats.isSymbolicLink()) {
    throw new Error("Destination archive directory changed after migration preflight");
  }
  if ((await fileSystem.readdir(plan.destinationArchiveDir)).length !== 0) {
    throw new Error("Destination archive directory is no longer empty");
  }
}

async function assertPlanReadyToCommit(
  plan: MigrationPlan,
  stagedIndexPath: string,
  fileSystem: SessionArchiveMigrationFileSystem,
): Promise<void> {
  const currentLegacyRoot = await canonicalizeAllowMissing(plan.legacyRoot, fileSystem);
  const currentDestinationRoot = await canonicalizeAllowMissing(plan.destinationRoot, fileSystem);
  if (!pathsEqual(currentLegacyRoot, plan.canonicalLegacyRoot, plan.platform)
    || !pathsEqual(currentDestinationRoot, plan.canonicalDestinationRoot, plan.platform)) {
    throw new Error("Archive data root changed during migration");
  }
  const legacyIndexStats = await lstatIfExists(plan.legacyIndexPath, fileSystem);
  if (legacyIndexStats === undefined || !legacyIndexStats.isFile() || legacyIndexStats.isSymbolicLink()) {
    throw new Error("Legacy archive index changed during migration");
  }
  if (await fileSystem.readFile(plan.legacyIndexPath) !== plan.sourceIndexContents) {
    throw new Error("Legacy archive index changed during migration");
  }
  if (!await legacyDirectoryMatchesPlan(plan.legacyArchiveDir, plan.legacyArchiveDirExists, plan.files, plan.platform, fileSystem)) {
    throw new Error("Legacy archive directory changed during migration");
  }
  if (plan.legacyArchiveDirExists
    && !pathsEqual(await fileSystem.realpath(plan.legacyArchiveDir), plan.canonicalLegacyArchiveDir, plan.platform)) {
    throw new Error("Legacy archive directory changed during migration");
  }
  if (await lstatIfExists(plan.destinationIndexPath, fileSystem) !== undefined) {
    throw new Error("Destination archive index appeared during migration");
  }
  if (await fileSystem.readFile(stagedIndexPath) !== plan.destinationIndexContents) {
    throw new Error("Staged archive index changed during migration");
  }

  if (plan.files.length === 0) {
    const destinationStats = await lstatIfExists(plan.destinationArchiveDir, fileSystem);
    if (plan.destinationArchiveDirExists) {
      if (destinationStats === undefined || !destinationStats.isDirectory() || destinationStats.isSymbolicLink()
        || !pathsEqual(await fileSystem.realpath(plan.destinationArchiveDir), plan.canonicalDestinationArchiveDir, plan.platform)
        || (await fileSystem.readdir(plan.destinationArchiveDir)).length !== 0) {
        throw new Error("Destination archive directory changed during migration");
      }
    } else if (destinationStats !== undefined) {
      throw new Error("Destination archive directory appeared during migration");
    }
    return;
  }

  const destinationStats = await lstatIfExists(plan.destinationArchiveDir, fileSystem);
  if (destinationStats === undefined || !destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
    throw new Error("Destination archive directory is not a real directory");
  }
  if (!pathsEqual(await fileSystem.realpath(plan.destinationArchiveDir), plan.canonicalDestinationArchiveDir, plan.platform)) {
    throw new Error("Destination archive directory changed during migration");
  }
  const destinationEntries = await fileSystem.readdir(plan.destinationArchiveDir);
  if (destinationEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Destination archive directory contains an unexpected entry");
  }
  const actualNames = new Set(destinationEntries.map((entry) => pathNameKey(entry.name, plan.platform)));
  const expectedNames = new Set(plan.files.map((file) => pathNameKey(file.fileName, plan.platform)));
  if (actualNames.size !== destinationEntries.length || actualNames.size !== expectedNames.size
    || ![...expectedNames].every((name) => actualNames.has(name))) {
    throw new Error("Destination archive directory does not match the migration plan");
  }

  for (const file of plan.files) {
    const sourceStats = await lstatIfExists(file.sourcePath, fileSystem);
    const destinationFileStats = await lstatIfExists(file.destinationPath, fileSystem);
    if (sourceStats === undefined || !sourceStats.isFile() || sourceStats.isSymbolicLink()
      || destinationFileStats === undefined || !destinationFileStats.isFile() || destinationFileStats.isSymbolicLink()) {
      throw new Error(`Archive file changed during migration: ${file.fileName}`);
    }
    if (!await filesEqual(file.sourcePath, file.destinationPath, fileSystem)) {
      throw new Error(`Archive file verification failed before commit: ${file.fileName}`);
    }
  }
}

async function rollbackUncommittedDestination(
  state: {
    stagingRoot: string | undefined;
    stagingCreated: boolean;
    destinationArchiveDir: string;
    destinationArchiveCreated: boolean;
    ownedDestinationFiles: string[];
  },
  fileSystem: SessionArchiveMigrationFileSystem,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const path of [...state.ownedDestinationFiles].reverse()) {
    try {
      await removeFileIfPresent(path, fileSystem);
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (state.destinationArchiveCreated) {
    try {
      await removeDirectoryIfPresent(state.destinationArchiveDir, fileSystem);
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (state.stagingCreated && state.stagingRoot !== undefined) {
    try {
      await fileSystem.rmOwnedTree(state.stagingRoot);
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  return errors;
}

async function removeCommittedLegacyState(
  plan: MigrationPlan,
  fileSystem: SessionArchiveMigrationFileSystem,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  // Remove the index last. If any file/directory cleanup fails, the complete
  // legacy index remains as a recovery marker while the destination is valid.
  for (const file of plan.files) {
    try {
      await removeFileIfPresent(file.sourcePath, fileSystem);
    } catch (error: unknown) {
      errors.push(error);
      return errors;
    }
  }
  if (plan.legacyArchiveDirExists) {
    try {
      await removeDirectoryIfPresent(plan.legacyArchiveDir, fileSystem);
    } catch (error: unknown) {
      errors.push(error);
      return errors;
    }
  }
  try {
    await removeFileIfPresent(plan.legacyIndexPath, fileSystem);
  } catch (error: unknown) {
    errors.push(error);
  }
  return errors;
}

async function filesEqual(
  firstPath: string,
  secondPath: string,
  fileSystem: SessionArchiveMigrationFileSystem,
): Promise<boolean> {
  const first = await fileSystem.open(firstPath);
  try {
    const second = await fileSystem.open(secondPath);
    try {
      const firstBuffer = Buffer.allocUnsafe(64 * 1024);
      const secondBuffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const [firstBytes, secondBytes] = await Promise.all([
          readChunk(first, firstBuffer),
          readChunk(second, secondBuffer),
        ]);
        if (firstBytes !== secondBytes) return false;
        if (firstBytes === 0) return true;
        if (!firstBuffer.subarray(0, firstBytes).equals(secondBuffer.subarray(0, secondBytes))) return false;
      }
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
}

async function readChunk(handle: SessionArchiveMigrationReadHandle, buffer: Buffer): Promise<number> {
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

async function canonicalizeAllowMissing(path: string, fileSystem: SessionArchiveMigrationFileSystem): Promise<string> {
  let cursor = resolve(path);
  const missingParts: string[] = [];
  for (;;) {
    try {
      const canonical = await fileSystem.realpath(cursor);
      return resolve(canonical, ...missingParts);
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      if (await lstatIfExists(cursor, fileSystem) !== undefined) {
        throw new Error(`Cannot resolve existing path: ${cursor}`, { cause: error });
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingParts.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function lstatIfExists(path: string, fileSystem: SessionArchiveMigrationFileSystem): Promise<Stats | undefined> {
  try {
    return await fileSystem.lstat(path);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function removeFileIfPresent(path: string, fileSystem: SessionArchiveMigrationFileSystem): Promise<void> {
  try {
    await fileSystem.unlink(path);
  } catch (error: unknown) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
  }
}

async function removeDirectoryIfPresent(path: string, fileSystem: SessionArchiveMigrationFileSystem): Promise<void> {
  try {
    await fileSystem.rmdir(path);
  } catch (error: unknown) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
  }
}

function migrationFileSystem(options: LegacySessionArchiveMigrationOptions): SessionArchiveMigrationFileSystem {
  return { ...defaultFileSystem, ...options.fileSystem };
}

function migrationSkipped(
  reason: LegacySessionArchiveMigrationSkipReason,
  error?: unknown,
): LegacySessionArchiveMigrationSkipped {
  return error === undefined ? { status: "skipped", reason } : { status: "skipped", reason, error };
}

function pathsOverlap(first: string, second: string, platform: NodeJS.Platform): boolean {
  return pathContains(first, second, platform) || pathContains(second, first, platform);
}

function pathContains(parent: string, candidate: string, platform: NodeJS.Platform): boolean {
  const parentPath = pathKey(parent, platform);
  const candidatePath = pathKey(candidate, platform);
  const pathFromParent = relative(parentPath, candidatePath);
  const firstSegment = pathFromParent.split(/[\\/]/, 1)[0];
  return pathFromParent === "" || (firstSegment !== ".." && !isAbsolute(pathFromParent));
}

function pathsEqual(first: string, second: string, platform: NodeJS.Platform): boolean {
  return pathKey(first, platform) === pathKey(second, platform);
}

function pathKey(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathNameKey(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toLowerCase() : name;
}

function collisionKey(path: string): string {
  // Conservatively reject case/normalization variants even when the source
  // platform happens to allow them; the destination filesystem may not.
  return resolve(path).normalize("NFC").toLowerCase();
}

function safeAttemptId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "attempt";
}

function recordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    records.push(item);
  }
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
