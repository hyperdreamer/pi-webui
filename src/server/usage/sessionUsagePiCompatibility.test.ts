import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { scanSessionUsage } from "./sessionUsageScanner";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Pi 0.86 added standalone `usage` session entries (for example cache warming)
 * that its `getSessionStats` counts alongside compaction, branch-summary, and
 * message usage. PI WEBUI's project totals mirror that scanner, so this proves
 * parity against the installed Pi runtime instead of trusting a fixture.
 */
describe("installed Pi usage-stat compatibility", () => {
  it("matches Pi's getSessionStats for standalone usage entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-usage-pi-compat-"));
    tempRoots.push(root);
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path, { recursive: true })));

    const sessionPath = join(sessionDir, "usage-parity.jsonl");
    await writeFile(sessionPath, `${sessionLines(cwd).map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const services = await createAgentSessionServices({ cwd, agentDir });
    const sessionManager = SessionManager.open(sessionPath);
    const { session } = await createAgentSessionFromServices({ services, sessionManager });
    const stats = session.getSessionStats();
    const scanned = await scanSessionUsage(sessionPath, 0);

    expect({
      input: scanned.totals.input,
      output: scanned.totals.output,
      cacheRead: scanned.totals.cacheRead,
      cacheWrite: scanned.totals.cacheWrite,
    }).toEqual({
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
    });
    expect(scanned.totals.cost).toBeCloseTo(stats.cost);
    // Guard the reason for the comparison: Pi must actually count the usage entry.
    expect(stats.tokens.input).toBe(24);
    expect(stats.cost).toBeCloseTo(0.19);
  });
});

const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function sessionLines(cwd: string): readonly unknown[] {
  return [
    { type: "session", version: 3, id: "usage-parity", timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
    { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "system", content: "", toolsAdded: [{ name: "read" }], timestamp: 2 } },
    { type: "message", id: "m3", parentId: "m2", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], api: "anthropic-messages", provider: "anthropic", model: "demo", usage: usage(10, 5, 0.1), stopReason: "stop", timestamp: 3 } },
    { type: "usage", id: "u1", parentId: "m3", timestamp: "2026-01-01T00:00:04.000Z", kind: "cache_warm", provider: "anthropic", model: "demo", usage: usage(7, 0, 0.02), note: "cache warm" },
    { type: "branch_summary", id: "b1", parentId: "u1", timestamp: "2026-01-01T00:00:05.000Z", summary: "branch", usage: usage(3, 1, 0.03) },
    { type: "compaction", id: "c1", parentId: "b1", timestamp: "2026-01-01T00:00:06.000Z", summary: "compact", firstKeptEntryId: null, tokensBefore: 100, usage: usage(4, 2, 0.04) },
  ];
}
