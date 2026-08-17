/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-assignment */
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalCommandRun, TerminalCommandRunHandle, WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import type { WorkspaceTask, WorkspaceTaskRef, WorkspaceTaskScope } from "../../src/shared/workspaceTasks";

interface CatalogState {
  readonly kind: "loading" | "loaded" | "missing" | "invalid" | "unavailable" | "error";
  readonly config?: { readonly version: 1; readonly tasks: readonly Readonly<WorkspaceTask>[] };
  readonly message?: string;
  readonly hint?: string;
  readonly detail?: string;
  readonly refreshing?: boolean;
  readonly refreshError?: string;
}

interface WorkspaceTasksWorkspaceState {
  readonly workspace: CatalogState;
  readonly global: CatalogState;
  readonly move?: { readonly kind: "partial" | "unknown-outcome" | "conflict"; readonly message: string; readonly retryAllowed: boolean };
  readonly mutationGate?: { readonly scopes: readonly WorkspaceTaskScope[]; readonly message: string };
}

interface WorkspaceTasksActions {
  create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void>;
  update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>;
  remove(ref: WorkspaceTaskRef): Promise<void>;
  move(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>;
  retryMove(): Promise<void>;
  refresh(): Promise<void>;
}
import { defineTasksPanelElement, tasksPanelTagName } from "./tasksPanelElement.js";

interface TasksPanelElement extends HTMLElement {
  context: WorkspacePanelContext | undefined;
  workspaceTasksState: WorkspaceTasksWorkspaceState;
  workspaceTasksActions: WorkspaceTasksActions;
}

const workspaceTask = (overrides: Partial<WorkspaceTask> = {}): WorkspaceTask => ({
  id: "build",
  title: "Build",
  command: "npm run build",
  confirm: false,
  ...overrides,
});

const state = (workspace: readonly WorkspaceTask[], global: readonly WorkspaceTask[]): WorkspaceTasksWorkspaceState => ({
  workspace: { kind: "loaded", config: { version: 1, tasks: workspace }, refreshing: false },
  global: { kind: "loaded", config: { version: 1, tasks: global }, refreshing: false },
});

beforeEach(() => {
  defineTasksPanelElement();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("workspace tasks panel", () => {
  it("renders All, Global, and Project filter buttons with counts and pressed state", () => {
    const panel = mount(state([
      workspaceTask({ id: "project-build", title: "Project Build" }),
    ], [
      workspaceTask({ id: "global-build", title: "Global Build" }),
      workspaceTask({ id: "global-test", title: "Global Test" }),
    ]));

    expect(button(panel, "[data-filter='all']").textContent).toContain("All");
    expect(button(panel, "[data-filter='global']").textContent).toContain("Global");
    expect(button(panel, "[data-filter='workspace']").textContent).toContain("Project");
    expect(button(panel, "[data-filter='all']").getAttribute("aria-pressed")).toBe("true");
    expect(button(panel, "[data-filter='global']").getAttribute("aria-pressed")).toBe("false");
    expect(button(panel, "[data-filter='global']").textContent).toContain("2");
    expect(button(panel, "[data-filter='workspace']").textContent).toContain("1");
    expect(panel.shadowRoot?.querySelector("[role='group']")?.getAttribute("aria-label")).toBe("Task scope");
  });

  it("keeps duplicate IDs independently actionable and includes scope in accessible names", () => {
    const runCommand = vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>(() => Promise.resolve(terminalHandle()));
    const panel = mount(state([
      workspaceTask({ title: "Project Build", group: "Checks" }),
    ], [
      workspaceTask({ title: "Global Build", group: "Checks" }),
    ]), { runCommand });

    const rows = panel.shadowRoot?.querySelectorAll("[data-task-ref='global:build'], [data-task-ref='workspace:build']");
    expect(rows).toHaveLength(2);
    const editButtons = [...(panel.shadowRoot?.querySelectorAll("button[data-edit-task]") ?? [])] as HTMLButtonElement[];
    expect(editButtons.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Edit Global Build (Global)",
      "Edit Project Build (Project)",
    ]);
    const runButtons = [...(panel.shadowRoot?.querySelectorAll("button[data-run-task]") ?? [])] as HTMLButtonElement[];
    runButtons[0]?.click();
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ "task.scope": "global", "task.id": "build" }) }));
  });

  it("renders native collapsed details groups with counts and preserves expansion by scoped group key", () => {
    const initial = state([
      workspaceTask({ id: "project-build", title: "Project Build", group: "Checks" }),
    ], [
      workspaceTask({ id: "global-build", title: "Global Build", group: "Checks" }),
    ]);
    const panel = mount(initial);
    const groups = panel.shadowRoot?.querySelectorAll("details[data-group-key]");
    expect(groups).toHaveLength(2);
    expect([...groups ?? []].every((item) => !(item as HTMLDetailsElement).open)).toBe(true);
    expect(panel.shadowRoot?.textContent).toContain("1 task");

    const globalGroup = panel.shadowRoot?.querySelector("details[data-group-scope='global']") as HTMLDetailsElement | null;
    if (globalGroup === null) throw new Error("Global group missing");
    globalGroup.open = true;
    globalGroup.dispatchEvent(new Event("toggle"));

    panel.workspaceTasksState = initial;
    expect((panel.shadowRoot?.querySelector("details[data-group-scope='global']") as HTMLDetailsElement | null)?.open).toBe(true);
    expect((panel.shadowRoot?.querySelector("details[data-group-scope='workspace']") as HTMLDetailsElement | null)?.open).toBe(false);

    button(panel, "[data-filter='global']").click();
    button(panel, "[data-filter='workspace']").click();
    button(panel, "[data-filter='all']").click();
    expect((panel.shadowRoot?.querySelector("details[data-group-scope='global']") as HTMLDetailsElement | null)?.open).toBe(true);
  });

  it("shows a scoped failure without hiding the usable source", () => {
    const panel = mount({
      workspace: { kind: "loaded", config: { version: 1, tasks: [workspaceTask({ title: "Project Build" })] }, refreshing: false },
      global: { kind: "unavailable", message: "Global unavailable", hint: "Refresh." },
    });

    expect(panel.shadowRoot?.textContent).toContain("Project Build");
    expect(panel.shadowRoot?.textContent).toContain("Global unavailable");
    button(panel, "[data-filter='workspace']").click();
    expect(panel.shadowRoot?.textContent).toContain("Project Build");
  });
});

