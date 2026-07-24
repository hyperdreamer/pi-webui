import { describe, expect, it, vi } from "vitest";
import type { Machine, ModelsConfigDocument } from "../api";
import { ModelsConfigDialog } from "./ModelsConfigDialog";

describe("models-config-dialog machine targeting", () => {
  it("loads and saves the selected remote machine's models configuration", async () => {
    const config: ModelsConfigDocument = { providers: { custom: { api: "openai-completions" } } };
    const modelsApi = {
      config: vi.fn().mockResolvedValue(config),
      save: vi.fn().mockResolvedValue({ success: true }),
      test: vi.fn(),
      discover: vi.fn(),
    };
    const dialog = new ModelsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.modelsApi = modelsApi;

    await callDialogPromise(dialog, "loadConfig");
    await callDialogPromise(dialog, "saveConfig");

    expect(modelsApi.config).toHaveBeenCalledWith("remote-a");
    expect(modelsApi.save).toHaveBeenCalledWith(config, "remote-a");
  });

  it("tests the selected custom model against the selected machine", async () => {
    const config: ModelsConfigDocument = {
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://models.example.test/v1",
          models: [{ id: "demo-model", reasoning: true }],
        },
      },
    };
    const modelsApi = {
      config: vi.fn(),
      save: vi.fn(),
      test: vi.fn().mockResolvedValue({ ok: true, latencyMs: 42, status: 200, responseText: "OK" }),
      discover: vi.fn(),
    };
    const dialog = new ModelsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.modelsApi = modelsApi;
    Reflect.set(dialog, "config", config);

    await callDialogPromise(dialog, "testModel", "custom", 0);

    expect(modelsApi.test).toHaveBeenCalledWith({
      providerName: "custom",
      provider: config.providers?.["custom"],
      model: { id: "demo-model", reasoning: true },
    }, "remote-a");
  });

  it("refreshes a provider catalog with its current configuration", async () => {
    const config: ModelsConfigDocument = {
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://models.example.test/v1",
          models: [{ id: "" }],
        },
      },
    };
    const modelsApi = {
      config: vi.fn(),
      save: vi.fn(),
      test: vi.fn(),
      discover: vi.fn()
        .mockResolvedValueOnce({ models: [{ id: "gpt-old" }] })
        .mockResolvedValueOnce({ models: [{ id: "gpt-new" }] }),
    };
    const dialog = new ModelsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.modelsApi = modelsApi;
    Reflect.set(dialog, "config", config);

    await callDialogPromise(dialog, "discoverModels", "custom");
    callDialogMethod(dialog, "replaceProvider", "custom", {
      api: "openai-completions",
      baseUrl: "https://models.example.test/v2",
      models: [{ id: "" }],
    });

    expect(Reflect.get(dialog, "discoveredModels")).toEqual({
      custom: { phase: "ready", models: [{ id: "gpt-old" }] },
    });

    await callDialogPromise(dialog, "discoverModels", "custom");

    expect(modelsApi.discover).toHaveBeenNthCalledWith(1, {
      providerName: "custom",
      provider: config.providers?.["custom"],
    }, "remote-a");
    expect(modelsApi.discover).toHaveBeenNthCalledWith(2, {
      providerName: "custom",
      provider: {
        api: "openai-completions",
        baseUrl: "https://models.example.test/v2",
        models: [{ id: "" }],
      },
    }, "remote-a");
    expect(Reflect.get(dialog, "discoveredModels")).toEqual({
      custom: { phase: "ready", models: [{ id: "gpt-new" }] },
    });
  });

  it("keeps another provider's in-flight discovery valid after a provider edit", async () => {
    const config: ModelsConfigDocument = {
      providers: {
        first: { api: "openai-completions", baseUrl: "https://first.example.test/v1" },
        second: { api: "openai-completions", baseUrl: "https://second.example.test/v1" },
      },
    };
    let resolveFirst: ((value: { models: { id: string }[] }) => void) | undefined;
    const firstDiscovery = new Promise<{ models: { id: string }[] }>((resolve) => { resolveFirst = resolve; });
    const modelsApi = {
      config: vi.fn(),
      save: vi.fn(),
      test: vi.fn(),
      discover: vi.fn((input: { providerName: string }) => input.providerName === "first"
        ? firstDiscovery
        : Promise.resolve({ models: [] })),
    };
    const dialog = new ModelsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.modelsApi = modelsApi;
    Reflect.set(dialog, "config", config);

    const discovery = callDialogPromise(dialog, "discoverModels", "first");
    callDialogMethod(dialog, "replaceProvider", "second", {
      api: "openai-completions",
      baseUrl: "https://second.example.test/v2",
    });
    if (resolveFirst === undefined) throw new Error("First provider discovery did not start");
    resolveFirst({ models: [{ id: "first-model" }] });
    await discovery;

    expect(Reflect.get(dialog, "discoveredModels")).toEqual({
      first: { phase: "ready", models: [{ id: "first-model" }] },
    });
  });

  it("discovers provider models on the selected machine and uses the selected display name", async () => {
    const config: ModelsConfigDocument = {
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://models.example.test/v1",
          models: [{ id: "" }],
        },
      },
    };
    const modelsApi = {
      config: vi.fn(),
      save: vi.fn(),
      test: vi.fn(),
      discover: vi.fn().mockResolvedValue({
        models: [
          { id: "gpt-test", name: "GPT Test" },
          { id: "gpt-mini" },
        ],
      }),
    };
    const dialog = new ModelsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.modelsApi = modelsApi;
    Reflect.set(dialog, "config", config);

    await callDialogPromise(dialog, "discoverModels", "custom");
    callDialogMethod(dialog, "selectDiscoveredModel", "custom", 0, "gpt-test");

    expect(modelsApi.discover).toHaveBeenCalledWith({
      providerName: "custom",
      provider: config.providers?.["custom"],
    }, "remote-a");
    expect(Reflect.get(dialog, "config")).toEqual({
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://models.example.test/v1",
          models: [{ id: "gpt-test", name: "GPT Test" }],
        },
      },
    });

    callDialogMethod(dialog, "selectDiscoveredModel", "custom", 0, "gpt-mini");

    expect(Reflect.get(dialog, "config")).toEqual({
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://models.example.test/v1",
          models: [{ id: "gpt-mini", name: "gpt-mini" }],
        },
      },
    });
  });
});

function machine(id: string): Machine {
  return {
    id,
    name: "Remote build host",
    kind: "remote",
    baseUrl: "https://remote.example.test/",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

async function callDialogPromise(dialog: ModelsConfigDialog, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callDialogMethod(dialog, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`ModelsConfigDialog.${methodName} did not return a promise`);
  await result;
}

function callDialogMethod(dialog: ModelsConfigDialog, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(dialog, methodName);
  if (!isDialogMethod(method)) throw new Error(`ModelsConfigDialog.${methodName} is not callable`);
  return method.call(dialog, ...args);
}

function isDialogMethod(value: unknown): value is (this: ModelsConfigDialog, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}
