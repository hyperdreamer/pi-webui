import type { FastifyInstance, FastifyRequest } from "fastify";
import { normalizeBrowserOrigin } from "../../shared/browserOrigins.js";

export interface BrowserOriginContext {
  origin: string | undefined;
  requestOrigin: string | undefined;
  allowedOrigins: readonly string[];
}

/**
 * The single browser-origin decision shared by every HTTP owner. An absent
 * Origin is not a browser request (or is same-origin), so it is admitted.
 * Everything else must normalize to the exact request origin or to one exact
 * configured origin; host-shaped patterns never confer trust.
 */
export function isAllowedBrowserOrigin({ origin, requestOrigin, allowedOrigins }: BrowserOriginContext): boolean {
  if (origin === undefined) return true;
  const normalized = normalizeBrowserOrigin(origin);
  if (normalized === undefined) return false;
  if (requestOrigin !== undefined && normalizeBrowserOrigin(requestOrigin) === normalized) return true;
  return allowedOrigins.some((value) => normalizeBrowserOrigin(value) === normalized);
}

function rawHeaderCount(request: FastifyRequest, name: string): number {
  let count = 0;
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) if (request.raw.rawHeaders[i]?.toLowerCase() === name) count++;
  return count;
}

/**
 * The public origin the browser used, deduced from Host, the first
 * X-Forwarded-Proto token, and the actual socket encryption. X-Forwarded-Host
 * is deliberately ignored so a spoofed header cannot widen trust.
 */
export function requestOriginFrom(request: FastifyRequest): string | undefined {
  const host = request.headers.host;
  if (typeof host !== "string" || !host || /[\s\p{Cc},/?#@\\]/u.test(host) || rawHeaderCount(request, "host") > 1) return undefined;
  const forwarded = request.headers["x-forwarded-proto"];
  let scheme: string;
  if (forwarded !== undefined) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    scheme = ((first ?? "").split(",", 1).at(0) ?? "").trim().toLowerCase();
    if (scheme !== "http" && scheme !== "https") return undefined;
  } else {
    const socket = request.raw.socket;
    scheme = "encrypted" in socket && socket.encrypted === true ? "https" : "http";
  }
  return normalizeBrowserOrigin(`${scheme}://${host}`);
}

/**
 * Installs the one root onRequest guard: state-changing HTTP methods and
 * WebSocket upgrades are checked before body parsing or route handling, while
 * ordinary safe methods stay untouched. The startup allowlist is normalized
 * and copied once, so a later operator edit cannot retarget a live process.
 */
export function registerBrowserOriginGuard(app: FastifyInstance, allowedOrigins: readonly string[] = []): void {
  const snapshot = allowedOrigins.map((value) => {
    const result = normalizeBrowserOrigin(value);
    if (result === undefined) throw new Error("Invalid allowedOrigins startup snapshot");
    return result;
  });
  app.addHook("onRequest", async (request, reply) => {
    const upgrade = request.headers.upgrade;
    const tokens = (Array.isArray(upgrade) ? upgrade.join(",") : upgrade ?? "").split(",");
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase()) && !tokens.some((s) => s.trim().toLowerCase() === "websocket")) return;
    const incoming = request.headers.origin;
    const count = rawHeaderCount(request, "origin");
    const invalid = count > 1 || Array.isArray(incoming) || (incoming !== undefined && (incoming.trim() === "" || incoming.includes(","))) || (count > 0 && incoming === undefined);
    const present = typeof incoming === "string" ? incoming : undefined;
    if (!invalid && isAllowedBrowserOrigin({ origin: present, requestOrigin: requestOriginFrom(request), allowedOrigins: snapshot })) return;
    return reply.code(403).type("application/json; charset=utf-8").header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").send({ error: "Cross-origin request rejected" });
  });
}
