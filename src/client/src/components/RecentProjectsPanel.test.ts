// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { Project, RecentProjectEntry, Workspace } from "../../../shared/apiTypes";
import { RecentProjectsPanel, registeredProjectForEntry } from "./RecentProjectsPanel";

function entry(path: string, id = `entry-${path}`): RecentProjectEntry {
  return { id, name: path.split("/").at(-1) ?? path, path, lastUsedAt: "2026-01-01T00:00:00.000Z" };
}

function project(id: string, path: string): Project {
  return { id, name: path.split("/").at(-1) ?? path, path, createdAt: "2026-01-01T00:00:00.000Z" };
}

function workspace(projectId: string, path: string): Workspace {
  return { id: `w-${projectId}`, projectId, path, label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
}

function renderedText(panel: RecentProjectsPanel): string {
  return JSON.stringify(panel.render());
}

describe("registeredProjectForEntry", () => {
  it("matches a registered project by path", () => {
    const alpha = project("p1", "/work/alpha");

    expect(registeredProjectForEntry(entry("/work/alpha"), [alpha])).toEqual(alpha);
  });

  it("returns undefined when no registered project has that path", () => {
    expect(registeredProjectForEntry(entry("/work/alpha"), [project("p1", "/work/beta")])).toBeUndefined();
  });
});

async function mount(overrides: Partial<RecentProjectsPanel>): Promise<{ panel: RecentProjectsPanel; teardown: () => void }> {
  await import("./RecentProjectsPanel");
  const panel = new RecentProjectsPanel();
  Object.assign(panel, overrides);
  document.body.append(panel);
  await panel.updateComplete;
  return { panel, teardown: () => { panel.remove(); } };
}

function rows(panel: RecentProjectsPanel): HTMLElement[] {
  return [...panel.renderRoot.querySelectorAll<HTMLElement>(".recent-project-row")];
}

describe("recent-projects-panel rendering", () => {
  it("renders entries in server order with name and full path", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/beta"), entry("/work/alpha")] },
      projects: [project("p1", "/work/alpha"), project("p2", "/work/beta")],
    });

    expect(rows(panel).map((row) => row.textContent.includes("/work/beta"))).toEqual([true, false]);
    expect(panel.renderRoot.textContent).toContain("/work/alpha");

    teardown();
  });

  it("marks an entry with no registered project as Closed", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [],
    });

    expect(panel.renderRoot.textContent).toContain("Closed");

    teardown();
  });

  it("shows an activity indicator for a registered project with active work", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [project("p1", "/work/alpha")],
      workspacesByProjectId: { p1: [workspace("p1", "/work/alpha")] },
      activities: { "/work/alpha": { cwd: "/work/alpha", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-01-01T00:00:00.000Z" } },
    });

    expect(panel.renderRoot.querySelector(".activity-indicator")).not.toBeNull();

    teardown();
  });

  it("renders loading, empty, and failed states", async () => {
    const loading = await mount({ state: { kind: "loading" } });
    expect(loading.panel.renderRoot.textContent).toContain("Loading");
    loading.teardown();

    const empty = await mount({ state: { kind: "ready", entries: [] } });
    expect(empty.panel.renderRoot.textContent).toContain("No recent projects");
    empty.teardown();

    const failed = await mount({ state: { kind: "failed", message: "offline" } });
    expect(failed.panel.renderRoot.textContent).toContain("offline");
    expect(failed.panel.renderRoot.querySelector("button.recent-projects-retry")).not.toBeNull();
    failed.teardown();
  });

  it("renders no per-row removal control", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [project("p1", "/work/alpha")],
    });

    expect(panel.renderRoot.querySelectorAll(".action-menu-toggle")).toHaveLength(0);
    expect(panel.renderRoot.querySelectorAll("button")).toHaveLength(0);
    expect(panel.renderRoot.textContent).not.toContain("Remove");
    expect(renderedText(panel)).not.toContain("Remove");

    teardown();
  });
});

describe("recent-projects-panel activation", () => {
  it("opens a registered project through the supplied callback", async () => {
    const onOpenRegistered = vi.fn();
    const alpha = project("p1", "/work/alpha");
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [alpha],
      onOpenRegistered,
    });

    rows(panel)[0]?.click();

    expect(onOpenRegistered).toHaveBeenCalledWith(alpha);
    teardown();
  });

  it("routes a closed entry to the closed handler instead", async () => {
    const onOpenRegistered = vi.fn();
    const onOpenClosed = vi.fn();
    const closed = entry("/work/alpha");
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [closed] },
      projects: [],
      onOpenClosed,
      onOpenRegistered,
    });

    rows(panel)[0]?.click();

    expect(onOpenClosed).toHaveBeenCalledWith(closed);
    expect(onOpenRegistered).not.toHaveBeenCalled();
    teardown();
  });

  it("activates a row from the keyboard and retries from the failed state", async () => {
    const onOpenRegistered = vi.fn();
    const alpha = project("p1", "/work/alpha");
    const opened = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [alpha],
      onOpenRegistered,
    });

    rows(opened.panel)[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpenRegistered).toHaveBeenCalledWith(alpha);
    opened.teardown();

    const onRetry = vi.fn();
    const failed = await mount({ state: { kind: "failed", message: "offline" }, onRetry });

    failed.panel.renderRoot.querySelector<HTMLButtonElement>("button.recent-projects-retry")?.click();

    expect(onRetry).toHaveBeenCalledTimes(1);
    failed.teardown();
  });
});
