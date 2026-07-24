import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { DefaultPackageManager, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import type {
  PiPackagePluginDiagnostic,
  PiPackagePluginInfo,
  PiPackagePluginMutationRequest,
  PiPackagePluginResourceCounts,
  PiPackagePluginResourceInfo,
  PiPackagePluginResourceKind,
  PiPackagePluginScope,
  PiPackagePluginsResponse,
} from "../shared/apiTypes.js";
import { requireActiveAgentProfile, type ActiveAgentProfileProvider } from "./activeAgentProfileProvider.js";

interface ResolvedPackageResource {
  path: string;
  enabled: boolean;
  metadata: {
    source: string;
    scope: string;
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

interface ResolvedPackagePaths {
  extensions: ResolvedPackageResource[];
  skills: ResolvedPackageResource[];
  prompts: ResolvedPackageResource[];
  themes: ResolvedPackageResource[];
}

interface ConfiguredPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

export interface PiPackagePluginsPackageManager {
  resolve(onMissing?: (source: string) => Promise<"install" | "skip" | "error">): Promise<ResolvedPackagePaths>;
  listConfiguredPackages(): ConfiguredPackage[];
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
  update(source?: string): Promise<void>;
}

export interface PiPackagePluginsSettingsManager {
  getGlobalSettings(): { packages?: PackageSource[] };
  getProjectSettings(): { packages?: PackageSource[] };
  setPackages(packages: PackageSource[]): void;
  setProjectPackages(packages: PackageSource[]): void;
  flush(): Promise<void>;
}

export interface PiPackagePluginsRuntime {
  packageManager: PiPackagePluginsPackageManager;
  settingsManager: PiPackagePluginsSettingsManager;
}

export type PiPackagePluginsRuntimeFactory = (cwd: string, agentDir: string) => PiPackagePluginsRuntime;

export interface PiPackagePluginsConfigService {
  list(cwd: string): Promise<PiPackagePluginsResponse>;
  mutate(request: PiPackagePluginMutationRequest): Promise<PiPackagePluginsResponse>;
}

/**
 * Resolves and manages Pi packages for one active agent profile. Browser state
 * remains in the client; this service owns filesystem and package-manager work.
 */
export class DefaultPiPackagePluginsConfigService implements PiPackagePluginsConfigService {
  constructor(
    private readonly agentDir: string,
    private readonly createRuntime: PiPackagePluginsRuntimeFactory = createPiPackagePluginsRuntime,
  ) {}

  async list(cwd: string): Promise<PiPackagePluginsResponse> {
    return await readPlugins(this.createRuntime(requireCwd(cwd), this.agentDir));
  }

  async mutate(request: PiPackagePluginMutationRequest): Promise<PiPackagePluginsResponse> {
    const cwd = requireCwd(request.cwd);
    const runtime = this.createRuntime(cwd, this.agentDir);
    const scope = request.scope ?? "global";

    switch (request.action) {
      case "install": {
        const source = requiredSource(request.source);
        await runtime.packageManager.installAndPersist(source, scope === "project" ? { local: true } : undefined);
        break;
      }
      case "remove": {
        const source = requiredSource(request.source);
        await runtime.packageManager.removeAndPersist(source, scope === "project" ? { local: true } : undefined);
        break;
      }
      case "update": {
        const source = optionalSource(request.source);
        await runtime.packageManager.update(source);
        break;
      }
      case "disable":
        setPackageDisabled(runtime.settingsManager, requiredSource(request.source), scope, true);
        break;
      case "enable":
        setPackageDisabled(runtime.settingsManager, requiredSource(request.source), scope, false);
        break;
    }

    // Package-manager setters queue persistence. Flush before resolving again
    // so the returned workspace state is durable and immediately coherent.
    await runtime.settingsManager.flush();
    return await readPlugins(runtime);
  }
}

/** Resolves the daemon-selected profile at each operation boundary. */
export class ActiveProfilePiPackagePluginsConfigService implements PiPackagePluginsConfigService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly activeAgentProfile: ActiveAgentProfileProvider,
    private readonly serviceForAgentDir: (agentDir: string) => PiPackagePluginsConfigService,
  ) {}

  async list(cwd: string): Promise<PiPackagePluginsResponse> {
    return await this.withActiveService((service) => service.list(cwd));
  }

  mutate(request: PiPackagePluginMutationRequest): Promise<PiPackagePluginsResponse> {
    const queuedMutation = this.mutationQueue.then(() => this.withActiveService((service) => service.mutate(request)));
    this.mutationQueue = queuedMutation.then(
      () => undefined,
      () => undefined,
    );
    return queuedMutation;
  }

  private async withActiveService<T>(operation: (service: PiPackagePluginsConfigService) => Promise<T>): Promise<T> {
    const profile = await requireActiveAgentProfile(this.activeAgentProfile);
    return await operation(this.serviceForAgentDir(profile.dir));
  }
}

export function createActiveProfilePiPackagePluginsConfigService(activeAgentProfile: ActiveAgentProfileProvider): PiPackagePluginsConfigService {
  return new ActiveProfilePiPackagePluginsConfigService(
    activeAgentProfile,
    (agentDir) => new DefaultPiPackagePluginsConfigService(agentDir),
  );
}

function createPiPackagePluginsRuntime(cwd: string, agentDir: string): PiPackagePluginsRuntime {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  return { packageManager, settingsManager };
}

function requireCwd(cwd: string): string {
  if (cwd.trim() === "") throw new Error("cwd is required");
  return cwd;
}

function requiredSource(source: string | undefined): string {
  const normalized = optionalSource(source);
  if (normalized === undefined) throw new Error("source is required");
  return normalized;
}

function optionalSource(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  const normalized = source.trim();
  return normalized === "" ? undefined : normalized;
}

function emptyCounts(): PiPackagePluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function toPluginScope(scope: string): PiPackagePluginScope {
  return scope === "project" ? "project" : "global";
}

function packageKey(source: string, scope: PiPackagePluginScope): string {
  return `${scope}\0${source}`;
}

function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageIsDisabled(entry: PackageSource): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) && entry.extensions.length === 0
    && Array.isArray(entry.skills) && entry.skills.length === 0
    && Array.isArray(entry.prompts) && entry.prompts.length === 0
    && Array.isArray(entry.themes) && entry.themes.length === 0
  );
}

