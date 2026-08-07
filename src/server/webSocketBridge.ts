import { WebSocket, type Data } from "ws";
import { SlowConsumerGuard } from "./realtime/slowConsumerGuard.js";

export function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  // Guard only the browser-facing socket: upstream output is high-volume and
  // order-sensitive, so a client that stops reading must not be allowed to
  // grow an unbounded event queue. The guard terminates only when the depth
  // stays past the soft limit without draining.
  const guard = new SlowConsumerGuard(client);
  const sendToClient = createBufferedSender(client);
  const sendToUpstream = createBufferedSender(upstream);
  client.on("message", (data) => { sendToUpstream(data); });
  upstream.on("message", (data) => {
    sendToClient(data);
    if (guard.afterSend()) {
      upstream.close();
    }
  });
  client.on("close", () => { upstream.close(); });
  upstream.on("close", () => { client.close(); });
  upstream.on("error", () => { client.close(); });
  client.on("error", () => { upstream.close(); });
}

export function createBufferedSender(socket: WebSocket): (data: Data) => void {
  const queue: Data[] = [];
  const flush = () => {
    while (socket.readyState === WebSocket.OPEN) {
      const data = queue.shift();
      if (data === undefined) return;
      socket.send(data);
    }
  };
  socket.on("open", flush);
  return (data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) queue.push(data);
  };
}
