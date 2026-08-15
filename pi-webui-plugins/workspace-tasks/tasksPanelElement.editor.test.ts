/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FileContentResponse,
  TerminalCommandRun,
  TerminalCommandRunHandle,
  WorkspacePanelContext,
  WriteWorkspaceFileResponse,
} from "@hyperdreamer/pi-webui/plugin-api";
import { TASKS_CONFIG_PATH, serializeWorkspaceTasksConfig } from "./config.js";
import {
  clearWorkspaceTasksStateForTesting,
} from "./workspaceTasksClient.js";
import { defineTasksPanelElement, tasksPanelTagName } from "./tasksPanelElement.js";

interface TasksPanelElement extends HTMLElement {
  context: WorkspacePanelContext | undefined;
}

interface PartialFixtureOverrides {
  content?: string | undefined;
  machineId?: string;
  projectId?: string;
  workspaceId?: string;
  readFile?: WorkspacePanelContext["files"]["readFile"];
  writeFile?: WorkspacePanelContext["files"]["writeFile"];
  terminal?: WorkspacePanelContext["terminal"];
}

const initialConfig = JSON.stringify({
  version: 1,
  tasks: [
    { id: "build", title: "Build", command: "npm run build", group: "Checks", confirm: false },
    { id: "test", title: "Test", command: "npm test", group: "Checks", confirm: true },
  ],
});

