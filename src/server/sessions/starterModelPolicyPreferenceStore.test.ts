import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultStarterModelPolicyPreferenceFilePath,
  FileStarterModelPolicyPreferencePersistence,
  StarterModelPolicyPreferenceStore,
  type StarterModelPolicyPreferencePersistence,
} from "./starterModelPolicyPreferenceStore.js";

const temporaryRoots: string[] = [];
const invalidPreferenceFiles: readonly (readonly [string, unknown])[] = [
  ["an unsupported version", { version: 2, workspaces: {} }],
  ["missing workspaces", { version: 1 }],
  ["array workspaces", { version: 1, workspaces: [] }],
  ["an unknown root field", { version: 1, workspaces: {}, extra: true }],
  ["a relative workspace key", {
    version: 1,
    workspaces: { relative: { mode: "exact" } },
  }],
  ["an unknown preference field", {
    version: 1,
    workspaces: { [resolve("/workspace")]: { mode: "exact", extra: true } },
  }],
  ["an unknown mode", {
    version: 1,
    workspaces: { [resolve("/workspace")]: { mode: "automatic" } },
  }],
  ["an unknown tier", {
    version: 1,
    workspaces: { [resolve("/workspace")]: { mode: "tiered", tier: "unlimited" } },
  }],
  ["Tiered without a tier", {
    version: 1,
    workspaces: { [resolve("/workspace")]: { mode: "tiered" } },
  }],
];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("starter model policy preference store", () => {
  it("uses PI_WEBUI_DATA_DIR for the managed preference file", () => {
    expect(defaultStarterModelPolicyPreferenceFilePath(
      { PI_WEBUI_DATA_DIR: "managed-state" },
      "/tmp/pi-webui",
    )).toBe(resolve(
      "/tmp/pi-webui",
      "managed-state",
      "starter-model-policy-preferences.json",
    ));
  });

  it("round-trips independent workspace preferences and remembers a tier in Exact", async () => {
    const root = await temporaryRoot();
    const filePath = join(root, "preferences.json");
    const store = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(filePath),
    );
    const main = resolve(root, "main");
    const feature = resolve(root, "feature");

    await store.replace(main, { mode: "exact", tier: "advanced" });
    await store.replace(feature, { mode: "tiered", tier: "frontier" });

    await expect(store.inspect(main)).resolves.toEqual({
      kind: "valid",
      preference: { mode: "exact", tier: "advanced" },
    });
    await expect(store.inspect(feature)).resolves.toEqual({
      kind: "valid",
      preference: { mode: "tiered", tier: "frontier" },
    });
    await expect(store.inspect(resolve(root, "missing"))).resolves.toEqual({ kind: "absent" });
  });

  it.each(invalidPreferenceFiles)("reports invalid persisted data with %s", async (_label, persisted) => {
    const root = await temporaryRoot();
    const filePath = join(root, "preferences.json");
    await writeFile(filePath, JSON.stringify(persisted), "utf8");
    const store = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(filePath),
    );

    const stringReason: unknown = expect.any(String);
    await expect(store.inspect(resolve("/workspace"))).resolves.toEqual({
      kind: "invalid",
      reason: stringReason,
    });
  });

  it("serializes the complete read-modify-write transaction", async () => {
    const persistence = new BlockingPersistence();
    const store = new StarterModelPolicyPreferenceStore(persistence);
    const workspaceA = resolve("/workspace-a");
    const workspaceB = resolve("/workspace-b");
    const first = store.replace(workspaceA, { mode: "exact", tier: "fast" });
    await persistence.firstSaveStarted;

    const second = store.replace(workspaceB, { mode: "tiered", tier: "advanced" });
    expect(persistence.loadCalls).toBe(1);
    expect(persistence.saveCalls).toBe(1);

    persistence.releaseFirstSave();
    await Promise.all([first, second]);

    expect(persistence.maximumConcurrentSaves).toBe(1);
    expect(persistence.value).toMatchObject({
      version: 1,
      workspaces: {
        [workspaceA]: { mode: "exact", tier: "fast" },
        [workspaceB]: { mode: "tiered", tier: "advanced" },
      },
    });
  });

  it("writes a private atomic file without leftover temporary files", async () => {
    const root = await temporaryRoot();
    const filePath = join(root, "state", "preferences.json");
    const store = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(filePath),
    );
    await store.replace(resolve(root, "workspace"), { mode: "tiered", tier: "standard" });

    const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted).toMatchObject({ version: 1 });
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(filePath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the previous file unchanged and cleans up when atomic replacement fails", async () => {
    const root = await temporaryRoot();
    const filePath = join(root, "state", "preferences.json");
    const workspace = resolve(root, "workspace");
    const initialStore = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(filePath),
    );
    await initialStore.replace(workspace, { mode: "exact", tier: "advanced" });
    const original = await readFile(filePath, "utf8");
    const failingStore = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(
        filePath,
        () => Promise.reject(new Error("rename failed")),
      ),
    );

    await expect(failingStore.replace(workspace, { mode: "tiered", tier: "frontier" }))
      .rejects.toThrow("rename failed");

    await expect(readFile(filePath, "utf8")).resolves.toBe(original);
    expect((await readdir(dirname(filePath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("continues serialized replacements after a failed save", async () => {
    const persistence = new FailOncePersistence();
    const store = new StarterModelPolicyPreferenceStore(persistence);
    const workspace = resolve("/workspace");

    await expect(store.replace(workspace, { mode: "exact", tier: "fast" }))
      .rejects.toThrow("transient save failure");
    await store.replace(workspace, { mode: "tiered", tier: "advanced" });

    expect(persistence.saveCalls).toBe(2);
    expect(persistence.value).toMatchObject({
      version: 1,
      workspaces: { [workspace]: { mode: "tiered", tier: "advanced" } },
    });
  });
});

class BlockingPersistence implements StarterModelPolicyPreferencePersistence {
  loadCalls = 0;
  saveCalls = 0;
  maximumConcurrentSaves = 0;
  value: unknown = undefined;
  readonly firstSaveStarted: Promise<void>;
  private concurrentSaves = 0;
  private readonly firstSaveStartedDeferred = deferred();
  private readonly firstSaveRelease = deferred();

  constructor() {
    this.firstSaveStarted = this.firstSaveStartedDeferred.promise;
  }

  load(): Promise<unknown> {
    this.loadCalls += 1;
    return Promise.resolve(structuredClone(this.value));
  }

  async save(value: unknown): Promise<void> {
    this.saveCalls += 1;
    this.concurrentSaves += 1;
    this.maximumConcurrentSaves = Math.max(this.maximumConcurrentSaves, this.concurrentSaves);
    try {
      if (this.saveCalls === 1) {
        this.firstSaveStartedDeferred.resolve();
        await this.firstSaveRelease.promise;
      }
      this.value = structuredClone(value);
    } finally {
      this.concurrentSaves -= 1;
    }
  }

  releaseFirstSave(): void {
    this.firstSaveRelease.resolve();
  }
}

class FailOncePersistence implements StarterModelPolicyPreferencePersistence {
  saveCalls = 0;
  value: unknown = undefined;

  load(): Promise<unknown> {
    return Promise.resolve(structuredClone(this.value));
  }

  save(value: unknown): Promise<void> {
    this.saveCalls += 1;
    if (this.saveCalls === 1) return Promise.reject(new Error("transient save failure"));
    this.value = structuredClone(value);
    return Promise.resolve();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-webui-starter-model-policy-"));
  temporaryRoots.push(root);
  return root;
}
