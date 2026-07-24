import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillInfo } from "../../shared/apiTypes.js";
import { SkillsConfigNotFoundError, SkillsConfigService } from "./skillsConfigService.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("SkillsConfigService", () => {
  it("toggles disable-model-invocation only for a skill loaded in the selected workspace", async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const filePath = join(cwd, ".pi", "skills", "testing", "SKILL.md");
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, "---\nname: testing\n---\nTest safely.\n", "utf8");
    const loadedSkill: SkillInfo = {
      name: "testing",
      description: "Test safely.",
      filePath,
      baseDir: join(filePath, ".."),
      disableModelInvocation: false,
      sourceInfo: { scope: "project" },
    };
    const loadSkills = vi.fn().mockResolvedValue([loadedSkill]);
    const skills = new SkillsConfigService({ agentDir, loadSkills });

    await expect(skills.toggle({ cwd, filePath, disableModelInvocation: true })).resolves.toEqual({ success: true });
    await expect(readFile(filePath, "utf8")).resolves.toBe("---\ndisable-model-invocation: true\nname: testing\n---\nTest safely.\n");
    await expect(skills.toggle({ cwd, filePath, disableModelInvocation: false })).resolves.toEqual({ success: true });
    await expect(readFile(filePath, "utf8")).resolves.toBe("---\nname: testing\n---\nTest safely.\n");
    expect(loadSkills).toHaveBeenCalledWith(cwd, agentDir);
  });

  it("replaces an explicit false toggle with one parsable true frontmatter key", async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const filePath = join(cwd, ".pi", "skills", "testing", "SKILL.md");
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, "---\nname: testing\ndisable-model-invocation: false\n---\nTest safely.\n", "utf8");
    const loadedSkill: SkillInfo = {
      name: "testing",
      description: "Test safely.",
      filePath,
      baseDir: join(filePath, ".."),
      disableModelInvocation: false,
      sourceInfo: { scope: "project" },
    };
    const skills = new SkillsConfigService({ agentDir, loadSkills: () => Promise.resolve([loadedSkill]) });

    await expect(skills.toggle({ cwd, filePath, disableModelInvocation: true })).resolves.toEqual({ success: true });

    const updated = await readFile(filePath, "utf8");
    expect(updated).toBe("---\nname: testing\ndisable-model-invocation: true\n---\nTest safely.\n");
    expect(parseFrontmatter(updated).frontmatter).toMatchObject({
      name: "testing",
      "disable-model-invocation": true,
    });
  });

  it("rejects a toggle request for a path that the selected workspace did not load", async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, "project");
    const skills = new SkillsConfigService({ agentDir: join(root, "agent"), loadSkills: () => Promise.resolve([]) });

    await expect(skills.toggle({
      cwd,
      filePath: join(cwd, ".pi", "skills", "unloaded", "SKILL.md"),
      disableModelInvocation: true,
    })).rejects.toBeInstanceOf(SkillsConfigNotFoundError);
  });

  it("returns parsable CLI results when skills.sh and the CLI both fail after producing output", async () => {
    const cliError = Object.assign(new Error("skills find exited unsuccessfully"), {
      stdout: "owner/repo@testing  2K installs\n└ https://skills.sh/owner/repo/testing\n",
      stderr: "",
    });
    const skills = new SkillsConfigService({
      agentDir: "/agent",
      loadSkills: () => Promise.resolve([]),
      fetcher: () => Promise.resolve(new Response("Unavailable", { status: 503 })),
      runNpx: () => Promise.reject(cliError),
    });

    await expect(skills.search({ query: "testing", limit: 1 })).resolves.toEqual({
      results: [{
        package: "owner/repo@testing",
        installs: "2K installs",
        url: "https://skills.sh/owner/repo/testing",
      }],
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-skills-config-service-"));
  temporaryDirectories.push(directory);
  return directory;
}
