import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Workspace } from "../../shared/apiTypes.js";
import type { WorkspaceCatalogAddress } from "../../shared/apiTypes.js";
import { serializeWorkspaceTasksConfig, type WorkspaceTasksConfig } from "../../shared/workspaceTasks.js";
import { ProjectService } from "../projects/projectService.js";
import { ProjectStore } from "../storage/projectStore.js";
import { WorkspaceService } from "../workspaces/workspaceService.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "../workspaces/fileContentService.testSupport.js";
import {
  createWorkspaceTasksWorkspaceFileResolver,
  isWorkspaceTasksPath,
  normalizeWorkspaceTasksPath,
  type WorkspaceTasksWorkspaceFileResolver,
} from "./workspaceTasksWorkspaceFile.js";

afterEach(async () => {
  await cleanupTempWorkspaces();
});

describe("WorkspaceTasksWorkspaceFileResolver", () => {
  it("resolves the main workspace and worktree to separate task files for one project", async () => {
    const projectRoot = await createTempWorkspace("pi-webui-project-");
    const worktreeRoot = await createTempWorkspace("pi-webui-worktree-");
    const project = projectFor("project", projectRoot);
    const workspaces = [workspaceFor("main", project.id, projectRoot, true), workspaceFor("worktree", project.id, worktreeRoot, false)];
    const resolver = createResolver(project, workspaces);
    const mainAddress = { projectId: project.id, workspaceId: "main" } satisfies WorkspaceCatalogAddress;
    const worktreeAddress = { projectId: project.id, workspaceId: "worktree" } satisfies WorkspaceCatalogAddress;
    const mainConfig = catalogWithTask("main-task");
    const worktreeConfig = catalogWithTask("worktree-task");

    await resolver.publishCatalog(mainAddress, Buffer.from(serializeWorkspaceTasksConfig(mainConfig), "utf8"));
    await resolver.publishCatalog(worktreeAddress, Buffer.from(serializeWorkspaceTasksConfig(worktreeConfig), "utf8"));

    await expect(readFile(join(projectRoot, ".pi-webui", "tasks.json"), "utf8")).resolves.toBe(serializeWorkspaceTasksConfig(mainConfig));
    await expect(readFile(join(worktreeRoot, ".pi-webui", "tasks.json"), "utf8")).resolves.toBe(serializeWorkspaceTasksConfig(worktreeConfig));
  });

  it("distinguishes missing, empty-present, and different raw source revisions", async () => {
    const root = await createTempWorkspace();
    const project = projectFor("project", root);
    const resolver = createResolver(project, [workspaceFor("workspace", project.id, root, true)]);
    const address = { projectId: project.id, workspaceId: "workspace" } satisfies WorkspaceCatalogAddress;

    const missing = await resolver.readCatalog(address);
    await mkdir(join(root, ".pi-webui"));
    await writeFile(join(root, ".pi-webui", "tasks.json"), "", "utf8");
    const emptyPresent = await resolver.readCatalog(address);
    await writeFile(join(root, ".pi-webui", "tasks.json"), "{\"version\":1,\"tasks\":[]}\n", "utf8");
    const validPresent = await resolver.readCatalog(address);

    expect(missing.kind).toBe("missing");
    expect(emptyPresent.kind).toBe("present");
    expect(validPresent.kind).toBe("present");
    expect(missing.revision).not.toBe(emptyPresent.revision);
    expect(emptyPresent.revision).not.toBe(validPresent.revision);
  });

  it.each([
    ["final task-file symlink", "file"],
    ["dangling final task-file symlink", "dangling-file"],
    [".pi-webui parent symlink", "parent"],
    ["dangling .pi-webui parent symlink", "dangling-parent"],
  ])("rejects a %s before using the external target", async (_label, kind) => {
    const root = await createTempWorkspace();
    const outside = await createTempWorkspace("pi-webui-workspace-file-outside-");
    const project = projectFor("project", root);
    const resolver = createResolver(project, [workspaceFor("workspace", project.id, root, true)]);
    const address = { projectId: "project", workspaceId: "workspace" } satisfies WorkspaceCatalogAddress;

    if (kind === "file") {
      await mkdir(join(root, ".pi-webui"));
      await writeFile(join(outside, "tasks.json"), "outside\n", "utf8");
      await symlink(join(outside, "tasks.json"), join(root, ".pi-webui", "tasks.json"));
    } else if (kind === "dangling-file") {
      await mkdir(join(root, ".pi-webui"));
      await symlink(join(outside, "missing.json"), join(root, ".pi-webui", "tasks.json"));
    } else if (kind === "parent") {
      await symlink(outside, join(root, ".pi-webui"));
    } else {
      await symlink(join(outside, "missing-directory"), join(root, ".pi-webui"));
    }

    await expect(resolver.readCatalog(address)).rejects.toThrow();
    await expect(resolver.publishCatalog(address, Buffer.from("{}\n"))).rejects.toThrow();
    if (kind === "file") {
      await expect(readFile(join(outside, "tasks.json"), "utf8")).resolves.toBe("outside\n");
    } else {
      await expect(readFile(join(outside, "tasks.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("normalizes explorer aliases before identifying the fixed task file", () => {
    expect(normalizeWorkspaceTasksPath("./.pi-webui\\tasks.json")).toBe(".pi-webui/tasks.json");
    expect(isWorkspaceTasksPath("./.pi-webui/tasks.json")).toBe(true);
    expect(isWorkspaceTasksPath(".pi-webui/other.json")).toBe(false);
  });
  it("publishes through an exclusive temporary file and acknowledges after final rename", async () => {
    const root = await createTempWorkspace();
    const project = projectFor("project", root);
    const resolver = createResolver(project, [workspaceFor("workspace", project.id, root, true)]);
    const address = { projectId: "project", workspaceId: "workspace" } satisfies WorkspaceCatalogAddress;
    const events: string[] = [];

    await resolver.publishCatalog(address, Buffer.from("{\"version\":1,\"tasks\":[]}\n"), {
      onPublicationAttempt: () => events.push("attempt"),
      onPublished: () => events.push("published"),
    });

    expect(events).toEqual(["attempt", "published"]);
    const metadata = await lstat(join(root, ".pi-webui", "tasks.json"));
    expect(metadata.isFile()).toBe(true);
  });

  it("leaves the source catalog unchanged when an exclusive temporary write fails", async () => {
    const root = await createTempWorkspace();
    const project = projectFor("project", root);
    let failTemporaryWrite = false;
    const resolver = createResolver(project, [workspaceFor("workspace", project.id, root, true)], {
      writeFile: async (path, bytes, options) => {
        if (failTemporaryWrite && options?.flag === "wx") {
          await writeFile(path, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), { flag: "wx" });
          throw new Error("partial temporary write");
        }
        await writeFile(path, bytes, options);
      },
    });
    const address = { projectId: "project", workspaceId: "workspace" } satisfies WorkspaceCatalogAddress;
    const original = Buffer.from(serializeWorkspaceTasksConfig(catalogWithTask("original")), "utf8");
    await resolver.publishCatalog(address, original);
    failTemporaryWrite = true;

    await expect(resolver.publishCatalog(address, Buffer.from(serializeWorkspaceTasksConfig(catalogWithTask("next")), "utf8"))).rejects.toThrow("partial temporary write");
    await expect(readFile(join(root, ".pi-webui", "tasks.json"))).resolves.toEqual(original);
  });
});

function createResolver(
  project: Project,
  workspaces: Workspace[],
  fileSystem?: Parameters<typeof createWorkspaceTasksWorkspaceFileResolver>[0]["fileSystem"],
): WorkspaceTasksWorkspaceFileResolver {
  return createWorkspaceTasksWorkspaceFileResolver({
    projects: new FakeProjectService(project),
    workspaces: new FakeWorkspaceService(workspaces),
    ...(fileSystem === undefined ? {} : { fileSystem }),
  });
}

class FakeProjectService extends ProjectService {
  constructor(private readonly project: Project) {
    super(new ProjectStore(join(project.path, ".project-store.json")));
  }

  override requireProject(id: string): Promise<Project> {
    return id === this.project.id ? Promise.resolve(this.project) : Promise.reject(new Error("Project not found"));
  }
}

class FakeWorkspaceService extends WorkspaceService {
  constructor(private readonly workspaces: Workspace[]) {
    super();
  }

  override list(project: Project): Promise<Workspace[]> {
    return Promise.resolve(this.workspaces.filter((workspace) => workspace.projectId === project.id));
  }
}

function projectFor(id: string, path: string): Project {
  return { id, name: id, path, createdAt: new Date(0).toISOString() };
}

function workspaceFor(id: string, projectId: string, path: string, isMain: boolean): Workspace {
  return { id, projectId, path, label: id, isMain, isGitRepo: true, isGitWorktree: !isMain };
}

function catalogWithTask(id: string): WorkspaceTasksConfig {
  return { version: 1, tasks: [{ id, title: id, command: `npm run ${id}`, confirm: false }] };
}
