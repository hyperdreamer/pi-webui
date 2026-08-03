// Template inspection is proportionate here: this node-environment harness
// verifies PiWebUiApp's composer policy inputs, capability gating, and starter
// synthesis. Those are Lit property bindings on a child custom element, and a
// real shadow-DOM harness is unavailable in this runner. Assertions stay on
// observable app state and injected collaborators.
import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import type {
  ClientSessionModelPolicyStatus,
  MachineRuntime,
  ModelTier,
  ModelTierLadder,
  ModelTierModelOption,
  ModelTierSettingsResponse,
  SessionModelPolicy,
  SessionModelPolicyResponse,
  SessionStatus,
} from "../../../shared/apiTypes";
import { modelTiersApi, sessionsApi, type Machine, type Project, type SessionDefaultsResponse, type SessionInfo, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { findTemplateContaining, isTemplateResult, templateStrings, templateText, templateValueAfterMarker, templateValues } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";
import type { StarterNotice } from "./starterNotice";
import type { ThinkingLevelOption } from "./thinkingLevelOptions";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── fixtures ────────────────────────────────────────────────────────────────

const project: Project = { id: "project-a", name: "Project A", path: "/work/project-a", createdAt: "2026-07-31T00:00:00.000Z" };

const mainWorkspace: Workspace = {
  id: "workspace-a",
  projectId: project.id,
  path: "/work/project-a",
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

const featureWorkspace: Workspace = { ...mainWorkspace, id: "workspace-b", path: "/work/project-a-feature", label: "feature", isMain: false };

const remoteMachine: Machine = {
  id: "remote-a",
  name: "Remote build host",
  kind: "remote",
  baseUrl: "https://remote.example.test/",
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
};

const defaultModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-default" },
  name: "Default",
  thinkingLevels: ["low", "medium", "high"],
};

const advancedModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-advanced" },
  name: "Advanced",
  thinkingLevels: ["high"],
};

const repairModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-repair" },
  name: "Repair",
  thinkingLevels: ["low", "medium", "high"],
};

function validLadder(): ModelTierLadder {
  return {
    economy: { model: { ...defaultModelOption.model }, thinkingLevel: "low" },
    fast: { model: { ...defaultModelOption.model }, thinkingLevel: "low" },
    standard: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    advanced: { model: { ...advancedModelOption.model }, thinkingLevel: "high" },
    capable: { model: { ...advancedModelOption.model }, thinkingLevel: "high" },
    frontier: { model: { ...advancedModelOption.model }, thinkingLevel: "high" },
  };
}

function validCatalog(): ModelTierSettingsResponse {
  return {
    contractVersion: 1,
    ladder: validLadder(),
    models: [defaultModelOption, advancedModelOption, repairModelOption],
    rows: {
      economy: { valid: true },
      fast: { valid: true },
      standard: { valid: true },
      advanced: { valid: true },
      capable: { valid: true },
      frontier: { valid: true },
    },
    valid: true,
  };
}

function invalidTierCatalog(tier: ModelTier, reason: string): ModelTierSettingsResponse {
  const catalog = validCatalog();
  return {
    ...catalog,
    rows: { ...catalog.rows, [tier]: { valid: false, reason } },
    valid: false,
  };
}

function starterDefaults(overrides: Partial<SessionDefaultsResponse> = {}): SessionDefaultsResponse {
  return {
    model: { provider: "openai", id: "gpt-default", name: "Default" },
    thinkingLevel: "medium",
    models: [{ provider: "openai", id: "gpt-default" }, { provider: "openai", id: "gpt-advanced" }],
    thinkingLevels: ["low", "medium", "high"],
    ...overrides,
  };
}

function starterDefaultsWithoutResolvedModel(): SessionDefaultsResponse {
  return {
    thinkingLevel: "medium",
    models: [],
    thinkingLevels: ["off", "low", "medium", "high"],
  };
}

function activeSession(): SessionInfo {
  return {
    id: "session-a",
    cwd: mainWorkspace.path,
    path: "/sessions/session-a.jsonl",
    created: "2026-07-31T00:00:00.000Z",
    modified: "2026-07-31T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "Review the policy",
  };
}

function exactPolicyStatus(): ClientSessionModelPolicyStatus {
  return {
    mode: "exact",
    resolved: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    ladderValid: true,
  };
}

function activeStatus(policy: ClientSessionModelPolicyStatus | undefined): SessionStatus {
  const base: SessionStatus = {
    sessionId: "session-a",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    model: { provider: "openai", id: "gpt-default" },
    thinkingLevel: "medium",
  };
  if (policy === undefined) return base;
  return { ...base, modelPolicy: policy };
}

function exactPolicyResponse(): SessionModelPolicyResponse {
  const exact = exactPolicyStatus().resolved;
  return {
    contractVersion: 1,
    policy: {
      mode: "exact",
      exact: { model: { ...exact.model }, thinkingLevel: exact.thinkingLevel },
    },
    session: activeStatus(exactPolicyStatus()),
  };
}

function machineRuntime(
  capabilities: MachineRuntime["capabilities"],
  machineId = remoteMachine.id,
): MachineRuntime {
  return {
    machineId,
    ok: true,
    checkedAt: "2026-07-31T00:00:00.000Z",
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function starterState(): AppState {
  return {
    ...initialAppState(),
    projects: [project],
    selectedProject: project,
    workspaces: [mainWorkspace],
    selectedWorkspace: mainWorkspace,
    sessions: [],
    isLoadingSessions: false,
    error: "",
  };
}

function preferenceCapableStarterState(): AppState {
  return {
    ...starterState(),
    machineRuntimes: {
      local: machineRuntime([
        PI_WEBUI_CAPABILITIES.sessionsModelPolicy,
        PI_WEBUI_CAPABILITIES.sessionsModelPolicyDefaults,
      ], "local"),
    },
  };
}

function activeState(overrides: Partial<AppState> = {}): AppState {
  const session = activeSession();
  return {
    ...starterState(),
    sessions: [session],
    selectedSession: session,
    status: activeStatus(exactPolicyStatus()),
    ...overrides,
  };
}

// ── capability gate ─────────────────────────────────────────────────────────

describe("PiWebUiApp session model policy capability gate", () => {
  it("withholds the policy control from a remote peer that advertises only model tier settings", () => {
    const app = createApp();
    const settings = vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    setAppState(app, activeState({
      selectedMachine: remoteMachine,
      machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.modelTierSettings]) },
    }));

    const editor = promptEditorTemplate(app);

    expect(templateValueAfterMarker(editor, ".modelPolicyStatus=")).toBeUndefined();
    expect(templateValueAfterMarker(editor, ".modelTierCatalog=")).toBeUndefined();
    expect(settings).not.toHaveBeenCalled();
  });

  it("withholds the policy control while a remote peer's runtime is still unknown", () => {
    const app = createApp();
    setAppState(app, activeState({ selectedMachine: remoteMachine }));

    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus=")).toBeUndefined();
  });

  it("withholds the status projection the composer would otherwise fall back to", () => {
    const app = createApp();
    // The runtime has not been negotiated yet while a session status carrying a
    // policy projection has already arrived. PromptEditor falls back to
    // `status.modelPolicy`, so leaving it in place would render a control with no
    // callbacks and a Retry wired to nothing.
    setAppState(app, activeState({ selectedMachine: remoteMachine }));

    const editor = promptEditorTemplate(app);
    const status = promptEditorStatus(editor);

    expect(status.modelPolicy).toBeUndefined();
    // Everything else the composer displays from the status is untouched.
    expect(status.model).toEqual({ provider: "openai", id: "gpt-default" });
    expect(status.thinkingLevel).toBe("medium");
  });

  it("keeps the full status when the capability is available", () => {
    const app = createApp();
    setAppState(app, activeState({
      selectedMachine: remoteMachine,
      machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.sessionsModelPolicy]) },
    }));

    expect(promptEditorStatus(promptEditorTemplate(app)).modelPolicy).toEqual(exactPolicyStatus());
  });

  it("supplies the policy control for a remote peer advertising sessions.modelPolicy", () => {
    const app = createApp();
    setAppState(app, activeState({
      selectedMachine: remoteMachine,
      machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.sessionsModelPolicy]) },
    }));

    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus=")).toEqual(exactPolicyStatus());
  });
});

