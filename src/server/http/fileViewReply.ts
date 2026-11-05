import type { FastifyReply } from "fastify";
import { Transform } from "node:stream";
import type { WorkspaceFileView } from "../workspaces/fileViewService.js";
import type { ReplyDisconnectScope } from "./replyDisconnect.js";
import { MAX_FILE_VIEW_BYTES } from "../../shared/fileViewTypes.js";

/**
 * Complete single-line document policy for HTML/SVG previews. `sandbox
 * allow-scripts` gives the document an opaque origin while still allowing
 * inline animation and script; every network, form, frame, worker, object, and
 * base-URL capability stays denied.
 */
export const FILE_VIEW_DOCUMENT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";

/**
 * Stream one authorized file preview as the terminal response body.
 *
 * The helper owns `view.stream` and `disconnect` on entry, including when the
 * reply is already disconnected. It counts uncompressed file bytes, requires
 * the exact measured size at clean EOF, flushes the final Fastify/compression
 * headers before the first source read, and tears down both the source and the
 * counting transform on disconnect, source error, overflow, or send failure.
 */
export async function sendWorkspaceFileView(reply: FastifyReply, view: WorkspaceFileView, disconnect: ReplyDisconnectScope): Promise<FastifyReply> {
  const source = view.stream;
  let count = 0;
  let released = false;
  let started = false;

  const counter = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      if (!Buffer.isBuffer(chunk)) {
        callback(new Error("File-view stream yielded a non-buffer chunk"));
        return;
      }
      count += chunk.length;
      if (count > view.size || count > MAX_FILE_VIEW_BYTES) {
        callback(new Error("File-view byte count exceeded measured bound"));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      callback(count === view.size ? undefined : new Error("File-view stream ended before measured size"));
    },
  });

  const release = (): void => {
    if (released) return;
    released = true;
    disconnect.signal.removeEventListener("abort", onDisconnect);
    reply.raw.removeListener("pipe", start);
    reply.raw.removeListener("finish", onFinish);
    reply.raw.removeListener("close", onClose);
    disconnect.dispose();
  };

  const abort = (error?: Error): void => {
    source.destroy();
    counter.destroy();
    if (!reply.raw.destroyed) reply.raw.destroy(error);
  };

  const onSourceError = (error: Error): void => {
    counter.destroy(error);
    if (!reply.raw.destroyed) reply.raw.destroy(error);
  };

  const onCounterError = (error: Error): void => {
    source.destroy();
    if (!reply.raw.destroyed) reply.raw.destroy(error);
  };

  const onDisconnect = (): void => {
    abort();
    release();
  };

  const onFinish = (): void => {
    if (!source.readableEnded) source.destroy();
    if (!counter.readableEnded) counter.destroy();
    release();
  };

  const onClose = (): void => {
    if (!reply.raw.writableFinished) abort();
    release();
  };

  const start = (): void => {
    if (started) return;
    started = true;
    if (disconnect.signal.aborted || reply.raw.destroyed) {
      onDisconnect();
      return;
    }
    // Flush the final Fastify/compression-adjusted headers before the first
    // source read, so a zero-byte truncation cannot become a clean empty body.
    if (!reply.raw.headersSent) reply.raw.flushHeaders();
    source.pipe(counter);
  };

  source.on("error", onSourceError);
  counter.on("error", onCounterError);
  source.once("close", () => { source.removeListener("error", onSourceError); });
  counter.once("close", () => { counter.removeListener("error", onCounterError); });
  reply.raw.once("finish", onFinish);
  reply.raw.once("close", onClose);
  disconnect.signal.addEventListener("abort", onDisconnect, { once: true });

  if (disconnect.signal.aborted || reply.raw.destroyed) {
    onDisconnect();
    return reply;
  }

  try {
    reply
      .code(200)
      .type(view.mediaType)
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    reply.removeHeader("content-length");
    if (view.kind === "document") reply.header("Content-Security-Policy", FILE_VIEW_DOCUMENT_CSP);
    reply.raw.once("pipe", start);
    return await reply.send(counter);
  } catch (error) {
    source.destroy();
    counter.destroy();
    release();
    if (reply.raw.headersSent) {
      reply.raw.destroy(error instanceof Error ? error : undefined);
      return reply;
    }
    throw error;
  }
}
