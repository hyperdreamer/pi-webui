import { join } from "node:path";
import { piWebUiDataDir } from "../config.js";

export function sessiondSocketPath(): string {
  return process.env["PI_WEBUI_SESSIOND_SOCKET"] ?? join(piWebUiDataDir(), "sessiond.sock");
}

export function sessiondHttpUrl(): string | undefined {
  return process.env["PI_WEBUI_SESSIOND_URL"];
}
