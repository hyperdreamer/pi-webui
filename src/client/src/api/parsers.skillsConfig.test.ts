import { describe, expect, it } from "vitest";
import { parseSkillsCheckResponse, parseSkillsResponse, parseSkillUpdateResponse } from "./parsers";

const installedSkill = {
  name: "testing",
  description: "Test a project safely.",
  filePath: "/repo/.pi/skills/testing/SKILL.md",
  baseDir: "/repo/.pi/skills/testing",
  disableModelInvocation: false,
  sourceInfo: { scope: "project" },
  install: {
    package: "owner/repo@testing",
    scope: "project",
    source: "owner/repo",
    sourceType: "github",
    skillsShUrl: "https://skills.sh/owner/repo/testing",
    skillPath: "skills/testing/SKILL.md",
    versionHash: "current-hash",
    canCheckForUpdates: true,
  },
};

describe("Skills configuration response parsers", () => {
  it("parses resource-loader skills, install provenance, and update results", () => {
    expect(parseSkillsResponse({ skills: [installedSkill] })).toEqual({ skills: [installedSkill] });
    expect(parseSkillsCheckResponse({
      updates: [{
        package: "owner/repo@testing",
        scope: "project",
        state: "update-available",
        currentVersion: "current-hash",
        latestVersion: "next-hash",
      }],
    })).toEqual({
      updates: [{
        package: "owner/repo@testing",
        scope: "project",
        state: "update-available",
        currentVersion: "current-hash",
        latestVersion: "next-hash",
      }],
    });
    expect(parseSkillUpdateResponse({ success: true, skill: installedSkill, output: "Installed 1 skill" })).toEqual({
      success: true,
      skill: installedSkill,
      output: "Installed 1 skill",
    });
  });

  it("rejects malformed skill payloads before they reach the Skills dialog", () => {
    expect(() => parseSkillsResponse({
      skills: [{ ...installedSkill, disableModelInvocation: "false" }],
    })).toThrow("disableModelInvocation");
    expect(() => parseSkillsCheckResponse({
      updates: [{ package: "owner/repo@testing", scope: "project", state: "unknown" }],
    })).toThrow("skill update state");
  });
});
