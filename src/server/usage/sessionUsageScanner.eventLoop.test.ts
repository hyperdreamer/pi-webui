import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { scanSessionUsage } from "./sessionUsageScanner";

const LAG_BUDGET_MS = 50;
const PROBE_INTERVAL_MS = 20;

function assistantLine(input: number): string {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, content: "x".repeat(400) },
  });
}

async function writeLargeSession(): Promise<{ path: string; expectedInput: number }> {
  const dir = await mkdtemp(join(tmpdir(), "usage-lag-"));
  const path = join(dir, "session.jsonl");
  const header = JSON.stringify({ type: "session", id: "lag", cwd: "/repo" });
  // ~22 MB of JSON. This is the smallest fixture whose whole-file mutant
  // blocks the event loop decisively past LAG_BUDGET_MS (~105-130 ms measured
  // against this test); the original 20k-line fixture's mutant lagged only
  // ~46-57 ms and could pass. The streaming scanner keeps each turn short at
  // any size.
  const lineCount = 40_000;
  const lines = [header];
  for (let index = 0; index < lineCount; index += 1) lines.push(assistantLine(1));
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return { path, expectedInput: lineCount };
}

describe("scanSessionUsage event-loop behavior", () => {
  it("keeps the event loop responsive while scanning a large session", async () => {
    const { path, expectedInput } = await writeLargeSession();

    let maxLag = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - PROBE_INTERVAL_MS);
      last = now;
    }, PROBE_INTERVAL_MS);

    try {
      const result = await scanSessionUsage(path, 0);
      expect(result.totals.input).toBe(expectedInput);
    } finally {
      // Let overdue probe ticks fire before tearing the interval down. A probe
      // delayed by blocking work is queued as a timer macrotask; clearing the
      // interval synchronously here would run ahead of it (in a microtask) and
      // mask the very lag we are measuring.
      await new Promise((resolve) => setTimeout(resolve, 0));
      clearInterval(probe);
    }

    // Streaming keeps each turn short. A whole-file read would block for the
    // entire parse and blow this budget.
    expect(maxLag).toBeLessThan(LAG_BUDGET_MS);
  });
});
