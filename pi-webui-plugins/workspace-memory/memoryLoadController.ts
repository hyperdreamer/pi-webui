import type { MemoryEntry } from "./memoryData.js";

const PROJECT_UNAVAILABLE_MESSAGE = "Project-specific memory could not be loaded.";

export type MemoryLoadResult =
  | {
      kind: "loaded";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
    }
  | { kind: "global-error"; message: string };

export interface MemoryLoadFetchers {
  fetchGlobalMemories(): Promise<MemoryEntry[]>;
  fetchProjectMemories(projectPath: string): Promise<MemoryEntry[]>;
}

type ProjectLoadOutcome =
  | { kind: "available"; entries: MemoryEntry[] }
  | { kind: "unavailable" };

/** Coordinates independently fetched memory scopes and suppresses superseded loads. */
export class MemoryLoadController {
  private generation = 0;

  constructor(private readonly fetchers: MemoryLoadFetchers) {}

  async load(projectPath: string): Promise<MemoryLoadResult | undefined> {
    const loadGeneration = ++this.generation;
    const globalLoad = invokeFetcher(() => this.fetchers.fetchGlobalMemories());
    const projectLoad = invokeFetcher(() => this.fetchers.fetchProjectMemories(projectPath))
      .then((entries): ProjectLoadOutcome => ({ kind: "available", entries }))
      .catch((): ProjectLoadOutcome => ({ kind: "unavailable" }));

    let globalEntries: MemoryEntry[];
    try {
      globalEntries = await globalLoad;
    } catch (error) {
      if (!this.isCurrent(loadGeneration)) return undefined;
      return {
        kind: "global-error",
        message: error instanceof Error ? error.message : "Failed to load memories.",
      };
    }

    const projectOutcome = await projectLoad;
    if (!this.isCurrent(loadGeneration)) return undefined;

    if (projectOutcome.kind === "unavailable") {
      return {
        kind: "loaded",
        globalEntries,
        projectEntries: [],
        projectUnavailableMessage: PROJECT_UNAVAILABLE_MESSAGE,
      };
    }

    return {
      kind: "loaded",
      globalEntries,
      projectEntries: projectOutcome.entries,
    };
  }

  invalidate(): void {
    this.generation += 1;
  }

  private isCurrent(loadGeneration: number): boolean {
    return this.generation === loadGeneration;
  }
}

async function invokeFetcher<T>(fetcher: () => Promise<T>): Promise<T> {
  return fetcher();
}
