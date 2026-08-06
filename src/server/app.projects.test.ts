import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Project, Workspace } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import { buildApp } from "./app.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";

registerAppTestHooks();

describe("buildApp project routes", () => {
  it("adds, lists, and closes projects through the HTTP contract", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Example", path: appTestContext.projectDir, create: true },
    });

    expect(addResponse.statusCode).toBe(200);
    const project = addResponse.json<Project>();
    expect(project).toMatchObject({ name: "Example", path: appTestContext.projectDir });
    expect(project.id).not.toBe("");

    const listResponse = await appTestContext.app.inject({ method: "GET", url: "/api/projects" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<Project[]>()).toEqual([project]);

    const closeResponse = await appTestContext.app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(closeResponse.statusCode).toBe(200);
    expect(closeResponse.json()).toEqual({ closed: true });

    const emptyListResponse = await appTestContext.app.inject({ method: "GET", url: "/api/projects" });
    expect(emptyListResponse.json<Project[]>()).toEqual([]);
  });

  it("returns stable errors for invalid project requests", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Missing", path: join(appTestContext.tempDir, "missing") },
    });

    expect(addResponse.statusCode).toBe(400);
    expect(addResponse.json()).toHaveProperty("error");

    const closeResponse = await appTestContext.app.inject({ method: "DELETE", url: "/api/projects/does-not-exist" });
    expect(closeResponse.statusCode).toBe(404);
    expect(closeResponse.json()).toEqual({ error: "Project not found" });
  });

  it("lists a non-git project as a single workspace", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Plain", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<Workspace[]>()).toEqual([
      expect.objectContaining({
        projectId: project.id,
        path: appTestContext.projectDir,
        label: "Plain",
        isMain: true,
        isGitRepo: false,
        isGitWorktree: false,
      }),
    ]);
  });

  it("exposes the default upload config on workspace responses", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Upload Defaults", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<Workspace[]>()).toEqual([
      expect.objectContaining({
        projectId: project.id,
        effectiveConfig: { uploads: { defaultFolder: ".pi-webui/uploads" } },
      }),
    ]);
  });

  it("lets project-local upload config override global upload config on workspace responses", async () => {
    appTestContext.piWebUiConfig = { uploads: { defaultFolder: "global-uploads" } };
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Project Upload Defaults", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    await mkdir(join(appTestContext.projectDir, ".pi-webui"), { recursive: true });
    await writeFile(join(appTestContext.projectDir, ".pi-webui", "config.json"), `${JSON.stringify({ version: 1, uploads: { defaultFolder: "project-uploads" } }, null, 2)}\n`);

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<Workspace[]>()).toEqual([
      expect.objectContaining({
        projectId: project.id,
        effectiveConfig: { uploads: { defaultFolder: "project-uploads" } },
      }),
    ]);
  });

  it("pins a project, returning the reordered list", async () => {
    const first = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "First", path: join(appTestContext.tempDir, "first"), create: true },
    })).json<Project>();
    const second = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Second", path: join(appTestContext.tempDir, "second"), create: true },
    })).json<Project>();

    const pinResponse = await appTestContext.app.inject({ method: "POST", url: `/api/projects/${second.id}/pin` });

    expect(pinResponse.statusCode).toBe(200);
    expect(pinResponse.json<Project[]>()).toEqual([{ ...second, pinned: true }, first]);
    expect((await appTestContext.app.inject({ method: "GET", url: "/api/projects" })).json<Project[]>()).toEqual([{ ...second, pinned: true }, first]);
  });

  it("unpins a project and moves it to the front of the list", async () => {
    const first = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "First", path: join(appTestContext.tempDir, "first"), create: true },
    })).json<Project>();
    const second = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Second", path: join(appTestContext.tempDir, "second"), create: true },
    })).json<Project>();
    await appTestContext.app.inject({ method: "POST", url: `/api/projects/${first.id}/pin` });

    const unpinResponse = await appTestContext.app.inject({ method: "POST", url: `/api/projects/${second.id}/unpin` });

    expect(unpinResponse.statusCode).toBe(200);
    expect(unpinResponse.json<Project[]>()).toEqual([second, { ...first, pinned: true }]);
  });

  it("returns 404 when pinning or unpinning an unknown project", async () => {
    const pinResponse = await appTestContext.app.inject({ method: "POST", url: "/api/projects/does-not-exist/pin" });
    const unpinResponse = await appTestContext.app.inject({ method: "POST", url: "/api/projects/does-not-exist/unpin" });

    expect(pinResponse.statusCode).toBe(404);
    expect(pinResponse.json()).toEqual({ error: "Project not found" });
    expect(unpinResponse.statusCode).toBe(404);
    expect(unpinResponse.json()).toEqual({ error: "Project not found" });
  });

  it.skipIf(process.platform === "win32")("answers 500 when a project store write fails while unknown ids still answer 404", async () => {
    const storeDir = join(appTestContext.tempDir, "readonly-store");
    await mkdir(storeDir, { recursive: true });
    const storePath = join(storeDir, "projects.json");
    await writeFile(storePath, `${JSON.stringify({
      projects: [{
        id: "known-id",
        name: "Known",
        path: join(appTestContext.tempDir, "known"),
        createdAt: "2026-05-25T00:00:00.000Z",
      }],
    }, null, 2)}\n`, "utf8");
    // Readable but not writable, so store reads still resolve projects (404
    // for unknown ids) while the pin write itself fails with a non-ProjectNotFoundError.
    await chmod(storeDir, 0o500);

    const app = await buildApp({
      projects: new ProjectService(new ProjectStore(storePath)),
      clientDist: false,
      logger: false,
    });

    try {
      const pinResponse = await app.inject({ method: "POST", url: "/api/projects/known-id/pin" });
      expect(pinResponse.statusCode).toBe(500);
      expect(pinResponse.json()).toHaveProperty("error");

      const unknownResponses = await Promise.all([
        app.inject({ method: "DELETE", url: "/api/projects/does-not-exist" }),
        app.inject({ method: "POST", url: "/api/projects/does-not-exist/pin" }),
        app.inject({ method: "POST", url: "/api/projects/does-not-exist/unpin" }),
        app.inject({ method: "GET", url: "/api/projects/does-not-exist/workspaces" }),
      ]);
      for (const response of unknownResponses) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "Project not found" });
      }
    } finally {
      await app.close();
      await chmod(storeDir, 0o700).catch(() => undefined);
    }
  });

  it("serves pin and unpin under the local machine prefix", async () => {
    const project = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Local", path: appTestContext.projectDir, create: true },
    })).json<Project>();

    const pinResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/local/projects/${project.id}/pin` });
    const unpinResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/local/projects/${project.id}/unpin` });

    expect(pinResponse.json<Project[]>()).toEqual([{ ...project, pinned: true }]);
    expect(unpinResponse.json<Project[]>()).toEqual([project]);
  });
});
