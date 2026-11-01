import type { FastifyInstance, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import type { Machine, PiWebUiAgentConfig } from "../../shared/apiTypes.js";
import { FEDERATED_HTTP_ROUTES, FEDERATED_WEBSOCKET_ROUTES, isWorkspaceTasksFederatedHttpRoute, type FederatedHttpRouteSpec } from "../../shared/federatedRoutes.js";
import { parsePiWebUiConfigResponseBody, parseSelectedMachineConfigRequest, selectedMachineConfigResponse } from "../configRoutes.js";
import { createReplyDisconnectScope } from "../http/replyDisconnect.js";
import { bridgeSockets } from "../webSocketBridge.js";
import { RemoteMachineRequestError, type MachineClient, type MachineJsonResponse, type MachineRequestOptions } from "./machineClient.js";
import { MachineService } from "./machineService.js";

export const REMOTE_HTTP_ROUTES = FEDERATED_HTTP_ROUTES.filter((spec) => !isWorkspaceTasksFederatedHttpRoute(spec));
export const REMOTE_WEBSOCKET_ROUTES = FEDERATED_WEBSOCKET_ROUTES;

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "cache-control",
  "last-modified",
  "etag",
  "content-security-policy",
  "x-content-type-options",
]);

export function registerMachineProxyRoutes(app: FastifyInstance, machines = new MachineService()): void {
  for (const spec of REMOTE_HTTP_ROUTES) {
    app.route<{ Params: { machineId: string }; Body: unknown }>({
      method: spec.method,
      url: `/api/machines/:machineId${spec.path}`,
      handler: (request, reply) => proxyMachineHttpRequest(machines, spec, request.params.machineId, request.method, request.url, request.body, request.headers["content-type"], reply),
    });
  }

  for (const path of REMOTE_WEBSOCKET_ROUTES) {
    app.get<{ Params: { machineId: string } }>(`/api/machines/:machineId${path}`, { websocket: true }, async (socket, request) => {
      await proxyWebSocket(machines, request.params.machineId, request.url, socket);
    });
  }
}

export async function proxyMachineHttpRequest(machines: MachineService, spec: FederatedHttpRouteSpec, machineId: string, method: string, requestUrl: string, body: unknown, contentType: string | string[] | undefined, reply: FastifyReply): Promise<FastifyReply> {
  if (machineId === "local") {
    return reply.code(501).send({ error: "Local machine route is not registered for this endpoint" });
  }

  // GET is the cancellable-read class at this boundary: a dropped browser owns the
  // remote read it started. Mutations keep their independent gateway deadline and are
  // never cancelled by a browser disconnect.
  const disconnect = method === "GET" ? createReplyDisconnectScope(reply) : undefined;
  const signal = disconnect?.signal;
  const lookup = { failed: false };
  try {
    let machine: Machine | undefined;
    let client: MachineClient | undefined;
    try {
      machine = await machines.get(machineId);
      if (isDisconnected(signal, reply)) return await reply;
      if (machine !== undefined) client = await machines.remoteClient(machineId);
    } catch (error) {
      // Preserve Fastify's original handling of registry/lookup failures, while still
      // suppressing work that raced with a disconnected reply.
      if (isDisconnected(signal, reply)) return await reply;
      lookup.failed = true;
      throw error;
    }
    if (isDisconnected(signal, reply)) return await reply;
    if (machine === undefined || client === undefined) return await reply.code(404).send({ error: "Machine not found" });

    const remotePath = remoteApiPath(machineId, requestUrl);
    if (spec.path === "/config") {
      return await proxySelectedMachineConfigRequest(client, machineId, method, body, reply, routeRequestOptions(spec, machine, undefined, undefined), signal);
    }

    const requestOptions = withSignal(routeRequestOptions(spec, machine, body, contentType), signal);
    const upstream = requestOptions === undefined
      ? await client.request(method, remotePath, body)
      : await client.request(method, remotePath, body, requestOptions);
    if (isDisconnected(signal, reply)) return await reply;

    reply.code(upstream.statusCode);
    applySafeHeaders(reply, upstream.headers);
    if (upstream.body === undefined) return await reply.send();
    return await sendStreamedReply(reply, upstream.body);
  } catch (error) {
    if (lookup.failed) throw error;
    if (isDisconnected(signal, reply)) return await reply;
    if (isSelectedMachineConfigRequestError(error)) return await reply.code(400).send({ error: errorMessage(error) });
    return await sendGatewayError(reply, machineId, error);
  } finally {
    // The reply owns cleanup on normal finish/close; this releases the terminal
    // paths that leave neither a stream nor a pending body behind.
    disconnect?.dispose();
  }
}

/**
 * Arms one eager header flush on the raw response's `pipe` event, which Fastify emits
 * after copying the final (compression-adjusted) headers and before the first body
 * byte. A send that fails before piping leaves no armed listener and still takes the
 * ordinary gateway error path; a failure after the flush destroys the response
 * instead of writing a second status or body.
 */
async function sendStreamedReply(reply: FastifyReply, body: NodeJS.ReadableStream): Promise<FastifyReply> {
  const state = { flushed: false };
  const flush = (): void => {
    if (state.flushed) return;
    state.flushed = true;
    if (reply.raw.destroyed || reply.raw.headersSent) return;
    reply.raw.flushHeaders();
  };
  const release = (): void => {
    reply.raw.removeListener("pipe", flush);
    reply.raw.removeListener("finish", release);
    reply.raw.removeListener("close", release);
  };
  reply.raw.once("pipe", flush);
  reply.raw.once("finish", release);
  reply.raw.once("close", release);
  try {
    return await reply.send(body);
  } catch (error) {
    release();
    if (state.flushed) reply.raw.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    release();
  }
}

