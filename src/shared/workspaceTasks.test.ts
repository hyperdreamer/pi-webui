import { describe, expect, it } from "vitest";
import {
  TASKS_CONFIG_PATH,
  WORKSPACE_TASKS_CATALOG_MAX_BYTES,
  WORKSPACE_TASKS_CONFIG_VERSION,
  appendWorkspaceTask,
  assertWorkspaceTasksCatalogSize,
  deriveWorkspaceTaskMove,
  isWorkspaceTaskId,
  parseWorkspaceTaskRefKey,
  parseWorkspaceTasksConfig,
  parseWorkspaceTasksConfigText,
  removeWorkspaceTaskAt,
  replaceWorkspaceTaskAt,
  serializeWorkspaceTasksConfig,
  workspaceTaskGroupKey,
  workspaceTaskRefKey,
  workspaceTasksCanonicalByteLength,
  type WorkspaceTask,
  type WorkspaceTasksConfig,
} from "./workspaceTasks";

const buildTask: WorkspaceTask = {
  id: "build",
  title: "Build",
  command: "npm run build",
  confirm: false,
};

const testTask: WorkspaceTask = {
  id: "test",
  title: "Test",
  command: "npm test",
  confirm: true,
};

const baseConfig: WorkspaceTasksConfig = {
  version: WORKSPACE_TASKS_CONFIG_VERSION,
  tasks: [buildTask, testTask],
};

describe("workspace task catalog parsing", () => {
  it("accepts unknown catalog and task keys but omits them from the semantic projection", () => {
    expect(parseWorkspaceTasksConfig({
      version: 1,
      generatedAt: "2026-08-16T00:00:00Z",
      tasks: [{
        id: "build",
        title: "Build",
        command: "npm run build",
        confirm: false,
        metadata: { owner: "platform" },
      }],
    })).toEqual({
      ok: true,
      config: {
        version: 1,
        tasks: [buildTask],
      },
    });
  });

  it("defaults omitted confirmation to false", () => {
    expect(parseWorkspaceTasksConfigText(JSON.stringify({
      version: 1,
      tasks: [{ id: "build", title: "Build", command: "npm run build" }],
    }))).toEqual({
      ok: true,
      config: { version: 1, tasks: [buildTask] },
    });
  });

  it.each([
    [
      "duplicate IDs",
      { version: 1, tasks: [buildTask, { ...buildTask, title: "Again" }] },
      "Duplicate task id: build",
    ],
    [
      "blank required fields",
      { version: 1, tasks: [{ id: " ", title: "Title", command: "npm test" }] },
      "Task 1 id must be a non-empty string",
    ],
    [
      "invalid IDs",
      { version: 1, tasks: [{ id: "Build Task", title: "Build", command: "npm run build" }] },
      "Task 1 id must match ^[a-z][a-z0-9.-]*$",
    ],
    [
      "non-boolean confirmation",
      { version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: "yes" }] },
      "Task 1 confirm must be a boolean",
    ],
  ])("rejects %s", (_caseName, value, error) => {
    expect(parseWorkspaceTasksConfig(value)).toEqual({ ok: false, error });
  });

  it("preserves the existing optional field validation", () => {
    expect(parseWorkspaceTasksConfig({
      version: 1,
      tasks: [{ id: "build", title: "Build", command: "npm run build", description: " " }],
    })).toEqual({
      ok: false,
      error: "Task 1 description must be a non-empty string when provided",
    });
    expect(parseWorkspaceTasksConfig({
      version: 1,
      tasks: [{ id: "build", title: "Build", command: "npm run build", group: 7 }],
    })).toEqual({
      ok: false,
      error: "Task 1 group must be a non-empty string when provided",
    });
  });

  it("reports invalid JSON and unsupported versions", () => {
    const invalidJson = parseWorkspaceTasksConfigText("{");
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) expect(invalidJson.error).toMatch(/^Invalid JSON:/);
    expect(parseWorkspaceTasksConfigText(JSON.stringify({ version: 2, tasks: [] }))).toEqual({
      ok: false,
      error: "Config version must be 1",
    });
  });

  it("preserves multiline command content through parsing and canonical serialization", () => {
    const command = "#!/bin/sh\r\nprintf 'build α'\n";
    const parsed = parseWorkspaceTasksConfigText(`{
  "version": 1,
  "tasks": [
    {
      "id": "build",
      "title": "Build",
      "command": "#!/bin/sh\\r\\nprintf 'build α'\\n",
      "confirm": false
    }
  ]
}`);
    if (!parsed.ok) throw new Error(parsed.error);

    const serialized = serializeWorkspaceTasksConfig(parsed.config);
    const roundTripped = parseWorkspaceTasksConfigText(serialized);
    if (!roundTripped.ok) throw new Error(roundTripped.error);
    expect(parsed.config.tasks[0]?.command).toBe(command);
    expect(roundTripped.config.tasks[0]?.command).toBe(command);
    expect(roundTripped).toEqual(parsed);
  });

  it("serializes version then tasks and task fields in canonical order", () => {
    const config: WorkspaceTasksConfig = {
      version: 1,
      tasks: [{
        id: "build",
        title: "Build",
        command: "set -e\nnpm run build",
        description: "Build the application.",
        group: "Quality",
        confirm: true,
      }],
    };

    expect(serializeWorkspaceTasksConfig(config)).toBe(`{\n  "version": 1,\n  "tasks": [\n    {\n      "id": "build",\n      "title": "Build",\n      "command": "set -e\\nnpm run build",\n      "description": "Build the application.",\n      "group": "Quality",\n      "confirm": true\n    }\n  ]\n}\n`);
  });
});

