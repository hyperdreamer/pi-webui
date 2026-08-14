import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PiWebUiConfigMutationCoordinator, PiWebUiConfigMutationSnapshot } from "../../configMutationCoordinator.js";
import type { ModelTierLadder, PiWebUiConfigValues, PiWebUiSpeechInputConfig, UtilityModelSettings } from "../../shared/apiTypes.js";
import { createConfigMutationWriters } from "./configMutationWriters.js";

describe("config mutation writers", () => {
  it("replaces model tiers through the coordinator while preserving the speech subtree", async () => {
    const speechInput: PiWebUiSpeechInputConfig = {
      provider: "cloud",
      language: "en-US",
      cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", apiKey: "$OPENAI_API_KEY" },
    };
    const harness = fakeCoordinator({ port: 9000, speechInput });
    const writers = createConfigMutationWriters(harness.coordinator);

    const ladder = validLadder();
    await writers.replaceModelTiers(ladder);

    expect(harness.mutateCalls).toBe(1);
    const next = harness.capturedMutator?.(snapshot({ port: 9000, speechInput })) ?? {};
    expect(next.modelTiers).toEqual(ladder);
    expect(next.speechInput).toEqual(speechInput);
    expect(next.port).toBe(9000);
  });

  it("replaces utility models through the coordinator while preserving the speech subtree", async () => {
    const speechInput: PiWebUiSpeechInputConfig = { provider: "browser" };
    const harness = fakeCoordinator({ port: 9000, speechInput });
    const writers = createConfigMutationWriters(harness.coordinator);

    const settings: UtilityModelSettings = { lightweight: { provider: "acme", id: "small" } };
    await writers.replaceUtilityModels(settings);

    expect(harness.mutateCalls).toBe(1);
    const next = harness.capturedMutator?.(snapshot({ port: 9000, speechInput })) ?? {};
    expect(next.utilityModels).toEqual(settings);
    expect(next.speechInput).toEqual(speechInput);
    expect(next.port).toBe(9000);
  });

  it("propagates coordinator contention and failures to the caller", async () => {
    const harness = fakeCoordinator({});
    harness.failures.push(new Error("PI WEBUI config is busy. Try again."));
    const writers = createConfigMutationWriters(harness.coordinator);

    await expect(writers.replaceModelTiers(validLadder())).rejects.toThrow("PI WEBUI config is busy. Try again.");
  });
});

describe("production low-level config save confinement", () => {
  it("allows direct savePiWebUiConfig only in the coordinator and low-level config definitions", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url)) + `${sep}..${sep}..`;
    const violations: string[] = [];
    for (const file of productionSourceFiles(srcDir)) {
      const relativePath = relative(srcDir, file).split(sep).join("/");
      if (relativePath === "config.ts" || relativePath === "configMutationCoordinator.ts") continue;
      const contents = readFileSync(file, "utf8");
      if (contents.includes("savePiWebUiConfig(")) {
        violations.push(`${relativePath}: direct savePiWebUiConfig call`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the session daemon on coordinated model-tier and utility-model writes", () => {
    const sessiondSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "sessiond.ts"), "utf8");

    expect(sessiondSource).not.toContain("replacePiWebUiModelTiers");
    expect(sessiondSource).not.toContain("replacePiWebUiUtilityModels");
  });
});

function productionSourceFiles(srcDir: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const metadata = statSync(path);
      if (metadata.isDirectory()) {
        if (entry === "node_modules" || entry === "client") continue;
        visit(path);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
      files.push(path);
    }
  };
  visit(srcDir);
  return files;
}

interface FakeCoordinatorHarness {
  coordinator: PiWebUiConfigMutationCoordinator;
  capturedMutator: ((current: PiWebUiConfigMutationSnapshot) => PiWebUiConfigValues) | undefined;
  mutateCalls: number;
  failures: Error[];
}

function fakeCoordinator(config: PiWebUiConfigValues): FakeCoordinatorHarness {
  const harness: FakeCoordinatorHarness = {
    coordinator: { read: () => Promise.resolve(snapshot(config)), mutate: () => Promise.resolve(snapshot(config)) },
    capturedMutator: undefined,
    mutateCalls: 0,
    failures: [],
  };
  harness.coordinator = {
    read: () => Promise.resolve(snapshot(config)),
    mutate: (mutate) => {
      harness.mutateCalls += 1;
      const failure = harness.failures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      harness.capturedMutator = mutate;
      const next = mutate(snapshot(config));
      return Promise.resolve(snapshot(next));
    },
  };
  return harness;
}

function snapshot(config: PiWebUiConfigValues): PiWebUiConfigMutationSnapshot {
  return {
    loaded: {
      path: "/tmp/pi-webui/config.json",
      exists: true,
      config,
    },
    speechInputRevision: "revision-1",
  };
}

function validLadder(): ModelTierLadder {
  return {
    economy: { model: { provider: "acme", id: "small" }, thinkingLevel: "low" },
    fast: { model: { provider: "acme", id: "small" }, thinkingLevel: "medium" },
    standard: { model: { provider: "acme", id: "large" }, thinkingLevel: "medium" },
    advanced: { model: { provider: "acme", id: "large" }, thinkingLevel: "high" },
    capable: { model: { provider: "acme", id: "large" }, thinkingLevel: "xhigh" },
    frontier: { model: { provider: "acme", id: "large" }, thinkingLevel: "max" },
  };
}
