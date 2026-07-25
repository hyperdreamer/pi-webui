import { type FastifyInstance } from "fastify";
import {
  arch,
  cpus,
  freemem,
  hostname,
  networkInterfaces,
  platform,
  release,
  totalmem,
  uptime,
} from "node:os";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { PiWebUiRuntimeComponent, SystemInfoResponse } from "../shared/apiTypes.js";

const execFileAsync = promisify(execFile);

const PUBLIC_IPV4_SERVICES = [
  "https://api.ipify.org",
  "https://v4.ident.me",
];
const PUBLIC_IPV6_SERVICE = "https://v6.ident.me";
const PUBLIC_IP_TIMEOUT_MS = 4000;

export interface SystemInfoRouteDependencies {
  piWebUiRuntime?: () => Promise<{ components: { web: PiWebUiRuntimeComponent; sessiond: PiWebUiRuntimeComponent } }>;
}

export function registerSystemInfoRoutes(app: FastifyInstance, prefix: string, deps: SystemInfoRouteDependencies = {}): void {
  app.get(`${prefix}/system-info`, async (_request, reply) => {
    try {
      return await collectSystemInfo(deps);
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function collectSystemInfo(deps: SystemInfoRouteDependencies = {}): Promise<SystemInfoResponse> {
  const [gpu, publicIpv4, publicIpv6, versionInfo, networkSpeed] = await Promise.all([
    collectGpuInfo(),
    fetchPublicIpv4(),
    fetchPublicIpv6().catch(() => undefined),
    collectVersionInfo(deps),
    measureNetworkSpeed(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    os: collectOsInfo(),
    cpu: collectCpuInfo(),
    ...(gpu === undefined ? {} : { gpu }),
    memory: collectMemoryInfo(),
    network: collectNetworkInfo(publicIpv4, publicIpv6, networkSpeed),
    ...(versionInfo.piWebUiVersion === undefined ? {} : { piWebUiVersion: versionInfo.piWebUiVersion }),
    ...(versionInfo.piVersion === undefined ? {} : { piVersion: versionInfo.piVersion }),
  };
}

async function collectVersionInfo(deps: SystemInfoRouteDependencies): Promise<{ piWebUiVersion?: string; piVersion?: string }> {
  if (deps.piWebUiRuntime === undefined) return {};
  try {
    const runtime = await deps.piWebUiRuntime();
    const result: { piWebUiVersion?: string; piVersion?: string } = {};
    const webVersion = runtime.components.web.runtimeVersion;
    const sessiondVersion = runtime.components.sessiond.runtimeVersion;
    if (webVersion !== undefined) result.piWebUiVersion = webVersion;
    else if (sessiondVersion !== undefined) result.piWebUiVersion = sessiondVersion;
    const agentCommand = runtime.components.sessiond.activeAgentProfile?.command;
    if (agentCommand !== undefined) {
      const versionOutput = await runAgentVersion(agentCommand);
      if (versionOutput !== undefined) result.piVersion = versionOutput;
    }
    return result;
  } catch {
    return {};
  }
}

async function runAgentVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const firstLine = stdout.trim().split("\n")[0];
    if (firstLine === undefined) return undefined;
    const trimmed = firstLine.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

function collectOsInfo(): SystemInfoResponse["os"] {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    uptimeSeconds: Math.round(uptime()),
  };
}

function collectCpuInfo(): SystemInfoResponse["cpu"] {
  const cpuList = cpus();
  const model = cpuList[0]?.model ?? "Unknown";
  const cores = cpuList.length;

  // Calculate usage from idle time across all cores
  let totalIdle = 0;
  let totalAll = 0;
  for (const cpu of cpuList) {
    const times = cpu.times;
    const idle = times.idle;
    const all = Object.values(times).reduce((sum, val) => sum + val, 0);
    totalIdle += idle;
    totalAll += all;
  }
  // This is a point-in-time snapshot from os.cpus() which returns
  // cumulative ticks since boot. We approximate usage as (1 - idle/total)
  // since the last boot, which gives a rough indication.
  const usagePercent = totalAll === 0 ? 0 : Math.round((1 - totalIdle / totalAll) * 100);

  return { model, cores, usagePercent };
}

async function collectGpuInfo(): Promise<SystemInfoResponse["gpu"] | undefined> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu",
      "--format=csv,noheader,nounits",
    ], { encoding: "utf8", timeout: 5000 });

    const lines = stdout.trim().split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) return undefined;

    // Use the first GPU
    const firstLine = lines[0];
    if (firstLine === undefined) return undefined;
    const fields = firstLine.split(", ").map((s) => s.trim());
    if (fields.length < 7) return undefined;

    const name = fields[1] ?? "NVIDIA GPU";
    const driverVersion = fields[2] === "" ? undefined : fields[2];
    const memoryTotalMb = parseFloat(fields[3] ?? "0");
    const memoryUsedMb = parseFloat(fields[4] ?? "0");
    const utilizationPercent = parseFloat(fields[5] ?? "0");
    const temperatureCelsius = parseFloat(fields[6] ?? "0");

    return {
      name,
      ...(driverVersion === undefined ? {} : { driverVersion }),
      memoryTotalBytes: Math.round(memoryTotalMb * 1024 * 1024),
      memoryUsedBytes: Math.round(memoryUsedMb * 1024 * 1024),
      ...(isNaN(utilizationPercent) ? {} : { utilizationPercent }),
      ...(isNaN(temperatureCelsius) ? {} : { temperatureCelsius }),
    };
  } catch {
    return undefined;
  }
}