beforeEach(() => {
  defineTasksPanelElement();
  clearWorkspaceTasksStateForTesting();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("workspace tasks editor", () => {
  it.each([
    ["loaded", initialConfig],
    ["missing", undefined],
  ])("opens Add Task from the %s state", async (_label, content) => {
    const panel = await mountLoadedPanel(createContext({ content }));

    requireButton(panel, "button[data-add-task]").click();

    const title = requireInput(panel, "input[data-editor-title]");
    expect(title).toBeTruthy();
    expect(requireTextarea(panel, "textarea[data-editor-command]")).toBeTruthy();
    expect(requireShadow(panel).activeElement).toBe(title);
  });

  it("suggests an ID until the user directly edits it, including clearing it", async () => {
    const panel = await mountLoadedPanel(createContext({ content: undefined }));
    requireButton(panel, "button[data-add-task]").click();

    const title = requireInput(panel, "input[data-editor-title]");
    const id = requireInput(panel, "input[data-editor-id]");
    input(title, "2026 Build Application");
    expect(id.value).toBe("task-2026-build-application");

    input(id, "custom-id");
    input(title, "Changed Title");
    expect(id.value).toBe("custom-id");

    input(id, "");
    input(title, "Another Title");
    expect(id.value).toBe("");
    expect(requireButton(panel, "button[data-save-task]").disabled).toBe(true);
  });

  it("prefills Edit without changing the captured ID when the title changes", async () => {
    const panel = await mountLoadedPanel(createContext({ content: initialConfig }));
    requireButton(panel, "button[data-edit-task='build']").click();

    const title = requireInput(panel, "input[data-editor-title]");
    const id = requireInput(panel, "input[data-editor-id]");
    expect(title.value).toBe("Build");
    expect(id.value).toBe("build");
    input(title, "Release Build");
    expect(id.value).toBe("build");
  });

  it("renders and persists a multiline command exactly through the canonical post-write read", async () => {
    let savedContent = JSON.stringify({ version: 1, tasks: [] });
    const writes: string[] = [];
    const readFile = vi.fn<WorkspacePanelContext["files"]["readFile"]>(() => Promise.resolve(fileResponse(savedContent)));
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
      const serialized = typeof value === "string" ? value : new TextDecoder().decode(value);
      writes.push(serialized);
      savedContent = serialized;
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const panel = await mountLoadedPanel(createContext({ readFile, writeFile }));
    requireButton(panel, "button[data-add-task]").click();

    const title = requireInput(panel, "input[data-editor-title]");
    const command = requireTextarea(panel, "textarea[data-editor-command]");
    input(title, "Verify");
    const exactScript = "  set -e\n\nnpm run build\n npm test\n";
    input(command, exactScript);
    expect(command.value).toBe(exactScript);

    requireButton(panel, "button[data-save-task]").click();
    await vi.waitFor(() => { expect(writes).toHaveLength(1); });
    await vi.waitFor(() => { expect(requireShadow(panel).querySelector("[data-task-editor]")).toBeNull(); });

    const persisted = parsePersistedConfig(savedContent);
    expect(persisted.tasks[0]?.command).toBe(exactScript);
    expect(readFile).toHaveBeenCalledTimes(3);
  });

  it("shows visible validation errors with ARIA references and focuses the first invalid control", async () => {
    const panel = await mountLoadedPanel(createContext({ content: initialConfig }));
    requireButton(panel, "button[data-add-task]").click();

    const title = requireInput(panel, "input[data-editor-title]");
    const id = requireInput(panel, "input[data-editor-id]");
    const command = requireTextarea(panel, "textarea[data-editor-command]");
    input(title, "New Task");
    input(id, "test");
    input(command, "printf test");
    const form = requireShadow(panel).querySelector("form[data-task-form]");
    if (!(form instanceof HTMLFormElement)) throw new Error("Task form not found");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const error = requireShadow(panel).querySelector("[data-field-error='id']");
    expect(error?.textContent).toContain("already exists");
    const invalidId = requireInput(panel, "input[data-editor-id]");
    expect(invalidId.getAttribute("aria-invalid")).toBe("true");
    expect(invalidId.getAttribute("aria-describedby")).toBe(error?.id);
    expect(requireShadow(panel).activeElement).toBe(invalidId);

    input(invalidId, "Bad ID");
    expect(requireShadow(panel).textContent).toContain("must match");
    expect(invalidId.getAttribute("aria-invalid")).toBe("true");
  });

  it("replaces Edit at its captured index when ID and group change", async () => {
    let savedContent = initialConfig;
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
      savedContent = typeof value === "string" ? value : new TextDecoder().decode(value);
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const panel = await mountLoadedPanel(createContext({
      readFile: () => Promise.resolve(fileResponse(savedContent)),
      writeFile,
    }));
    requireButton(panel, "button[data-edit-task='build']").click();

    input(requireInput(panel, "input[data-editor-id]"), "release");
    input(requireInput(panel, "input[data-editor-title]"), "Release");
    input(requireInput(panel, "input[data-editor-group]"), "Deployments");
    requireButton(panel, "button[data-save-task]").click();
    await vi.waitFor(() => { expect(requireShadow(panel).querySelector("[data-task-editor]")).toBeNull(); });

    const persisted = parsePersistedConfig(savedContent);
    expect(persisted.tasks.map((task) => task.id)).toEqual(["release", "test"]);
    expect(persisted.tasks[0]?.group).toBe("Deployments");
  });

  it("deletes only the captured task and preserves the remaining array order", async () => {
    let savedContent = JSON.stringify({
      version: 1,
      tasks: [
        { id: "first", title: "First", command: "printf first", confirm: false },
        { id: "middle", title: "Middle", command: "printf middle\nexit 0", confirm: false },
        { id: "last", title: "Last", command: "printf last", confirm: false },
      ],
    });
    const writes: string[] = [];
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
      savedContent = typeof value === "string" ? value : new TextDecoder().decode(value);
      writes.push(savedContent);
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const panel = await mountLoadedPanel(createContext({
      readFile: () => Promise.resolve(fileResponse(savedContent)),
      writeFile,
    }));

    requireButton(panel, "button[data-delete-task='middle']").click();
    expect(requireShadow(panel).querySelector("[data-delete-confirmation]")?.textContent).toContain("printf middle\nexit 0");
    requireButton(panel, "button[data-cancel-delete]").click();
    expect(requireShadow(panel).querySelector("[data-delete-confirmation]")).toBeNull();
    expect(writes).toHaveLength(0);

    requireButton(panel, "button[data-delete-task='middle']").click();
    requireButton(panel, "button[data-confirm-delete]").click();
    await vi.waitFor(() => { expect(writes).toHaveLength(1); });

    const persisted = parsePersistedConfig(savedContent);
    expect(persisted.tasks.map((task) => task.id)).toEqual(["first", "last"]);
  });

  it("runs a confirmed task once with its complete command", async () => {
    const runCommand = vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>((input) => {
      const run: TerminalCommandRun = {
        id: "run-1",
        origin: "plugin",
        projectId: "proj1",
        workspaceId: "ws1",
        terminalId: "terminal-1",
        title: input.title,
        command: input.command,
        status: "queued",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: input.metadata ?? {},
      };
      const handle: TerminalCommandRunHandle = { run, completed: Promise.resolve(run) };
      return Promise.resolve(handle);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const command = "set -e\nprintf one\nprintf two\n";
    const content = JSON.stringify({ version: 1, tasks: [{ id: "verify", title: "Verify", command, confirm: true }] });
    const panel = await mountLoadedPanel(createContext({ content, terminal: { open: vi.fn(), runCommand } }));

    requireButton(panel, "button[data-task-id='verify']").click();
    await vi.waitFor(() => { expect(runCommand).toHaveBeenCalledTimes(1); });
    expect(runCommand.mock.calls[0]?.[0].command).toBe(command);
  });

  it("clears terminal dispatch after an overlapping refresh completion", async () => {
    const refreshRead = deferred<FileContentResponse>();
    const terminalRun = deferred<TerminalCommandRunHandle>();
    let readCount = 0;
    const readFile = vi.fn<WorkspacePanelContext["files"]["readFile"]>(() => {
      readCount += 1;
      return readCount === 1 ? Promise.resolve(fileResponse(initialConfig)) : refreshRead.promise;
    });
    const runCommand = vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>(() => terminalRun.promise);
    const panel = await mountLoadedPanel(createContext({
      readFile,
      terminal: { open: vi.fn(), runCommand },
    }));

    requireButton(panel, "button[data-task-id='build']").click();
    await vi.waitFor(() => { expect(runCommand).toHaveBeenCalledTimes(1); });
    requireButton(panel, "button[data-refresh-config]").click();
    await vi.waitFor(() => { expect(requireButton(panel, "button[data-refresh-config]").disabled).toBe(true); });

    const run: TerminalCommandRun = {
      id: "run-1",
      origin: "plugin",
      projectId: "proj1",
      workspaceId: "ws1",
      terminalId: "terminal-1",
      title: "Build",
      command: "npm run build",
      status: "queued",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: {},
    };
    terminalRun.resolve({ run, completed: Promise.resolve(run) });
    await vi.waitFor(() => {
      expect(requireShadow(panel).textContent).not.toContain("Dispatching...");
    });

    refreshRead.resolve(fileResponse(initialConfig));
    await vi.waitFor(() => { expect(requireShadow(panel).textContent).toContain("Loaded 2 tasks."); });
  });

  it("clears terminal dispatch ownership when the panel disconnects", async () => {
    const terminalRun = deferred<TerminalCommandRunHandle>();
    const runCommand = vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>(() => terminalRun.promise);
    const panel = createPanel();
    panel.context = createContext({
      content: initialConfig,
      terminal: { open: vi.fn(), runCommand },
    });
    document.body.append(panel);
    await vi.waitFor(() => { expect(requireShadow(panel).textContent).toContain("Build"); });

    requireButton(panel, "button[data-task-id='build']").click();
    await vi.waitFor(() => { expect(runCommand).toHaveBeenCalledTimes(1); });
    document.body.removeChild(panel);
    const run: TerminalCommandRun = {
      id: "run-1",
      origin: "plugin",
      projectId: "proj1",
      workspaceId: "ws1",
      terminalId: "terminal-1",
      title: "Build",
      command: "npm run build",
      status: "queued",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: {},
    };
    terminalRun.resolve({ run, completed: Promise.resolve(run) });
    document.body.append(panel);
    await vi.waitFor(() => {
      expect(requireButton(panel, "button[data-task-id='build']").textContent).toBe("Run");
    });
  });

  it("offers Reset only for a complete invalid text file and writes the canonical empty config", async () => {
    let savedContent = "{\n  \"version\": 2\n}";
    const writes: string[] = [];
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
      savedContent = typeof value === "string" ? value : new TextDecoder().decode(value);
      writes.push(savedContent);
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const panel = await mountLoadedPanel(createContext({
      readFile: () => Promise.resolve(fileResponse(savedContent)),
      writeFile,
    }));
    requireButton(panel, "button[data-reset-tasks-file]").click();
    expect(requireShadow(panel).textContent).toContain("replace");
    requireButton(panel, "button[data-cancel-reset]").click();
    expect(writes).toHaveLength(0);

    requireButton(panel, "button[data-reset-tasks-file]").click();
    requireButton(panel, "button[data-confirm-reset]").click();
    await vi.waitFor(() => { expect(writes).toHaveLength(1); });
    expect(savedContent).toBe(serializeWorkspaceTasksConfig({ version: 1, tasks: [] }));
  });

  it("does not offer Reset for binary or truncated content", async () => {
    const binary = await mountLoadedPanel(createContext({
      readFile: () => Promise.resolve(fileResponse("bytes", { binary: true })),
    }));
    expect(requireShadow(binary).querySelector("button[data-reset-tasks-file]")).toBeNull();

    document.body.innerHTML = "";
    clearWorkspaceTasksStateForTesting();
    const truncated = await mountLoadedPanel(createContext({
      readFile: () => Promise.resolve(fileResponse("partial", { truncated: true })),
    }));
    expect(requireShadow(truncated).querySelector("button[data-reset-tasks-file]")).toBeNull();
  });

  it("retains an Add draft after a conflict and blocks mutation until Refresh", async () => {
    let savedContent = JSON.stringify({ version: 1, tasks: [] });
    const writes: string[] = [];
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
      savedContent = typeof value === "string" ? value : new TextDecoder().decode(value);
      writes.push(savedContent);
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const context = createContext({
      readFile: () => Promise.resolve(fileResponse(savedContent)),
      writeFile,
    });
    const hostRender = vi.spyOn(context.host, "requestRender");
    const panel = await mountLoadedPanel(context);
    requireButton(panel, "button[data-add-task]").click();
    input(requireInput(panel, "input[data-editor-title]"), "Build");
    input(requireTextarea(panel, "textarea[data-editor-command]"), "npm run build");

    savedContent = JSON.stringify({ version: 1, tasks: [{ id: "external", title: "External", command: "printf external" }] });
    requireButton(panel, "button[data-save-task]").click();
    await vi.waitFor(() => { expect(requireShadow(panel).textContent).toContain("changed outside this panel"); });
    expect(writes).toHaveLength(0);
    expect(hostRender).toHaveBeenCalled();
    expect(requireShadow(panel).querySelector("[data-task-editor]")).not.toBeNull();

    requireButton(panel, "button[data-cancel-editor]").click();
    expect(requireShadow(panel).querySelector("button[data-add-task]")).toBeNull();
    requireButton(panel, "button[data-refresh-config]").click();
    await vi.waitFor(() => { expect(requireShadow(panel).querySelector("button[data-add-task]")).not.toBeNull(); });
  });

  it("keeps a local edit conflict refresh-gated after cancellation", async () => {
    let savedContent = initialConfig;
    const writes: string[] = [];
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
      savedContent = typeof value === "string" ? value : new TextDecoder().decode(value);
      writes.push(savedContent);
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const context = createContext({
      readFile: () => Promise.resolve(fileResponse(savedContent)),
      writeFile,
    });
    const panelA = await mountLoadedPanel(context);
    const panelB = await mountLoadedPanel(context);

    requireButton(panelA, "button[data-edit-task='build']").click();
    requireButton(panelB, "button[data-edit-task='build']").click();
    input(requireInput(panelB, "input[data-editor-id]"), "release");
    input(requireInput(panelB, "input[data-editor-title]"), "Release");
    requireButton(panelB, "button[data-save-task]").click();
    await vi.waitFor(() => { expect(writes).toHaveLength(1); });

    requireButton(panelA, "button[data-save-task]").click();
    await vi.waitFor(() => { expect(requireShadow(panelA).textContent).toContain("changed outside this panel"); });
    expect(writes).toHaveLength(1);
    requireButton(panelA, "button[data-cancel-editor]").click();
    expect(requireShadow(panelA).querySelector("button[data-add-task]")).toBeNull();
    expect(requireButton(panelA, "button[data-edit-task='release']").disabled).toBe(true);

    requireButton(panelA, "button[data-refresh-config]").click();
    await vi.waitFor(() => { expect(requireShadow(panelA).querySelector("button[data-add-task]")).not.toBeNull(); });
  });

  it("keeps a local delete conflict refresh-gated after cancellation", async () => {
    let savedContent = initialConfig;
    const writes: string[] = [];
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
      savedContent = typeof value === "string" ? value : new TextDecoder().decode(value);
      writes.push(savedContent);
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const context = createContext({
      readFile: () => Promise.resolve(fileResponse(savedContent)),
      writeFile,
    });
    const panelA = await mountLoadedPanel(context);
    const panelB = await mountLoadedPanel(context);

    requireButton(panelA, "button[data-delete-task='build']").click();
    requireButton(panelB, "button[data-edit-task='build']").click();
    input(requireInput(panelB, "input[data-editor-id]"), "release");
    input(requireInput(panelB, "input[data-editor-title]"), "Release");
    requireButton(panelB, "button[data-save-task]").click();
    await vi.waitFor(() => { expect(writes).toHaveLength(1); });

    requireButton(panelA, "button[data-confirm-delete]").click();
    await vi.waitFor(() => { expect(requireShadow(panelA).textContent).toContain("changed outside this panel"); });
    expect(writes).toHaveLength(1);
    requireButton(panelA, "button[data-cancel-delete]").click();
    expect(requireShadow(panelA).querySelector("button[data-add-task]")).toBeNull();

    requireButton(panelA, "button[data-refresh-config]").click();
    await vi.waitFor(() => { expect(requireShadow(panelA).querySelector("button[data-add-task]")).not.toBeNull(); });
  });

  it("distinguishes an unverifiable preflight and never writes", async () => {
    let readCount = 0;
    const writes: string[] = [];
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
      writes.push(typeof value === "string" ? value : new TextDecoder().decode(value));
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const panel = await mountLoadedPanel(createContext({
      readFile: () => {
        readCount += 1;
        return readCount === 1 ? Promise.resolve(fileResponse(JSON.stringify({ version: 1, tasks: [] }))) : Promise.reject(new Error("offline"));
      },
      writeFile,
    }));
    requireButton(panel, "button[data-add-task]").click();
    input(requireInput(panel, "input[data-editor-title]"), "Offline");
    input(requireTextarea(panel, "textarea[data-editor-command]"), "printf offline");
    requireButton(panel, "button[data-save-task]").click();

    await vi.waitFor(() => { expect(requireShadow(panel).textContent).toContain("could not be verified"); });
    expect(writes).toHaveLength(0);
  });

  it("does not claim success after a failed write and requires Refresh", async () => {
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>(() => Promise.reject(new Error("disk full")));
    const panel = await mountLoadedPanel(createContext({ content: JSON.stringify({ version: 1, tasks: [] }), writeFile }));
    requireButton(panel, "button[data-add-task]").click();
    input(requireInput(panel, "input[data-editor-title]"), "Build");
    input(requireTextarea(panel, "textarea[data-editor-command]"), "npm run build");
    requireButton(panel, "button[data-save-task]").click();

    await vi.waitFor(() => { expect(requireShadow(panel).textContent).toContain("Unable to write"); });
    expect(requireShadow(panel).textContent).not.toContain("Saved task");
    expect(requireButton(panel, "button[data-save-task]").disabled).toBe(true);
    requireButton(panel, "button[data-refresh-config]").click();
    await vi.waitFor(() => { expect(requireShadow(panel).querySelector("button[data-add-task]")).not.toBeNull(); });
  });

  it("keeps a retained Edit draft labeled as Edit Task after a failed write", async () => {
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>(() => Promise.reject(new Error("disk full")));
    const panel = await mountLoadedPanel(createContext({ content: initialConfig, writeFile }));
    requireButton(panel, "button[data-edit-task='build']").click();
    input(requireTextarea(panel, "textarea[data-editor-command]"), "npm run build:prod");
    requireButton(panel, "button[data-save-task]").click();

    await vi.waitFor(() => { expect(requireShadow(panel).textContent).toContain("Unable to write"); });
    expect(requireShadow(panel).querySelector("[data-task-editor] h3")?.textContent).toBe("Edit Task");
  });

  it("asks before discarding a dirty editor on Refresh and performs no load until confirmed", async () => {
    const readFile = vi.fn<WorkspacePanelContext["files"]["readFile"]>(() => Promise.resolve(fileResponse(JSON.stringify({ version: 1, tasks: [] }))));
    const panel = await mountLoadedPanel(createContext({ readFile }));
    const readsAfterMount = readFile.mock.calls.length;
    requireButton(panel, "button[data-add-task]").click();
    input(requireInput(panel, "input[data-editor-title]"), "Draft");

    requireButton(panel, "button[data-refresh-config]").click();
    expect(requireShadow(panel).querySelector("[data-refresh-discard-confirmation]")).not.toBeNull();
    expect(requireButton(panel, "button[data-refresh-config]").disabled).toBe(true);
    requireButton(panel, "button[data-refresh-config]").click();
    expect(requireShadow(panel).querySelector("[data-refresh-discard-confirmation]")).not.toBeNull();
    expect(readFile.mock.calls).toHaveLength(readsAfterMount);

    requireButton(panel, "button[data-cancel-refresh-discard]").click();
    expect(requireShadow(panel).querySelector("[data-task-editor]")).not.toBeNull();
    requireButton(panel, "button[data-refresh-config]").click();
    requireButton(panel, "button[data-confirm-refresh-discard]").click();
    await vi.waitFor(() => { expect(readFile.mock.calls.length).toBeGreaterThan(readsAfterMount); });
  });

  it("dispatches only one mutation for double Save and double Delete", async () => {
    let savedContent = JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }] });
    const writeStarted = deferred<true>();
    const writeGate = deferred<true>();
    const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>(async (_path, value) => {
      savedContent = typeof value === "string" ? value : new TextDecoder().decode(value);
      writeStarted.resolve(true);
      await writeGate.promise;
      return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
    });
    const panel = await mountLoadedPanel(createContext({
      readFile: () => Promise.resolve(fileResponse(savedContent)),
      writeFile,
    }));
    requireButton(panel, "button[data-edit-task='build']").click();
    input(requireTextarea(panel, "textarea[data-editor-command]"), "npm run build:prod");
    const save = requireButton(panel, "button[data-save-task]");
    save.click();
    save.click();
    await writeStarted.promise;
    expect(writeFile).toHaveBeenCalledTimes(1);
    writeGate.resolve(true);
    await vi.waitFor(() => { expect(requireShadow(panel).querySelector("[data-task-editor]")).toBeNull(); });

    requireButton(panel, "button[data-delete-task='build']").click();
    const confirm = requireButton(panel, "button[data-confirm-delete]");
    confirm.click();
    confirm.click();
    await vi.waitFor(() => { expect(writeFile).toHaveBeenCalledTimes(2); });
  });

  it("ignores a refresh completion after switching workspaces", async () => {
    const oldRead = deferred<FileContentResponse>();
    const oldContext = createContext({
      workspaceId: "old",
      readFile: () => oldRead.promise,
    });
    const panel = createPanel();
    panel.context = oldContext;
    document.body.append(panel);

    const currentContext = createContext({
      workspaceId: "current",
      content: JSON.stringify({ version: 1, tasks: [{ id: "current", title: "Current", command: "printf current" }] }),
    });
    panel.context = currentContext;
    await vi.waitFor(() => { expect(requireShadow(panel).textContent).toContain("Current"); });
    oldRead.resolve(fileResponse(JSON.stringify({ version: 1, tasks: [{ id: "old", title: "Old", command: "printf old" }] })));
    await vi.waitFor(() => { expect(requireShadow(panel).textContent).toContain("Current"); });
    expect(requireShadow(panel).textContent).not.toContain("Old");
  });

  it("removes subscription effects after disconnect", async () => {
    const pending = deferred<FileContentResponse>();
    const context = createContext({ readFile: () => pending.promise });
    const panel = createPanel();
    panel.context = context;
    document.body.append(panel);
    const beforeDisconnect = requireShadow(panel).innerHTML;
    document.body.removeChild(panel);
    pending.resolve(fileResponse(initialConfig));
    await Promise.resolve();
    await Promise.resolve();
    expect(requireShadow(panel).innerHTML).toBe(beforeDisconnect);
  });

  it("lets a second panel observe refresh-required gating and later recovery", async () => {
    let savedContent = JSON.stringify({ version: 1, tasks: [] });
    const writes: string[] = [];
    const files = createContext({
      readFile: () => Promise.resolve(fileResponse(savedContent)),
      writeFile: vi.fn<WorkspacePanelContext["files"]["writeFile"]>((_path, value) => {
        writes.push(typeof value === "string" ? value : new TextDecoder().decode(value));
        return Promise.resolve(writeResponse(TASKS_CONFIG_PATH));
      }),
    });
    const panelA = await mountLoadedPanel(files);
    const panelB = await mountLoadedPanel(files);
    requireButton(panelA, "button[data-add-task]").click();
    input(requireInput(panelA, "input[data-editor-title]"), "Draft");
    input(requireTextarea(panelA, "textarea[data-editor-command]"), "printf draft");
    savedContent = JSON.stringify({ version: 1, tasks: [{ id: "external", title: "External", command: "printf external" }] });
    requireButton(panelA, "button[data-save-task]").click();
    await vi.waitFor(() => { expect(requireShadow(panelA).textContent).toContain("changed outside this panel"); });
    expect(writes).toHaveLength(0);
    await vi.waitFor(() => { expect(requireShadow(panelB).querySelector("button[data-add-task]")).toBeNull(); });

    requireButton(panelB, "button[data-refresh-config]").click();
    await vi.waitFor(() => { expect(requireShadow(panelB).querySelector("button[data-add-task]")).not.toBeNull(); });
  });

  it("keeps keyboard interaction and responsive script presentation explicit", async () => {
    const panel = await mountLoadedPanel(createContext({ content: initialConfig }));
    requireButton(panel, "button[data-add-task]").click();
    const command = requireTextarea(panel, "textarea[data-editor-command]");
    let parentReceivedEscape = false;
    panel.addEventListener("keydown", () => { parentReceivedEscape = true; });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    command.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(requireShadow(panel).querySelector("[data-task-editor]")).not.toBeNull();

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    command.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(parentReceivedEscape).toBe(false);
    expect(requireShadow(panel).querySelector("[data-task-editor]")).toBeNull();

    const styles = requireShadow(panel).querySelector("style")?.textContent ?? "";
    expect(styles).toContain("container-type: inline-size");
    expect(styles).toContain("@container");
    expect(styles).toContain("white-space: pre-wrap");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toContain("max-height");
    expect(styles).toContain("overflow-y: auto");
    expect(styles).toContain("min-height");
    expect(styles).toContain("resize: vertical");
    expect(styles).toContain(":focus-visible");
    expect(styles).not.toContain("@media");
  });
});

