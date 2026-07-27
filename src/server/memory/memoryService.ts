import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseMemoryFile, type ParsedMemoryEntry } from "./memoryFileParser.js";

export class MemoryService {
  constructor(private readonly agentDir: string) {}

  async globalEntries(): Promise<ParsedMemoryEntry[]> {
    const results: ParsedMemoryEntry[] = [];

    const memPath = join(this.agentDir, "pi-hermes-memory", "MEMORY.md");
    try {
      const content = await readFile(memPath, "utf-8");
      results.push(...parseMemoryFile(content));
    } catch {
      // File missing — skip
    }

    const failuresPath = join(this.agentDir, "pi-hermes-memory", "failures.md");
    try {
      const content = await readFile(failuresPath, "utf-8");
      results.push(...parseMemoryFile(content));
    } catch {
      // File missing — skip
    }

    return results;
  }

  async projectEntries(projectPath: string): Promise<ParsedMemoryEntry[]> {
    const projectName = basename(projectPath);

    // Path safety: reject names that could escape the projects-memory directory
    if (projectName.includes("/") || projectName.includes("\\") || projectName === ".." || projectName === ".") {
      return [];
    }

    const filePath = join(this.agentDir, "projects-memory", projectName, "MEMORY.md");
    try {
      const content = await readFile(filePath, "utf-8");
      return parseMemoryFile(content);
    } catch {
      return [];
    }
  }
}
