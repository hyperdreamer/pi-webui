#!/usr/bin/env node
import { DEFAULT_PORT, effectivePiWebUiConfig, maxUploadBytes } from "../config.js";
import { buildApp, createGatewayConfigComposition } from "./app.js";

// Freeze the startup environment once so the web config service and the
// session daemon derive identical config and lock database paths from the
// same pinned snapshot; later process.env changes cannot move them.
const webEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const { config } = effectivePiWebUiConfig({ env: webEnvironment });
// Exactly one shared mutation authority: the generic config service and the
// speech settings service (via AppDependencies) both coordinate through the
// same lazily created instance.
const { coordinator, config: configService } = createGatewayConfigComposition(webEnvironment);
const app = await buildApp({
  bodyLimit: maxUploadBytes(webEnvironment, config),
  config: configService,
  configMutationCoordinator: coordinator,
});
await app.listen({ port: config.port ?? DEFAULT_PORT, host: config.host ?? "127.0.0.1" });
