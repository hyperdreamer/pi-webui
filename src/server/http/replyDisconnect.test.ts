import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import { createReplyDisconnectScope } from "./replyDisconnect.js";

interface RawReply extends EventEmitter {
  writableFinished: boolean;
  destroyed: boolean;
}

function rawReply(state: { writableFinished?: boolean; destroyed?: boolean } = {}): RawReply {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the outgoing ServerResponse is an event emitter plus the two flags the scope reads.
  const raw = new EventEmitter() as RawReply;
  raw.writableFinished = state.writableFinished ?? false;
  raw.destroyed = state.destroyed ?? false;
  return raw;
}

function scopeReply(raw: RawReply): FastifyReply {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal reply surface the scope observes.
  return { raw } as unknown as FastifyReply;
}

function abortReasonName(signal: AbortSignal): string | undefined {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException ? reason.name : undefined;
}

describe("createReplyDisconnectScope", () => {
  it("owns reply finish and close listeners until response completion", () => {
    const completedRaw = rawReply();
    const completedScope = createReplyDisconnectScope(scopeReply(completedRaw));
    expect(completedRaw.listenerCount("finish")).toBe(1);
    expect(completedRaw.listenerCount("close")).toBe(1);

    completedRaw.emit("finish");
    expect(completedScope.signal.aborted).toBe(false);
    expect(completedRaw.listenerCount("finish")).toBe(0);
    expect(completedRaw.listenerCount("close")).toBe(0);
    completedRaw.emit("close");
    expect(completedScope.signal.aborted).toBe(false);

    const disconnectedRaw = rawReply();
    const disconnectedScope = createReplyDisconnectScope(scopeReply(disconnectedRaw));
    let abortEvents = 0;
    disconnectedScope.signal.addEventListener("abort", () => {
      abortEvents += 1;
    });
    disconnectedRaw.emit("close");
    expect(disconnectedScope.signal.aborted).toBe(true);
    expect(abortReasonName(disconnectedScope.signal)).toBe("AbortError");
    expect(abortEvents).toBe(1);
    expect(disconnectedRaw.listenerCount("finish")).toBe(0);
    expect(disconnectedRaw.listenerCount("close")).toBe(0);
    disconnectedRaw.emit("close");
    expect(abortEvents).toBe(1);

    const alreadyFinishedRaw = rawReply({ writableFinished: true });
    const alreadyFinishedScope = createReplyDisconnectScope(scopeReply(alreadyFinishedRaw));
    expect(alreadyFinishedRaw.listenerCount("finish")).toBe(0);
    expect(alreadyFinishedRaw.listenerCount("close")).toBe(0);
    alreadyFinishedRaw.emit("close");
    expect(alreadyFinishedScope.signal.aborted).toBe(false);

    const alreadyDestroyedRaw = rawReply({ destroyed: true });
    const alreadyDestroyedScope = createReplyDisconnectScope(scopeReply(alreadyDestroyedRaw));
    expect(alreadyDestroyedScope.signal.aborted).toBe(true);
    expect(alreadyDestroyedRaw.listenerCount("finish")).toBe(0);
    expect(alreadyDestroyedRaw.listenerCount("close")).toBe(0);

    const disposedRaw = rawReply();
    let collaboratorCloses = 0;
    disposedRaw.on("close", () => {
      collaboratorCloses += 1;
    });
    const disposedScope = createReplyDisconnectScope(scopeReply(disposedRaw));
    disposedScope.dispose();
    disposedScope.dispose();
    expect(disposedRaw.listenerCount("finish")).toBe(0);
    expect(disposedRaw.listenerCount("close")).toBe(1);
    disposedRaw.emit("close");
    expect(collaboratorCloses).toBe(1);
    expect(disposedScope.signal.aborted).toBe(false);
  });
});
