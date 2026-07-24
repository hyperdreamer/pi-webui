import { readFile, writeFile } from "node:fs/promises";
import { DefaultResourceLoader, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type {
  SkillInstallRequest,
  SkillInstallScope,
  SkillInfo,
  SkillMutationResponse,
  SkillSearchRequest,
  SkillSearchResult,
  SkillsCheckResponse,
  SkillsResponse,
  SkillUpdateRequest,
  SkillUpdateResponse,
} from "../../shared/apiTypes.js";
import { annotateSkillsWithInstallInfo } from "./skillLock.js";
import { runNpx, type RunNpxOptions, type RunNpxResult } from "./runNpx.js";
import { buildSkillUpdateArgs, checkSkillUpdates, type SkillUpdateCheckOptions } from "./skillUpdates.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
const DEFAULT_SEARCH_LIMIT = 50;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 50;
const skillsApiUrl = process.env["SKILLS_API_URL"];
const DEFAULT_SKILLS_API_BASE = skillsApiUrl === undefined || skillsApiUrl === "" ? "https://skills.sh" : skillsApiUrl;

type NpxRunner = (args: readonly string[], options?: RunNpxOptions) => Promise<RunNpxResult>;
type SkillLoader = (cwd: string, agentDir: string) => Promise<SkillInfo[]>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface SkillsApiSkill {
  id?: string;
  name?: string;
  source?: string;
  installs?: number;
}

interface SkillsApiResponse {
  skills?: SkillsApiSkill[];
}

export class SkillsConfigRequestError extends Error {}
export class SkillsConfigNotFoundError extends Error {}

export interface SkillsConfigServiceDependencies {
  agentDir: string;
  loadSkills?: SkillLoader;
  runNpx?: NpxRunner;
  fetcher?: Fetcher;
  skillsApiBase?: string;
  githubToken?: string;
}

/**
 * Reads and mutates the skills visible to a selected workspace. This service
 * runs in sessiond so the profile, filesystem, and external commands belong to
 * the same long-lived Pi runtime as the sessions it serves.
 */
export class SkillsConfigService {
  private readonly loadResourceSkills: SkillLoader;
  private readonly npx: NpxRunner;
  private readonly fetcher: Fetcher;
  private readonly skillsApiBase: string;
  private readonly githubToken: string | undefined;

  constructor(private readonly dependencies: SkillsConfigServiceDependencies) {
    this.loadResourceSkills = dependencies.loadSkills ?? loadSkillsWithResourceLoader;
    this.npx = dependencies.runNpx ?? runNpx;
    this.fetcher = dependencies.fetcher ?? fetch;
    this.skillsApiBase = dependencies.skillsApiBase ?? DEFAULT_SKILLS_API_BASE;
    this.githubToken = dependencies.githubToken;
  }

  async list(cwd: string): Promise<SkillsResponse> {
    return { skills: await this.loadedSkills(requireCwd(cwd)) };
  }

  async toggle(value: unknown): Promise<SkillMutationResponse> {
    const request = parseSkillToggleRequest(value);
    const skill = (await this.loadedSkills(request.cwd)).find((item) => item.filePath === request.filePath);
    if (skill === undefined) throw new SkillsConfigNotFoundError("Skill not found in the selected workspace");
    if (!isSkillMarkdownPath(skill.filePath)) throw new SkillsConfigRequestError("Only SKILL.md files can be toggled");

    let content: string;
    try {
      content = await readFile(skill.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) throw new SkillsConfigNotFoundError("Skill file not found");
      throw error;
    }

    await writeFile(skill.filePath, updateDisableModelInvocation(content, request.disableModelInvocation), "utf8");
    return { success: true };
  }

  async search(value: unknown): Promise<{ results: SkillSearchResult[] }> {
    const request = parseSkillSearchRequest(value);
    try {
      return { results: await searchSkillsApi(request.query, request.limit, this.fetcher, this.skillsApiBase) };
    } catch {
      try {
        const { stdout, stderr } = await this.npx(["skills", "find", request.query], {
          timeout: 20_000,
          env: { ...process.env, FORCE_COLOR: "0" },
        });
        return { results: parseSearchOutput(`${stdout}${stderr}`).slice(0, request.limit) };
      } catch (error) {
        const results = parseSearchOutput(npxOutput(error)).slice(0, request.limit);
        if (results.length > 0) return { results };
        throw error;
      }
    }
  }

  async install(value: unknown): Promise<SkillMutationResponse> {
    const request = parseSkillInstallRequest(value);
    const global = request.scope === "global";
    const args = ["skills", "add", request.package, "-y", "--agent", "pi"];
    if (global) args.push("-g");

    try {
      const { stdout, stderr } = await this.npx(args, {
        timeout: 60_000,
        ...(global ? {} : { cwd: request.cwd }),
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      const output = `${stdout}${stderr}`.replace(ANSI_RE, "");
      if (!/Installation complete|Installed \d+ skill/u.test(output)) {
        throw new Error(output.slice(-300) || "Install failed");
      }
      return { success: true };
    } catch (error) {
      throw new Error(npxErrorMessage(error), { cause: error });
    }
  }

  async check(value: unknown): Promise<SkillsCheckResponse> {
    const request = parseSkillCheckRequest(value);
    const installs = (await this.loadedSkills(request.cwd))
      .flatMap((skill) => skill.install === undefined ? [] : [skill.install])
      .filter((install) => request.package === undefined || (install.package === request.package && install.scope === request.scope));

    if (request.package !== undefined && installs.length === 0) throw new SkillsConfigNotFoundError("Installed skill not found");
    return {
      updates: await checkSkillUpdates(installs, this.skillUpdateCheckOptions()),
    };
  }

  async update(value: unknown): Promise<SkillUpdateResponse> {
    const request = parseSkillUpdateRequest(value);
    const skills = await this.loadedSkills(request.cwd);
    const skill = skills.find((item) => item.install?.package === request.package && item.install.scope === request.scope);
    if (skill?.install === undefined) throw new SkillsConfigNotFoundError("Installed skill not found");
    if (!skill.install.canCheckForUpdates) throw new SkillsConfigRequestError("This skill cannot be updated automatically");

    try {
      const { stdout, stderr } = await this.npx(buildSkillUpdateArgs(skill.install), {
        timeout: 60_000,
        ...(request.scope === "project" ? { cwd: request.cwd } : {}),
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      const updatedSkill = (await this.loadedSkills(request.cwd)).find((item) => item.install?.package === request.package && item.install.scope === request.scope);
      return {
        success: true,
        ...(updatedSkill === undefined ? {} : { skill: updatedSkill }),
        output: `${stdout}${stderr}`.slice(-500),
      };
    } catch (error) {
      throw new Error(npxErrorMessage(error), { cause: error });
    }
  }

  private async loadedSkills(cwd: string): Promise<SkillInfo[]> {
    const skills = await this.loadResourceSkills(cwd, this.dependencies.agentDir);
    return annotateSkillsWithInstallInfo(skills, { cwd, agentDir: this.dependencies.agentDir });
  }

  private skillUpdateCheckOptions(): SkillUpdateCheckOptions {
    return {
      fetcher: this.fetcher,
      skillsApiBase: this.skillsApiBase,
      ...(this.githubToken === undefined ? {} : { githubToken: this.githubToken }),
    };
  }
}

async function loadSkillsWithResourceLoader(cwd: string, agentDir: string): Promise<SkillInfo[]> {
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  return loader.getSkills().skills;
}

const DISABLE_MODEL_INVOCATION_KEY = "disable-model-invocation";
const FRONTMATTER_BLOCK_PATTERN = /^(---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/mu;
const DISABLE_MODEL_INVOCATION_LINE_PATTERN = /^disable-model-invocation[ \t]*:[^\r\n]*(?:\r?\n|$)/mu;

export function updateDisableModelInvocation(content: string, disableModelInvocation: boolean): string {
  const { frontmatter } = parseFrontmatter(content);
  const hasDisableModelInvocation = Object.hasOwn(frontmatter, DISABLE_MODEL_INVOCATION_KEY);

  if (disableModelInvocation) {
    if (hasDisableModelInvocation && frontmatter[DISABLE_MODEL_INVOCATION_KEY] === true) return content;
    return hasDisableModelInvocation
      ? updateExistingDisableModelInvocation(content, true)
      : addDisableModelInvocation(content);
  }

  return hasDisableModelInvocation ? updateExistingDisableModelInvocation(content, false) : content;
}

function addDisableModelInvocation(content: string): string {
  const openingDelimiter = /^---[ \t]*(\r?\n)/u.exec(content);
  if (openingDelimiter === null) return `---\n${DISABLE_MODEL_INVOCATION_KEY}: true\n---\n${content}`;

  const lineEnding = openingDelimiter[1] ?? "\n";
  return content.replace(/^---[ \t]*\r?\n/u, (delimiter) => `${delimiter}${DISABLE_MODEL_INVOCATION_KEY}: true${lineEnding}`);
}

function updateExistingDisableModelInvocation(content: string, disableModelInvocation: boolean): string {
  const frontmatter = FRONTMATTER_BLOCK_PATTERN.exec(content)?.[2];
  if (frontmatter === undefined || !DISABLE_MODEL_INVOCATION_LINE_PATTERN.test(frontmatter)) {
    throw new Error("Could not locate disable-model-invocation in skill frontmatter");
  }

  return content.replace(FRONTMATTER_BLOCK_PATTERN, (_block, openingDelimiter: string, blockFrontmatter: string, closingDelimiter: string) => {
    const updatedFrontmatter = blockFrontmatter.replace(DISABLE_MODEL_INVOCATION_LINE_PATTERN, (line) => {
      return disableModelInvocation ? `${DISABLE_MODEL_INVOCATION_KEY}: true${lineEnding(line)}` : "";
    });
    return `${openingDelimiter}${updatedFrontmatter}${closingDelimiter}`;
  });
}

function lineEnding(line: string): string {
  return line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
}

function parseSkillToggleRequest(value: unknown): { cwd: string; filePath: string; disableModelInvocation: boolean } {
  const record = requireRecord(value, "Skill toggle request");
  const disableModelInvocation = record["disableModelInvocation"];
  if (typeof disableModelInvocation !== "boolean") throw new SkillsConfigRequestError("disableModelInvocation must be a boolean");
  return {
    cwd: requiredString(record, "cwd"),
    filePath: requiredString(record, "filePath"),
    disableModelInvocation,
  };
}

function parseSkillSearchRequest(value: unknown): Required<SkillSearchRequest> {
  const record = requireRecord(value, "Skill search request");
  const query = requiredString(record, "query");
  return { query, limit: parseSearchLimit(record["limit"]) };
}

function parseSkillInstallRequest(value: unknown): SkillInstallRequest {
  const record = requireRecord(value, "Skill install request");
  const scope = record["scope"];
  if (scope !== "global" && scope !== "project") throw new SkillsConfigRequestError("scope must be \"global\" or \"project\"");
  return {
    cwd: requiredString(record, "cwd"),
    package: requiredString(record, "package"),
    scope,
  };
}

function parseSkillCheckRequest(value: unknown): { cwd: string; package?: string; scope?: SkillInstallScope } {
  const record = requireRecord(value, "Skill update check request");
  const packageName = optionalString(record, "package");
  const scope = record["scope"];
  if (scope !== undefined && scope !== "global" && scope !== "project") throw new SkillsConfigRequestError("scope must be \"global\" or \"project\"");
  if ((packageName === undefined) !== (scope === undefined)) throw new SkillsConfigRequestError("package and scope must be provided together");
  return {
    cwd: requiredString(record, "cwd"),
    ...(packageName === undefined ? {} : { package: packageName }),
    ...(scope === undefined ? {} : { scope }),
  };
}

function parseSkillUpdateRequest(value: unknown): Required<Pick<SkillUpdateRequest, "cwd" | "package" | "scope">> {
  const record = requireRecord(value, "Skill update request");
  const scope = record["scope"];
  if (scope !== "global" && scope !== "project") throw new SkillsConfigRequestError("scope must be \"global\" or \"project\"");
  return {
    cwd: requiredString(record, "cwd"),
    package: requiredString(record, "package"),
    scope,
  };
}

function requireCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd.trim() === "") throw new SkillsConfigRequestError("cwd is required");
  return cwd;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SkillsConfigRequestError(`${label} must be an object`);
  return value;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") throw new SkillsConfigRequestError(`${field} is required`);
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new SkillsConfigRequestError(`${field} must be a non-empty string`);
  return value.trim();
}

function parseSearchLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(MIN_SEARCH_LIMIT, Math.floor(numberValue)));
}

function parseSearchOutput(raw: string): SkillSearchResult[] {
  const clean = raw.replace(ANSI_RE, "");
  const results: SkillSearchResult[] = [];
  const lines = clean.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const packageMatch = /^([\w.-]+\/[\w.@:-]+)\s+([\d.,]+[KMB]?\s+installs)$/u.exec(line);
    if (packageMatch === null) continue;
    const urlLine = lines[index + 1]?.trim().replace(/^└\s*/u, "");
    results.push({
      package: packageMatch[1] ?? "",
      installs: packageMatch[2] ?? "",
      url: urlLine?.startsWith("https://") === true ? urlLine : "",
    });
  }
  return results;
}

function parseSkillsApiResponse(value: unknown): SkillsApiResponse {
  if (!isRecord(value)) throw new Error("skills.sh search returned an invalid response");
  const rawSkills = value["skills"];
  if (rawSkills === undefined || rawSkills === null) return {};
  if (!Array.isArray(rawSkills)) throw new Error("skills.sh search returned an invalid skills list");
  return { skills: rawSkills.flatMap(parseSkillsApiSkill) };
}

function parseSkillsApiSkill(value: unknown): SkillsApiSkill[] {
  if (!isRecord(value)) return [];
  const id = typeof value["id"] === "string" ? value["id"] : undefined;
  const name = typeof value["name"] === "string" ? value["name"] : undefined;
  const source = typeof value["source"] === "string" ? value["source"] : undefined;
  const installs = typeof value["installs"] === "number" ? value["installs"] : undefined;
  return [{
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(source === undefined ? {} : { source }),
    ...(installs === undefined ? {} : { installs }),
  }];
}

async function searchSkillsApi(query: string, limit: number, fetcher: Fetcher, skillsApiBase: string): Promise<SkillSearchResult[]> {
  const url = `${skillsApiBase}/api/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`;
  const response = await fetcher(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`skills.sh search failed: HTTP ${String(response.status)}`);
  const rawData: unknown = await response.json();
  const data = parseSkillsApiResponse(rawData);
  return (data.skills ?? [])
    .map((skill): SkillSearchResult | undefined => {
      const name = skill.name?.trim();
      const source = skill.source?.trim();
      const slug = skill.id?.trim();
      if (name === undefined || name === "") return undefined;
      const packageSource = source === undefined || source === "" ? slug : source;
      if (packageSource === undefined || packageSource === "") return undefined;
      return {
        package: `${packageSource}@${name}`,
        installs: formatInstalls(skill.installs),
        url: slug === undefined || slug === "" ? "" : `${skillsApiBase}/${slug}`,
      };
    })
    .filter((skill): skill is SkillSearchResult => skill !== undefined)
    .sort((left, right) => parseInstallCount(right.installs) - parseInstallCount(left.installs));
}

function formatInstalls(count: number | undefined): string {
  if (count === undefined || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/u, "")}K installs`;
  return `${String(count)} install${count === 1 ? "" : "s"}`;
}

function parseInstallCount(installs: string): number {
  const match = /^([\d.]+)([KMB])?\s+installs?$/u.exec(installs);
  if (match === null) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const multiplier = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return value * multiplier;
}

function npxOutput(error: unknown): string {
  if (!isRecord(error)) return "";
  const stdout = typeof error["stdout"] === "string" ? error["stdout"] : "";
  const stderr = typeof error["stderr"] === "string" ? error["stderr"] : "";
  return `${stdout}${stderr}`;
}

function npxErrorMessage(error: unknown): string {
  const output = npxOutput(error).replace(ANSI_RE, "");
  return output === "" ? errorMessage(error) : output;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error);
  if (typeof error === "symbol") return error.toString();
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  return Object.prototype.toString.call(error);
}

function isSkillMarkdownPath(path: string): boolean {
  return /(?:^|[\\/])SKILL\.md$/iu.test(path);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
