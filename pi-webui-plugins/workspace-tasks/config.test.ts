import { describe, expect, it } from "vitest";
import {
  appendWorkspaceTask,
  emptyWorkspaceTasksConfig,
  parseTasksConfigText,
  removeWorkspaceTaskAt,
  replaceWorkspaceTaskAt,
  serializeWorkspaceTasksConfig,
  suggestWorkspaceTaskId,
  validateAndNormalizeDraft,
  type WorkspaceTask,
  type WorkspaceTaskDraft,
} from "./config";

describe("workspace tasks config", () => {
  it("parses a minimal version 1 config", () => {
    expect(parseTasksConfigText(JSON.stringify({
      version: 1,
      tasks: [
        { id: "db.reset", title: "Reset DB", command: "go -C klingit-go run ./cli db reset" },
      ],
    }))).toEqual({
      ok: true,
      config: {
        version: 1,
        tasks: [
          { id: "db.reset", title: "Reset DB", command: "go -C klingit-go run ./cli db reset", confirm: false },
        ],
      },
    });
  });

  it("parses optional group, description, and confirm fields", () => {
    expect(parseTasksConfigText(JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "docker.start",
          title: "Start Docker",
          description: "Start the dev stack.",
          group: "Docker",
          command: "./docker/pi-webui-docker --dev start",
          confirm: true,
        },
      ],
    }))).toEqual({
      ok: true,
      config: {
        version: 1,
        tasks: [
          {
            id: "docker.start",
            title: "Start Docker",
            description: "Start the dev stack.",
            group: "Docker",
            command: "./docker/pi-webui-docker --dev start",
            confirm: true,
          },
        ],
      },
    });
  });

  it("accepts an empty tasks array", () => {
    expect(parseTasksConfigText(JSON.stringify({ version: 1, tasks: [] }))).toEqual({
      ok: true,
      config: { version: 1, tasks: [] },
    });
  });

  it("rejects invalid JSON and unsupported versions", () => {
    expect(parseTasksConfigText("{")).toMatchObject({ ok: false });
    expect(parseTasksConfigText(JSON.stringify({ version: 2, tasks: [] }))).toEqual({
      ok: false,
      error: "Config version must be 1",
    });
  });

  it("rejects missing, empty, or duplicate required fields", () => {
    expect(parseTasksConfigText(JSON.stringify({ version: 1 }))).toEqual({
      ok: false,
      error: "Config tasks must be an array",
    });
    expect(parseTasksConfigText(JSON.stringify({ version: 1, tasks: [{ id: "", title: "T", command: "cmd" }] }))).toEqual({
      ok: false,
      error: "Task 1 id must be a non-empty string",
    });
    expect(parseTasksConfigText(JSON.stringify({
      version: 1,
      tasks: [
        { id: "one", title: "One", command: "cmd" },
        { id: "one", title: "Again", command: "cmd" },
      ],
    }))).toEqual({
      ok: false,
      error: "Duplicate task id: one",
    });
  });

  it("rejects invalid optional field types", () => {
    expect(parseTasksConfigText(JSON.stringify({ version: 1, tasks: [{ id: "one", title: "One", command: "cmd", confirm: "yes" }] }))).toEqual({
      ok: false,
      error: "Task 1 confirm must be a boolean",
    });
    expect(parseTasksConfigText(JSON.stringify({ version: 1, tasks: [{ id: "one", title: "One", command: "cmd", group: "" }] }))).toEqual({
      ok: false,
      error: "Task 1 group must be a non-empty string when provided",
    });
  });
});

const firstTask: WorkspaceTask = { id: "first", title: "First", command: "printf first", confirm: false };

const baseTasks: WorkspaceTask[] = [
  firstTask,
  { id: "second", title: "Second", command: "printf second", confirm: true },
];

const draft = (overrides: Partial<WorkspaceTaskDraft> = {}): WorkspaceTaskDraft => ({
  id: "verify",
  title: "Verify",
  command: "  set -e\nnpm test\n",
  description: " details ",
  group: " Quality ",
  confirm: false,
  ...overrides,
});