// ── active composer ─────────────────────────────────────────────────────────

describe("PiWebUiApp active composer policy wiring", () => {
  it("passes the live status projection and retained control state", () => {
    const app = createApp();
    setAppState(app, activeState({ isLoadingModelPolicy: true, isSavingModelPolicy: true, modelPolicyError: "nope" }));

    const editor = promptEditorTemplate(app);

    expect(templateValueAfterMarker(editor, ".modelPolicyStatus=")).toEqual(exactPolicyStatus());
    expect(templateValueAfterMarker(editor, ".modelPolicyLoading=")).toBe(true);
    expect(templateValueAfterMarker(editor, ".modelPolicySaving=")).toBe(true);
    expect(templateValueAfterMarker(editor, ".modelPolicyError=")).toBe("nope");
  });
});

describe("PiWebUiApp policy-aware pick handlers", () => {
  it("routes an incoming-model-valid exact pair through the policy writer when supported", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();
    const setModel = vi.spyOn(sessionController(app), "setModel").mockResolvedValue();
    const setThinkingLevel = vi.spyOn(sessionController(app), "setThinkingLevel").mockResolvedValue();

    await pickModel(app, "openai/gpt-advanced");

    expect(saveModelPolicy).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    expect(policyThinkingOptions(app)).toEqual([
      { level: "off", supported: false, selected: false, description: "No reasoning" },
      { level: "low", supported: false, selected: false, description: "Light reasoning (~2k tokens)" },
      { level: "medium", supported: false, selected: false, description: "Moderate reasoning (~8k tokens)" },
      { level: "high", supported: true, selected: false, description: "Deep reasoning (~16k tokens)" },
    ]);

    await pickThinking(app, "high");
    expect(saveModelPolicy).not.toHaveBeenCalled();
    await timers.runAll();

    expect(setModel).not.toHaveBeenCalled();
    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(saveModelPolicy).toHaveBeenCalledOnce();
    expect(saveModelPolicy).toHaveBeenCalledWith({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    });
  });

  it("keeps both legacy direct writes when the capability is absent", async () => {
    const timers = manualTimers();
    const app = legacyActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();
    const setModel = vi.spyOn(sessionController(app), "setModel").mockResolvedValue();
    const setThinkingLevel = vi.spyOn(sessionController(app), "setThinkingLevel").mockResolvedValue();

    await pickModel(app, "openai/gpt-repair");
    await pickThinking(app, "low");
    await timers.runAll();

    expect(saveModelPolicy).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledOnce();
    expect(setModel).toHaveBeenCalledWith("openai", "gpt-repair");
    expect(setThinkingLevel).toHaveBeenCalledOnce();
    expect(setThinkingLevel).toHaveBeenCalledWith("low");
  });

  it("fails closed instead of saving a thinking level unsupported by the incoming model", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();
    const setModel = vi.spyOn(sessionController(app), "setModel").mockResolvedValue();
    const setThinkingLevel = vi.spyOn(sessionController(app), "setThinkingLevel").mockResolvedValue();

    await pickModel(app, "openai/gpt-advanced");
    await pickThinking(app, "low");
    await timers.runAll();

    expect(saveModelPolicy).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(modelTierCatalogError(app)).toContain("unsupported by openai/gpt-advanced");
  });

  it("coalesces rapid exact changes behind one trailing policy write", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    await pickModel(app, "openai/gpt-repair");
    await pickThinking(app, "low");
    await pickThinking(app, "high");

    expect(timers.size()).toBe(1);
    expect(saveModelPolicy).not.toHaveBeenCalled();
    await timers.runAll();

    expect(saveModelPolicy).toHaveBeenCalledOnce();
    expect(saveModelPolicy).toHaveBeenCalledWith({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-repair" }, thinkingLevel: "high" },
    });
  });

  it("applies a selected tier immediately", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    await selectPolicyTier(app, "frontier");

    expect(timers.size()).toBe(0);
    expect(saveModelPolicy).toHaveBeenCalledOnce();
    expect(saveModelPolicy).toHaveBeenCalledWith({ mode: "tiered", tier: "frontier" });
  });

  it("preserves the remembered exact pair across a mode round trip", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    await selectPolicyTier(app, "advanced");
    expect(saveModelPolicy).toHaveBeenCalledWith({ mode: "tiered", tier: "advanced" });
    saveModelPolicy.mockClear();

    await selectPolicyMode(app, "exact");
    expect(saveModelPolicy).not.toHaveBeenCalled();
    await timers.runAll();

    expect(saveModelPolicy).toHaveBeenCalledOnce();
    expect(saveModelPolicy).toHaveBeenCalledWith({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });
  });

  it("never writes starter preferences for active-session mode or tier changes", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const updateDefaults = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    await selectPolicyTier(app, "advanced");
    await selectPolicyMode(app, "exact");
    await timers.runAll();

    expect(updateDefaults).not.toHaveBeenCalled();
  });

  it("ignores an exact model picker completion that arrives after switching to Tiered", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    await selectPolicyTier(app, "advanced");
    saveModelPolicy.mockClear();

    await pickModel(app, "openai/gpt-advanced");
    await selectPolicyMode(app, "exact");
    await timers.runAll();

    expect(saveModelPolicy).toHaveBeenCalledOnce();
    expect(saveModelPolicy).toHaveBeenCalledWith({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });
  });

  it("drops the pending pair when the policy writer reports failed verification", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockImplementation(() => {
      setAppState(app, { ...appState(app), modelPolicyError: "effective pair could not be verified" });
      return Promise.resolve();
    });

    await pickModel(app, "openai/gpt-repair");
    await timers.runAll();

    expect(saveModelPolicy).toHaveBeenCalledOnce();
    const editor = promptEditorTemplate(app);
    expect(promptEditorStatus(editor).model).toEqual({ provider: "openai", id: "gpt-default" });
    expect(templateValueAfterMarker(editor, ".modelPolicyStatus=")).toEqual(exactPolicyStatus());
    expect(templateValueAfterMarker(editor, ".modelPolicyError=")).toBe("effective pair could not be verified");
  });

  it("cancels a pending exact apply on an actual mode change", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    await pickModel(app, "openai/gpt-repair");
    expect(timers.size()).toBe(1);

    await selectPolicyMode(app, "tiered");
    await timers.runAll();

    expect(saveModelPolicy).not.toHaveBeenCalled();
  });

  it("cancels a pending exact apply when the app disconnects", async () => {
    const timers = manualTimers();
    const app = policyCapableActiveApp(timers);
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue();

    await pickModel(app, "openai/gpt-repair");
    expect(timers.size()).toBe(1);

    app.disconnectedCallback();
    await timers.runAll();

    expect(saveModelPolicy).not.toHaveBeenCalled();
  });
});

