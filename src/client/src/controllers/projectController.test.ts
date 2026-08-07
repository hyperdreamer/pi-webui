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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (resolveDeferred === undefined || rejectDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

const remoteMachine: NonNullable<AppState["selectedMachine"]> = {
  id: "remote",
  name: "Remote",
  kind: "remote",
  createdAt: "now",
  updatedAt: "now",
};

const localMachine: NonNullable<AppState["selectedMachine"]> = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: "now",
  updatedAt: "now",
};

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
          pinProject: vi.fn(),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
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
          pinProject: vi.fn(),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
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
          pinProject: vi.fn(),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
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
          pinProject: vi.fn(),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
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
          pinProject: vi.fn(),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
        },
        onProjectsApplied,
      },
    );

    await controller.closeProject(closedProject.id);

    expect(events).toEqual(["forget", "applied", "clear"]);
    expect(onProjectsApplied).toHaveBeenCalledOnce();
    expect(clearSelection).toHaveBeenCalledOnce();
  });

  it("replaces the project list with the order returned by pinning", async () => {
    const alpha = project("alpha", "/alpha");
    const beta = project("beta", "/beta");
    let state: AppState = { ...initialAppState(), projects: [alpha, beta] };
    const pinProject = vi.fn().mockResolvedValue([{ ...beta, pinned: true }, alpha]);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject, unpinProject: vi.fn(), closeProjectTree: vi.fn() } },
    );

    await controller.pinProject(beta.id);

    expect(pinProject).toHaveBeenCalledWith(beta.id, "local");
    expect(state.projects).toEqual([{ ...beta, pinned: true }, alpha]);
  });

  it("replaces the project list with the order returned by unpinning", async () => {
    const alpha = project("alpha", "/alpha");
    const beta = { ...project("beta", "/beta"), pinned: true };
    let state: AppState = { ...initialAppState(), projects: [beta, alpha] };
    const unpinProject = vi.fn().mockResolvedValue([project("beta", "/beta"), alpha]);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject: vi.fn(), unpinProject, closeProjectTree: vi.fn() } },
    );

    await controller.unpinProject(beta.id);

    expect(unpinProject).toHaveBeenCalledWith(beta.id, "local");
    expect(state.projects).toEqual([project("beta", "/beta"), alpha]);
  });

  it("reports a failed pin through app state without changing the project list", async () => {
    const alpha = project("alpha", "/alpha");
    let state: AppState = { ...initialAppState(), projects: [alpha] };
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn(),
          closeProject: vi.fn(),
          pinProject: vi.fn().mockRejectedValue(new Error("Project not found")),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
        },
      },
    );

    await controller.pinProject(alpha.id);

    expect(state.projects).toEqual([alpha]);
    expect(state.error).toContain("Project not found");
  });

  it("serializes same-machine pin changes and publishes only the latest response", async () => {
    const alpha = project("alpha", "/alpha");
    const pinnedBeta = { ...project("beta", "/beta"), pinned: true };
    const firstResponse = [{ ...alpha, pinned: true }, pinnedBeta];
    const secondResponse = [project("beta", "/beta"), { ...alpha, pinned: true }];
    let state: AppState = { ...initialAppState(), projects: [pinnedBeta, alpha] };
    const first = deferred<Project[]>();
    const second = deferred<Project[]>();
    const mutationCalls: string[] = [];
    const pinProject = vi.fn(() => {
      mutationCalls.push("pin alpha");
      return first.promise;
    });
    const unpinProject = vi.fn(() => {
      mutationCalls.push("unpin beta");
      return second.promise;
    });
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject, unpinProject, closeProjectTree: vi.fn() } },
    );

    const firstMutation = controller.pinProject(alpha.id);
    const secondMutation = controller.unpinProject(pinnedBeta.id);

    expect(mutationCalls).toEqual(["pin alpha"]);
    expect(unpinProject).not.toHaveBeenCalled();

    first.resolve(firstResponse);
    await firstMutation;
    await Promise.resolve();

    expect(mutationCalls).toEqual(["pin alpha", "unpin beta"]);
    expect(state.projects).toEqual([pinnedBeta, alpha]);

    second.resolve(secondResponse);
    await secondMutation;

    expect(state.projects).toEqual(secondResponse);
  });

  it("keeps pin mutation queues independent between machines", async () => {
    const localProject = project("local-project", "/local");
    const remoteProject = project("remote-project", "/remote");
    const localResponse = [{ ...localProject, pinned: true }];
    const remoteResponse = [{ ...remoteProject, pinned: true }];
    let state: AppState = { ...initialAppState(), selectedMachine: localMachine, projects: [localProject] };
    const pendingLocalPin = deferred<Project[]>();
    const pendingRemotePin = deferred<Project[]>();
    const pinProject = vi.fn((_projectId: string, machineId?: string) => (
      machineId === "local" ? pendingLocalPin.promise : pendingRemotePin.promise
    ));
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject, unpinProject: vi.fn(), closeProjectTree: vi.fn() } },
    );

    const localMutation = controller.pinProject(localProject.id);
    state = { ...state, selectedMachine: remoteMachine, projects: [remoteProject] };
    const remoteMutation = controller.pinProject(remoteProject.id);

    expect(pinProject.mock.calls).toEqual([
      [localProject.id, "local"],
      [remoteProject.id, "remote"],
    ]);

    pendingRemotePin.resolve(remoteResponse);
    await remoteMutation;
    expect(state.projects).toEqual(remoteResponse);

    pendingLocalPin.resolve(localResponse);
    await localMutation;
    expect(state.projects).toEqual(remoteResponse);
  });

  it("continues a same-machine pin queue after an earlier rejection", async () => {
    const alpha = project("alpha", "/alpha");
    const pinnedBeta = { ...project("beta", "/beta"), pinned: true };
    const secondResponse = [project("beta", "/beta"), alpha];
    let state: AppState = { ...initialAppState(), projects: [pinnedBeta, alpha] };
    const first = deferred<Project[]>();
    const second = deferred<Project[]>();
    const pinProject = vi.fn(() => first.promise);
    const unpinProject = vi.fn(() => second.promise);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject, unpinProject, closeProjectTree: vi.fn() } },
    );

    const firstMutation = controller.pinProject(alpha.id);
    const secondMutation = controller.unpinProject(pinnedBeta.id);

    first.reject(new Error("pin failed"));
    await firstMutation;
    await Promise.resolve();

    expect(unpinProject).toHaveBeenCalledWith(pinnedBeta.id, "local");
    expect(state.error).toBe("");

    second.resolve(secondResponse);
    await secondMutation;

    expect(state.projects).toEqual(secondResponse);
  });

  it("keeps an older same-id load from surviving a machine-selection ABA", async () => {
    const initialLocalProjects = [project("initial-local", "/initial-local")];
    const staleLocalProjects = [project("stale-local", "/stale-local")];
    const remoteProjects = [project("remote", "/remote")];
    const freshLocalProjects = [project("fresh-local", "/fresh-local")];
    let state: AppState = { ...initialAppState(), selectedMachine: localMachine, projects: initialLocalProjects };
    const publishedProjectLists: Project[][] = [];
    const pendingStaleLocalLoad = deferred<Project[]>();
    const pendingFreshLocalLoad = deferred<Project[]>();
    const projects = vi.fn()
      .mockReturnValueOnce(pendingStaleLocalLoad.promise)
      .mockResolvedValueOnce(remoteProjects)
      .mockReturnValueOnce(pendingFreshLocalLoad.promise);
    const controller = new ProjectController(
      () => state,
      (patch) => {
        if (patch.projects !== undefined) publishedProjectLists.push(patch.projects);
        state = { ...state, ...patch };
      },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects,
          addProject: vi.fn(),
          closeProject: vi.fn(),
          pinProject: vi.fn(),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
        },
      },
    );

    const staleLocalLoad = controller.loadProjects();
    state = { ...state, selectedMachine: remoteMachine };
    await controller.loadProjects();
    state = { ...state, selectedMachine: localMachine };
    const freshLocalLoad = controller.loadProjects();

    pendingStaleLocalLoad.resolve(staleLocalProjects);
    await staleLocalLoad;

    expect(projects.mock.calls).toEqual([["local"], ["remote"], ["local"]]);
    expect(publishedProjectLists).toEqual([remoteProjects]);
    expect(state.projects).toEqual(remoteProjects);
    expect(state.isLoadingProjects).toBe(true);

    pendingFreshLocalLoad.resolve(freshLocalProjects);
    await freshLocalLoad;

    expect(publishedProjectLists).toEqual([remoteProjects, freshLocalProjects]);
    expect(state.projects).toEqual(freshLocalProjects);
    expect(state.isLoadingProjects).toBe(false);
  });

  it("reconciles a stale pin success after machine selection returns to the same id", async () => {
    const initialLocalProject = project("initial-local", "/initial-local");
    const initialLocalProjects = [initialLocalProject];
    const remoteProjects = [project("remote", "/remote")];
    const freshLocalProjects = [project("fresh-local", "/fresh-local")];
    const stalePinProjects = [project("stale-pin", "/stale-pin")];
    const reconciledLocalProjects = [project("reconciled-local", "/reconciled-local")];
    let state: AppState = { ...initialAppState(), selectedMachine: localMachine, projects: initialLocalProjects };
    const publishedProjectLists: Project[][] = [];
    const pendingPin = deferred<Project[]>();
    const projects = vi.fn()
      .mockResolvedValueOnce(remoteProjects)
      .mockResolvedValueOnce(freshLocalProjects)
      .mockResolvedValueOnce(reconciledLocalProjects);
    const controller = new ProjectController(
      () => state,
      (patch) => {
        if (patch.projects !== undefined) publishedProjectLists.push(patch.projects);
        state = { ...state, ...patch };
      },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects,
          addProject: vi.fn(),
          closeProject: vi.fn(),
          pinProject: vi.fn().mockReturnValue(pendingPin.promise),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
        },
      },
    );

    const pin = controller.pinProject(initialLocalProject.id);
    state = { ...state, selectedMachine: remoteMachine };
    await controller.loadProjects();
    state = { ...state, selectedMachine: localMachine };
    await controller.loadProjects();

    pendingPin.resolve(stalePinProjects);
    await pin;

    expect(projects).toHaveBeenNthCalledWith(1, "remote");
    expect(projects).toHaveBeenNthCalledWith(2, "local");
    expect(projects).toHaveBeenNthCalledWith(3, "local");
    expect(publishedProjectLists).toEqual([remoteProjects, freshLocalProjects, reconciledLocalProjects]);
    expect(state.projects).toEqual(reconciledLocalProjects);
  });

  it("ignores a stale pin failure after machine selection returns to the same id", async () => {
    const initialLocalProject = project("initial-local", "/initial-local");
    const initialLocalProjects = [initialLocalProject];
    const remoteProjects = [project("remote", "/remote")];
    const freshLocalProjects = [project("fresh-local", "/fresh-local")];
    let state: AppState = { ...initialAppState(), selectedMachine: localMachine, projects: initialLocalProjects };
    const pendingPin = deferred<Project[]>();
    const projects = vi.fn()
      .mockResolvedValueOnce(remoteProjects)
      .mockResolvedValueOnce(freshLocalProjects);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects,
          addProject: vi.fn(),
          closeProject: vi.fn(),
          pinProject: vi.fn().mockReturnValue(pendingPin.promise),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn(),
        },
      },
    );

    const pin = controller.pinProject(initialLocalProject.id);
    state = { ...state, selectedMachine: remoteMachine };
    await controller.loadProjects();
    state = { ...state, selectedMachine: localMachine };
    await controller.loadProjects();
    state = { ...state, error: "current error" };

    pendingPin.reject(new Error("stale pin failure"));
    await pin;

    expect(state.projects).toEqual(freshLocalProjects);
    expect(state.error).toBe("current error");
  });

  it("ignores a stale pin response after the selected machine changed", async () => {
    const alpha = project("alpha", "/alpha");
    const beta = project("beta", "/beta");
    let state: AppState = { ...initialAppState(), projects: [alpha, beta] };
    const pending = deferred<Project[]>();
    const pinProject = vi.fn().mockReturnValue(pending.promise);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject, unpinProject: vi.fn(), closeProjectTree: vi.fn() } },
    );

    const pin = controller.pinProject(beta.id);
    expect(pinProject).toHaveBeenCalledWith(beta.id, "local");
    state = { ...state, selectedMachine: remoteMachine };
    pending.resolve([{ ...beta, pinned: true }, alpha]);
    await pin;

    expect(state.projects).toEqual([alpha, beta]);
    expect(state.error).toBe("");
  });

  it("ignores a stale unpin response after the selected machine changed", async () => {
    const alpha = project("alpha", "/alpha");
    const beta = { ...project("beta", "/beta"), pinned: true };
    let state: AppState = { ...initialAppState(), projects: [beta, alpha] };
    const pending = deferred<Project[]>();
    const unpinProject = vi.fn().mockReturnValue(pending.promise);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject: vi.fn(), unpinProject, closeProjectTree: vi.fn() } },
    );

    const unpin = controller.unpinProject(beta.id);
    expect(unpinProject).toHaveBeenCalledWith(beta.id, "local");
    state = { ...state, selectedMachine: remoteMachine };
    pending.resolve([project("beta", "/beta"), alpha]);
    await unpin;

    expect(state.projects).toEqual([beta, alpha]);
    expect(state.error).toBe("");
  });

  it("ignores a stale pin failure after the selected machine changed", async () => {
    const alpha = project("alpha", "/alpha");
    let state: AppState = { ...initialAppState(), projects: [alpha], error: "earlier error" };
    const pending = deferred<Project[]>();
    const pinProject = vi.fn().mockReturnValue(pending.promise);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject, unpinProject: vi.fn(), closeProjectTree: vi.fn() } },
    );

    const pin = controller.pinProject(alpha.id);
    expect(pinProject).toHaveBeenCalledWith(alpha.id, "local");
    state = { ...state, selectedMachine: remoteMachine };
    pending.reject(new Error("Project not found"));
    await pin;

    expect(state.projects).toEqual([alpha]);
    expect(state.error).toBe("earlier error");
  });

  it("does not let an older load overwrite a newer pin result", async () => {
    const alpha = project("alpha", "/alpha");
    const beta = project("beta", "/beta");
    const pinnedBeta = { ...beta, pinned: true };
    let state: AppState = { ...initialAppState(), projects: [alpha, beta] };
    const publishedProjectLists: Project[][] = [];
    const pendingOldLoad = deferred<Project[]>();
    const projects = vi.fn().mockReturnValue(pendingOldLoad.promise);
    const pinProject = vi.fn().mockResolvedValue([pinnedBeta, alpha]);
    const controller = new ProjectController(
      () => state,
      (patch) => {
        if (patch.projects !== undefined) publishedProjectLists.push(patch.projects);
        state = { ...state, ...patch };
      },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects, addProject: vi.fn(), closeProject: vi.fn(), pinProject, unpinProject: vi.fn(), closeProjectTree: vi.fn() } },
    );

    const oldLoad = controller.loadProjects();
    await controller.pinProject(beta.id);

    expect(publishedProjectLists).toEqual([[pinnedBeta, alpha]]);
    expect(state.projects).toEqual([pinnedBeta, alpha]);
    expect(state.isLoadingProjects).toBe(false);

    pendingOldLoad.resolve([alpha, beta]);
    await oldLoad;

    expect(publishedProjectLists).toEqual([[pinnedBeta, alpha]]);
    expect(state.projects).toEqual([pinnedBeta, alpha]);
    expect(state.error).toBe("");
    expect(state.isLoadingProjects).toBe(false);
  });

  it("does not publish an older load failure after a newer unpin result", async () => {
    const alpha = project("alpha", "/alpha");
    const beta = { ...project("beta", "/beta"), pinned: true };
    let state: AppState = { ...initialAppState(), projects: [beta, alpha] };
    const publishedProjectLists: Project[][] = [];
    const pendingOldLoad = deferred<Project[]>();
    const projects = vi.fn().mockReturnValue(pendingOldLoad.promise);
    const unpinProject = vi.fn().mockResolvedValue([project("beta", "/beta"), alpha]);
    const controller = new ProjectController(
      () => state,
      (patch) => {
        if (patch.projects !== undefined) publishedProjectLists.push(patch.projects);
        state = { ...state, ...patch };
      },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects, addProject: vi.fn(), closeProject: vi.fn(), pinProject: vi.fn(), unpinProject, closeProjectTree: vi.fn() } },
    );

    const oldLoad = controller.loadProjects();
    await controller.unpinProject(beta.id);

    expect(state.projects).toEqual([project("beta", "/beta"), alpha]);
    expect(state.isLoadingProjects).toBe(false);

    pendingOldLoad.reject(new Error("older load failure"));
    await oldLoad;

    expect(publishedProjectLists).toEqual([[project("beta", "/beta"), alpha]]);
    expect(state.projects).toEqual([project("beta", "/beta"), alpha]);
    expect(state.error).toBe("");
    expect(state.isLoadingProjects).toBe(false);
  });
});

