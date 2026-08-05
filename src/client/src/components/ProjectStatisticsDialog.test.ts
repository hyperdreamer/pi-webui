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

  it("renders identifiable metric pairs for the narrow table contract", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    const usageReport = report();
    usageReport.buckets.live = {
      input: 111_111,
      output: 222_222,
      cacheRead: 3_333_333,
      cacheWrite: 44_444,
      cost: 1.5,
      sessionCount: 3,
    };
    element.report = usageReport;
    document.body.append(element);
    await element.updateComplete;

    const row = element.renderRoot.querySelector("tbody tr");
    expect(row?.querySelector("th[scope='row']")?.textContent).toContain("Live workspaces");
    expect(row?.querySelector(".usage-cost-cell")?.textContent.trim()).toBe("$1.5000");
    expect([...row?.querySelectorAll(".usage-token-cell") ?? []].map((cell) => ({
      label: cell.querySelector(".usage-metric-label")?.textContent.trim(),
      value: cell.querySelector(".usage-metric-value")?.textContent.trim(),
    }))).toEqual([
      { label: "Input", value: "111,111" },
      { label: "Output", value: "222,222" },
      { label: "Cache read", value: "3.3M" },
      { label: "Cache write", value: "44,444" },
    ]);

    const narrowStyles = ProjectStatisticsDialog.styles.cssText.slice(
      ProjectStatisticsDialog.styles.cssText.indexOf("@media (max-width: 760px)"),
    );
    expect(narrowStyles).toMatch(/\.usage-cost-cell\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/);
    expect(narrowStyles).toMatch(/\.usage-token-cell\s*\{[^}]*grid-column:\s*1 \/ -1;/);
    expect(narrowStyles).toMatch(/\.usage-metric-label\s*\{[^}]*display:\s*block;/);
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
    const spinner = element.renderRoot.querySelector(".usage-spinner");
    expect(spinner?.getAttribute("role")).toBe("progressbar");
    expect(spinner?.getAttribute("aria-label")).toBe("Scanning project sessions");
    expect(element.renderRoot.querySelector(".usage-scanning")?.getAttribute("role")).toBe("status");
    element.remove();
  });

  it("renders an idle state when no report is available and no scan is running", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    document.body.append(element);
    await element.updateComplete;

    expect(element.renderRoot.textContent).toContain("Usage data is not available.");
    expect(element.renderRoot.textContent).not.toContain("Scanning");
    expect(element.renderRoot.querySelector(".usage-spinner")).toBeNull();
    element.remove();
  });

  it("keeps the narrow dialog frame within the viewport contract", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    document.body.append(element);
    await element.updateComplete;

    expect(element.renderRoot.querySelector(".backdrop")).not.toBeNull();
    expect(element.renderRoot.querySelector("section[role='dialog']")).not.toBeNull();
    const styles = ProjectStatisticsDialog.styles.cssText;
    expect(styles).toMatch(/\*\s*\{[^}]*box-sizing:\s*border-box;/);
    const narrowStyles = styles.slice(styles.indexOf("@media (max-width: 760px)"));
    expect(narrowStyles).toMatch(/\.backdrop\s*\{[^}]*padding:\s*0;/);
    expect(narrowStyles).toMatch(/section\[role="dialog"\]\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*border:\s*0;[^}]*border-radius:\s*0;/);
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
