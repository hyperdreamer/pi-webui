import { describe, expect, it, vi } from "vitest";
import type { Project, SessionInfo, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import type { SessionController } from "./sessionController";
import { InMemoryWorkspaceSelectionMemory } from "./workspaceSelection";
import { WorkspaceController } from "./workspaceController";

const project: Project = { id: "project-1", name: "workspace", path: "/workspace", createdAt: "now" };
const otherProject: Project = { id: "project-2", name: "other", path: "/other", createdAt: "now" };
const mainWorkspace = workspace(project, "workspace-1", project.path);
const otherWorkspace = workspace(otherProject, "workspace-2", otherProject.path);
const featureWorkspace = workspace(project, "workspace-feature", "/workspace-feature");

interface Recorded {
  signal: AbortSignal | undefined;
}

/**
 * A workspace/session client that records the signal it was called with and
 * never settles, so a test can assert what switching away does to the previous
 * selection's in-flight reads.
 */
function pendingApi(): {
  api: { workspaces: (projectId: string, machineId?: string, signal?: AbortSignal) => Promise<Workspace[]>; sessions: (cwd: string, machineId?: string, signal?: AbortSignal) => Promise<SessionInfo[]> };
  workspaceCalls: Recorded[];
  sessionCalls: Recorded[];
} {
  const workspaceCalls: Recorded[] = [];
  const sessionCalls: Recorded[] = [];
  return {
    workspaceCalls,
    sessionCalls,
    api: {
      workspaces: (_projectId, _machineId, signal) => {
        workspaceCalls.push({ signal });
        return new Promise<Workspace[]>(() => undefined);
      },
      sessions: (_cwd, _machineId, signal) => {
        sessionCalls.push({ signal });
        return new Promise<SessionInfo[]>(() => undefined);
      },
    },
  };
}

function controllerWith(api: ReturnType<typeof pendingApi>["api"], seed: Partial<AppState> = {}) {
  let state: AppState = { ...initialAppState(), projects: [project, otherProject], ...seed };
  const sessions: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession"> = {
    clearActiveSession: () => undefined,
    preferredSession: () => undefined,
    selectSession: () => Promise.resolve(),
  };
  const controller = new WorkspaceController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    sessions,
    new InMemoryWorkspaceSelectionMemory(),
    { api },
  );
  return { controller, state: () => state };
}