// ── catalog stale guards ────────────────────────────────────────────────────

describe("PiWebUiApp model tier catalog stale guards", () => {
  it("never applies a catalog fetched for a selection the user has already left", async () => {
    const app = createApp();
    const pending = deferred<ModelTierSettingsResponse>();
    const settings = vi.spyOn(modelTiersApi, "settings").mockReturnValueOnce(pending.promise);
    setAppState(app, starterState());

    void loadModelTierCatalog(app, "local");
    setAppState(app, {
      ...starterState(),
      selectedMachine: remoteMachine,
      selectedWorkspace: featureWorkspace,
      machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.sessionsModelPolicy]) },
    });
    pending.resolve(validCatalog());
    await flush();

    expect(modelTierCatalog(app)).toBeUndefined();
    expect(settings).toHaveBeenCalledWith("local");

    const remoteCatalog: ModelTierSettingsResponse = { ...validCatalog(), models: [advancedModelOption] };
    settings.mockResolvedValueOnce(remoteCatalog);
    await loadModelTierCatalog(app, remoteMachine.id);

    expect(modelTierCatalog(app)).toEqual(remoteCatalog);
    expect(settings).toHaveBeenLastCalledWith(remoteMachine.id);
  });

  it("never lets a late response overwrite a newer one for the same machine", async () => {
    const app = createApp();
    const slow = deferred<ModelTierSettingsResponse>();
    const staleCatalog: ModelTierSettingsResponse = { ...validCatalog(), valid: false, configError: "stale" };
    const freshCatalog = validCatalog();
    const settings = vi.spyOn(modelTiersApi, "settings")
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(freshCatalog);
    setAppState(app, starterState());

    const first = loadModelTierCatalog(app, "local");
    await loadModelTierCatalog(app, "local");
    slow.resolve(staleCatalog);
    await first;

    expect(settings).toHaveBeenCalledTimes(2);
    expect(modelTierCatalog(app)).toEqual(freshCatalog);
    expect(modelTierCatalogLoading(app)).toBe(false);
  });

  it("surfaces a catalog failure without inventing a catalog", async () => {
    const app = createApp();
    vi.spyOn(modelTiersApi, "settings").mockRejectedValue(new Error("catalog offline"));
    setAppState(app, starterState());

    await loadModelTierCatalog(app, "local");

    expect(modelTierCatalog(app)).toBeUndefined();
    expect(modelTierCatalogError(app)).toContain("catalog offline");
  });
});

// ── starter composer ────────────────────────────────────────────────────────

