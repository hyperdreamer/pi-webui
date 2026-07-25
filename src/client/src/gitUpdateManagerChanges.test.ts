import { describe, expect, it } from "vitest";
import type { GitStatusFile } from "./api";

interface GitUpdateManagerChangesModule {
  gitStatusIndicator(state: GitStatusFile["index"]): string;
  gitStatusLabel(state: GitStatusFile["index"]): string;
  gitUpdateManagerChangeCount(files: readonly GitStatusFile[]): number;
  gitUpdateChanges(files: readonly GitStatusFile[]): {
    staged: readonly { id: string; path: string; oldPath?: string; scope: "staged" | "unstaged"; state: GitStatusFile["index"] }[];
    unstaged: readonly { id: string; path: string; oldPath?: string; scope: "staged" | "unstaged"; state: GitStatusFile["index"] }[];
  };
}

async function loadGitUpdateManagerChanges(): Promise<GitUpdateManagerChangesModule | undefined> {
  try {
    return await import("./gitUpdateManagerChanges.js");
  } catch {
    return undefined;
  }
}

describe("gitUpdateManagerChanges", () => {
  it("splits staged and unstaged changes while retaining Git statuses and rename sources", async () => {
    const module = await loadGitUpdateManagerChanges();
    expect(module).toBeDefined();
    if (module === undefined) return;

    const changes = module.gitUpdateChanges([
      { path: "src/both.ts", index: "modified", workingTree: "modified" },
      { path: "src/renamed.ts", oldPath: "src/original.ts", index: "renamed", workingTree: "unmodified" },
      { path: "new-file.md", index: "untracked", workingTree: "untracked" },
      { path: "removed.txt", index: "unmodified", workingTree: "deleted" },
      { path: "ignored.log", index: "ignored", workingTree: "ignored" },
    ]);

    expect(changes.staged).toEqual([
      { id: "staged:src/both.ts", path: "src/both.ts", scope: "staged", state: "modified" },
      { id: "staged:src/renamed.ts", path: "src/renamed.ts", oldPath: "src/original.ts", scope: "staged", state: "renamed" },
    ]);
    expect(changes.unstaged).toEqual([
      { id: "unstaged:src/both.ts", path: "src/both.ts", scope: "unstaged", state: "modified" },
      { id: "unstaged:new-file.md", path: "new-file.md", scope: "unstaged", state: "untracked" },
      { id: "unstaged:removed.txt", path: "removed.txt", scope: "unstaged", state: "deleted" },
    ]);
  });

  it("uses recognizable indicators and labels for every visible Git state", async () => {
    const module = await loadGitUpdateManagerChanges();
    expect(module).toBeDefined();
    if (module === undefined) return;

    expect(module.gitStatusIndicator("modified")).toBe("M");
    expect(module.gitStatusIndicator("added")).toBe("A");
    expect(module.gitStatusIndicator("deleted")).toBe("D");
    expect(module.gitStatusIndicator("renamed")).toBe("R");
    expect(module.gitStatusIndicator("copied")).toBe("C");
    expect(module.gitStatusIndicator("untracked")).toBe("?");
    expect(module.gitStatusIndicator("conflicted")).toBe("U");
    expect(module.gitStatusLabel("renamed")).toBe("Renamed");
  });

  it("counts each visible changed path once even when it has staged and unstaged work", async () => {
    const module = await loadGitUpdateManagerChanges();
    expect(module).toBeDefined();
    if (module === undefined) return;

    expect(module.gitUpdateManagerChangeCount([
      { path: "src/both.ts", index: "modified", workingTree: "modified" },
      { path: "added.ts", index: "added", workingTree: "unmodified" },
      { path: "ignored.log", index: "ignored", workingTree: "ignored" },
    ])).toBe(2);
  });

  it("shows conflicted files only as unresolved unstaged work", async () => {
    const module = await loadGitUpdateManagerChanges();
    expect(module).toBeDefined();
    if (module === undefined) return;

    expect(module.gitUpdateChanges([
      { path: "merge.ts", index: "conflicted", workingTree: "conflicted" },
    ])).toEqual({
      staged: [],
      unstaged: [{ id: "unstaged:merge.ts", path: "merge.ts", scope: "unstaged", state: "conflicted" }],
    });
  });
});
