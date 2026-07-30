import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import { initialAppState } from "../appState";
import type { Project, Workspace } from "../api";
import { ProjectController } from "./projectController";

function project(id: string, path: string): Project {
  return { id, name: id, path, createdAt: "now" };
}

function workspace(projectId: string, path: string): Workspace {
  return { id: path, projectId, path, label: path, isMain: true, isGitRepo: true, isGitWorktree: true };
}

describe("ProjectController", () => {
  it("provisions ~/workspace and selects it when the project list is empty", async () => {
    const defaultProject = project("workspace", "/home/tester/workspace");
    let state: AppState = initialAppState();
    const selectProject = vi.fn(() => Promise.resolve());
    const addProject = vi.fn().mockResolvedValue(defaultProject);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject, forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn().mockResolvedValue([]),
          addProject,
          closeProject: vi.fn(),
        },
      },
    );

    await controller.loadProjects();

    expect(addProject).toHaveBeenCalledWith("~/workspace", undefined, true, "local");
    expect(state.projects).toEqual([defaultProject]);
    expect(selectProject).toHaveBeenCalledWith(defaultProject);
  });

  it("notifies ownership discovery after an applied project reload", async () => {
    const currentProject = project("current", "/current");
    const removedProject = project("removed", "/removed");
    let state: AppState = {
      ...initialAppState(),
      projects: [removedProject],
      workspacesByProjectId: {
        [currentProject.id]: [workspace(currentProject.id, currentProject.path)],
        [removedProject.id]: [workspace(removedProject.id, removedProject.path)],
      },
    };
    const onProjectsApplied = vi.fn((machineId: string) => {
      expect(machineId).toBe("local");
      expect(state.projects).toEqual([currentProject]);
      expect(state.workspacesByProjectId).toEqual({
        [currentProject.id]: [workspace(currentProject.id, currentProject.path)],
      });
    });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn().mockResolvedValue([currentProject]),
          addProject: vi.fn(),
          closeProject: vi.fn(),
        },
        onProjectsApplied,
      },
    );

    await controller.loadProjects();

    expect(onProjectsApplied).toHaveBeenCalledOnce();
  });

  it("clears an obsolete selected project before notifying ownership observers", async () => {
    const oldProject = project("current", "/old-current");
    const replacementProject = project("current", "/replacement-current");
    let state: AppState = {
      ...initialAppState(),
      projects: [oldProject],
      selectedProject: oldProject,
      selectedWorkspace: workspace(oldProject.id, oldProject.path),
      workspaces: [workspace(oldProject.id, oldProject.path)],
      workspacesByProjectId: {
        [oldProject.id]: [workspace(oldProject.id, oldProject.path)],
      },
    };
    const events: string[] = [];
    const projectsWhenCleared: Project[][] = [];
    const observedSelectedProjects: (Project | undefined)[] = [];
    const clearSelection = vi.fn(() => {
      events.push("clear");
      projectsWhenCleared.push(state.projects);
      state = { ...state, selectedProject: undefined, selectedWorkspace: undefined, workspaces: [] };
    });
    const onProjectsApplied = vi.fn(() => {
      events.push("applied");
      observedSelectedProjects.push(state.selectedProject);
    });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection },
      {
        api: {
          projects: vi.fn().mockResolvedValue([replacementProject]),
          addProject: vi.fn(),
          closeProject: vi.fn(),
        },
        onProjectsApplied,
      },
    );

    await controller.loadProjects();

    expect(state.projects).toEqual([replacementProject]);
    expect(clearSelection).toHaveBeenCalledOnce();
    expect(projectsWhenCleared).toEqual([[replacementProject]]);
    expect(events).toEqual(["clear", "applied"]);
    expect(observedSelectedProjects).toEqual([undefined]);
  });

  it("notifies after adding a project and preserves the existing selection flow", async () => {
    const addedProject = project("added", "/added");
    let state: AppState = { ...initialAppState(), projectDialogOpen: true };
    const events: string[] = [];
    const selectProject = vi.fn((selected: Project): Promise<void> => {
      events.push("select");
      expect(selected).toBe(addedProject);
      return Promise.resolve();
    });
    const onProjectsApplied = vi.fn((machineId: string) => {
      events.push("applied");
      expect(machineId).toBe("local");
      expect(state.projects).toEqual([addedProject]);
      expect(state.projectDialogOpen).toBe(false);
    });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject, forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn().mockResolvedValue(addedProject),
          closeProject: vi.fn(),
        },
        onProjectsApplied,
      },
    );

    await controller.addProject(" /added ");

    expect(events).toEqual(["applied", "select"]);
    expect(onProjectsApplied).toHaveBeenCalledOnce();
    expect(selectProject).toHaveBeenCalledOnce();
  });

  it("notifies after closing a project without changing the existing clear-selection flow", async () => {
    const closedProject = project("closed", "/closed");
    const remainingProject = project("remaining", "/remaining");
    let state: AppState = {
      ...initialAppState(),
      projects: [closedProject, remainingProject],
      selectedProject: closedProject,
      workspacesByProjectId: {
        [closedProject.id]: [workspace(closedProject.id, closedProject.path)],
        [remainingProject.id]: [workspace(remainingProject.id, remainingProject.path)],
      },
    };
    const events: string[] = [];
    const forgetProject = vi.fn((projectId: string) => {
      events.push("forget");
      state = {
        ...state,
        workspacesByProjectId: Object.fromEntries(Object.entries(state.workspacesByProjectId).filter(([id]) => id !== projectId)),
      };
    });
    const clearSelection = vi.fn(() => { events.push("clear"); });
    const onProjectsApplied = vi.fn((machineId: string) => {
      events.push("applied");
      expect(machineId).toBe("local");
      expect(state.projects).toEqual([remainingProject]);
      expect(state.workspacesByProjectId[closedProject.id]).toBeUndefined();
    });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject, clearSelection },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn(),
          closeProject: vi.fn().mockResolvedValue(undefined),
        },
        onProjectsApplied,
      },
    );

    await controller.closeProject(closedProject.id);

    expect(events).toEqual(["forget", "applied", "clear"]);
    expect(onProjectsApplied).toHaveBeenCalledOnce();
    expect(clearSelection).toHaveBeenCalledOnce();
  });
});
