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
  registerBrowserOriginGuard(app, options.allowedOrigins);
  await app.register(fastifyWebsocket);
  return app;
}
