import { describe, expect, it, vi } from "vitest";
import type { TemplateResult } from "lit";
import type { HostSpeechStatus, PiWebUiConfigResponse, PiWebUiConfigValues } from "../../api";
import { findTemplateContaining, templateText, templateValuesAfterMarker } from "../../templateInspection.testSupport";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";
import type { GatewayServerConfigDraft, MachineAccessConfigDraft } from "./settingsConfigDraft";

describe("settings-general-panel copy", () => {
  it("uses factual scope copy for gateway and selected-machine settings", () => {
    const panel = new SettingsGeneralPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = configResponse({ host: "127.0.0.1" });
    panel.machineConfigResponse = configResponse({ pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual/uploads" } });

    const template = panel.render();
    const strings = collectTemplateStrings(template).join("");
    const values = collectTemplateValues(template);

    expect(strings).toContain("<settings-panel-frame");
    expect(strings).toContain("Gateway server fields edit this local gateway. File access and upload defaults edit ");
    expect(strings).toContain("Host, port, and allowed hosts are saved in the gateway config.");
    expect(strings).toContain("External filesystem roots and upload defaults are saved on ");
    expect(values.filter((value) => value === "Lab Mac (remote machine)")).toHaveLength(4);
  });

  it("shows reload copy when selected-machine access config is unavailable", () => {
    const panel = new SettingsGeneralPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = configResponse({ host: "127.0.0.1" });
    panel.machineError = "Failed to load file access/upload config from Lab Mac (remote machine): unsupported";

    const template = panel.render();
    const values = collectTemplateValues(template);

    expect(values).toContain("Save gateway server config");
    expect(values).not.toContain("Save file/upload config");
    expect(values).toContain("Selected-machine file access config is unavailable. Reload before saving file/upload settings.");
    expect(values).toContain("Failed to load file access/upload config from Lab Mac (remote machine): unsupported");
  });

  it("uses frame notices for saved and gateway messages while keeping selected-machine errors scoped", () => {
    const panel = new SettingsGeneralPanel();
    panel.error = "Gateway failed";
    panel.machineError = "Selected-machine failed";
    panel.savedMessage = "Config saved.";

    const values = collectTemplateValues(panel.render());
    const notices = values.find(isSettingsNoticeArray);

    expect(notices).toEqual([
      { type: "error", title: "Gateway server", content: "Gateway failed" },
      { type: "success", content: "Config saved." },
    ]);
    expect(values).toContain("Selected-machine failed");
  });
});

describe("settings-general-panel save payloads", () => {
  it("saves gateway server fields through the gateway save callback only", async () => {
    const panel = new SettingsGeneralPanel();
    const onSave = vi.fn();
    const onSaveMachineConfig = vi.fn();
    const event = new Event("submit", { cancelable: true });
    panel.configResponse = configResponse({
      host: "127.0.0.1",
      port: 8808,
      allowedHosts: ["old.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/gateway"] },
      uploads: { defaultFolder: "gateway/uploads" },
      spawnSessions: true,
    });
    panel.onSave = onSave;
    panel.onSaveMachineConfig = onSaveMachineConfig;
    setPanelProperty(panel, "gatewayDraft", {
      host: " 0.0.0.0 ",
      port: "9000",
      allowedHostsMode: "all",
      allowedHostsText: "ignored.local",
    } satisfies GatewayServerConfigDraft);

    await callPanelPromise(panel, "saveGatewayConfig", event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSave.mock.calls).toEqual([[
      {
        host: "0.0.0.0",
        port: 9000,
        allowedHosts: true,
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: false } },
        pathAccess: { allowedPaths: ["/gateway"] },
        uploads: { defaultFolder: "gateway/uploads" },
        spawnSessions: true,
      },
    ]]);
    expect(onSaveMachineConfig).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "gatewayLocalError")).toBe("");
  });

  it("saves external roots and upload defaults through the selected-machine save callback only", async () => {
    const panel = new SettingsGeneralPanel();
    const onSave = vi.fn();
    const onSaveMachineConfig = vi.fn();
    const event = new Event("submit", { cancelable: true });
    panel.onSave = onSave;
    panel.onSaveMachineConfig = onSaveMachineConfig;
    setPanelProperty(panel, "machineDraft", {
      allowedPathsText: "/tmp\n~/SDKs\n",
      uploadDefaultFolder: " manual\\uploads/. ",
    } satisfies MachineAccessConfigDraft);

    await callPanelPromise(panel, "saveMachineAccessConfig", event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSaveMachineConfig.mock.calls).toEqual([[
      {
        pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
        uploads: { defaultFolder: "manual/uploads" },
      },
    ]]);
    expect(onSave).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "machineLocalError")).toBe("");
  });

  it("keeps invalid upload folders local and does not save selected-machine config", async () => {
    const panel = new SettingsGeneralPanel();
    const onSaveMachineConfig = vi.fn();
    panel.onSaveMachineConfig = onSaveMachineConfig;
    setPanelProperty(panel, "machineDraft", {
      allowedPathsText: "",
      uploadDefaultFolder: "/tmp/uploads",
    } satisfies MachineAccessConfigDraft);

    await callPanelPromise(panel, "saveMachineAccessConfig", new Event("submit", { cancelable: true }));

    expect(onSaveMachineConfig).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "machineLocalError")).toBe("Upload default folder must be workspace-relative.");
  });
});