describe("PiWebUiApp starter composer policy", () => {
  it("starts from a local Exact policy linked to the resolved Pi defaults", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    setAppState(app, starterState());

    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(starterModelPolicy(app)).toEqual({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });
    const editor = promptEditorTemplate(app);
    expect(templateValueAfterMarker(editor, ".modelPolicyStatus=")).toEqual({
      mode: "exact",
      resolved: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
      // The catalog is not known yet. That is not an invalid ladder, and
      // reporting it as one raises a configuration alarm that does not exist.
      ladderValid: true,
    });
  });

  it("keeps an unresolvable starter tier visible as blocked", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setStarterModelPolicy(app, {
      mode: "tiered",
      tier: "advanced",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });

    const editor = promptEditorTemplate(app);
    const status = policyStatus(templateValueAfterMarker(editor, ".modelPolicyStatus="));

    expect(status.blockedReason).toBe("Choose a valid model tier before starting");
    expect(status.resolved).toEqual({ model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" });
  });

  it("refuses to synthesize a starter policy for a peer without the capability", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    setAppState(app, {
      ...starterState(),
      selectedMachine: remoteMachine,
      machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.modelTierSettings]) },
    });

    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus=")).toBeUndefined();
  });

  it("keeps the starter policy in sync after an exact model pick is confirmed", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults({
      model: { provider: "openai", id: "gpt-advanced" },
      thinkingLevel: "high",
    }));
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await pickStarterModel(app, "openai/gpt-advanced");

    expect(update).toHaveBeenCalledWith(
      mainWorkspace.path,
      { model: { provider: "openai", modelId: "gpt-advanced" } },
      "local",
    );
    expect(starterModelPolicy(app)).toEqual({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    });
  });

  it("keeps the starter policy in sync after an exact thinking pick is confirmed", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults({ thinkingLevel: "low" }));
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await pickStarterThinking(app, "low");

    expect(starterModelPolicy(app)).toEqual({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "low" },
    });
  });

  it("does not let a stale exact picker completion switch a starter out of Tiered mode", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults({
      model: { provider: "openai", id: "gpt-advanced" },
      thinkingLevel: "high",
    }));
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    const tiered: SessionModelPolicy = {
      mode: "tiered",
      tier: "advanced",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    };
    setStarterModelPolicy(app, tiered);

    await pickStarterModel(app, "openai/gpt-advanced");

    expect(starterModelPolicy(app)).toEqual(tiered);
  });

  it("restores an Exact preference and retains its inactive tier", async () => {
    const app = createApp();
    const settings = vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "exact", tier: "fast" },
    }));
    setAppState(app, preferenceCapableStarterState());

    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(starterModelPolicy(app)).toEqual({
      mode: "exact",
      tier: "fast",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });
    expect(settings).not.toHaveBeenCalled();
  });

  it("restores Tiered intent, preloads its catalog, and blocks Send while validation is pending", async () => {
    const app = createApp();
    const pendingCatalog = deferred<ModelTierSettingsResponse>();
    const settings = vi.spyOn(modelTiersApi, "settings").mockReturnValue(pendingCatalog.promise);
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    setAppState(app, preferenceCapableStarterState());

    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(settings).toHaveBeenCalledWith("local");
    expect(starterModelPolicy(app)?.mode).toBe("tiered");
    expect(starterModelPolicy(app)?.tier).toBe("advanced");
    let editor = promptEditorTemplate(app);
    expect(policyStatus(templateValueAfterMarker(editor, ".modelPolicyStatus=")).tier).toBe("advanced");
    expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(true);

    pendingCatalog.resolve(validCatalog());
    await flush();

    editor = promptEditorTemplate(app);
    expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(false);
  });

  it("keeps in-memory starter selection for a peer without preference support and sends no preference write", async () => {
    const app = createApp();
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    setAppState(app, {
      ...starterState(),
      machineRuntimes: {
        local: machineRuntime([PI_WEBUI_CAPABILITIES.sessionsModelPolicy], "local"),
      },
    });
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    await selectPolicyTier(app, "frontier");
    await flush();

    expect(starterModelPolicy(app)?.mode).toBe("tiered");
    expect(starterModelPolicy(app)?.tier).toBe("frontier");
    expect(update).not.toHaveBeenCalled();
  });

  it("persists valid Tiered and Exact choices immediately for a capable selected machine", async () => {
    const app = createApp();
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    await selectPolicyTier(app, "frontier");
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        mainWorkspace.path,
        { starterModelPolicyPreference: { mode: "tiered", tier: "frontier" } },
        "local",
      );
    });

    await selectPolicyMode(app, "exact");
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        mainWorkspace.path,
        { starterModelPolicyPreference: { mode: "exact", tier: "frontier" } },
        "local",
      );
    });
  });

  it("persists a switch back to a remembered valid Tiered choice", async () => {
    const app = createApp();
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "exact", tier: "frontier" },
    }));
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    await selectPolicyMode(app, "tiered");

    expect(starterModelPolicy(app)?.mode).toBe("tiered");
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        mainWorkspace.path,
        { starterModelPolicyPreference: { mode: "tiered", tier: "frontier" } },
        "local",
      );
    });
  });

  it("does not persist a first Tiered mode choice until a valid tier is selected", async () => {
    const app = createApp();
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    await selectPolicyMode(app, "tiered");
    await flush();

    expect(starterModelPolicy(app)?.mode).toBe("tiered");
    expect(starterModelPolicy(app)?.tier).toBeUndefined();
    expect(update).not.toHaveBeenCalled();

    await selectPolicyTier(app, "advanced");
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        mainWorkspace.path,
        { starterModelPolicyPreference: { mode: "tiered", tier: "advanced" } },
        "local",
      );
    });
  });

  it("keeps an invalid remembered tier as a blocked draft without replacing a durable Exact preference", async () => {
    const app = createApp();
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "exact", tier: "advanced" },
    }));
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, invalidTierCatalog("advanced", "Advanced has no configured model"), "local");

    await selectPolicyMode(app, "tiered");
    await flush();

    expect(starterModelPolicy(app)?.mode).toBe("tiered");
    expect(starterModelPolicy(app)?.tier).toBe("advanced");
    expect(policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus=")).blockedReason)
      .toBe("Choose a valid model tier before starting");
    expect(update).not.toHaveBeenCalled();
  });

  it("relinks only the Exact branch after confirmed Pi defaults and persists the retained tier", async () => {
    const app = createApp();
    const initial = starterDefaults({
      starterModelPolicyPreference: { mode: "exact", tier: "frontier" },
    });
    const confirmed = starterDefaults({
      model: { provider: "openai", id: "gpt-advanced" },
      thinkingLevel: "high",
      starterModelPolicyPreference: { mode: "exact", tier: "frontier" },
    });
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(initial);
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(confirmed);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await pickStarterModel(app, "openai/gpt-advanced");
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        mainWorkspace.path,
        { starterModelPolicyPreference: { mode: "exact", tier: "frontier" } },
        "local",
      );
    });

    expect(starterModelPolicy(app)).toEqual({
      mode: "exact",
      tier: "frontier",
      exact: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    });
  });

  it("wires starter mode, tier, and thinking choices to the local policy/default paths", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults({ thinkingLevel: "low" }));
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    await selectPolicyTier(app, "frontier");
    expect(starterModelPolicy(app)?.mode).toBe("tiered");
    expect(starterModelPolicy(app)?.tier).toBe("frontier");

    await selectPolicyMode(app, "exact");
    expect(starterModelPolicy(app)?.mode).toBe("exact");

    await selectPolicyThinking(app, "low");
    expect(starterModelPolicy(app)?.exact.thinkingLevel).toBe("low");
  });
});

// ── starter reset ───────────────────────────────────────────────────────────

