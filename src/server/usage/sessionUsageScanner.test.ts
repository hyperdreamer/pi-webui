import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addUsageTotals, emptyUsageTotals, readSessionHeaderId, scanSessionUsage, usageTotalsFromLine } from "./sessionUsageScanner";

function usageLine(role: string, usage: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", message: { role, usage } });
}

describe("usageTotalsFromLine", () => {
  it("ignores lines without usage", () => {
    expect(usageTotalsFromLine(JSON.stringify({ type: "message", message: { role: "user" } }))).toBeUndefined();
  });

  it("reads assistant usage with nested cost", () => {
    const line = usageLine("assistant", { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } });
    expect(usageTotalsFromLine(line)).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25 });
  });

  it("reads toolResult usage and numeric cost", () => {
    const line = usageLine("toolResult", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
    expect(usageTotalsFromLine(line)).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
  });

  it("reads branch_summary and compaction usage", () => {
    const branch = JSON.stringify({ type: "branch_summary", usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } });
    const compaction = JSON.stringify({ type: "compaction", usage: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } } });
    expect(usageTotalsFromLine(branch)?.input).toBe(3);
    expect(usageTotalsFromLine(compaction)?.cost).toBeCloseTo(0.2);
  });

  it("ignores user message usage", () => {
    expect(usageTotalsFromLine(usageLine("user", { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: 1 }))).toBeUndefined();
  });

  it("ignores malformed json", () => {
    expect(usageTotalsFromLine('{"usage": broken')).toBeUndefined();
  });
});

describe("addUsageTotals", () => {
  it("sums field by field", () => {
    const left = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 };
    expect(addUsageTotals(left, left)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, cost: 1 });
  });

  it("starts from zero", () => {
    expect(emptyUsageTotals()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });
});

describe("scanSessionUsage", () => {
  it("scans from an offset and reports bytes consumed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-scan-"));
    const path = join(dir, "session.jsonl");
    const header = JSON.stringify({ type: "session", id: "abc", cwd: "/repo" });
    const first = usageLine("assistant", { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } });
    await writeFile(path, `${header}\n${first}\n`, "utf8");

    expect(await readSessionHeaderId(path)).toBe("abc");

    const full = await scanSessionUsage(path, 0);
    expect(full.totals.input).toBe(10);
    expect(full.bytesScanned).toBe(Buffer.byteLength(`${header}\n${first}\n`, "utf8"));

    const second = usageLine("assistant", { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } });
    await writeFile(path, `${header}\n${first}\n${second}\n`, "utf8");
    const appended = await scanSessionUsage(path, full.bytesScanned);
    expect(appended.totals.input).toBe(7);
    expect(appended.totals.cost).toBeCloseTo(0.2);
  });

  it("does not consume a trailing partial line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-partial-"));
    const path = join(dir, "session.jsonl");
    const header = JSON.stringify({ type: "session", id: "abc", cwd: "/repo" });
    const complete = usageLine("assistant", { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } });
    await writeFile(path, `${header}\n${complete}\n{"type":"mess`, "utf8");

    const result = await scanSessionUsage(path, 0);
    expect(result.totals.input).toBe(5);
    expect(result.bytesScanned).toBe(Buffer.byteLength(`${header}\n${complete}\n`, "utf8"));
  });

  it("returns empty totals for a missing file", async () => {
    const result = await scanSessionUsage(join(tmpdir(), "does-not-exist.jsonl"), 0);
    expect(result).toEqual({ totals: emptyUsageTotals(), bytesScanned: 0 });
  });
});
