import { describe, expect, it } from "vitest";
import type { Project, Workspace } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

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

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/workspace-tasks` });
    expect(response.json()).not.toHaveProperty("write");
    expect(response.json()).not.toHaveProperty("reset");
  });
});
