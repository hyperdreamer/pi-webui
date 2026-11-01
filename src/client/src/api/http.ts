import { resolveAppUrl } from "../appUrl";

export class HttpRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export interface HttpJsonResponse {
  status: number;
  body: unknown;
}

export type ResponseStarted = (response: Response) => void;

/** The upstream response started, but its successful body did not arrive intact. */
export class HttpResponseBodyError extends Error {
  readonly status: number;
  override readonly cause: unknown;

  constructor(status: number, cause: unknown) {
    super("Failed to receive response body");
    this.name = "HttpResponseBodyError";
    this.status = status;
    this.cause = cause;
  }
}

export async function request<T>(
  url: string,
  parse: (value: unknown) => T,
  init?: RequestInit,
  onResponse?: ResponseStarted,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(resolveAppUrl(url), { ...init, headers });
  onResponse?.(response);
  if (!response.ok) {
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new HttpRequestError(errorMessage(body) ?? response.statusText, response.status);
  }
  // Callers that did not opt into phase reporting keep the existing body
  // handling contract, including `response.json()`.
  if (onResponse === undefined) {
    const body: unknown = await response.json();
    return parse(body);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    if (init?.signal?.aborted === true || isAbortError(cause)) throw cause;
    throw new HttpResponseBodyError(response.status, cause);
  }
  return parse(JSON.parse(text));
}

export async function requestJson(url: string, init?: RequestInit): Promise<HttpJsonResponse> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(resolveAppUrl(url), { ...init, headers });
  const body: unknown = await response.json().catch((error: unknown): undefined => {
    if (init?.signal?.aborted === true || isAbortError(error)) throw error;
    return undefined;
  });
  return { status: response.status, body };
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["error"] === "string" ? value["error"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
