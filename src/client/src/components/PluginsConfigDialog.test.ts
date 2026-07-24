import { describe, expect, it, vi } from "vitest";
import type { Machine, PiPackagePluginInfo, SessionInfo } from "../api";
import { PluginsConfigDialog } from "./PluginsConfigDialog";

const cwd = "/work/project-a";
const plugin: PiPackagePluginInfo = {
  source: "npm:@acme/tools",
  scope: "global",
  filtered: false,
  disabled: false,
  installedPath: "/home/test/.pi/agent/npm/node_modules/@acme/tools",
  packageName: "@acme/tools",
  version: "1.0.0",
  counts: { extensions: 1, skills: 0, prompts: 0, themes: 0 },
  resources: [{ kind: "extension", name: "tools", path: "/packages/tools/extensions/index.ts", relativePath: "extensions/index.ts" }],
  status: "loaded",
};

const session: SessionInfo = {
  id: "session-a",
  cwd,
  path: "/sessions/session-a.jsonl",
  created: "2026-06-04T00:00:00.000Z",
  modified: "2026-06-04T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "Configure plugins",
};

describe("plugins-config-dialog machine and workspace targeting", () => {
  it("loads, mutates, installs, and reloads a selected machine session for the active workspace", async () => {
    const response = { packages: [plugin], totals: plugin.counts, diagnostics: [] };
    const pluginsApi = {
      list: vi.fn().mockResolvedValue(response),
      mutate: vi.fn().mockResolvedValue(response),
    };
    const sessionsApi = { runCommand: vi.fn().mockResolvedValue({ type: "done" }) };
    const onReloaded = vi.fn();
    const dialog = new PluginsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.cwd = cwd;
    dialog.session = session;
    dialog.pluginsApi = pluginsApi;
    dialog.sessionsApi = sessionsApi;
    dialog.onReloaded = onReloaded;

    await callDialogPromise(dialog, "loadPlugins");
    await callDialogPromise(dialog, "runAction", "disable", plugin);
    Reflect.set(dialog, "installSource", "npm:@acme/new-tools");
    Reflect.set(dialog, "installScope", "project");
    await callDialogPromise(dialog, "installPlugin");
    await callDialogPromise(dialog, "reloadSession");

    expect(pluginsApi.list).toHaveBeenCalledWith(cwd, "remote-a");
    expect(pluginsApi.mutate).toHaveBeenNthCalledWith(1, {
      action: "disable",
      source: plugin.source,
      scope: "global",
      cwd,
    }, "remote-a");
    expect(pluginsApi.mutate).toHaveBeenNthCalledWith(2, {
      action: "install",
      source: "npm:@acme/new-tools",
      scope: "project",
      cwd,
    }, "remote-a");
    expect(sessionsApi.runCommand).toHaveBeenCalledWith(session, "/reload", "remote-a");
    expect(onReloaded).toHaveBeenCalledOnce();
  });

  it("shows a Pi runtime reload rejection instead of reporting success", async () => {
    const onReloaded = vi.fn();
    const sessionsApi = {
      runCommand: vi.fn().mockResolvedValue({
        type: "unsupported",
        message: "Cannot reload while the session is active.",
      }),
    };
    const dialog = new PluginsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.cwd = cwd;
    dialog.session = session;
    dialog.pluginsApi = { list: vi.fn(), mutate: vi.fn() };
    dialog.sessionsApi = sessionsApi;
    dialog.onReloaded = onReloaded;

    await callDialogPromise(dialog, "reloadSession");

    expect(sessionsApi.runCommand).toHaveBeenCalledWith(session, "/reload", "remote-a");
    expect(onReloaded).not.toHaveBeenCalled();
    expect(Reflect.get(dialog, "actionError")).toBe("Cannot reload while the session is active.");
  });

  it("selects a locally normalized package by its installed path after installation", async () => {
    const localSource = "/work/project-a/local-tools";
    const locallyConfigured = { ...plugin, source: "../local-tools", installedPath: localSource };
    const response = { packages: [locallyConfigured], totals: locallyConfigured.counts, diagnostics: [] };
    const dialog = new PluginsConfigDialog();
    dialog.machine = machine("local");
    dialog.cwd = cwd;
    dialog.pluginsApi = {
      list: vi.fn().mockResolvedValue(response),
      mutate: vi.fn().mockResolvedValue(response),
    };

    Reflect.set(dialog, "installSource", localSource);
    await callDialogPromise(dialog, "installPlugin");

    expect(Reflect.get(dialog, "selectedKey")).toBe(`global\0${locallyConfigured.source}`);
  });
});

function machine(id: string): Machine {
  return {
    id,
    name: "Remote build host",
    kind: "remote",
    baseUrl: "https://remote.example.test/",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

async function callDialogPromise(dialog: PluginsConfigDialog, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callDialogMethod(dialog, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`PluginsConfigDialog.${methodName} did not return a promise`);
  await result;
}

function callDialogMethod(dialog: PluginsConfigDialog, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(dialog, methodName);
  if (!isDialogMethod(method)) throw new Error(`PluginsConfigDialog.${methodName} is not callable`);
  return method.call(dialog, ...args);
}

function isDialogMethod(value: unknown): value is (this: PluginsConfigDialog, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}
