import { describe, expect, it } from "vitest";
import type { Project, RecentProjectEntry } from "../shared/apiTypes.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

async function addProject(): Promise<Project> {
  const response = await appTestContext.app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Example", path: appTestContext.projectDir, create: true },
  });
  expect(response.statusCode).toBe(200);
  return response.json<Project>();
}

async function listRecent(url = "/api/recent-projects"): Promise<RecentProjectEntry[]> {
  const response = await appTestContext.app.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  return response.json<RecentProjectEntry[]>();
}

describe("recent project routes", () => {
  it("records a registered project and lists it", async () => {
    const project = await addProject();

    expect((await listRecent()).map((entry) => entry.path)).toEqual([appTestContext.projectDir]);

    const touch = await appTestContext.app.inject({ method: "POST", url: `/api/projects/${project.id}/recent` });

    expect(touch.statusCode).toBe(200);
    expect(touch.json<RecentProjectEntry[]>().map((entry) => entry.path)).toEqual([appTestContext.projectDir]);
  });

  it("serves the explicit local machine prefix", async () => {
    await addProject();

    expect((await listRecent("/api/machines/local/recent-projects")).map((entry) => entry.name)).toEqual(["Example"]);
  });

  it("answers 404 when recording work for an unknown project", async () => {
    const response = await appTestContext.app.inject({ method: "POST", url: "/api/projects/missing/recent" });

    expect(response.statusCode).toBe(404);
  });

  it("removes a registered entry, answers 404 for an unknown entry, and recreates the entry after work", async () => {
    const project = await addProject();
    const [entry] = await listRecent();
    if (entry === undefined) throw new Error("expected a recorded entry");

    const removed = await appTestContext.app.inject({ method: "DELETE", url: `/api/recent-projects/${entry.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<RecentProjectEntry[]>()).toEqual([]);

    const projects = await appTestContext.app.inject({ method: "GET", url: "/api/projects" });
    expect(projects.statusCode).toBe(200);
    expect(projects.json<Project[]>().map((candidate) => candidate.path)).toEqual([appTestContext.projectDir]);

    const missing = await appTestContext.app.inject({ method: "DELETE", url: `/api/recent-projects/${entry.id}` });
    expect(missing.statusCode).toBe(404);

    const recreated = await appTestContext.app.inject({ method: "POST", url: `/api/projects/${project.id}/recent` });
    expect(recreated.statusCode).toBe(200);
    const entries = recreated.json<RecentProjectEntry[]>();
    expect(entries.map((candidate) => candidate.path)).toEqual([appTestContext.projectDir]);
    expect(entries[0]?.id).not.toBe(entry.id);
  });

  it("removes a history entry through the explicit local machine prefix", async () => {
    await addProject();
    const [entry] = await listRecent("/api/machines/local/recent-projects");
    if (entry === undefined) throw new Error("expected a recorded entry");

    const removed = await appTestContext.app.inject({ method: "DELETE", url: `/api/machines/local/recent-projects/${entry.id}` });

    expect(removed.statusCode).toBe(200);
    expect(removed.json<RecentProjectEntry[]>()).toEqual([]);
  });

  it("removes a closed entry", async () => {
    const project = await addProject();
    const [entry] = await listRecent();
    if (entry === undefined) throw new Error("expected a recorded entry");
    await appTestContext.app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });

    const removed = await appTestContext.app.inject({ method: "DELETE", url: `/api/recent-projects/${entry.id}` });

    expect(removed.statusCode).toBe(200);
    expect(removed.json<RecentProjectEntry[]>()).toEqual([]);
  });

  it("keeps history after the project is closed", async () => {
    const project = await addProject();

    await appTestContext.app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });

    expect((await listRecent()).map((entry) => entry.path)).toEqual([appTestContext.projectDir]);
  });
});