function mount(nextState: WorkspaceTasksWorkspaceState, options: { runCommand?: WorkspacePanelContext["terminal"]["runCommand"] } = {}): TasksPanelElement {
  const panel = document.createElement(tasksPanelTagName) as TasksPanelElement;
  panel.context = createContext(options.runCommand);
  panel.workspaceTasksActions = {
    create: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    move: vi.fn(() => Promise.resolve()),
    retryMove: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
  panel.workspaceTasksState = nextState;
  document.body.append(panel);
  return panel;
}

function button(panel: HTMLElement, selector: string): HTMLButtonElement {
  const element = panel.shadowRoot?.querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button ${selector}`);
  return element;
}

function createContext(runCommand: WorkspacePanelContext["terminal"]["runCommand"] = vi.fn(() => Promise.resolve(terminalHandle()))): WorkspacePanelContext {
  return {
    machine: { id: "local", kind: "local", name: "Local" },
    workspace: { id: "ws", projectId: "project", path: "/tmp/ws", label: "Project", isMain: true, isGitRepo: false, isGitWorktree: false },
    state: {},
    files: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      moveFile: vi.fn(),
    },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand },
    host: { requestRender: vi.fn() },
  };
}

function terminalHandle(): TerminalCommandRunHandle {
  const run: TerminalCommandRun = {
    id: "run",
    origin: "plugin",
    projectId: "project",
    workspaceId: "ws",
    terminalId: "term",
    title: "Build",
    command: "npm run build",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
  return { run, completed: Promise.resolve(run) };
}
