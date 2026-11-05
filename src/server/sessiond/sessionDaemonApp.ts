import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { sessionRouteFastifyOptions } from "../sessions/sessionRouteFastifyOptions.js";
import { registerBrowserOriginGuard } from "../http/browserOriginGuard.js";

export interface SessionDaemonAppOptions {
  allowedOrigins?: readonly string[];
  logger?: FastifyServerOptions["logger"];
  bodyLimit?: number;
}

/**
 * The session daemon's own HTTP edge. It is constructed independently of the
 * gateway so the long-lived daemon copies its startup browser-origin trust
 * exactly once and never inherits the gateway's runtime state.
 */
export async function createSessionDaemonApp(options: SessionDaemonAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    ...sessionRouteFastifyOptions,
    ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
  });
  // The installed WebSocket plugin must observe the upgrade before the guard
  // replies: its onResponse hook destroys a rejected upgrade's raw socket, so
  // registering the guard first would leak one held connection per denial. The
  // guard still rejects in onRequest, before any route handler, bridge, or
  // runtime attachment.
  await app.register(fastifyWebsocket);
  registerBrowserOriginGuard(app, options.allowedOrigins);
  return app;
}