function requireShadow(panel: HTMLElement): ShadowRoot {
  if (panel.shadowRoot === null) throw new Error("Tasks panel has no open shadow root");
  return panel.shadowRoot;
}

function requireButton(panel: HTMLElement, selector: string): HTMLButtonElement {
  const element = requireShadow(panel).querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button for ${selector}`);
  return element;
}

function requireInput(panel: HTMLElement, selector: string): HTMLInputElement {
  const element = requireShadow(panel).querySelector(selector);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Expected input for ${selector}`);
  return element;
}

function requireTextarea(panel: HTMLElement, selector: string): HTMLTextAreaElement {
  const element = requireShadow(panel).querySelector(selector);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Expected textarea for ${selector}`);
  return element;
}

function input(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function createContext(overrides: PartialFixtureOverrides = {}): WorkspacePanelContext {
  let content = overrides.content;
  const readFile = overrides.readFile ?? vi.fn<WorkspacePanelContext["files"]["readFile"]>(() => {
    if (content === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve(fileResponse(content));
  });
  const writeFile = overrides.writeFile ?? vi.fn<WorkspacePanelContext["files"]["writeFile"]>((path, value) => {
    content = typeof value === "string" ? value : new TextDecoder().decode(value);
    return Promise.resolve(writeResponse(path));
  });
  const terminal = overrides.terminal ?? {
    open: vi.fn<WorkspacePanelContext["terminal"]["open"]>(),
    runCommand: vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>((input) => {
      const run: TerminalCommandRun = {
        id: "run-1",
        origin: "plugin",
        projectId: overrides.projectId ?? "proj1",
        workspaceId: overrides.workspaceId ?? "ws1",
        terminalId: "terminal-1",
        title: input.title,
        command: input.command,
        status: "queued",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: input.metadata ?? {},
      };
      const handle: TerminalCommandRunHandle = { run, completed: Promise.resolve(run) };
      return Promise.resolve(handle);
    }),
  };

  return {
    machine: { id: overrides.machineId ?? "local", kind: "local", name: "Local" },
    workspace: {
      id: overrides.workspaceId ?? "ws1",
      projectId: overrides.projectId ?? "proj1",
      path: "/test",
      label: "Test",
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
    },
    files: {
      readFile,
      writeFile,
      deleteFile: vi.fn<WorkspacePanelContext["files"]["deleteFile"]>(() => Promise.resolve({ path: TASKS_CONFIG_PATH, existed: true })),
      moveFile: vi.fn<WorkspacePanelContext["files"]["moveFile"]>(() => Promise.resolve({ fromPath: "", toPath: "", size: 0, modifiedAt: "" })),
    },
    prompt: {
      insertText: vi.fn(),
      getText: vi.fn(() => ""),
      getSelection: vi.fn(() => null),
    },
    terminal,
    host: { requestRender: vi.fn() },
  };
}

async function mountLoadedPanel(context: WorkspacePanelContext): Promise<TasksPanelElement> {
  const panel = createPanel();
  panel.context = context;
  document.body.append(panel);
  await vi.waitFor(() => { expect(requireShadow(panel).textContent).not.toContain("Loading"); }, { timeout: 1000 });
  return panel;
}

interface PersistedTask {
  id: string;
  command?: string;
  group?: string;
}

interface PersistedConfig {
  tasks: PersistedTask[];
}

function parsePersistedConfig(content: string): PersistedConfig {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !Array.isArray(parsed["tasks"])) throw new Error("Persisted config is missing tasks");
  const tasks: PersistedTask[] = [];
  for (const task of parsed["tasks"]) {
    if (!isRecord(task) || typeof task["id"] !== "string") throw new Error("Persisted task is invalid");
    tasks.push({
      id: task["id"],
      ...(typeof task["command"] === "string" ? { command: task["command"] } : {}),
      ...(typeof task["group"] === "string" ? { group: task["group"] } : {}),
    });
  }
  return { tasks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTasksPanelElement(element: HTMLElement): element is TasksPanelElement {
  return "context" in element;
}

function createPanel(): TasksPanelElement {
  const panel = document.createElement(tasksPanelTagName);
  if (!isTasksPanelElement(panel)) throw new Error("Tasks panel does not expose a context property");
  return panel;
}
function fileResponse(content: string, options: { binary?: boolean; truncated?: boolean } = {}): FileContentResponse {
  return {
    path: TASKS_CONFIG_PATH,
    encoding: "utf8",
    size: content.length,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    content,
    truncated: options.truncated ?? false,
    binary: options.binary ?? false,
  };
}

function writeResponse(path: string): WriteWorkspaceFileResponse {
  return { path, size: 100, modifiedAt: "2026-01-01T00:00:00.000Z", created: false };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
