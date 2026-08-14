import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, chownSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PI_WEBUI_CONFIG_MUTATION_LOCK_TIMEOUT_MS,
  PiWebUiConfigMutationBusyError,
  createPiWebUiConfigMutationCoordinator,
  piWebUiConfigMutationDatabasePath,
  type PiWebUiConfigFileIdentity,
  type PiWebUiConfigLockDatabase,
  type PiWebUiConfigLockState,
  type PiWebUiConfigMutationCoordinator,
} from "./configMutationCoordinator.js";
import { loadPiWebUiConfig } from "./config.js";

let tempDir: string;
let configPath: string;
let dataDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-webui-coordinator-test-"));
  configPath = join(tempDir, "config.json");
  dataDir = join(tempDir, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  revisionCounter = 0;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("config mutation coordinator acquisition", () => {
  it("acquires immediately for read and mutation and commits once", async () => {
    const harness = fakeHarness();

    const read = await harness.coordinator.read();
    expect(read.loaded.path).toBe(configPath);
    expect(read.loaded.exists).toBe(false);
    expect(read.speechInputRevision).toBe("revision-1");
    expect(requireDb(harness.dbs, 0).commitCalls).toBe(1);
    expect(requireDb(harness.dbs, 0).rollbackCalls).toBe(0);
    expect(requireDb(harness.dbs, 0).closeCalls).toBe(0);

    const mutated = await harness.coordinator.mutate((current) => ({ ...current.loaded.config, port: 9001 }));
    expect(mutated.loaded.config.port).toBe(9001);
    expect(mutated.speechInputRevision).toBe("revision-1");
    expect(requireDb(harness.dbs, 1).commitCalls).toBe(1);
    expect(requireDb(harness.dbs, 1).beginImmediateCalls).toBe(1);
    expect(harness.retryCount()).toBe(0);
  });

  it("rolls back, closes, and retries an errcode 5 contention without blocking", async () => {
    const harness = fakeHarness({ beginErrors: [busyError()], retryAdvanceMs: 100 });

    const read = await harness.coordinator.read();

    expect(read.speechInputRevision).toBe("revision-1");
    expect(harness.retryCount()).toBe(1);
    expect(harness.dbs).toHaveLength(2);
    expect(requireDb(harness.dbs, 0).closeCalls).toBe(1);
    expect(requireDb(harness.dbs, 0).rollbackCalls).toBe(0);
    expect(requireDb(harness.dbs, 1).commitCalls).toBe(1);
  });

  it("spends one total 10,000 ms acquisition budget without resetting between attempts", async () => {
    const harness = fakeHarness({
      beginErrors: [busyError(), busyError(), busyError(), busyError(), busyError()],
      retryAdvanceMs: 2_500,
    });

    const attempt = harness.coordinator.read();
    await expect(attempt).rejects.toBeInstanceOf(PiWebUiConfigMutationBusyError);
    await expect(attempt).rejects.toMatchObject({ code: "PI_WEBUI_CONFIG_BUSY" });
    expect(harness.dbs).toHaveLength(5);
    expect(harness.dbs.every((db) => db.closeCalls === 1)).toBe(true);
    expect(harness.retryCount()).toBe(4);
    expect(harness.fakeNow()).toBe(10_000);
  });

  it("exhausts the budget at the exact deadline and never falls back to an unlocked save", async () => {
    const harness = fakeHarness({ beginErrors: [busyError(), busyError(), busyError(), busyError(), busyError()], retryAdvanceMs: 2_500 });

    await expect(harness.coordinator.mutate((current) => ({ ...current.loaded.config, port: 9001 })))
      .rejects.toBeInstanceOf(PiWebUiConfigMutationBusyError);
    expect(harness.fakeNow()).toBe(PI_WEBUI_CONFIG_MUTATION_LOCK_TIMEOUT_MS);
    expect(harness.dbs).toHaveLength(5);
    expect(harness.retryCount()).toBe(4);
    expect(existsSync(configPath)).toBe(false);
  });

  it("still acquires on an attempt exactly at the total deadline", async () => {
    const harness = fakeHarness({ beginErrors: [busyError(), busyError(), busyError(), busyError()], retryAdvanceMs: 2_500 });

    const read = await harness.coordinator.read();

    expect(read.loaded.path).toBe(configPath);
    expect(harness.fakeNow()).toBe(PI_WEBUI_CONFIG_MUTATION_LOCK_TIMEOUT_MS);
    expect(harness.dbs).toHaveLength(5);
    expect(requireDb(harness.dbs, 4).commitCalls).toBe(1);
  });

  it("fails immediately on non-contention SQLite errors after close", async () => {
    const harness = fakeHarness({ beginErrors: [new Error("no such table: configMutationState")] });

    await expect(harness.coordinator.read()).rejects.toThrow("no such table");
    expect(harness.retryCount()).toBe(0);
    expect(requireDb(harness.dbs, 0).closeCalls).toBe(1);
    expect(requireDb(harness.dbs, 0).rollbackCalls).toBe(0);
  });

  it("rolls back and closes after a mutation callback failure", async () => {
    const harness = fakeHarness();

    await expect(harness.coordinator.mutate(() => { throw new Error("callback boom"); })).rejects.toThrow("callback boom");

    expect(requireDb(harness.dbs, 0).rollbackCalls).toBe(1);
    expect(requireDb(harness.dbs, 0).closeCalls).toBe(1);
    expect(requireDb(harness.dbs, 0).commitCalls).toBe(0);
  });

  it("rolls back and closes after a low-level save failure", async () => {
    const harness = fakeHarness();

    // A value that passes the typed callback boundary but fails the strict
    // low-level save (agent without its required state directory).
    await expect(harness.coordinator.mutate((current) => ({ ...current.loaded.config, agent: { command: "acme-agent" } })))
      .rejects.toThrow("PI WEBUI config agent.dir or PI_WEBUI_AGENT_DIR is required");

    expect(requireDb(harness.dbs, 0).rollbackCalls).toBe(1);
    expect(requireDb(harness.dbs, 0).closeCalls).toBe(1);
  });

  it("rolls back and closes when the loaded path no longer matches the construction-time path", async () => {
    const env: NodeJS.ProcessEnv = { PI_WEBUI_CONFIG: configPath };
    const harness = fakeHarness({ env });

    env["PI_WEBUI_CONFIG"] = join(tempDir, "other.json");

    await expect(harness.coordinator.mutate(() => ({ port: 1 }))).rejects.toThrow("PI WEBUI config path changed");
    expect(requireDb(harness.dbs, 0).rollbackCalls).toBe(1);
    expect(requireDb(harness.dbs, 0).closeCalls).toBe(1);
  });

  it("recovers on the next operation after any failure", async () => {
    const harness = fakeHarness();
    await expect(harness.coordinator.mutate(() => { throw new Error("boom"); })).rejects.toThrow("boom");

    const recovered = await harness.coordinator.read();

    expect(recovered.loaded.path).toBe(configPath);
    expect(requireDb(harness.dbs, 1).commitCalls).toBe(1);
  });
});

describe("config mutation coordinator speech revision", () => {
  it("keeps one stable revision for one metadata fingerprint across instances", async () => {
    const coordinator = realCoordinator();
    const first = await coordinator.read();
    const second = await coordinator.read();

    expect(second.speechInputRevision).toBe(first.speechInputRevision);
    expect(second.speechInputRevision).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    const otherInstance = realCoordinator();
    expect((await otherInstance.read()).speechInputRevision).toBe(first.speechInputRevision);
  });

  it("preserves the revision across unrelated coordinated writes, including a speech-omitting callback", async () => {
    const coordinator = realCoordinator();
    const seeded = await coordinator.mutate((current) => ({
      ...current.loaded.config,
      speechInput: {
        provider: "cloud",
        language: "en-US",
        cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", apiKey: "$OPENAI_API_KEY" },
      },
    }));

    const unrelated = await coordinator.mutate((current) => ({ ...current.loaded.config, port: 9001 }));
    expect(unrelated.speechInputRevision).toBe(seeded.speechInputRevision);

    // The callback result omits speechInput entirely; the low-level writer
    // carries the persisted subtree forward, so the revision is preserved.
    const omitted = await coordinator.mutate(() => ({ port: 9002 }));
    expect(omitted.speechInputRevision).toBe(seeded.speechInputRevision);
    expect(omitted.loaded.config.speechInput).toEqual(seeded.loaded.config.speechInput);
    expect(omitted.loaded.config.port).toBe(9002);
  });

  it("rotates the revision only when the authoritative persisted speech subtree changed", async () => {
    const coordinator = realCoordinator();
    const first = await coordinator.mutate((current) => ({ ...current.loaded.config, speechInput: { provider: "browser" } }));
    const unchanged = await coordinator.mutate((current) => ({ ...current.loaded.config, port: 9001 }));
    expect(unchanged.speechInputRevision).toBe(first.speechInputRevision);

    const changed = await coordinator.mutate((current) => ({
      ...current.loaded.config,
      speechInput: { provider: "cloud", cloud: { model: "gpt-4o-mini-transcribe" } },
    }));
    expect(changed.speechInputRevision).not.toBe(first.speechInputRevision);
  });

  it("forces rotation for an idempotent speech mutation only when requested", async () => {
    const coordinator = realCoordinator();
    const speech = { provider: "cloud" as const, cloud: { apiKey: "$OPENAI_API_KEY" } };
    const first = await coordinator.mutate((current) => ({ ...current.loaded.config, speechInput: speech }));
    const idempotent = await coordinator.mutate((current) => ({ ...current.loaded.config, speechInput: speech }));
    expect(idempotent.speechInputRevision).toBe(first.speechInputRevision);

    const forced = await coordinator.mutate((current) => ({ ...current.loaded.config, speechInput: speech }), { rotateSpeechInputRevision: true });
    expect(forced.speechInputRevision).not.toBe(first.speechInputRevision);
    expect(forced.loaded.config.speechInput).toEqual(speech);
  });

  it("rotates after an offline replacement by identity metadata without hashing contents", async () => {
    const coordinator = realCoordinator();
    const first = await coordinator.read();

    writeFileSync(configPath, `${JSON.stringify({ port: 9000 })}\n`, "utf8");

    const second = await coordinator.read();
    expect(second.speechInputRevision).not.toBe(first.speechInputRevision);
    expect(second.loaded.config.port).toBe(9000);
  });

  it("rotates when the injected file identity changes and preserves it when it does not", async () => {
    let identity: PiWebUiConfigFileIdentity = {
      exists: false,
      device: "0",
      inode: "0",
      size: "0",
      mtimeNs: "0",
      ctimeNs: "0",
    };
    const harness = fakeHarness({
      readFileIdentity: () => identity,
    });

    const first = await harness.coordinator.read();
    expect(first.speechInputRevision).toBe("revision-1");

    const sameIdentity = await harness.coordinator.read();
    expect(sameIdentity.speechInputRevision).toBe("revision-1");

    identity = { ...identity, exists: true, size: "42" };
    const replaced = await harness.coordinator.read();
    expect(replaced.speechInputRevision).toBe("revision-2");
  });

  it("rotates conservatively after a crash between JSON rename and state commit", async () => {
    const harness = fakeHarness();
    const committed = await harness.coordinator.mutate((current) => ({ ...current.loaded.config, port: 9001 }));

    // Crash simulation: the JSON rename landed, but the old state row survived.
    harness.rewindState({ speechInputRevision: "pre-crash-revision", fileFingerprint: "pre-crash-fingerprint" });

    const recovered = await harness.coordinator.read();
    expect(recovered.speechInputRevision).not.toBe("pre-crash-revision");
    expect(recovered.loaded.config.port).toBe(9001);
    expect(harness.store.state?.speechInputRevision).not.toBe("pre-crash-revision");
    expect(harness.store.state?.fileFingerprint).not.toBe("pre-crash-fingerprint");
    expect(committed.speechInputRevision).toBe("revision-1");
  });

  it("stores no config, credential, audio, or transcript bytes in SQLite", async () => {
    const coordinator = realCoordinator();
    await coordinator.mutate((current) => ({
      ...current.loaded.config,
      port: 9001,
      speechInput: { provider: "cloud", cloud: { apiKey: "sk-super-secret-test", baseUrl: "https://api.openai.com/v1" } },
    }));

    const dbPath = piWebUiConfigMutationDatabasePath(configPath, realpathSync(dataDir));
    const bytes = readFileSync(dbPath, "utf8");
    expect(bytes).not.toContain("sk-super-secret-test");
    expect(bytes).not.toContain("api.openai.com");
    expect(bytes).not.toContain("9001");
    // Config JSON content never lands in the coordination database; only the
    // opaque revision and the identity fingerprint do.
    expect(bytes).not.toContain('"provider"');
    expect(bytes).not.toContain('"port"');
  });
});

describe("config mutation coordinator managed paths and permissions", () => {
  it("derives a deterministic canonical data-dir path keyed by the resolved config path", () => {
    const resolvedConfigPath = realpathSync(tempDir) + join("relative", "config.json");
    const canonicalDataDir = realpathSync(dataDir);
    const digest = createHash("sha256").update(resolvedConfigPath).digest("hex");

    expect(piWebUiConfigMutationDatabasePath(resolvedConfigPath, canonicalDataDir))
      .toBe(join(canonicalDataDir, "config-mutations", `${digest}.sqlite`));
  });

  it("derives the identical database path through a trusted data-root symlink", async () => {
    const realData = join(tempDir, "real-data");
    const linkData = join(tempDir, "link-data");
    mkdirSync(realData, { mode: 0o700 });
    symlinkSync(realData, linkData);
    const opened: string[] = [];
    const coordinator = createPiWebUiConfigMutationCoordinator({
      config: { env: { PI_WEBUI_CONFIG: configPath } },
      dataDir: linkData,
      openDatabase: (path) => {
        opened.push(path);
        const store: FakeLockStateStore = { state: undefined, beginErrors: [] };
        return new FakeLockDatabase(store);
      },
    });

    await coordinator.read();

    expect(opened).toEqual([piWebUiConfigMutationDatabasePath(configPath, realpathSync(realData))]);
    expect(opened[0]).toBe(piWebUiConfigMutationDatabasePath(configPath, realpathSync(linkData)));
  });

  it.skipIf(process.platform === "win32")("rejects a group/other-writable canonical data root", () => {
    chmodSync(dataDir, 0o777);

    expect(() => createPiWebUiConfigMutationCoordinator({ config: { env: { PI_WEBUI_CONFIG: configPath } }, dataDir }))
      .toThrow("PI WEBUI data directory must not be group or other writable");
  });

  it.skipIf(process.platform === "win32")("rejects a data root owned by another user", () => {
    if ((process.getuid?.() ?? -1) !== 0) return; // Only root can create a foreign-owned directory.
    chownSync(dataDir, 12345, 12345);

    expect(() => createPiWebUiConfigMutationCoordinator({ config: { env: { PI_WEBUI_CONFIG: configPath } }, dataDir }))
      .toThrow("PI WEBUI data directory must be owned by the PI WEBUI user");
  });

  it("rejects a config-mutations child symlink at construction", () => {
    const elsewhere = join(tempDir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dataDir, "config-mutations"));

    expect(() => createPiWebUiConfigMutationCoordinator({ config: { env: { PI_WEBUI_CONFIG: configPath } }, dataDir }))
      .toThrow("PI WEBUI config mutation directory must not be a symbolic link");
  });

  it("rejects a non-directory config-mutations child at construction", () => {
    writeFileSync(join(dataDir, "config-mutations"), "not a directory");

    expect(() => createPiWebUiConfigMutationCoordinator({ config: { env: { PI_WEBUI_CONFIG: configPath } }, dataDir }))
      .toThrow("PI WEBUI config mutation directory must be a directory");
  });

  it.skipIf(process.platform === "win32")("rejects a child owned by another user", () => {
    if ((process.getuid?.() ?? -1) !== 0) return;
    mkdirSync(join(dataDir, "config-mutations"), { mode: 0o700 });
    chownSync(join(dataDir, "config-mutations"), 12345, 12345);

    expect(() => createPiWebUiConfigMutationCoordinator({ config: { env: { PI_WEBUI_CONFIG: configPath } }, dataDir }))
      .toThrow("PI WEBUI config mutation directory must be owned by the PI WEBUI user");
  });

  it.skipIf(process.platform === "win32")("creates the private child at 0700 and the database at 0600", async () => {
    const coordinator = realCoordinator();
    await coordinator.read();

    expect(statSync(join(dataDir, "config-mutations")).mode & 0o777).toBe(0o700);
    expect(statSync(piWebUiConfigMutationDatabasePath(configPath, realpathSync(dataDir))).mode & 0o777).toBe(0o600);
  });

  it("rejects a database symlink before SQLite opens", async () => {
    const coordinator = realCoordinator();
    const dbPath = piWebUiConfigMutationDatabasePath(configPath, realpathSync(dataDir));
    const elsewhere = join(tempDir, "elsewhere.sqlite");
    writeFileSync(elsewhere, "not sqlite");
    symlinkSync(elsewhere, dbPath);

    await expect(coordinator.read()).rejects.toThrow("PI WEBUI config mutation database must not be a symbolic link");
  });

  it("rejects a non-regular database file", async () => {
    const coordinator = realCoordinator();
    mkdirSync(piWebUiConfigMutationDatabasePath(configPath, realpathSync(dataDir)));

    await expect(coordinator.read()).rejects.toThrow("PI WEBUI config mutation database must be a regular file");
  });

  it("rejects a database file with a link count other than one", async () => {
    const coordinator = realCoordinator();
    const dbPath = piWebUiConfigMutationDatabasePath(configPath, realpathSync(dataDir));
    writeFileSync(dbPath, "not sqlite");
    linkSync(dbPath, join(tempDir, "db-hardlink"));

    await expect(coordinator.read()).rejects.toThrow("PI WEBUI config mutation database must not have hard links");
  });

  it.skipIf(process.platform === "win32")("tightens an accepted existing database to 0600 before opening", async () => {
    const coordinator = realCoordinator();
    const dbPath = piWebUiConfigMutationDatabasePath(configPath, realpathSync(dataDir));
    const seeded = new DatabaseSync(dbPath);
    seeded.exec("CREATE TABLE seeded (id INTEGER PRIMARY KEY)");
    seeded.close();
    chmodSync(dbPath, 0o644);

    await coordinator.read();

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });
});

