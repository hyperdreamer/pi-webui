#!/usr/bin/env node
import { createHash } from "node:crypto";
import { watch as nodeWatch } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const workspaceTasksDomainImport = "@pi-webui/workspace-tasks-domain";
const defaultFileSystem = { copyFile, mkdir, readdir, readFile, rm, writeFile };
const domainCompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
};

export function createPluginsBuilder({
  rootDir = resolve("pi-webui-plugins"),
  outDir = resolve("dist/pi-webui-plugins"),
  workspaceTasksDomainSourcePath = resolve("src/shared/workspaceTasks.ts"),
  fileSystem = defaultFileSystem,
  watchFactory = nodeWatch,
  schedule = scheduleBuild,
  cancelSchedule = clearTimeout,
  logger = console,
  cwd = process.cwd(),
} = {}) {
  let watchers = [];
  let timer;
  let building = false;
  let pending = false;

  const buildAll = async () => {
    await fileSystem.rm(outDir, { recursive: true, force: true });
    const domainVersion = await buildWorkspaceTasksDomain();
    const result = await buildDirectory(rootDir, outDir, `./taskDomain.js?v=${domainVersion}`);
    const suffix = result.transpiled === 1 ? "file" : "files";
    logger.log(`[plugins] built ${String(result.transpiled)} TypeScript plugin ${suffix} into ${relative(cwd, outDir)}`);
    return result;
  };

  const buildWorkspaceTasksDomain = async () => {
    const source = await fileSystem.readFile(workspaceTasksDomainSourcePath, "utf8");
    const outputPath = resolve(outDir, "workspace-tasks", "taskDomain.js");
    await writeTranspiledFile(workspaceTasksDomainSourcePath, outputPath, source, {
      sourceLabel: "Workspace Tasks task domain",
    });
    return contentVersion(source);
  };

  const buildDirectory = async (sourceDir, targetDir, domainModuleSpecifier) => {
    const entries = await readDirectory(sourceDir);
    let copied = 0;
    let transpiled = 0;

    for (const entry of entries) {
      const sourcePath = resolve(sourceDir, entry.name);
      const targetPath = resolve(targetDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        const result = await buildDirectory(sourcePath, targetPath, domainModuleSpecifier);
        copied += result.copied;
        transpiled += result.transpiled;
        continue;
      }

      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".d.ts") || isTestSource(entry.name)) continue;

      if (isPluginSource(entry.name)) {
        await buildFile(sourcePath, targetPath.replace(/\.ts$/u, ".js"), domainModuleSpecifier);
        transpiled += 1;
        continue;
      }

      if (entry.name.endsWith(".js") && await hasTypeScriptSource(sourcePath)) continue;
      await fileSystem.mkdir(dirname(targetPath), { recursive: true });
      await fileSystem.copyFile(sourcePath, targetPath);
      copied += 1;
    }

    return { copied, transpiled };
  };

  const buildFile = async (file, outputPath, domainModuleSpecifier) => {
    const source = await fileSystem.readFile(file, "utf8");
    await writeTranspiledFile(file, outputPath, source, { domainModuleSpecifier });
  };

  const writeTranspiledFile = async (file, outputPath, source, options = {}) => {
    const transpiled = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: {
        ...domainCompilerOptions,
        verbatimModuleSyntax: true,
        sourceMap: false,
        inlineSourceMap: false,
      },
      transformers: options.domainModuleSpecifier === undefined
        ? undefined
        : { before: [createDomainImportTransformer(options.domainModuleSpecifier)] },
    });

    const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) throw new Error(formatDiagnostics(errors, cwd));

    const sourceLabel = options.sourceLabel ?? relative(cwd, file);
    const output = `// Generated from ${sourceLabel}. Do not edit directly.\n${transpiled.outputText}`;
    await fileSystem.mkdir(dirname(outputPath), { recursive: true });
    await fileSystem.writeFile(outputPath, output);
  };

  const findPluginDirs = async (dir) => {
    const entries = await readDirectory(dir);
    const dirs = [dir];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      dirs.push(...await findPluginDirs(resolve(dir, entry.name)));
    }
    return dirs.sort((left, right) => left.localeCompare(right));
  };

  const findWorkspaceTasksDomainDependencies = async () => {
    const dependencies = new Set();
    const pendingSources = [workspaceTasksDomainSourcePath];

    while (pendingSources.length > 0) {
      const sourcePath = pendingSources.pop();
      if (sourcePath === undefined) continue;

      const source = await fileSystem.readFile(sourcePath, "utf8");
      const references = ts.preProcessFile(source, true, true).importedFiles;
      for (const reference of references) {
        if (!reference.fileName.startsWith(".")) continue;
        const dependency = resolveTypeScriptDependency(reference.fileName, sourcePath);
        if (dependency === undefined || dependencies.has(dependency)) continue;
        dependencies.add(dependency);
        pendingSources.push(dependency);
      }
    }

    return [...dependencies].sort((left, right) => left.localeCompare(right));
  };

  const readDirectory = async (dir) => {
    try {
      return await fileSystem.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  };

  const hasTypeScriptSource = async (javaScriptPath) => {
    const typeScriptPath = javaScriptPath.replace(/\.js$/u, ".ts");
    try {
      await fileSystem.readFile(typeScriptPath, "utf8");
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  };

  const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const refreshWatchers = async () => {
    closeWatchers();
    const [pluginDirs, domainDependencies] = await Promise.all([
      findPluginDirs(rootDir),
      findWorkspaceTasksDomainDependencies(),
    ]);
    const watchedInputs = [...new Set([
      ...pluginDirs,
      workspaceTasksDomainSourcePath,
      ...domainDependencies,
    ])];
    watchers = watchedInputs.map((path) => watchFactory(path, () => scheduleNextBuild()));
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
    } finally {
      building = false;
    }
  };

  const scheduleNextBuild = () => {
    if (timer !== undefined) cancelSchedule(timer);
    timer = schedule(async () => {
      timer = undefined;
      try {
        await runBuild();
      } catch (error) {
        logger.error(`[plugins] ${formatUnknownError(error)}`);
      }
    }, 100);
  };

  return {
    buildAll,
    async startWatching() {
      try {
        await runBuild();
      } catch (error) {
        logger.error(`[plugins] ${formatUnknownError(error)}`);
      }
      return {
        close() {
          if (timer !== undefined) cancelSchedule(timer);
          closeWatchers();
        },
      };
    },
  };
}

