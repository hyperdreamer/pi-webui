// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { formatUsageTokens, usageBucketRows } from "./ProjectStatisticsDialog";
import type { ProjectUsageResponse } from "../../../shared/apiTypes";

function totals(input: number, sessionCount: number) {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.5, sessionCount };
}

function report(): ProjectUsageResponse {
  return {
    projectPath: "/dev/app",
    buckets: { live: totals(10, 1), retired: totals(20, 2), archived: totals(30, 3) },
    total: totals(60, 6),
    generatedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("formatUsageTokens", () => {
  it("keeps small values exact", () => {
    expect(formatUsageTokens(7574)).toBe((7574).toLocaleString());
  });

  it("compacts values at a million or above", () => {
    expect(formatUsageTokens(93_274_304)).toBe("93.3M");
  });

  it("renders zero as zero", () => {
    expect(formatUsageTokens(0)).toBe("0");
  });
});

describe("usageBucketRows", () => {
  it("returns the three buckets in display order with labels", () => {
    const rows = usageBucketRows(report());
    expect(rows.map((row) => row.key)).toEqual(["live", "retired", "archived"]);
    expect(rows.map((row) => row.label)).toEqual(["Live workspaces", "Retired worktrees", "Archived"]);
    expect(rows[1]?.totals.input).toBe(20);
  });
});

describe("ProjectStatisticsDialog", () => {
  it("renders bucket labels, the total, and the deleted-note when a report is present", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    element.project = { id: "p1", name: "app", path: "/dev/app", createdAt: "2026-08-01T00:00:00.000Z" };
    element.report = report();
    document.body.append(element);
    await element.updateComplete;

    const text = element.renderRoot.textContent;
    expect(text).toContain("Live workspaces");
    expect(text).toContain("Retired worktrees");
    expect(text).toContain("Archived");
    expect(text).toContain("not counted");
    expect(text).toContain(formatUsageTokens(60));
    element.remove();
  });

  it("renders a scanning state with the session count while loading", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    element.loading = true;
    element.sessionCount = 639;
    document.body.append(element);
    await element.updateComplete;

    expect(element.renderRoot.textContent).toContain("639");
    element.remove();
  });

  it("renders the error message when a scan fails", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    element.errorMessage = "scan blew up";
    document.body.append(element);
    await element.updateComplete;

    expect(element.renderRoot.textContent).toContain("scan blew up");
    element.remove();
  });
});
