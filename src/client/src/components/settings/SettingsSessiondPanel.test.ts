// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveAgentProfileDescriptor, PiWebUiConfigResponse, PiWebUiConfigValues, PiWebUiSessiondListenerDescriptor } from "../../api";
import { SettingsSessiondPanel, sessiondDescription, sessiondPanelNotices, type SessiondPanelNoticeContext } from "./SettingsSessiondPanel";

// Notice composition and description strings are asserted through the exported
// pure seams; the listener block is asserted with a real jsdom shadow-DOM
// harness because it is rendered, user-visible state. Static layout and styling
// remain unasserted.

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

function configResponse(
  config: PiWebUiConfigValues,
  overrides: Partial<PiWebUiConfigResponse["envOverrides"]> = {},
  effectiveConfig: PiWebUiConfigValues = config,
): PiWebUiConfigResponse {
  return {
    path: "/tmp/pi-webui/config.json",
    exists: true,
    config,
    effectiveConfig,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, ...overrides },
  };
}

describe("session daemon panel listener block", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function tcp(host: string, port: number, hostSource: "env" | "config" | "default", portSource: "env" | "config"): PiWebUiSessiondListenerDescriptor {
    return { kind: "tcp", host, port, hostSource, portSource };
  }

  async function mountListenerPanel(config: PiWebUiConfigResponse, listener?: PiWebUiSessiondListenerDescriptor): Promise<SettingsSessiondPanel> {
    const panel = new SettingsSessiondPanel();
    panel.configResponse = config;
    if (listener !== undefined) panel.sessiondListener = listener;
    document.body.append(panel);
    await panel.updateComplete;
    return panel;
  }

  function listenerRoot(panel: SettingsSessiondPanel): ShadowRoot {
    const root = panel.shadowRoot;
    if (root === null) throw new Error("Expected an open shadow root");
    return root;
  }

  function listenerRows(panel: SettingsSessiondPanel): Element[] {
    return [...listenerRoot(panel).querySelectorAll(".listener-card dl > div")];
  }

  function rowValue(panel: SettingsSessiondPanel, label: string): string | undefined {
    for (const row of listenerRows(panel)) {
      if (row.querySelector("dt")?.textContent === label) return row.querySelector("dd")?.textContent.trim();
    }
    return undefined;
  }

  function rowBadges(panel: SettingsSessiondPanel, label: string): string[] {
    for (const row of listenerRows(panel)) {
      if (row.querySelector("dt")?.textContent === label) {
        return [...row.querySelectorAll(".override-badge")].map((badge) => badge.textContent);
      }
    }
    return [];
  }

  it("renders the read-only listener rows", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    const panel = await mountListenerPanel(configResponse({ sessiond }, {}, { sessiond }), tcp("0.0.0.0", 8810, "config", "config"));
    const text = listenerRoot(panel).textContent;

    expect(text).toContain("Desired bind address");
    expect(text).toContain("Running bind address");
    expect(text).toContain("Web/API dial target");
    expect(text).toContain("0.0.0.0");
    expect(text).toContain("http://127.0.0.1:8810");
    expect(text).toContain("✓ daemon in sync");
    expect(rowValue(panel, "Running bind port")).toBe("8810");
    expect(listenerRoot(panel).querySelectorAll(".listener-card input, .listener-card button")).toHaveLength(0);
  });

  it("renders each verdict and the unavailable state", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810 };
    const overridden = await mountListenerPanel(configResponse({ sessiond }), tcp("127.0.0.1", 8810, "env", "config"));
    expect(listenerRoot(overridden).textContent).toContain("one or more listener values come from the environment");

    document.body.replaceChildren();
    const restart = await mountListenerPanel(configResponse({ sessiond }), tcp("127.0.0.1", 9000, "config", "config"));
    expect(listenerRoot(restart).textContent).toContain("⚠ restart required");

    document.body.replaceChildren();
    const unavailable = await mountListenerPanel(configResponse({ sessiond }));
    expect(rowValue(unavailable, "Running bind address")).toBe("Unavailable");
    expect(rowValue(unavailable, "Running bind port")).toBe("Unavailable");
    expect(rowValue(unavailable, "Listener status")).toBe("");
    expect(listenerRoot(unavailable).textContent).not.toContain("✓");
  });

  it("badges environment-sourced values only", async () => {
    const sessiond = { url: "http://127.0.0.1:8810" };
    const panel = await mountListenerPanel(
      configResponse({ sessiond }, { sessiondUrl: true }, { sessiond }),
      tcp("0.0.0.0", 8810, "env", "env"),
    );

    expect(rowBadges(panel, "Running bind address")).toEqual(["environment override"]);
    expect(rowBadges(panel, "Running bind port")).toEqual(["environment override"]);
    expect(rowBadges(panel, "Web/API dial target")).toEqual(["environment override"]);
    expect(rowBadges(panel, "Desired bind address")).toEqual([]);
    expect(rowBadges(panel, "Desired bind port")).toEqual([]);
  });

  it("omits the environment badge for config-sourced values", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    const panel = await mountListenerPanel(
      configResponse({ sessiond }, { sessiondUrl: false }, { sessiond }),
      tcp("0.0.0.0", 8810, "config", "config"),
    );

    expect(rowBadges(panel, "Running bind address")).toEqual([]);
    expect(rowBadges(panel, "Running bind port")).toEqual([]);
    expect(rowBadges(panel, "Web/API dial target")).toEqual([]);
  });

  it("renders and suppresses the dial-target coherence warning", async () => {
    const panel = await mountListenerPanel(configResponse({ sessiond: { port: 8810 } }));
    expect(listenerRoot(panel).textContent).toContain("Add sessiond.url or remove sessiond.port.");

    panel.configResponse = configResponse({ sessiond: { port: 8810 } }, { sessiondUrl: true });
    await panel.updateComplete;

    expect(listenerRoot(panel).textContent).not.toContain("Add sessiond.url or remove sessiond.port.");
  });

  it("suppresses the bind half once the daemon reports an environment port", async () => {
    const panel = await mountListenerPanel(configResponse({ sessiond: { url: "http://127.0.0.1:8810" } }));
    expect(listenerRoot(panel).textContent).toContain("Add sessiond.port or remove sessiond.url.");

    panel.sessiondListener = tcp("127.0.0.1", 8810, "config", "env");
    await panel.updateComplete;

    expect(listenerRoot(panel).textContent).not.toContain("Add sessiond.port or remove sessiond.url.");
  });
});
