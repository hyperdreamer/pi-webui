import http from "node:http";
import { WebSocket } from "ws";
import { isHostAbsoluteAgentDir, isSafeAgentCommandForHost } from "../config.js";
import type { ActiveAgentProfileDescriptor } from "../shared/apiTypes.js";
import { parsePiWebUiRuntimeComponent } from "../shared/piWebUiStatusParsing.js";
import { sessiondHttpUrl, sessiondSocketPath } from "./config.js";

export type SessionDaemonAgentProfileResult =
  | { status: "available"; profile: ActiveAgentProfileDescriptor }
  | { status: "unavailable"; error: string }
  | { status: "invalid"; error: string };

export interface SessionDaemonRequestClient {
  request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
}

export class SessionDaemonClient {
  private readonly baseUrl = sessiondHttpUrl();
  private readonly socketPath = sessiondSocketPath();

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (this.baseUrl !== undefined && this.baseUrl !== "") return this.requestUrl(method, path, payload, signal);
    return this.requestSocket(method, path, payload, signal);
  }

  getActiveAgentProfile(): Promise<SessionDaemonAgentProfileResult> {
    return getSessionDaemonActiveAgentProfile(this);
  }

  connectWebSocket(path: string): WebSocket {
    if (this.baseUrl !== undefined && this.baseUrl !== "") {
      const url = new URL(path, this.baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url);
    }
    return new WebSocket(`ws+unix:${this.socketPath}:${path}`);
  }

  private async requestUrl(method: string, path: string, payload?: string, signal?: AbortSignal) {
    const init: RequestInit = { method, ...(signal === undefined ? {} : { signal }) };
    if (payload !== undefined && payload !== "") {
      init.headers = { "content-type": "application/json" };
      init.body = payload;
    }
    const response = await fetch(new URL(path, this.baseUrl), init);
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await raceWithAbort(Promise.resolve().then(() => response.text()), signal),
    };
  }

  private requestSocket(method: string, path: string, payload?: string, signal?: AbortSignal): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortError(signal));
        return;
      }

      let settled = false;
      let request: http.ClientRequest | undefined;
      let response: http.IncomingMessage | undefined;
      let responseEnded = false;
      const chunks: Uint8Array[] = [];

      const cleanup = (): void => {
        request?.removeListener("error", onRequestError);
        request?.removeListener("close", onRequestClose);
        response?.removeListener("data", onData);
        response?.removeListener("end", onEnd);
        response?.removeListener("error", onResponseError);
        response?.removeListener("aborted", onResponseAborted);
        response?.removeListener("close", onResponseClose);
      };
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const fail = (error: unknown): void => {
        settle(() => { reject(asError(error)); });
      };
      const onData = (chunk: Buffer | string): void => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      };
      const onEnd = (): void => {
        responseEnded = true;
        settle(() => {
          resolve({
            statusCode: response?.statusCode ?? 500,
            headers: Object.fromEntries(Object.entries(response?.headers ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      };
      const onResponseError = (error: unknown): void => { fail(error); };
      const onResponseAborted = (): void => { fail(new Error("Session daemon response was aborted.")); };
      const onResponseClose = (): void => {
        if (!responseEnded) fail(new Error("Session daemon response closed before completion."));
      };
      const onRequestError = (error: unknown): void => { fail(error); };
      const onRequestClose = (): void => {
        if (!settled && response === undefined) fail(new Error("Session daemon request closed."));
      };
      const onResponse = (nextResponse: http.IncomingMessage): void => {
        response = nextResponse;
        response.on("data", onData);
        response.once("end", onEnd);
        response.once("error", onResponseError);
        response.once("aborted", onResponseAborted);
        response.once("close", onResponseClose);
      };

      try {
        request = http.request(
          {
            socketPath: this.socketPath,
            path,
            method,
            ...(signal === undefined ? {} : { signal }),
            headers: payload !== undefined && payload !== ""
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : undefined,
          },
          onResponse,
        );
        request.on("error", onRequestError);
        request.once("close", onRequestClose);
        if (payload !== undefined && payload !== "") request.write(payload);
        request.end();
      } catch (error) {
        request?.destroy();
        fail(error);
      }
    });
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => { signal.removeEventListener("abort", onAbort); };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      settle(() => { reject(abortError(signal)); });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { settle(() => { resolve(value); }); },
      (error: unknown) => { settle(() => { reject(asError(error)); }); },
    );
    if (signal.aborted) onAbort();
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function getSessionDaemonActiveAgentProfile(client: SessionDaemonRequestClient): Promise<SessionDaemonAgentProfileResult> {
  let response: Awaited<ReturnType<SessionDaemonRequestClient["request"]>>;
  try {
    response = await client.request("GET", "/runtime");
  } catch (error) {
    return { status: "unavailable", error: errorMessage(error) };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { status: "unavailable", error: `session daemon runtime request returned HTTP ${String(response.statusCode)}` };
  }

  let value: unknown;
  try {
    value = response.body === "" ? undefined : JSON.parse(response.body);
  } catch {
    return { status: "invalid", error: "session daemon runtime response was not valid JSON" };
  }

  const runtime = parsePiWebUiRuntimeComponent(value);
  if (runtime?.component !== "sessiond") {
    return { status: "invalid", error: "session daemon runtime response was invalid" };
  }
  if (runtime.activeAgentProfile === undefined) {
    return { status: "invalid", error: "session daemon runtime response did not include an active agent profile" };
  }
  if (!isSafeAgentCommandForHost(runtime.activeAgentProfile.command) || !isHostAbsoluteAgentDir(runtime.activeAgentProfile.dir)) {
    return { status: "invalid", error: "session daemon active agent profile was not valid for this host" };
  }
  return { status: "available", profile: runtime.activeAgentProfile };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
