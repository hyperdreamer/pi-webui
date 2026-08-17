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

export async function request<T>(url: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(resolveAppUrl(url), { ...init, headers });
  if (!response.ok) {
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new HttpRequestError(errorMessage(body) ?? response.statusText, response.status);
  }
  const body: unknown = await response.json();
  return parse(body);
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
