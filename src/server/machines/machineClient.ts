import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { DEFAULT_REMOTE_REQUEST_TIMEOUT_MS } from "../../shared/machineRequestTimeout.js";
import type { StoredMachine } from "./machineStore.js";

export { DEFAULT_REMOTE_REQUEST_TIMEOUT_MS };

export interface MachineHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body?: NodeJS.ReadableStream;
}

export interface MachineJsonResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MachineRequestOptions {
  timeoutMs?: number;
  contentType?: string;
  signal?: AbortSignal;
}

export interface MachineClient {
  request(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineHttpResponse>;
  requestJson(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineJsonResponse>;
  connectWebSocket(path: string): WebSocket;
}

export const DEFAULT_REMOTE_HEALTH_TIMEOUT_MS = 3_000;

const REMOTE_RESPONSE_ACCEPT_ENCODING = "gzip, deflate";

const REMOTE_REQUEST_TIMEOUT_MESSAGE = "Remote machine request timed out";

const BLOCKED_CONFIGURED_HEADER_NAMES = new Set([
  "host",
  "connection",
  "upgrade",
  "transfer-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "authorization",
  "cookie",
]);

export class RemoteMachineRequestError extends Error {
  constructor(message: string, readonly statusCode: 502 | 504) {
    super(message);
    this.name = "RemoteMachineRequestError";
  }
}

export class RemoteMachineClient implements MachineClient {
  constructor(
    private readonly machine: Pick<StoredMachine, "baseUrl" | "token" | "headers" | "requestTimeoutMs">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(method: string, path: string, body?: unknown, options: MachineRequestOptions = {}): Promise<MachineHttpResponse> {
    const { response, cancellation } = await this.fetchResponse(method, path, body, options);
    const headers = decodedResponseHeaders(response.headers);
    if (response.body === null) {
      cancellation.dispose();
      return { statusCode: response.status, headers };
    }
    let readable: Readable;
    try {
      readable = readableFromWebResponseBody(response.body);
    } catch (error) {
      cancellation.dispose();
      throw error;
    }
    cancellation.attachBody(readable);
    return { statusCode: response.status, headers, body: readable };
  }

  async requestJson(method: string, path: string, body?: unknown, options: MachineRequestOptions = {}): Promise<MachineJsonResponse> {
    const { response, cancellation } = await this.fetchResponse(method, path, body, options);
    try {
      const text = await cancellation.readBody(response, () => response.text());
      const parsed: unknown = text === "" ? undefined : JSON.parse(text);
      return {
        statusCode: response.status,
        headers: decodedResponseHeaders(response.headers),
        body: parsed,
      };
    } finally {
      cancellation.dispose();
    }
  }

  connectWebSocket(path: string): WebSocket {
    const url = this.remoteUrl(path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url, { headers: this.remoteHeaders() });
  }

  private async fetchResponse(method: string, path: string, body: unknown, options: MachineRequestOptions): Promise<FetchedRemoteResponse> {
    const cancellation = new RemoteRequestCancellation(options.signal, resolveRequestTimeout(this.machine, options));
    const preAborted = cancellation.failure();
    if (preAborted !== undefined) {
      cancellation.dispose();
      throw preAborted;
    }
    try {
      const requestBody = serializeRequestBody(method, body);
      const init: RequestInit = {
        method,
        headers: this.requestHeaders(body, options),
        signal: cancellation.signal,
        redirect: "manual",
      };
      if (requestBody !== undefined) init.body = requestBody;
      const response = await this.fetchImpl(this.remoteUrl(path), init);
      // The client deadline only covers the wait for headers; body transfer is unbounded.
      cancellation.headersArrived();
      const failure = cancellation.failure();
      if (failure !== undefined) {
        // Cancellation already won, so nobody will read this body. Cleanup is only
        // started here: the reason below is already owned and must not wait for it.
        discardResponseBody(response, failure);
        throw failure;
      }
      return { response, cancellation };
    } catch (error) {
      // A request that already owns a failure keeps that reason instead of a mapped one.
      cancellation.dispose();
      const failure = cancellation.failure();
      if (failure !== undefined) throw failure;
      throw mapRemoteFetchFailure(error);
    }
  }

  private requestHeaders(body: unknown, options: MachineRequestOptions): Headers {
    const headers = new Headers(this.remoteHeaders());
    headers.set("accept", "*/*");
    headers.set("accept-encoding", REMOTE_RESPONSE_ACCEPT_ENCODING);
    if (body !== undefined) headers.set("content-type", options.contentType ?? defaultContentTypeForBody(body));
    return headers;
  }

  private remoteHeaders(): Record<string, string> {
    return {
      ...(this.machine.token === undefined || this.machine.token === "" ? {} : { authorization: `Bearer ${this.machine.token}` }),
      ...filterConfiguredHeaders(this.machine.headers),
    };
  }

  private remoteUrl(path: string): URL {
    const url = new URL(this.machine.baseUrl);
    const separator = path.indexOf("?");
    const rawPath = separator === -1 ? path : path.slice(0, separator);
    const rawQuery = separator === -1 ? "" : path.slice(separator + 1);
    const basePath = url.pathname.replace(/\/$/u, "");
    const nextPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    url.pathname = `${basePath}${nextPath}`;
    url.search = rawQuery === "" ? "" : `?${rawQuery}`;
    url.hash = "";
    return url;
  }
}

interface FetchedRemoteResponse {
  response: Response;
  cancellation: RemoteRequestCancellation;
}

type RemoteRequestOwner = "caller" | "deadline";

/**
 * Owns one outgoing request's abort sources: the caller's signal for the whole
 * request lifetime and a client-owned timer that only covers the wait for
 * response headers.
 */
class RemoteRequestCancellation {
  private readonly controller = new AbortController();
  private readonly caller: AbortSignal | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private owner: RemoteRequestOwner | undefined;
  private callerAttached = false;

  readonly signal: AbortSignal;

  constructor(caller: AbortSignal | undefined, timeoutMs: number) {
    this.caller = caller;
    this.signal = this.controller.signal;
    if (caller?.aborted === true) {
      this.handleCallerAbort();
      return;
    }
    if (caller !== undefined) {
      caller.addEventListener("abort", this.handleCallerAbort, { once: true });
      this.callerAttached = true;
    }
    this.timer = setTimeout(this.handleDeadline, timeoutMs);
  }

  /** Releases the header-only timer while keeping caller cancellation for the body. */
  headersArrived(): void {
    this.clearTimer();
  }

  /** The failure this request already owns, if any. */
  failure(): Error | undefined {
    if (this.owner === "caller") return callerFailureReason(this.caller);
    if (this.owner === "deadline") return new RemoteMachineRequestError(REMOTE_REQUEST_TIMEOUT_MESSAGE, 504);
    return undefined;
  }

  /**
   * Reads a response body while the caller can still cancel. A cancellation that
   * already won releases the body instead of starting a doomed read.
   */
  async readBody<T>(response: Response, read: () => Promise<T>): Promise<T> {
    const settled = this.failure();
    if (settled !== undefined) {
      discardResponseBody(response, settled);
      throw settled;
    }
    const work = read();
    // Keep the read observed even when the race below is lost, so a body rejection
    // can never surface as unhandled.
    void work.catch(() => undefined);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => { reject(this.failure() ?? new Error(REMOTE_REQUEST_TIMEOUT_MESSAGE)); };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      if (onAbort !== undefined) this.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Keeps caller cancellation attached to a returned body until that body settles. */
  attachBody(readable: Readable): void {
    const settled = this.failure();
    if (settled !== undefined) {
      this.dispose();
      readable.destroy(settled);
      return;
    }
    const onAbort = (): void => {
      readable.destroy(this.failure() ?? new Error(REMOTE_REQUEST_TIMEOUT_MESSAGE));
    };
    const release = (): void => {
      this.signal.removeEventListener("abort", onAbort);
      this.dispose();
    };
    this.signal.addEventListener("abort", onAbort, { once: true });
    readable.once("end", release);
    readable.once("close", release);
    readable.once("error", release);
  }

  dispose(): void {
    this.clearTimer();
    if (!this.callerAttached) return;
    this.callerAttached = false;
    this.caller?.removeEventListener("abort", this.handleCallerAbort);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private readonly handleCallerAbort = (): void => {
    if (this.owner !== undefined) return;
    this.owner = "caller";
    this.controller.abort(callerFailureReason(this.caller));
  };

  private readonly handleDeadline = (): void => {
    if (this.owner !== undefined) return;
    this.owner = "deadline";
    this.controller.abort(new Error(REMOTE_REQUEST_TIMEOUT_MESSAGE));
  };
}

export function validateConfiguredMachineHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const name = key.trim();
    if (name === "") throw new Error("Machine header names must not be empty");
    if (typeof value !== "string") throw new Error("Machine headers must be strings");
    if (BLOCKED_CONFIGURED_HEADER_NAMES.has(name.toLowerCase())) throw new Error(`Machine header is not allowed: ${name}`);
    return [name, value];
  }));
}

function filterConfiguredHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !BLOCKED_CONFIGURED_HEADER_NAMES.has(key.toLowerCase())));
}

