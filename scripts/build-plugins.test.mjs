import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("plugin build", () => {
  it("resolves the workspace task domain alias from a fixture extending the root TypeScript config", async () => {
    const fixture = await createFixture();
    try {
      const config = ts.getParsedCommandLineOfConfigFile(fixture.tsconfigPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
          throw new Error(formatDiagnostics([diagnostic]));
        },
      });
      if (config === undefined) throw new Error("Unable to parse fixture tsconfig.json");

      const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
      const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];

      expect(formatDiagnostics(diagnostics)).toBe("");
      expect(program.getSourceFile(resolve(repoRoot, "src/shared/workspaceTasks.ts"))).toBeDefined();
    } finally {
      await removeFixture(fixture);
    }
  });

  it("emits and refreshes the shared domain before the Workspace Tasks plugin entry", async () => {
    const fixture = await createFixture();
    const watchHarness = createWatchHarness();
    const writes = [];
    const fileSystem = {
      copyFile,
      mkdir,
      readdir,
      readFile,
      rm,
      writeFile: async (...args) => {
        writes.push(args[0]);
        return writeFile(...args);
      },
    };
    let watching;

    try {
      const { createPluginsBuilder } = await import("./build-plugins.mjs");
      expect(createPluginsBuilder).toBeTypeOf("function");

      const builder = createPluginsBuilder({
        rootDir: fixture.pluginRoot,
        outDir: fixture.outputRoot,
        workspaceTasksDomainSourcePath: fixture.domainSourcePath,
        fileSystem,
        watchFactory: watchHarness.watch,
        schedule: watchHarness.schedule,
        cancelSchedule: watchHarness.cancel,
      });
      watching = await builder.startWatching();

      expect(watchHarness.paths).toContain(fixture.domainSourcePath);
      expect(watchHarness.paths).toContain(fixture.domainDependencyPath);
      expect(writes.indexOf(fixture.domainOutputPath)).toBeLessThan(writes.indexOf(fixture.pluginOutputPath));

      const initialEntry = await readFile(fixture.pluginOutputPath, "utf8");
      expect(initialEntry).toMatch(/from ["']\.\/taskDomain\.js\?v=[a-z0-9]+["']/u);
      expect(initialEntry).not.toContain("@pi-webui/workspace-tasks-domain");
      expect(initialEntry).not.toContain("/src/");

      const initialDomain = await import(moduleUrl(fixture.domainOutputPath, "domain-initial"));
      expect(initialDomain.parseWorkspaceTasksConfigText('{"value":"task"}')).toEqual({ label: "initial", value: "task" });

      const initialPlugin = await import(moduleUrl(fixture.pluginOutputPath, "plugin-initial"));
      expect(initialPlugin.parserFixtureResult).toEqual({ label: "initial", value: "fixture" });

      writes.length = 0;
      await writeFile(fixture.domainSourcePath, domainSource("updated"), "utf8");
      watchHarness.trigger(fixture.domainSourcePath);
      await watchHarness.runQueuedBuild();

      expect(writes.indexOf(fixture.domainOutputPath)).toBeLessThan(writes.indexOf(fixture.pluginOutputPath));
      const updatedEntry = await readFile(fixture.pluginOutputPath, "utf8");
      expect(updatedEntry).not.toBe(initialEntry);

      const updatedPlugin = await import(moduleUrl(fixture.pluginOutputPath, "plugin-updated"));
      expect(updatedPlugin.parserFixtureResult).toEqual({ label: "updated", value: "fixture" });
    } finally {
      watching?.close();
      await removeFixture(fixture);
    }
  });
});

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "pi-webui-build-plugins-"));
  const pluginRoot = join(rootDir, "pi-webui-plugins");
  const workspaceTasksPluginDir = join(pluginRoot, "workspace-tasks");
  const sourceSharedDir = join(rootDir, "src", "shared");
  const outputRoot = join(rootDir, "dist", "pi-webui-plugins");
  const domainSourcePath = join(sourceSharedDir, "workspaceTasks.ts");
  const domainDependencyPath = join(sourceSharedDir, "fixtureTask.ts");
  const domainOutputPath = join(outputRoot, "workspace-tasks", "taskDomain.js");
  const pluginOutputPath = join(outputRoot, "workspace-tasks", "pi-webui-plugin.js");
  const tsconfigPath = join(rootDir, "tsconfig.json");

  await mkdir(workspaceTasksPluginDir, { recursive: true });
  await mkdir(sourceSharedDir, { recursive: true });
  await Promise.all([
    writeFile(tsconfigPath, fixtureTsconfig(), "utf8"),
    writeFile(join(workspaceTasksPluginDir, "pi-webui-plugin.ts"), pluginSource(), "utf8"),
    writeFile(domainSourcePath, domainSource("initial"), "utf8"),
    writeFile(domainDependencyPath, "export interface FixtureTask { label: string; value: string; }\n", "utf8"),
  ]);

  return {
    rootDir,
    pluginRoot,
    outputRoot,
    domainSourcePath,
    domainDependencyPath,
    domainOutputPath,
    pluginOutputPath,
    tsconfigPath,
  };
}

function fixtureTsconfig() {
  return `${JSON.stringify({
    extends: join(repoRoot, "tsconfig.json"),
    compilerOptions: { noEmit: true, typeRoots: [join(repoRoot, "node_modules", "@types")] },
    include: ["pi-webui-plugins/**/*.ts"],
  }, null, 2)}\n`;
}

function pluginSource() {
  return [
    'import { parseWorkspaceTasksConfigText } from "@pi-webui/workspace-tasks-domain";',
    'export const parserFixtureResult = parseWorkspaceTasksConfigText(\'{"value":"fixture"}\');',
    "",
  ].join("\n");
}

function domainSource(label) {
  return [
    'import type { FixtureTask } from "./fixtureTask.js";',
    "export function parseWorkspaceTasksConfigText(text: string): FixtureTask {",
    "  const parsed: unknown = JSON.parse(text);",
    "  if (!isFixtureTask(parsed)) throw new Error(\"Fixture task must include a value\");",
    `  return { label: ${JSON.stringify(label)}, value: parsed.value };`,
    "}",
    "",
    "function isFixtureTask(value: unknown): value is { value: string } {",
    "  return typeof value === \"object\" && value !== null && \"value\" in value && typeof value.value === \"string\";",
    "}",
    "",
  ].join("\n");
}

function createWatchHarness() {
  const callbacks = new Map();
  const paths = [];
  const queuedBuilds = [];

  return {
    paths,
    watch(path, callback) {
      paths.push(path);
      callbacks.set(path, callback);
      return {
        close() {
          callbacks.delete(path);
        },
      };
    },
    schedule(callback) {
      queuedBuilds.push(callback);
      return callback;
    },
    cancel(callback) {
      const index = queuedBuilds.indexOf(callback);
      if (index !== -1) queuedBuilds.splice(index, 1);
    },
    trigger(path) {
      const callback = callbacks.get(path);
      if (callback === undefined) throw new Error(`No watcher registered for ${path}`);
      callback();
    },
    async runQueuedBuild() {
      const callback = queuedBuilds.shift();
      if (callback === undefined) throw new Error("No plugin build was queued");
      await callback();
    },
  };
}

function moduleUrl(path, version) {
  return `${pathToFileURL(path).href}?test=${encodeURIComponent(version)}`;
}

async function removeFixture(fixture) {
  await rm(fixture.rootDir, { recursive: true, force: true });
}

function formatDiagnostics(diagnostics) {
  if (diagnostics.length === 0) return "";
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  });
}
