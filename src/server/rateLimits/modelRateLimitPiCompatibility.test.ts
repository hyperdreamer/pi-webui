import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsConfigDocument } from "../../shared/apiTypes";
import { ModelsJsonParseError, parseModelsJsonText } from "../models/modelsJsonParser";
import { extractModelRateLimits, modelRateLimitValuesFor } from "./modelRateLimitConfig";

const tempDirs: string[] = [];

const PLAIN_FIXTURE = `{
  "customRootFlag": "kept",
  "providers": {
    "acme": {
      "name": "Acme",
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "customProviderFlag": "kept",
      "models": [
        { "id": "model-large", "name": "Large", "contextWindow": 200000, "maxTokens": 8192, "customModelFlag": "kept" },
        { "id": "model-small", "name": "Small" }
      ]
    }
  }
}`;

const LIMITED_FIXTURE = `{
  "customRootFlag": "kept",
  "providers": {
    "acme": {
      "name": "Acme",
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "customProviderFlag": "kept",
      "models": [
        { "id": "model-large", "name": "Large", "contextWindow": 200000, "maxTokens": 8192, "customModelFlag": "kept", "tpm": 100000, "prm": 60 },
        { "id": "model-small", "name": "Small", "tpm": 300000 }
      ]
    }
  }
}`;

const DIALECT_FIXTURE = `\uFEFF{ // acme provider\n "providers": { "acme": { "baseUrl": "https://api.example.test/v1", "api": "openai-completions", "apiKey": "test-key", "models": [{ "id": "demo", },], }, },\n}`;

const BLOCK_COMMENT_FIXTURE = `{
  "providers": {
    "acme": {
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      /* block comments are not Pi JSON */
      "models": [{ "id": "demo" }]
    }
  }
}`;

const DUPLICATE_FIXTURE = `{
  "providers": {
    "acme": {
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "models": [
        { "id": "demo", "maxTokens": 111, "tpm": 100 },
        { "id": "demo", "maxTokens": 4096, "tpm": 200 }
      ]
    }
  }
}`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("installed Pi 0.85.1 rate limit compatibility", () => {
  it("loads identical model behavior with and without tpm/prm", async () => {
    const plain = await createRuntime(PLAIN_FIXTURE);
    const limited = await createRuntime(LIMITED_FIXTURE);

    expect(plain.getError()).toBeUndefined();
    expect(limited.getError()).toBeUndefined();
    expect(modelSummary(limited)).toEqual(modelSummary(plain));
    expect(modelSummary(limited)).toEqual([
      {
        id: "model-large",
        api: "openai-completions",
        baseUrl: "https://api.example.test/v1",
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: false,
        thinkingLevelMap: undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: undefined,
      },
      {
        id: "model-small",
        api: "openai-completions",
        baseUrl: "https://api.example.test/v1",
        contextWindow: 128000,
        maxTokens: 16384,
        reasoning: false,
        thinkingLevelMap: undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: undefined,
      },
    ]);
  });

  it("preserves unknown fields in PI WEBUI's parser and does not reinterpret them", async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed JSON is deliberately treated as the shared document type to assert unknown-field preservation.
    const document = parseModelsJsonText(LIMITED_FIXTURE) as ModelsConfigDocument;
    const provider = document.providers?.["acme"];

    expect(document["customRootFlag"]).toBe("kept");
    expect(provider?.["customProviderFlag"]).toBe("kept");
    expect(provider?.models?.[0]?.["customModelFlag"]).toBe("kept");

    const runtime = await createRuntime(LIMITED_FIXTURE);
    expect(runtime.getProvider("acme")?.baseUrl).toBe("https://api.example.test/v1");
    expect(runtime.getProvider("acme")?.name).toBe("Acme");
  });

  it("loads BOM, line comments, and trailing commas and rejects block comments in both parsers", async () => {
    const dialect = await createRuntime(DIALECT_FIXTURE);
    expect(dialect.getError()).toBeUndefined();
    expect(dialect.getModels("acme").map((model) => model.id)).toEqual(["demo"]);
    expect(parseModelsJsonText(DIALECT_FIXTURE)).toEqual({
      providers: { acme: { baseUrl: "https://api.example.test/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "demo" }] } },
    });

    const blockComment = await createRuntime(BLOCK_COMMENT_FIXTURE);
    expect(blockComment.getError()).toContain("Failed to parse models.json:");
    expect(() => parseModelsJsonText(BLOCK_COMMENT_FIXTURE)).toThrow(ModelsJsonParseError);
  });

  it("resolves duplicate model IDs with the last definition winning and agrees on limits", async () => {
    const runtime = await createRuntime(DUPLICATE_FIXTURE);
    const duplicates = runtime.getModels("acme").filter((model) => model.id === "demo");

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.maxTokens).toBe(4096);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed JSON is deliberately treated as the shared document type to compare limit extraction with Pi's duplicate resolution.
    const extraction = extractModelRateLimits(parseModelsJsonText(DUPLICATE_FIXTURE) as ModelsConfigDocument);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: "demo" })).toEqual({ tpm: 200 });
  });

  it("never rewrites or restats the source models.json", async () => {
    const directory = await fixtureDir(LIMITED_FIXTURE);
    const modelsPath = join(directory, "models.json");
    const before = await stat(modelsPath);
    const text = await readFile(modelsPath, "utf8");

    const runtime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });

    expect(runtime.getError()).toBeUndefined();
    expect(await readFile(modelsPath, "utf8")).toBe(text);
    expect((await stat(modelsPath)).mtimeMs).toBe(before.mtimeMs);
  });

  it("keeps credentials configuration identical for both fixtures", async () => {
    const authPath = await authFilePath();
    const plain = await createRuntime(PLAIN_FIXTURE, authPath);
    const limited = await createRuntime(LIMITED_FIXTURE, authPath);

    expect(await limited.getAuth("anthropic")).toEqual(await plain.getAuth("anthropic"));
    expect(await limited.getAuth("acme")).toEqual(await plain.getAuth("acme"));
    expect(limited.getProviderAuthStatus("acme")).toEqual(plain.getProviderAuthStatus("acme"));
  });
});

function modelSummary(runtime: ModelRuntime) {
  return runtime.getModels("acme").map((model) => ({
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    compat: model.compat,
  }));
}

async function fixtureDir(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-rate-limit-pi-compat-"));
  tempDirs.push(directory);
  await writeFile(join(directory, "models.json"), text, "utf8");
  return directory;
}

async function createRuntime(modelsText: string, authPath?: string): Promise<ModelRuntime> {
  const directory = await fixtureDir(modelsText);
  return await ModelRuntime.create({
    modelsPath: join(directory, "models.json"),
    ...(authPath === undefined ? {} : { authPath }),
    allowModelNetwork: false,
  });
}

async function authFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-rate-limit-auth-"));
  tempDirs.push(directory);
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-api-test" } }), "utf8");
  return authPath;
}