describe("PiWebUiApp starter policy reset", () => {
  it("clears the starter tier and catalog error on workspace change and relinks only after fresh defaults arrive", async () => {
    const app = createApp();
    const defaults = vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    setStarterModelPolicy(app, {
      mode: "tiered",
      tier: "advanced",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });
    setModelTierCatalogError(app, "previous catalog failure");

    const previous = appState(app);
    const next: AppState = { ...previous, selectedWorkspace: featureWorkspace, workspaces: [mainWorkspace, featureWorkspace] };
    stubWorkspaceChangeSideEffects(app);
    setRouteRestoreInProgress(app);
    setAppState(app, next);
    handleWorkspaceChange(app, previous, next);

    expect(starterModelPolicy(app)).toBeUndefined();
    expect(modelTierCatalogError(app)).toBe("");
    // The catalog is a per-machine projection, so staying on the same machine
    // keeps it rather than paying for an identical refetch.
    expect(modelTierCatalog(app)).toEqual(validCatalog());

    defaults.mockResolvedValue(starterDefaults({ model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" }));
    await loadStarterSessionDefaults(app, featureWorkspace);

    expect(starterModelPolicy(app)).toEqual({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    });
  });

  it("clears the starter policy and catalog on machine change", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    expect(starterModelPolicy(app)).not.toBeUndefined();

    const previous = appState(app);
    const next: AppState = { ...previous, selectedMachine: remoteMachine };
    stubMachineChangeSideEffects(app);
    setAppState(app, next);
    handleMachineChange(app, previous, next);

    expect(starterModelPolicy(app)).toBeUndefined();
    expect(modelTierCatalog(app)).toBeUndefined();
  });
});

// ── start snapshot ──────────────────────────────────────────────────────────

describe("PiWebUiApp starter policy start snapshot", () => {
  it("passes no policy for an untouched Exact starter", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSessionWithPrompt").mockImplementation(promptStartFrom(Promise.resolve(false)));
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");

    startSessionPrompt(app, "explore the repo");

    expect(start).toHaveBeenCalledWith("explore the repo", undefined, undefined, undefined, undefined, expect.any(Function));
  });

});

describe("PiWebUiApp starter policy blocking and diagnostics", () => {
  it("keeps an invalid restored tier visible and blocks both direct start paths", async () => {
    const app = createApp();
    const catalog = invalidTierCatalog("advanced", "Advanced points to a missing model");
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(catalog);
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    setAppState(app, preferenceCapableStarterState());

    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();

    const editor = promptEditorTemplate(app);
    const status = policyStatus(templateValueAfterMarker(editor, ".modelPolicyStatus="));
    const boundCatalog = templateValueAfterMarker(editor, ".modelTierCatalog=");
    expect(status.mode).toBe("tiered");
    expect(status.tier).toBe("advanced");
    expect(status.blockedReason).toBe("Choose a valid model tier before starting");
    expect(boundCatalog).toEqual(catalog);
    expect(catalog.rows.advanced.reason).toBe("Advanced points to a missing model");
    expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(true);

    startSessionPrompt(app, "do not start");
    await startSessionAndOpenChat(app);

    expect(startWithPrompt).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    // The refusal is reported on the start screen itself, not through
    // `state.error`, which selects which screen renders at all.
    expect(templateText(renderApp(app))).toContain("Choose a valid model tier before starting");
  });

  it("keeps the start screen and its repair controls mounted after a blocked direct start", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    setAppState(app, preferenceCapableStarterState());

    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    await startSessionAndOpenChat(app);

    expect(start).not.toHaveBeenCalled();
    // `shouldShowSessionStartScreen()` requires an empty `state.error`, so a
    // block published there would unmount the controls that repair it.
    expect(appState(app).error).toBe("");
    // Throws if the start screen no longer renders its composer.
    const editor = promptEditorTemplate(app);
    const status = policyStatus(templateValueAfterMarker(editor, ".modelPolicyStatus="));
    expect(status.mode).toBe("tiered");
    expect(status.tier).toBe("advanced");
    expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(true);
    expect(templateValueAfterMarker(editor, ".onSelectPolicyTier=")).toBeTypeOf("function");
    // T6-F-3: the refusal still is not silent.
    expect(templateText(renderApp(app))).toContain("Choose a valid model tier before starting");
  });

  it("switches blocked Tiered intent to complete Exact after catalog loading fails", async () => {
    const app = createApp();
    const settings = vi.spyOn(modelTiersApi, "settings").mockRejectedValue(new Error("catalog offline"));
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults());
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    stubComposerFocus(app);
    setAppState(app, preferenceCapableStarterState());

    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    await selectPolicyMode(app, "exact");

    expect(settings).toHaveBeenCalledOnce();
    expect(starterModelPolicy(app)?.mode).toBe("exact");
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".sendDisabled=")).toBe(false);
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        mainWorkspace.path,
        { starterModelPolicyPreference: { mode: "exact", tier: "advanced" } },
        "local",
      );
    });

    startSessionPrompt(app, "start exact");
    expect(startWithPrompt).toHaveBeenCalledWith(
      "start exact",
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
  });

  it("warns after a rejected preference write but starts with the valid in-memory Tiered policy", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockRejectedValue(new Error("preference store offline"));
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    stubComposerFocus(app);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    await selectPolicyTier(app, "frontier");
    await vi.waitFor(() => {
      expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyError="))
        .toContain("Could not remember this model policy; this session will still use it.");
    });

    startSessionPrompt(app, "use frontier now");

    expect(startWithPrompt).toHaveBeenCalledWith(
      "use frontier now",
      undefined,
      undefined,
      undefined,
      { mode: "tiered", tier: "frontier" },
      expect.any(Function),
    );
  });

  it("shows a failed preference write warning above an earlier read diagnostic", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreferenceError: "Preference file could not be read",
    }));
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockRejectedValue(new Error("disk full"));
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyError="))
      .toBe("Preference file could not be read");

    await selectPolicyTier(app, "advanced");
    await vi.waitFor(() => {
      const editor = promptEditorTemplate(app);
      expect(templateValueAfterMarker(editor, ".modelPolicyError="))
        .toBe("Could not remember this model policy; this session will still use it. Error: disk full");
      expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(false);
    });
  });

  it("clears an earlier preference warning after a later successful write", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults")
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockResolvedValue(starterDefaults());
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    await selectPolicyTier(app, "advanced");
    await vi.waitFor(() => {
      expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyError="))
        .toContain("first write failed");
    });

    await selectPolicyTier(app, "frontier");
    await vi.waitFor(() => {
      expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyError=")).toBe("");
    });
  });

  it("keeps preference write warnings scoped across workspace changes", async () => {
    const app = createApp();
    const pendingWrite = deferred<SessionDefaultsResponse>();
    void pendingWrite.promise.catch(() => undefined);
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockReturnValue(pendingWrite.promise);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");
    stubWorkspaceChangeSideEffects(app);
    setRouteRestoreInProgress(app);

    await selectPolicyTier(app, "advanced");

    const mainState = appState(app);
    const featureState: AppState = {
      ...mainState,
      workspaces: [mainWorkspace, featureWorkspace],
      selectedWorkspace: featureWorkspace,
    };
    setAppState(app, featureState);
    handleWorkspaceChange(app, mainState, featureState);
    await loadStarterSessionDefaults(app, featureWorkspace);

    pendingWrite.reject(new Error("main workspace write failed"));
    await flush();

    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyError=")).toBe("");

    const beforeReturn = appState(app);
    const returnedState: AppState = { ...beforeReturn, selectedWorkspace: mainWorkspace };
    setAppState(app, returnedState);
    handleWorkspaceChange(app, beforeReturn, returnedState);
    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyError="))
      .toContain("main workspace write failed");
  });

  it("shows preference read diagnostics without blocking complete Exact defaults", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreferenceError: "Preference file has an unsupported version",
    }));
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    stubComposerFocus(app);
    setAppState(app, preferenceCapableStarterState());

    await loadStarterSessionDefaults(app, mainWorkspace);

    const editor = promptEditorTemplate(app);
    expect(starterModelPolicy(app)?.mode).toBe("exact");
    expect(templateValueAfterMarker(editor, ".modelPolicyError="))
      .toBe("Preference file has an unsupported version");
    expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(false);

    startSessionPrompt(app, "start with exact defaults");
    expect(startWithPrompt).toHaveBeenCalledOnce();
  });

  it("clears a stale preference read diagnostic after a successful preference write", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreferenceError: "Preference file could not be read",
    }));
    const update = vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults());
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    setModelTierCatalog(app, validCatalog(), "local");

    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyError="))
      .toBe("Preference file could not be read");

    await selectPolicyTier(app, "advanced");
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        mainWorkspace.path,
        { starterModelPolicyPreference: { mode: "tiered", tier: "advanced" } },
        "local",
      );
      expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyError=")).toBe("");
    });
  });

  it("keeps /login reachable when Pi has no resolved Exact model", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaultsWithoutResolvedModel());
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    setAppState(app, starterState());

    await loadStarterSessionDefaults(app, mainWorkspace);

    const editor = promptEditorTemplate(app);
    expect(policyStatus(templateValueAfterMarker(editor, ".modelPolicyStatus=")).blockedReason).toBeUndefined();
    expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(false);

    startSessionPrompt(app, "/login");

    expect(appState(app).authDialog).toEqual({ step: "method" });
    expect(startWithPrompt).not.toHaveBeenCalled();
  });

  it("starts through daemon defaults when Pi has no resolved Exact model", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaultsWithoutResolvedModel());
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    stubComposerFocus(app);
    setAppState(app, starterState());

    await loadStarterSessionDefaults(app, mainWorkspace);

    startSessionPrompt(app, "use daemon defaults");
    expect(startWithPrompt).toHaveBeenCalledWith(
      "use daemon defaults",
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );

    await startSessionAndOpenChat(app);
    expect(start).toHaveBeenCalledWith(undefined);
  });

  it("blocks an incomplete user Exact draft when Pi defaults are complete", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    setAppState(app, starterState());

    await loadStarterSessionDefaults(app, mainWorkspace);
    setStarterModelPolicy(app, {
      mode: "exact",
      exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
    });

    const editor = promptEditorTemplate(app);
    expect(policyStatus(templateValueAfterMarker(editor, ".modelPolicyStatus=")).blockedReason)
      .toBe("Choose a model and thinking level before starting");
    expect(templateValueAfterMarker(editor, ".sendDisabled=")).toBe(true);

    startSessionPrompt(app, "blocked exact");
    await startSessionAndOpenChat(app);

    expect(startWithPrompt).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("PiWebUiApp starter notice channel", () => {
  it("reports a failed direct start without touching screen selection", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionController(app), "startSession").mockRejectedValue(new Error("session daemon offline"));
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await startSessionAndOpenChat(app);
    await flush();

    // `shouldShowSessionStartScreen()` requires an empty `state.error`, so a
    // starter failure published there would unmount the composer the user needs
    // in order to retry.
    expect(appState(app).error).toBe("");
    expect(starterNotice(app)?.kind).toBe("start-failed");
    expect(templateText(renderApp(app))).toContain("session daemon offline");
  });

  it("keeps the composer mounted and the draft intact after a failed prompt start", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionController(app), "startSessionWithPrompt").mockRejectedValue(new Error("start request rejected"));
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    const draftBeforeStart = starterModelPolicy(app);

    startSessionPrompt(app, "explore the repo");
    await flush();

    expect(appState(app).error).toBe("");
    expect(starterModelPolicy(app)).toBe(draftBeforeStart);
    // Throws if the start screen stopped rendering its composer.
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".onSend=")).toBeTypeOf("function");
    expect(templateText(renderApp(app))).toContain("start request rejected");
  });

  it("reports a failed starter defaults update without unmounting the model controls", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockRejectedValue(new Error("defaults store offline"));
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await pickStarterModel(app, "openai/gpt-advanced");

    expect(appState(app).error).toBe("");
    expect(starterNotice(app)?.kind).toBe("defaults-failed");
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".onSelectModel=")).toBeTypeOf("function");
    expect(templateText(renderApp(app))).toContain("defaults store offline");
  });

  it("reports a failed starter defaults load instead of failing silently", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockRejectedValue(new Error("defaults unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setAppState(app, starterState());

    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(appState(app).error).toBe("");
    expect(starterNotice(app)?.kind).toBe("defaults-failed");
    // Pi's own defaults would still have started a session, so the composer that
    // picks a model must stay reachable.
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".onSend=")).toBeTypeOf("function");
    expect(templateText(renderApp(app))).toContain("defaults unavailable");
    expect(warn).toHaveBeenCalled();
  });

  // One markup anchor, kept deliberately narrow: the notice moved out of the
  // start-screen column into `<main>` and its class was renamed, so the CSS
  // contract and the alert role would otherwise be able to drift silently.
  it("renders the notice as an alert with the shared starter-notice class", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionController(app), "startSession").mockRejectedValue(new Error("session daemon offline"));
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await startSessionAndOpenChat(app);
    await flush();

    expect(findTemplateContaining(renderApp(app), 'class="starter-notice" role="alert"')).not.toBeUndefined();
  });

  it("reports a refusal on the composer send path, which used to return in silence", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    stubComposerFocus(app);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();

    startSessionPrompt(app, "start with a broken tier");

    expect(startWithPrompt).not.toHaveBeenCalled();
    expect(appState(app).error).toBe("");
    expect(starterNotice(app)?.kind).toBe("policy-blocked");
    expect(templateText(renderApp(app))).toContain("Choose a valid model tier before starting");
  });

  it("retires a previous notice once a starter defaults load succeeds", async () => {
    const app = createApp();
    const defaults = vi.spyOn(sessionsApi, "sessionDefaults")
      .mockRejectedValueOnce(new Error("defaults unavailable"))
      .mockResolvedValue(starterDefaults());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setAppState(app, starterState());

    await loadStarterSessionDefaults(app, mainWorkspace);
    expect(starterNotice(app)?.kind).toBe("defaults-failed");

    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(defaults).toHaveBeenCalledTimes(2);
    expect(starterNotice(app)).toBeUndefined();
    expect(templateText(renderApp(app))).not.toContain("defaults unavailable");
  });
});

