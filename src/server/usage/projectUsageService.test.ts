import { describe, expect, it, vi } from "vitest";
import { ProjectUsageService, type ProjectUsageCandidateSource } from "./projectUsageService";
import type { UsageTotals } from "./sessionUsageScanner";

function totals(input: number, cost: number): UsageTotals {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, cost };
}

function candidateSource(overrides: Partial<ProjectUsageCandidateSource> = {}): ProjectUsageCandidateSource {
  return {
    listForCwd: () => Promise.resolve([]),
    listAll: () => Promise.resolve([]),
    listArchived: () => Promise.resolve([]),
    ...overrides,
  };
}

describe("ProjectUsageService", () => {
  it("sums buckets and the project total", async () => {
    const service = new ProjectUsageService({
      candidates: candidateSource({
        listForCwd: (cwd) => Promise.resolve(cwd === "/dev/app" ? [{ id: "live1", path: "/store/live1.jsonl", cwd: "/dev/app" }] : []),
        listAll: () => Promise.resolve([
          { id: "live1", path: "/store/live1.jsonl", cwd: "/dev/app" },
          { id: "gone1", path: "/store/gone1.jsonl", cwd: "/dev/app/.worktrees/gone" },
          { id: "other", path: "/store/other.jsonl", cwd: "/dev/app-sibling" },
        ]),
        listArchived: () => Promise.resolve([{ sessionId: "arch1", cwd: "/dev/app", archivePath: "/archive/arch1.jsonl" }]),
      }),
      cache: {
        totalsFor: (sessionId) => {
          if (sessionId === "live1") return Promise.resolve(totals(10, 0.1));
          if (sessionId === "gone1") return Promise.resolve(totals(100, 1));
          if (sessionId === "arch1") return Promise.resolve(totals(1000, 10));
          return Promise.resolve(totals(0, 0));
        },
        flush: () => Promise.resolve(undefined),
      },
      now: () => new Date("2026-08-05T00:00:00.000Z"),
    });

    const report = await service.report({ projectPath: "/dev/app", liveCwds: ["/dev/app"] });

    expect(report.buckets.live).toEqual({ ...totals(10, 0.1), sessionCount: 1 });
    expect(report.buckets.retired).toEqual({ ...totals(100, 1), sessionCount: 1 });
    expect(report.buckets.archived).toEqual({ ...totals(1000, 10), sessionCount: 1 });
    expect(report.total.input).toBe(1110);
    expect(report.total.cost).toBeCloseTo(11.1);
    expect(report.total.sessionCount).toBe(3);
    expect(report.generatedAt).toBe("2026-08-05T00:00:00.000Z");
    expect(report.projectPath).toBe("/dev/app");
  });

  it("prefers the archive path for archived sessions", async () => {
    const totalsFor = vi.fn(() => Promise.resolve(totals(1, 0.01)));
    const service = new ProjectUsageService({
      candidates: candidateSource({
        listArchived: () => Promise.resolve([{ sessionId: "arch1", cwd: "/dev/app", archivePath: "/archive/arch1.jsonl", originalPath: "/store/arch1.jsonl" }]),
      }),
      cache: { totalsFor, flush: () => Promise.resolve(undefined) },
    });

    await service.report({ projectPath: "/dev/app", liveCwds: [] });
    expect(totalsFor).toHaveBeenCalledWith("arch1", "/archive/arch1.jsonl");
  });

  it("counts a session once when it appears in both the store and the archive", async () => {
    const service = new ProjectUsageService({
      candidates: candidateSource({
        listAll: () => Promise.resolve([{ id: "dup", path: "/store/dup.jsonl", cwd: "/dev/app" }]),
        listArchived: () => Promise.resolve([{ sessionId: "dup", cwd: "/dev/app", archivePath: "/archive/dup.jsonl" }]),
      }),
      cache: { totalsFor: () => Promise.resolve(totals(5, 0.5)), flush: () => Promise.resolve(undefined) },
    });

    const report = await service.report({ projectPath: "/dev/app", liveCwds: [] });
    expect(report.total.sessionCount).toBe(1);
    expect(report.total.input).toBe(5);
    expect(report.buckets.archived.sessionCount).toBe(1);
  });

  it("returns zeroed buckets when no session belongs to the project", async () => {
    const service = new ProjectUsageService({
      candidates: candidateSource({ listAll: () => Promise.resolve([{ id: "x", path: "/store/x.jsonl", cwd: "/elsewhere" }]) }),
      cache: { totalsFor: () => Promise.resolve(totals(9, 9)), flush: () => Promise.resolve(undefined) },
    });

    const report = await service.report({ projectPath: "/dev/app", liveCwds: [] });
    expect(report.total).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessionCount: 0 });
  });

  it("shares one scan between concurrent requests for the same project", async () => {
    const listAll = vi.fn(() => Promise.resolve([{ id: "a", path: "/store/a.jsonl", cwd: "/dev/app" }]));
    const service = new ProjectUsageService({
      candidates: candidateSource({ listAll }),
      cache: { totalsFor: () => Promise.resolve(totals(2, 0.2)), flush: () => Promise.resolve(undefined) },
    });

    const [first, second] = await Promise.all([
      service.report({ projectPath: "/dev/app", liveCwds: [] }),
      service.report({ projectPath: "/dev/app", liveCwds: [] }),
    ]);

    expect(listAll).toHaveBeenCalledTimes(1);
    expect(first.total.input).toBe(2);
    expect(second.total.input).toBe(2);
  });

  it("flushes the cache after a report", async () => {
    const flush = vi.fn(() => Promise.resolve(undefined));
    const service = new ProjectUsageService({
      candidates: candidateSource(),
      cache: { totalsFor: () => Promise.resolve(totals(0, 0)), flush },
    });

    await service.report({ projectPath: "/dev/app", liveCwds: [] });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("still flushes when a session scan throws", async () => {
    const flush = vi.fn(() => Promise.resolve(undefined));
    const service = new ProjectUsageService({
      candidates: candidateSource({ listAll: () => Promise.resolve([{ id: "a", path: "/store/a.jsonl", cwd: "/dev/app" }]) }),
      cache: {
        totalsFor: () => Promise.reject(new Error("scan failed")),
        flush,
      },
    });

    await expect(service.report({ projectPath: "/dev/app", liveCwds: [] })).rejects.toThrow("scan failed");
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
