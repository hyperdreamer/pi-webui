import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner";
import { createFakeModelRateLimitClock, fixtureIdentity, fixtureTerminalMessage } from "../rateLimits/modelRateLimit.testSupport";
import { ModelsConfigService, validateModelsConfigDraftShape } from "./modelsConfigService";

const tempDirs: string[] = [];
const identity = fixtureIdentity("acme", "demo");

const EMPTY_DOCUMENT = { providers: {} };
const LIMITED_DOCUMENT = { providers: { acme: { models: [{ id: "demo", tpm: 50 }] } } };

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ModelsConfigService rate limit lifecycle", () => {
  it("reads a missing models.json as an empty document and publishes missing-file at startup", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    const models = new ModelsConfigService({ agentDir, rateLimits });

    await models.initialize();

    await expect(models.read()).resolves.toEqual(EMPTY_DOCUMENT);
    expect(rateLimits.readStatus()).toEqual({ revision: 1, admission: "ready", source: "missing-file" });
  });

  it("reports a parse failure without substituting an empty document", async () => {
    const agentDir = await temporaryAgentDir();
    await writeFile(join(agentDir, "models.json"), "{ not json", "utf8");
    const { rateLimits } = ownerWithClock();
    const models = new ModelsConfigService({ agentDir, rateLimits });

    await models.initialize();

    await expect(models.read()).rejects.toMatchObject({ code: "MODELS_CONFIG_PARSE_FAILED" });
    expect(rateLimits.readStatus()).toMatchObject({ revision: 0, admission: "blocked", source: "none" });
  });

  it("keeps an invalid-limits document readable while rejecting its snapshot", async () => {
    const agentDir = await temporaryAgentDir();
    const document = { providers: { acme: { models: [{ id: "demo", tpm: "bad" }] } } };
    await writeDocument(agentDir, document);
    const { rateLimits } = ownerWithClock();
    const models = new ModelsConfigService({ agentDir, rateLimits });

    await models.initialize();

    await expect(models.read()).resolves.toEqual(document);
    expect(rateLimits.readStatus()).toMatchObject({ revision: 0, admission: "blocked" });
  });

  it("rejects save shape and limit failures with structured details and no write", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    const models = new ModelsConfigService({ agentDir, rateLimits });

    await expect(models.save({ providers: { acme: { models: [{ id: 5 }] } } })).rejects.toMatchObject({
      code: "MODELS_CONFIG_SAVE_INVALID",
    });
    await expect(models.save({ providers: { acme: { models: [{ id: "demo", prm: -1 }] } } })).rejects.toMatchObject({
      code: "MODELS_CONFIG_INVALID_LIMITS",
      details: { provider: "acme", modelId: "demo", field: "prm", reason: "negative", occurrence: 0 },
    });
    await expect(readFile(join(agentDir, "models.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to save over an unreadable on-disk file", async () => {
    const agentDir = await temporaryAgentDir();
    await writeFile(join(agentDir, "models.json"), "{ broken", "utf8");
    const models = new ModelsConfigService({ agentDir });

    await expect(models.save(EMPTY_DOCUMENT)).rejects.toMatchObject({ code: "MODELS_CONFIG_UNREADABLE" });
    expect(await readFile(join(agentDir, "models.json"), "utf8")).toBe("{ broken");
  });

  it("writes through a sibling temporary file with rename and preserves a restricted mode", async () => {
    const agentDir = await temporaryAgentDir();
    const modelsPath = join(agentDir, "models.json");
    await writeFile(modelsPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    const models = new ModelsConfigService({ agentDir });

    await expect(models.save(LIMITED_DOCUMENT)).resolves.toEqual({ success: true, contractVersion: 1 });

    expect((await stat(modelsPath)).mode & 0o7777).toBe(0o600);
    expect(await readFile(modelsPath, "utf8")).toBe(`${JSON.stringify(LIMITED_DOCUMENT, null, 2)}\n`);
    expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("updates a symlinked target instead of replacing the link", async () => {
    const agentDir = await temporaryAgentDir();
    const realDir = await temporaryAgentDir();
    const realPath = join(realDir, "real-models.json");
    await writeFile(realPath, "{}\n", "utf8");
    await symlink(realPath, join(agentDir, "models.json"));
    const models = new ModelsConfigService({ agentDir });

    await models.save(LIMITED_DOCUMENT);

    expect(await readFile(realPath, "utf8")).toContain("demo");
    expect((await lstat(join(agentDir, "models.json"))).isSymbolicLink()).toBe(true);
  });

  it("rejects a hard-linked target before creating a temporary file", async () => {
    const agentDir = await temporaryAgentDir();
    const otherDir = await temporaryAgentDir();
    const modelsPath = join(agentDir, "models.json");
    await writeFile(modelsPath, "{}\n", "utf8");
    await link(modelsPath, join(otherDir, "models.json"));
    const models = new ModelsConfigService({ agentDir });

    await expect(models.save(LIMITED_DOCUMENT)).rejects.toMatchObject({ code: "MODELS_CONFIG_PERSIST_FAILED" });
    expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps active limits when persistence fails", async () => {
    const agentDir = await temporaryAgentDir();
    const otherDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    await writeDocument(agentDir, LIMITED_DOCUMENT);
    const models = new ModelsConfigService({ agentDir, rateLimits });
    await models.initialize();
    const before = rateLimits.readStatus();
    await link(join(agentDir, "models.json"), join(otherDir, "models.json"));

    await expect(models.save({ providers: { acme: { models: [{ id: "demo", tpm: 10 }] } } })).rejects.toMatchObject({
      code: "MODELS_CONFIG_PERSIST_FAILED",
    });

    expect(rateLimits.readStatus()).toEqual(before);
  });

  it("reports a narrow refresh failure with persisted true and keeps last-known-good", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    await writeDocument(agentDir, EMPTY_DOCUMENT);
    const modelRuntime = {
      refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
      getError: () => "Failed to parse models.json: bad",
    };
    const models = new ModelsConfigService({ agentDir, modelRuntime, rateLimits });
    await models.initialize();

    await expect(models.save(LIMITED_DOCUMENT)).rejects.toMatchObject({
      code: "MODELS_CONFIG_REFRESH_FAILED",
      details: { persisted: true },
    });

    expect(await readFile(join(agentDir, "models.json"), "utf8")).toContain('"tpm": 50');
    expect(rateLimits.readStatus()).toMatchObject({ admission: "ready", source: "last-known-good" });
    expect(rateLimits.readStatus().error).toContain("Failed to parse models.json:");
  });

  it("ignores transient availability and catalog errors during refresh validation", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    await writeDocument(agentDir, EMPTY_DOCUMENT);
    const modelRuntime = {
      refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map([["acme", new Error("catalog down")]]) }),
      getError: () => "Availability refresh: acme failed\nCredential check failed for acme",
    };
    const models = new ModelsConfigService({ agentDir, modelRuntime, rateLimits });
    await models.initialize();

    await expect(models.save(LIMITED_DOCUMENT)).resolves.toEqual({ success: true, contractVersion: 1, revision: 2 });
    expect(rateLimits.readStatus()).toEqual({ revision: 2, admission: "ready", source: "accepted-document" });
  });

  it("publishes a higher revision and wakes waiters after a successful save", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    const modelRuntime = { refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }), getError: () => undefined };
    const models = new ModelsConfigService({ agentDir, modelRuntime, rateLimits });
    await models.initialize();
    await models.save({ providers: { acme: { models: [{ id: "demo", tpm: 1, prm: 1 }] } } });
    await rateLimits.acquire(identity);
    rateLimits.completeCall(identity, { input: 1 });
    const queued = rateLimits.acquire(identity);
    expect(rateLimits.pendingWaiterCount(identity)).toBe(1);

    await models.save({ providers: { acme: { models: [{ id: "demo", tpm: 100, prm: 5 }] } } });

    await expect(queued).resolves.toEqual({ status: "granted" });
    expect(rateLimits.readStatus().revision).toBe(3);
  });

  it("serializes saves so an older save cannot publish over a newer one", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    let releaseRefresh: (() => void) | undefined;
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 1) await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      return { aborted: false, errors: new Map() };
    });
    const modelRuntime = { refresh, getError: () => undefined };
    const models = new ModelsConfigService({ agentDir, modelRuntime, rateLimits });

    const first = models.save({ providers: { acme: { models: [{ id: "demo", tpm: 10 }] } } });
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1); });
    const second = models.save({ providers: { acme: { models: [{ id: "demo", tpm: 20 }] } } });
    expect(refresh).toHaveBeenCalledTimes(1);
    releaseRefresh?.();

    await expect(first).resolves.toEqual({ success: true, contractVersion: 1, revision: 1 });
    await expect(second).resolves.toEqual({ success: true, contractVersion: 1, revision: 2 });
    expect(await readFile(join(agentDir, "models.json"), "utf8")).toContain('"tpm": 20');
    expect(rateLimits.readStatus()).toEqual({ revision: 2, admission: "ready", source: "accepted-document" });
  });

  it("charges a connection test against saved limits and never publishes draft values", async () => {
    const agentDir = await temporaryAgentDir();
    const { clock, rateLimits } = ownerWithClock();
    await writeDocument(agentDir, {
      providers: { acme: { api: "openai-completions", baseUrl: "https://api.example.test/v1", apiKey: "test-key", models: [{ id: "demo", prm: 1 }] } },
    });
    const connectionModel = {
      id: "demo",
      name: "Demo",
      api: "openai-completions" as const,
      provider: "acme",
      baseUrl: "https://api.example.test/v1",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    };
    const completeSimple = vi.fn(() => Promise.resolve(fixtureTerminalMessage({ api: "openai-completions", provider: "acme", model: "demo" })));
    const models = new ModelsConfigService({
      agentDir,
      rateLimits,
      createConnectionRuntime: () => Promise.resolve({
        getError: () => undefined,
        getModel: () => connectionModel,
        getAuth: () => Promise.resolve({ auth: { apiKey: "test-key" } }),
        completeSimple,
      }),
    });
    await models.initialize();
    await rateLimits.acquire(identity);

    const testPromise = models.test({
      providerName: "acme",
      provider: { api: "openai-completions", baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      model: { id: "demo", tpm: 999_999 },
    });
    await vi.waitFor(() => { expect(rateLimits.pendingWaiterCount(identity)).toBe(1); });
    expect(completeSimple).not.toHaveBeenCalled();

    clock.advance(60_000);
    await expect(testPromise).resolves.toMatchObject({ ok: true });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(rateLimits.readStatus().revision).toBe(1);
    expect(await readFile(join(agentDir, "models.json"), "utf8")).not.toContain("999999");
  });

  it("never throws from initialize when models.json cannot be read", async () => {
    const agentDir = await temporaryAgentDir();
    await mkdir(join(agentDir, "models.json"));
    const { rateLimits } = ownerWithClock();
    const logger = { warn: vi.fn() };
    const models = new ModelsConfigService({ agentDir, rateLimits, logger });

    await expect(models.initialize()).resolves.toBeUndefined();

    expect(rateLimits.readStatus().admission).toBe("blocked");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("validates the shared draft shape without dropping unknown fields", () => {
    expect(validateModelsConfigDraftShape(null)).toEqual({ ok: false, message: "models.json must be a JSON object" });
    expect(validateModelsConfigDraftShape({ providers: [] })).toEqual({ ok: false, message: "models.json providers must be an object" });
    expect(validateModelsConfigDraftShape({ providers: { acme: { models: "no" } } })).toEqual({
      ok: false,
      message: 'models.json provider "acme" models must be an array',
    });
    expect(validateModelsConfigDraftShape({ providers: { acme: { models: [{ id: 5 }] } } })).toEqual({
      ok: false,
      message: 'models.json provider "acme" model entries must have a string id',
    });
    expect(validateModelsConfigDraftShape({ rootFlag: true })).toEqual({ ok: true, document: { rootFlag: true, providers: {} } });
    expect(validateModelsConfigDraftShape({ rootFlag: true, providers: { acme: { custom: 1, models: [{ id: "" }] } } })).toEqual({
      ok: true,
      document: { rootFlag: true, providers: { acme: { custom: 1, models: [{ id: "" }] } } },
    });
  });
});

function ownerWithClock() {
  const clock = createFakeModelRateLimitClock();
  const rateLimits = createModelRateLimitOwner({ clock });
  return { clock, rateLimits };
}

async function temporaryAgentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-models-config-rate-limits-"));
  tempDirs.push(directory);
  return directory;
}

async function writeDocument(agentDir: string, document: unknown): Promise<void> {
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
