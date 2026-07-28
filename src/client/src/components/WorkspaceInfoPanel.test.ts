import { afterEach, describe, expect, it, vi } from "vitest";
import { piWebUiApi, type SystemInfoResponse } from "../api";
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceInfoPanel", () => {
  it("renders Download and Upload labels with arrows after their rates", () => {
    const panel = new WorkspaceInfoPanel();
    Object.assign(panel, { systemInfo: systemInfoWithTransferRates() });

    const text = templateText(panel.render());

    expect(text).toContain('<td class="info-label">Download</td>');
    expect(text).toContain('<td class="info-value">1.4 MB/s<span class="network-speed-arrow download" aria-hidden="true">↓</span></td>');
    expect(text).toContain('<td class="info-label">Upload</td>');
    expect(text).toContain('<td class="info-value">244 KB/s<span class="network-speed-arrow upload" aria-hidden="true">↑</span></td>');
    const styles = workspaceInfoPanelStyles();
    expect(styles).toContain(".network-speed-arrow { display: inline-block; width: 1em; margin-left: 6px; font-weight: 700; }");
  });

  it("renders public IPv4 and IPv6 addresses in separate WAN subsections", () => {
    const panel = new WorkspaceInfoPanel();
    const systemInfo = systemInfoWithTransferRates();
    Object.assign(panel, {
      systemInfo: {
        ...systemInfo,
        network: {
          ...systemInfo.network,
          publicIpv4: "198.51.100.44",
          publicIpv6: "2001:db8::44",
          localIpv4Addresses: ["192.0.2.44"],
        },
      },
    });

    const text = templateText(panel.render());

    expect(text).toContain("Public IPv4 Addresses");
    expect(text).toContain("Public IPv6 Addresses");
    expect(text.match(/<td class="info-label">WAN<\/td>/g) ?? []).toHaveLength(2);
    expect(text).toMatch(
      /<h4 class="info-subheading">Public IPv4 Addresses<\/h4>\s*<table class="info-table">\s*<tbody>\s*<tr>\s*<td class="info-label">WAN<\/td>\s*<td class="info-value"><code class="ip-address">198\.51\.100\.44<\/code><\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/,
    );
    expect(text).toMatch(
      /<h4 class="info-subheading">Public IPv6 Addresses<\/h4>\s*<table class="info-table">\s*<tbody>\s*<tr>\s*<td class="info-label">WAN<\/td>\s*<td class="info-value"><code class="ip-address">2001:db8::44<\/code><\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/,
    );
    expect(text).toMatch(
      /<h4 class="info-subheading">Local IPv4 Addresses<\/h4>\s*<table class="info-table">\s*<tbody>\s*<tr>\s*<td class="info-label">LAN<\/td>\s*<td class="info-value"><code class="ip-address">192\.0\.2\.44<\/code><\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/,
    );
    expect(text).not.toContain('<td class="info-label">Public IPv4</td>');
    expect(text).not.toContain('<td class="info-label">Public IPv6</td>');
  });

  it("renders public IPv4 and IPv6 subsections independently", () => {
    const ipv4OnlyPanel = new WorkspaceInfoPanel();
    const ipv4OnlySystemInfo = systemInfoWithTransferRates();
    Object.assign(ipv4OnlyPanel, {
      systemInfo: {
        ...ipv4OnlySystemInfo,
        network: { ...ipv4OnlySystemInfo.network, publicIpv4: "198.51.100.45" },
      },
    });

    const ipv4OnlyText = templateText(ipv4OnlyPanel.render());

    expect(ipv4OnlyText).toContain("Public IPv4 Addresses");
    expect(ipv4OnlyText).not.toContain("Public IPv6 Addresses");
    expect(ipv4OnlyText).toMatch(
      /<h4 class="info-subheading">Public IPv4 Addresses<\/h4>\s*<table class="info-table">\s*<tbody>\s*<tr>\s*<td class="info-label">WAN<\/td>\s*<td class="info-value"><code class="ip-address">198\.51\.100\.45<\/code><\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/,
    );

    const ipv6OnlyPanel = new WorkspaceInfoPanel();
    const ipv6OnlySystemInfo = systemInfoWithTransferRates();
    Object.assign(ipv6OnlyPanel, {
      systemInfo: {
        ...ipv6OnlySystemInfo,
        network: { ...ipv6OnlySystemInfo.network, publicIpv6: "2001:db8::45" },
      },
    });

    const ipv6OnlyText = templateText(ipv6OnlyPanel.render());

    expect(ipv6OnlyText).toContain("Public IPv6 Addresses");
    expect(ipv6OnlyText).not.toContain("Public IPv4 Addresses");
    expect(ipv6OnlyText).toMatch(
      /<h4 class="info-subheading">Public IPv6 Addresses<\/h4>\s*<table class="info-table">\s*<tbody>\s*<tr>\s*<td class="info-label">WAN<\/td>\s*<td class="info-value"><code class="ip-address">2001:db8::45<\/code><\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/,
    );
  });

  it("polls dynamic memory and network metrics without overlapping requests", async () => {
    const panel = new WorkspaceInfoPanel();
    const initial = systemInfoWithTransferRates();
    const metrics = {
      generatedAt: "2026-03-10T12:00:02.000Z",
      memory: { totalBytes: 1_000, usedBytes: 750, freeBytes: 250, usagePercent: 75 },
      network: { downloadSpeedBytesPerSecond: 2_500_000, uploadSpeedBytesPerSecond: 500_000 },
    };
    const nextMetrics = deferred<typeof metrics>();
    const systemInfo = vi.spyOn(piWebUiApi, "systemInfo").mockResolvedValue(initial);
    const systemMetrics = vi.spyOn(piWebUiApi, "systemMetrics").mockReturnValue(nextMetrics.promise);
    let poll: (() => void) | undefined;
    const setInterval = vi.fn<(callback: () => void, delay: number) => number>((callback) => {
      poll = callback;
      return 42;
    });
    const clearInterval = vi.fn<(timer: number) => void>();
    vi.stubGlobal("window", { setInterval, clearInterval });
    Object.defineProperty(panel, "context", { configurable: true, value: infoPanelContext("local") });
    Object.defineProperty(panel, "isConnected", { configurable: true, value: true });
    Reflect.set(panel, "machineId", "local");

    await loadSystemInfo(panel, "local");

    expect(systemInfo).toHaveBeenCalledWith("local");
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 2_000);
    if (poll === undefined) throw new Error("Dynamic metrics polling did not start");
    poll();
    poll();
    expect(systemMetrics).toHaveBeenCalledOnce();

    nextMetrics.resolve(metrics);
    await vi.waitFor(() => {
      expect(Reflect.get(panel, "systemInfo")).toEqual({
        ...initial,
        memory: metrics.memory,
        network: { ...initial.network, ...metrics.network },
      });
    });

    const stopPolling = panelMethod(panel, "stopDynamicMetricsPolling");
    expect(stopPolling).toBeDefined();
    stopPolling?.();
    expect(clearInterval).toHaveBeenCalledWith(42);
  });

  it("loads system information only when the context machine changes", () => {
    const panel = new WorkspaceInfoPanel();
    const systemInfo = vi.spyOn(piWebUiApi, "systemInfo").mockReturnValue(new Promise<SystemInfoResponse>(() => undefined));
    const localContext = infoPanelContext("local");
    const refreshedLocalContext = infoPanelContext("local");

    updatePanelContext(panel, localContext, undefined);
    updatePanelContext(panel, refreshedLocalContext, localContext);
    updatePanelContext(panel, infoPanelContext("remote-a"), refreshedLocalContext);

    expect(systemInfo).toHaveBeenCalledTimes(2);
    expect(systemInfo).toHaveBeenNthCalledWith(1, "local");
    expect(systemInfo).toHaveBeenNthCalledWith(2, "remote-a");
  });
});

