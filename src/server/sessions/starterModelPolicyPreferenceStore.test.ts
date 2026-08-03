import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StarterModelPolicyPreference } from "../../shared/apiTypes.js";
import {
  defaultStarterModelPolicyPreferenceFilePath,
  FileStarterModelPolicyPreferencePersistence,
  StarterModelPolicyPreferenceStore,
  type StarterModelPolicyPreferencePersistence,
  type StarterPreferenceWrite,
} from "./starterModelPolicyPreferenceStore.js";

const temporaryRoots: string[] = [];
const fullPreference: StarterModelPolicyPreference = {
  mode: "tiered",
  exact: {
    model: { provider: "acme", id: "reasoner" },
    thinkingLevel: "high",
  },
  tier: "frontier",
};
const invalidPreferenceFiles: readonly (readonly [string, unknown])[] = [
  ["an unsupported version", { version: 3, workspaces: {} }],
  ["missing workspaces", { version: 1 }],
  ["array workspaces", { version: 1, workspaces: [] }],
  ["an unknown version-one root field", { version: 1, workspaces: {}, extra: true }],
  ["an unknown version-two root field", { version: 2, workspaces: {}, extra: true }],
  ["a relative workspace key", {
    version: 1,
    workspaces: { relative: { mode: "exact" } },
  }],
  ["a malformed version-one entry", {
    version: 1,
    workspaces: { [resolve("/workspace")]: "exact" },
  }],
  ["an unknown version-one preference field", {
    version: 1,
    workspaces: { [resolve("/workspace")]: { mode: "exact", extra: true } },
  }],
  ["an unknown version-one mode", {
    version: 1,
    workspaces: { [resolve("/workspace")]: { mode: "automatic" } },
  }],
  ["a non-canonical version-one tier", {
    version: 1,
    workspaces: { [resolve("/workspace")]: { mode: "tiered", tier: "unlimited" } },
  }],
  ["version-one Tiered without a tier", {
    version: 1,
    workspaces: { [resolve("/workspace")]: { mode: "tiered" } },
  }],
  ["a malformed version-two entry", {
    version: 2,
    workspaces: { [resolve("/workspace")]: "full" },
  }],
  ["an unknown version-two entry field", {
    version: 2,
    workspaces: {
      [resolve("/workspace")]: { kind: "legacy-v1", preference: { mode: "exact" }, extra: true },
    },
  }],
  ["an unknown version-two entry kind", {
    version: 2,
    workspaces: {
      [resolve("/workspace")]: { kind: "future", preference: { mode: "exact" } },
    },
  }],
  ["a malformed version-two legacy entry", {
    version: 2,
    workspaces: {
      [resolve("/workspace")]: { kind: "legacy-v1", preference: { mode: "tiered" } },
    },
  }],
  ["a full entry using preference instead of policy", {
    version: 2,
    workspaces: {
      [resolve("/workspace")]: { kind: "full", preference: fullPreference },
    },
  }],
  ["an unknown full policy field", {
    version: 2,
    workspaces: {
      [resolve("/workspace")]: {
        kind: "full",
        policy: { ...fullPreference, extra: true },
      },
    },
  }],
  ["a blank Exact provider", versionTwoFullPreference({
    ...fullPreference,
    exact: { ...fullPreference.exact, model: { provider: "  ", id: "reasoner" } },
  })],
  ["a blank Exact model id", versionTwoFullPreference({
    ...fullPreference,
    exact: { ...fullPreference.exact, model: { provider: "acme", id: "\t" } },
  })],
  ["a blank Exact thinking level", versionTwoFullPreference({
    ...fullPreference,
    exact: { ...fullPreference.exact, thinkingLevel: "" },
  })],
  ["version-two Tiered without a tier", versionTwoFullPreference({
    mode: "tiered",
    exact: fullPreference.exact,
  })],
  ["a non-canonical version-two tier", versionTwoFullPreference({
    ...fullPreference,
    tier: "unlimited",
  })],
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

  it("round-trips legacy and full workspace preferences", async () => {
    const root = await temporaryRoot();
    const filePath = join(root, "preferences.json");
    const store = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(filePath),
    );
    const legacy = resolve(root, "legacy");
    const full = resolve(root, "full");

    await store.replace(legacy, {
      kind: "legacy-v1",
      preference: { mode: "exact", tier: "advanced" },
    });
    await store.replace(full, { kind: "full", preference: fullPreference });

    await expect(store.inspect(legacy)).resolves.toEqual({
      kind: "legacy-v1",
      preference: { mode: "exact", tier: "advanced" },
    });
    await expect(store.inspect(full)).resolves.toEqual({
      kind: "full",
      preference: fullPreference,
    });
    await expect(store.inspect(resolve(root, "missing"))).resolves.toEqual({ kind: "absent" });
  });

  it("inspects version one without writing and migrates every workspace on the next replacement", async () => {
    const root = await temporaryRoot();
    const filePath = join(root, "preferences.json");
    const legacyExact = resolve(root, "legacy-exact");
    const legacyTiered = resolve(root, "legacy-tiered");
    const full = resolve(root, "full");
    const originalValue = {
      version: 1,
      workspaces: {
        [legacyExact]: { mode: "exact", tier: "advanced" },
        [legacyTiered]: { mode: "tiered", tier: "capable" },
      },
    };
    const originalBytes = `${JSON.stringify(originalValue, null, 2)}\n`;
    await writeFile(filePath, originalBytes, "utf8");
    const store = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(filePath),
    );

    await expect(store.inspect(legacyTiered)).resolves.toEqual({
      kind: "legacy-v1",
      preference: { mode: "tiered", tier: "capable" },
    });
    await expect(readFile(filePath, "utf8")).resolves.toBe(originalBytes);

    await store.replace(full, { kind: "full", preference: fullPreference });

    const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted).toEqual({
      version: 2,
      workspaces: {
        [legacyExact]: {
          kind: "legacy-v1",
          preference: { mode: "exact", tier: "advanced" },
        },
        [legacyTiered]: {
          kind: "legacy-v1",
          preference: { mode: "tiered", tier: "capable" },
        },
        [full]: { kind: "full", policy: fullPreference },
      },
    });
    if (!isRecord(persisted) || !isRecord(persisted["workspaces"])) {
      throw new Error("expected persisted workspaces");
    }
    expect(Object.keys(persisted["workspaces"]).sort())
      .toEqual([legacyExact, legacyTiered, full].sort());
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

  it("rejects a malformed tagged replacement before loading or saving", async () => {
    const persistence = new ReferencePersistence();
    const store = new StarterModelPolicyPreferenceStore(persistence);
    const malformed: StarterPreferenceWrite = {
      kind: "full",
      preference: {
        ...fullPreference,
        exact: { ...fullPreference.exact, thinkingLevel: " " },
      },
    };

    await expect(store.replace(resolve("/workspace"), malformed)).rejects.toThrow("thinking level");

    expect(persistence.loadCalls).toBe(0);
    expect(persistence.saveCalls).toBe(0);
  });

  it("clones full preference values at both store boundaries", async () => {
    const persistence = new ReferencePersistence();
    const store = new StarterModelPolicyPreferenceStore(persistence);
    const input = structuredClone(fullPreference);

    await store.replace(resolve("/workspace"), { kind: "full", preference: input });
    input.exact.model.id = "caller-mutation";
    const first = await store.inspect(resolve("/workspace"));
    expect(first).toEqual({ kind: "full", preference: fullPreference });
    if (first.kind !== "full") throw new Error("expected a full preference");

    first.preference.exact.model.id = "inspection-mutation";
    await expect(store.inspect(resolve("/workspace"))).resolves.toEqual({
      kind: "full",
      preference: fullPreference,
    });
  });

  it("serializes the complete read-modify-write transaction", async () => {
    const persistence = new BlockingPersistence();
    const store = new StarterModelPolicyPreferenceStore(persistence);
    const workspaceA = resolve("/workspace-a");
    const workspaceB = resolve("/workspace-b");
    const first = store.replace(workspaceA, {
      kind: "legacy-v1",
      preference: { mode: "exact", tier: "fast" },
    });
    await persistence.firstSaveStarted;

    const second = store.replace(workspaceB, {
      kind: "legacy-v1",
      preference: { mode: "tiered", tier: "advanced" },
    });
    expect(persistence.loadCalls).toBe(1);
    expect(persistence.saveCalls).toBe(1);

    persistence.releaseFirstSave();
    await Promise.all([first, second]);

    expect(persistence.maximumConcurrentSaves).toBe(1);
    expect(persistence.value).toEqual({
      version: 2,
      workspaces: {
        [workspaceA]: {
          kind: "legacy-v1",
          preference: { mode: "exact", tier: "fast" },
        },
        [workspaceB]: {
          kind: "legacy-v1",
          preference: { mode: "tiered", tier: "advanced" },
        },
      },
    });
  });

  it("writes a private atomic file without leftover temporary files", async () => {
    const root = await temporaryRoot();
    const filePath = join(root, "state", "preferences.json");
    const store = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(filePath),
    );
    await store.replace(resolve(root, "workspace"), {
      kind: "legacy-v1",
      preference: { mode: "tiered", tier: "standard" },
    });

    const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted).toMatchObject({ version: 2 });
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
    await initialStore.replace(workspace, {
      kind: "legacy-v1",
      preference: { mode: "exact", tier: "advanced" },
    });
    const original = await readFile(filePath, "utf8");
    const failingStore = new StarterModelPolicyPreferenceStore(
      new FileStarterModelPolicyPreferencePersistence(
        filePath,
        () => Promise.reject(new Error("rename failed")),
      ),
    );

    await expect(failingStore.replace(workspace, {
      kind: "full",
      preference: fullPreference,
    })).rejects.toThrow("rename failed");

    await expect(readFile(filePath, "utf8")).resolves.toBe(original);
    expect((await readdir(dirname(filePath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("continues serialized replacements after a failed save", async () => {
    const persistence = new FailOncePersistence();
    const store = new StarterModelPolicyPreferenceStore(persistence);
    const workspace = resolve("/workspace");

    await expect(store.replace(workspace, {
      kind: "legacy-v1",
      preference: { mode: "exact", tier: "fast" },
    })).rejects.toThrow("transient save failure");
    await store.replace(workspace, {
      kind: "full",
      preference: fullPreference,
    });

    expect(persistence.saveCalls).toBe(2);
    expect(persistence.value).toEqual({
      version: 2,
      workspaces: { [workspace]: { kind: "full", policy: fullPreference } },
    });
  });
});

class ReferencePersistence implements StarterModelPolicyPreferencePersistence {
  loadCalls = 0;
  saveCalls = 0;
  value: unknown = undefined;

  load(): Promise<unknown> {
    this.loadCalls += 1;
    return Promise.resolve(this.value);
  }

  save(value: unknown): Promise<void> {
    this.saveCalls += 1;
    this.value = value;
    return Promise.resolve();
  }
}

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

function versionTwoFullPreference(preference: unknown): unknown {
  return {
    version: 2,
    workspaces: {
      [resolve("/workspace")]: { kind: "full", policy: preference },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolvePromiseCallback) => {
    resolvePromise = resolvePromiseCallback;
  });
  return { promise, resolve: resolvePromise };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-webui-starter-model-policy-"));
  temporaryRoots.push(root);
  return root;
}
