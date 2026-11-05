import compress from "@fastify/compress";
import Fastify, { type FastifyReply } from "fastify";
import http from "node:http";
import { mkdtemp, open, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import type { ReadStream } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { createReplyDisconnectScope } from "./replyDisconnect.js";
import { FILE_VIEW_DOCUMENT_CSP, sendWorkspaceFileView } from "./fileViewReply.js";
import type { WorkspaceFileView } from "../workspaces/fileViewService.js";

const policy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

type ReadMode = "none" | "holdFirst" | "holdAfterFirst";

interface ReplyFixtureOptions {
  declaredSize?: number;
  readMode?: ReadMode;
  beforeSend?: (reply: FastifyReply) => void;
}

interface ReplyFixture {
  url: string;
  path: string;
  stream: ReadStream;
  go: Deferred<undefined>;
  entered: Deferred<undefined>;
  readonly disposed: number;
  readonly reads: number;
  readonly sent: unknown[];
  releaseReads(): void;
  close(): Promise<void>;
}

interface InstrumentedReads {
  reads: () => number;
  release: () => void;
}

function instrumentReads(stream: ReadStream, mode: ReadMode): InstrumentedReads {
  const original = stream._read.bind(stream);
  let reads = 0;
  let released = mode === "none";
  let pending: number | undefined;
  const read = (size: number) => {
    reads += 1;
    original(size);
  };
  stream._read = (size: number) => {
    if (mode === "none") {
      read(size);
      return;
    }
    if (mode === "holdAfterFirst" && reads === 0) {
      read(size);
      return;
    }
    if (released) {
      read(size);
      return;
    }
    pending = size;
  };
  return {
    reads: () => reads,
    release: () => {
      released = true;
      if (pending !== undefined) {
        const size = pending;
        pending = undefined;
        read(size);
      }
    },
  };
}

async function replyFixture(
  body: Buffer,
  kind: WorkspaceFileView["kind"] = "document",
  mediaType = "text/html; charset=utf-8",
  compression = false,
  options: ReplyFixtureOptions = {},
): Promise<ReplyFixture> {
  const root = await mkdtemp(join(tmpdir(), "view-reply-"));
  const path = join(root, "a.html");
  await writeFile(path, body);
  const handle = await open(path, "r");
  const measured = await handle.stat();
  const stream = handle.createReadStream({ start: 0, end: body.length > 0 ? body.length - 1 : 0, autoClose: true });
  if (body.length === 0) stream.push(null);
  const instrumented = instrumentReads(stream, options.readMode ?? "none");
  const go = deferred<undefined>();
  const entered = deferred<undefined>();
  const app = Fastify({ logger: false });
  if (compression) await app.register(compress, { threshold: 1024 });
  let scopeDisposed = 0;
  let sentPayloads: unknown[] = [];
  app.get("/", async (_request, reply) => {
    const scope = createReplyDisconnectScope(reply);
    const sendSpy = vi.spyOn(reply, "send");
    entered.resolve(undefined);
    await go.promise;
    const view: WorkspaceFileView = {
      path: "a.html",
      kind,
      mediaType,
      size: options.declaredSize ?? measured.size,
      modifiedAt: measured.mtime.toISOString(),
      stream,
    };
    try {
      options.beforeSend?.(reply);
      return await sendWorkspaceFileView(reply, view, {
        signal: scope.signal,
        dispose: () => {
          scopeDisposed += 1;
          scope.dispose();
        },
      });
    } finally {
      sentPayloads = sendSpy.mock.calls.map((call) => call[0]);
    }
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    url,
    path,
    stream,
    go,
    entered,
    get disposed() { return scopeDisposed; },
    get reads() { return instrumented.reads(); },
    get sent() { return sentPayloads; },
    releaseReads: () => { instrumented.release(); },
    async close() {
      stream.destroy();
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface ObservedResponse {
  ended: boolean;
  aborted: boolean;
  bytes: Buffer;
  headers: http.IncomingHttpHeaders;
  status: number;
}

function observe(url: string, headers: http.OutgoingHttpHeaders = {}, onHeaders?: (response: http.IncomingMessage) => void) {
  const header = deferred<http.IncomingMessage>();
  const first = deferred<undefined>();
  let request: http.ClientRequest | undefined;
  const result = new Promise<ObservedResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const finish = (ended: boolean, aborted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ended, aborted, bytes: Buffer.concat(chunks), headers: response?.headers ?? {}, status: response?.statusCode ?? 0 });
    };
    const deadline = setTimeout(() => {
      request?.destroy();
      reject(new Error("HTTP observation deadline"));
    }, 3000);
    request = http.get(url, { headers }, (incoming) => {
      response = incoming;
      header.resolve(incoming);
      onHeaders?.(incoming);
      incoming.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        first.resolve(undefined);
      });
      incoming.once("end", () => { finish(true, false); });
      incoming.once("aborted", () => { finish(false, true); });
      incoming.once("error", () => { finish(false, true); });
    });
    request.on("error", () => {
      // A transport error is an aborted/incomplete transfer; the deadline is
      // the only harness-level failure signal for a hung observation.
      finish(false, true);
    });
  });
  return { result, header: header.promise, first: first.promise, destroy: () => { request?.destroy(); } };
}