describe("config mutation coordinator real-process probe", () => {
  it("serializes two real processes through SQLite and recovers after holder death", { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-webui-config-probe-"));
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const workerDir = join(dir, "workers");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "holder.mts"), holderWorkerSource(srcDir));
    writeFileSync(join(workerDir, "contender.mts"), contenderWorkerSource(srcDir));
    writeFileSync(join(workerDir, "unlocked.mts"), unlockedWriterWorkerSource(srcDir));
    const probeDataDir = join(dir, "data");
    mkdirSync(probeDataDir, { recursive: true, mode: 0o700 });

    const children: ChildProcess[] = [];
    const spawnWorker = (worker: string, args: readonly string[]): ChildProcess => {
      const child = spawn(process.execPath, ["--import", "tsx/esm", join(workerDir, worker), ...args], { stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => process.stderr.write(`[probe ${worker}] ${chunk}`));
      return child;
    };

    try {
      await withinDeadline(60_000, async () => {
        // Case 1: B reports contention against A's open transaction, then
        // merges A's committed key after A is released through stdin.
        const case1Config = join(dir, "case1.json");
        const a = spawnWorker("holder.mts", [case1Config, probeDataDir]);
        const aLines = workerLineWaiter(a);
        await aLines.waitFor("A:INSIDE");

        const b = spawnWorker("contender.mts", [case1Config, probeDataDir]);
        const bLines = workerLineWaiter(b);
        await bLines.waitFor("B:CONTENTION");

        a.stdin?.write("\n");
        await aLines.waitFor("A:COMMITTED");
        const bCommitted = await bLines.waitFor("B:COMMITTED");
        expect(JSON.parse(bCommitted.slice("B:COMMITTED:".length))).toMatchObject({ port: 9001, maxUploadBytes: 2345 });
        expect(JSON.parse(readFileSync(case1Config, "utf8"))).toEqual({ port: 9001, maxUploadBytes: 2345 });

        // Case 2: A is killed while holding the transaction; B recovers from
        // SQLite journal recovery without any stale-lock cleanup.
        const case2Config = join(dir, "case2.json");
        const a2 = spawnWorker("holder.mts", [case2Config, probeDataDir]);
        const a2Lines = workerLineWaiter(a2);
        await a2Lines.waitFor("A:INSIDE");

        const b2 = spawnWorker("contender.mts", [case2Config, probeDataDir]);
        const b2Lines = workerLineWaiter(b2);
        await b2Lines.waitFor("B:CONTENTION");

        a2.kill("SIGKILL");
        await a2Lines.exited();
        a2.stdin?.end();
        const b2Committed = await b2Lines.waitFor("B:COMMITTED");
        expect(JSON.parse(b2Committed.slice("B:COMMITTED:".length))).toEqual({ maxUploadBytes: 2345 });
        expect(JSON.parse(readFileSync(case2Config, "utf8"))).toEqual({ maxUploadBytes: 2345 });

        // No-lock control: both writers load the old snapshot behind a barrier
        // before ordered writes, so the later write demonstrably loses the
        // earlier key.
        const controlConfig = join(dir, "control.json");
        const c1 = spawnWorker("unlocked.mts", [controlConfig, "c1"]);
        const c1Lines = workerLineWaiter(c1);
        await c1Lines.waitFor("c1:LOADED");
        const c2 = spawnWorker("unlocked.mts", [controlConfig, "c2"]);
        const c2Lines = workerLineWaiter(c2);
        await c2Lines.waitFor("c2:LOADED");

        c1.stdin?.write("\n");
        await c1Lines.waitFor("c1:SAVED");
        c2.stdin?.write("\n");
        await c2Lines.waitFor("c2:SAVED");

        expect(JSON.parse(readFileSync(controlConfig, "utf8"))).toEqual({ maxUploadBytes: 2345 });
        expect(loadPiWebUiConfig({ env: { PI_WEBUI_CONFIG: controlConfig } }).config.port).toBeUndefined();
      });
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

interface FakeLockStateStore {
  state: PiWebUiConfigLockState | undefined;
  beginErrors: Error[];
}

class FakeLockDatabase implements PiWebUiConfigLockDatabase {
  beginImmediateCalls = 0;
  commitCalls = 0;
  rollbackCalls = 0;
  closeCalls = 0;

  constructor(private readonly store: FakeLockStateStore) {}

  beginImmediate(): void {
    this.beginImmediateCalls += 1;
    const error = this.store.beginErrors.shift();
    if (error !== undefined) throw error;
  }

  readState(): PiWebUiConfigLockState | undefined {
    return this.store.state;
  }

  writeState(state: PiWebUiConfigLockState): void {
    this.store.state = state;
  }

  commit(): void {
    this.commitCalls += 1;
  }

  rollback(): void {
    this.rollbackCalls += 1;
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function requireDb(dbs: FakeLockDatabase[], index: number): FakeLockDatabase {
  const db = dbs[index];
  if (db === undefined) throw new Error(`expected fake database at index ${String(index)}`);
  return db;
}

interface FakeHarness {
  coordinator: PiWebUiConfigMutationCoordinator;
  dbs: FakeLockDatabase[];
  store: FakeLockStateStore;
  retryCount(): number;
  fakeNow(): number;
  rewindState(state: PiWebUiConfigLockState): void;
}

let revisionCounter = 0;

function fakeHarness(overrides: {
  env?: NodeJS.ProcessEnv;
  beginErrors?: Error[];
  retryAdvanceMs?: number;
  readFileIdentity?: (path: string) => PiWebUiConfigFileIdentity;
} = {}): FakeHarness {
  let fakeNow = 0;
  let retryCount = 0;
  const store: FakeLockStateStore = { state: undefined, beginErrors: [...(overrides.beginErrors ?? [])] };
  const dbs: FakeLockDatabase[] = [];
  const coordinator = createPiWebUiConfigMutationCoordinator({
    config: { env: overrides.env ?? { PI_WEBUI_CONFIG: configPath } },
    dataDir,
    now: () => fakeNow,
    scheduleRetry: (callback) => {
      retryCount += 1;
      fakeNow += overrides.retryAdvanceMs ?? 0;
      callback();
      return () => undefined;
    },
    openDatabase: () => {
      const db = new FakeLockDatabase(store);
      dbs.push(db);
      return db;
    },
    ...(overrides.readFileIdentity === undefined ? {} : { readFileIdentity: overrides.readFileIdentity }),
    createRevision: () => `revision-${String(++revisionCounter)}`,
  });
  return {
    coordinator,
    dbs,
    store,
    retryCount: () => retryCount,
    fakeNow: () => fakeNow,
    rewindState: (state: PiWebUiConfigLockState) => {
      store.state = state;
    },
  };
}

function realCoordinator(): PiWebUiConfigMutationCoordinator {
  return createPiWebUiConfigMutationCoordinator({
    config: { env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_DATA_DIR: dataDir } },
  });
}

function busyError(): Error {
  return Object.assign(new Error("database is locked"), { errcode: 5 });
}

async function withinDeadline<T>(deadlineMs: number, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`two-process probe exceeded its ${String(deadlineMs)}ms deadline`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface WorkerLineWaiter {
  waitFor(line: string): Promise<string>;
  exited(): Promise<[number | null, NodeJS.Signals | null]>;
}

function workerLineWaiter(child: ChildProcess): WorkerLineWaiter {
  let buffer = "";
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const received = new Set<string>();
  const waiters: { line: string; resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trimEnd();
      buffer = buffer.slice(index + 1);
      received.add(line);
      for (const waiter of [...waiters]) {
        if (line.startsWith(waiter.line)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    }
  });
  child.once("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });
  // Stdio data events are fully flushed before 'close', so a worker that
  // prints a milestone and exits immediately can never lose it to an exit
  // race; only genuinely missing lines reject here.
  child.once("close", () => {
    const pendingLines = waiters.map((waiter) => waiter.line).join(", ");
    const error = new Error(`worker exited prematurely (code ${String(exitCode)}, signal ${String(exitSignal)}) while waiting for [${pendingLines}]; saw [${[...received].join(", ")}]`);
    for (const waiter of [...waiters]) waiter.reject(error);
    waiters.length = 0;
  });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve([code, signal]);
    });
  });
  return {
    waitFor: (line) => {
      const existing = [...received].find((seen) => seen.startsWith(line));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<string>((resolve, reject) => waiters.push({ line, resolve, reject }));
    },
    exited: () => exited,
  };
}

function holderWorkerSource(srcDir: string): string {
  return `import { readSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { createPiWebUiConfigMutationCoordinator } = await import(pathToFileURL(join(${JSON.stringify(srcDir)}, "configMutationCoordinator.ts")).href);
const configPath = process.argv[2];
const dataDir = process.argv[3];
const coordinator = createPiWebUiConfigMutationCoordinator({
  config: { env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_DATA_DIR: dataDir } },
});
const snapshot = await coordinator.mutate((current) => {
  process.stdout.write("A:INSIDE\\n");
  const buffer = Buffer.alloc(1);
  readSync(0, buffer, 0, 1, null);
  return { ...current.loaded.config, port: 9001 };
});
process.stdout.write("A:COMMITTED:" + JSON.stringify(snapshot.loaded.config) + "\\n");
`;
}

function contenderWorkerSource(srcDir: string): string {
  return `import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { createPiWebUiConfigMutationCoordinator } = await import(pathToFileURL(join(${JSON.stringify(srcDir)}, "configMutationCoordinator.ts")).href);
const configPath = process.argv[2];
const dataDir = process.argv[3];
let reported = false;
const coordinator = createPiWebUiConfigMutationCoordinator({
  config: { env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_DATA_DIR: dataDir } },
  scheduleRetry: (callback, delayMs) => {
    if (!reported) {
      reported = true;
      process.stdout.write("B:CONTENTION\\n");
    }
    return setTimeout(callback, delayMs);
  },
});
const snapshot = await coordinator.mutate((current) => ({ ...current.loaded.config, maxUploadBytes: 2345 }));
process.stdout.write("B:COMMITTED:" + JSON.stringify(snapshot.loaded.config) + "\\n");
`;
}

function unlockedWriterWorkerSource(srcDir: string): string {
  return `import { readSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { loadPiWebUiConfig, savePiWebUiConfig } = await import(pathToFileURL(join(${JSON.stringify(srcDir)}, "config.ts")).href);
const configPath = process.argv[2];
const key = process.argv[3];
const loaded = loadPiWebUiConfig({ env: { PI_WEBUI_CONFIG: configPath } });
process.stdout.write(key + ":LOADED\\n");
const buffer = Buffer.alloc(1);
readSync(0, buffer, 0, 1, null);
const next = key === "c1"
  ? { ...loaded.config, port: 9001 }
  : { ...loaded.config, maxUploadBytes: 2345 };
savePiWebUiConfig(next, { env: { PI_WEBUI_CONFIG: configPath } });
process.stdout.write(key + ":SAVED\\n");
`;
}
