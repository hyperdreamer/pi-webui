import { describe, expect, it, vi } from "vitest";
import { TASKS_CONFIG_PATH } from "./config";
import { loadWorkspaceTasksConfig, type WorkspaceTasksFileReader } from "./workspaceTasksClient";

describe("workspace tasks client", () => {
  it("loads the configured path through the public workspace file helper", async () => {
    const readFile = vi.fn<WorkspaceTasksFileReader["readFile"]>(() => Promise.resolve({ content: JSON.stringify({ version: 1, tasks: [] }), truncated: false, binary: false }));

    await loadWorkspaceTasksConfig({ readFile });

    expect(readFile).toHaveBeenCalledWith(TASKS_CONFIG_PATH);
  });

  it("loads and parses a valid tasks config through the public workspace file helper", async () => {
    const files = reader({
      content: JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build" }] }),
      truncated: false,
      binary: false,
    });

    await expect(loadWorkspaceTasksConfig(files)).resolves.toEqual({
      kind: "loaded",
      path: TASKS_CONFIG_PATH,
      config: {
        version: 1,
        tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
      },
    });
  });

  it("treats a missing optional tasks config as unconfigured", async () => {
    const files: WorkspaceTasksFileReader = { readFile: () => Promise.reject(new Error("Path does not exist")) };

    await expect(loadWorkspaceTasksConfig(files)).resolves.toEqual({
      kind: "missing",
      message: "No workspace tasks configured here.",
      hint: `${TASKS_CONFIG_PATH} is optional. Create it in this workspace if you want custom tasks.`,
    });
  });

  it("returns a visible unavailable state instead of throwing on read failures", async () => {
    const files: WorkspaceTasksFileReader = { readFile: () => Promise.reject(new Error("nope")) };

    await expect(loadWorkspaceTasksConfig(files)).resolves.toMatchObject({
      kind: "unavailable",
      message: "Could not load workspace tasks.",
      hint: `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`,
      detail: `Unable to read ${TASKS_CONFIG_PATH}: nope`,
    });
  });

  it("returns parser details for invalid config files", async () => {
    const files = reader({
      content: JSON.stringify({ version: 2, tasks: [] }),
      truncated: false,
      binary: false,
    });

    await expect(loadWorkspaceTasksConfig(files)).resolves.toMatchObject({
      kind: "unavailable",
      detail: "Config version must be 1",
    });
  });
});

function reader(file: Awaited<ReturnType<WorkspaceTasksFileReader["readFile"]>>): WorkspaceTasksFileReader {
  return { readFile: () => Promise.resolve(file) };
}
