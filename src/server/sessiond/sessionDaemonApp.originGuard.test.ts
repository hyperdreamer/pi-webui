import { expect, it } from "vitest";
import { createSessionDaemonApp } from "./sessionDaemonApp.js";

it.each([
  ["http://pi.test:8808", 200], ["https://foreign.example", 403], ["null", 403], ["%%%", 403], [undefined, 200],
] as const)("constructs the production daemon HTTP edge for Origin %s", async (origin, expected) => {
  const app = await createSessionDaemonApp({ logger: false }); let calls = 0;
  app.post("/factory-control", () => { calls++; return { ok: true }; });
  try {
    const result = await app.inject({ method: "POST", url: "/factory-control", headers: { host: "pi.test:8808", ...(origin === undefined ? {} : { origin }) } });
    expect(result.statusCode).toBe(expected); expect(calls).toBe(expected === 200 ? 1 : 0);
    if (expected === 403) expect(result.body).toBe('{"error":"Cross-origin request rejected"}');
  } finally { await app.close(); }
});