function common(headers: http.IncomingHttpHeaders): void {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  for (const name of ["content-length", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified"]) expect(headers[name]).toBeUndefined();
}

it("streams an exact body without fixed Content-Length and closes the handle", async () => {
  // Seed a stale fixed length so the assertion is about the helper removing it
  // rather than about Fastify never emitting one for a stream payload.
  const fixture = await replyFixture(Buffer.from("hello"), "document", "text/html; charset=utf-8", false, {
    beforeSend: (reply) => { reply.header("content-length", "9999"); },
  });
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    const result = await response.result;
    expect(result.ended).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.bytes.toString()).toBe("hello");
    common(result.headers);
    await vi.waitFor(() => { expect(fixture.stream.closed).toBe(true); });
  } finally {
    await fixture.close();
  }
});

it("sets the independently specified full document policy for HTML and SVG", async () => {
  for (const type of ["text/html; charset=utf-8", "image/svg+xml"]) {
    const fixture = await replyFixture(Buffer.from("document"), "document", type);
    const response = observe(fixture.url);
    try {
      await fixture.entered.promise;
      fixture.go.resolve(undefined);
      const result = await response.result;
      common(result.headers);
      expect(result.headers["content-type"]).toBe(type);
      expect(result.headers["content-security-policy"]).toBe(policy);
      expect(FILE_VIEW_DOCUMENT_CSP).toBe(policy);
    } finally {
      await fixture.close();
    }
  }
});

it.each([
  ["pdf", "application/pdf"],
  ["image", "image/png"],
  ["text", "text/plain; charset=utf-8"],
] as const)("does not set document CSP on %s responses", async (kind, type) => {
  const fixture = await replyFixture(Buffer.from("data"), kind, type);
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    const result = await response.result;
    common(result.headers);
    expect(result.headers["content-type"]).toBe(type);
    expect(result.headers["content-security-policy"]).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

it.each([2, 0])("aborts a file truncated to %i after fstat", async (remaining) => {
  const fixture = await replyFixture(Buffer.from("hello"));
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    await truncate(fixture.path, remaining);
    fixture.go.resolve(undefined);
    const result = await response.result;
    expect(result.aborted).toBe(true);
    expect(result.ended).toBe(false);
    expect(result.bytes.length).toBeLessThanOrEqual(remaining);
    await vi.waitFor(() => { expect(fixture.stream.closed).toBe(true); });
  } finally {
    await fixture.close();
  }
});

it("finishes a genuinely empty file cleanly with no fixed length", async () => {
  const fixture = await replyFixture(Buffer.alloc(0));
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    const result = await response.result;
    expect(result.ended).toBe(true);
    expect(result.bytes).toEqual(Buffer.alloc(0));
    common(result.headers);
    await vi.waitFor(() => { expect(fixture.stream.closed).toBe(true); });
  } finally {
    await fixture.close();
  }
});

it("aborts a source read error without appending an error page", async () => {
  const fixture = await replyFixture(Buffer.from("hello world payload plus more"), "document", "text/html; charset=utf-8", false, { readMode: "holdAfterFirst" });
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    await response.first;
    const readsBefore = fixture.reads;
    const failure: NodeJS.ErrnoException = new Error("source read failed");
    failure.code = "EIO";
    fixture.stream.destroy(failure);
    const result = await response.result;
    expect(result.aborted).toBe(true);
    expect(result.ended).toBe(false);
    expect(result.bytes.toString()).not.toContain("Unable to preview");
    expect(result.bytes.toString()).not.toContain("{");
    expect(fixture.reads).toBe(readsBefore);
    await vi.waitFor(() => { expect(fixture.stream.closed).toBe(true); });
  } finally {
    await fixture.close();
  }
});

