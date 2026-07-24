import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsConfigService } from "./modelsConfigService.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ModelsConfigService", () => {
  it("persists models.json and reloads the daemon model runtime", async () => {
    const agentDir = await temporaryAgentDir();
    const modelRuntime = { reloadConfig: vi.fn().mockResolvedValue(undefined) };
    const models = new ModelsConfigService({ agentDir, modelRuntime });
    const config = {
      providers: {
        custom: {
          api: "openai-completions",
          models: [{ id: "demo-model", reasoning: true }],
        },
      },
    };

    await expect(models.save(config)).resolves.toEqual({ success: true });

    await expect(readFile(join(agentDir, "models.json"), "utf8")).resolves.toBe(`${JSON.stringify(config, null, 2)}\n`);
    expect(modelRuntime.reloadConfig).toHaveBeenCalledOnce();
  });

  it("discovers Google provider models with normalized IDs", async () => {
    const agentDir = await temporaryAgentDir();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: "models/gemini-test", displayName: "Gemini Test" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const models = new ModelsConfigService({
      agentDir,
      createConnectionRuntime: () => Promise.resolve(discoveryRuntime("google-key")),
    });

    await expect(discoverModels(models, {
      providerName: "google-custom",
      provider: {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "$GEMINI_API_KEY",
      },
    })).resolves.toEqual({ models: [{ id: "gemini-test", name: "Gemini Test" }] });

    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(fetchUrl(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=google-key");
    expect(new Headers(options?.headers).get("authorization")).toBeNull();
  });

  it("discovers OpenAI-compatible provider models with resolved credentials", async () => {
    const agentDir = await temporaryAgentDir();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "gpt-test", name: "GPT Test" },
        { id: "gpt-mini" },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let discoveryDocument: unknown;
    const models = new ModelsConfigService({
      agentDir,
      createConnectionRuntime: async ({ modelsPath }) => {
        discoveryDocument = JSON.parse(await readFile(modelsPath, "utf8"));
        return discoveryRuntime("discovery-key", { "x-tenant": "demo" });
      },
    });

    await expect(discoverModels(models, {
      providerName: "custom",
      provider: {
        api: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        apiKey: "$MODEL_API_KEY",
        models: [{ id: "" }],
      },
    })).resolves.toEqual({
      models: [
        { id: "gpt-test", name: "GPT Test" },
        { id: "gpt-mini" },
      ],
    });

    expect(discoveryDocument).toEqual({
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://models.example.test/v1",
          apiKey: "$MODEL_API_KEY",
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(fetchUrl(url)).toBe("https://models.example.test/v1/models");
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBe("Bearer discovery-key");
    expect(headers.get("x-tenant")).toBe("demo");
  });
});

type DiscoverModels = (this: ModelsConfigService, value: unknown) => Promise<unknown>;

function discoverModels(service: ModelsConfigService, value: unknown): Promise<unknown> {
  const discover: unknown = Reflect.get(service, "discover");
  if (!isDiscoverModels(discover)) throw new Error("ModelsConfigService.discover is not callable");
  return discover.call(service, value);
}

function isDiscoverModels(value: unknown): value is DiscoverModels {
  return typeof value === "function";
}

function discoveryRuntime(apiKey: string, headers?: Record<string, string>) {
  return {
    getError: () => undefined,
    getModel: () => undefined,
    getAuth: () => Promise.resolve({ auth: { apiKey, ...(headers === undefined ? {} : { headers }) } }),
    completeSimple: () => Promise.reject(new Error("Connection testing is not expected during discovery")),
  };
}

function fetchUrl(input: string | URL | Request | undefined): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new Error("Expected a fetch URL");
}

async function temporaryAgentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-models-config-service-"));
  tempDirs.push(directory);
  return directory;
}
