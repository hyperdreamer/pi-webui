import { describe, expect, it } from "vitest";
import { effectivePiWebUiCapabilities, PI_WEBUI_CAPABILITIES, SESSIOND_RUNTIME_CAPABILITIES, WEB_RUNTIME_CAPABILITIES, parseKnownPiWebUiCapabilities } from "./capabilities";
import type { SessionDefaultsV2Response, SessionStartOptions, StarterModelPolicyPreference } from "./apiTypes";

describe("PI WEBUI capabilities", () => {
  it("advertises web-only capabilities without requiring session daemon support", () => {
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEBUI_CAPABILITIES.piPackagesManage);
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEBUI_CAPABILITIES.selectedMachineSettings);
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEBUI_CAPABILITIES.agentProfileConfig);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEBUI_CAPABILITIES.piPackagesManage);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEBUI_CAPABILITIES.selectedMachineSettings);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEBUI_CAPABILITIES.agentProfileConfig);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.piPackagesManage, PI_WEBUI_CAPABILITIES.selectedMachineSettings, PI_WEBUI_CAPABILITIES.agentProfileConfig] },
      sessiond: { available: false, capabilities: [] },
    })).toEqual([PI_WEBUI_CAPABILITIES.piPackagesManage, PI_WEBUI_CAPABILITIES.selectedMachineSettings, PI_WEBUI_CAPABILITIES.agentProfileConfig]);
  });

  it("requires web and session daemon support for model-tier settings", () => {
    const modelTiers = PI_WEBUI_CAPABILITIES.modelTierSettings;
    expect(modelTiers).toBe("settings.modelTiers");
    expect(WEB_RUNTIME_CAPABILITIES).toContain(modelTiers);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(modelTiers);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [modelTiers] },
      sessiond: { available: false, capabilities: [modelTiers] },
    })).not.toContain(modelTiers);
    expect(effectivePiWebUiCapabilities({
      web: { available: false, capabilities: [modelTiers] },
      sessiond: { available: true, capabilities: [modelTiers] },
    })).not.toContain(modelTiers);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [modelTiers] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(modelTiers);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [modelTiers] },
      sessiond: { available: true, capabilities: [modelTiers] },
    })).toContain(modelTiers);
  });

  it("requires web and session daemon support for session model policy", () => {
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsModelPolicy] },
      sessiond: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsModelPolicy] },
    })).toContain(PI_WEBUI_CAPABILITIES.sessionsModelPolicy);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsModelPolicy] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(PI_WEBUI_CAPABILITIES.sessionsModelPolicy);

    expect(parseKnownPiWebUiCapabilities(["sessions.modelPolicy", "unknown.capability"]))
      .toEqual([PI_WEBUI_CAPABILITIES.sessionsModelPolicy]);
  });

  it("requires web and session daemon support for starter model policy defaults", () => {
    const defaults = PI_WEBUI_CAPABILITIES.sessionsModelPolicyDefaults;
    expect(defaults).toBe("sessions.modelPolicyDefaults");
    expect(WEB_RUNTIME_CAPABILITIES).toContain(defaults);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(defaults);
    expect(parseKnownPiWebUiCapabilities([defaults, "future.capability"]))
      .toEqual([defaults]);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [defaults] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(defaults);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [defaults] },
    })).not.toContain(defaults);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [defaults] },
      sessiond: { available: true, capabilities: [defaults] },
    })).toContain(defaults);
  });

  it("requires web and session daemon support for authoritative session persistence", () => {
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEBUI_CAPABILITIES.sessionsPersistedState);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(PI_WEBUI_CAPABILITIES.sessionsPersistedState);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsPersistedState] },
      sessiond: { available: false, capabilities: [PI_WEBUI_CAPABILITIES.sessionsPersistedState] },
    })).not.toContain(PI_WEBUI_CAPABILITIES.sessionsPersistedState);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsPersistedState] },
      sessiond: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsPersistedState] },
    })).toContain(PI_WEBUI_CAPABILITIES.sessionsPersistedState);
  });

  it("requires web and session daemon support for server-side queue clearing", () => {
    const clearQueue = PI_WEBUI_CAPABILITIES.sessionsClearQueue;
    expect(WEB_RUNTIME_CAPABILITIES).toContain(clearQueue);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(clearQueue);
    expect(parseKnownPiWebUiCapabilities([clearQueue, "future.capability"])).toEqual([clearQueue]);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [clearQueue] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(clearQueue);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [clearQueue] },
    })).not.toContain(clearQueue);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [clearQueue] },
      sessiond: { available: true, capabilities: [clearQueue] },
    })).toContain(clearQueue);
  });

  it("requires both web and session daemon support for per-message history actions", () => {
    const messageActions = PI_WEBUI_CAPABILITIES.sessionsMessageActions;
    expect(messageActions).toBe("sessions.messageActions");
    expect(WEB_RUNTIME_CAPABILITIES).toContain(messageActions);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(messageActions);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [messageActions] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(messageActions);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [messageActions] },
      sessiond: { available: true, capabilities: [messageActions] },
    })).toContain(messageActions);
  });

  it("requires both web and session daemon support for viewing system prompts", () => {
    const systemPrompt = PI_WEBUI_CAPABILITIES.sessionsSystemPrompt;
    expect(systemPrompt).toBe("sessions.systemPrompt");
    expect(WEB_RUNTIME_CAPABILITIES).toContain(systemPrompt);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(systemPrompt);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [systemPrompt] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(systemPrompt);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [systemPrompt] },
    })).not.toContain(systemPrompt);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [systemPrompt] },
      sessiond: { available: true, capabilities: [systemPrompt] },
    })).toContain(systemPrompt);
  });

  it("requires both web and session daemon support for notification inboxes", () => {
    const notifications = PI_WEBUI_CAPABILITIES.sessionsNotifications;
    expect(WEB_RUNTIME_CAPABILITIES).toContain(notifications);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(notifications);
    expect(parseKnownPiWebUiCapabilities([notifications, "future.capability"])).toEqual([notifications]);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [notifications] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(notifications);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [notifications] },
    })).not.toContain(notifications);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [notifications] },
      sessiond: { available: true, capabilities: [notifications] },
    })).toContain(notifications);
  });

  it("negotiates daemon-authoritative unread state only when both runtimes support it", () => {
    const unread = PI_WEBUI_CAPABILITIES.sessionsUnread;
    expect(WEB_RUNTIME_CAPABILITIES).toContain(unread);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(unread);
    expect(parseKnownPiWebUiCapabilities([unread, "future.capability"])).toEqual([unread]);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [unread] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(unread);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [unread] },
    })).not.toContain(unread);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [unread] },
      sessiond: { available: true, capabilities: [unread] },
    })).toContain(unread);
  });

  it("keeps only known string capabilities when parsing runtime data", () => {
    expect(parseKnownPiWebUiCapabilities([PI_WEBUI_CAPABILITIES.piPackagesManage, PI_WEBUI_CAPABILITIES.selectedMachineSettings, "future.capability"])).toEqual([PI_WEBUI_CAPABILITIES.piPackagesManage, PI_WEBUI_CAPABILITIES.selectedMachineSettings]);
    expect(parseKnownPiWebUiCapabilities([PI_WEBUI_CAPABILITIES.piPackagesManage, 1])).toBeUndefined();
  });

  it("requires web and session daemon support for the starter model policy selection capability", () => {
    const starterSelection = PI_WEBUI_CAPABILITIES.sessionsModelPolicyStarterSelection;
    expect(starterSelection).toBe("sessions.modelPolicyStarterSelection");
    expect(WEB_RUNTIME_CAPABILITIES).toContain(starterSelection);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(starterSelection);
    expect(parseKnownPiWebUiCapabilities([starterSelection, "future.capability"])).toEqual([starterSelection]);

    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [starterSelection] },
      sessiond: { available: false, capabilities: [] },
    })).not.toContain(starterSelection);
    expect(effectivePiWebUiCapabilities({
      web: { available: false, capabilities: [] },
      sessiond: { available: true, capabilities: [starterSelection] },
    })).not.toContain(starterSelection);
    expect(effectivePiWebUiCapabilities({
      web: { available: true, capabilities: [starterSelection] },
      sessiond: { available: true, capabilities: [starterSelection] },
    })).toContain(starterSelection);
  });

  it("keeps the disjoint plus-created start contract distinct from legacy starts", () => {
    const full: StarterModelPolicyPreference = {
      mode: "exact",
      exact: {
        model: { provider: "acme", id: "reasoner" },
        thinkingLevel: "high",
      },
      tier: "advanced",
    };
    const plusStart: SessionStartOptions = {
      creationSource: "session-list-plus",
      initialModelPolicy: full,
    };
    const legacyStart: SessionStartOptions = {
      modelPolicy: { mode: "tiered", tier: "standard" },
    };
    expect(plusStart.creationSource).toBe("session-list-plus");
    expect(legacyStart.modelPolicy).toEqual({ mode: "tiered", tier: "standard" });
  });

  it("distinguishes a full negotiated starter response from a legacy one by the required exact field", () => {
    const full: SessionDefaultsV2Response = {
      starterModelPolicyContractVersion: 2,
      thinkingLevel: "high",
      models: [],
      thinkingLevels: ["high"],
      starterModelPolicyPreference: {
        mode: "tiered",
        exact: { model: { provider: "acme", id: "reasoner" }, thinkingLevel: "high" },
        tier: "advanced",
      },
    };
    const legacy: SessionDefaultsV2Response = {
      starterModelPolicyContractVersion: 2,
      thinkingLevel: "high",
      models: [],
      thinkingLevels: ["high"],
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    };
    expect(full.starterModelPolicyPreference && "exact" in full.starterModelPolicyPreference).toBe(true);
    expect(legacy.starterModelPolicyPreference && "exact" in legacy.starterModelPolicyPreference).toBe(false);
  });
});
