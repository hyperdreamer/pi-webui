import { describe, expect, it, vi } from "vitest";
import { MemoryLoadController } from "./memoryLoadController.js";
import type { MemoryEntry } from "./memoryData.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise is unavailable");
      resolvePromise(value);
    },
    reject(error) {
      if (rejectPromise === undefined) throw new Error("Deferred promise is unavailable");
      rejectPromise(error);
    },
  };
}

function entry(id: string): MemoryEntry {
  return { id, content: `Memory ${id}` };
}

describe("MemoryLoadController", () => {
  it("loads project memories for exactly the active workspace path", async () => {
    const global = deferred<MemoryEntry[]>();
    const project = deferred<MemoryEntry[]>();
    const fetchGlobalMemories = vi.fn(() => global.promise);
    const fetchProjectMemories = vi.fn((projectPath: string) => {
      expect(projectPath).toBe("/workspaces/active");
      return project.promise;
    });
    const controller = new MemoryLoadController({ fetchGlobalMemories, fetchProjectMemories });

    const result = controller.load("/workspaces/active");

    expect(fetchProjectMemories).toHaveBeenCalledOnce();
    expect(fetchProjectMemories).toHaveBeenCalledWith("/workspaces/active");

    global.resolve([entry("global")]);
    project.resolve([entry("project-active")]);

    await expect(result).resolves.toEqual({
      kind: "loaded",
      globalEntries: [entry("global")],
      projectEntries: [entry("project-active")],
    });
  });

  it("suppresses a late workspace-A result after workspace-B begins loading", async () => {
    const globalA = deferred<MemoryEntry[]>();
    const projectA = deferred<MemoryEntry[]>();
    const globalB = deferred<MemoryEntry[]>();
    const projectB = deferred<MemoryEntry[]>();
    const fetchGlobalMemories = vi
      .fn<() => Promise<MemoryEntry[]>>()
      .mockReturnValueOnce(globalA.promise)
      .mockReturnValueOnce(globalB.promise);
    const fetchProjectMemories = vi
      .fn<(projectPath: string) => Promise<MemoryEntry[]>>()
      .mockReturnValueOnce(projectA.promise)
      .mockReturnValueOnce(projectB.promise);
    const controller = new MemoryLoadController({ fetchGlobalMemories, fetchProjectMemories });

    const workspaceAResult = controller.load("/workspaces/a");
    const workspaceBResult = controller.load("/workspaces/b");

    expect(fetchProjectMemories).toHaveBeenNthCalledWith(1, "/workspaces/a");
    expect(fetchProjectMemories).toHaveBeenNthCalledWith(2, "/workspaces/b");

    globalB.resolve([entry("global-b")]);
    projectB.resolve([entry("project-b")]);
    await expect(workspaceBResult).resolves.toEqual({
      kind: "loaded",
      globalEntries: [entry("global-b")],
      projectEntries: [entry("project-b")],
    });

    globalA.resolve([entry("global-a")]);
    projectA.resolve([entry("project-a")]);
    await expect(workspaceAResult).resolves.toBeUndefined();
  });

  it("retains global entries and reports the generic scoped message when project loading fails", async () => {
    const global = deferred<MemoryEntry[]>();
    const project = deferred<MemoryEntry[]>();
    const controller = new MemoryLoadController({
      fetchGlobalMemories: () => global.promise,
      fetchProjectMemories: () => project.promise,
    });

    const result = controller.load("/workspaces/active");
    global.resolve([entry("global")]);
    project.reject(new Error("Project route unavailable"));

    await expect(result).resolves.toEqual({
      kind: "loaded",
      globalEntries: [entry("global")],
      projectEntries: [],
      projectUnavailableMessage: "Project-specific memory could not be loaded.",
    });
  });

  it("returns a panel-level error when global loading fails", async () => {
    const global = deferred<MemoryEntry[]>();
    const project = deferred<MemoryEntry[]>();
    const controller = new MemoryLoadController({
      fetchGlobalMemories: () => global.promise,
      fetchProjectMemories: () => project.promise,
    });

    const result = controller.load("/workspaces/active");
    project.resolve([entry("project")]);
    global.reject(new Error("Global route unavailable"));

    await expect(result).resolves.toEqual({
      kind: "global-error",
      message: "Global route unavailable",
    });
  });

  it("suppresses a started result after invalidation", async () => {
    const global = deferred<MemoryEntry[]>();
    const project = deferred<MemoryEntry[]>();
    const controller = new MemoryLoadController({
      fetchGlobalMemories: () => global.promise,
      fetchProjectMemories: () => project.promise,
    });

    const result = controller.load("/workspaces/active");
    controller.invalidate();
    global.resolve([entry("global")]);
    project.resolve([entry("project")]);

    await expect(result).resolves.toBeUndefined();
  });
});
