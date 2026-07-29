import { describe, expect, it } from "vitest";
import type { MemoryProviderResult } from "./memoryProvider.js";
import { MemoryCatalog } from "./memoryCatalog.js";

function resolved(result: MemoryProviderResult): Promise<MemoryProviderResult> {
  return Promise.resolve(result);
}

describe("MemoryCatalog", () => {
  it("returns unavailable only when every provider reports unavailable", async () => {
    const catalog = new MemoryCatalog([{ id: "one", read: () => resolved({ kind: "unavailable" }) }]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when no providers are registered", async () => {
    const catalog = new MemoryCatalog([]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({ kind: "unavailable" });
  });

  it("prefixes provider-local ids while aggregating scopes", async () => {
    const catalog = new MemoryCatalog([
      { id: "one", read: () => resolved({ kind: "data", globalEntries: [{ id: "a", content: "one" }], projectEntries: [] }) },
      { id: "two", read: () => resolved({ kind: "data", globalEntries: [], projectEntries: [{ id: "a", content: "two" }] }) },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalEntries: [{ id: "one:a", content: "one" }],
      projectEntries: [{ id: "two:a", content: "two" }],
    });
  });

  it("retains the first available provider's project-unavailable message", async () => {
    const catalog = new MemoryCatalog([
      {
        id: "one",
        read: () => resolved({
          kind: "data",
          globalEntries: [],
          projectEntries: [],
          projectUnavailableMessage: "First project failure",
        }),
      },
      {
        id: "two",
        read: () => resolved({
          kind: "data",
          globalEntries: [],
          projectEntries: [],
          projectUnavailableMessage: "Second project failure",
        }),
      },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalEntries: [],
      projectEntries: [],
      projectUnavailableMessage: "First project failure",
    });
  });
});
