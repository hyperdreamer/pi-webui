import { describe, expect, it } from "vitest";
import { gitSummary } from "./panels.js";

describe("gitSummary", () => {
  it("separates the branch and latest tag for the Git summary", () => {
    expect(gitSummary({
      isGitRepo: true,
      hash: "abc123",
      branch: "main",
      latestTag: "v1.4.0",
      files: [],
    })).toEqual({
      branch: "main",
      latestTag: "v1.4.0",
    });
  });
});