it("rejects a counter overflow instead of completing a long body", async () => {
  const fixture = await replyFixture(Buffer.from("hello"), "document", "text/html; charset=utf-8", false, { declaredSize: 2 });
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    const result = await response.result;
    expect(result.aborted).toBe(true);
    expect(result.ended).toBe(false);
    expect(result.bytes.length).toBeLessThanOrEqual(2);
    const counter = fixture.sent[0];
    expect(counter).toBeInstanceOf(Transform);
    if (counter instanceof Transform) await vi.waitFor(() => { expect(counter.destroyed).toBe(true); });
    await vi.waitFor(() => { expect(fixture.stream.closed).toBe(true); });
  } finally {
    await fixture.close();
  }
});

it("closes source and counter when the client disconnects", async () => {
  const fixture = await replyFixture(Buffer.from("hello world payload"), "document", "text/html; charset=utf-8", false, { readMode: "holdAfterFirst" });
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    await response.first;
    response.destroy();
    const result = await response.result;
    expect(result.ended).toBe(false);
    await vi.waitFor(() => { expect(fixture.stream.closed).toBe(true); });
    const readsAtClose = fixture.reads;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(fixture.reads).toBe(readsAtClose);
    await vi.waitFor(() => { expect(fixture.disposed).toBe(1); });
    const counter = fixture.sent[0];
    expect(counter).toBeInstanceOf(Transform);
    if (counter instanceof Transform) await vi.waitFor(() => { expect(counter.destroyed).toBe(true); });
  } finally {
    await fixture.close();
  }
});

it("cleans up an already disconnected reply", async () => {
  const fixture = await replyFixture(Buffer.from("hello"), "document", "text/html; charset=utf-8", false, {
    beforeSend: (reply) => { reply.raw.destroy(); },
  });
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    const result = await response.result;
    expect(result.aborted).toBe(true);
    await vi.waitFor(() => { expect(fixture.stream.closed).toBe(true); });
    expect(fixture.disposed).toBe(1);
    expect(fixture.sent).toEqual([]);
  } finally {
    await fixture.close();
  }
});

it("cleans up a send-setup failure", async () => {
  const fixture = await replyFixture(Buffer.from("hello"), "document", "text/html; charset=utf-8", false, {
    beforeSend: (reply) => {
      vi.spyOn(reply, "send").mockImplementationOnce(() => { throw new Error("send setup failed"); });
    },
  });
  const response = observe(fixture.url);
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    const result = await response.result;
    expect(result.ended).toBe(true);
    expect(result.status).toBe(500);
    await vi.waitFor(() => { expect(fixture.stream.closed).toBe(true); });
    expect(fixture.disposed).toBe(1);
    // The fixture retains the payload through its pass-through send spy, so
    // this is the real counting transform the helper handed to Fastify.
    const counter = fixture.sent[0];
    expect(counter).toBeInstanceOf(Transform);
    if (counter instanceof Transform) {
      expect(counter.destroyed).toBe(true);
      await vi.waitFor(() => { expect(counter.closed).toBe(true); });
    }
  } finally {
    await fixture.close();
  }
});

it("flushes final compression-negotiated headers before releasing the source", async () => {
  const body = Buffer.alloc(4096, "a");
  const fixture = await replyFixture(body, "document", "text/html; charset=utf-8", true, {
    readMode: "holdFirst",
    beforeSend: (reply) => { reply.header("content-length", "9999"); },
  });
  const headersSeen = deferred<http.IncomingHttpHeaders>();
  const response = observe(fixture.url, { "accept-encoding": "gzip" }, (incoming) => { headersSeen.resolve(incoming.headers); });
  try {
    await fixture.entered.promise;
    fixture.go.resolve(undefined);
    const headers = await headersSeen.promise;
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers["content-security-policy"]).toBe(policy);
    expect(headers["content-length"]).toBeUndefined();
    fixture.releaseReads();
    const result = await response.result;
    expect(result.ended).toBe(true);
    expect(gunzipSync(result.bytes)).toEqual(body);
    common(result.headers);
  } finally {
    await fixture.close();
  }
});
