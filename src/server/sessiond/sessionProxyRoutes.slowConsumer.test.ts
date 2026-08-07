import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket, WebSocketServer } from "ws";
import { registerSessionProxyRoutes } from "./sessionProxyRoutes";

/**
 * Production SlowConsumerGuard defaults (src/server/realtime/slowConsumerGuard.ts):
 * a socket whose bufferedAmount stays above the 4 MiB soft limit without
 * draining for 5 s is terminated. This suite uses real ws sockets over local
 * WebSocketServer instances so bufferedAmount reflects genuine backpressure.
 * The flood is bounded so a regression cannot hang the suite, and GREEN keeps
 * comfortable slack over the 5 s stall window.
 */
const FLOOD_FRAME_BYTES = 64 * 1024;
const FLOOD_FRAMES = 512; // ~32 MiB backlog: far beyond the 4 MiB soft limit plus TCP buffers.
const PACE_MS = 100; // keeps the bridge sending so guard.afterSend() re-evaluates through the stall window.
const STALL_WINDOW_MS = 5_000;
const FLOOD_BOUND_MS = STALL_WINDOW_MS * 2 + 2_000; // bounds RED, leaves GREEN ~6 s of slack.

let app: FastifyInstance;
let daemon: FloodingSessionDaemon;
let browserClient: WebSocket | undefined;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  daemon = await FloodingSessionDaemon.create();
  registerSessionProxyRoutes(app, daemon);
});

afterEach(async () => {
  browserClient?.terminate();
  browserClient = undefined;
  await app.close();
  await daemon.close();
});

describe("sessiond websocket bridge slow-consumer backpressure", () => {
  it("terminates a browser consumer that stops reading and releases the upstream bridge", async () => {
    // The browser-facing socket is the one the guard terminates; capture it so
    // termination can be asserted. The paused browser itself cannot observe the
    // close: its paused stream never reads the FIN/RST off the wire.
    let bridgeCloseCode: number | undefined;
    app.websocketServer.on("connection", (socket) => {
      socket.once("close", (code) => { bridgeCloseCode = code; });
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    browserClient = new WebSocket(`${serverUrl(app)}/api/events`);
    await waitForOpen(browserClient);
    const upstreamSocket = await daemon.waitForConnection();

    // A terminated connection surfaces as an 'error' (ECONNRESET) before the
    // 'close' event; absorb it so it is not an unhandled error.
    browserClient.on("error", (error) => { void error; });

    // The browser tab stops consuming: pausing the client's underlying TCP
    // stream fills its kernel receive buffer, so the server-side send queue
    // stops draining. The /events bridge is the measured incident path (the
    // 125.9 MB browser queue was on a sessiond /events bridge here).
    browserClient.pause();

    const floodPayload = Buffer.alloc(FLOOD_FRAME_BYTES, 0x61);

    // Phase 1: build a multi-megabyte backlog quickly.
    for (let i = 0; i < FLOOD_FRAMES; i += 1) {
      if (upstreamSocket.readyState !== WebSocket.OPEN) break;
      upstreamSocket.send(floodPayload);
    }

    // Phase 2: keep flooding on a pace so the guard re-evaluates through the
    // stall window, until it terminates the browser-facing socket (or the
    // bound expires on a regression).
    const deadline = Date.now() + FLOOD_BOUND_MS;
    while (bridgeCloseCode === undefined && Date.now() < deadline) {
      if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(floodPayload);
      await sleep(PACE_MS);
    }

    if (bridgeCloseCode === undefined) {
      throw new Error(`browser-facing bridge socket was not terminated within ${String(FLOOD_BOUND_MS)} ms`);
    }
    expect(bridgeCloseCode).toBe(1006); // terminated abruptly, not cleanly closed
    await waitForClosed(upstreamSocket, 2_000);
  }, 20_000);
});

interface FakeDaemonResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

class FloodingSessionDaemon {
  readonly websocketPaths: string[] = [];
  private readonly upstream: WebSocketServer;
  private readonly acceptedSockets = new Set<WebSocket>();
  private readonly daemonClients = new Set<WebSocket>();
  private readonly connectionWaiters: ((socket: WebSocket) => void)[] = [];

  private constructor(upstream: WebSocketServer) {
    this.upstream = upstream;
    this.upstream.on("connection", (socket) => {
      this.acceptedSockets.add(socket);
      socket.on("close", () => { this.acceptedSockets.delete(socket); });
      const waiter = this.connectionWaiters.shift();
      if (waiter !== undefined) waiter(socket);
    });
  }

  static async create(): Promise<FloodingSessionDaemon> {
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitForListening(upstream);
    return new FloodingSessionDaemon(upstream);
  }

  connectWebSocket(path: string): WebSocket {
    this.websocketPaths.push(path);
    const client = new WebSocket(`${webSocketServerUrl(this.upstream)}${path}`);
    this.daemonClients.add(client);
    client.on("close", () => { this.daemonClients.delete(client); });
    return client;
  }

  request(method: string, path: string, body?: unknown): Promise<FakeDaemonResponse> {
    // This fake only serves the websocket bridge; an HTTP proxy request means
    // the test is exercising something outside this suite's scope.
    throw new Error(`unexpected HTTP request to ${method} ${path}: ${JSON.stringify(body)}`);
  }

  waitForConnection(): Promise<WebSocket> {
    for (const socket of this.acceptedSockets) return Promise.resolve(socket);
    return new Promise((resolve) => { this.connectionWaiters.push(resolve); });
  }

  async close(): Promise<void> {
    for (const socket of this.acceptedSockets) socket.terminate();
    for (const client of this.daemonClients) client.terminate();
    await closeWebSocketServer(this.upstream);
  }
}

function serverUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function webSocketServerUrl(server: WebSocketServer): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function waitForListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    server.once("listening", () => { resolve(); });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => { resolve(); });
    socket.once("error", reject);
    socket.once("close", () => { reject(new Error("WebSocket closed before opening")); });
  });
}

function waitForClosed(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("socket did not close within the timeout"));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.once("close", onClose);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
