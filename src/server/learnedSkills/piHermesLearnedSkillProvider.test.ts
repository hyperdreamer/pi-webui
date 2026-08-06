import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiHermesLearnedSkillProvider } from "./piHermesLearnedSkillProvider.js";

const VALID_SKILL = [
  "---",
  'name: "verify-red"',
  'description: "Prove RED."',
  "version: 2",
  'created: "2026-08-01"',
  'updated: "2026-08-05"',
  "---",
  "## Procedure",
  "Run it.",
].join("\n");

describe("PiHermesLearnedSkillProvider", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-webui-hermes-learned-skills-"));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  async function writeSkillFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(agentDir, relativePath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  it("reports unavailable when neither the global nor the project skills root exists", async () => {
    const result = await new PiHermesLearnedSkillProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable when neither skills root exists and the project basename is unsafe", async () => {
    const result = await new PiHermesLearnedSkillProvider(agentDir).read({ projectPath: "/work/.." });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it.each(["EACCES", "ENOTDIR"])("rejects a %s project-root probe when the global root is absent", async (code) => {
    const globalRootPath = join(agentDir, "pi-hermes-memory", "skills");
    const projectRootPath = join(agentDir, "projects-memory", "repo", "skills");
    const projectProbeError = Object.assign(new Error(`project probe ${code}`), { code });
    const provider = new PiHermesLearnedSkillProvider(agentDir, {
      fileAccess: {
        readFile: () => Promise.reject(new Error("Skill files must not be read after a failed availability probe")),
        isDirectory: (path) => {
          if (path === globalRootPath) return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
          if (path === projectRootPath) return Promise.reject(projectProbeError);
          return Promise.reject(new Error(`Unexpected directory probe: ${path}`));
        },
        listDirectories: () => Promise.reject(new Error("No listing should happen after a failed availability probe")),
      },
    });

    await expect(provider.read({ projectPath: "/work/repo" })).rejects.toThrow(`project probe ${code}`);
  });

  it("keeps a provider available when the project-root probe fails", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory", "skills");
    const projectRootPath = join(agentDir, "projects-memory", "repo", "skills");
    const provider = new PiHermesLearnedSkillProvider(agentDir, {
      fileAccess: {
        readFile: () => Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
        isDirectory: (path) => {
          if (path === globalRootPath) return Promise.resolve(true);
          if (path === projectRootPath) return Promise.reject(Object.assign(new Error("project denied"), { code: "EACCES" }));
          return Promise.reject(new Error(`Unexpected directory probe: ${path}`));
        },
        listDirectories: (path) => path === globalRootPath
          ? Promise.resolve([])
          : Promise.reject(new Error(`Unexpected directory listing: ${path}`)),
      },
    });

    await expect(provider.read({ projectPath: "/work/repo" })).resolves.toEqual({
      kind: "data",
      globalSkills: [],
      projectSkills: [],
      projectUnavailableMessage: "Project-specific learned skills could not be loaded.",
    });
  });

  it("keeps global skills when the project identity resolver fails", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory", "skills");
    const goodSkillPath = join(globalRootPath, "good", "SKILL.md");
    const provider = new PiHermesLearnedSkillProvider(agentDir, {
      fileAccess: {
        readFile: (path) => path === goodSkillPath
          ? Promise.resolve(`---\nname: "good"\ndescription: "A good skill."\n---\n`)
          : Promise.reject(new Error(`Unexpected file read: ${path}`)),
        isDirectory: (path) => path === globalRootPath
          ? Promise.resolve(true)
          : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
        listDirectories: (path) => path === globalRootPath
          ? Promise.resolve(["good"])
          : Promise.reject(new Error(`Unexpected directory listing: ${path}`)),
      },
      resolveProjectName: () => Promise.reject(Object.assign(new Error("identity denied"), { code: "EACCES" })),
    });

    await expect(provider.read({ projectPath: "/work/repo" })).resolves.toMatchObject({
      kind: "data",
      globalSkills: [{ id: "good", name: "good" }],
      projectSkills: [],
      projectUnavailableMessage: "Project-specific learned skills could not be loaded.",
    });
  });

  it("rejects a failing project identity resolver when the global root is absent", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory", "skills");
    const provider = new PiHermesLearnedSkillProvider(agentDir, {
      fileAccess: {
        readFile: () => Promise.reject(new Error("Skill files must not be read after a failed availability probe")),
        isDirectory: (path) => path === globalRootPath
          ? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }))
          : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
        listDirectories: () => Promise.reject(new Error("No listing should happen after a failed availability probe")),
      },
      resolveProjectName: () => Promise.reject(Object.assign(new Error("identity denied"), { code: "EACCES" })),
    });

    await expect(provider.read({ projectPath: "/work/repo" })).rejects.toThrow("identity denied");
  });

  it("reports an existing empty skills root as available without inventing skills", async () => {
    await mkdir(join(agentDir, "pi-hermes-memory", "skills"), { recursive: true });

    const result = await new PiHermesLearnedSkillProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toEqual({ kind: "data", globalSkills: [], projectSkills: [] });
  });

  it("reads global skills from <agentDir>/pi-hermes-memory/skills/<slug>/SKILL.md", async () => {
    await writeSkillFile("pi-hermes-memory/skills/verify-red/SKILL.md", VALID_SKILL);

    const result = await new PiHermesLearnedSkillProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toEqual({
      kind: "data",
      globalSkills: [{
        id: "verify-red",
        name: "verify-red",
        description: "Prove RED.",
        filePath: join(agentDir, "pi-hermes-memory", "skills", "verify-red", "SKILL.md"),
        version: 2,
        created: "2026-08-01",
        updated: "2026-08-05",
      }],
      projectSkills: [],
    });
  });

  it("keeps a project-only skills root available", async () => {
    await writeSkillFile("projects-memory/repo/skills/verify-blue/SKILL.md", VALID_SKILL);

    const result = await new PiHermesLearnedSkillProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toMatchObject({
      kind: "data",
      globalSkills: [],
      projectSkills: [{
        id: "verify-blue",
        filePath: join(agentDir, "projects-memory", "repo", "skills", "verify-blue", "SKILL.md"),
      }],
    });
  });

  it("reads project skills from <agentDir>/projects-memory/<project>/skills/<slug>/SKILL.md", async () => {
    await writeSkillFile("pi-hermes-memory/skills/global-skill/SKILL.md", VALID_SKILL);
    await writeSkillFile(
      "projects-memory/repo/skills/project-skill/SKILL.md",
      `---\nname: "project-skill"\ndescription: "Project scoped."\n---\n## Procedure\nRun it.`,
    );

    const result = await new PiHermesLearnedSkillProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toMatchObject({
      kind: "data",
      globalSkills: [{ id: "global-skill", filePath: join(agentDir, "pi-hermes-memory", "skills", "global-skill", "SKILL.md") }],
      projectSkills: [{ id: "project-skill", filePath: join(agentDir, "projects-memory", "repo", "skills", "project-skill", "SKILL.md") }],
    });
  });

  it("ignores non-directory children and missing SKILL.md files", async () => {
    await writeSkillFile("pi-hermes-memory/skills/real-skill/SKILL.md", VALID_SKILL);
    await writeFile(join(agentDir, "pi-hermes-memory", "skills", "note.txt"), "not a directory", "utf-8");
    await mkdir(join(agentDir, "pi-hermes-memory", "skills", "empty-dir"), { recursive: true });

    const result = await new PiHermesLearnedSkillProvider(agentDir).read({ projectPath: "/work/repo" });

    expect(result).toMatchObject({
      kind: "data",
      globalSkills: [{ id: "real-skill" }],
      projectSkills: [],
    });
  });

  it("skips unreadable and invalid individual skill files", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory", "skills");
    const provider = new PiHermesLearnedSkillProvider(agentDir, {
      fileAccess: {
        isDirectory: (path) => path === globalRootPath
          ? Promise.resolve(true)
          : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
        listDirectories: (path) => path === globalRootPath
          ? Promise.resolve(["good", "unreadable", "invalid"])
          : Promise.reject(new Error(`Unexpected directory listing: ${path}`)),
        readFile: (path) => {
          if (path === join(globalRootPath, "good", "SKILL.md")) {
            return Promise.resolve(`---\nname: "good"\ndescription: "A good skill."\n---\n`);
          }
          if (path === join(globalRootPath, "unreadable", "SKILL.md")) {
            return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
          }
          if (path === join(globalRootPath, "invalid", "SKILL.md")) {
            return Promise.resolve("No frontmatter here.");
          }
          return Promise.reject(new Error(`Unexpected file read: ${path}`));
        },
      },
    });

    await expect(provider.read({})).resolves.toMatchObject({
      kind: "data",
      globalSkills: [{ id: "good", name: "good" }],
      projectSkills: [],
    });
  });

  it("preserves global skills and adds the scoped warning when the project listing fails", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory", "skills");
    const projectRootPath = join(agentDir, "projects-memory", "repo", "skills");
    const goodSkillPath = join(globalRootPath, "good", "SKILL.md");
    const provider = new PiHermesLearnedSkillProvider(agentDir, {
      fileAccess: {
        readFile: (path) => path === goodSkillPath
          ? Promise.resolve(`---\nname: "good"\ndescription: "A good skill."\n---\n`)
          : Promise.reject(new Error(`Unexpected file read: ${path}`)),
        isDirectory: (path) => path === globalRootPath || path === projectRootPath
          ? Promise.resolve(true)
          : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
        listDirectories: (path) => {
          if (path === globalRootPath) return Promise.resolve(["good"]);
          if (path === projectRootPath) return Promise.reject(Object.assign(new Error("listing denied"), { code: "EACCES" }));
          return Promise.reject(new Error(`Unexpected directory listing: ${path}`));
        },
      },
    });

    await expect(provider.read({ projectPath: "/work/repo" })).resolves.toEqual({
      kind: "data",
      globalSkills: [{ id: "good", name: "good", description: "A good skill.", filePath: goodSkillPath }],
      projectSkills: [],
      projectUnavailableMessage: "Project-specific learned skills could not be loaded.",
    });
  });

  it("rejects a global skills-root listing failure", async () => {
    const globalRootPath = join(agentDir, "pi-hermes-memory", "skills");
    const provider = new PiHermesLearnedSkillProvider(agentDir, {
      fileAccess: {
        readFile: () => Promise.reject(new Error("Unexpected file read")),
        isDirectory: (path) => path === globalRootPath
          ? Promise.resolve(true)
          : Promise.reject(new Error(`Unexpected directory probe: ${path}`)),
        listDirectories: (path) => path === globalRootPath
          ? Promise.reject(Object.assign(new Error("listing denied"), { code: "EACCES" }))
          : Promise.reject(new Error(`Unexpected directory listing: ${path}`)),
      },
    });

    await expect(provider.read({})).rejects.toThrow("listing denied");
  });
});
