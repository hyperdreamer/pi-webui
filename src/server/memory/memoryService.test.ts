import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiHermesMemoryProvider } from "./piHermesMemoryProvider.js";
import { MemoryService } from "./memoryService.js";

describe("MemoryService", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-webui-memory-service-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  async function writeMemoryFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(agentDir, relativePath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  describe("globalEntries", () => {
    it("returns empty array when no memory files exist", async () => {
      const service = new MemoryService(agentDir);
      const entries = await service.globalEntries();
      expect(entries).toEqual([]);
    });

    it("returns empty arrays from both scope helpers when no provider root exists", async () => {
      const service = new MemoryService(agentDir);

      await expect(service.globalEntries()).resolves.toEqual([]);
      await expect(service.projectEntries("/some/nonexistent/project")).resolves.toEqual([]);
    });

    it("reads entries from MEMORY.md", async () => {
      await writeMemoryFile("pi-hermes-memory/MEMORY.md", "Entry one.\n§\nEntry two.");
      const service = new MemoryService(agentDir);
      const entries = await service.globalEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]?.content).toBe("Entry one.");
      expect(entries[1]?.content).toBe("Entry two.");
    });

    it("reads entries from failures.md", async () => {
      await writeMemoryFile("pi-hermes-memory/failures.md", "[tool-quirk] Something odd.");
      const service = new MemoryService(agentDir);
      const entries = await service.globalEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.category).toBe("tool-quirk");
    });

    it("merges entries from both MEMORY.md and failures.md", async () => {
      await writeMemoryFile("pi-hermes-memory/MEMORY.md", "Global one.");
      await writeMemoryFile("pi-hermes-memory/failures.md", "[failure] Broke.");
      const service = new MemoryService(agentDir);
      const entries = await service.globalEntries();
      expect(entries).toHaveLength(2);
    });
  });

  describe("projectEntries", () => {
    it("uses the project-only provider read instead of aggregate reads", async () => {
      const aggregateRead = vi.spyOn(PiHermesMemoryProvider.prototype, "read").mockRejectedValue(new Error("global read must not run"));
      const projectRead = vi.spyOn(PiHermesMemoryProvider.prototype, "readProjectEntries").mockResolvedValue([
        { id: "project", content: "Project entry" },
      ]);
      const service = new MemoryService(agentDir);

      await expect(service.projectEntries("/work/repo")).resolves.toEqual([
        { id: "project", content: "Project entry" },
      ]);
      expect(projectRead).toHaveBeenCalledWith("/work/repo");
      expect(aggregateRead).not.toHaveBeenCalled();
    });

    it("returns empty array when the project memory file does not exist", async () => {
      const service = new MemoryService(agentDir);
      const entries = await service.projectEntries("/some/nonexistent/project");
      expect(entries).toEqual([]);
    });

    it("reads entries from a project MEMORY.md", async () => {
      await writeMemoryFile("projects-memory/my-project/MEMORY.md", "Project entry.");
      const service = new MemoryService(agentDir);
      const entries = await service.projectEntries("/home/user/my-project");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.content).toBe("Project entry.");
    });

    it("returns empty array for safe basename values", async () => {
      const service = new MemoryService(agentDir);
      const entries = await service.projectEntries("/safe");
      expect(Array.isArray(entries)).toBe(true);
    });

    it("returns empty array for project path whose basename is ..", async () => {
      const service = new MemoryService(agentDir);
      const entries = await service.projectEntries("/home/ok/..");
      expect(entries).toEqual([]);
    });
  });
});
