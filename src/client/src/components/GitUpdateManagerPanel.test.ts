import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
// The node test environment has no DOM renderer. These narrow checks cover the
// component's public API boundary and its user-facing Lit click wiring.
import { templateClickHandlerForText, templateText } from "../templateInspection.testSupport";

interface GitUpdateManagerPanelModule {
  GitUpdateManagerPanel: new () => { render: () => TemplateResult; refresh: () => Promise<void> };
}

async function loadGitUpdateManagerPanel(): Promise<GitUpdateManagerPanelModule | undefined> {
  try {
    return await import("./GitUpdateManagerPanel.js");
  } catch {
    return undefined;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitUpdateManagerPanel", () => {
  it("renders a Git Update Manager with no file-management actions", async () => {
    const module = await loadGitUpdateManagerPanel();
    expect(module).toBeDefined();
    if (module === undefined) return;

    const panel = new module.GitUpdateManagerPanel();
    const rendered = templateText(panel.render());

    expect(rendered).toContain("Git Update Manager");
    expect(rendered).toContain("Refresh changes");
    expect(rendered).not.toContain("New file");
    expect(rendered).not.toContain("New folder");
    expect(rendered).not.toContain("Rename");
    expect(rendered).not.toContain("Delete");
  });

  it("loads the current workspace status and renders separate staged and unstaged entries", async () => {
    const module = await loadGitUpdateManagerPanel();
    expect(module).toBeDefined();
    if (module === undefined) return;

    const gitStatus = vi.fn(() => Promise.resolve(status([
      { path: "src/staged.ts", index: "modified", workingTree: "unmodified" },
      { path: "notes.md", index: "untracked", workingTree: "untracked" },
    ])));
    const panel = new module.GitUpdateManagerPanel();
    Reflect.set(panel, "workspace", workspace());
    Reflect.set(panel, "machineId", "remote-1");
    Reflect.set(panel, "api", { gitStatus });

    await panel.refresh();

    expect(gitStatus).toHaveBeenCalledWith("project-1", "workspace-1", "remote-1");
    const rendered = templateText(panel.render());
    expect(rendered).toContain("Staged (1)");
    expect(rendered).toContain("Unstaged (1)");
    expect(rendered).toContain("M");
    expect(rendered).toContain("?");
    expect(rendered).toContain("src/staged.ts");
    expect(rendered).toContain("notes.md");
  });

  it("reports refreshed status so the host can update its Git badge", async () => {
    const module = await loadGitUpdateManagerPanel();
    expect(module).toBeDefined();
    if (module === undefined) return;

    const refreshedStatus = status([{ path: "src/changed.ts", index: "modified", workingTree: "unmodified" }]);
    const onStatusChange = vi.fn();
    const panel = new module.GitUpdateManagerPanel();
    Reflect.set(panel, "workspace", workspace());
    Reflect.set(panel, "onStatusChange", onStatusChange);
    Reflect.set(panel, "api", { gitStatus: vi.fn(() => Promise.resolve(refreshedStatus)) });

    await panel.refresh();

    expect(onStatusChange).toHaveBeenCalledWith(refreshedStatus);
  });

  it("requests the selected scope's diff and identifies it as staged", async () => {
    const module = await loadGitUpdateManagerPanel();
    expect(module).toBeDefined();
    if (module === undefined) return;

    const gitStatus = vi.fn(() => Promise.resolve(status([
      { path: "src/staged.ts", index: "modified", workingTree: "unmodified" },
    ])));
    const gitDiff = vi.fn(() => Promise.resolve({
      path: "src/staged.ts",
      staged: true,
      hash: "diff-hash",
      diff: "diff --git a/src/staged.ts b/src/staged.ts\n--- a/src/staged.ts\n+++ b/src/staged.ts\n@@ -1 +1 @@\n-before\n+after\n",
      truncated: false,
    }));
    const panel = new module.GitUpdateManagerPanel();
    Reflect.set(panel, "workspace", workspace());
    Reflect.set(panel, "machineId", "remote-1");
    Reflect.set(panel, "api", { gitStatus, gitDiff });
    await panel.refresh();

    templateClickHandlerForText(panel.render(), "src/staged.ts")(new Event("click"));
    await Promise.resolve();

    expect(gitDiff).toHaveBeenCalledWith("project-1", "workspace-1", { path: "src/staged.ts", staged: true }, "remote-1");
    const rendered = templateText(panel.render());
    expect(rendered).toContain("Staged");
    expect(rendered).toContain("Modified");
    expect(rendered).toContain("unified-diff-viewer");
  });

  it("shows a completed diff-load error instead of a perpetual loading message", async () => {
    const module = await loadGitUpdateManagerPanel();
    expect(module).toBeDefined();
    if (module === undefined) return;

    const gitStatus = vi.fn(() => Promise.resolve(status([
      { path: "src/staged.ts", index: "modified", workingTree: "unmodified" },
    ])));
    const panel = new module.GitUpdateManagerPanel();
    Reflect.set(panel, "workspace", workspace());
    Reflect.set(panel, "api", { gitStatus, gitDiff: vi.fn(() => Promise.reject(new Error("Diff unavailable"))) });
    await panel.refresh();

    templateClickHandlerForText(panel.render(), "src/staged.ts")(new Event("click"));
    await Promise.resolve();
    await Promise.resolve();

    const rendered = templateText(panel.render());
    expect(rendered).toContain("Diff unavailable");
    expect(rendered).not.toContain("Loading src/staged.ts…");
  });

  it("keeps a valid selected change and reloads its diff when refreshed", async () => {
    const module = await loadGitUpdateManagerPanel();
    expect(module).toBeDefined();
    if (module === undefined) return;

    const gitStatus = vi.fn(() => Promise.resolve(status([
      { path: "notes.md", index: "untracked", workingTree: "untracked" },
    ])));
    const gitDiff = vi.fn(() => Promise.resolve({ path: "notes.md", staged: false, hash: "diff-hash", diff: "diff --git a/notes.md b/notes.md\n", truncated: false }));
    const panel = new module.GitUpdateManagerPanel();
    Reflect.set(panel, "workspace", workspace());
    Reflect.set(panel, "api", { gitStatus, gitDiff });
    await panel.refresh();

    templateClickHandlerForText(panel.render(), "notes.md")(new Event("click"));
    await Promise.resolve();
    await panel.refresh();

    expect(gitDiff).toHaveBeenCalledTimes(2);
    expect(Reflect.get(panel, "selectedChange")).toMatchObject({ path: "notes.md", scope: "unstaged" });
  });

  it("shows a status-load error without leaving stale change rows", async () => {
    const module = await loadGitUpdateManagerPanel();
    expect(module).toBeDefined();
    if (module === undefined) return;

    const panel = new module.GitUpdateManagerPanel();
    Reflect.set(panel, "workspace", workspace());
    Reflect.set(panel, "api", { gitStatus: vi.fn(() => Promise.reject(new Error("Git unavailable"))) });

    await expect(panel.refresh()).resolves.toBeUndefined();
    expect(templateText(panel.render())).toContain("Git unavailable");
  });
});

function status(files: readonly { path: string; oldPath?: string; index: string; workingTree: string }[]) {
  return { isGitRepo: true, hash: "status-hash", branch: "main", files };
}

function workspace() {
  return { id: "workspace-1", projectId: "project-1", path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false };
}
