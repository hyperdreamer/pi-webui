import { describe, expect, it } from "vitest";
import type { Project, WorkspaceActivity } from "../api";
import { displayedProjects, filterProjects, prioritizeActiveProjects } from "./projectListProjection";

const projects: Project[] = [
  { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-07-26T00:00:00.000Z" },
  { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-07-26T00:00:00.000Z" },
  { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-07-26T00:00:00.000Z" },
];

describe("project list projection", () => {
  it("filters case-insensitively by both name and full path", () => {
    expect(filterProjects(projects, "  CLIENT  ").map((project) => project.id)).toEqual(["client", "docs"]);
  });

  it("keeps active projects first without mutating the incoming list", () => {
    const activities: Record<string, WorkspaceActivity> = {
      "/work/client-app": { cwd: "/work/client-app", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-26T01:00:00.000Z" },
    };

    expect(prioritizeActiveProjects(projects, {}, activities).map((project) => project.id)).toEqual(["client", "server", "docs"]);
    expect(projects.map((project) => project.id)).toEqual(["server", "client", "docs"]);
  });

  it("filters before it applies active-first ordering", () => {
    const activities: Record<string, WorkspaceActivity> = {
      "/work/client-guides": { cwd: "/work/client-guides", hasSessionActivity: false, hasTerminalActivity: true, updatedAt: "2026-07-26T01:00:00.000Z" },
    };

    expect(displayedProjects(projects, "client", {}, activities).map((project) => project.id)).toEqual(["docs", "client"]);
  });
});