describe("workspace task editor domain", () => {
  it.each([
    ["Build app", "build-app"],
    ["  $$$  ", "task"],
    ["2026 checks", "task-2026-checks"],
    ["Release...Candidate", "release-candidate"],
  ])("suggests a valid id for %s", (title, expected) => {
    expect(suggestWorkspaceTaskId(title)).toBe(expected);
  });

  it("normalizes ordinary fields while preserving the command string exactly", () => {
    expect(validateAndNormalizeDraft(draft(), baseTasks)).toEqual({
      ok: true,
      task: {
        id: "verify",
        title: "Verify",
        command: "  set -e\nnpm test\n",
        description: "details",
        group: "Quality",
        confirm: false,
      },
    });
  });

  it("omits blank optional fields and preserves confirmation", () => {
    expect(validateAndNormalizeDraft(draft({ description: " ", group: "\n", confirm: true }), baseTasks)).toEqual({
      ok: true,
      task: {
        id: "verify",
        title: "Verify",
        command: "  set -e\nnpm test\n",
        confirm: true,
      },
    });
  });

  it("reports required, pattern, and duplicate errors and excludes the edited index", () => {
    expect(validateAndNormalizeDraft(draft({ id: "", title: "", command: " \n " }), baseTasks)).toEqual({
      ok: false,
      errors: {
        id: "ID is required.",
        title: "Title is required.",
        command: "Command script is required.",
      },
    });
    expect(validateAndNormalizeDraft(draft({ id: "Bad ID" }), baseTasks)).toMatchObject({
      ok: false,
      errors: { id: "ID must match ^[a-z][a-z0-9.-]*$." },
    });
    expect(validateAndNormalizeDraft(draft({ id: "second" }), baseTasks)).toMatchObject({
      ok: false,
      errors: { id: "Task ID \"second\" already exists." },
    });
    expect(validateAndNormalizeDraft(draft({ id: "second" }), baseTasks, 1)).toMatchObject({ ok: true });
  });

  it("appends, replaces, and removes without reordering untouched tasks", () => {
    const config = { version: 1 as const, tasks: baseTasks };
    const added = { id: "third", title: "Third", command: "printf third", confirm: false };

    const appended = appendWorkspaceTask(config, added);
    const replaced = replaceWorkspaceTaskAt(config, 0, added);
    const removed = removeWorkspaceTaskAt(config, 0);

    expect(appended).not.toBe(config);
    expect(appended.tasks).not.toBe(config.tasks);
    expect(appended.tasks.map((task) => task.id)).toEqual(["first", "second", "third"]);
    expect(replaced.tasks.map((task) => task.id)).toEqual(["third", "second"]);
    expect(removed.tasks.map((task) => task.id)).toEqual(["second"]);
    expect(config.tasks.map((task) => task.id)).toEqual(["first", "second"]);
  });

  it.each([
    ["replace", () => replaceWorkspaceTaskAt({ version: 1, tasks: baseTasks }, -1, firstTask)],
    ["remove", () => removeWorkspaceTaskAt({ version: 1, tasks: baseTasks }, baseTasks.length)],
  ])("rejects an invalid captured index when attempting to %s", (_operation, transform) => {
    expect(transform).toThrow(RangeError);
    expect(transform).toThrow(/Task index/);
  });

  it("serializes canonical version 1 JSON with stable key order and a final newline", () => {
    const serialized = serializeWorkspaceTasksConfig({
      version: 1,
      tasks: [{ id: "verify", title: "Verify", command: "set -e\nnpm test", group: "Quality", confirm: false }],
    });

    expect(serialized).toBe('{\n  "version": 1,\n  "tasks": [\n    {\n      "id": "verify",\n      "title": "Verify",\n      "command": "set -e\\nnpm test",\n      "group": "Quality",\n      "confirm": false\n    }\n  ]\n}\n');
    expect(serializeWorkspaceTasksConfig(emptyWorkspaceTasksConfig)).toBe('{\n  "version": 1,\n  "tasks": []\n}\n');
  });

  it.each([
    [
      "single-line",
      '{"version":1,"tasks":[{"id":"check","title":"Check","command":"npm test","confirm":true}]}',
    ],
    [
      "multiline",
      `{
  "version": 1,
  "tasks": [
    {
      "id": "verify",
      "title": "Verify",
      "command": "set -e\\nnpm test",
      "description": "Run the test suite.",
      "group": "Quality"
    }
  ]
}`,
    ],
  ])("round-trips the semantics of a %s config", (_format, text) => {
    const parsed = parseTasksConfigText(text);
    if (!parsed.ok) throw new Error(parsed.error);

    expect(parseTasksConfigText(serializeWorkspaceTasksConfig(parsed.config))).toEqual(parsed);
  });
});
