import { vi } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import type { Machine, MachineRuntime, PiPackageInfo, PiPackageMutationResponse, PiWebUiConfigResponse, PiWebUiConfigValues, PiWebUiPluginInfo, PiWebUiPluginsResponse, SpeechInputSettingsResponse } from "../api";
import { speechInputApi } from "../api";
import { SettingsDialog } from "./SettingsDialog";

export const remoteMachine: Machine = {
  id: "remote-a",
  name: "Lab Mac",
  kind: "remote",
  baseUrl: "https://lab.example.test",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

export const secondRemoteMachine: Machine = {
  id: "remote-b",
  name: "Build Box",
  kind: "remote",
  baseUrl: "https://build.example.test",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

export const runtimeWithPackageManagement: MachineRuntime = {
  machineId: "remote-a",
  ok: true,
  checkedAt: "2026-07-01T00:00:00.000Z",
  capabilities: [PI_WEBUI_CAPABILITIES.piPackagesManage],
};

export function getDialogProperty(dialog: SettingsDialog, property: string): unknown {
  return Reflect.get(dialog, property);
}

export function setDialogProperty(dialog: SettingsDialog, property: string, value: unknown): void {
  if (!Reflect.set(dialog, property, value)) throw new Error(`Failed to set SettingsDialog property ${property}`);
}

export async function callDialogPromise(dialog: SettingsDialog, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callDialogMethod(dialog, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SettingsDialog.${methodName} did not return a promise`);
  await result;
}

export function callDialogUpdated(dialog: SettingsDialog, changed: Map<string, unknown>): void {
  const result = callDialogMethod(dialog, "updated", changed);
  if (result !== undefined) throw new Error("SettingsDialog.updated returned an unexpected value");
}

function callDialogMethod(dialog: SettingsDialog, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(dialog, methodName);
  if (!isDialogMethod(method)) throw new Error(`SettingsDialog.${methodName} is not callable`);
  return method.call(dialog, ...args);
}

function isDialogMethod(value: unknown): value is (this: SettingsDialog, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}

export function configResponse(config: PiWebUiConfigValues): PiWebUiConfigResponse {
  return {
    path: "/tmp/pi-webui/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}

export function speechInputSettingsResponse(overrides: Partial<SpeechInputSettingsResponse> = {}): SpeechInputSettingsResponse {
  return {
    contractVersion: 1,
    revision: "00000000-0000-4000-8000-000000000001",
    settings: {
      provider: "auto",
      cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" },
    },
    credential: { configured: false, resolution: "missing" },
    ...overrides,
  };
}

export function pluginsResponse(plugins: PiWebUiPluginInfo[]): PiWebUiPluginsResponse {
  return { plugins };
}

if (typeof document === "undefined") {
  vi.spyOn(speechInputApi, "settings").mockResolvedValue(speechInputSettingsResponse());
}

export function pluginInfo(id: string, enabled: boolean): PiWebUiPluginInfo {
  return {
    id,
    module: `/pi-webui-plugins/${id}/plugin.js`,
    source: "test",
    scope: "local",
    machineSpecific: false,
    enabled,
  };
}

export function packageInfo(source: string): PiPackageInfo {
  return { source, scope: "user", filtered: false, installedPath: `/pi/packages/${source}` };
}

export function packageMutationResponse(action: PiPackageMutationResponse["action"], packages: PiPackageInfo[], source?: string): PiPackageMutationResponse {
  return source === undefined ? { action, packages } : { action, source, packages };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (resolveDeferred === undefined || rejectDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

export function stubWindowTimers(): void {
  vi.stubGlobal("window", {
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(() => 1),
  });
}