describe("workspace task references", () => {
  it("round-trips global and workspace references separately", () => {
    const globalKey = workspaceTaskRefKey({ scope: "global", id: "build" });
    const workspaceKey = workspaceTaskRefKey({ scope: "workspace", id: "build" });

    expect(globalKey).toBe("global:build");
    expect(workspaceKey).toBe("workspace:build");
    expect(globalKey).not.toBe(workspaceKey);
    expect(parseWorkspaceTaskRefKey(globalKey)).toEqual({ scope: "global", id: "build" });
    expect(parseWorkspaceTaskRefKey(workspaceKey)).toEqual({ scope: "workspace", id: "build" });
  });

  it.each(["", "global", "global:", "global:build:extra", "project:build", ":build"])(
    "rejects malformed reference key %j",
    (key) => {
      expect(() => parseWorkspaceTaskRefKey(key)).toThrow();
    },
  );

  it("rejects IDs containing the reference separator", () => {
    expect(isWorkspaceTaskId("build:watch")).toBe(false);
    expect(() => workspaceTaskRefKey({ scope: "global", id: "build:watch" })).toThrow();
    expect(() => parseWorkspaceTaskRefKey("global:build:watch")).toThrow();
  });

  it("keeps identical group labels distinct by scope and reversible", () => {
    const globalKey = workspaceTaskGroupKey("global", "Build: release");
    const workspaceKey = workspaceTaskGroupKey("workspace", "Build: release");

    expect(globalKey).not.toBe(workspaceKey);
    expect(JSON.parse(globalKey)).toEqual(["global", "Build: release"]);
    expect(JSON.parse(workspaceKey)).toEqual(["workspace", "Build: release"]);
  });
});

describe("workspace task catalog editors", () => {
  it("appends, replaces, and removes without reordering untouched tasks", () => {
    const added = { id: "lint", title: "Lint", command: "npm run lint", confirm: false };
    const appended = appendWorkspaceTask(baseConfig, added);
    const replaced = replaceWorkspaceTaskAt(baseConfig, 0, added);
    const removed = removeWorkspaceTaskAt(baseConfig, 0);

    expect(appended.tasks.map((task) => task.id)).toEqual(["build", "test", "lint"]);
    expect(replaced.tasks.map((task) => task.id)).toEqual(["lint", "test"]);
    expect(removed.tasks.map((task) => task.id)).toEqual(["test"]);
    expect(baseConfig.tasks.map((task) => task.id)).toEqual(["build", "test"]);
  });

  it.each([
    ["replace", () => replaceWorkspaceTaskAt(baseConfig, -1, buildTask)],
    ["remove", () => removeWorkspaceTaskAt(baseConfig, baseConfig.tasks.length)],
  ])("throws RangeError for a bad captured index when attempting to %s", (_operation, transform) => {
    expect(transform).toThrow(RangeError);
  });
});

