/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import { TASKS_CONFIG_PATH } from "./config.js";
import { clearConfigCacheForTesting, defineTasksPanelElement, tasksPanelTagName } from "./tasksPanelElement.js";

describe("workspace tasks editor", () => {
  beforeEach(() => {
    defineTasksPanelElement();
    clearConfigCacheForTesting();
    document.body.innerHTML = "";
  });

  it("renders an Add Task button when tasks are loaded", async () => {
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build" }] }),
        truncated: false,
        binary: false,
      }),
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const addButton = panel.shadowRoot?.querySelector("button[data-add-task]");
    expect(addButton).toBeTruthy();
    expect(addButton?.textContent).toContain("Add");

    document.body.removeChild(panel);
  });

  it("switches to editor mode when Add Task is clicked", async () => {
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: JSON.stringify({ version: 1, tasks: [] }),
        truncated: false,
        binary: false,
      }),
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const addButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-add-task]");
    addButton?.click();
    await vi.waitFor(() => {
      const editor = panel.shadowRoot?.querySelector(".task-editor");
      expect(editor).toBeTruthy();
    });

    document.body.removeChild(panel);
  });

  it("shows task form fields in editor mode", async () => {
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: JSON.stringify({ version: 1, tasks: [] }),
        truncated: false,
        binary: false,
      }),
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const addButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-add-task]");
    addButton?.click();
    await vi.waitFor(() => {
      const titleInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='title']");
      const commandInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='command']");
      expect(titleInput).toBeTruthy();
      expect(commandInput).toBeTruthy();
    });

    document.body.removeChild(panel);
  });

  it("auto-suggests task ID from title", async () => {
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: JSON.stringify({ version: 1, tasks: [] }),
        truncated: false,
        binary: false,
      }),
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const addButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-add-task]");
    addButton?.click();
    await vi.waitFor(() => {
      const titleInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='title']");
      expect(titleInput).toBeTruthy();
    });

    const titleInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='title']")!;
    titleInput.value = "Build Application";
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => {
      const idInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='id']");
      expect(idInput?.value).toBe("build-application");
    });

    document.body.removeChild(panel);
  });

  it("saves a new task to tasks.json", async () => {
    let savedContent = JSON.stringify({ version: 1, tasks: [] });
    const writeFile = vi.fn((path: string, content: string | Uint8Array) => {
      savedContent = content as string;
      return Promise.resolve({ path: TASKS_CONFIG_PATH, size: 100, modifiedAt: new Date().toISOString(), created: true });
    });
    const readFile = vi.fn(() => {
      return Promise.resolve({
        content: savedContent,
        truncated: false,
        binary: false,
      });
    });
    const context = mockContext({
      readFile,
      writeFile,
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const addButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-add-task]");
    addButton?.click();
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.querySelector("input[name='title']")).toBeTruthy();
    });

    const titleInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='title']");
    const commandInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='command']");
    if (!titleInput || !commandInput) throw new Error("Inputs not found");
    titleInput.value = "Build";
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    commandInput.value = "npm run build";
    commandInput.dispatchEvent(new Event("input", { bubbles: true }));

    const saveButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-save-task]");
    saveButton?.click();

    await vi.waitFor(() => {
      expect(writeFile).toHaveBeenCalledTimes(1);
    });

    const savedConfig = JSON.parse(writeFile.mock.calls[0]![1] as string);
    expect(savedConfig).toEqual({
      version: 1,
      tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
    });

    document.body.removeChild(panel);
  });

  it("cancels editor and returns to task list", async () => {
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: JSON.stringify({ version: 1, tasks: [{ id: "test", title: "Test", command: "npm test" }] }),
        truncated: false,
        binary: false,
      }),
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const addButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-add-task]");
    addButton?.click();
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.querySelector(".task-editor")).toBeTruthy();
    });

    const cancelButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-cancel-editor]");
    cancelButton?.click();

    await vi.waitFor(() => {
      const taskCard = panel.shadowRoot?.querySelector(".task-card");
      expect(taskCard).toBeTruthy();
      expect(panel.shadowRoot?.querySelector(".task-editor")).toBeFalsy();
    });

    document.body.removeChild(panel);
  });

  it("opens edit mode for an existing task", async () => {
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build", description: "Build the app", confirm: true }] }),
        truncated: false,
        binary: false,
      }),
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const editButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-edit-task='build']");
    editButton?.click();

    await vi.waitFor(() => {
      const titleInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='title']");
      expect(titleInput?.value).toBe("Build");
    });

    const commandInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='command']");
    const descriptionInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='description']");
    const confirmInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='confirm']");

    expect(commandInput?.value).toBe("npm run build");
    expect(descriptionInput?.value).toBe("Build the app");
    expect(confirmInput?.checked).toBe(true);

    document.body.removeChild(panel);
  });

  it("updates an existing task", async () => {
    let savedContent = JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build" }] });
    const writeFile = vi.fn((path: string, content: string | Uint8Array) => {
      savedContent = content as string;
      return Promise.resolve({ path: TASKS_CONFIG_PATH, size: 100, modifiedAt: new Date().toISOString(), created: false });
    });
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: savedContent,
        truncated: false,
        binary: false,
      }),
      writeFile,
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const editButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-edit-task='build']");
    editButton?.click();
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.querySelector("input[name='title']")).toBeTruthy();
    });

    const commandInput = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name='command']");
    if (!commandInput) throw new Error("Command input not found");
    commandInput.value = "npm run build:prod";
    commandInput.dispatchEvent(new Event("input", { bubbles: true }));

    const saveButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-save-task]");
    saveButton?.click();

    await vi.waitFor(() => {
      expect(writeFile).toHaveBeenCalledTimes(1);
    });

    const savedConfig = JSON.parse(writeFile.mock.calls[0]![1] as string);
    expect(savedConfig.tasks[0].command).toBe("npm run build:prod");

    document.body.removeChild(panel);
  });

  it("validates required fields", async () => {
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: JSON.stringify({ version: 1, tasks: [] }),
        truncated: false,
        binary: false,
      }),
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const addButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-add-task]");
    addButton?.click();
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.querySelector("input[name='title']")).toBeTruthy();
    });

    const saveButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-save-task]");
    expect(saveButton?.disabled).toBe(true);

    document.body.removeChild(panel);
  });

  it("deletes a task with confirmation", async () => {
    let savedContent = JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build" }, { id: "test", title: "Test", command: "npm test" }] });
    const writeFile = vi.fn((path: string, content: string | Uint8Array) => {
      savedContent = content as string;
      return Promise.resolve({ path: TASKS_CONFIG_PATH, size: 100, modifiedAt: new Date().toISOString(), created: false });
    });
    const context = mockContext({
      readFile: () => Promise.resolve({
        content: savedContent,
        truncated: false,
        binary: false,
      }),
      writeFile,
    });

    const panel = document.createElement(tasksPanelTagName) as HTMLElement & { context: WorkspacePanelContext };
    panel.context = context;
    document.body.appendChild(panel);
    await waitForConfigLoad(panel);

    const deleteButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-delete-task='build']");
    deleteButton?.click();

    await vi.waitFor(() => {
      const confirmDialog = panel.shadowRoot?.querySelector(".delete-confirm");
      expect(confirmDialog).toBeTruthy();
    });

    const confirmButton = panel.shadowRoot?.querySelector<HTMLButtonElement>("button[data-confirm-delete]");
    if (!confirmButton) throw new Error("Confirm button not found");
    confirmButton.click();

    await vi.waitFor(() => {
      expect(writeFile).toHaveBeenCalledTimes(1);
    });

    const savedConfig = JSON.parse(writeFile.mock.calls[0]![1] as string);
    expect(savedConfig.tasks).toHaveLength(1);
    expect(savedConfig.tasks[0].id).toBe("test");

    document.body.removeChild(panel);
  });
});

