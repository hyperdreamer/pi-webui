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

  it.each(["EACCES", "ENOTDIR"])("rejects a %s project-root probe when the global root is absent", async (code) => {
    const globalRootPath = join(agentDir, "pi-hermes-memory");
    const projectRootPath = join(agentDir, "projects-memory", "repo");
    const projectProbeError = Object.assign(new Error(`project probe ${code}`), { code });
    const provider = new PiHermesMemoryProvider(agentDir, {
      readFile: () => Promise.reject(new Error("Memory files must not be read after a failed availability probe")),
      isDirectory: (path) => {
        if (path === globalRootPath) return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
        if (path === projectRootPath) return Promise.reject(projectProbeError);
        return Promise.reject(new Error(`Unexpected directory probe: ${path}`));
      },
    });

    await expect(provider.read({ projectPath: "/work/repo" })).rejects.toThrow(`project probe ${code}`);
  });

  it("keeps a global provider available when the project-root probe fails", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory");
    const projectRootPath = join(agentDir, "projects-memory", "repo");
    const provider = new PiHermesMemoryProvider(agentDir, {
      readFile: () => Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
      isDirectory: (path) => {
        if (path === globalRootPath) return Promise.resolve(true);
        if (path === projectRootPath) return Promise.reject(Object.assign(new Error("project denied"), { code: "EACCES" }));
        return Promise.reject(new Error(`Unexpected directory probe: ${path}`));
      },
    });

    await expect(provider.read({ projectPath: "/work/repo" })).resolves.toEqual({
      kind: "data",
      globalEntries: [],
      projectEntries: [],
      projectUnavailableMessage: "Project-specific memory could not be loaded.",
    });
  });

  it("keeps global memory when the project identity resolver fails", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory");
    const globalMemoryPath = join(globalRootPath, "MEMORY.md");
    const failuresPath = join(globalRootPath, "failures.md");
    const provider = new PiHermesMemoryProvider(
      agentDir,
      {
        readFile: (path) => {
          if (path === globalMemoryPath) return Promise.resolve("[insight] Global entry");
          if (path === failuresPath) return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
          return Promise.reject(new Error(`Unexpected file read: ${path}`));
        },
        isDirectory: (path) => path === globalRootPath
          ? Promise.resolve(true)
          : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
      },
      () => Promise.reject(Object.assign(new Error("identity denied"), { code: "EACCES" })),
    );

    await expect(provider.read({ projectPath: "/work/repo" })).resolves.toMatchObject({
      kind: "data",
      globalEntries: [{ content: "[insight] Global entry" }],
      projectEntries: [],
      projectUnavailableMessage: "Project-specific memory could not be loaded.",
    });
  });

  it("rejects a failing project identity resolver when the global root is absent", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory");
    const provider = new PiHermesMemoryProvider(
      agentDir,
      {
        readFile: () => Promise.reject(new Error("Memory files must not be read after a failed availability probe")),
        isDirectory: (path) => path === globalRootPath
          ? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }))
          : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
      },
      () => Promise.reject(Object.assign(new Error("identity denied"), { code: "EACCES" })),
    );

    await expect(provider.read({ projectPath: "/work/repo" })).rejects.toThrow("identity denied");
  });

  it("returns no project entries when the project identity resolver fails", async () => {
    const provider = new PiHermesMemoryProvider(
      agentDir,
      {
        readFile: () => Promise.reject(new Error("Unexpected file read")),
        isDirectory: () => Promise.reject(new Error("Unexpected directory probe")),
      },
      () => Promise.reject(Object.assign(new Error("identity denied"), { code: "EACCES" })),
    );

    await expect(provider.readProjectEntries("/work/repo")).resolves.toEqual([]);
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

  it("reads a linked worktree's project memory through its shared repo root", async () => {
    const mainPath = join(agentDir, "main");
    const worktreeGitDir = join(mainPath, ".git", "worktrees", "feature");
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, "commondir"), "../..\n", "utf-8");

    const featurePath = join(agentDir, "feature");
    await mkdir(featurePath, { recursive: true });
    await writeFile(join(featurePath, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf-8");

    await writeMemoryFile("projects-memory/main/MEMORY.md", "Worktree-shared project memory");

    await expect(new PiHermesMemoryProvider(agentDir).read({ projectPath: featurePath })).resolves.toMatchObject({
      kind: "data",
      projectEntries: [{ content: "Worktree-shared project memory" }],
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

  it("reads project entries without probing or reading global memory", async () => {
    const projectRootPath = join(agentDir, "projects-memory", "repo");
    const projectMemoryPath = join(projectRootPath, "MEMORY.md");
    const provider = new PiHermesMemoryProvider(agentDir, {
      isDirectory: (path) => path === projectRootPath
        ? Promise.resolve(true)
        : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
      readFile: (path) => path === projectMemoryPath
        ? Promise.resolve("[project] Independent project entry")
        : Promise.reject(new Error(`Unexpected file read: ${path}`)),
    });

    await expect(provider.readProjectEntries("/work/repo")).resolves.toMatchObject([
      { content: "[project] Independent project entry", category: "project" },
    ]);
  });

  it("returns no project entries when the project memory file is inaccessible", async () => {
    const projectRootPath = join(agentDir, "projects-memory", "repo");
    const projectMemoryPath = join(projectRootPath, "MEMORY.md");
    const provider = new PiHermesMemoryProvider(agentDir, {
      isDirectory: (path) => path === projectRootPath
        ? Promise.resolve(true)
        : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
      readFile: (path) => path === projectMemoryPath
        ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
        : Promise.reject(new Error(`Unexpected file read: ${path}`)),
    });

    await expect(provider.readProjectEntries("/work/repo")).resolves.toEqual([]);
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
