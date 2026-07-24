import { describe, expect, it } from "vitest";
import { sanitizedGitEnv } from "./gitEnv.js";

describe("sanitizedGitEnv", () => {
  it("removes repository-local Git variables inherited from hooks", () => {
    const env = sanitizedGitEnv({
      PATH: "/bin",
      GIT_DIR: "/repo/.git",
      GIT_WORK_TREE: "/repo",
      GIT_INDEX_FILE: "/repo/.git/index.lock",
      GIT_PREFIX: "src/",
      GIT_COMMON_DIR: "/repo/.git",
    });

    expect(env).toEqual({ PATH: "/bin" });
  });
});