describe("settings-general-panel host speech settings", () => {
  it("renders an enabled gateway-host card with a system default first and deduplicated voice labels", () => {
    const panel = hostSpeechPanel({
      available: true,
      voices: [
        { name: "Ada", language: "en-US" },
        { name: "Ada", language: "en-US", variant: "duplicate" },
        { name: "Beatriz", language: "pt-BR", variant: "female" },
      ],
    }, { tts: { voice: "Ada", rate: 25 } });

    const card = hostSpeechCard(panel);
    expect(card).toBeDefined();
    if (card === undefined) return;
    const text = templateText(card);
    expect(text).toContain("Text to speech");
    expect(text).toContain("gateway host");
    expect(text).toContain("System default");
    expect(text).toContain("Ada (en-US)");
    expect(text).toContain("Beatriz (pt-BR, female)");
    expect(text.match(/Ada \(en-US\)/gu)).toHaveLength(1);
    expect(collectTemplateStrings(card).join("")).toContain('type="range"');
    expect(collectTemplateStrings(card).join("")).toContain('type="number"');
    expect(templateValuesAfterMarker(card, ".value=").filter((value) => value === "25")).toHaveLength(2);
  });

  it("disables host speech controls and shows the gateway reason when the service is unavailable", () => {
    const panel = hostSpeechPanel({ available: false, reason: "Speech Dispatcher is unavailable.", voices: [] }, { tts: { voice: "Configured voice" } });
    const card = hostSpeechCard(panel);
    expect(card).toBeDefined();
    if (card === undefined) return;
    const text = templateText(card);
    expect(text).toContain("Speech Dispatcher is unavailable.");
    expect(text).toContain("Configured voice (configured)");
    expect(text).not.toContain("Configured voice (no longer available)");
    expect(templateValuesAfterMarker(card, "?disabled=")).toContain(true);
  });

  it("keeps text to speech controls disabled while gateway configuration is loading and rejects a direct save", async () => {
    const panel = new SettingsGeneralPanel();
    const onSave = vi.fn();
    panel.showHostSpeechSettings = true;
    panel.hostSpeechStatus = { available: true, voices: [{ name: "Ada", language: "en-US" }] };
    panel.loading = true;
    panel.onSave = onSave;

    const card = hostSpeechCard(panel);
    expect(card).toBeDefined();
    if (card === undefined) return;
    expect(templateText(card)).toContain("Gateway configuration is still loading");
    expect(templateText(card)).toContain("cannot be saved yet");
    expect(templateValuesAfterMarker(card, "?disabled=")).toEqual([true, true, true, true]);

    await callPanelPromise(panel, "saveHostSpeechConfig", new Event("submit", { cancelable: true }));

    expect(onSave).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "hostSpeechLocalError")).toBe("Reload gateway configuration before saving text to speech settings.");
  });

  it("keeps text to speech controls disabled when gateway configuration is unavailable and rejects a direct save", async () => {
    const panel = new SettingsGeneralPanel();
    const onSave = vi.fn();
    panel.showHostSpeechSettings = true;
    panel.hostSpeechStatus = { available: true, voices: [{ name: "Ada", language: "en-US" }] };
    panel.error = "Failed to load gateway configuration.";
    panel.onSave = onSave;

    const card = hostSpeechCard(panel);
    expect(card).toBeDefined();
    if (card === undefined) return;
    expect(templateText(card)).toContain("Gateway configuration is unavailable");
    expect(templateText(card)).toContain("Reload before saving text to speech settings");
    expect(templateValuesAfterMarker(card, "?disabled=")).toEqual([true, true, true, true]);

    await callPanelPromise(panel, "saveHostSpeechConfig", new Event("submit", { cancelable: true }));

    expect(onSave).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "hostSpeechLocalError")).toBe("Reload gateway configuration before saving text to speech settings.");
  });

  it("omits the host speech card for a remote target even when status is supplied", () => {
    const panel = hostSpeechPanel({ available: true, voices: [{ name: "Ada", language: "en-US" }] });
    panel.showHostSpeechSettings = false;

    expect(hostSpeechCard(panel)).toBeUndefined();
  });

  it("keeps an unavailable configured voice selectable and explains the system-default fallback", () => {
    const panel = hostSpeechPanel({ available: true, voices: [{ name: "Ada", language: "en-US" }] }, { tts: { voice: "Retired voice", rate: 10 } });
    const card = hostSpeechCard(panel);
    expect(card).toBeDefined();
    if (card === undefined) return;
    const text = templateText(card);
    expect(text).toContain("Retired voice");
    expect(text).toContain("no longer available");
    expect(text).toContain("System default");
  });

  it("preserves a dirty host speech draft across unrelated config responses, then accepts its saved response", () => {
    const panel = hostSpeechPanel({ available: true, voices: [] }, { tts: { voice: "Ada", rate: 10 }, host: "127.0.0.1" });
    const initial = panel.configResponse;
    callPanelMethod(panel, "updateHostSpeechDraft", { voice: "Beatriz", rate: "25" });

    const unrelated = configResponse({ tts: { voice: "Ada", rate: 10 }, host: "0.0.0.0" });
    panel.configResponse = unrelated;
    callPanelMethod(panel, "willUpdate", new Map([["configResponse", initial]]));
    expect(getPanelProperty(panel, "hostSpeechDraft")).toEqual({ voice: "Beatriz", rate: "25" });

    const saved = configResponse({ tts: { voice: "Beatriz", rate: 25 }, host: "0.0.0.0" });
    panel.configResponse = saved;
    callPanelMethod(panel, "willUpdate", new Map([["configResponse", unrelated]]));
    expect(getPanelProperty(panel, "hostSpeechDraftDirty")).toBe(false);
  });

  it("saves complete gateway config and reloads host speech only for the local card", async () => {
    const panel = hostSpeechPanel({ available: true, voices: [{ name: "Ada", language: "en-US" }] }, {
      host: "127.0.0.1",
      port: 8808,
      allowedHosts: ["localhost"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/gateway"] },
      uploads: { defaultFolder: "gateway/uploads" },
      spawnSessions: true,
      tts: { voice: "Old", rate: 10 },
    });
    const onSave = vi.fn();
    const onReloadHostSpeech = vi.fn();
    panel.onSave = onSave;
    panel.onReloadHostSpeech = onReloadHostSpeech;
    setPanelProperty(panel, "hostSpeechDraft", { voice: " Ada ", rate: "-20" });

    await callPanelPromise(panel, "saveHostSpeechConfig", new Event("submit", { cancelable: true }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      host: "127.0.0.1",
      port: 8808,
      allowedHosts: ["localhost"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/gateway"] },
      uploads: { defaultFolder: "gateway/uploads" },
      spawnSessions: true,
      tts: { voice: "Ada", rate: -20 },
    });

    callPanelMethod(panel, "reloadAll");
    expect(onReloadHostSpeech).toHaveBeenCalledOnce();

    panel.showHostSpeechSettings = false;
    callPanelMethod(panel, "reloadAll");
    expect(onReloadHostSpeech).toHaveBeenCalledOnce();
  });
});

