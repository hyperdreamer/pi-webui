import type { MemoryEntry, MemorySnapshotResponse } from "../../shared/apiTypes.js";
import type { MemoryProvider } from "./memoryProvider.js";

export class MemoryCatalog {
  constructor(private readonly providers: readonly MemoryProvider[]) {}

  async read(projectPath: string): Promise<MemorySnapshotResponse> {
    const results = await Promise.all(
      this.providers.map(async (provider) => ({ provider, result: await provider.read({ projectPath }) })),
    );
    const globalEntries: MemoryEntry[] = [];
    const projectEntries: MemoryEntry[] = [];
    let projectUnavailableMessage: string | undefined;
    let hasAvailableProvider = false;

    for (const { provider, result } of results) {
      if (result.kind === "unavailable") continue;

      hasAvailableProvider = true;
      globalEntries.push(...namespaceEntries(provider.id, result.globalEntries));
      projectEntries.push(...namespaceEntries(provider.id, result.projectEntries));
      if (projectUnavailableMessage === undefined && result.projectUnavailableMessage !== undefined) {
        projectUnavailableMessage = result.projectUnavailableMessage;
      }
    }

    if (!hasAvailableProvider) return { kind: "unavailable" };

    return {
      kind: "data",
      globalEntries,
      projectEntries,
      ...(projectUnavailableMessage === undefined ? {} : { projectUnavailableMessage }),
    };
  }
}

function namespaceEntries(providerId: string, entries: MemoryEntry[]): MemoryEntry[] {
  return entries.map((entry) => ({ ...entry, id: `${providerId}:${entry.id}` }));
}
