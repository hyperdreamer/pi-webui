import { join } from "node:path";
import { loadPiWebUiConfig, piWebUiDataDir, resolveEffectivePiWebUiConfig, type LoadOptions } from "../config.js";

export function sessiondSocketPath(): string {
  return process.env["PI_WEBUI_SESSIOND_SOCKET"] ?? join(piWebUiDataDir(), "sessiond.sock");
}

/**
 * Resolve the web/API dial target from the effective config. This is the only
 * place URL-form validation runs, so an invalid value stops the web/API and
 * never the session daemon.
 */
export function sessiondHttpUrl(options: LoadOptions = {}): string | undefined {
  const loaded = loadPiWebUiConfig(options);
  const value = resolveEffectivePiWebUiConfig(loaded, options).config.sessiond?.url;
  return value === undefined ? undefined : validateSessiondHttpUrl(value, loaded.path);
}

function validateSessiondHttpUrl(value: string, configPath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw new Error(`PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}`);
  }
  if (url.username !== "" || url.password !== "") throw new Error(`PI WEBUI config sessiond.url must not contain credentials: ${configPath}`);
  if (url.search !== "") throw new Error(`PI WEBUI config sessiond.url must not contain a query string: ${configPath}`);
  if (url.hash !== "") throw new Error(`PI WEBUI config sessiond.url must not contain a fragment: ${configPath}`);
  if (url.pathname !== "/") throw new Error(`PI WEBUI config sessiond.url must not contain a path: ${configPath}`);
  return value;
}