function collectTemplateStrings(template: TemplateResult): string[] {
  const strings: string[] = [];
  visitTemplate(template);
  return strings;

  function visitTemplate(current: TemplateResult): void {
    strings.push(...templateStrings(current));
    for (const value of templateValues(current)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isTemplateResult(item)) visitTemplate(item);
      } else if (isTemplateResult(value)) {
        visitTemplate(value);
      }
    }
  }
}

function collectTemplateValues(template: TemplateResult): unknown[] {
  const values: unknown[] = [];
  visit(template);
  return values;

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isTemplateResult(current)) return;
    for (const value of templateValues(current)) {
      values.push(value);
      visit(value);
    }
  }
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isSettingsNoticeArray(value: unknown): value is readonly { type: string; content: unknown; title?: string }[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item: unknown) => typeof item === "object" && item !== null && typeof Reflect.get(item, "type") === "string" && Reflect.has(item, "content"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function setPanelProperty(panel: SettingsGeneralPanel, property: string, value: unknown): void {
  if (!Reflect.set(panel, property, value)) throw new Error(`Failed to set SettingsGeneralPanel property ${property}`);
}

function getPanelProperty(panel: SettingsGeneralPanel, property: string): unknown {
  return Reflect.get(panel, property);
}

async function callPanelPromise(panel: SettingsGeneralPanel, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callPanelMethod(panel, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SettingsGeneralPanel.${methodName} did not return a promise`);
  await result;
}

function callPanelMethod(panel: SettingsGeneralPanel, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(panel, methodName);
  if (!isPanelMethod(method)) throw new Error(`SettingsGeneralPanel.${methodName} is not callable`);
  return method.call(panel, ...args);
}

function hostSpeechPanel(status: HostSpeechStatus, config: PiWebUiConfigValues = {}): SettingsGeneralPanel {
  const panel = new SettingsGeneralPanel();
  panel.showHostSpeechSettings = true;
  panel.hostSpeechStatus = status;
  panel.configResponse = configResponse(config);
  callPanelMethod(panel, "willUpdate", new Map([["configResponse", undefined]]));
  return panel;
}

function hostSpeechCard(panel: SettingsGeneralPanel): TemplateResult | undefined {
  return findTemplateContaining(panel.render(), 'aria-label="Text to speech settings"');
}

function isPanelMethod(value: unknown): value is (this: SettingsGeneralPanel, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}

function configResponse(config: PiWebUiConfigValues): PiWebUiConfigResponse {
  return {
    path: "/tmp/pi-webui/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}
