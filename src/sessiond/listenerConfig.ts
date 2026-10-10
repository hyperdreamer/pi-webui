import { parsePort } from "../config.js";
import type { PiWebUiSessiondConfig, PiWebUiSessiondListenerDescriptor } from "../shared/apiTypes.js";

/**
 * Resolve the session daemon listener from the raw loaded file subtree plus the
 * environment, so an identical value from either source stays distinguishable.
 * Pure: performs no I/O and never reads sessiond.url.
 */
export function sessiondListenerConfig(
  subtree: PiWebUiSessiondConfig | undefined,
  env: NodeJS.ProcessEnv,
): PiWebUiSessiondListenerDescriptor {
  const envPortText = env["PI_WEBUI_SESSIOND_PORT"]?.trim();
  const envPort = envPortText !== undefined && envPortText !== "" ? parsePort(envPortText, "PI_WEBUI_SESSIOND_PORT") : undefined;
  const port = envPort ?? subtree?.port;
  if (port === undefined) return { kind: "socket" };
  const portSource = envPort !== undefined ? "env" : "config";
  const envHost = env["PI_WEBUI_SESSIOND_HOST"]?.trim();
  const host = envHost !== undefined && envHost !== "" ? envHost : subtree?.host ?? "127.0.0.1";
  const hostSource = envHost !== undefined && envHost !== ""
    ? "env"
    : subtree?.host !== undefined ? "config" : "default";
  return { kind: "tcp", host, port, hostSource, portSource };
}

/**
 * Map a resolved listener to Fastify listen options. The wire descriptor's
 * socket branch is path-free, so the caller supplies the real socket path; the
 * TCP branch ignores it.
 */
export function sessiondListenOptions(
  listener: PiWebUiSessiondListenerDescriptor,
  socketPath: string,
): { port: number; host: string } | { path: string } {
  return listener.kind === "tcp" ? { port: listener.port, host: listener.host } : { path: socketPath };
}
