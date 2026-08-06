import { describe, expect, it, vi } from "vitest";
import { ProjectNotFoundError, ProjectService } from "./projectService.js";
import type { ProjectStore } from "../storage/projectStore.js";
import type { Project } from "../types.js";

function project(id: string, pinned?: true): Project {
  return { id, name: id, path: `/work/${id}`, createdAt: "2026-08-06T00:00:00.000Z", ...(pinned === undefined ? {} : { pinned }) };
}

function fakeStore(setPinned: ProjectStore["setPinned"]): ProjectStore {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the pin path uses.
  return { setPinned } as unknown as ProjectStore;
}

function fakeStoreWith(overrides: Partial<Pick<ProjectStore, "remove" | "get" | "setPinned">>): ProjectStore {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface each not-found path uses.
  return overrides as unknown as ProjectStore;
}

describe("ProjectService pin state", () => {
  it("returns the reordered list when pinning succeeds", async () => {
    const ordered = [project("beta", true), project("alpha")];
    const setPinned = vi.fn().mockResolvedValue(ordered);
    const service = new ProjectService(fakeStore(setPinned));

    await expect(service.pin("beta")).resolves.toEqual(ordered);
    expect(setPinned).toHaveBeenCalledWith("beta", true);
  });

  it("returns the reordered list when unpinning succeeds", async () => {
    const ordered = [project("beta"), project("alpha", true)];
    const setPinned = vi.fn().mockResolvedValue(ordered);
    const service = new ProjectService(fakeStore(setPinned));

    await expect(service.unpin("beta")).resolves.toEqual(ordered);
    expect(setPinned).toHaveBeenCalledWith("beta", false);
  });

  it("throws Project not found when the store reports an unknown id", async () => {
    const service = new ProjectService(fakeStore(vi.fn().mockResolvedValue(undefined)));

    await expect(service.pin("missing")).rejects.toThrow("Project not found");
    await expect(service.unpin("missing")).rejects.toThrow("Project not found");
  });
});

describe("ProjectService unknown project", () => {
  it("close rejects with ProjectNotFoundError for an unknown id", async () => {
    const service = new ProjectService(fakeStoreWith({ remove: vi.fn().mockResolvedValue(false) }));

    await expect(service.close("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("close keeps the Project not found response-body message", async () => {
    const service = new ProjectService(fakeStoreWith({ remove: vi.fn().mockResolvedValue(false) }));

    await expect(service.close("missing")).rejects.toThrow("Project not found");
  });

  it("requireProject rejects with ProjectNotFoundError for an unknown id", async () => {
    const service = new ProjectService(fakeStoreWith({ get: vi.fn().mockResolvedValue(undefined) }));

    await expect(service.requireProject("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("pin rejects with ProjectNotFoundError for an unknown id", async () => {
    const service = new ProjectService(fakeStoreWith({ setPinned: vi.fn().mockResolvedValue(undefined) }));

    await expect(service.pin("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("unpin rejects with ProjectNotFoundError for an unknown id", async () => {
    const service = new ProjectService(fakeStoreWith({ setPinned: vi.fn().mockResolvedValue(undefined) }));

    await expect(service.unpin("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
