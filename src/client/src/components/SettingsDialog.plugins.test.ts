import { afterEach, describe, expect, it, vi } from "vitest";
import { configApi, pluginsApi, type PiWebUiConfigResponse, type PiWebUiPluginsResponse } from "../api";
import { SettingsDialog } from "./SettingsDialog";
import { callDialogPromise, callDialogUpdated, configResponse, deferred, getDialogProperty, pluginInfo, pluginsResponse, remoteMachine, secondRemoteMachine, setDialogProperty, stubWindowTimers } from "./SettingsDialog.testSupport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog plugin settings machine targeting", () => {
  it("loads plugin config and plugin list from the selected machine", async () => {
    const config = configResponse({ plugins: { info: { enabled: true } } });
    const plugins = pluginsResponse([pluginInfo("info", true)]);
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(config);
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(plugins);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadPluginsForTarget");

    expect(configSpy.mock.calls).toEqual([["remote-a"]]);
    expect(pluginsSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBe(plugins);
    expect(getDialogProperty(dialog, "pluginError")).toBe("");
    expect(getDialogProperty(dialog, "pluginLoading")).toBe(false);
  });

  it("keeps fulfilled plugin config when the selected machine plugin list is unsupported", async () => {
    const config = configResponse({ plugins: { info: { enabled: true } } });
    vi.spyOn(configApi, "config").mockResolvedValue(config);
    vi.spyOn(pluginsApi, "plugins").mockRejectedValue(new Error("route GET:/api/plugins not found"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadPluginsForTarget");

    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "pluginError")).toBe("Failed to load PI WEBUI plugin settings from Lab Mac (remote machine): PI WEBUI plugins: Selected-machine settings are not available on Lab Mac. Update and restart PI WEBUI on that machine, then try again.");
    expect(getDialogProperty(dialog, "pluginLoading")).toBe(false);
  });

  it("saves selected-machine plugin toggles as plugin-only patches and refreshes the selected machine plugin list", async () => {
    stubWindowTimers();
    const baseConfig = configResponse({
      plugins: {
        keep: { enabled: true, settings: { level: 1 } },
        info: { settings: { color: "blue" } },
      },
    });
    const savedConfig = configResponse({
      plugins: {
        keep: { enabled: true, settings: { level: 1 } },
        info: { enabled: false, settings: { color: "blue" } },
      },
    });
    const refreshedPlugins = pluginsResponse([pluginInfo("info", false), pluginInfo("keep", true)]);
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(refreshedPlugins);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    setDialogProperty(dialog, "selectedPluginConfigResponse", baseConfig);

    await callDialogPromise(dialog, "togglePlugin", "info", false);

    expect(saveSpy.mock.calls).toEqual([[
      {
        plugins: {
          keep: { enabled: true, settings: { level: 1 } },
          info: { enabled: false, settings: { color: "blue" } },
        },
      },
      "remote-a",
    ]]);
    expect(pluginsSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBe(refreshedPlugins);
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("merges local selected-machine plugin saves into gateway config without dropping gateway-only values", async () => {
    stubWindowTimers();
    const gatewayConfig = configResponse({
      host: "127.0.0.1",
      shortcuts: { "core:view.chat": "mod+1" },
      spawnSessions: false,
      plugins: { info: { enabled: false }, gateway: { settings: { theme: "dark" } } },
    });
    const savedConfig = configResponse({ plugins: { info: { enabled: true }, gateway: { settings: { theme: "dark" } } } });
    const refreshedPlugins = pluginsResponse([pluginInfo("info", true)]);
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    vi.spyOn(pluginsApi, "plugins").mockResolvedValue(refreshedPlugins);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;
    setDialogProperty(dialog, "configResponse", gatewayConfig);
    setDialogProperty(dialog, "selectedPluginConfigResponse", configResponse({ plugins: { info: { enabled: false } } }));

    await callDialogPromise(dialog, "togglePlugin", "info", true);

    expect(saveSpy.mock.calls).toEqual([[{ plugins: { info: { enabled: true } } }, "local"]]);
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBe(refreshedPlugins);
    expect(getDialogProperty(dialog, "configResponse")).toMatchObject({
      config: {
        host: "127.0.0.1",
        shortcuts: { "core:view.chat": "mod+1" },
        spawnSessions: false,
        plugins: { info: { enabled: true }, gateway: { settings: { theme: "dark" } } },
      },
      effectiveConfig: {
        host: "127.0.0.1",
        shortcuts: { "core:view.chat": "mod+1" },
        spawnSessions: false,
        plugins: { info: { enabled: true }, gateway: { settings: { theme: "dark" } } },
      },
    });
    expect(onConfigSaved).toHaveBeenCalledWith({
      host: "127.0.0.1",
      shortcuts: { "core:view.chat": "mod+1" },
      spawnSessions: false,
      plugins: { info: { enabled: true }, gateway: { settings: { theme: "dark" } } },
    });
  });

  it("ignores stale plugin load responses after the selected machine changes", async () => {
    const configLoad = deferred<PiWebUiConfigResponse>();
    const pluginsLoad = deferred<PiWebUiPluginsResponse>();
    vi.spyOn(configApi, "config").mockReturnValue(configLoad.promise);
    vi.spyOn(pluginsApi, "plugins").mockReturnValue(pluginsLoad.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const loadPromise = callDialogPromise(dialog, "loadPluginsForTarget");
    expect(getDialogProperty(dialog, "pluginLoading")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    configLoad.resolve(configResponse({ plugins: { info: { enabled: true } } }));
    pluginsLoad.resolve(pluginsResponse([pluginInfo("info", true)]));
    await loadPromise;

    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "pluginError")).toBe("");
    expect(getDialogProperty(dialog, "pluginLoading")).toBe(false);
  });

  it("ignores stale plugin save responses after the selected machine changes", async () => {
    const save = deferred<PiWebUiConfigResponse>();
    const pluginsSpy = vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([pluginInfo("info", false)]));
    vi.spyOn(configApi, "saveConfig").mockReturnValue(save.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    setDialogProperty(dialog, "selectedPluginConfigResponse", configResponse({ plugins: { info: { enabled: true } } }));

    const savePromise = callDialogPromise(dialog, "togglePlugin", "info", false);
    expect(getDialogProperty(dialog, "saving")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    save.resolve(configResponse({ plugins: { info: { enabled: false } } }));
    await savePromise;

    expect(pluginsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "selectedPluginConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "selectedPluginsResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });
});
