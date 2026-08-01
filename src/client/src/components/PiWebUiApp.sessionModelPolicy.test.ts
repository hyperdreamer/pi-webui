// Template inspection is proportionate here: this node-environment harness
// verifies PiWebUiApp's composer policy wiring — which inputs and callbacks each
// prompt-editor receives, whether the capability gate withholds them, and what
// the starter synthesis contains. Those are Lit property/event bindings on a
// child custom element, and a real shadow-DOM harness is unavailable in this
// runner. Assertions stay on observable app state and injected collaborators.
import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import type {
  ClientSessionModelPolicyStatus,
  MachineRuntime,
  ModelTierLadder,
  ModelTierModelOption,
  ModelTierSettingsResponse,
  SessionModelPolicy,
  SessionModelPolicyResponse,
  SessionModelPolicyUpdate,
  SessionStatus,
} from "../../../shared/apiTypes";
import { modelTiersApi, sessionsApi, type Machine, type Project, type SessionDefaultsResponse, type SessionInfo, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { findTemplateContaining, isTemplateResult, templateStrings, templateValueAfterMarker, templateValues } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

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
    models: [defaultModelOption, advancedModelOption],
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

function starterDefaults(overrides: Partial<SessionDefaultsResponse> = {}): SessionDefaultsResponse {
  return {
    model: { provider: "openai", id: "gpt-default", name: "Default" },
    thinkingLevel: "medium",
    models: [{ provider: "openai", id: "gpt-default" }, { provider: "openai", id: "gpt-advanced" }],
    thinkingLevels: ["low", "medium", "high"],
    ...overrides,
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

function machineRuntime(capabilities: MachineRuntime["capabilities"]): MachineRuntime {
  return {
    machineId: remoteMachine.id,
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
    expect(templateValueAfterMarker(editor, ".modelPolicyResponse=")).toBeUndefined();
    expect(templateValueAfterMarker(editor, ".modelTierCatalog=")).toBeUndefined();
    expect(templateValueAfterMarker(editor, ".onOpenModelPolicy=")).toBeUndefined();
    expect(templateValueAfterMarker(editor, ".onSaveModelPolicy=")).toBeUndefined();
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
  it("loads the selected session's policy and the selected machine's catalog once when the dialog opens", async () => {
    const app = createApp();
    const settings = vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const loadModelPolicy = vi.spyOn(sessionController(app), "loadModelPolicy").mockResolvedValue(undefined);
    setAppState(app, activeState());

    voidCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onOpenModelPolicy="))();
    await flush();

    expect(loadModelPolicy).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledWith("local");
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelTierCatalog=")).toEqual(validCatalog());
  });

  it("passes the live status projection and the lazily read response as separate inputs", () => {
    const app = createApp();
    const response: SessionModelPolicyResponse = {
      contractVersion: 1,
      policy: { mode: "exact", exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" } },
      session: activeStatus(exactPolicyStatus()),
    };
    setAppState(app, activeState({ modelPolicy: response, isLoadingModelPolicy: true, isSavingModelPolicy: true, modelPolicyError: "nope" }));

    const editor = promptEditorTemplate(app);

    expect(templateValueAfterMarker(editor, ".modelPolicyStatus=")).toEqual(exactPolicyStatus());
    expect(templateValueAfterMarker(editor, ".modelPolicyResponse=")).toBe(response);
    expect(templateValueAfterMarker(editor, ".modelPolicyLoading=")).toBe(true);
    expect(templateValueAfterMarker(editor, ".modelPolicySaving=")).toBe(true);
    expect(templateValueAfterMarker(editor, ".modelPolicyError=")).toBe("nope");
  });

  it("delegates a save to the controller without deciding the policy itself", () => {
    const app = createApp();
    const saveModelPolicy = vi.spyOn(sessionController(app), "saveModelPolicy").mockResolvedValue(undefined);
    setAppState(app, activeState());

    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({ mode: "tiered", tier: "advanced" });

    expect(saveModelPolicy).toHaveBeenCalledWith({ mode: "tiered", tier: "advanced" });
  });

  it("drops the held policy response when the dialog closes so exact-route changes do not pay for a re-read", () => {
    const app = createApp();
    const response: SessionModelPolicyResponse = {
      contractVersion: 1,
      policy: { mode: "exact", exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" } },
      session: activeStatus(exactPolicyStatus()),
    };
    setAppState(app, activeState({ modelPolicy: response, modelPolicyError: "stale failure" }));

    voidCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onCloseModelPolicy="))();

    expect(appState(app).modelPolicy).toBeUndefined();
    expect(appState(app).modelPolicyError).toBeUndefined();
    // The trigger keeps rendering from the live status projection, and the
    // per-machine catalog stays cached for the next open.
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus=")).toEqual(exactPolicyStatus());
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

  it("does not report an invalid ladder merely because the catalog has not arrived", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    const pending = deferred<ModelTierSettingsResponse>();
    vi.spyOn(modelTiersApi, "settings").mockReturnValueOnce(pending.promise);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    voidCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onOpenModelPolicy="))();

    const loadingStatus = policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus="));
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyLoading=")).toBe(true);
    expect(loadingStatus.ladderValid).toBe(true);
    expect(loadingStatus.blockedReason).toBeUndefined();

    pending.resolve({ ...validCatalog(), valid: false, configError: "missing model-tier ladder in settings.json" });
    await flush();

    // A catalog that actually arrived invalid still reports an invalid ladder.
    expect(policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus=")).ladderValid).toBe(false);
  });

  it("preserves the remembered Exact branch when the starter chooses a Tiered policy, and writes no Pi default", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    const updateDefaults = vi.spyOn(sessionsApi, "updateSessionDefaults");
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    voidCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onOpenModelPolicy="))();
    await flush();
    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({ mode: "tiered", tier: "advanced" });

    expect(starterModelPolicy(app)).toEqual({
      mode: "tiered",
      tier: "advanced",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });
    expect(updateDefaults).not.toHaveBeenCalled();
    const editor = promptEditorTemplate(app);
    expect(templateValueAfterMarker(editor, ".modelPolicyStatus=")).toEqual({
      mode: "tiered",
      tier: "advanced",
      resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
      ladderValid: true,
    });
    const response = policyResponse(templateValueAfterMarker(editor, ".modelPolicyResponse="));
    expect(response.contractVersion).toBe(1);
    expect(response.policy).toEqual(starterModelPolicy(app));
    expect(response.session).toMatchObject({
      sessionId: "starter",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      cost: 0,
      model: { provider: "openai", id: "gpt-default", name: "Default" },
      thinkingLevel: "medium",
    });
  });

  it("reports the exact tuple, not the remembered tier's entry, after the starter returns to Exact", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    voidCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onOpenModelPolicy="))();
    await flush();

    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({ mode: "tiered", tier: "advanced" });
    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });

    // The canonical tier stays remembered, exactly as a persisted policy keeps it.
    expect(starterModelPolicy(app)).toEqual({
      mode: "exact",
      tier: "advanced",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    });
    // What the trigger and the panel's "Current:" line report must be what the
    // session will actually start from, which in Exact mode is the exact tuple.
    const status = policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus="));
    expect(status.mode).toBe("exact");
    expect(status.tier).toBe("advanced");
    expect(status.resolved).toEqual({ model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" });
    expect(status.blockedReason).toBeUndefined();
  });

  it("keeps an unresolvable starter tier repairable by reporting it as blocked with a policy present", async () => {
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
    expect(policyResponse(templateValueAfterMarker(editor, ".modelPolicyResponse=")).policy).not.toBeUndefined();
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
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyResponse=")).toBeUndefined();
  });

  it("relinks the Exact branch after a starter model default is confirmed", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockResolvedValue(starterDefaults({
      model: { provider: "openai", id: "gpt-advanced" },
      thinkingLevel: "high",
    }));
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await updateStarterSessionDefaults(app, { model: { provider: "openai", modelId: "gpt-advanced" } });

    expect(starterModelPolicy(app)).toEqual({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    });
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
  it("forwards a Tiered starter choice and clears it only after the prompt start succeeds", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSessionWithPrompt").mockResolvedValue(true);
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({ mode: "tiered", tier: "advanced" });

    startSessionPrompt(app, "explore the repo");

    expect(start).toHaveBeenCalledWith("explore the repo", undefined, undefined, undefined, { mode: "tiered", tier: "advanced" });
    expect(starterModelPolicy(app)).toMatchObject({ mode: "tiered", tier: "advanced" });
    await flush();
    expect(starterModelPolicy(app)).toBeUndefined();
  });

  it("forwards a Tiered starter choice and clears it only after the nav start succeeds", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(true);
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({ mode: "tiered", tier: "advanced" });

    await startSessionAndOpenChat(app);

    expect(start).toHaveBeenCalledWith({ mode: "tiered", tier: "advanced" });
    await flush();
    expect(starterModelPolicy(app)).toBeUndefined();
  });

  it("retains a failed Tiered starter choice and carries it into a retry", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    let attempt = 0;
    const start = vi.spyOn(sessionController(app), "startSessionWithPrompt").mockImplementation(() => {
      attempt += 1;
      const pending: SessionInfo = {
        ...activeSession(),
        id: `pending-session-${String(attempt)}`,
        path: `pi-webui://pending-session/${String(attempt)}`,
        persisted: false,
      };
      applyStatePatch(app, { sessions: [pending], selectedSession: pending });
      return Promise.resolve(false);
    });
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({ mode: "tiered", tier: "advanced" });

    startSessionPrompt(app, "first attempt");
    await flush();

    expect(starterModelPolicy(app)).toMatchObject({ mode: "tiered", tier: "advanced" });

    startSessionPrompt(app, "retry attempt");
    await flush();

    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls.map((call) => call[4])).toEqual([
      { mode: "tiered", tier: "advanced" },
      { mode: "tiered", tier: "advanced" },
    ]);
    expect(starterModelPolicy(app)).toMatchObject({ mode: "tiered", tier: "advanced" });
  });

  it("does not clear a starter choice when loading or an unrelated error hides the start screen", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({ mode: "tiered", tier: "advanced" });
    const draft = starterModelPolicy(app);

    applyStatePatch(app, { isLoadingSessions: true });
    expect(starterModelPolicy(app)).toBe(draft);

    applyStatePatch(app, { isLoadingSessions: false });
    await flush();
    applyStatePatch(app, { error: "unrelated refresh failure" });

    expect(starterModelPolicy(app)).toBe(draft);
  });

  it("does not clear a starter choice changed while its start is in flight", async () => {
    const app = createApp();
    const completion = deferred<boolean>();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSessionWithPrompt").mockReturnValue(completion.promise);
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    const save = saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="));
    save({ mode: "tiered", tier: "advanced" });

    startSessionPrompt(app, "explore the repo");
    save({ mode: "tiered", tier: "capable" });
    const changedDraft = starterModelPolicy(app);
    completion.resolve(true);
    await flush();

    expect(start).toHaveBeenCalledWith("explore the repo", undefined, undefined, undefined, { mode: "tiered", tier: "advanced" });
    expect(starterModelPolicy(app)).toBe(changedDraft);
    expect(starterModelPolicy(app)).toMatchObject({ mode: "tiered", tier: "capable" });
  });

  it("does not clear a starter choice after the user moves to another workspace", async () => {
    const app = createApp();
    const completion = deferred<boolean>();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    vi.spyOn(sessionController(app), "startSession").mockReturnValue(completion.promise);
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({ mode: "tiered", tier: "advanced" });
    const otherWorkspaceDraft = starterModelPolicy(app);

    await startSessionAndOpenChat(app);
    setAppState(app, {
      ...appState(app),
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
    });
    completion.resolve(true);
    await flush();

    expect(starterModelPolicy(app)).toBe(otherWorkspaceDraft);
  });

  it("snapshots and reports the exact tuple after the starter returns to Exact from a remembered tier", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSessionWithPrompt").mockResolvedValue(false);
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    const save = saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="));
    save({ mode: "tiered", tier: "advanced" });
    save({ mode: "exact", exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "low" } });

    const status = policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus="));
    startSessionPrompt(app, "explore the repo");

    // The remembered tier must not leak into either observable account of the
    // impending start: Exact mode reports and sends the same exact tuple.
    expect(status.resolved).toEqual({ model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "low" });
    expect(start).toHaveBeenCalledWith("explore the repo", undefined, undefined, undefined, {
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "low" },
    });
  });

  it("passes no policy for an untouched Exact starter", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSessionWithPrompt").mockResolvedValue(false);
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");

    startSessionPrompt(app, "explore the repo");

    expect(start).toHaveBeenCalledWith("explore the repo", undefined, undefined, undefined, undefined);
  });

  it("forwards an Exact selection the starter repaired away from the linked defaults", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(modelTiersApi, "settings").mockResolvedValue(validCatalog());
    const start = vi.spyOn(sessionController(app), "startSessionWithPrompt").mockResolvedValue(false);
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await loadModelTierCatalog(app, "local");
    saveCallback(templateValueAfterMarker(promptEditorTemplate(app), ".onSaveModelPolicy="))({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    });

    startSessionPrompt(app, "explore the repo");

    expect(start).toHaveBeenCalledWith("explore the repo", undefined, undefined, undefined, {
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    });
  });
});

