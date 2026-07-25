import { describe, expect, it } from "vitest";
import type { SystemInfoResponse } from "../api";
import { templateText } from "../templateInspection.testSupport";
import { WorkspaceInfoPanel } from "./WorkspaceInfoPanel";

function systemInfoWithTransferRates(): SystemInfoResponse {
  return {
    generatedAt: "2026-03-10T12:00:00.000Z",
    os: { platform: "linux", release: "6.0", arch: "x64", uptimeSeconds: 60 },
    cpu: { model: "CPU", cores: 4, usagePercent: 20 },
    memory: { totalBytes: 1_000, usedBytes: 500, freeBytes: 500, usagePercent: 50 },
    network: {
      hostname: "host",
      localIpv4Addresses: [],
      downloadSpeedBytesPerSecond: 1_500_000,
      uploadSpeedBytesPerSecond: 250_000,
    },
  };
}

describe("WorkspaceInfoPanel", () => {
  it("renders download and upload rates with directional arrows", () => {
    const panel = new WorkspaceInfoPanel();
    Object.assign(panel, { systemInfo: systemInfoWithTransferRates() });

    const text = templateText(panel.render());

    expect(text).toContain('network-speed-arrow download" aria-hidden="true">↓</span> Download');
    expect(text).toContain("1.4 MB/s");
    expect(text).toContain('network-speed-arrow upload" aria-hidden="true">↑</span> Upload');
    expect(text).toContain("244 KB/s");
  });
});