function collectMemoryInfo(): SystemInfoResponse["memory"] {
  const totalBytes = totalmem();
  const freeBytes = freemem();
  const usedBytes = totalBytes - freeBytes;
  const usagePercent = totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 100);
  return { totalBytes, usedBytes, freeBytes, usagePercent };
}

async function fetchPublicIpv4(): Promise<string | undefined> {
  for (const service of PUBLIC_IPV4_SERVICES) {
    try {
      const response = await fetch(service, {
        signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const text = (await response.text()).trim();
      if (isValidIpv4(text)) return text;
    } catch {
      // try next service
    }
  }
  return undefined;
}

async function fetchPublicIpv6(): Promise<string | undefined> {
  try {
    const response = await fetch(PUBLIC_IPV6_SERVICE, {
      signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const text = (await response.text()).trim();
    if (isValidIpv6(text)) return text;
  } catch {
    // ignore errors
  }
  return undefined;
}

function isValidIpv4(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split(".").every((p) => {
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

function isValidIpv6(value: string): boolean {
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(":");
}

function collectNetworkInfo(
  publicIpv4: string | undefined,
  publicIpv6: string | undefined,
  speeds: { downloadBytesPerSecond?: number; uploadBytesPerSecond?: number },
): SystemInfoResponse["network"] {
  const localIpv4Addresses: string[] = [];
  const interfaces = networkInterfaces();

  for (const iface of Object.values(interfaces)) {
    if (iface === undefined) continue;
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        localIpv4Addresses.push(addr.address);
      }
    }
  }

  return {
    hostname: hostname(),
    ...(publicIpv4 === undefined ? {} : { publicIpv4 }),
    ...(publicIpv6 === undefined ? {} : { publicIpv6 }),
    localIpv4Addresses,
    ...(speeds.downloadBytesPerSecond === undefined ? {} : { downloadSpeedBytesPerSecond: speeds.downloadBytesPerSecond }),
    ...(speeds.uploadBytesPerSecond === undefined ? {} : { uploadSpeedBytesPerSecond: speeds.uploadBytesPerSecond }),
  };
}

interface NetDevSnapshot {
  rxBytes: number;
  txBytes: number;
}

function readNetDevSnapshot(): NetDevSnapshot | undefined {
  try {
    return parseNetDevSnapshot(readFileSync("/proc/net/dev", "utf8"));
  } catch {
    return undefined;
  }
}

export function parseNetDevSnapshot(content: string): NetDevSnapshot | undefined {
  let rxBytes = 0;
  let txBytes = 0;
  let foundInterface = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("Inter-") || trimmed.startsWith("face")) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 10) continue;
    const ifname = cols[0]?.replace(/:$/, "") ?? "";
    if (ifname === "lo") continue;
    const received = Number.parseInt(cols[1] ?? "", 10);
    const transmitted = Number.parseInt(cols[9] ?? "", 10);
    if (!Number.isFinite(received) || !Number.isFinite(transmitted)) continue;
    foundInterface = true;
    rxBytes += received;
    txBytes += transmitted;
  }
  return foundInterface ? { rxBytes, txBytes } : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function measureNetworkSpeed(): Promise<{ downloadBytesPerSecond?: number; uploadBytesPerSecond?: number }> {
  const first = readNetDevSnapshot();
  if (first === undefined) return {};
  const startedAt = Date.now();
  await sleep(1000);
  const second = readNetDevSnapshot();
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  if (second === undefined || elapsedSeconds <= 0) return {};
  return {
    downloadBytesPerSecond: Math.max(0, Math.round((second.rxBytes - first.rxBytes) / elapsedSeconds)),
    uploadBytesPerSecond: Math.max(0, Math.round((second.txBytes - first.txBytes) / elapsedSeconds)),
  };
}
