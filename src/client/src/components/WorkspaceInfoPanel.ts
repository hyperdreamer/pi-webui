import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { piWebUiApi, type SystemInfoResponse } from "../api";
import type { WorkspacePanelContext } from "../plugins/types";
import { workspacePanelStyles } from "./shared";

@customElement("workspace-info-panel")
export class WorkspaceInfoPanel extends LitElement {
  @property({ attribute: false }) context: WorkspacePanelContext | undefined;
  @state() private systemInfo: SystemInfoResponse | undefined;
  @state() private loading = false;
  @state() private error = "";

  private machineId = "local";

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has("context")) {
      const context = this.context;
      if (context !== undefined) {
        this.machineId = context.machine.id;
        void this.loadSystemInfo();
      }
    }
  }

  private async loadSystemInfo(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      const sysInfo = await piWebUiApi.systemInfo(this.machineId);
      // Only apply if still on the same machine
      if (this.context === undefined || this.context.machine.id === this.machineId) {
        this.systemInfo = sysInfo;
      }
    } catch (err) {
      if (this.context === undefined || this.context.machine.id === this.machineId) {
        this.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (this.context === undefined || this.context.machine.id === this.machineId) {
        this.loading = false;
      }
    }
  }

  override render(): TemplateResult {
    if (this.loading) {
      return html`<section class="info-panel"><p class="muted">Loading system information…</p></section>`;
    }
    if (this.error !== "") {
      return html`<section class="info-panel">
        <p class="error-text">Failed to load system information: ${this.error}</p>
        <button @click=${() => { void this.loadSystemInfo(); }}>Retry</button>
      </section>`;
    }
    const info = this.systemInfo;
    if (info === undefined) {
      return html`<section class="info-panel"><p class="muted">System information unavailable.</p></section>`;
    }
    return html`<section class="info-panel">
      <div class="toolbar">
        <strong>System Info</strong>
        <button @click=${() => { void this.loadSystemInfo(); }}>Refresh</button>
      </div>
      <div class="info-content">
        ${this.renderVersionSection(info)}
        ${this.renderOsSection(info)}
        ${this.renderHardwareSection(info)}
        ${this.renderNetworkSection(info)}
      </div>
    </section>`;
  }

  private renderVersionSection(info: SystemInfoResponse): TemplateResult {
    return html`
      <section class="info-section">
        <h3>Versions</h3>
        <table class="info-table">
          <tbody>
            <tr>
              <td class="info-label">PI WEBUI</td>
              <td class="info-value">${info.piWebUiVersion ?? "unknown"}</td>
            </tr>
            <tr>
              <td class="info-label">Pi Agent</td>
              <td class="info-value">${info.piVersion ?? "unknown"}</td>
            </tr>
          </tbody>
        </table>
      </section>
    `;
  }

  private renderOsSection(info: SystemInfoResponse): TemplateResult {
    const os = info.os;
    return html`
      <section class="info-section">
        <h3>System</h3>
        <table class="info-table">
          <tbody>
            <tr>
              <td class="info-label">Platform</td>
              <td class="info-value">${os.platform}</td>
            </tr>
            <tr>
              <td class="info-label">Release</td>
              <td class="info-value">${os.release}</td>
            </tr>
            <tr>
              <td class="info-label">Architecture</td>
              <td class="info-value">${os.arch}</td>
            </tr>
            <tr>
              <td class="info-label">Uptime</td>
              <td class="info-value">${formatUptime(os.uptimeSeconds)}</td>
            </tr>
          </tbody>
        </table>
      </section>
      ${this.renderBrowserSection()}
    `;
  }

  private renderBrowserSection(): TemplateResult {
    if (typeof navigator === "undefined") return html``;
    const ua = navigator.userAgent;
    const browser = parseBrowser(ua);
    return html`
      <section class="info-section">
        <h3>Browser</h3>
        <table class="info-table">
          <tbody>
            <tr>
              <td class="info-label">Name</td>
              <td class="info-value">${browser.name}</td>
            </tr>
            <tr>
              <td class="info-label">Version</td>
              <td class="info-value">${browser.version}</td>
            </tr>
            <tr>
              <td class="info-label">Platform</td>
              <td class="info-value">${navigator.platform}</td>
            </tr>
            <tr>
              <td class="info-label">Language</td>
              <td class="info-value">${navigator.language}</td>
            </tr>
          </tbody>
        </table>
      </section>
    `;
  }

  private renderHardwareSection(info: SystemInfoResponse): TemplateResult {
    const cpu = info.cpu;
    const mem = info.memory;
    const gpu = info.gpu;
    return html`
      <section class="info-section">
        <h3>Hardware</h3>
        <table class="info-table">
          <tbody>
            <tr>
              <td class="info-label">CPU</td>
              <td class="info-value">${cpu.model}</td>
            </tr>
            <tr>
              <td class="info-label">CPU Cores</td>
              <td class="info-value">${String(cpu.cores)}</td>
            </tr>
            <tr>
              <td class="info-label">CPU Usage</td>
              <td class="info-value">${progressBar(cpu.usagePercent, cpu.usagePercent > 80 ? "high" : "normal")}</td>
            </tr>
            <tr>
              <td class="info-label">Memory</td>
              <td class="info-value">${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)} (${String(mem.usagePercent)}%)</td>
            </tr>
          </tbody>
        </table>
        ${gpu === undefined ? null : this.renderGpuSection(gpu)}
      </section>
    `;
  }

  private renderGpuSection(gpu: NonNullable<SystemInfoResponse["gpu"]>): TemplateResult {
    const rows: TemplateResult[] = [
      html`<tr><td class="info-label">GPU Name</td><td class="info-value">${gpu.name}</td></tr>`,
    ];
    if (gpu.driverVersion !== undefined) {
      rows.push(html`<tr><td class="info-label">Driver</td><td class="info-value">${gpu.driverVersion}</td></tr>`);
    }
    if (gpu.memoryTotalBytes !== undefined && gpu.memoryUsedBytes !== undefined) {
      const memUsed = formatBytes(gpu.memoryUsedBytes);
      const memTotal = formatBytes(gpu.memoryTotalBytes);
      const memPct = gpu.memoryTotalBytes === 0 ? 0 : Math.round((gpu.memoryUsedBytes / gpu.memoryTotalBytes) * 100);
      rows.push(html`<tr><td class="info-label">GPU Memory</td><td class="info-value">${memUsed} / ${memTotal} (${String(memPct)}%)</td></tr>`);
    }
    if (gpu.utilizationPercent !== undefined) {
      rows.push(html`<tr><td class="info-label">GPU Utilisation</td><td class="info-value">${progressBar(gpu.utilizationPercent, gpu.utilizationPercent > 80 ? "high" : "normal")}</td></tr>`);
    }
    if (gpu.temperatureCelsius !== undefined) {
      rows.push(html`<tr><td class="info-label">GPU Temp</td><td class="info-value">${String(gpu.temperatureCelsius)}°C</td></tr>`);
    }
    return html`
      <h4 class="info-subheading">GPU</h4>
      <table class="info-table">
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private renderNetworkSection(info: SystemInfoResponse): TemplateResult {
    const net = info.network;
    return html`
      <section class="info-section">
        <h3>Network</h3>
        <table class="info-table">
          <tbody>
            <tr>
              <td class="info-label">Hostname</td>
              <td class="info-value">${net.hostname}</td>
            </tr>
            <tr>
              <td class="info-label"><span class="network-speed-arrow download" aria-hidden="true">↓</span> Download</td>
              <td class="info-value">${formatTransferRate(net.downloadSpeedBytesPerSecond)}</td>
            </tr>
            <tr>
              <td class="info-label"><span class="network-speed-arrow upload" aria-hidden="true">↑</span> Upload</td>
              <td class="info-value">${formatTransferRate(net.uploadSpeedBytesPerSecond)}</td>
            </tr>
            ${net.publicIpv4 === undefined ? null : html`
              <tr>
                <td class="info-label">Public IPv4</td>
                <td class="info-value">${net.publicIpv4}</td>
              </tr>
            `}
            ${net.publicIpv6 === undefined ? null : html`
              <tr>
                <td class="info-label">Public IPv6</td>
                <td class="info-value"><code class="ip-address">${net.publicIpv6}</code></td>
              </tr>
            `}
          </tbody>
        </table>
        ${net.localIpv4Addresses.length === 0 ? null : html`
          <h4 class="info-subheading">Local IPv4 Addresses</h4>
          <table class="info-table">
            <tbody>
              ${net.localIpv4Addresses.map((addr) => html`
                <tr>
                  <td class="info-label">LAN</td>
                  <td class="info-value"><code class="ip-address">${addr}</code></td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      </section>
    `;
  }

  static override styles = [
    workspacePanelStyles,
    css`
      :host { flex: 1 1 auto; }
      .info-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .info-content { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px; display: grid; gap: 16px; align-content: start; }
      .info-section { display: grid; gap: 4px; }
      .info-section h3 { margin: 0 0 6px; color: var(--pi-text-bright); font-size: 13px; font-weight: 650; }
      .info-subheading { margin: 8px 0 2px; color: var(--pi-muted); font-size: 12px; font-weight: 600; }
      .info-table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.5; }
      .info-table td { padding: 3px 0; vertical-align: top; }
      .info-label { width: 110px; color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
      .info-value { min-width: 0; overflow-wrap: anywhere; color: var(--pi-text); }
      .network-speed-arrow { display: inline-block; width: 1em; font-weight: 700; }
      .network-speed-arrow.download { color: var(--pi-accent); }
      .network-speed-arrow.upload { color: var(--pi-success); }
      .info-value code.ip-address {
        display: inline-block;
        font-family: var(--pi-mono, ui-monospace, monospace);
        font-size: 12px;
        background: var(--pi-surface);
        border: 1px solid var(--pi-border-muted);
        border-radius: 4px;
        padding: 1px 6px;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .progress-bar-track {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        min-width: 0;
      }
      .progress-bar-fill-outer {
        flex: 0 1 120px;
        min-width: 60px;
        height: 8px;
        border: 1px solid var(--pi-border);
        border-radius: 999px;
        background: var(--pi-surface);
        overflow: hidden;
      }
      .progress-bar-fill-inner {
        height: 100%;
        border-radius: 999px;
        background: var(--pi-accent);
        transition: width .3s ease;
      }
      .progress-bar-fill-inner.high { background: var(--pi-danger); }
      .progress-bar-label { flex: 0 0 auto; font-size: 12px; color: var(--pi-muted); white-space: nowrap; }
      .error-text { color: var(--pi-danger); margin: 10px; }
    `,
  ];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${String(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${formatScaled(kib)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${formatScaled(mib)} MB`;
  const gib = mib / 1024;
  return `${formatScaled(gib)} GB`;
}

function formatScaled(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function formatTransferRate(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "Unavailable";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return `${String(hours)}h ${String(remainderMinutes)}m`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return `${String(days)}d ${String(remainderHours)}h`;
}

function progressBar(percent: number, tone: "normal" | "high"): TemplateResult {
  const pct = Math.round(Math.max(0, Math.min(100, percent)));
  return html`
    <span class="progress-bar-track">
      <span class="progress-bar-fill-outer">
        <span class="progress-bar-fill-inner${tone === "high" ? " high" : ""}" style="width:${String(pct)}%"></span>
      </span>
      <span class="progress-bar-label">${String(pct)}%</span>
    </span>
  `;
}

interface BrowserInfo {
  name: string;
  version: string;
}

function parseBrowser(ua: string): BrowserInfo {
  const patterns: { name: string; regex: RegExp }[] = [
    { name: "Edge", regex: /Edg(?:e|A|iOS)?\/(\d+[\d.]*)/ },
    { name: "Chrome", regex: /(?:Chrome|CriOS)\/(\d+[\d.]*)/ },
    { name: "Firefox", regex: /(?:Firefox|FxiOS)\/(\d+[\d.]*)/ },
    { name: "Safari", regex: /Version\/(\d+[\d.]*).*Safari\// },
    { name: "Opera", regex: /(?:OPR|Opera|OPiOS)\/(\d+[\d.]*)/ },
  ];

  for (const { name, regex } of patterns) {
    const match = regex.exec(ua);
    if (match?.[1] !== undefined) {
      return { name, version: match[1] };
    }
  }

  return { name: "Unknown", version: "unknown" };
}