function decodedResponseHeaders(headers: Headers): Record<string, string> {
  const values: Record<string, string> = Object.fromEntries(headers.entries());
  const contentEncoding = values["content-encoding"];
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    // Fetch decodes response bodies but retains headers for the encoded wire
    // representation. The outer HTTP edge must negotiate and frame the decoded body.
    delete values["content-encoding"];
    delete values["content-length"];
  }
  return values;
}

function resolveRequestTimeout(machine: Pick<StoredMachine, "requestTimeoutMs">, options: MachineRequestOptions): number {
  return options.timeoutMs ?? machine.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
}

function callerFailureReason(caller: AbortSignal | undefined): Error {
  const reason: unknown = caller?.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

function serializeRequestBody(method: string, body: unknown): NonNullable<RequestInit["body"]> | undefined {
  if (body === undefined || method === "GET" || method === "HEAD") return undefined;
  if (isRawRequestBody(body)) return body;
  if (ArrayBuffer.isView(body)) return copyArrayBufferView(body);
  const serialized: string = JSON.stringify(body);
  return serialized;
}

function defaultContentTypeForBody(body: unknown): string {
  return isRawRequestBody(body) || ArrayBuffer.isView(body) ? "application/octet-stream" : "application/json";
}

function isRawRequestBody(body: unknown): body is NonNullable<RequestInit["body"]> {
  return typeof body === "string"
    || body instanceof URLSearchParams
    || body instanceof Blob
    || body instanceof FormData
    || body instanceof ReadableStream
    || body instanceof ArrayBuffer;
}

function copyArrayBufferView(view: ArrayBufferView): ArrayBuffer {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function readableFromWebResponseBody(body: Response["body"]): Readable {
  if (body === null) throw new Error("Response body is not readable");
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Node fetch returns a web stream that is runtime-compatible with Readable.fromWeb, but DOM and node:stream/web types are not structurally identical in this TS config.
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}

function mapRemoteFetchFailure(error: unknown): RemoteMachineRequestError {
  // Only the request's own recorded deadline maps to 504; every other rejection,
  // including an unowned AbortError, keeps its diagnostic as a 502.
  return new RemoteMachineRequestError(error instanceof Error ? error.message : String(error), 502);
}

/**
 * Starts releasing a response body nobody will read and observes its eventual
 * rejection, without reporting completion. A tee'd or slow source can keep the
 * cancel promise pending indefinitely, so propagation of the reason this request
 * already owns must never depend on it.
 */
function discardResponseBody(response: Response, reason: Error): void {
  const body = response.body;
  if (body === null) return;
  try {
    void body.cancel(reason).catch(() => undefined);
  } catch {
    // The body already settled or is locked by another reader.
  }
}
