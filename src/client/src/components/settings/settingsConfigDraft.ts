import type { PiWebUiConfigValues } from "../../api";

export interface GatewayServerConfigDraft {
  host: string;
  port: string;
  allowedHostsMode: "list" | "all";
  allowedHostsText: string;
}

export interface MachineAccessConfigDraft {
  allowedPathsText: string;
  uploadDefaultFolder: string;
}

export interface AgentProfileConfigDraft {
  command: string;
  dir: string;
}

export interface HostSpeechConfigDraft {
  voice: string;
  rate: string;
}

export function emptyGatewayServerConfigDraft(): GatewayServerConfigDraft {
  return { host: "", port: "", allowedHostsMode: "list", allowedHostsText: "" };
}

export function emptyMachineAccessConfigDraft(): MachineAccessConfigDraft {
  return { allowedPathsText: "", uploadDefaultFolder: "" };
}

export function emptyAgentProfileConfigDraft(): AgentProfileConfigDraft {
  return { command: "", dir: "" };
}

export function emptyHostSpeechConfigDraft(): HostSpeechConfigDraft {
  return { voice: "", rate: "" };
}

export function gatewayServerDraftFromConfig(config: PiWebUiConfigValues): GatewayServerConfigDraft {
  return {
    host: config.host ?? "",
    port: config.port === undefined ? "" : String(config.port),
    allowedHostsMode: config.allowedHosts === true ? "all" : "list",
    allowedHostsText: Array.isArray(config.allowedHosts) ? config.allowedHosts.join("\n") : "",
  };
}

export function machineAccessDraftFromConfig(config: PiWebUiConfigValues): MachineAccessConfigDraft {
  return {
    allowedPathsText: config.pathAccess?.allowedPaths?.join("\n") ?? "",
    uploadDefaultFolder: config.uploads?.defaultFolder ?? "",
  };
}

export function agentProfileDraftFromConfig(config: PiWebUiConfigValues): AgentProfileConfigDraft {
  return {
    command: config.agent?.command ?? "",
    dir: config.agent?.dir ?? "",
  };
}

export function hostSpeechDraftFromConfig(config: PiWebUiConfigValues): HostSpeechConfigDraft {
  return {
    voice: config.tts?.voice ?? "",
    rate: config.tts?.rate === undefined ? "" : String(config.tts.rate),
  };
}

export function agentProfileConfigPatchFromDraft(draft: AgentProfileConfigDraft): PiWebUiConfigValues {
  const command = draft.command.trim();
  const dir = draft.dir.trim();
  return {
    agent: {
      ...(command === "" ? {} : { command }),
      ...(dir === "" ? {} : { dir }),
    },
  };
}

export function agentProfileDraftMatchesConfig(draft: AgentProfileConfigDraft, config: PiWebUiConfigValues): boolean {
  const normalizedDraft = agentProfileConfigPatchFromDraft(draft).agent ?? {};
  const configured = config.agent ?? {};
  return normalizedDraft.command === configured.command && normalizedDraft.dir === configured.dir;
}

export function hostSpeechConfigFromDraft(draft: HostSpeechConfigDraft, baseConfig: PiWebUiConfigValues = {}): PiWebUiConfigValues {
  const voice = draft.voice.trim();
  const rate = parseHostSpeechRate(draft.rate);
  return {
    ...baseConfig,
    tts: {
      ...(voice === "" ? {} : { voice }),
      ...(rate === 0 ? {} : { rate }),
    },
  };
}

export function hostSpeechDraftMatchesConfig(draft: HostSpeechConfigDraft, config: PiWebUiConfigValues): boolean {
  try {
    const normalizedDraft = hostSpeechConfigFromDraft(draft).tts ?? {};
    const configured = config.tts ?? {};
    return normalizedDraft.voice === configured.voice
      && (normalizedDraft.rate ?? 0) === (configured.rate ?? 0);
  } catch {
    return false;
  }
}

export function gatewayServerConfigFromDraft(draft: GatewayServerConfigDraft, baseConfig: PiWebUiConfigValues = {}): PiWebUiConfigValues {
  const config = preservedGatewayConfigRemainder(baseConfig);
  const host = draft.host.trim();
  const port = draft.port.trim();
  if (host !== "") config.host = host;
  if (port !== "") {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("Port must be an integer from 1 to 65535.");
    config.port = parsed;
  }
  config.allowedHosts = draft.allowedHostsMode === "all" ? true : parseAllowedHostsText(draft.allowedHostsText);
  return config;
}

export function machineAccessConfigPatchFromDraft(draft: MachineAccessConfigDraft): PiWebUiConfigValues {
  const allowedPaths = parseAllowedPathsText(draft.allowedPathsText);
  const uploadDefaultFolder = normalizeWorkspaceRelativeFolder(draft.uploadDefaultFolder);
  return {
    pathAccess: { allowedPaths },
    uploads: uploadDefaultFolder === "" ? {} : { defaultFolder: uploadDefaultFolder },
  };
}

function preservedGatewayConfigRemainder(baseConfig: PiWebUiConfigValues): PiWebUiConfigValues {
  return {
    ...(baseConfig.shortcuts === undefined ? {} : { shortcuts: baseConfig.shortcuts }),
    ...(baseConfig.plugins === undefined ? {} : { plugins: baseConfig.plugins }),
    ...(baseConfig.pathAccess === undefined ? {} : { pathAccess: baseConfig.pathAccess }),
    ...(baseConfig.uploads === undefined ? {} : { uploads: baseConfig.uploads }),
    ...(baseConfig.maxUploadBytes === undefined ? {} : { maxUploadBytes: baseConfig.maxUploadBytes }),
    ...(baseConfig.spawnSessions === undefined ? {} : { spawnSessions: baseConfig.spawnSessions }),
    ...(baseConfig.subsessions === undefined ? {} : { subsessions: baseConfig.subsessions }),
    ...(baseConfig.agent === undefined ? {} : { agent: baseConfig.agent }),
    ...(baseConfig.tts === undefined ? {} : { tts: baseConfig.tts }),
  };
}

function parseAllowedHostsText(value: string): string[] {
  return value.split(/[\n,]/u).map((host) => host.trim()).filter((host) => host !== "");
}

function parseHostSpeechRate(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const rate = Number(trimmed);
  if (!Number.isInteger(rate) || rate < -100 || rate > 100) {
    throw new Error("Speech rate must be an integer from -100 to 100.");
  }
  return rate;
}

function parseAllowedPathsText(value: string): string[] {
  const paths = value.split("\n").map((path) => path.trim()).filter((path) => path !== "");
  const invalid = paths.find((path) => !isAbsoluteishAllowedPath(path));
  if (invalid !== undefined) throw new Error(`Allowed external paths must be absolute paths or start with ~: ${invalid}`);
  return paths;
}

function normalizeWorkspaceRelativeFolder(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (isAbsoluteLike(trimmed)) throw new Error("Upload default folder must be workspace-relative.");
  const parts = trimmed.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return "";
  if (parts.some((part) => part === "..")) throw new Error("Upload default folder must not contain path traversal.");
  return parts.join("/");
}

function isAbsoluteishAllowedPath(path: string): boolean {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(path);
}

function isAbsoluteLike(value: string): boolean {
  const withForwardSlashes = value.replace(/\\/g, "/");
  return withForwardSlashes.startsWith("/") || /^[A-Za-z]:\//u.test(withForwardSlashes);
}
