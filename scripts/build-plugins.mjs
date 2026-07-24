#!/usr/bin/env node
import { watch } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const rootDir = resolve("pi-webui-plugins");
const outDir = resolve("dist/pi-webui-plugins");
const watchMode = process.argv.includes("--watch");
const cwd = process.cwd();

if (watchMode) {
  await watchAndBuild();
} else {
  await buildAll();
}

async function buildAll() {
  await rm(outDir, { recursive: true, force: true });
  const result = await buildDirectory(rootDir, outDir);
  const suffix = result.transpiled === 1 ? "file" : "files";
  console.log(`[plugins] built ${String(result.transpiled)} TypeScript plugin ${suffix} into ${relative(cwd, outDir)}`);
}

async function buildDirectory(sourceDir, targetDir) {
  const entries = await readDirectory(sourceDir);
  let copied = 0;
  let transpiled = 0;

  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      const result = await buildDirectory(sourcePath, targetPath);
      copied += result.copied;
      transpiled += result.transpiled;
      continue;
    }

    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".d.ts") || isTestSource(entry.name)) continue;

    if (isPluginSource(entry.name)) {
      await buildFile(sourcePath, targetPath.replace(/\.ts$/u, ".js"));
      transpiled += 1;
      continue;
    }

    if (entry.name.endsWith(".js") && await hasTypeScriptSource(sourcePath)) continue;
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied += 1;
  }

  return { copied, transpiled };
}

async function buildFile(file, outputPath) {
  const source = await readFile(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: false,
    },
  });

  const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(formatDiagnostics(errors));

  const output = `// Generated from ${relative(cwd, file)}. Do not edit directly.\n${transpiled.outputText}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
}

async function findPluginDirs(dir) {
  const entries = await readDirectory(dir);
  const dirs = [dir];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    dirs.push(...await findPluginDirs(resolve(dir, entry.name)));
  }
  return dirs.sort((left, right) => left.localeCompare(right));
}

function isPluginSource(fileName) {
  return fileName.endsWith(".ts") && !fileName.endsWith(".d.ts");
}

function isTestSource(fileName) {
  return /\.(?:test|spec)\.ts$/u.test(fileName);
}

async function hasTypeScriptSource(javaScriptPath) {
  const typeScriptPath = javaScriptPath.replace(/\.js$/u, ".ts");
  try {
    await readFile(typeScriptPath, "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readDirectory(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function watchAndBuild() {
  let watchers = [];
  let timer;
  let building = false;
  let pending = false;

  const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const refreshWatchers = async () => {
    closeWatchers();
    const dirs = await findPluginDirs(rootDir);
    watchers = dirs.map((dir) => watch(dir, () => scheduleBuild()));
  };

  const runBuild = async () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      do {
        pending = false;
        await refreshWatchers();
        await buildAll();
      } while (pending);
    } catch (error) {
      console.error(`[plugins] ${formatUnknownError(error)}`);
    } finally {
      building = false;
    }
  };

  const scheduleBuild = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runBuild();
    }, 100);
  };

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    closeWatchers();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await runBuild();
  console.log(`[plugins] watching ${relative(cwd, rootDir)}`);
  await new Promise(() => undefined);
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => cwd,
    getNewLine: () => "\n",
  });
}

function formatUnknownError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
