import { describe, expect, it } from "vitest";
import { resolveSkillsGitHubToken } from "./skillsGithubToken.js";

describe("resolveSkillsGitHubToken", () => {
  it("falls back to GH_TOKEN when GITHUB_TOKEN is empty", () => {
    expect(resolveSkillsGitHubToken({ GITHUB_TOKEN: "", GH_TOKEN: "fallback-token" })).toBe("fallback-token");
  });

  it("prefers a nonempty GITHUB_TOKEN", () => {
    expect(resolveSkillsGitHubToken({ GITHUB_TOKEN: "primary-token", GH_TOKEN: "fallback-token" })).toBe("primary-token");
  });
});