describe("WorkspaceController selection load cancellation", () => {
  it("aborts a project's workspace read when another project is selected", async () => {
    const { api, workspaceCalls } = pendingApi();
    const { controller } = controllerWith(api);

    void controller.selectProject(project);
    await Promise.resolve();
    expect(workspaceCalls).toHaveLength(1);
    expect(workspaceCalls[0]?.signal?.aborted).toBe(false);

    void controller.selectProject(otherProject);
    await Promise.resolve();

    expect(workspaceCalls[0]?.signal?.aborted).toBe(true);
    expect(workspaceCalls[1]?.signal?.aborted).toBe(false);
  });

  it("aborts a workspace's session read when another workspace is selected", async () => {
    const { api, sessionCalls } = pendingApi();
    const { controller } = controllerWith(api, { selectedProject: project, workspaces: [mainWorkspace, featureWorkspace] });

    void controller.selectWorkspace(mainWorkspace);
    await Promise.resolve();
    expect(sessionCalls).toHaveLength(1);

    void controller.selectWorkspace(featureWorkspace);
    await Promise.resolve();

    expect(sessionCalls[0]?.signal?.aborted).toBe(true);
    expect(sessionCalls[1]?.signal?.aborted).toBe(false);
  });

  it("aborts an in-flight workspace read when the selection is cleared", async () => {
    const { api, workspaceCalls } = pendingApi();
    const { controller } = controllerWith(api);

    void controller.selectProject(project);
    await Promise.resolve();

    controller.clearSelection();

    expect(workspaceCalls[0]?.signal?.aborted).toBe(true);
  });

  it("aborts a superseded workspace's session read when a project selection replaces it", async () => {
    const { api, sessionCalls, workspaceCalls } = pendingApi();
    const { controller } = controllerWith(api, { selectedProject: project, workspaces: [mainWorkspace] });

    void controller.selectWorkspace(mainWorkspace);
    await Promise.resolve();
    expect(sessionCalls).toHaveLength(1);

    void controller.selectProject(otherProject);
    await Promise.resolve();

    expect(sessionCalls[0]?.signal?.aborted).toBe(true);
    expect(workspaceCalls[0]?.signal?.aborted).toBe(false);
  });

  // Supersession is the expected outcome of switching, so an aborted read must
  // not leave a user-visible error or a stuck loading indicator behind.
  it("reports no error when a superseded workspace read rejects with its abort", async () => {
    const api = {
      workspaces: (_projectId: string, _machineId?: string, signal?: AbortSignal) => new Promise<Workspace[]>((_resolve, reject) => {
        signal?.addEventListener("abort", () => { reject(asError(signal.reason)); });
      }),
      sessions: () => Promise.resolve<SessionInfo[]>([]),
    };
    const { controller, state } = controllerWith(api);

    const superseded = controller.selectProject(project);
    await Promise.resolve();
    void controller.selectProject(otherProject);
    await superseded;

    expect(state().error).toBe("");
  });

  it("keeps the newest selection loading after an older one is aborted", async () => {
    const api = {
      workspaces: (projectId: string, _machineId?: string, signal?: AbortSignal) => new Promise<Workspace[]>((resolve, reject) => {
        signal?.addEventListener("abort", () => { reject(asError(signal.reason)); });
        if (projectId === otherProject.id) resolve([otherWorkspace]);
      }),
      sessions: () => Promise.resolve<SessionInfo[]>([]),
    };
    const { controller, state } = controllerWith(api);

    const superseded = controller.selectProject(project);
    await Promise.resolve();
    const current = controller.selectProject(otherProject);
    await Promise.allSettled([superseded, current]);

    expect(state().selectedProject?.id).toBe(otherProject.id);
    expect(state().error).toBe("");
    expect(state().isLoadingWorkspaces).toBe(false);
  });

  // Background catalog topology can deliver a project's workspaces before the
  // foreground read returns. Completing the selection that way must inherit the
  // open load, never restart it, or it would abort the read it is completing.
  it("does not abort a foreground workspace read when catalog topology completes it", async () => {
    const listSessions = vi.fn((...args: [string, (string | undefined)?, (AbortSignal | undefined)?]) => { void args; return Promise.resolve<SessionInfo[]>([]); });
    const workspaceSignals: (AbortSignal | undefined)[] = [];
    const api = {
      workspaces: (_projectId: string, _machineId?: string, signal?: AbortSignal) => {
        workspaceSignals.push(signal);
        return new Promise<Workspace[]>(() => undefined);
      },
      sessions: listSessions,
    };
    const { controller } = controllerWith(api, {
      selectedProject: project,
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
    });

    void controller.selectProject(project);
    await Promise.resolve();
    const foregroundSignal = workspaceSignals[0];
    expect(foregroundSignal?.aborted).toBe(false);

    await controller.reconcileProjectCatalog({ machineId: "local", project, workspaces: [mainWorkspace] });

    expect(foregroundSignal?.aborted).toBe(false);
    expect(listSessions.mock.calls.some((call) => call[2] === foregroundSignal)).toBe(true);
  });

  // A fallback chosen by background reconciliation (no foreground selection in
  // flight) is background work. Borrowing the foreground load would let a later
  // switch cancel a recovery the user never initiated.
  it("runs a background catalog fallback selection outside the foreground load", async () => {
    const listSessions = vi.fn((...args: [string, (string | undefined)?, (AbortSignal | undefined)?]) => { void args; return Promise.resolve<SessionInfo[]>([]); });
    const api = {
      workspaces: () => Promise.resolve<Workspace[]>([]),
      sessions: listSessions,
    };
    const { controller } = controllerWith(api, {
      selectedProject: project,
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
    });

    await controller.reconcileProjectCatalog({ machineId: "local", project, workspaces: [mainWorkspace] });

    expect(listSessions).toHaveBeenCalled();
    expect(listSessions.mock.calls.every((call) => call[2] === undefined)).toBe(true);
  });
});

function workspace(projectForWorkspace: Project, id: string, path: string): Workspace {
  return {
    id,
    projectId: projectForWorkspace.id,
    path,
    label: id,
    isMain: path === projectForWorkspace.path,
    isGitRepo: false,
    isGitWorktree: false,
  };
}

/**
 * A cancelled fetch rejects with the signal's reason; typed as `Error` so the
 * fake reads like the real transport and satisfies promise-rejection linting.
 */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
