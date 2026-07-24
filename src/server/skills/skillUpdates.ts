import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SkillInstallInfo, SkillUpdateResult } from "../../shared/apiTypes.js";

const CHECK_TIMEOUT_MS = 15_000;
const GIT_CHECK_TIMEOUT_MS = 30_000;
const skillsApiUrl = process.env["SKILLS_API_URL"];
const DEFAULT_SKILLS_API_BASE = skillsApiUrl === undefined || skillsApiUrl === "" ? "https://skills.sh" : skillsApiUrl;
const execFileAsync = promisify(execFile);

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type GitTreeResolver = (install: SkillInstallInfo) => Promise<string>;

export interface SkillUpdateCheckOptions {
  fetcher?: Fetcher;
  skillsApiBase?: string;
  githubToken?: string;
  resolveGitTreeHash?: GitTreeResolver;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
  }
}

export function skillUpdateKey(install: Pick<SkillInstallInfo, "scope" | "package">): string {
  return `${install.scope}\0${install.package}`;
}

/** Build the source CLI command used to refresh a single installed skill. */
export function buildSkillUpdateArgs(install: SkillInstallInfo): string[] {
  const folder = skillFolder(install.skillPath ?? "");
  const source = folder === "" ? install.source : `${install.source}/${folder}`;
  const ref = install.ref === undefined ? "" : `#${encodeURIComponent(install.ref)}`;
  const args = [
    "skills",
    "add",
    `${source}${ref}`,
    "--skill",
    skillNameFromPackage(install.package),
    "-y",
    "--agent",
    "pi",
  ];
  if (install.scope === "global") args.push("-g");
  return args;
}

function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function skillNameFromPackage(pkg: string): string {
  const at = pkg.lastIndexOf("@");
  return at >= 0 ? pkg.slice(at + 1) : pkg;
}

function skillFolder(skillPath: string): string {
  let folder = skillPath.replace(/\\/gu, "/");
  if (folder.toLowerCase().endsWith("/skill.md")) folder = folder.slice(0, -9);
  else if (folder.toLowerCase().endsWith("skill.md")) folder = folder.slice(0, -8);
  return folder.replace(/\/$/u, "");
}

function result(
  install: SkillInstallInfo,
  state: SkillUpdateResult["state"],
  latestVersion?: string,
  message?: string,
): SkillUpdateResult {
  return {
    package: install.package,
    scope: install.scope,
    state,
    ...(install.versionHash === undefined ? {} : { currentVersion: install.versionHash }),
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(message === undefined ? {} : { message }),
  };
}

