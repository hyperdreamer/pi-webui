import type { ParsedMemoryEntry } from "./memoryFileParser.js";
import { PiHermesMemoryProvider } from "./piHermesMemoryProvider.js";

export class MemoryService {
  private readonly provider: PiHermesMemoryProvider;

  constructor(agentDir: string) {
    this.provider = new PiHermesMemoryProvider(agentDir);
  }

  async globalEntries(): Promise<ParsedMemoryEntry[]> {
    const result = await this.provider.read({});
    return result.kind === "data" ? result.globalEntries : [];
  }

  async projectEntries(projectPath: string): Promise<ParsedMemoryEntry[]> {
    return this.provider.readProjectEntries(projectPath);
  }
}
