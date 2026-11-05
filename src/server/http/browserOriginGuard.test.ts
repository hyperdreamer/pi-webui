import Fastify, { type FastifyRequest } from "fastify";
import { expect, it } from "vitest";
import { isAllowedBrowserOrigin, registerBrowserOriginGuard, requestOriginFrom } from "./browserOriginGuard.js";

it("allows an absent browser Origin without an inferred request origin", () => {
  expect(isAllowedBrowserOrigin({ origin: undefined, requestOrigin: undefined, allowedOrigins: [] })).toBe(true);
  expect(isAllowedBrowserOrigin({ origin: undefined, requestOrigin: "%%%", allowedOrigins: [] })).toBe(true);
});

it("matches exact normalized origins and explicit allowedOrigins", () => {
  for (const [origin, requestOrigin, allowedOrigins] of [
    ["HTTPS://PI.EXAMPLE:443/", "https://pi.example", []],
    ["http://pi.example:80", "http://pi.example", []],
    ["https://public.example:8443", "http://internal:8808", ["https://public.example:8443/"]],
    ["https://pi.example", undefined, ["https://pi.example"]],
  ] as const) expect(isAllowedBrowserOrigin({ origin, requestOrigin, allowedOrigins })).toBe(true);
});

it.each(["https://pi.test:8808", "http://other.test:8808", "http://pi.test:8809", "null", "", "%%%", "https://u:p@pi.test", "https://pi.test/path", "https://pi.test?", "https://pi.test#", "file://pi.test", "http://a,http://b"])("rejects %s", (origin) => {
  expect(isAllowedBrowserOrigin({ origin, requestOrigin: "http://pi.test:8808", allowedOrigins: ["not-an-origin"] })).toBe(false);
  if (["null", "", "%%%", "https://u:p@pi.test", "https://pi.test/path", "https://pi.test?", "https://pi.test#", "file://pi.test", "http://a,http://b"].includes(origin)) expect(isAllowedBrowserOrigin({ origin, requestOrigin: undefined, allowedOrigins: [origin] })).toBe(false);
});

it("does not derive trust from allowedHosts-shaped patterns", () => {
  expect(isAllowedBrowserOrigin({ origin: "https://evil.pi.example", requestOrigin: "https://pi.example", allowedOrigins: ["*.pi.example", ".pi.example", "*"] })).toBe(false);
});

async function derive(change: (request: FastifyRequest) => void): Promise<unknown> {
  const app = Fastify({ logger: false });
  app.get("/", (request) => { change(request); return { origin: requestOriginFrom(request) ?? null }; });
  try { return (await app.inject({ url: "/", headers: { host: "pi.test:8808" } })).json(); }
  finally { await app.close(); }
}

it("derives the request origin from socket protocol and Host", async () => {
  expect(await derive(() => undefined)).toEqual({ origin: "http://pi.test:8808" });
  expect(await derive((r) => { Object.defineProperty(r.raw.socket, "encrypted", { configurable: true, value: true }); })).toEqual({ origin: "https://pi.test:8808" });
  expect(await derive((r) => { r.headers.host = "[::1]:8808"; })).toEqual({ origin: "http://[::1]:8808" });
});

it("uses only the first forwarded-proto token and ignores forwarded host", async () => {
  for (const [token, origin] of [["https, http", "https://pi.test:8808"], ["bad, https", null], [", https", null], ["", null]] as const) expect(await derive((r) => { r.headers["x-forwarded-proto"] = token; r.headers["x-forwarded-host"] = "foreign.example"; })).toEqual({ origin });
});

it("fails closed on malformed or duplicate Host and present-invalid forwarded proto", async () => {
  for (const host of ["", "a,b", "a b", "a/path", "a?", "a#", "u@a", "a\\b"]) expect(await derive((r) => { r.headers.host = host; })).toEqual({ origin: null });
  expect(await derive((r) => { r.raw.rawHeaders.push("Host", "other.test"); })).toEqual({ origin: null });
  expect(await derive((r) => { delete r.headers.host; })).toEqual({ origin: null });
});