function mockContext(overrides: {
  readFile?: () => Promise<{ content: string; truncated: boolean; binary: boolean }>;
  writeFile?: (path: string, content: string | Uint8Array) => Promise<{ path: string; size: number; modifiedAt: string; created: boolean }>;
} = {}): WorkspacePanelContext {
  return {
    machine: { id: "local", kind: "local", name: "Local", baseUrl: "", hasAuth: false, status: "online" },
    workspace: { id: "ws1", projectId: "proj1", path: "/test", label: "Test", isMain: true, isGitRepo: false, isGitWorktree: false },
    files: {
      readFile: overrides.readFile ?? (() => Promise.reject(new Error("Path does not exist"))),
      writeFile: overrides.writeFile ?? vi.fn(() => Promise.resolve({ path: TASKS_CONFIG_PATH, size: 100, modifiedAt: new Date().toISOString(), created: true })),
      deleteFile: vi.fn(() => Promise.resolve({ path: TASKS_CONFIG_PATH, existed: true })),
      moveFile: vi.fn(() => Promise.resolve({ fromPath: "", toPath: "", size: 0, modifiedAt: "" })),
    },
    prompt: { insert: vi.fn(), appendFile: vi.fn() },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
  } as unknown as WorkspacePanelContext;
}

async function waitForConfigLoad(panel: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    const loading = panel.shadowRoot?.textContent?.includes("Loading");
    expect(loading).toBe(false);
  }, { timeout: 1000 });
}