// ── harness ─────────────────────────────────────────────────────────────────

type VoidCallback = () => void;
type SaveCallback = (update: SessionModelPolicyUpdate) => void;

function createApp(): PiWebUiApp {
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
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  if (typeof document === "undefined") {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/", visibilityState: "visible", hasFocus: () => true });
  }
  vi.stubGlobal("requestAnimationFrame", () => 1);
  const app = new PiWebUiApp();
  if (!Reflect.set(app, "getBoundingClientRect", () => ({ width: 1280 }))) throw new Error("Could not stub PiWebUiApp bounds");
  return app;
}

function appState(app: PiWebUiApp): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebUiApp state is unavailable");
  return state;
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

/** Drive a real `setState()` so its transition side effects run. */
function applyStatePatch(app: PiWebUiApp, patch: Partial<AppState>): void {
  const method: unknown = Reflect.get(app, "setState");
  if (typeof method !== "function") throw new Error("PiWebUiApp.setState is not callable");
  Reflect.apply(method, app, [patch]);
}

function startSessionAndOpenChat(app: PiWebUiApp): Promise<void> {
  const method: unknown = Reflect.get(app, "startSessionAndOpenChat");
  if (typeof method !== "function") throw new Error("PiWebUiApp.startSessionAndOpenChat is not callable");
  const result: unknown = Reflect.apply(method, app, []);
  if (!isPromise(result)) throw new Error("PiWebUiApp.startSessionAndOpenChat did not return a promise");
  return result;
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

function updateStarterSessionDefaults(app: PiWebUiApp, update: { model?: { provider: string; modelId: string }; thinkingLevel?: string }): Promise<void> {
  const method: unknown = Reflect.get(app, "updateStarterSessionDefaults");
  if (typeof method !== "function") throw new Error("PiWebUiApp.updateStarterSessionDefaults is not callable");
  const result: unknown = Reflect.apply(method, app, [update]);
  if (!isPromise(result)) throw new Error("PiWebUiApp.updateStarterSessionDefaults did not return a promise");
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

function starterModelPolicy(app: PiWebUiApp): SessionModelPolicy | undefined {
  const value: unknown = Reflect.get(app, "starterModelPolicy");
  if (value === undefined) return undefined;
  if (!isSessionModelPolicy(value)) throw new Error("Starter model policy has an unexpected shape");
  return value;
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

function voidCallback(value: unknown): VoidCallback {
  if (!isVoidCallback(value)) throw new Error("Expected a composer policy callback");
  return value;
}

function saveCallback(value: unknown): SaveCallback {
  if (!isSaveCallback(value)) throw new Error("Expected a composer policy save callback");
  return value;
}

function policyStatus(value: unknown): ClientSessionModelPolicyStatus {
  if (!isClientPolicyStatus(value)) throw new Error("Expected a policy status");
  return value;
}

function policyResponse(value: unknown): SessionModelPolicyResponse {
  if (!isPolicyResponse(value)) throw new Error("Expected a policy response");
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

function isVoidCallback(value: unknown): value is VoidCallback {
  return typeof value === "function";
}

function isSaveCallback(value: unknown): value is SaveCallback {
  return typeof value === "function";
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

function isPolicyResponse(value: unknown): value is SessionModelPolicyResponse {
  return typeof value === "object" && value !== null && "contractVersion" in value && "session" in value;
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "object" && value !== null && "sessionId" in value && "isStreaming" in value;
}

function isPromise(value: unknown): value is Promise<void> {
  return value instanceof Promise;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise is unavailable");
      resolvePromise(value);
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