async function fetchJson(url: string, fetcher: Fetcher, headers?: HeadersInit): Promise<unknown> {
  const response = await fetcher(url, {
    cache: "no-store",
    ...(headers === undefined ? {} : { headers }),
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status);
  return await response.json();
}

function recordString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function recordArray(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return Array.isArray(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveGitTreeHash(install: SkillInstallInfo): Promise<string> {
  const repository = `https://github.com/${install.source}.git`;
  const ref = install.ref ?? "HEAD";
  const folder = skillFolder(install.skillPath ?? "");
  const gitDir = await mkdtemp(join(tmpdir(), "pi-webui-skill-check-"));

  try {
    await execFileAsync("git", ["init", "--bare", gitDir], { timeout: GIT_CHECK_TIMEOUT_MS });
    await execFileAsync("git", [
      `--git-dir=${gitDir}`,
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      repository,
      ref,
    ], { timeout: GIT_CHECK_TIMEOUT_MS });
    const revision = folder === "" ? "FETCH_HEAD^{tree}" : `FETCH_HEAD:${folder}`;
    const { stdout } = await execFileAsync("git", [`--git-dir=${gitDir}`, "rev-parse", revision], { timeout: GIT_CHECK_TIMEOUT_MS });
    const hash = stdout.trim();
    if (!/^[0-9a-f]{40}$/iu.test(hash)) throw new Error("Invalid Git tree hash");
    return hash;
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}

async function checkGlobalSkill(
  install: SkillInstallInfo,
  options: Required<Pick<SkillUpdateCheckOptions, "fetcher" | "resolveGitTreeHash">> & SkillUpdateCheckOptions,
): Promise<SkillUpdateResult> {
  const ref = install.ref ?? "HEAD";
  const url = `https://api.github.com/repos/${install.source}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "pi-webui",
  };
  if (options.githubToken !== undefined && options.githubToken !== "") headers["Authorization"] = `Bearer ${options.githubToken}`;

  const folder = skillFolder(install.skillPath ?? "");
  let latestVersion: string | undefined;
  try {
    const raw = await fetchJson(url, options.fetcher, headers);
    const rootHash = recordString(raw, "sha");
    latestVersion = rootHash !== undefined && folder === "" ? rootHash : undefined;
    const tree = recordArray(raw, "tree");
    if (folder !== "" && tree !== undefined) {
      const entry = tree.find((item) => recordString(item, "type") === "tree" && recordString(item, "path") === folder);
      latestVersion = entry === undefined ? undefined : recordString(entry, "sha");
    }
  } catch (error) {
    if (!(error instanceof HttpError) || ![401, 403, 429].includes(error.status)) throw error;
    latestVersion = await options.resolveGitTreeHash(install);
  }

  if (latestVersion === undefined || latestVersion === "") return result(install, "error", undefined, "Remote skill path was not found.");
  return result(install, latestVersion === install.versionHash ? "up-to-date" : "update-available", latestVersion);
}

async function checkProjectSkill(
  install: SkillInstallInfo,
  options: Required<Pick<SkillUpdateCheckOptions, "fetcher" | "skillsApiBase">> & SkillUpdateCheckOptions,
): Promise<SkillUpdateResult> {
  const [owner, repo] = install.source.split("/");
  const name = skillSlug(skillNameFromPackage(install.package));
  const url = `${options.skillsApiBase}/api/download/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}/${encodeURIComponent(name)}`;
  const raw = await fetchJson(url, options.fetcher);
  const latestVersion = recordString(raw, "hash");
  if (latestVersion === undefined || latestVersion === "") return result(install, "error", undefined, "skills.sh did not return a version hash.");
  return result(install, latestVersion === install.versionHash ? "up-to-date" : "update-available", latestVersion);
}

export async function checkSkillUpdate(
  install: SkillInstallInfo,
  options: SkillUpdateCheckOptions = {},
): Promise<SkillUpdateResult> {
  if (!install.canCheckForUpdates || install.versionHash === undefined || install.skillPath === undefined) {
    return result(install, "unsupported", undefined, "This lock entry cannot be checked automatically.");
  }

  const resolvedOptions = {
    ...options,
    fetcher: options.fetcher ?? fetch,
    skillsApiBase: options.skillsApiBase ?? DEFAULT_SKILLS_API_BASE,
    resolveGitTreeHash: options.resolveGitTreeHash ?? resolveGitTreeHash,
  };

  try {
    return install.scope === "global"
      ? await checkGlobalSkill(install, resolvedOptions)
      : await checkProjectSkill(install, resolvedOptions);
  } catch (error) {
    return result(install, "error", undefined, error instanceof Error ? error.message : String(error));
  }
}

/** Coalesce identical remote reads while preserving a result for every skill. */
export async function checkSkillUpdates(
  installs: readonly SkillInstallInfo[],
  options: SkillUpdateCheckOptions = {},
): Promise<SkillUpdateResult[]> {
  const fetcher = options.fetcher ?? fetch;
  const requests = new Map<string, Promise<Response>>();
  const cachedFetcher: Fetcher = async (input, init) => {
    let request = requests.get(input);
    if (request === undefined) {
      request = fetcher(input, init);
      requests.set(input, request);
    }
    return (await request).clone();
  };

  return await Promise.all(installs.map(async (install) => await checkSkillUpdate(install, { ...options, fetcher: cachedFetcher })));
}
