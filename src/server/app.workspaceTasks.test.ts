import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MoveWorkspaceTaskRequest } from "../shared/apiTypes.js";
import type { Project, Workspace } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import {
  deriveWorkspaceTasksMovePlan,
  workspaceTasksGlobalCatalogRevision,
  workspaceTasksWorkspaceCatalogRevision,
} from "./workspaceTasks/workspaceTasksMoveProtocol.js";

registerAppTestHooks();

describe("buildApp Workspace Tasks local routes", () => {
  it("uses one fixed composition for ordinary and /api/machines/local task routes", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Task routes", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const ordinary = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/workspace-tasks` });
    const alias = await appTestContext.app.inject({ method: "GET", url: `/api/machines/local/projects/${project.id}/workspaces/${workspace.id}/workspace-tasks` });
    const ordinaryGlobal = await appTestContext.app.inject({ method: "GET", url: "/api/workspace-tasks/global" });
    const aliasGlobal = await appTestContext.app.inject({ method: "GET", url: "/api/machines/local/workspace-tasks/global" });

    expect(ordinary.statusCode).toBe(200);
    expect(alias.statusCode).toBe(200);
    expect(alias.json()).toEqual(ordinary.json());
    expect(ordinaryGlobal.statusCode).toBe(200);
    expect(aliasGlobal.statusCode).toBe(200);
    expect(aliasGlobal.json()).toEqual(ordinaryGlobal.json());
  });

  it("does not expose an invalid workspace catalog as a write or reset route", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Invalid task routes", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspace = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    await mkdir(join(appTestContext.projectDir, ".pi-webui"), { recursive: true });
    await writeFile(join(appTestContext.projectDir, ".pi-webui", "tasks.json"), "{invalid-json", "utf8");

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/workspace-tasks` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: "invalid" });
    expect(response.json()).not.toHaveProperty("write");
    expect(response.json()).not.toHaveProperty("reset");

    const repair = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(".pi-webui/tasks.json")}`,
      payload: JSON.stringify({ version: 1, tasks: [] }),
      headers: { "content-type": "text/plain" },
    });
    expect(repair.statusCode).toBe(200);
    expect(repair.json()).toMatchObject({ path: ".pi-webui/tasks.json" });
  });

  it.each([
    ["ordinary", "/api/config"],
    ["local machine", "/api/machines/local/config"],
  ])("uses the composition coordinator to reject a late global-task claim for %s config routes", async (_label, url) => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Late config claim", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspace = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const task = { id: "late-claim", title: "Late claim", command: "echo late-claim", confirm: false };
    const sourceCatalog = { version: 1 as const, tasks: [task] };
    const globalCatalog = { version: 1 as const, tasks: [] };
    const requestedCatalog = { version: 1 as const, tasks: [task] };
    const request: MoveWorkspaceTaskRequest = {
      operationId: "71a51a87-6334-4511-9b9e-330ec1eae2d7",
      intent: "start",
      source: {
        ref: { scope: "workspace", id: task.id },
        expectedCatalog: {
          kind: "loaded",
          revision: workspaceTasksWorkspaceCatalogRevision(sourceCatalog),
          config: sourceCatalog,
        },
      },
      destination: {
        scope: "global",
        expectedCatalog: {
          kind: "loaded",
          revision: workspaceTasksGlobalCatalogRevision(globalCatalog),
          config: globalCatalog,
        },
        task,
      },
    };
    const plan = deriveWorkspaceTasksMovePlan({ projectId: project.id, workspaceId: workspace.id }, request);
    const registry = appTestContext.workspaceTasks.registry;
    appTestContext.beforeConfigMutation = async () => {
      appTestContext.beforeConfigMutation = undefined;
      await registry.withMoveLock(plan.operationId, () => {
        const permit = registry.beginStart(plan);
        registry.markDestinationWritten(permit);
        return Promise.resolve();
      });
    };

    const response = await appTestContext.app.inject({
      method: "PUT",
      url,
      payload: { config: { plugins: { "workspace-tasks": { settings: { globalTasks: requestedCatalog } } } } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Workspace task move recovery is pending. Refresh before changing the affected catalog." });
    expect(appTestContext.piWebUiConfig).toEqual({});
  });
});
