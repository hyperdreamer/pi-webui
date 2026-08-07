import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { bridgeSockets, createBufferedSender } from "./webSocketBridge.js";
import { SLOW_CONSUMER_SOFT_LIMIT_BYTES } from "./realtime/slowConsumerGuard.js";

const servers = new Set<WebSocketServer>();
const sockets = new Set<WebSocket>();

afterEach(async () => {
  for (const socket of sockets) closeSocket(socket);
  await Promise.all(Array.from(servers, closeSocketServer));
  sockets.clear();
  servers.clear();
});

describe("bridgeSockets", () => {
  it("forwards messages in both directions while sockets are open", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    bridgeSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);

    const forwardedToUpstream = nextMessage(upstreamSide.peerSocket);
    clientSide.peerSocket.send("to-upstream");
    await expect(forwardedToUpstream).resolves.toBe("to-upstream");

    const forwardedToClient = nextMessage(clientSide.peerSocket);
    upstreamSide.peerSocket.send("to-client");
    await expect(forwardedToClient).resolves.toBe("to-client");
  });

  it("terminates a browser-facing socket whose consumer stalls while deep and closes the upstream", { timeout: 30_000 }, async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    bridgeSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);

    // The production guard's stall window is 5 s; the flood deadline bounds
    // this test well beyond it, leaving slack for kernel and ws buffering.
    const floodDeadline = Date.now() + 15_000;

    // Pause the browser-facing peer's TCP reads (ws.pause() delegates to the
    // underlying socket) so the bridge's send buffer can never drain: the
    // kernel receive window closes and bufferedAmount grows past the soft
    // limit while the consumer stays stalled.
    clientSide.peerSocket.pause();

    const bridgeCloseCode = nextCloseCode(clientSide.bridgeSocket);
    const upstreamClosed = nextClose(upstreamSide.peerSocket);

    const frame = Buffer.alloc(64 * 1024);
    let sent = 0;
    let terminated = false;
    while (Date.now() < floodDeadline && !terminated) {
      upstreamSide.peerSocket.send(frame);
      sent += 1;
      // Yield periodically so the event loop can pump the flood through the
      // bridge. Once the depth passes the soft limit, a trickle is enough to
      // keep the guard's stall clock ticking because the paused consumer
      // cannot drain anything.
      if (sent % 64 === 0) {
        const deep = clientSide.bridgeSocket.bufferedAmount > SLOW_CONSUMER_SOFT_LIMIT_BYTES;
        await new Promise((resolve) => { setTimeout(resolve, deep ? 100 : 1); });
      }
      terminated = clientSide.bridgeSocket.readyState !== WebSocket.OPEN;
    }

    // Termination must beat the deadline: expiry means the guard never fired.
    expect(terminated, "browser-facing bridge socket was not terminated within the flood deadline").toBe(true);
    // Pin abrupt termination (1006): a clean close handshake must not satisfy
    // this test, so an unrelated close cannot make it pass.
    await expect(bridgeCloseCode).resolves.toBe(1006);
    // The terminated browser-facing socket propagates a close to the upstream.
    await upstreamClosed;
  });

  it("propagates close and error events to the opposite socket", async () => {
    const closeCaseClientSide = await createSocketPair();
    const closeCaseUpstreamSide = await createSocketPair();
    bridgeSockets(closeCaseClientSide.bridgeSocket, closeCaseUpstreamSide.bridgeSocket);

    const upstreamClosed = nextClose(closeCaseUpstreamSide.peerSocket);
    closeCaseClientSide.peerSocket.close();
    await upstreamClosed;

    const errorCaseClientSide = await createSocketPair();
    const errorCaseUpstreamSide = await createSocketPair();
    bridgeSockets(errorCaseClientSide.bridgeSocket, errorCaseUpstreamSide.bridgeSocket);

    const clientClosed = nextClose(errorCaseClientSide.peerSocket);
    errorCaseUpstreamSide.bridgeSocket.emit("error", new Error("upstream failed"));
    await clientClosed;
  });
});

describe("createBufferedSender", () => {
  it("queues messages while a WebSocket is still connecting", async () => {
    const socketServer = createServer();
    const connected = new Promise<WebSocket>((resolve) => {
      socketServer.once("connection", (socket) => {
        sockets.add(socket);
        resolve(socket);
      });
    });
    await waitForListening(socketServer);

    const client = new WebSocket(serverUrl(socketServer));
    sockets.add(client);
    const send = createBufferedSender(client);
    send("queued-before-open");

    const serverSocket = await connected;
    await expect(nextMessage(serverSocket)).resolves.toBe("queued-before-open");
    closeSocket(client);
    closeSocket(serverSocket);
  });
});

interface SocketPair {
  bridgeSocket: WebSocket;
  peerSocket: WebSocket;
}

async function createSocketPair(): Promise<SocketPair> {
  const socketServer = createServer();
  const connected = new Promise<WebSocket>((resolve) => {
    socketServer.once("connection", (socket) => {
      sockets.add(socket);
      resolve(socket);
    });
  });
  await waitForListening(socketServer);

  const peerSocket = new WebSocket(serverUrl(socketServer));
  sockets.add(peerSocket);
  const opened = nextOpen(peerSocket);
  const bridgeSocket = await connected;
  await opened;

  return { bridgeSocket, peerSocket };
}

function createServer(): WebSocketServer {
  const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.add(socketServer);
  return socketServer;
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN) return;
  socket.close();
}

function closeSocketServer(socketServer: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => {
    socketServer.close(() => { resolve(); });
  });
}

function waitForListening(socketServer: WebSocketServer): Promise<void> {
  if (socketServer.address() !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.once("listening", () => {
      socketServer.off("error", reject);
      resolve();
    });
  });
}

function serverUrl(socketServer: WebSocketServer): string {
  const address = socketServer.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function nextOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

function nextClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => { resolve(); });
  });
}

function nextCloseCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => { resolve(code); });
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(rawDataToString(data));
    });
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