// ── harness ─────────────────────────────────────────────────────────────────

function promptStartFrom(
  completion: Promise<boolean>,
): (...args: Parameters<SessionController["startSessionWithPrompt"]>) => Promise<void> {
  return (...args) => completion.then((started) => {
    args[5]?.(started);
  });
}

interface AppTimers {
  setTimeout(callback: () => void): number;
  clearTimeout(id: number): void;
}

interface ManualTimers extends AppTimers {
  runAll(): Promise<void>;
  size(): number;
}

function manualTimers(): ManualTimers {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    setTimeout(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
    async runAll() {
      while (callbacks.size > 0) {
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback();
        await flush();
      }
    },
    size: () => callbacks.size,
  };
}

function policyCapableActiveApp(timers?: AppTimers): PiWebUiApp {
  const app = createApp(timers);
  setAppState(app, activeState({
    selectedMachine: remoteMachine,
    machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.sessionsModelPolicy]) },
    modelPolicy: exactPolicyResponse(),
    availableThinkingLevels: ["off", "low", "medium", "high"],
  }));
  setModelTierCatalog(app, validCatalog(), remoteMachine.id);
  return app;
}

function legacyActiveApp(timers?: AppTimers): PiWebUiApp {
  const app = createApp(timers);
  setAppState(app, activeState({
    selectedMachine: remoteMachine,
    machineRuntimes: { [remoteMachine.id]: machineRuntime([PI_WEBUI_CAPABILITIES.modelTierSettings]) },
    availableThinkingLevels: ["off", "low", "medium", "high"],
  }));
  setModelTierCatalog(app, validCatalog(), remoteMachine.id);
  return app;
}

