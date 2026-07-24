#!/usr/bin/env node
import { DEFAULT_PORT, effectivePiWebUiConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";

const { config } = effectivePiWebUiConfig();
const app = await buildApp({ bodyLimit: maxUploadBytes(process.env, config) });
await app.listen({ port: config.port ?? DEFAULT_PORT, host: config.host ?? "127.0.0.1" });