function disabledPackages(settingsManager: PiPackagePluginsSettingsManager): Map<string, boolean> {
  const disabled = new Map<string, boolean>();
  for (const entry of settingsManager.getGlobalSettings().packages ?? []) {
    disabled.set(packageKey(packageSource(entry), "global"), packageIsDisabled(entry));
  }
  for (const entry of settingsManager.getProjectSettings().packages ?? []) {
    disabled.set(packageKey(packageSource(entry), "project"), packageIsDisabled(entry));
  }
  return disabled;
}

function setPackageDisabled(
  settingsManager: PiPackagePluginsSettingsManager,
  source: string,
  scope: PiPackagePluginScope,
  disabled: boolean,
): boolean {
  const current = scope === "project"
    ? settingsManager.getProjectSettings().packages ?? []
    : settingsManager.getGlobalSettings().packages ?? [];
  const hasMatchingSource = current.some((entry) => packageSource(entry) === source);
  if (!hasMatchingSource) return false;
  const next = current.map((entry): PackageSource => {
    if (packageSource(entry) !== source) return entry;
    if (disabled) {
      return {
        ...(typeof entry === "string" ? { source: entry } : entry),
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
    }
    return packageSource(entry);
  });
  if (scope === "project") settingsManager.setProjectPackages(next);
  else settingsManager.setPackages(next);
  return true;
}

function addCount(counts: PiPackagePluginResourceCounts, kind: keyof PiPackagePluginResourceCounts): void {
  counts[kind] += 1;
}

function resourceName(path: string, kind: PiPackagePluginResourceKind): string {
  const file = basename(path);
  const extension = extname(file);
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
  if ((kind === "extension" || kind === "theme" || kind === "prompt") && extension !== "") {
    if (kind === "extension" && /^index\.(ts|js)$/u.test(file)) return basename(dirname(path));
    return file.slice(0, -extension.length);
  }
  return file;
}

function resourceRelativePath(resource: ResolvedPackageResource): string {
  const baseDir = resource.metadata.baseDir;
  if (baseDir === undefined || baseDir === "") return resource.path;
  const relativePath = relative(baseDir, resource.path);
  return relativePath !== "" && !relativePath.startsWith("..") ? relativePath : resource.path;
}

function configuredVersion(source: string): string | undefined {
  const npmSpec = source.startsWith("npm:") ? source.slice(4) : undefined;
  if (npmSpec !== undefined) {
    const lastAt = npmSpec.lastIndexOf("@");
    const packageNameEnd = npmSpec.startsWith("@") ? npmSpec.indexOf("/", 1) : 0;
    if (lastAt > packageNameEnd) return npmSpec.slice(lastAt + 1) || undefined;
    return undefined;
  }

  if (source.startsWith("git:") || /^[a-z]+:\/\//u.test(source)) {
    const lastAt = source.lastIndexOf("@");
    const lastSlash = source.lastIndexOf("/");
    const lastColon = source.lastIndexOf(":");
    if (lastAt > Math.max(lastSlash, lastColon)) return source.slice(lastAt + 1) || undefined;
  }
  return undefined;
}

function packageMetadata(installedPath: string | undefined): { packageName?: string; version?: string } {
  if (installedPath === undefined) return {};
  try {
    const stats = statSync(installedPath);
    const packageJsonPath = stats.isDirectory()
      ? join(installedPath, "package.json")
      : join(dirname(installedPath), "package.json");
    if (!existsSync(packageJsonPath)) return {};
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (!isRecord(parsed)) return {};
    const packageName = typeof parsed["name"] === "string" ? parsed["name"] : undefined;
    const version = typeof parsed["version"] === "string" ? parsed["version"] : undefined;
    return {
      ...(packageName === undefined ? {} : { packageName }),
      ...(version === undefined ? {} : { version }),
    };
  } catch {
    return {};
  }
}

function collectResource(
  resource: ResolvedPackageResource,
  kind: keyof PiPackagePluginResourceCounts,
  countsByPackage: Map<string, PiPackagePluginResourceCounts>,
  resourcesByPackage: Map<string, PiPackagePluginResourceInfo[]>,
  totals: PiPackagePluginResourceCounts,
): void {
  if (!resource.enabled || resource.metadata.origin !== "package") return;
  const scope = toPluginScope(resource.metadata.scope);
  const key = packageKey(resource.metadata.source, scope);
  const counts = countsByPackage.get(key) ?? emptyCounts();
  addCount(counts, kind);
  addCount(totals, kind);
  countsByPackage.set(key, counts);
  const resources = resourcesByPackage.get(key) ?? [];
  const resourceKind: PiPackagePluginResourceKind = kind === "extensions"
    ? "extension"
    : kind === "skills"
      ? "skill"
      : kind === "prompts"
        ? "prompt"
        : "theme";
  resources.push({
    kind: resourceKind,
    name: resourceName(resource.path, resourceKind),
    path: resource.path,
    relativePath: resourceRelativePath(resource),
  });
  resourcesByPackage.set(key, resources);
}

function collectResources(resolved: ResolvedPackagePaths): {
  countsByPackage: Map<string, PiPackagePluginResourceCounts>;
  resourcesByPackage: Map<string, PiPackagePluginResourceInfo[]>;
  totals: PiPackagePluginResourceCounts;
} {
  const countsByPackage = new Map<string, PiPackagePluginResourceCounts>();
  const resourcesByPackage = new Map<string, PiPackagePluginResourceInfo[]>();
  const totals = emptyCounts();
  for (const resource of resolved.extensions) collectResource(resource, "extensions", countsByPackage, resourcesByPackage, totals);
  for (const resource of resolved.skills) collectResource(resource, "skills", countsByPackage, resourcesByPackage, totals);
  for (const resource of resolved.prompts) collectResource(resource, "prompts", countsByPackage, resourcesByPackage, totals);
  for (const resource of resolved.themes) collectResource(resource, "themes", countsByPackage, resourcesByPackage, totals);
  return { countsByPackage, resourcesByPackage, totals };
}

async function readPlugins(runtime: PiPackagePluginsRuntime): Promise<PiPackagePluginsResponse> {
  const diagnostics: PiPackagePluginDiagnostic[] = [];
  let countsByPackage = new Map<string, PiPackagePluginResourceCounts>();
  let resourcesByPackage = new Map<string, PiPackagePluginResourceInfo[]>();
  let totals = emptyCounts();
  const disabledByPackage = disabledPackages(runtime.settingsManager);

  try {
    const resolved = await runtime.packageManager.resolve((source) => {
      diagnostics.push({ type: "warning", source, message: "Package is configured but not installed yet." });
      return Promise.resolve<"skip">("skip");
    });
    ({ countsByPackage, resourcesByPackage, totals } = collectResources(resolved));
  } catch (error) {
    diagnostics.push({ type: "error", message: errorMessage(error) });
  }

  const packages = runtime.packageManager.listConfiguredPackages().map((configuredPackage): PiPackagePluginInfo => {
    const scope = toPluginScope(configuredPackage.scope);
    const key = packageKey(configuredPackage.source, scope);
    const disabled = disabledByPackage.get(key) ?? false;
    const counts = countsByPackage.get(key) ?? emptyCounts();
    const resources = resourcesByPackage.get(key) ?? [];
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const metadata = packageMetadata(configuredPackage.installedPath);
    const sourceVersion = configuredVersion(configuredPackage.source);
    if (configuredPackage.installedPath === undefined) {
      diagnostics.push({ type: "warning", source: configuredPackage.source, message: "Configured package path was not found." });
    }
    const status: PiPackagePluginInfo["status"] = disabled
      ? "disabled"
      : resourceCount > 0
        ? "loaded"
        : configuredPackage.installedPath === undefined
          ? "missing"
          : "installed";
    return {
      source: configuredPackage.source,
      scope,
      filtered: configuredPackage.filtered,
      disabled,
      ...(configuredPackage.installedPath === undefined ? {} : { installedPath: configuredPackage.installedPath }),
      ...metadata,
      ...(sourceVersion === undefined ? {} : { configuredVersion: sourceVersion }),
      counts,
      resources,
      status,
    };
  });

  return { packages, totals, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