function createApp(timers?: AppTimers): PiWebUiApp {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("window", {
    location: { search: "" },
    localStorage: storage,
    innerWidth: 1280,
    matchMedia: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: timers === undefined ? () => 1 : (callback: () => void) => timers.setTimeout(callback),
    clearTimeout: timers === undefined ? () => undefined : (id: number) => { timers.clearTimeout(id); },
  });
  if (typeof document === "undefined") {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/", visibilityState: "visible", hasFocus: () => true });
  }
  vi.stubGlobal("requestAnimationFrame", () => 1);
  const app = new PiWebUiApp();
  if (!Reflect.set(app, "getBoundingClientRect", () => ({ width: 1280 }))) throw new Error("Could not stub PiWebUiApp bounds");
  return app;
}

function pickModel(app: PiWebUiApp, value: string): Promise<void> {
  return callAsyncAppMethod(app, "pickModel", [value]);
}

function pickThinking(app: PiWebUiApp, value: string): Promise<void> {
  return callAsyncAppMethod(app, "pickThinking", [value]);
}

function pickStarterModel(app: PiWebUiApp, value: string): Promise<void> {
  return callAsyncAppMethod(app, "pickStarterModel", [value]);
}

function pickStarterThinking(app: PiWebUiApp, value: string): Promise<void> {
  return callAsyncAppMethod(app, "pickStarterThinking", [value]);
}

function selectPolicyMode(app: PiWebUiApp, mode: "exact" | "tiered"): Promise<void> {
  return callPromptEditorCallback(app, ".onSelectPolicyMode=", mode);
}

function selectPolicyTier(app: PiWebUiApp, tier: ModelTier): Promise<void> {
  return callPromptEditorCallback(app, ".onSelectPolicyTier=", tier);
}

function selectPolicyThinking(app: PiWebUiApp, level: string): Promise<void> {
  return callPromptEditorCallback(app, ".onSelectPolicyThinking=", level);
}

function callPromptEditorCallback(app: PiWebUiApp, marker: string, value: string): Promise<void> {
  const callback: unknown = templateValueAfterMarker(promptEditorTemplate(app), marker);
  if (typeof callback !== "function") throw new Error(`prompt-editor did not bind ${marker}`);
  const result: unknown = Reflect.apply(callback, undefined, [value]);
  return result instanceof Promise ? result.then(() => undefined) : Promise.resolve();
}

function callAsyncAppMethod(app: PiWebUiApp, methodName: string, args: unknown[]): Promise<void> {
  const method: unknown = Reflect.get(app, methodName);
  if (typeof method !== "function") throw new Error(`PiWebUiApp.${methodName} is not callable`);
  const result: unknown = Reflect.apply(method, app, args);
  if (!isPromise(result)) throw new Error(`PiWebUiApp.${methodName} did not return a promise`);
  return result;
}

function policyThinkingOptions(app: PiWebUiApp): ThinkingLevelOption[] {
  const value: unknown = templateValueAfterMarker(promptEditorTemplate(app), ".policyThinkingOptions=");
  if (!Array.isArray(value) || !value.every(isThinkingLevelOption)) throw new Error("prompt-editor thinking options are unavailable");
  return value;
}

function setModelTierCatalog(app: PiWebUiApp, catalog: ModelTierSettingsResponse, machineId: string): void {
  if (!Reflect.set(app, "modelTierCatalog", catalog)) throw new Error("Could not set the model tier catalog");
  if (!Reflect.set(app, "modelTierCatalogMachineId", machineId)) throw new Error("Could not set the model tier catalog machine");
}

function appState(app: PiWebUiApp): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebUiApp state is unavailable");
  return state;
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function sessionController(app: PiWebUiApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebUiApp session controller is unavailable");
  return controller;
}

function renderApp(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "render");
  if (typeof method !== "function") throw new Error("PiWebUiApp.render is not callable");
  const rendered: unknown = Reflect.apply(method, app, []);
  if (!isTemplateResult(rendered)) throw new Error("PiWebUiApp.render did not return a template");
  return rendered;
}

function promptEditorTemplate(app: PiWebUiApp): TemplateResult {
  const template = findTemplateContaining(renderApp(app), "<prompt-editor");
  if (template === undefined) throw new Error("PiWebUiApp did not render prompt-editor");
  return template;
}

function loadModelTierCatalog(app: PiWebUiApp, machineId: string): Promise<void> {
  const method: unknown = Reflect.get(app, "loadModelTierCatalog");
  if (typeof method !== "function") throw new Error("PiWebUiApp.loadModelTierCatalog is not callable");
  const result: unknown = Reflect.apply(method, app, [machineId]);
  if (!isPromise(result)) throw new Error("PiWebUiApp.loadModelTierCatalog did not return a promise");
  return result;
}

function loadStarterSessionDefaults(app: PiWebUiApp, workspace: Workspace): Promise<void> {
  const method: unknown = Reflect.get(app, "loadStarterSessionDefaults");
  if (typeof method !== "function") throw new Error("PiWebUiApp.loadStarterSessionDefaults is not callable");
  const result: unknown = Reflect.apply(method, app, [workspace]);
  if (!isPromise(result)) throw new Error("PiWebUiApp.loadStarterSessionDefaults did not return a promise");
  return result;
}

