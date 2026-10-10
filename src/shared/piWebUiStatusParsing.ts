import type { PiWebUiComponentStatus, PiWebUiInstallationInfo, PiWebUiRuntimeComponent, PiWebUiRuntimeResponse, PiWebUiSessiondListenerDescriptor, PiWebUiVersionResponse } from "./apiTypes.js";
import { parseActiveAgentProfileDescriptor } from "./activeAgentProfile.js";
import { parseKnownPiWebUiCapabilities } from "./capabilities.js";

export function parsePiWebUiVersionResponse(value: unknown): PiWebUiVersionResponse | undefined {
  if (!isRecord(value)) return undefined;
  const packageName = value["packageName"];
  const generatedAt = value["generatedAt"];
  const components = value["components"];
  if (typeof packageName !== "string" || packageName === "" || typeof generatedAt !== "string" || generatedAt === "" || !isRecord(components)) return undefined;
  const web = parsePiWebUiComponentStatus(components["web"]);
  const sessiond = parsePiWebUiComponentStatus(components["sessiond"]);
  if (web === undefined || sessiond === undefined) return undefined;
  return { packageName, generatedAt, components: { web, sessiond } };
}

export function parsePiWebUiRuntimeResponse(value: unknown): PiWebUiRuntimeResponse | undefined {
  if (!isRecord(value)) return undefined;
  const packageName = value["packageName"];
  const generatedAt = value["generatedAt"];
  const components = value["components"];
  const capabilities = parseKnownPiWebUiCapabilities(value["capabilities"]);
  if (typeof packageName !== "string" || packageName === "" || typeof generatedAt !== "string" || generatedAt === "" || !isRecord(components) || capabilities === undefined) return undefined;
  const web = parsePiWebUiRuntimeComponent(components["web"]);
  const sessiond = parsePiWebUiRuntimeComponent(components["sessiond"]);
  if (web === undefined || sessiond === undefined) return undefined;
  return { packageName, generatedAt, components: { web, sessiond }, capabilities };
}

export function parsePiWebUiSessiondListenerDescriptor(value: unknown): PiWebUiSessiondListenerDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  if (kind === "socket") {
    if (Object.keys(value).some((key) => key !== "kind")) return undefined;
    return Object.freeze({ kind: "socket" });
  }
  if (kind !== "tcp") return undefined;
  if (Object.keys(value).some((key) => key !== "kind" && key !== "host" && key !== "port" && key !== "hostSource" && key !== "portSource")) return undefined;
  const host = value["host"];
  const port = value["port"];
  const hostSource = value["hostSource"];
  const portSource = value["portSource"];
  if (typeof host !== "string" || host === "") return undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (hostSource !== "env" && hostSource !== "config" && hostSource !== "default") return undefined;
  if (portSource !== "env" && portSource !== "config") return undefined;
  return Object.freeze({ kind: "tcp", host, port, hostSource, portSource });
}

export function parsePiWebUiRuntimeComponent(value: unknown): PiWebUiRuntimeComponent | undefined {
  if (!isRecord(value)) return undefined;
  const component = value["component"];
  const label = value["label"];
  const runtimeVersion = value["runtimeVersion"];
  const available = value["available"];
  const capabilities = parseKnownPiWebUiCapabilities(value["capabilities"]);
  const activeAgentProfileValue = value["activeAgentProfile"];
  const activeAgentProfile = activeAgentProfileValue === undefined ? undefined : parseActiveAgentProfileDescriptor(activeAgentProfileValue);
  const sessiondListenerValue = value["sessiondListener"];
  const sessiondListener = sessiondListenerValue === undefined ? undefined : parsePiWebUiSessiondListenerDescriptor(sessiondListenerValue);
  const error = value["error"];
  if (component !== "web" && component !== "sessiond") return undefined;
  if (typeof label !== "string" || label === "" || typeof available !== "boolean" || capabilities === undefined) return undefined;
  if (activeAgentProfileValue !== undefined && (component !== "sessiond" || activeAgentProfile === undefined)) return undefined;
  if (sessiondListenerValue !== undefined && (component !== "sessiond" || sessiondListener === undefined)) return undefined;
  return {
    component,
    label,
    ...(typeof runtimeVersion === "string" ? { runtimeVersion } : {}),
    available,
    capabilities,
    ...(activeAgentProfile === undefined ? {} : { activeAgentProfile }),
    ...(sessiondListener === undefined ? {} : { sessiondListener }),
    ...(typeof error === "string" ? { error } : {}),
  };
}

export function parsePiWebUiComponentStatus(value: unknown): PiWebUiComponentStatus | undefined {
  if (!isRecord(value)) return undefined;
  const component = value["component"];
  const label = value["label"];
  const runtimeVersion = value["runtimeVersion"];
  const installedVersion = value["installedVersion"];
  const stale = value["stale"];
  const available = value["available"];
  const error = value["error"];
  const installation = parsePiWebUiInstallationInfo(value["installation"]);
  if (component !== "web" && component !== "sessiond") return undefined;
  if (typeof label !== "string" || label === "" || typeof stale !== "boolean" || typeof available !== "boolean") return undefined;
  return {
    component,
    label,
    ...(typeof runtimeVersion === "string" ? { runtimeVersion } : {}),
    ...(typeof installedVersion === "string" ? { installedVersion } : {}),
    stale,
    available,
    ...(installation === undefined ? {} : { installation }),
    ...(typeof error === "string" ? { error } : {}),
  };
}

export function parsePiWebUiInstallationInfo(value: unknown): PiWebUiInstallationInfo | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  const path = value["path"];
  const source = value["source"];
  const scope = value["scope"];
  const npmRoot = value["npmRoot"];
  const dockerMode = value["dockerMode"];
  if (kind !== "pi-package" && kind !== "npm-global" && kind !== "local" && kind !== "docker" && kind !== "unknown") return undefined;
  return {
    kind,
    ...(typeof path === "string" ? { path } : {}),
    ...(typeof source === "string" ? { source } : {}),
    ...(scope === "user" || scope === "project" ? { scope } : {}),
    ...(typeof npmRoot === "string" ? { npmRoot } : {}),
    ...(dockerMode === "runtime" || dockerMode === "dev" ? { dockerMode } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