function loadSystemInfo(panel: WorkspaceInfoPanel, machineId: string): Promise<void> {
  const load: unknown = Reflect.get(panel, "loadSystemInfo");
  if (!isSystemInfoLoader(load)) throw new Error("System information loader was unavailable");
  return load.call(panel, machineId);
}

function panelMethod(panel: WorkspaceInfoPanel, name: string): (() => void) | undefined {
  const method: unknown = Reflect.get(panel, name);
  if (!isVoidMethod(method)) return undefined;
  return () => { method.call(panel); };
}

function isSystemInfoLoader(value: unknown): value is (machineId: string) => Promise<void> {
  return typeof value === "function";
}

function isVoidMethod(value: unknown): value is () => void {
  return typeof value === "function";
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

function workspaceInfoPanelStyles(): string {
  const styles = WorkspaceInfoPanel.styles;
  const styleResults = Array.isArray(styles) ? styles : [styles];
  return styleResults.map((style) => style.cssText).join("\n");
}

function infoPanelContext(machineId: string): { machine: { id: string } } {
  return { machine: { id: machineId } };
}

function updatePanelContext(panel: WorkspaceInfoPanel, context: { machine: { id: string } }, previous: unknown): void {
  if (!Reflect.set(panel, "context", context)) throw new Error("Could not set the panel context");
  const willUpdate: unknown = Reflect.get(panel, "willUpdate");
  if (typeof willUpdate !== "function") throw new Error("The panel update lifecycle was unavailable");
  willUpdate.call(panel, new Map([["context", previous]]));
}
