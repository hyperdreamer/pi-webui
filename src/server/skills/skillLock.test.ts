import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillInfo } from "../../shared/apiTypes.js";
import { annotateSkillsWithInstallInfo, getGlobalSkillsLockPath } from "./skillLock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("skill lock provenance", () => {
  it("uses the skills CLI global lock locations", () => {
    expect(getGlobalSkillsLockPath({ homeDir: "/home/test", xdgStateHome: undefined })).toBe(join("/home/test", ".agents", ".skill-lock.json"));
    expect(getGlobalSkillsLockPath({ homeDir: "/home/test", xdgStateHome: "/state" })).toBe(join("/state", "skills", ".skill-lock.json"));
  });

  it("annotates live lock entries only when they are in the matching Pi install scope", async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, "project");
    const agentDir = join(root, "home", ".pi", "agent");
    const globalLockPath = join(root, "global-lock.json");
    const projectLockPath = join(cwd, "skills-lock.json");
    const globalSkillPath = join(agentDir, "skills", "edge-tts", "SKILL.md");
    const projectSkillPath = join(cwd, ".pi", "skills", "find-skills", "SKILL.md");
    const manualSkillPath = join(agentDir, "skills", "manual", "SKILL.md");
    const otherAgentSkillPath = join(root, "other-agent", "tts", "SKILL.md");

    await Promise.all([globalSkillPath, projectSkillPath, manualSkillPath, otherAgentSkillPath].map(async (path) => {
      await writeSkill(path);
    }));
    await writeJson(globalLockPath, {
      version: 3,
      skills: {
        "edge-tts": {
          source: "https://github.com/aahl/skills.git",
          sourceType: "github",
          skillPath: "skills/edge-tts/SKILL.md",
          skillFolderHash: "global-version",
        },
      },
    });
    await writeJson(projectLockPath, {
      version: 1,
      skills: {
        "find-skills": {
          source: "vercel-labs/skills",
          sourceType: "github",
          skillPath: "skills/find-skills/SKILL.md",
          computedHash: "project-version",
        },
      },
    });

    const annotated = annotateSkillsWithInstallInfo([
      skill("edge-tts", globalSkillPath, "user"),
      skill("find-skills", projectSkillPath, "project"),
      skill("manual", manualSkillPath, "user"),
      skill("tts", otherAgentSkillPath, "user"),
    ], { cwd, agentDir, globalLockPath, projectLockPath });

    expect(annotated[0]?.install).toEqual({
      package: "aahl/skills@edge-tts",
      scope: "global",
      source: "aahl/skills",
      sourceType: "github",
      skillsShUrl: "https://skills.sh/aahl/skills/edge-tts",
      skillPath: "skills/edge-tts/SKILL.md",
      versionHash: "global-version",
      canCheckForUpdates: true,
    });
    expect(annotated[1]?.install).toEqual({
      package: "vercel-labs/skills@find-skills",
      scope: "project",
      source: "vercel-labs/skills",
      sourceType: "github",
      skillsShUrl: "https://skills.sh/vercel-labs/skills/find-skills",
      skillPath: "skills/find-skills/SKILL.md",
      versionHash: "project-version",
      canCheckForUpdates: true,
    });
    expect(annotated[2]?.install).toBeUndefined();
    expect(annotated[3]?.install).toBeUndefined();
  });

  it("ignores malformed nested entries while retaining valid provenance", async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const globalLockPath = join(root, "global-lock.json");
    const nullEntryPath = join(agentDir, "skills", "null-entry", "SKILL.md");
    const stringEntryPath = join(agentDir, "skills", "string-entry", "SKILL.md");
    const numberEntryPath = join(agentDir, "skills", "number-entry", "SKILL.md");
    const arrayEntryPath = join(agentDir, "skills", "array-entry", "SKILL.md");
    const validEntryPath = join(agentDir, "skills", "valid-entry", "SKILL.md");
    await Promise.all([nullEntryPath, stringEntryPath, numberEntryPath, arrayEntryPath, validEntryPath].map(async (path) => {
      await writeSkill(path);
    }));
    await writeJson(globalLockPath, {
      skills: {
        "null-entry": null,
        "string-entry": "not a lock entry",
        "number-entry": 1,
        "array-entry": [],
        "valid-entry": {
          source: "owner/repo",
          sourceType: "github",
          skillPath: "skills/valid-entry/SKILL.md",
          skillFolderHash: "valid-version",
        },
      },
    });

    const [nullEntry, stringEntry, numberEntry, arrayEntry, validEntry] = annotateSkillsWithInstallInfo([
      skill("null-entry", nullEntryPath, "user"),
      skill("string-entry", stringEntryPath, "user"),
      skill("number-entry", numberEntryPath, "user"),
      skill("array-entry", arrayEntryPath, "user"),
      skill("valid-entry", validEntryPath, "user"),
    ], { cwd, agentDir, globalLockPath });

    expect([nullEntry?.install, stringEntry?.install, numberEntry?.install, arrayEntry?.install]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(validEntry?.install).toEqual({
      package: "owner/repo@valid-entry",
      scope: "global",
      source: "owner/repo",
      sourceType: "github",
      skillsShUrl: "https://skills.sh/owner/repo/valid-entry",
      skillPath: "skills/valid-entry/SKILL.md",
      versionHash: "valid-version",
      canCheckForUpdates: true,
    });
  });

  it("ignores stale and malformed locks and does not compare a project ref with the default snapshot", async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const globalLockPath = join(root, "global-lock.json");
    const projectLockPath = join(cwd, "skills-lock.json");
    const missingSkillPath = join(agentDir, "skills", "missing", "SKILL.md");
    const projectSkillPath = join(cwd, ".pi", "skills", "preview", "SKILL.md");
    await writeSkill(projectSkillPath);
    await writeJson(globalLockPath, { skills: { missing: { source: "owner/repo", sourceType: "github" } } });
    await writeJson(projectLockPath, {
      skills: {
        preview: {
          source: "owner/repo",
          sourceType: "github",
          skillPath: "skills/preview/SKILL.md",
          ref: "preview",
          computedHash: "project-version",
        },
      },
    });

    const [missing, preview] = annotateSkillsWithInstallInfo([
      skill("missing", missingSkillPath, "user"),
      skill("preview", projectSkillPath, "project"),
    ], { cwd, agentDir, globalLockPath, projectLockPath });

    expect(missing?.install).toBeUndefined();
    expect(preview?.install).toMatchObject({ ref: "preview", canCheckForUpdates: false });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-skill-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "---\nname: test\n---\n", "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function skill(name: string, filePath: string, scope: string): SkillInfo {
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: filePath.slice(0, -"/SKILL.md".length),
    disableModelInvocation: false,
    sourceInfo: { scope },
  };
}