function isDisconnected(signal: AbortSignal | undefined, reply: FastifyReply): boolean {
  return signal?.aborted === true || reply.raw.destroyed;
}

async function proxySelectedMachineConfigRequest(client: MachineClient, machineId: string, method: string, body: unknown, reply: FastifyReply, baseOptions: MachineRequestOptions | undefined, signal: AbortSignal | undefined): Promise<FastifyReply> {
  if (method === "GET") {
    const readOptions = withSignal(baseOptions, signal);
    const read = readOptions === undefined
      ? await client.requestJson("GET", "/api/machines/local/config")
      : await client.requestJson("GET", "/api/machines/local/config", undefined, readOptions);
    return await sendSelectedMachineConfigResponse(reply, read, machineId);
  }

  if (method === "PUT") {
    // The target gateway's coordinator performs the merge under its own lock;
    // this gateway only validates the portable patch and forwards it once.
    const patch = parseSelectedMachineConfigRequest(configPayload(body), "portable");
    const update = baseOptions === undefined
      ? await client.requestJson("PUT", "/api/machines/local/config", { config: patch })
      : await client.requestJson("PUT", "/api/machines/local/config", { config: patch }, baseOptions);
    return await sendSelectedMachineConfigResponse(reply, update, machineId, patch.agent);
  }

  return await reply.code(405).send({ error: "Method not allowed" });
}

function configPayload(body: unknown): unknown {
  return isRecord(body) ? body["config"] : undefined;
}

function sendSelectedMachineConfigResponse(reply: FastifyReply, upstream: MachineJsonResponse, machineId: string, expectedAgentProfile?: PiWebUiAgentConfig): FastifyReply {
  if (!isSuccessfulStatus(upstream.statusCode)) return sendUpstreamJsonResponse(reply, upstream, machineId);
  const response = parsePiWebUiConfigResponseBody(upstream.body, "Remote machine config response");
  if (expectedAgentProfile !== undefined && !sameAgentProfile(response.config.agent, expectedAgentProfile)) {
    return reply.code(409).send({
      error: "Remote machine did not persist the requested agent profile",
      machineId,
      detail: "Update and restart PI WEBUI on the remote machine before changing its agent profile.",
    });
  }
  reply.code(upstream.statusCode);
  applySafeHeaders(reply, upstream.headers);
  return reply.send(selectedMachineConfigResponse(response));
}

function sameAgentProfile(actual: PiWebUiAgentConfig | undefined, expected: PiWebUiAgentConfig): boolean {
  return actual !== undefined && actual.command === expected.command && actual.dir === expected.dir;
}

function sendUpstreamJsonResponse(reply: FastifyReply, upstream: MachineJsonResponse, machineId: string): FastifyReply {
  reply.code(upstream.statusCode);
  applySafeHeaders(reply, upstream.headers);
  return reply.send(upstream.body ?? { error: "Remote machine config request failed", machineId, statusCode: upstream.statusCode });
}

function isSuccessfulStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

async function proxyWebSocket(machines: MachineService, machineId: string, requestUrl: string, socket: WebSocket): Promise<void> {
  if (machineId === "local") {
    socket.close(1011, "Local machine route is not registered for this endpoint");
    return;
  }

  const client = await machines.remoteClient(machineId);
  if (client === undefined) {
    socket.close(1008, "Machine not found");
    return;
  }

  try {
    bridgeSockets(socket, client.connectWebSocket(remoteApiPath(machineId, requestUrl)));
  } catch {
    socket.close(1011, "Remote machine unavailable");
  }
}

function remoteApiPath(machineId: string, requestUrl: string): string {
  const machinePrefix = `/api/machines/${encodeURIComponent(machineId)}`;
  const stripped = requestUrl.startsWith(machinePrefix) ? requestUrl.slice(machinePrefix.length) : requestUrl;
  const compatPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
  return `/api${compatPath}`;
}

function routeRequestOptions(spec: Pick<FederatedHttpRouteSpec, "timeoutMs">, machine: Pick<Machine, "requestTimeoutMs">, body: unknown, contentType: string | string[] | undefined): MachineRequestOptions | undefined {
  const options: MachineRequestOptions = {};
  // An override wins; otherwise the stored machine value, and never the default, so an
  // absent stored value still resolves in the client.
  const timeoutMs = spec.timeoutMs ?? machine.requestTimeoutMs;
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  if (isRawProxyBody(body)) {
    const value = firstHeaderValue(contentType);
    if (value !== undefined && value !== "") options.contentType = value;
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function withSignal(options: MachineRequestOptions | undefined, signal: AbortSignal | undefined): MachineRequestOptions | undefined {
  if (signal === undefined) return options;
  return { ...options, signal };
}

function isRawProxyBody(body: unknown): boolean {
  return typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function applySafeHeaders(reply: FastifyReply, headers: Record<string, string | string[] | undefined>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (!SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    reply.header(name, value);
  }
}

function isSelectedMachineConfigRequestError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("PI WEBUI selected-machine config");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendGatewayError(reply: FastifyReply, machineId: string, error: unknown): FastifyReply {
  const statusCode = error instanceof RemoteMachineRequestError ? error.statusCode : 502;
  const label = statusCode === 504 ? "Remote machine timeout" : "Remote machine unavailable";
  return reply.code(statusCode).send({
    error: label,
    machineId,
    statusCode,
    detail: errorMessage(error),
  });
}
