import { describe, expect, it, vi } from "vitest";
import type { ActiveAgentProfileDescriptor, PiWebUiConfigResponse, PiWebUiConfigValues } from "../../api";
import { SettingsSessiondPanel, sessiondDescription, sessiondPanelNotices, type SessiondPanelNoticeContext } from "./SettingsSessiondPanel";

// This suite asserts the session-daemon panel's dynamic behavior through public
// seams rather than by inspecting rendered Lit `TemplateResult` internals:
// notice composition/ordering and the description string come from the exported
// `sessiondPanelNotices`/`sessiondDescription` helpers, and profile-save and
// draft-preservation behavior are observed via injected callbacks and public
// state. Static labels and layout are intentionally not asserted here (no DOM
// harness); per the testing-guide skill those are not verified by scraping
// template internals.

describe("session daemon panel notices", () => {
  it("names the selected machine in the scope description and restart notice", () => {
    const targetLabel = "Lab Mac (remote machine)";
    const config = configResponse({
      agent: { command: "agent-lab", dir: "/srv/agent-lab" },
      spawnSessions: true,
      subsessions: false,
    });

    expect(sessiondDescription(targetLabel)).toContain("Lab Mac (remote machine)");

    const notices = sessiondPanelNotices(config, noticeContext({
      activeProfile: activeProfile("pi", "/srv/pi"),
      targetLabel,
    }));

    expect(notices).toHaveLength(1);
    expect(notices[0]?.type).toBe("warning");
    expect(notices[0]?.title).toBe("Pi-compatible agent profile restart required on Lab Mac (remote machine)");
    expect(notices[0]?.content).not.toBe("");
  });

  it("orders save/load notices before the restart notice", () => {
    const config = configResponse({ agent: { command: "agent-lab", dir: "/srv/agent-lab" }, spawnSessions: false });

    const notices = sessiondPanelNotices(config, noticeContext({
      activeProfile: activeProfile("pi", "/srv/pi"),
      error: "Failed to save session-daemon config.",
      savedMessage: "Session daemon settings saved.",
    }));

    expect(notices.map((notice) => notice.type)).toEqual(["error", "success", "warning"]);
    expect(notices[0]?.content).toBe("Failed to save session-daemon config.");
    expect(notices[1]?.content).toBe("Session daemon settings saved.");
    expect(notices[2]?.title).toBe("Pi-compatible agent profile restart required on local (local gateway)");
  });

  it("adds no restart or activation guidance when the desired and active profiles match", () => {
    const config = configResponse({ agent: { command: "agent-lab", dir: "/srv/agent-lab" } });

    const notices = sessiondPanelNotices(config, noticeContext({
      activeProfile: activeProfile("agent-lab", "/srv/agent-lab"),
    }));

    expect(notices).toEqual([]);
  });

  it("reports only the blocking error and no activation guidance when config is unavailable", () => {
    const notices = sessiondPanelNotices(undefined, noticeContext({
      activeProfile: undefined,
      error: "Selected-machine settings are not available on Lab Mac.",
      targetLabel: "Lab Mac (remote machine)",
    }));

    expect(notices).toEqual([
      { type: "error", content: "Selected-machine settings are not available on Lab Mac." },
    ]);
  });
});

describe("session daemon panel save behavior", () => {
  it("submits command and directory together as one profile save", async () => {
    const panel = new SettingsSessiondPanel();
    const onSave = vi.fn();
    setPanelConfig(panel, configResponse({ agent: { command: "pi", dir: "/srv/pi" } }));
    setPanelProperty(panel, "agentDraft", { command: " alternate-agent ", dir: " /srv/alternate " });
    panel.onSave = onSave;
    const event = new Event("submit", { cancelable: true });

    await callPanelPromise(panel, "saveAgentProfile", event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSave.mock.calls).toEqual([[{ agent: { command: "alternate-agent", dir: "/srv/alternate" } }]]);
  });

  it("preserves a dirty profile draft when an unrelated daemon setting is saved", () => {
    const panel = new SettingsSessiondPanel();
    const initial = configResponse({ agent: { command: "pi", dir: "/srv/pi" }, spawnSessions: false });
    setPanelConfig(panel, initial);
    callPanelMethod(panel, "updateAgentDraft", { command: "alternate-agent", dir: "/srv/alternate" });

    const toggled = configResponse({ agent: { command: "pi", dir: "/srv/pi" }, spawnSessions: true });
    panel.configResponse = toggled;
    callPanelMethod(panel, "willUpdate", new Map([["configResponse", initial]]));

    expect(Reflect.get(panel, "agentDraft")).toEqual({ command: "alternate-agent", dir: "/srv/alternate" });

    const saved = configResponse({ agent: { command: "alternate-agent", dir: "/srv/alternate" }, spawnSessions: true });
    panel.configResponse = saved;
    callPanelMethod(panel, "willUpdate", new Map([["configResponse", toggled]]));
    expect(Reflect.get(panel, "agentDraftDirty")).toBe(false);
  });
});

function noticeContext(overrides: Partial<SessiondPanelNoticeContext>): SessiondPanelNoticeContext {
  return {
    error: "",
    savedMessage: "",
    activeProfile: undefined,
    targetLabel: "local (local gateway)",
    profileEditingSupported: true,
    ...overrides,
  };
}

function activeProfile(command: string, dir: string): ActiveAgentProfileDescriptor {
  return {
    schemaVersion: 1,
    revision: `sha256:${"a".repeat(64)}`,
    command,
    dir,
    sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
  };
}

function setPanelConfig(panel: SettingsSessiondPanel, config: PiWebUiConfigResponse): void {
  panel.configResponse = config;
  callPanelMethod(panel, "willUpdate", new Map([["configResponse", undefined]]));
}

function setPanelProperty(panel: SettingsSessiondPanel, property: string, value: unknown): void {
  if (!Reflect.set(panel, property, value)) throw new Error(`Failed to set SettingsSessiondPanel property ${property}`);
}

async function callPanelPromise(panel: SettingsSessiondPanel, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callPanelMethod(panel, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SettingsSessiondPanel.${methodName} did not return a promise`);
  await result;
}

function callPanelMethod(panel: SettingsSessiondPanel, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(panel, methodName);
  if (typeof method !== "function") throw new Error(`SettingsSessiondPanel.${methodName} is not callable`);
  return Reflect.apply(method, panel, args);
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