function handleWorkspaceChange(app: PiWebUiApp, previous: AppState, next: AppState): void {
  const method: unknown = Reflect.get(app, "handleWorkspaceChange");
  if (typeof method !== "function") throw new Error("PiWebUiApp.handleWorkspaceChange is not callable");
  Reflect.apply(method, app, [previous, next]);
}

function handleMachineChange(app: PiWebUiApp, previous: AppState, next: AppState): void {
  const method: unknown = Reflect.get(app, "handleMachineChange");
  if (typeof method !== "function") throw new Error("PiWebUiApp.handleMachineChange is not callable");
  Reflect.apply(method, app, [previous, next]);
}

function startSessionPrompt(app: PiWebUiApp, text: string): void {
  const handler: unknown = Reflect.get(app, "handleStartSessionPrompt");
  if (typeof handler !== "function") throw new Error("PiWebUiApp.handleStartSessionPrompt is not callable");
  Reflect.apply(handler, app, [text]);
}

function startSessionAndOpenChat(app: PiWebUiApp): Promise<void> {
  return callAsyncAppMethod(app, "startSessionAndOpenChat", []);
}

function starterModelPolicy(app: PiWebUiApp): SessionModelPolicy | undefined {
  const value: unknown = Reflect.get(app, "starterModelPolicy");
  if (value === undefined) return undefined;
  if (!isSessionModelPolicy(value)) throw new Error("Starter model policy has an unexpected shape");
  return value;
}

function starterNotice(app: PiWebUiApp): StarterNotice | undefined {
  const value: unknown = Reflect.get(app, "starterNotice");
  if (value === undefined) return undefined;
  if (!isStarterNotice(value)) throw new Error("Starter notice has an unexpected shape");
  return value;
}

function isStarterNotice(value: unknown): value is StarterNotice {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  const scope: unknown = Reflect.get(value, "scope");
  if (kind !== "policy-blocked" && kind !== "start-failed" && kind !== "defaults-failed") return false;
  if (typeof scope !== "object" || scope === null) return false;
  return typeof Reflect.get(scope, "machineId") === "string" && typeof Reflect.get(scope, "workspaceId") === "string";
}

function setStarterModelPolicy(app: PiWebUiApp, policy: SessionModelPolicy): void {
  if (!Reflect.set(app, "starterModelPolicy", policy)) throw new Error("Could not set the starter model policy");
}

function modelTierCatalog(app: PiWebUiApp): ModelTierSettingsResponse | undefined {
  const value: unknown = Reflect.get(app, "modelTierCatalog");
  if (value === undefined) return undefined;
  if (!isModelTierCatalog(value)) throw new Error("Model tier catalog has an unexpected shape");
  return value;
}

function modelTierCatalogError(app: PiWebUiApp): string {
  const value: unknown = Reflect.get(app, "modelTierCatalogError");
  if (typeof value !== "string") throw new Error("Model tier catalog error is unavailable");
  return value;
}

function setModelTierCatalogError(app: PiWebUiApp, message: string): void {
  if (!Reflect.set(app, "modelTierCatalogError", message)) throw new Error("Could not set the catalog error");
}

function modelTierCatalogLoading(app: PiWebUiApp): boolean {
  const value: unknown = Reflect.get(app, "modelTierCatalogLoading");
  if (typeof value !== "boolean") throw new Error("Model tier catalog loading flag is unavailable");
  return value;
}

function stubWorkspaceChangeSideEffects(app: PiWebUiApp): void {
  if (!Reflect.set(app, "refreshActiveTerminals", () => Promise.resolve())) throw new Error("Could not stub terminal refresh");
  if (!Reflect.set(app, "refreshWorkspaceDeletionRuns", () => Promise.resolve())) throw new Error("Could not stub workspace deletion refresh");
}

function stubMachineChangeSideEffects(app: PiWebUiApp): void {
  if (!Reflect.set(app, "connectRealtime", () => undefined)) throw new Error("Could not stub realtime connection");
  if (!Reflect.set(app, "loadPluginsForSelectedMachine", () => Promise.resolve())) throw new Error("Could not stub plugin loading");
}

function stubComposerFocus(app: PiWebUiApp): void {
  if (!Reflect.set(app, "focusChatComposer", () => Promise.resolve())) throw new Error("Could not stub composer focus");
}

function setRouteRestoreInProgress(app: PiWebUiApp): void {
  if (!Reflect.set(app, "routeRestoreDepth", 1)) throw new Error("Could not set PiWebUiApp route restore depth");
}

function policyStatus(value: unknown): ClientSessionModelPolicyStatus {
  if (!isClientPolicyStatus(value)) throw new Error("Expected a policy status");
  return value;
}

function sessionStatusValue(value: unknown): SessionStatus {
  if (!isSessionStatus(value)) throw new Error("Expected a session status");
  return value;
}

/**
 * The `.status` value bound on `<prompt-editor>` itself.
 *
 * `.status=` is not unique in this subtree — `<chat-view>` binds it too, and the
 * shared marker helpers recurse into nested templates — so scan only the
 * prompt-editor template's own chunks, which is where all of its bindings live.
 */
function promptEditorStatus(editor: TemplateResult): SessionStatus {
  const strings = templateStrings(editor);
  const values = templateValues(editor);
  for (let index = 0; index < values.length; index += 1) {
    if (strings[index]?.includes(".status=") !== true) continue;
    return sessionStatusValue(values[index]);
  }
  throw new Error("prompt-editor did not bind a status");
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "selectedWorkspace" in value;
}

function isSessionModelPolicy(value: unknown): value is SessionModelPolicy {
  return typeof value === "object" && value !== null && "mode" in value && "exact" in value;
}

function isModelTierCatalog(value: unknown): value is ModelTierSettingsResponse {
  return typeof value === "object" && value !== null && "contractVersion" in value && "models" in value;
}

function isClientPolicyStatus(value: unknown): value is ClientSessionModelPolicyStatus {
  return typeof value === "object" && value !== null && "mode" in value && "resolved" in value && "ladderValid" in value;
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "object" && value !== null && "sessionId" in value && "isStreaming" in value;
}

function isThinkingLevelOption(value: unknown): value is ThinkingLevelOption {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "level") === "string"
    && typeof Reflect.get(value, "supported") === "boolean"
    && typeof Reflect.get(value, "selected") === "boolean";
}

function isPromise(value: unknown): value is Promise<void> {
  return value instanceof Promise;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise is unavailable");
      resolvePromise(value);
    },
    reject(error) {
      if (rejectPromise === undefined) throw new Error("Deferred rejection is unavailable");
      rejectPromise(error);
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