function createHarness(options: {
  projects: Project[];
  selectedProject?: Project;
  api?: { closeProjectTree?: (projectId: string, machineId?: string) => Promise<{ closedProjectIds: string[] }> };
  onBeforeResolve?: () => void;
}) {
  let state: AppState = {
    ...initialAppState(),
    projects: options.projects,
    ...(options.selectedProject === undefined ? {} : { selectedProject: options.selectedProject }),
  };
  const forgottenProjectIds: string[] = [];
  let clearSelectionCallCount = 0;
  const controller = new ProjectController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    {
      selectProject: vi.fn(),
      forgetProject: vi.fn((projectId: string) => { forgottenProjectIds.push(projectId); }),
      clearSelection: vi.fn(() => { clearSelectionCallCount += 1; }),
    },
    {
      api: {
        projects: vi.fn(),
        addProject: vi.fn(),
        closeProject: vi.fn(),
        pinProject: vi.fn(),
        unpinProject: vi.fn(),
        closeProjectTree: (projectId: string, machineId?: string) => Promise.resolve().then(() => {
          options.onBeforeResolve?.();
          return options.api?.closeProjectTree?.(projectId, machineId) ?? Promise.resolve({ closedProjectIds: [] });
        }),
      },
    },
  );
  return {
    controller,
    state: () => state,
    forgottenProjectIds,
    get clearSelectionCalls() {
      return clearSelectionCallCount;
    },
    switchMachine: (machineId: string) => {
      state = { ...state, selectedMachine: { id: machineId, name: machineId, kind: "remote", createdAt: "now", updatedAt: "now" } };
    },
  };
}

