import type { FastifyReply } from "fastify";

/**
 * Cancellation owned by one outgoing reply. A reply that finishes normally never
 * aborts; a reply that closes before it finished means the client went away and
 * aborts its signal so the work behind it can stop.
 */
export interface ReplyDisconnectScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createReplyDisconnectScope(reply: FastifyReply): ReplyDisconnectScope {
  const controller = new AbortController();
  let completed = false;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    reply.raw.removeListener("finish", onFinish);
    reply.raw.removeListener("close", onClose);
  };

  const onFinish = (): void => {
    completed = true;
    dispose();
  };

  const onClose = (): void => {
    if (!completed && !reply.raw.writableFinished && !controller.signal.aborted) {
      controller.abort(new DOMException("The response was disconnected", "AbortError"));
    }
    dispose();
  };

  // Observe the outgoing ServerResponse, not the request stream or a reusable socket.
  reply.raw.once("finish", onFinish);
  reply.raw.once("close", onClose);
  if (reply.raw.writableFinished) onFinish();
  else if (reply.raw.destroyed) onClose();

  return { signal: controller.signal, dispose };
}
