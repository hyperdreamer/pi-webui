import { describe, expect, it, vi } from "vitest";
import type { Machine, SkillInfo } from "../api";
import { SkillsConfigDialog } from "./SkillsConfigDialog";

const cwd = "/work/project-a";
const installedSkill: SkillInfo = {
  name: "testing",
  description: "Test a project safely.",
  filePath: `${cwd}/.pi/skills/testing/SKILL.md`,
  baseDir: `${cwd}/.pi/skills/testing`,
  disableModelInvocation: false,
  sourceInfo: { scope: "project" },
  install: {
    package: "owner/repo@testing",
    scope: "project",
    source: "owner/repo",
    skillPath: "skills/testing/SKILL.md",
    versionHash: "current-hash",
    canCheckForUpdates: true,
  },
};

describe("skills-config-dialog machine and workspace targeting", () => {
  it("sends list, toggle, discovery, installation, and update actions to the selected machine and workspace", async () => {
    const skillsApi = {
      list: vi.fn().mockResolvedValue({ skills: [installedSkill] }),
      toggle: vi.fn().mockResolvedValue({ success: true }),
      search: vi.fn().mockResolvedValue({ results: [{ package: "owner/repo@new-skill", installs: "1K installs", url: "https://skills.sh/owner/repo/new-skill" }] }),
      install: vi.fn().mockResolvedValue({ success: true }),
      check: vi.fn().mockResolvedValue({ updates: [{ package: "owner/repo@testing", scope: "project", state: "update-available", currentVersion: "current-hash", latestVersion: "next-hash" }] }),
      update: vi.fn().mockResolvedValue({ success: true, skill: installedSkill }),
    };
    const dialog = new SkillsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.cwd = cwd;
    dialog.skillsApi = skillsApi;

    await callDialogPromise(dialog, "loadSkills");
    await callDialogPromise(dialog, "toggleSkill", installedSkill);
    Reflect.set(dialog, "searchQuery", "testing");
    await callDialogPromise(dialog, "searchSkills");
    await callDialogPromise(dialog, "installSkill", "owner/repo@new-skill");
    await callDialogPromise(dialog, "checkForUpdates", installedSkill);
    await callDialogPromise(dialog, "updateInstalledSkill", installedSkill);

    expect(skillsApi.list).toHaveBeenCalledWith(cwd, "remote-a");
    expect(skillsApi.toggle).toHaveBeenCalledWith({
      cwd,
      filePath: installedSkill.filePath,
      disableModelInvocation: true,
    }, "remote-a");
    expect(skillsApi.search).toHaveBeenCalledWith({ query: "testing" }, "remote-a");
    expect(skillsApi.install).toHaveBeenCalledWith({
      cwd,
      package: "owner/repo@new-skill",
      scope: "global",
    }, "remote-a");
    expect(skillsApi.check).toHaveBeenCalledWith({
      cwd,
      package: "owner/repo@testing",
      scope: "project",
    }, "remote-a");
    expect(skillsApi.update).toHaveBeenCalledWith({
      cwd,
      package: "owner/repo@testing",
      scope: "project",
    }, "remote-a");
  });
});

function machine(id: string): Machine {
  return {
    id,
    name: "Remote build host",
    kind: "remote",
    baseUrl: "https://remote.example.test/",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

async function callDialogPromise(dialog: SkillsConfigDialog, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callDialogMethod(dialog, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SkillsConfigDialog.${methodName} did not return a promise`);
  await result;
}

function callDialogMethod(dialog: SkillsConfigDialog, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(dialog, methodName);
  if (!isDialogMethod(method)) throw new Error(`SkillsConfigDialog.${methodName} is not callable`);
  return method.call(dialog, ...args);
}

function isDialogMethod(value: unknown): value is (this: SkillsConfigDialog, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}
