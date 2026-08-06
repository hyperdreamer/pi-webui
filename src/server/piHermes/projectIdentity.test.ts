import { describe, expect, it } from "vitest";
import {
  resolvePiHermesProjectName,
  type PiHermesProjectIdentityAccess,
} from "./projectIdentity.js";

const AGENT_DIR = "/agent";
const HOME_DIR = "/home/user";

type FakeAccessEntry = "directory" | { file: string } | { error: NodeJS.ErrnoException };

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/**
 * In-memory stand-in for the Node adapter: ENOENT/ENOTDIR become "missing",
 * permission and I/O failures propagate.
 */
function fakeAccess(entries: Record<string, FakeAccessEntry>): PiHermesProjectIdentityAccess {
  return {
    pathKind(path) {
      const entry = entries[path];
      if (entry === undefined) return Promise.resolve("missing");
      if (typeof entry === "string") return Promise.resolve("directory");
      if ("error" in entry) {
        if (entry.error.code === "ENOENT" || entry.error.code === "ENOTDIR") return Promise.resolve("missing");
        return Promise.reject(entry.error);
      }
      return Promise.resolve("file");
    },
    readFile(path) {
      const entry = entries[path];
      if (entry === undefined || typeof entry === "string") {
        return Promise.reject(errnoError("ENOENT", `ENOENT: no such file or directory, open '${path}'`));
      }
      if ("error" in entry) return Promise.reject(entry.error);
      return Promise.resolve(entry.file);
    },
  };
}

describe("resolvePiHermesProjectName", () => {
  const resolutionCases: {
    name: string;
    projectPath: string;
    entries: Record<string, FakeAccessEntry>;
    expected: string;
  }[] = [
    {
      name: "resolves a .git directory above the working directory to the repo root",
      projectPath: "/work/main/src",
      entries: { "/work/main/.git": "directory" },
      expected: "main",
    },
    {
      name: "resolves a linked worktree through its commondir to the shared repo root",
      projectPath: "/work/feature",
      entries: {
        "/work/feature/.git": { file: "gitdir: /work/main/.git/worktrees/feature\n" },
        "/work/main/.git/worktrees/feature/commondir": { file: "../..\n" },
      },
      expected: "main",
    },
    {
      name: "resolves a relative gitdir pointer against the worktree root",
      projectPath: "/work/feature",
      entries: {
        "/work/feature/.git": { file: "gitdir: ../main/.git/worktrees/feature\n" },
        "/work/main/.git/worktrees/feature/commondir": { file: "../..\n" },
      },
      expected: "main",
    },
    {
      name: "resolves an older worktree layout without commondir two levels up",
      projectPath: "/work/feature",
      entries: {
        "/work/feature/.git": { file: "gitdir: /work/main/.git/worktrees/feature\n" },
      },
      expected: "main",
    },
    {
      name: "falls back to the working directory basename outside a Git repository",
      projectPath: "/work/feature",
      entries: {},
      expected: "feature",
    },
    {
      name: "falls back to the worktree root when the gitdir pointer is malformed",
      projectPath: "/work/feature",
      entries: {
        "/work/feature/.git": { file: "This is not a gitdir pointer\n" },
      },
      expected: "feature",
    },
    {
      name: "falls back to the worktree root when the gitdir target is not a worktrees layout",
      projectPath: "/work/feature",
      entries: {
        "/work/feature/.git": { file: "gitdir: /work/other/.git\n" },
      },
      expected: "feature",
    },
    {
      name: "keeps the repo name when the working directory is the repository root",
      projectPath: "/work/main",
      entries: { "/work/main/.git": "directory" },
      expected: "main",
    },
    {
      name: "keeps the cwd-basename store when it exists and the repo-named store is absent",
      projectPath: "/work/feature",
      entries: {
        "/work/feature/.git": { file: "gitdir: /work/main/.git/worktrees/feature\n" },
        "/work/main/.git/worktrees/feature/commondir": { file: "../..\n" },
        "/agent/projects-memory/feature": "directory",
      },
      expected: "feature",
    },
    {
      name: "adopts the repo name when both the repo-named and cwd-basename stores exist",
      projectPath: "/work/feature",
      entries: {
        "/work/feature/.git": { file: "gitdir: /work/main/.git/worktrees/feature\n" },
        "/work/main/.git/worktrees/feature/commondir": { file: "../..\n" },
        "/agent/projects-memory/feature": "directory",
        "/agent/projects-memory/main": "directory",
      },
      expected: "main",
    },
  ];

  it.each(resolutionCases)("$name", async ({ projectPath, entries, expected }) => {
    await expect(
      resolvePiHermesProjectName({ agentDir: AGENT_DIR, projectPath, homeDir: HOME_DIR }, fakeAccess(entries)),
    ).resolves.toBe(expected);
  });

  it.each([
    { name: "the filesystem root", projectPath: "/" },
    { name: "the supplied home directory", projectPath: HOME_DIR },
    { name: "the supplied home directory with a trailing slash", projectPath: `${HOME_DIR}/` },
    { name: "the current-directory reference", projectPath: "." },
    { name: "the parent-directory reference", projectPath: ".." },
  ])("returns undefined for $name", async ({ projectPath }) => {
    await expect(
      resolvePiHermesProjectName({ agentDir: AGENT_DIR, projectPath, homeDir: HOME_DIR }),
    ).resolves.toBeUndefined();
  });

  it("treats ENOTDIR as missing while walking parents", async () => {
    await expect(
      resolvePiHermesProjectName(
        { agentDir: AGENT_DIR, projectPath: "/work/main/src", homeDir: HOME_DIR },
        fakeAccess({ "/work/main/.git": { error: errnoError("ENOTDIR", "not a directory") } }),
      ),
    ).resolves.toBe("src");
  });

  it("rejects a non-ENOENT pathKind error while probing .git", async () => {
    await expect(
      resolvePiHermesProjectName(
        { agentDir: AGENT_DIR, projectPath: "/work/main/src", homeDir: HOME_DIR },
        fakeAccess({ "/work/main/.git": { error: errnoError("EACCES", "denied") } }),
      ),
    ).rejects.toThrow("denied");
  });

  it("rejects a non-ENOENT commondir read error", async () => {
    await expect(
      resolvePiHermesProjectName(
        { agentDir: AGENT_DIR, projectPath: "/work/feature", homeDir: HOME_DIR },
        fakeAccess({
          "/work/feature/.git": { file: "gitdir: /work/main/.git/worktrees/feature\n" },
          "/work/main/.git/worktrees/feature/commondir": { error: errnoError("EACCES", "commondir denied") },
        }),
      ),
    ).rejects.toThrow("commondir denied");
  });
});
