import { lstat, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_PREVIEW_BYTES } from "../shared/workspaceFiles.js";
import type { Project, Workspace } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp workspace file routes", () => {
  it("serves supported workspace images as previews", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Images", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"1\" height=\"1\" /></svg>";
    await writeFile(join(appTestContext.projectDir, "diagram.svg"), svg);
    await writeFile(join(appTestContext.projectDir, "note.txt"), "hello");
    await writeFile(join(appTestContext.projectDir, "huge.png"), "");
    await truncate(join(appTestContext.projectDir, "huge.png"), MAX_IMAGE_PREVIEW_BYTES + 1);

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const previewResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("diagram.svg")}` });

    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers["content-type"]).toContain("image/svg+xml");
    expect(previewResponse.headers["cache-control"]).toBe("private, max-age=3600");
    expect(previewResponse.headers["content-security-policy"]).toContain("sandbox");
    expect(previewResponse.headers["x-content-type-options"]).toBe("nosniff");
    expect(previewResponse.body).toBe(svg);

    const rejectedResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("note.txt")}` });
    expect(rejectedResponse.statusCode).toBe(400);
    expect(rejectedResponse.json()).toEqual({ error: "Image preview is not supported for this file type" });

    const tooLargeResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("huge.png")}` });
    expect(tooLargeResponse.statusCode).toBe(400);
    expect(tooLargeResponse.json()).toEqual({ error: "Image is too large to preview (limit 10 MB)" });
  });

  it("keeps normal file suggestions workspace-local when path access config is invalid", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Local Suggestions", path: appTestContext.projectDir, create: true },
    });
    expect(addResponse.statusCode).toBe(200);
    await writeFile(join(appTestContext.projectDir, "sdk.md"), "local sdk\n");
    await mkdir(join(appTestContext.projectDir, ".pi-webui"), { recursive: true });
    await writeFile(join(appTestContext.projectDir, ".pi-webui", "config.json"), `${JSON.stringify({ version: 1, pathAccess: { allowedPaths: [""] } }, null, 2)}\n`);

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/files?cwd=${encodeURIComponent(appTestContext.projectDir)}&q=sdk&scope=all` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ path: "sdk.md", kind: "other" }]);
  });

  it("serves project-configured allowed external files through the workspace explorer", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "External", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const externalDir = join(appTestContext.tempDir, "external-docs");
    const deniedFile = join(appTestContext.tempDir, "secret.md");
    await mkdir(externalDir);
    await writeFile(join(externalDir, "sdk.md"), "external sdk\n");
    await writeFile(deniedFile, "secret\n");
    await mkdir(join(appTestContext.projectDir, ".pi-webui"), { recursive: true });
    await writeFile(join(appTestContext.projectDir, ".pi-webui", "config.json"), `${JSON.stringify({ version: 1, pathAccess: { allowedPaths: [externalDir] } }, null, 2)}\n`);

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const fileResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(join(externalDir, "sdk.md"))}` });
    const treeResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/tree?path=${encodeURIComponent(externalDir)}` });
    const suggestionResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/files?q=${encodeURIComponent(join(externalDir, "s"))}` });
    const localSuggestionResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/files?q=sdk` });
    const deniedResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(deniedFile)}` });

    expect(fileResponse.statusCode).toBe(200);
    expect(fileResponse.json()).toMatchObject({ path: join(externalDir, "sdk.md"), content: "external sdk\n", binary: false });
    expect(treeResponse.statusCode).toBe(200);
    expect(treeResponse.json()).toMatchObject({
      path: externalDir,
      entries: [expect.objectContaining({ name: "sdk.md", path: join(externalDir, "sdk.md"), type: "file" })],
      truncated: false,
    });
    expect(suggestionResponse.statusCode).toBe(200);
    expect(suggestionResponse.json()).toEqual([{ path: join(externalDir, "sdk.md"), kind: "other" }]);
    expect(localSuggestionResponse.statusCode).toBe(200);
    expect(localSuggestionResponse.json()).toEqual([]);
    expect(deniedResponse.statusCode).toBe(400);
    expect(deniedResponse.json()).toEqual({ error: "Path is outside allowed paths" });
  });

  it("writes workspace files through the HTTP contract", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "WriteTest", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const writeTextResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}`,
      payload: "hello world",
      headers: { "content-type": "text/plain" },
    });
    expect(writeTextResponse.statusCode).toBe(200);
    expect(writeTextResponse.json()).toMatchObject({ path: "hello.txt", created: true });
    expect(typeof writeTextResponse.json<{ size: unknown }>().size).toBe("number");

    const readResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}` });
    expect(readResponse.json<{ content: unknown }>().content).toBe("hello world");

    const writeBinaryResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("image.png")}`,
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(writeBinaryResponse.statusCode).toBe(200);
    expect(writeBinaryResponse.json()).toMatchObject({ path: "image.png", created: true });

    const writeDeepResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("deep/nested/dir/file.txt")}`,
      payload: "deep content",
      headers: { "content-type": "text/plain" },
    });
    expect(writeDeepResponse.statusCode).toBe(200);

    const readDeepResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("deep/nested/dir/file.txt")}` });
    expect(readDeepResponse.json<{ content: unknown }>().content).toBe("deep content");

    const overwriteResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}`,
      payload: "updated",
      headers: { "content-type": "text/plain" },
    });
    expect(overwriteResponse.json()).toMatchObject({ path: "hello.txt", created: false });

    const noOverwriteResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}&overwrite=false`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(noOverwriteResponse.statusCode).toBe(400);
    expect(noOverwriteResponse.json<{ error: string }>().error).toContain("File already exists");

    const traversalResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
      payload: "evil",
      headers: { "content-type": "text/plain" },
    });
    expect(traversalResponse.statusCode).toBe(400);
    expect(traversalResponse.json<{ error: string }>().error).toContain("Path traversal");

    const noPathResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file`,
      payload: "no path",
      headers: { "content-type": "text/plain" },
    });
    expect(noPathResponse.statusCode).toBe(400);
    expect(noPathResponse.json<{ error: string }>().error).toContain("path query parameter is required");

    const noDirsResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("nonexistent/parent/file.txt")}&createDirs=false`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(noDirsResponse.statusCode).toBe(400);

    await mkdir(join(appTestContext.projectDir, "subdir"), { recursive: true });
    const dirWriteResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("subdir")}`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(dirWriteResponse.statusCode).toBe(400);
  });

  it("routes normalized task-file explorer mutations through the fixed resolver", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Task file", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspace = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const body = JSON.stringify({ version: 1, tasks: [] });
    const writeResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("./.pi-webui/tasks.json")}`,
      payload: body,
      headers: { "content-type": "text/plain" },
    });
    expect(writeResponse.statusCode).toBe(200);
    expect(writeResponse.json()).toMatchObject({ path: ".pi-webui/tasks.json", created: true });
    await expect(readFile(join(appTestContext.projectDir, ".pi-webui", "tasks.json"), "utf8")).resolves.toBe(body);

    const deleteResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(".pi-webui/tasks.json")}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ path: ".pi-webui/tasks.json", existed: true });
  });

  it("rejects task-file symlinks before explorer mutation helpers can follow them", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Task symlink", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspace = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");
    const outside = join(appTestContext.tempDir, "outside-tasks.json");
    await writeFile(outside, "outside", "utf8");
    await mkdir(join(appTestContext.projectDir, ".pi-webui"), { recursive: true });
    await symlink(outside, join(appTestContext.projectDir, ".pi-webui", "tasks.json"));

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(".pi-webui/tasks.json")}`,
      payload: "replacement",
      headers: { "content-type": "text/plain" },
    });

    expect(response.statusCode).toBe(400);
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
  });

  it("deletes an unrelated outside-pointing final symlink without touching its target", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Delete final symlink", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspace = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");
    const outside = join(appTestContext.tempDir, "outside-delete-target.txt");
    const link = join(appTestContext.projectDir, "delete-link.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, link);

    const response = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("delete-link.txt")}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ path: "delete-link.txt", existed: true });
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
  });

  it("overwrites an unrelated outside-pointing final symlink without touching its target", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Move final symlink", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspace = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");
    const source = join(appTestContext.projectDir, "move-source.txt");
    const destination = join(appTestContext.projectDir, "move-destination.txt");
    const outside = join(appTestContext.tempDir, "outside-move-target.txt");
    await writeFile(source, "source", "utf8");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, destination);

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("move-source.txt")}&toPath=${encodeURIComponent("move-destination.txt")}&overwrite=true`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ fromPath: "move-source.txt", toPath: "move-destination.txt" });
    expect((await lstat(destination)).isSymbolicLink()).toBe(false);
    await expect(readFile(destination, "utf8")).resolves.toBe("source");
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
  });

  it.each(["write", "delete", "move source", "move destination"])("does not let a real directory alias bypass the fixed resolver during %s", async (operation) => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: `Task alias ${operation}`, path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspace = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");
    const taskDirectory = join(appTestContext.projectDir, ".pi-webui");
    const taskFile = join(taskDirectory, "tasks.json");
    const protectedFile = join(appTestContext.projectDir, "protected-task-file.json");
    const alias = join(appTestContext.projectDir, "task-alias");
    const source = join(appTestContext.projectDir, "move-source.json");
    const moved = join(appTestContext.projectDir, "moved.json");
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(protectedFile, "protected", "utf8");
    await writeFile(source, "source", "utf8");
    await symlink(protectedFile, taskFile);
    await symlink(taskDirectory, alias);
    const base = `/api/projects/${project.id}/workspaces/${workspace.id}/file`;

    let response;
    if (operation === "write") {
      response = await appTestContext.app.inject({
        method: "PUT",
        url: `${base}?path=${encodeURIComponent("task-alias/tasks.json")}`,
        payload: "replacement",
        headers: { "content-type": "text/plain" },
      });
    } else if (operation === "delete") {
      response = await appTestContext.app.inject({
        method: "DELETE",
        url: `${base}?path=${encodeURIComponent("task-alias/tasks.json")}`,
      });
    } else if (operation === "move source") {
      response = await appTestContext.app.inject({
        method: "POST",
        url: `${base}/move?fromPath=${encodeURIComponent("task-alias/tasks.json")}&toPath=${encodeURIComponent("moved.json")}`,
      });
    } else {
      response = await appTestContext.app.inject({
        method: "POST",
        url: `${base}/move?fromPath=${encodeURIComponent("move-source.json")}&toPath=${encodeURIComponent("task-alias/tasks.json")}&overwrite=true`,
      });
    }

    expect(response.statusCode).toBe(400);
    await expect(readFile(protectedFile, "utf8")).resolves.toBe("protected");
    expect((await lstat(taskFile)).isSymbolicLink()).toBe(true);
    if (operation === "move source") await expect(readFile(moved, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    if (operation === "move destination") await expect(readFile(source, "utf8")).resolves.toBe("source");
  });

  it("rejects a dangling final alias chain before a generic write can create its target", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Dangling task alias", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspace = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");
    const taskDirectory = join(appTestContext.projectDir, ".pi-webui");
    const taskFile = join(taskDirectory, "tasks.json");
    const alias = join(appTestContext.projectDir, "task-alias");
    const missingTarget = join(appTestContext.projectDir, "must-not-exist.json");
    await mkdir(taskDirectory, { recursive: true });
    await symlink(missingTarget, taskFile);
    await symlink(taskFile, alias);

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("task-alias")}`,
      payload: "replacement",
      headers: { "content-type": "text/plain" },
    });

    expect(response.statusCode).toBe(400);
    await expect(readFile(missingTarget, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(taskFile)).isSymbolicLink()).toBe(true);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it("deletes workspace files through the HTTP contract", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "DeleteTest", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("to-delete.txt")}`,
      payload: "delete me",
      headers: { "content-type": "text/plain" },
    });

    const deleteResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("to-delete.txt")}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ path: "to-delete.txt", existed: true });

    const deleteMissingResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("missing.txt")}`,
    });
    expect(deleteMissingResponse.statusCode).toBe(200);
    expect(deleteMissingResponse.json()).toMatchObject({ path: "missing.txt", existed: false });

    const traversalResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
    });
    expect(traversalResponse.statusCode).toBe(400);
    expect(traversalResponse.json<{ error: string }>().error).toContain("Path traversal");

    const noPathResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file`,
    });
    expect(noPathResponse.statusCode).toBe(400);
    expect(noPathResponse.json<{ error: string }>().error).toContain("path query parameter is required");
  });

  it("moves workspace files through the HTTP contract", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "MoveTest", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("original.txt")}`,
      payload: "move me",
      headers: { "content-type": "text/plain" },
    });

    const moveResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("original.txt")}&toPath=${encodeURIComponent("moved.txt")}`,
    });
    expect(moveResponse.statusCode).toBe(200);
    expect(moveResponse.json()).toMatchObject({ fromPath: "original.txt", toPath: "moved.txt" });
    expect(typeof moveResponse.json<{ size: unknown }>().size).toBe("number");

    const readSourceResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("original.txt")}` });
    expect(readSourceResponse.statusCode).toBe(400);

    const readTargetResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("moved.txt")}` });
    expect(readTargetResponse.statusCode).toBe(200);
    expect(readTargetResponse.json<{ content: unknown }>().content).toBe("move me");

    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("source2.txt")}`,
      payload: "source",
      headers: { "content-type": "text/plain" },
    });
    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("target2.txt")}`,
      payload: "target",
      headers: { "content-type": "text/plain" },
    });

    const overwriteResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("source2.txt")}&toPath=${encodeURIComponent("target2.txt")}&overwrite=true`,
    });
    expect(overwriteResponse.statusCode).toBe(200);

    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("source3.txt")}`,
      payload: "s",
      headers: { "content-type": "text/plain" },
    });
    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("target3.txt")}`,
      payload: "t",
      headers: { "content-type": "text/plain" },
    });
    const noOverwriteResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("source3.txt")}&toPath=${encodeURIComponent("target3.txt")}`,
    });
    expect(noOverwriteResponse.statusCode).toBe(400);
    expect(noOverwriteResponse.json<{ error: string }>().error).toContain("File already exists");

    const traversalFromResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("../../etc/passwd")}&toPath=${encodeURIComponent("safe.txt")}`,
    });
    expect(traversalFromResponse.statusCode).toBe(400);

    const noParamsResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move`,
    });
    expect(noParamsResponse.statusCode).toBe(400);
    expect(noParamsResponse.json<{ error: string }>().error).toContain("fromPath query parameter is required");
  });
});