describe("closeProjectTree", () => {
  it("removes every closed project from the catalog", async () => {
    const harness = createHarness({
      projects: [
        { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "other", name: "Other", path: "/other", createdAt: "2026-08-07T00:00:00.000Z" },
      ],
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root", "child"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.state().projects.map((project) => project.id)).toEqual(["other"]);
  });

  it("forgets workspace state for every closed project", async () => {
    const harness = createHarness({
      projects: [
        { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
      ],
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root", "child"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.forgottenProjectIds).toEqual(["root", "child"]);
  });

  it("clears the selection when the selected project was a closed descendant", async () => {
    const child = { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" };
    const harness = createHarness({
      projects: [{ id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" }, child],
      selectedProject: child,
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root", "child"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.clearSelectionCalls).toBe(1);
  });

  it("keeps the selection when it was not closed", async () => {
    const other = { id: "other", name: "Other", path: "/other", createdAt: "2026-08-07T00:00:00.000Z" };
    const harness = createHarness({
      projects: [{ id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" }, other],
      selectedProject: other,
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.clearSelectionCalls).toBe(0);
  });

  it("reconciles against the returned ids rather than a locally computed subtree", async () => {
    const harness = createHarness({
      projects: [
        { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
      ],
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.state().projects.map((project) => project.id)).toEqual(["child"]);
  });

  it("surfaces a failure through the error state and leaves the catalog intact", async () => {
    const harness = createHarness({
      projects: [{ id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" }],
      api: { closeProjectTree: () => Promise.reject(new Error("boom")) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.state().error).toContain("boom");
    expect(harness.state().projects).toHaveLength(1);
  });

  it("ignores a result that arrives after the machine changed", async () => {
    const harness = createHarness({
      projects: [{ id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" }],
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root"] }) },
      onBeforeResolve: () => { harness.switchMachine("other-machine"); },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.state().projects).toHaveLength(1);
  });

  it("does not let an older in-flight catalog response restore closed projects", async () => {
    const root = project("root", "/work");
    const child = project("child", "/work/app1");
    const other = project("other", "/other");
    let state: AppState = { ...initialAppState(), projects: [root, child, other] };
    const publishedProjectLists: Project[][] = [];
    const pendingOldLoad = deferred<Project[]>();
    const projects = vi.fn().mockReturnValue(pendingOldLoad.promise);
    const controller = new ProjectController(
      () => state,
      (patch) => {
        if (patch.projects !== undefined) publishedProjectLists.push(patch.projects);
        state = { ...state, ...patch };
      },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects,
          addProject: vi.fn(),
          closeProject: vi.fn(),
          pinProject: vi.fn(),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn().mockResolvedValue({ closedProjectIds: ["root", "child"] }),
        },
      },
    );

    const oldLoad = controller.loadProjects();
    await controller.closeProjectTree(root.id);

    expect(state.projects.map((project) => project.id)).toEqual(["other"]);

    pendingOldLoad.resolve([root, child, other]);
    await oldLoad;

    expect(publishedProjectLists).toEqual([[other]]);
    expect(state.projects.map((project) => project.id)).toEqual(["other"]);
    expect(state.error).toBe("");
    expect(state.isLoadingProjects).toBe(false);
  });

  it("reloads the catalog when a newer operation superseded the close-tree response", async () => {
    const root = project("root", "/work");
    const other = project("other", "/other");
    let state: AppState = { ...initialAppState(), projects: [root, other] };
    const publishedProjectLists: Project[][] = [];
    const pendingLoad = deferred<Project[]>();
    const pendingClose = deferred<{ closedProjectIds: string[] }>();
    const projects = vi.fn()
      .mockReturnValueOnce(pendingLoad.promise)
      .mockResolvedValueOnce([other]);
    const controller = new ProjectController(
      () => state,
      (patch) => {
        if (patch.projects !== undefined) publishedProjectLists.push(patch.projects);
        state = { ...state, ...patch };
      },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects,
          addProject: vi.fn(),
          closeProject: vi.fn(),
          pinProject: vi.fn(),
          unpinProject: vi.fn(),
          closeProjectTree: vi.fn().mockReturnValue(pendingClose.promise),
        },
      },
    );

    const close = controller.closeProjectTree(root.id);
    const load = controller.loadProjects();

    pendingLoad.resolve([root, other]);
    await load;

    expect(state.projects.map((project) => project.id)).toEqual(["root", "other"]);

    pendingClose.resolve({ closedProjectIds: ["root"] });
    await close;

    expect(projects).toHaveBeenCalledTimes(2);
    expect(publishedProjectLists).toEqual([[root, other], [other]]);
    expect(state.projects.map((project) => project.id)).toEqual(["other"]);
    expect(state.error).toBe("");
    expect(state.isLoadingProjects).toBe(false);
  });
});
