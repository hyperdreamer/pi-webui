import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  migrateLegacySessionArchive,
  type LegacySessionArchiveMigrationOptions,
  type LegacySessionArchiveMigrationResult,
} from "../sessions/sessionArchiveMigration.js";
import { runSessionDaemonStartup } from "./sessionDaemonStartup.js";

const tempRoots: string[] = [];

describe("session daemon archive migration startup", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("finishes an eligible migration before constructing PiSessionService, registering archive routes, or listening", async () => {
    const fixture = await createLegacyArchiveFixture();
    const logger = createLogger();
    const boundaries: string[] = [];
    const runtime = { ready: true };

    const startedRuntime = await runSessionDaemonStartup({
      logger,
      migrateArchive: () => migrateLegacySessionArchive(fixture.options),
      createRuntime() {
        boundaries.push("construct-session-service");
        expectMigrationComplete(fixture);
        return runtime;
      },
      registerRoutes(createdRuntime) {
        boundaries.push("register-archive-routes");
        expect(createdRuntime).toBe(runtime);
        expectMigrationComplete(fixture);
      },
      listen(createdRuntime) {
        boundaries.push("listen");
        expect(createdRuntime).toBe(runtime);
        expectMigrationComplete(fixture);
        return Promise.resolve();
      },
    });

    expect(startedRuntime).toBe(runtime);
    expect(boundaries).toEqual([
      "construct-session-service",
      "register-archive-routes",
      "listen",
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      { archiveFileCount: 1 },
      "migrated legacy session archive to the configured PI_WEBUI_DATA_DIR",
    );
  });

  it("does not initialize archive consumers while a mutation-free eligibility check is pending", async () => {
    const logger = createLogger();
    const migration = deferred<LegacySessionArchiveMigrationResult>();
    const boundaries: string[] = [];

    const startup = runSessionDaemonStartup({
      logger,
      migrateArchive: () => migration.promise,
      createRuntime() {
        boundaries.push("construct-session-service");
        return { ready: true };
      },
      registerRoutes() {
        boundaries.push("register-archive-routes");
      },
      listen() {
        boundaries.push("listen");
        return Promise.resolve();
      },
    });

    expect(boundaries).toEqual([]);
    migration.resolve({ status: "skipped", reason: "legacy-index-missing" });
    await startup;

    expect(boundaries).toEqual([
      "construct-session-service",
      "register-archive-routes",
      "listen",
    ]);
    expect(logger.debug).toHaveBeenCalledWith(
      { reason: "legacy-index-missing" },
      "legacy session archive migration is not eligible; continuing session daemon startup",
    );
  });

  it("warns and continues normal startup when eligibility inspection is inconclusive", async () => {
    const logger = createLogger();
    const inspectionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const createRuntime = vi.fn(() => ({ ready: true }));
    const registerRoutes = vi.fn();
    const listen = vi.fn(() => Promise.resolve());

    await runSessionDaemonStartup({
      logger,
      migrateArchive: () => Promise.resolve<LegacySessionArchiveMigrationResult>({
        status: "skipped",
        reason: "inspection-failed",
        error: inspectionError,
      }),
      createRuntime,
      registerRoutes,
      listen,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      { err: inspectionError, reason: "inspection-failed" },
      "could not inspect legacy session archive migration eligibility; continuing session daemon startup without migration",
    );
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(registerRoutes).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
  });

  it("logs an eligible migration failure and stops before archive consumers can mutate destination state", async () => {
    const logger = createLogger();
    const migrationError = new Error("copy failed");
    const rollbackError = new Error("rollback failed");
    const createRuntime = vi.fn(() => ({ ready: true }));
    const registerRoutes = vi.fn();
    const listen = vi.fn(() => Promise.resolve());

    await expect(runSessionDaemonStartup({
      logger,
      migrateArchive: () => Promise.resolve<LegacySessionArchiveMigrationResult>({
        status: "failed",
        phase: "publish-files",
        error: migrationError,
        rollbackErrors: [rollbackError],
      }),
      createRuntime,
      registerRoutes,
      listen,
    })).rejects.toThrow("Legacy session archive migration failed during publish-files; session daemon startup stopped");

    expect(logger.error).toHaveBeenCalledWith(
      {
        err: migrationError,
        phase: "publish-files",
        rollbackErrorCount: 1,
        rollbackErrors: [rollbackError],
      },
      "legacy session archive migration failed before commit and rollback was incomplete; stopping session daemon startup",
    );
    expect(createRuntime).not.toHaveBeenCalled();
    expect(registerRoutes).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("warns but starts from the committed destination when legacy cleanup is incomplete", async () => {
    const logger = createLogger();
    const cleanupError = new Error("legacy index could not be removed");
    const createRuntime = vi.fn(() => ({ ready: true }));
    const registerRoutes = vi.fn();
    const listen = vi.fn(() => Promise.resolve());

    await runSessionDaemonStartup({
      logger,
      migrateArchive: () => Promise.resolve<LegacySessionArchiveMigrationResult>({
        status: "migrated",
        archiveFileCount: 2,
        cleanup: "incomplete",
        cleanupErrors: [cleanupError],
      }),
      createRuntime,
      registerRoutes,
      listen,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        archiveFileCount: 2,
        cleanupErrorCount: 1,
        cleanupErrors: [cleanupError],
      },
      "legacy session archive migration committed but cleanup was incomplete; continuing with the migrated destination archive",
    );
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(registerRoutes).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
  });
});

interface LegacyArchiveFixture {
  legacyIndexPath: string;
  legacyFilePath: string;
  destinationIndexPath: string;
  destinationFilePath: string;
  options: LegacySessionArchiveMigrationOptions;
}

async function createLegacyArchiveFixture(): Promise<LegacyArchiveFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-webui-sessiond-startup-"));
  tempRoots.push(root);
  const homeDir = join(root, "home");
  const legacyRoot = join(homeDir, ".pi-webui");
  const legacyArchiveDir = join(legacyRoot, "archived-sessions");
  const legacyIndexPath = join(legacyRoot, "archived-sessions.json");
  const legacyFilePath = join(legacyArchiveDir, "legacy-session.jsonl");
  const destinationRoot = join(root, "managed-state");
  const destinationIndexPath = join(destinationRoot, "archived-sessions.json");
  const destinationFilePath = join(destinationRoot, "archived-sessions", "legacy-session.jsonl");

  await mkdir(legacyArchiveDir, { recursive: true });
  await writeFile(legacyFilePath, "legacy session\n", "utf8");
  await writeFile(legacyIndexPath, `${JSON.stringify({
    sessions: [{
      sessionId: "legacy-session",
      cwd: join(root, "workspace"),
      archivedAt: "2026-01-01T00:00:00.000Z",
      archivePath: legacyFilePath,
    }],
  }, null, 2)}\n`, "utf8");

  return {
    legacyIndexPath,
    legacyFilePath,
    destinationIndexPath,
    destinationFilePath,
    options: {
      env: { PI_WEBUI_DATA_DIR: destinationRoot },
      cwd: root,
      homeDir,
      createAttemptId: () => "sessiond-startup-test",
    },
  };
}

function expectMigrationComplete(fixture: LegacyArchiveFixture): void {
  expect(existsSync(fixture.legacyIndexPath)).toBe(false);
  expect(existsSync(fixture.legacyFilePath)).toBe(false);
  expect(readFileSync(fixture.destinationFilePath, "utf8")).toBe("legacy session\n");
  expect(JSON.parse(readFileSync(fixture.destinationIndexPath, "utf8"))).toMatchObject({
    sessions: [{ archivePath: fixture.destinationFilePath }],
  });
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