it("treats duplicate or present-invalid Origin as rejection rather than absence", async () => {
  for (const value of ["", "http://pi.test:8808,http://pi.test:8808", ["http://pi.test:8808", "http://pi.test:8808"]]) {
    const app = Fastify({ logger: false }); let calls = 0;
    app.addHook("onRequest", (r) => { Object.defineProperty(r.headers, "origin", { configurable: true, value }); const duplicate = Array.isArray(value) ? value[1] : undefined; if (duplicate !== undefined) r.raw.rawHeaders.push("Origin", duplicate); return Promise.resolve(); });
    registerBrowserOriginGuard(app);
    app.post("/", () => { calls++; return {}; });
    try {
      const r = await app.inject({ method: "POST", url: "/", headers: { host: "pi.test:8808" } });
      expect(r.statusCode).toBe(403); expect(r.body).toBe('{"error":"Cross-origin request rejected"}'); expect(calls).toBe(0);
      expect(r.headers["cache-control"]).toBe("no-store"); expect(r.headers["x-content-type-options"]).toBe("nosniff");
    } finally { await app.close(); }
  }
});

it("guards case-insensitive websocket upgrade tokens before handling", async () => {
  const app = Fastify({ logger: false }); let calls = 0;
  registerBrowserOriginGuard(app); app.get("/", () => { calls++; return {}; });
  try {
    for (const upgrade of ["WebSocket", "h2c, WEBSOCKET"]) expect((await app.inject({ url: "/", headers: { host: "pi.test", origin: "https://foreign.example", upgrade } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/", headers: { origin: "%%%", upgrade: "h2c" } })).statusCode).toBe(200);
    expect(calls).toBe(1);
  } finally { await app.close(); }
});

it("pins a copied startup allowlist and rejects invalid injected snapshots", async () => {
  const input = ["https://public.example"]; const app = Fastify({ logger: false });
  registerBrowserOriginGuard(app, input); input[0] = "https://later.example";
  app.post("/", () => ({}));
  try {
    expect((await app.inject({ method: "POST", url: "/", headers: { origin: "https://public.example" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/", headers: { origin: "https://later.example" } })).statusCode).toBe(403);
  } finally { await app.close(); }
  const invalid = Fastify({ logger: false });
  try { expect(() => { registerBrowserOriginGuard(invalid, ["null"]); }).toThrow("Invalid allowedOrigins startup snapshot"); }
  finally { await invalid.close(); }
});

it("leaves ordinary safe methods untouched even with a hostile Origin", async () => {
  const app = Fastify({ logger: false }); let calls = 0;
  registerBrowserOriginGuard(app);
  // Fastify's GET route already owns its default bodyless HEAD alias.
  app.route({ method: ["GET", "OPTIONS"], url: "/", handler: () => { calls++; return {}; } });
  try {
    for (const method of ["GET", "HEAD", "OPTIONS"] as const) expect((await app.inject({ method, url: "/", headers: { host: "pi.test:8808", origin: "https://foreign.example" } })).statusCode).toBe(200);
    expect(calls).toBe(3);
  } finally { await app.close(); }
});

it("rejects control characters and extra separators in Host", async () => {
  for (const host of ["pi.test\u0000", "pi.test\t:8808", "pi.test:8808,other.test", "pi.test:8808?q", "pi.test:8808#"]) expect(await derive((r) => { r.headers.host = host; })).toEqual({ origin: null });
});

it("ignores a repeated forwarded-proto header value beyond the first token", async () => {
  expect(await derive((r) => { r.headers["x-forwarded-proto"] = "https"; r.raw.rawHeaders.push("X-Forwarded-Proto", "http"); })).toEqual({ origin: "https://pi.test:8808" });
});