function createDomainImportTransformer(domainModuleSpecifier) {
  return (context) => {
    const visitor = (node) => {
      if (ts.isImportDeclaration(node) && isWorkspaceTasksDomainSpecifier(node.moduleSpecifier)) {
        return ts.factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          ts.factory.createStringLiteral(domainModuleSpecifier),
          node.attributes,
        );
      }

      if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && isWorkspaceTasksDomainSpecifier(node.moduleSpecifier)) {
        return ts.factory.updateExportDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          ts.factory.createStringLiteral(domainModuleSpecifier),
          node.attributes,
        );
      }

      if (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression !== undefined
        && isWorkspaceTasksDomainSpecifier(node.moduleReference.expression)) {
        return ts.factory.updateImportEqualsDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.name,
          ts.factory.updateExternalModuleReference(
            node.moduleReference,
            ts.factory.createStringLiteral(domainModuleSpecifier),
          ),
        );
      }

      if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1
        && isWorkspaceTasksDomainSpecifier(node.arguments[0])) {
        return ts.factory.updateCallExpression(
          node,
          node.expression,
          node.typeArguments,
          [ts.factory.createStringLiteral(domainModuleSpecifier)],
        );
      }

      return ts.visitEachChild(node, visitor, context);
    };

    return (sourceFile) => ts.visitNode(sourceFile, visitor);
  };
}

function isWorkspaceTasksDomainSpecifier(node) {
  return ts.isStringLiteral(node) && node.text === workspaceTasksDomainImport;
}

function resolveTypeScriptDependency(specifier, sourcePath) {
  const resolved = ts.resolveModuleName(specifier, sourcePath, domainCompilerOptions, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved === undefined || !isTypeScriptPath(resolved)) return undefined;
  return resolve(resolved);
}

function isTypeScriptPath(path) {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

function contentVersion(source) {
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

function isPluginSource(fileName) {
  return fileName.endsWith(".ts") && !fileName.endsWith(".d.ts");
}

function isTestSource(fileName) {
  return /\.(?:test|spec)\.ts$/u.test(fileName);
}

function scheduleBuild(callback, delay) {
  return setTimeout(callback, delay);
}

function formatDiagnostics(diagnostics, cwd) {
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

async function runCli() {
  const builder = createPluginsBuilder();
  if (!process.argv.includes("--watch")) {
    await builder.buildAll();
    return;
  }

  const watching = await builder.startWatching();
  const stop = () => {
    watching.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`[plugins] watching ${relative(process.cwd(), resolve("pi-webui-plugins"))}`);
  await new Promise(() => undefined);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli().catch((error) => {
    console.error(`[plugins] ${formatUnknownError(error)}`);
    process.exitCode = 1;
  });
}
