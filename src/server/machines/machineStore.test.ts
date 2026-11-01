import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MachineStore } from "./machineStore.js";

const INVALID_REQUEST_TIMEOUT_MESSAGE = "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds";

const OLD_MACHINE_RECORD = {
  id: "old-remote",
  name: "Old Remote",
  kind: "remote",
  baseUrl: "https://old.example.test",
  token: "old-secret",
  createdAt: "2026-05-25T00:00:00.000Z",
  updatedAt: "2026-05-25T00:00:00.000Z",
};

let tempDir: string;
let registryPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-machine-store-test-"));
  registryPath = join(tempDir, "machines.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("MachineStore requestTimeoutMs persistence", () => {
  it("round trips an optional requestTimeoutMs without migrating old records", async () => {
    await writeRegistryFixture();
    const store = new MachineStore(registryPath);

    const [oldMachine] = await store.list();
    expect(oldMachine).not.toHaveProperty("requestTimeoutMs");

    const added = await store.add({ name: "Remote Lab", baseUrl: "https://remote.example.test/base", requestTimeoutMs: 5_000 });
    expect(added.requestTimeoutMs).toBe(5_000);
    const updated = await store.update(added.id, { requestTimeoutMs: 180_000 });
    expect(updated?.requestTimeoutMs).toBe(180_000);

    const reopened = new MachineStore(registryPath);
    const machines = await reopened.list();
    const reopenedAdded = machines.find((machine) => machine.id === added.id);
    const reopenedOld = machines.find((machine) => machine.id === OLD_MACHINE_RECORD.id);
    expect(reopenedAdded?.requestTimeoutMs).toBe(180_000);
    expect(reopenedAdded).not.toHaveProperty("token");
    expect(reopenedOld).not.toHaveProperty("requestTimeoutMs");
    expect(reopenedOld?.token).toBe("old-secret");

    const persisted = await readPersistedMachines();
    const persistedAdded = persisted.find((machine) => machine["id"] === added.id);
    const persistedOld = persisted.find((machine) => machine["id"] === OLD_MACHINE_RECORD.id);
    expect(persistedAdded?.["requestTimeoutMs"]).toBe(180_000);
    expect(persistedOld).toBeDefined();
    expect(Object.hasOwn(persistedOld ?? {}, "requestTimeoutMs")).toBe(false);
  });

  it("keeps an omitted requestTimeoutMs and adds one to a record that never had it", async () => {
    await writeRegistryFixture();
    const store = new MachineStore(registryPath);
    const added = await store.add({ name: "Remote Lab", baseUrl: "https://remote.example.test", requestTimeoutMs: 60_000 });

    const renamed = await store.update(added.id, { name: "Renamed Lab" });
    expect(renamed?.requestTimeoutMs).toBe(60_000);

    const updatedOld = await store.update(OLD_MACHINE_RECORD.id, { requestTimeoutMs: 5_000 });
    expect(updatedOld?.requestTimeoutMs).toBe(5_000);

    const reopened = await new MachineStore(registryPath).list();
    expect(reopened.find((machine) => machine.id === added.id)?.requestTimeoutMs).toBe(60_000);
    expect(reopened.find((machine) => machine.id === OLD_MACHINE_RECORD.id)?.requestTimeoutMs).toBe(5_000);
  });

  it.each<[string, unknown]>([
    ["a string", "120000"],
    ["a non-integer", 120_000.5],
    ["below the minimum", 4_999],
    ["above the maximum", 180_001],
    ["null", null],
    ["a boolean", true],
  ])("rejects a stored requestTimeoutMs that is %s", async (_label, requestTimeoutMs) => {
    await writeRegistryFixture({ requestTimeoutMs });
    const store = new MachineStore(registryPath);

    await expect(store.list()).rejects.toThrow(INVALID_REQUEST_TIMEOUT_MESSAGE);
  });

  it("rejects an own-property undefined requestTimeoutMs before writing", async () => {
    const store = new MachineStore(registryPath);
    const added = await store.add({ name: "Remote Lab", baseUrl: "https://remote.example.test" });
    const before = await readFile(registryPath, "utf8");

    const addInput = withOwnUndefinedRequestTimeout<Parameters<MachineStore["add"]>[0]>({ name: "Other", baseUrl: "https://other.example.test" });
    await expect(store.add(addInput)).rejects.toThrow(INVALID_REQUEST_TIMEOUT_MESSAGE);
    const patch = withOwnUndefinedRequestTimeout<Parameters<MachineStore["update"]>[1]>({});
    await expect(store.update(added.id, patch)).rejects.toThrow(INVALID_REQUEST_TIMEOUT_MESSAGE);

    await expect(readFile(registryPath, "utf8")).resolves.toBe(before);
    await expect(store.list()).resolves.toHaveLength(1);
    expect((await store.list())[0]).not.toHaveProperty("requestTimeoutMs");
  });
});

async function writeRegistryFixture(record: Record<string, unknown> = {}): Promise<void> {
  await writeFile(registryPath, `${JSON.stringify({ machines: [{ ...OLD_MACHINE_RECORD, ...record }] }, null, 2)}\n`, "utf8");
}

async function readPersistedMachines(): Promise<Record<string, unknown>[]> {
  const parsed: unknown = JSON.parse(await readFile(registryPath, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed["machines"])) throw new Error("Invalid persisted machine fixture");
  return parsed["machines"].filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withOwnUndefinedRequestTimeout<T extends object>(value: T): T {
  Object.defineProperty(value, "requestTimeoutMs", { value: undefined, enumerable: true });
  return value;
}
