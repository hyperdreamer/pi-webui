import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiHermesMemoryProvider } from "./piHermesMemoryProvider.js";

describe("PiHermesMemoryProvider", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-webui-hermes-memory-provider-"));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  async function writeMemoryFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(agentDir, relativePath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  it("reports unavailable when neither Hermes root exists", async () => {
    const result = await new PiHermesMemoryProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable when neither Hermes root exists and the project basename is unsafe", async () => {
    const result = await new PiHermesMemoryProvider(agentDir).read({ projectPath: "/work/.." });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("reports an empty Hermes root as available without inventing entries", async () => {
    await mkdir(join(agentDir, "pi-hermes-memory"));

    const result = await new PiHermesMemoryProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toEqual({ kind: "data", globalEntries: [], projectEntries: [] });
  });

  it("reads global entries from MEMORY.md and failures.md", async () => {
    await writeMemoryFile("pi-hermes-memory/MEMORY.md", "[insight] Global entry");
    await writeMemoryFile("pi-hermes-memory/failures.md", "[failure] Failure entry");

    const result = await new PiHermesMemoryProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toMatchObject({
      kind: "data",
      globalEntries: [
        { content: "[insight] Global entry", category: "insight" },
        { content: "[failure] Failure entry", category: "failure" },
      ],
      projectEntries: [],
    });
  });

  it("reports a project-only Hermes root as available", async () => {
    await writeMemoryFile("projects-memory/repo/MEMORY.md", "[project] Project entry");

    const result = await new PiHermesMemoryProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toMatchObject({
      kind: "data",
      globalEntries: [],
      projectEntries: [{ content: "[project] Project entry", category: "project" }],
    });
  });

  it("keeps global entries when only the project read fails", async () => {
    const globalMemoryPath = join(agentDir, "pi-hermes-memory", "MEMORY.md");
    const failuresPath = join(agentDir, "pi-hermes-memory", "failures.md");
    const provider = new PiHermesMemoryProvider(agentDir, {
      readFile: (path) => {
        if (path === globalMemoryPath) return Promise.resolve("[insight] Global entry");
        if (path === failuresPath) return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      },
      isDirectory: () => Promise.resolve(true),
    });

    await expect(provider.read({ projectPath: "/work/repo" })).resolves.toMatchObject({
      kind: "data",
      globalEntries: [{ content: "[insight] Global entry" }],
      projectEntries: [],
      projectUnavailableMessage: "Project-specific memory could not be loaded.",
    });
  });

  it("keeps global entries when the project basename is unsafe", async () => {
    const globalMemoryPath = join(agentDir, "pi-hermes-memory", "MEMORY.md");
    const failuresPath = join(agentDir, "pi-hermes-memory", "failures.md");
    const provider = new PiHermesMemoryProvider(agentDir, {
      readFile: (path) => {
        if (path === globalMemoryPath) return Promise.resolve("[insight] Global entry");
        if (path === failuresPath) return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
        return Promise.reject(new Error("The unsafe project file should not be read"));
      },
      isDirectory: () => Promise.resolve(true),
    });

    await expect(provider.read({ projectPath: "/work/.." })).resolves.toMatchObject({
      kind: "data",
      globalEntries: [{ content: "[insight] Global entry" }],
      projectEntries: [],
      projectUnavailableMessage: "Project-specific memory could not be loaded.",
    });
  });

  it("rejects a non-ENOENT global file failure", async () => {
    const provider = new PiHermesMemoryProvider(agentDir, {
      readFile: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
      isDirectory: () => Promise.resolve(true),
    });

    await expect(provider.read({ projectPath: "/work/repo" })).rejects.toThrow("denied");
  });

  it("rejects a non-ENOENT failures.md read failure", async () => {
    const globalMemoryPath = join(agentDir, "pi-hermes-memory", "MEMORY.md");
    const provider = new PiHermesMemoryProvider(agentDir, {
      readFile: (path) => {
        if (path === globalMemoryPath) return Promise.resolve("[insight] Global entry");
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      },
      isDirectory: () => Promise.resolve(true),
    });

    await expect(provider.read({})).rejects.toThrow("denied");
  });
});
