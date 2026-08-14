#!/usr/bin/env node
import { DEFAULT_PORT, effectivePiWebUiConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";
import { createFilePiWebUiConfigService } from "./configRoutes.js";

// Freeze the startup environment once so the web config service and the
// session daemon derive identical config and lock database paths from the
// same pinned snapshot; later process.env changes cannot move them.
const webEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const { config } = effectivePiWebUiConfig({ env: webEnvironment });
const app = await buildApp({
  bodyLimit: maxUploadBytes(webEnvironment, config),
  config: createFilePiWebUiConfigService({ env: webEnvironment }),
});
await app.listen({ port: config.port ?? DEFAULT_PORT, host: config.host ?? "127.0.0.1" });
