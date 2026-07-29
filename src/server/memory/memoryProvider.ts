import type { MemoryEntry } from "../../shared/apiTypes.js";

export interface MemoryProviderInput {
  readonly projectPath?: string;
}

export type MemoryProviderResult =
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
    };

export interface MemoryProvider {
  readonly id: string;
  read(input: MemoryProviderInput): Promise<MemoryProviderResult>;
}