describe("workspace task moves", () => {
  it.each([
    ["global", "workspace"],
    ["workspace", "global"],
  ] as const)("promotes or demotes by appending the editable destination task and removing the source", (sourceScope, destinationScope) => {
    const destinationTask: WorkspaceTask = {
      id: "build-local",
      title: "Build locally",
      command: "npm run build -- --local",
      confirm: true,
    };
    const result = deriveWorkspaceTaskMove({
      source: {
        ref: { scope: sourceScope, id: "build" },
        config: baseConfig,
      },
      destination: {
        scope: destinationScope,
        config: { version: 1, tasks: [testTask] },
        task: destinationTask,
      },
    });

    expect(result.sourceAfter.tasks.map((task) => task.id)).toEqual(["test"]);
    expect(result.destinationAfter.tasks.map((task) => task.id)).toEqual(["test", "build-local"]);
    expect(result.destinationAfter.tasks.at(-1)).toEqual(destinationTask);
    expect(baseConfig.tasks.map((task) => task.id)).toEqual(["build", "test"]);
  });

  it("rejects invalid move requests", () => {
    const emptyConfig: WorkspaceTasksConfig = { version: 1, tasks: [] };
    const cases: [string, Parameters<typeof deriveWorkspaceTaskMove>[0]][] = [
      ["same-scope move", {
        source: { ref: { scope: "global", id: "build" }, config: baseConfig },
        destination: { scope: "global", config: emptyConfig, task: buildTask },
      }],
      ["absent source task", {
        source: { ref: { scope: "global", id: "missing" }, config: baseConfig },
        destination: { scope: "workspace", config: emptyConfig, task: buildTask },
      }],
      ["destination collision", {
        source: { ref: { scope: "global", id: "build" }, config: baseConfig },
        destination: { scope: "workspace", config: { version: 1, tasks: [testTask] }, task: testTask },
      }],
    ];

    for (const [caseName, input] of cases) {
      expect(() => deriveWorkspaceTaskMove(input), caseName).toThrow();
    }
  });

  it("rejects a derived destination catalog over 512 KiB", () => {
    const oversizedTask: WorkspaceTask = {
      id: "oversized",
      title: "Oversized",
      command: "x".repeat(WORKSPACE_TASKS_CATALOG_MAX_BYTES),
      confirm: false,
    };
    const destination: WorkspaceTasksConfig = { version: 1, tasks: [] };

    expect(workspaceTasksCanonicalByteLength({ version: 1, tasks: [oversizedTask] })).toBeGreaterThan(WORKSPACE_TASKS_CATALOG_MAX_BYTES);
    expect(() => deriveWorkspaceTaskMove({
      source: { ref: { scope: "global", id: "build" }, config: baseConfig },
      destination: { scope: "workspace", config: destination, task: oversizedTask },
    })).toThrow(RangeError);
  });
});

describe("workspace task catalog size", () => {
  it("accepts canonical UTF-8 JSON at exactly 512 KiB and rejects one byte beyond it", () => {
    const emptyCommandConfig: WorkspaceTasksConfig = {
      version: 1,
      tasks: [{ id: "a", title: "A", command: "", confirm: false }],
    };
    const fixedBytes = workspaceTasksCanonicalByteLength(emptyCommandConfig);
    const exact: WorkspaceTasksConfig = {
      version: 1,
      tasks: [{ id: "a", title: "A", command: "x".repeat(WORKSPACE_TASKS_CATALOG_MAX_BYTES - fixedBytes), confirm: false }],
    };
    const beyond: WorkspaceTasksConfig = {
      version: 1,
      tasks: [{ id: "a", title: "A", command: "x".repeat(WORKSPACE_TASKS_CATALOG_MAX_BYTES - fixedBytes + 1), confirm: false }],
    };

    expect(() => {
      assertWorkspaceTasksCatalogSize(exact);
    }).not.toThrow();
    expect(workspaceTasksCanonicalByteLength(beyond)).toBe(WORKSPACE_TASKS_CATALOG_MAX_BYTES + 1);
    expect(() => {
      assertWorkspaceTasksCatalogSize(beyond);
    }).toThrow(RangeError);
  });

  it("counts UTF-8 bytes rather than JavaScript string length", () => {
    const config: WorkspaceTasksConfig = {
      version: 1,
      tasks: [{ id: "build", title: "Build", command: "echo α", confirm: false }],
    };

    expect(workspaceTasksCanonicalByteLength(config)).toBe(
      new TextEncoder().encode(serializeWorkspaceTasksConfig(config)).byteLength,
    );
  });
});

it("exports the workspace task config path", () => {
  expect(TASKS_CONFIG_PATH).toBe(".pi-webui/tasks.json");
});
