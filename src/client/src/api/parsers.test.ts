import { describe, expect, it } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import { SESSION_NOTIFICATION_LIMIT, SESSION_NOTIFICATION_MESSAGE_BYTES, SESSION_UNREAD_CATALOG_ID_MAX_LENGTH } from "../../../shared/apiTypes";
import { SPEECH_INPUT_MAX_TRANSCRIPT_BYTES } from "../../../shared/speechInputAudio";
import { parseAuthProvidersResponse, parseCommandResult, parseFileContentResponse, parseFileSuggestion, parseGitStatusResponse, parseHostSpeechStatus, parseHostSpeechStopResponse, parseHostSpeechTerminalResult, parseLearnedSkillsSnapshotResponse, parseMachineRuntime, parseMemorySnapshotResponse, parseMessagePage, parseModelTierSettingsResponse, parseSpeechInputSettingsResponse, parseSpeechInputTranscribeResponse, parseUtilityModelSettingsResponse, parseOAuthFlowState, parsePiPackageMutationResponse, parsePiPackagesResponse, parsePiWebUiConfigResponse, parsePiWebUiPluginsResponse, parsePiWebUiRuntimeResponse, parsePiWebUiStatusResponse, parseSessionBulkArchiveResponse, parseSessionBulkDeleteArchivedResponse, parseSessionCleanupExecuteResponse, parseSessionCleanupPreviewResponse, parseSessionDefaultsResponse, parseSessionDefaultsV2Response, parseSessionInfo, parseSessionMessageForkResult, parseSessionModelPolicyResponse, parseSessionReorderResponse, parseSessionNotificationInboxEvent, parseSessionNotificationInboxSnapshot, parseSessionStatus, parseSessionStreamSnapshot, parseSessionSystemPrompt, parseSessionTreeNavigateResult, parseSessionTreeSnapshot, parseSessionUnreadCatalogSnapshot, parseSessionUnreadEvent, parseSlashCommand, parseSystemInfoResponse, parseSystemMetricsResponse, parseTerminalCommandRun, parseTerminalInfo, parseWorkspace, parseWorkspaceActivityResponse } from "./parsers";

describe("API parsers", () => {
  it("strictly parses gateway speech transcription responses", () => {
    expect(parseSpeechInputTranscribeResponse({ text: "transcript" })).toEqual({ text: "transcript" });

    for (const value of [
      null,
      [],
      {},
      { text: "" },
      { text: "   " },
      { text: 1 },
      { text: "x".repeat(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES + 1) },
      { text: "transcript", extra: true },
    ]) {
      expect(() => parseSpeechInputTranscribeResponse(value)).toThrow();
    }
  });

  it("strictly parses host speech status documents", () => {
    const available = {
      available: true,
      voices: [
        { name: "Ada", language: "en-US" },
        { name: "Marta", language: "de-DE", variant: "female" },
      ],
    };
    const unavailable = {
      available: false,
      reason: "Speech Dispatcher is unavailable.",
      voices: [],
    };

    expect(parseHostSpeechStatus(available)).toEqual(available);
    expect(parseHostSpeechStatus({ available: true, voices: [] })).toEqual({ available: true, voices: [] });
    expect(parseHostSpeechStatus(unavailable)).toEqual(unavailable);
  });

  it("rejects malformed host speech status fields and nested voice entries", () => {
    const available = { available: true, voices: [{ name: "Ada", language: "en-US" }] };

    for (const value of [
      null,
      [],
      { voices: [] },
      { available: true },
      { ...available, available: "yes" },
      { ...available, extra: true },
      { available: false, voices: [] },
      { available: false, reason: "   ", voices: [] },
      { ...available, reason: 7 },
      { available: true, voices: [{ name: "Ada", language: "en-US", extra: true }] },
      { available: true, voices: [{ language: "en-US" }] },
      { available: true, voices: [{ name: "Ada" }] },
      { available: true, voices: [{ name: "", language: "en-US" }] },
      { available: true, voices: [{ name: "Ada", language: "" }] },
      { available: true, voices: [{ name: "Ada", language: "en-US", variant: "" }] },
      { available: true, voices: [{ name: "Ada", language: "en-US" }, { name: "Ada", language: "en-GB" }] },
    ]) {
      expect(() => parseHostSpeechStatus(value)).toThrow();
    }
  });

  it("strictly parses host speech terminal and stop responses", () => {
    expect(parseHostSpeechTerminalResult({ runId: "run-1", outcome: "ended" })).toEqual({ runId: "run-1", outcome: "ended" });
    expect(parseHostSpeechTerminalResult({ runId: "run-2", outcome: "canceled" })).toEqual({ runId: "run-2", outcome: "canceled" });
    expect(parseHostSpeechStopResponse({ runId: "run-1", stopped: true })).toEqual({ runId: "run-1", stopped: true });
    expect(parseHostSpeechStopResponse({ runId: "run-2", stopped: false })).toEqual({ runId: "run-2", stopped: false });

    for (const value of [
      {},
      { runId: "bad run", outcome: "ended" },
      { runId: "run-1", outcome: "unknown" },
      { runId: "run-1", outcome: "ended", extra: true },
    ]) {
      expect(() => parseHostSpeechTerminalResult(value)).toThrow();
    }
    for (const value of [
      {},
      { runId: "bad run", stopped: true },
      { runId: "run-1", stopped: "yes" },
      { runId: "run-1", stopped: true, extra: true },
    ]) {
      expect(() => parseHostSpeechStopResponse(value)).toThrow();
    }
  });

  it("parses dynamic memory and network metrics", () => {
    expect(parseSystemMetricsResponse({
      generatedAt: "2026-03-10T12:00:00.000Z",
      memory: { totalBytes: 1_000, usedBytes: 750, freeBytes: 250, usagePercent: 75 },
      network: { downloadSpeedBytesPerSecond: 1_500_000, uploadSpeedBytesPerSecond: 250_000 },
    })).toEqual({
      generatedAt: "2026-03-10T12:00:00.000Z",
      memory: { totalBytes: 1_000, usedBytes: 750, freeBytes: 250, usagePercent: 75 },
      network: { downloadSpeedBytesPerSecond: 1_500_000, uploadSpeedBytesPerSecond: 250_000 },
    });
  });

  it("parses typed memory snapshots and preserves project availability context", () => {
    const entry = {
      id: "pi-hermes-memory:entry-1",
      content: "Remember this.",
      category: "preference",
      created: "2026-07-29",
      last: "2026-07-30",
      failureReason: "none",
    };

    expect(parseMemorySnapshotResponse({
      kind: "data",
      globalEntries: [entry],
      projectEntries: [],
      projectUnavailableMessage: "Project-specific memory could not be loaded.",
    })).toEqual({
      kind: "data",
      globalEntries: [entry],
      projectEntries: [],
      projectUnavailableMessage: "Project-specific memory could not be loaded.",
    });
    expect(parseMemorySnapshotResponse({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
  });

  it("rejects missing discriminators and malformed memory entry arrays", () => {
    expect(() => parseMemorySnapshotResponse({ globalEntries: [], projectEntries: [] })).toThrow("Invalid memory snapshot response");
    expect(() => parseMemorySnapshotResponse({ kind: "data", globalEntries: "not-an-array", projectEntries: [] })).toThrow("Invalid memory snapshot response");
    expect(() => parseMemorySnapshotResponse({
      kind: "data",
      globalEntries: [{ id: "valid", content: "Valid entry" }, { id: "missing-content" }],
      projectEntries: [],
    })).toThrow("Invalid memory snapshot response");
  });

  it("parses typed learned-skill snapshots and preserves optional metadata", () => {
    expect(parseLearnedSkillsSnapshotResponse({
      kind: "data",
      globalSkills: [{
        id: "pi-hermes-memory:global",
        name: "global",
        description: "Global skill",
        filePath: "/agent/pi-hermes-memory/skills/global/SKILL.md",
        version: 2,
      }],
      projectSkills: [],
    })).toEqual({
      kind: "data",
      globalSkills: [{
        id: "pi-hermes-memory:global",
        name: "global",
        description: "Global skill",
        filePath: "/agent/pi-hermes-memory/skills/global/SKILL.md",
        version: 2,
      }],
      projectSkills: [],
    });
    expect(parseLearnedSkillsSnapshotResponse({
      kind: "data",
      globalSkills: [{
        id: "pi-hermes-memory:global",
        name: "global",
        description: "Global skill",
        filePath: "/agent/pi-hermes-memory/skills/global/SKILL.md",
        created: "2026-08-01",
        updated: "2026-08-05",
      }],
      projectSkills: [],
      projectUnavailableMessage: "Project-specific learned skills could not be loaded.",
    })).toEqual({
      kind: "data",
      globalSkills: [{
        id: "pi-hermes-memory:global",
        name: "global",
        description: "Global skill",
        filePath: "/agent/pi-hermes-memory/skills/global/SKILL.md",
        created: "2026-08-01",
        updated: "2026-08-05",
      }],
      projectSkills: [],
      projectUnavailableMessage: "Project-specific learned skills could not be loaded.",
    });
    expect(parseLearnedSkillsSnapshotResponse({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
  });

  it("rejects malformed learned-skill snapshots", () => {
    const base = { kind: "data", globalSkills: [], projectSkills: [] };
    const skill = {
      id: "pi-hermes-memory:global",
      name: "global",
      description: "Global skill",
      filePath: "/agent/pi-hermes-memory/skills/global/SKILL.md",
    };

    expect(() => parseLearnedSkillsSnapshotResponse({ globalSkills: [], projectSkills: [] })).toThrow("Invalid learned skills snapshot response");
    expect(() => parseLearnedSkillsSnapshotResponse({ ...base, kind: "stream" })).toThrow("Invalid learned skills snapshot response");
    expect(() => parseLearnedSkillsSnapshotResponse({ ...base, globalSkills: "not-an-array" })).toThrow("Invalid learned skills snapshot response");
    expect(() => parseLearnedSkillsSnapshotResponse({ ...base, projectSkills: null })).toThrow("Invalid learned skills snapshot response");

    for (const field of ["id", "name", "description", "filePath"] as const) {
      expect(() => parseLearnedSkillsSnapshotResponse({
        ...base,
        globalSkills: [{ ...skill, [field]: 42 }],
      })).toThrow(`Expected string field: ${field}`);
    }
    expect(() => parseLearnedSkillsSnapshotResponse({
      ...base,
      globalSkills: [{ ...skill, version: "2" }],
    })).toThrow("Expected optional number field: version");
    expect(() => parseLearnedSkillsSnapshotResponse({
      ...base,
      globalSkills: [{ ...skill, created: 20260801 }],
    })).toThrow("Expected optional string field: created");
    expect(() => parseLearnedSkillsSnapshotResponse({
      ...base,
      globalSkills: [{ ...skill, updated: null }],
    })).toThrow("Expected optional string field: updated");
    expect(() => parseLearnedSkillsSnapshotResponse({
      ...base,
      projectUnavailableMessage: 7,
    })).toThrow("Invalid learned skills snapshot response");
  });

  it("parses optional network transfer speeds from system info", () => {
    expect(parseSystemInfoResponse({
      generatedAt: "2026-03-10T12:00:00.000Z",
      os: { platform: "linux", release: "6.0", arch: "x64", uptimeSeconds: 60 },
      cpu: { model: "CPU", cores: 4, usagePercent: 20 },
      memory: { totalBytes: 1_000, usedBytes: 500, freeBytes: 500, usagePercent: 50 },
      network: {
        hostname: "host",
        localIpv4Addresses: ["192.168.1.10"],
        downloadSpeedBytesPerSecond: 1_500_000,
        uploadSpeedBytesPerSecond: 250_000,
      },
    }).network).toMatchObject({
      downloadSpeedBytesPerSecond: 1_500_000,
      uploadSpeedBytesPerSecond: 250_000,
    });
  });

  it("preserves additive interactive API-key flow hints and defaults legacy options", () => {
    const base = { id: "openai", name: "OpenAI", authType: "api_key", status: { configured: false } };

    expect(parseAuthProvidersResponse({ providers: [{ ...base, loginFlow: "interactive" }, base] }).providers).toEqual([
      { ...base, loginFlow: "interactive" },
      base,
    ]);
  });

  it("preserves additive OAuth interaction semantics", () => {
    expect(parseOAuthFlowState({
      flowId: "flow-1",
      providerId: "provider",
      providerName: "Provider",
      status: "running",
      auth: {
        url: "https://example.test/device",
        instructions: "Enter code",
        deviceCode: { userCode: "ABCD", intervalSeconds: 5, expiresInSeconds: 900 },
      },
      prompt: { requestId: "prompt-1", message: "Secret", kind: "prompt", promptType: "secret", allowEmpty: false, placeholder: "token" },
      select: { requestId: "select-1", message: "Choose", options: [{ value: "work", label: "Work", description: "Company account" }] },
      progress: ["Read the guide"],
      info: [{ message: "Read the guide", links: [{ url: "https://example.test/docs", label: "Guide" }] }],
    })).toMatchObject({
      auth: { deviceCode: { userCode: "ABCD", intervalSeconds: 5, expiresInSeconds: 900 } },
      prompt: { kind: "prompt", promptType: "secret", allowEmpty: false },
      select: { options: [{ value: "work", description: "Company account" }] },
      info: [{ links: [{ url: "https://example.test/docs", label: "Guide" }] }],
    });
  });

  it("defaults semantic prompt types from legacy OAuth wire kinds", () => {
    const flow = {
      flowId: "flow-1",
      providerId: "provider",
      providerName: "Provider",
      status: "running",
      progress: [],
    };

    expect(parseOAuthFlowState({ ...flow, prompt: { requestId: "text", message: "Value", kind: "prompt" } }).prompt).toMatchObject({
      kind: "prompt",
      promptType: "text",
    });
    expect(parseOAuthFlowState({ ...flow, prompt: { requestId: "manual", message: "Code", kind: "manual" } }).prompt).toMatchObject({
      kind: "manual",
      promptType: "manual_code",
    });
  });

  it("parses PI WEBUI config responses", () => {
    expect(parsePiWebUiConfigResponse({
      path: "/tmp/config.json",
      exists: true,
      config: { host: "0.0.0.0", port: 8808, allowedHosts: ["example.local"], shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false, settings: { compact: true } } }, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "manual/uploads" }, maxUploadBytes: 1234, agent: { command: "agent-lab", dir: "~/agent-profiles/lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8808, allowedHosts: true, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: ".pi-webui/uploads" }, agent: { command: "agent-lab", dir: "/Users/dev/agent-profiles/lab" } },
      envOverrides: { host: true, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: true, agentDirSource: "pi-compatibility", agentSessionDir: false },
    })).toEqual({
      path: "/tmp/config.json",
      exists: true,
      config: { host: "0.0.0.0", port: 8808, allowedHosts: ["example.local"], shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false, settings: { compact: true } } }, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "manual/uploads" }, maxUploadBytes: 1234, agent: { command: "agent-lab", dir: "~/agent-profiles/lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8808, allowedHosts: true, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: ".pi-webui/uploads" }, agent: { command: "agent-lab", dir: "/Users/dev/agent-profiles/lab" } },
      envOverrides: { host: true, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: true, agentDirSource: "pi-compatibility", agentSessionDir: false },
    });
  });

  it("never projects speechInput from generic config responses", () => {
    const parsed = parsePiWebUiConfigResponse({
      path: "/tmp/config.json",
      exists: true,
      config: { port: 8808, speechInput: { provider: "cloud", cloud: { apiKey: "sk-malicious", baseUrl: "https://api.openai.com/v1" } } },
      effectiveConfig: { port: 8808, speechInput: { provider: "cloud", cloud: { apiKey: "sk-malicious" } } },
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
    });

    expect(parsed.config).not.toHaveProperty("speechInput");
    expect(parsed.effectiveConfig).not.toHaveProperty("speechInput");
    expect(parsed.config.port).toBe(8808);
  });

  it("parses PI WEBUI runtime responses including the daemon-owned active profile", () => {
    expect(parsePiWebUiRuntimeResponse({
      packageName: "@hyperdreamer/pi-webui",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived, PI_WEBUI_CAPABILITIES.piPackagesManage, "future.capability"] },
        sessiond: {
          component: "sessiond",
          label: "Session daemon",
          runtimeVersion: "1.0.0",
          available: true,
          capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived],
          activeAgentProfile: {
            schemaVersion: 1,
            revision: `sha256:${"a".repeat(64)}`,
            command: "agent-lab",
            dir: "/srv/agent-lab",
            sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
          },
        },
      },
      capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived, PI_WEBUI_CAPABILITIES.piPackagesManage, "future.capability"],
    })).toMatchObject({
      capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived, PI_WEBUI_CAPABILITIES.piPackagesManage],
      components: { sessiond: { activeAgentProfile: { command: "agent-lab", dir: "/srv/agent-lab" } } },
    });
  });

  it("retains portable active profiles in machine runtime snapshots and rejects invalid ownership", () => {
    const profile = {
      schemaVersion: 1,
      revision: `sha256:${"b".repeat(64)}`,
      command: "C:\\tools\\pi.exe",
      dir: "C:\\agent-profiles\\work",
      sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
    };
    const components = {
      web: { component: "web", label: "Web/UI", available: true, capabilities: [] },
      sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [], activeAgentProfile: profile },
    };

    const parsed = parseMachineRuntime({ machineId: "remote-a", ok: true, checkedAt: "now", components, capabilities: [] });

    expect(parsed.components?.sessiond.activeAgentProfile).toMatchObject({ command: profile.command, dir: profile.dir });
    expect(Object.isFrozen(parsed.components?.sessiond.activeAgentProfile)).toBe(true);
    expect(() => parseMachineRuntime({
      machineId: "remote-a",
      ok: true,
      checkedAt: "now",
      components: { ...components, web: { ...components.web, activeAgentProfile: profile } },
      capabilities: [],
    })).toThrow("Invalid active agent profile descriptor");
    expect(() => parseMachineRuntime({
      machineId: "remote-a",
      ok: true,
      checkedAt: "now",
      components: { ...components, sessiond: { ...components.sessiond, activeAgentProfile: { ...profile, token: "secret" } } },
      capabilities: [],
    })).toThrow("Invalid active agent profile descriptor");
  });

  it("rejects malformed agent directory override metadata", () => {
    expect(() => parsePiWebUiConfigResponse({
      path: "/tmp/config.json",
      exists: true,
      config: {},
      effectiveConfig: {},
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentDirSource: "future" },
    })).toThrow("Invalid PI WEBUI agentDirSource field");
  });

  it("parses TTS config and rejects invalid nested TTS fields", () => {
    const response = {
      path: "/tmp/config.json",
      exists: true,
      config: { tts: { voice: "en-US-Test", rate: 50 } },
      effectiveConfig: { tts: { voice: "en-US-Test", rate: 50 } },
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
    };

    expect(parsePiWebUiConfigResponse(response)).toMatchObject({
      config: { tts: { voice: "en-US-Test", rate: 50 } },
      effectiveConfig: { tts: { voice: "en-US-Test", rate: 50 } },
    });

    expect(() => parsePiWebUiConfigResponse({
      ...response,
      config: { tts: { voice: "" } },
    })).toThrow("Invalid PI WEBUI tts voice field");

    expect(() => parsePiWebUiConfigResponse({
      ...response,
      config: { tts: { rate: 101 } },
    })).toThrow("Invalid PI WEBUI tts rate field");

    expect(() => parsePiWebUiConfigResponse({
      ...response,
      config: { tts: { rate: 0, autoReadAssistantReplies: true } },
    })).toThrow("Invalid PI WEBUI tts field: autoReadAssistantReplies");

    expect(() => parsePiWebUiConfigResponse({
      ...response,
      effectiveConfig: { tts: { voice: "en-US-Test", futureVoiceEngine: "edge" } },
    })).toThrow("Invalid PI WEBUI tts field: futureVoiceEngine");
  });

  it("parses Pi package list and mutation responses", () => {
    const packages = [
      { source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/tools" },
      { source: "../project-tools", scope: "project", filtered: true },
    ];

    expect(parsePiPackagesResponse({ packages })).toEqual({ packages });
    expect(parsePiPackageMutationResponse({ action: "remove", source: "../project-tools", scope: "project", removed: true, packages })).toEqual({
      action: "remove",
      source: "../project-tools",
      scope: "project",
      removed: true,
      packages,
    });
  });

  it("rejects malformed Pi package responses", () => {
    expect(() => parsePiPackagesResponse({ packages: [{ source: "npm:@acme/tools", scope: "global", filtered: false }] })).toThrow("Invalid Pi package scope");
    expect(() => parsePiPackageMutationResponse({ action: "sync", packages: [] })).toThrow("Invalid Pi package mutation action");
    expect(() => parsePiPackagesResponse({ packages: [{ source: "npm:@acme/tools", scope: "user", filtered: "no" }] })).toThrow("Expected boolean field: filtered");
  });

  it("parses Docker PI WEBUI installation metadata", () => {
    const response = {
      packageName: "@hyperdreamer/pi-webui",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, stale: false, installation: { kind: "docker", path: "/srv/pi-webui-docker", dockerMode: "runtime" } },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", available: true, stale: false, installation: { kind: "docker", dockerMode: "dev" } },
      },
      release: { packageName: "@hyperdreamer/pi-webui", updateAvailable: false },
      commands: { restart: "pi-webui-docker restart", status: "pi-webui-docker status" },
      messages: [],
    };

    const parsed = parsePiWebUiStatusResponse(response);

    expect(parsed.components.web.installation).toEqual({ kind: "docker", path: "/srv/pi-webui-docker", dockerMode: "runtime" });
    expect(parsed.components.sessiond.installation).toEqual({ kind: "docker", dockerMode: "dev" });
    expect(parsed.commands).toEqual({ restart: "pi-webui-docker restart", status: "pi-webui-docker status" });
    expect(() => parsePiWebUiStatusResponse({
      ...response,
      components: {
        ...response.components,
        web: { ...response.components.web, installation: { kind: "docker", dockerMode: "hidden" } },
      },
    })).toThrow("Invalid PI WEBUI Docker mode");
  });

  it("parses PI WEBUI plugin status responses", () => {
    expect(parsePiWebUiPluginsResponse({
      plugins: [{ id: "info", module: "/pi-webui-plugins/info/pi-webui-plugin.js?v=1", source: "bundled", scope: "bundled", machineSpecific: true, enabled: false }],
    })).toEqual({
      plugins: [{ id: "info", module: "/pi-webui-plugins/info/pi-webui-plugin.js?v=1", source: "bundled", scope: "bundled", machineSpecific: true, enabled: false }],
    });
  });

  it("accepts legacy array message pages and paged message responses", () => {
    expect(parseMessagePage(["a", "b"])).toEqual({ messages: ["a", "b"], start: 0, total: 2 });
    expect(parseMessagePage({ messages: ["c"], start: 3, total: 9 })).toEqual({ messages: ["c"], start: 3, total: 9 });
  });

  it("parses a session stream snapshot, defaulting a missing partial to null", () => {
    expect(parseSessionStreamSnapshot({ seq: 7, partial: { role: "assistant", content: [{ type: "text", text: "hi" }] } })).toEqual({
      seq: 7,
      partial: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(parseSessionStreamSnapshot({ seq: 0, partial: null })).toEqual({ seq: 0, partial: null });
    expect(parseSessionStreamSnapshot({ seq: 3 })).toEqual({ seq: 3, partial: null });
  });

  it("parses available, empty, and not-yet-loaded system prompts", () => {
    expect(parseSessionSystemPrompt({ systemPrompt: "Follow AGENTS.md" })).toEqual({ systemPrompt: "Follow AGENTS.md" });
    expect(parseSessionSystemPrompt({ systemPrompt: "" })).toEqual({ systemPrompt: "" });
    expect(parseSessionSystemPrompt({})).toEqual({});
    expect(() => parseSessionSystemPrompt({ systemPrompt: 7 })).toThrow("Expected optional string field: systemPrompt");
  });

  it("rejects a session stream snapshot without a numeric seq", () => {
    expect(() => parseSessionStreamSnapshot({ partial: null })).toThrow("Expected number field: seq");
  });

  it("strictly parses unread snapshots and identity-matched deltas", () => {
    const newest = { sessionId: "session-2", cwd: "/repo", completionOrder: 2, completedAt: "2026-07-20T00:00:02.000Z" };
    const oldest = { sessionId: "session-1", cwd: "/repo", completionOrder: 1, completedAt: "2026-07-20T00:00:01.000Z" };
    expect(parseSessionUnreadCatalogSnapshot({ catalogId: "catalog-a", catalogRevision: 2, sessions: [newest, oldest] })).toEqual({
      catalogId: "catalog-a",
      catalogRevision: 2,
      sessions: [newest, oldest],
    });
    expect(parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 3,
      sessionId: newest.sessionId,
      cwd: newest.cwd,
      unread: newest,
    })).toMatchObject({ type: "sessions.unread", unread: newest });
    expect(parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 4,
      sessionId: newest.sessionId,
      cwd: newest.cwd,
      unread: null,
    })).toMatchObject({ type: "sessions.unread", unread: null });
  });

  it("rejects malformed, duplicate, unsorted, and mismatched unread payloads", () => {
    const summary = { sessionId: "session-1", cwd: "/repo", completionOrder: 1, completedAt: "2026-07-20T00:00:01.000Z" };
    expect(() => parseSessionUnreadCatalogSnapshot({ catalogId: "catalog-a", catalogRevision: 2, sessions: [summary, summary] })).toThrow("Duplicate session unread identity");
    expect(() => parseSessionUnreadCatalogSnapshot({
      catalogId: "catalog-a",
      catalogRevision: 2,
      sessions: [summary, { ...summary, sessionId: "session-2", completionOrder: 2 }],
    })).toThrow("not newest-first");
    expect(() => parseSessionUnreadCatalogSnapshot({ catalogId: "catalog-a", catalogRevision: 1, sessions: [{ ...summary, completedAt: "never" }] })).toThrow("Invalid canonical session unread completion time");
    expect(() => parseSessionUnreadCatalogSnapshot({ catalogId: "catalog-a", catalogRevision: 1, sessions: [{ ...summary, completedAt: "2026-07-20" }] })).toThrow("Invalid canonical session unread completion time");
    expect(() => parseSessionUnreadCatalogSnapshot({
      catalogId: "x".repeat(SESSION_UNREAD_CATALOG_ID_MAX_LENGTH + 1),
      catalogRevision: 0,
      sessions: [],
    })).toThrow("String field exceeds limit: catalogId");
    expect(() => parseSessionUnreadCatalogSnapshot({
      catalogId: "catalog-a",
      catalogRevision: 0,
      sessions: [summary],
    })).toThrow("completion order exceeds catalog revision");
    expect(() => parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 1,
      sessionId: "session-1",
      cwd: "/repo",
      unread: { ...summary, completionOrder: 2 },
    })).toThrow("completion order exceeds catalog revision");
    expect(() => parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 1,
      sessionId: "other-session",
      cwd: "/repo",
      unread: summary,
    })).toThrow("identity mismatch");
    expect(() => parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 0,
      sessionId: "session-1",
      cwd: "/repo",
      unread: null,
    })).toThrow("positive safe integer");
  });

  it("parses session cleanup preview and execute responses", () => {
    const preview = {
      generatedAt: "2026-06-25T12:00:00.000Z",
      thresholds: { archiveIdleDays: 14, deleteArchivedDays: 30 },
      projects: [
        { cwd: "/repo-a", archiveCount: 2, deleteCount: 1 },
        { cwd: "/repo-b", archiveCount: 0, deleteCount: 3 },
      ],
      totals: { archiveCount: 2, deleteCount: 4 },
      skippedBusySessionIds: ["busy-1"],
    };

    expect(parseSessionCleanupPreviewResponse(preview)).toEqual(preview);
    expect(parseSessionCleanupExecuteResponse({ ...preview, archivedSessionIds: ["s1", "s2"], deletedSessionIds: ["a1"] })).toEqual({
      ...preview,
      archivedSessionIds: ["s1", "s2"],
      deletedSessionIds: ["a1"],
    });
  });

  it("rejects malformed session cleanup responses", () => {
    expect(() => parseSessionCleanupPreviewResponse({ generatedAt: "now", thresholds: {}, projects: [{ cwd: "/repo", archiveCount: "2", deleteCount: 0 }], totals: { archiveCount: 2, deleteCount: 0 } })).toThrow("Expected number field: archiveCount");
    expect(() => parseSessionCleanupExecuteResponse({ generatedAt: "now", thresholds: {}, projects: [], totals: { archiveCount: 0, deleteCount: 0 }, archivedSessionIds: ["s1"], deletedSessionIds: [1] })).toThrow("Expected string array field: deletedSessionIds");
  });

  it("parses bulk session mutation responses", () => {
    const failure = { sessionId: "busy", error: "Session is busy" };
    expect(parseSessionBulkArchiveResponse({ archived: true, archivedSessionIds: ["s1"], failures: [failure], generatedAt: "now" })).toEqual({
      archived: true,
      archivedSessionIds: ["s1"],
      failures: [failure],
      generatedAt: "now",
    });
    expect(parseSessionBulkDeleteArchivedResponse({ deleted: true, deletedSessionIds: ["s2"], failures: [], generatedAt: "later" })).toEqual({
      deleted: true,
      deletedSessionIds: ["s2"],
      failures: [],
      generatedAt: "later",
    });
  });

  it("rejects malformed bulk session mutation responses", () => {
    expect(() => parseSessionBulkArchiveResponse({ archived: true, archivedSessionIds: ["s1"], failures: [{ sessionId: "s2" }], generatedAt: "now" })).toThrow("Expected string field: error");
    expect(() => parseSessionBulkDeleteArchivedResponse({ deleted: true, deletedSessionIds: [1], failures: [], generatedAt: "now" })).toThrow("Expected string array field: deletedSessionIds");
  });

  it("parses starter session defaults with model-specific thinking levels", () => {
    const baseDefaults = {
      model: { provider: "openai", id: "gpt-default", reasoning: true },
      thinkingLevel: "high",
      models: [{ provider: "openai", id: "gpt-default", reasoning: true }],
      thinkingLevels: ["off", "low", "high"],
    };

    expect(parseSessionDefaultsResponse({
      ...baseDefaults,
      starterModelPolicyPreference: { mode: "exact", tier: "advanced" },
    })).toMatchObject({
      starterModelPolicyPreference: { mode: "exact", tier: "advanced" },
    });
    expect(parseSessionDefaultsResponse({
      ...baseDefaults,
      starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
    })).toMatchObject({
      starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
    });
    expect(parseSessionDefaultsResponse({
      ...baseDefaults,
      starterModelPolicyPreferenceError: "preference file is malformed",
    })).toMatchObject({
      starterModelPolicyPreferenceError: "preference file is malformed",
    });
    expect(parseSessionDefaultsResponse(baseDefaults)).toEqual(baseDefaults);

    expect(() => parseSessionDefaultsResponse({
      ...baseDefaults,
      starterModelPolicyPreference: { mode: "tiered" },
    })).toThrow("requires a tier");
    expect(() => parseSessionDefaultsResponse({
      ...baseDefaults,
      starterModelPolicyPreference: { mode: "automatic", tier: "standard" },
    })).toThrow("mode");
    expect(() => parseSessionDefaultsResponse({
      ...baseDefaults,
      starterModelPolicyPreference: { mode: "exact", tier: "unknown" },
    })).toThrow("tier");
    expect(() => parseSessionDefaultsResponse({
      ...baseDefaults,
      starterModelPolicyPreference: { mode: "exact", future: true },
    })).toThrow("field");
    expect(() => parseSessionDefaultsResponse({
      ...baseDefaults,
      starterModelPolicyPreference: { mode: "exact" },
      starterModelPolicyPreferenceError: "conflict",
    })).toThrow("both");

    expect(() => parseSessionDefaultsResponse({ thinkingLevel: "off", models: [], thinkingLevels: ["off", 1] })).toThrow("Expected string array field: thinkingLevels");
  });

  it("parses strict version-two starter session defaults with full and legacy preferences", () => {
    const v2Defaults = {
      starterModelPolicyContractVersion: 2,
      model: { provider: "acme", id: "available" },
      thinkingLevel: "high",
      models: [{ provider: "acme", id: "available" }],
      thinkingLevels: ["off", "high"],
      starterModelPolicyPreference: {
        mode: "tiered",
        exact: {
          model: { provider: "retired", id: "remembered" },
          thinkingLevel: "retired-level",
        },
        tier: "standard",
      },
    };
    const legacyExactDefaults = {
      ...v2Defaults,
      starterModelPolicyPreference: { mode: "exact", tier: "frontier" },
    };

    expect(parseSessionDefaultsV2Response(v2Defaults)).toEqual(v2Defaults);
    expect(parseSessionDefaultsV2Response(legacyExactDefaults)).toEqual(legacyExactDefaults);
  });

  it("rejects malformed version-two starter session defaults", () => {
    const v2Defaults = {
      starterModelPolicyContractVersion: 2,
      model: { provider: "acme", id: "available" },
      thinkingLevel: "high",
      models: [{ provider: "acme", id: "available" }],
      thinkingLevels: ["off", "high"],
      starterModelPolicyPreference: {
        mode: "tiered",
        exact: {
          model: { provider: "retired", id: "remembered" },
          thinkingLevel: "retired-level",
        },
        tier: "standard",
      },
    };

    const missingVersion: Record<string, unknown> = { ...v2Defaults };
    delete missingVersion["starterModelPolicyContractVersion"];
    expect(() => parseSessionDefaultsV2Response(missingVersion)).toThrow("contract version");
    expect(() => parseSessionDefaultsV2Response({ ...v2Defaults, starterModelPolicyContractVersion: 1 })).toThrow("contract version");
    expect(() => parseSessionDefaultsV2Response({ ...v2Defaults, starterModelPolicyContractVersion: 3 })).toThrow("contract version");
    expect(() => parseSessionDefaultsV2Response({ ...v2Defaults, starterModelPolicyContractVersion: "2" })).toThrow("contract version");
    expect(() => parseSessionDefaultsV2Response({ ...v2Defaults, unexpected: true })).toThrow("field");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: { ...v2Defaults.starterModelPolicyPreference, unexpected: true },
    })).toThrow("field");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: {
        ...v2Defaults.starterModelPolicyPreference,
        exact: { ...v2Defaults.starterModelPolicyPreference.exact, unexpected: true },
      },
    })).toThrow("field");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: {
        ...v2Defaults.starterModelPolicyPreference,
        exact: {
          ...v2Defaults.starterModelPolicyPreference.exact,
          model: { ...v2Defaults.starterModelPolicyPreference.exact.model, unexpected: true },
        },
      },
    })).toThrow("field");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: {
        ...v2Defaults.starterModelPolicyPreference,
        exact: {
          ...v2Defaults.starterModelPolicyPreference.exact,
          model: { ...v2Defaults.starterModelPolicyPreference.exact.model, provider: " " },
        },
      },
    })).toThrow("non-blank");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: {
        ...v2Defaults.starterModelPolicyPreference,
        exact: {
          ...v2Defaults.starterModelPolicyPreference.exact,
          model: { ...v2Defaults.starterModelPolicyPreference.exact.model, id: " " },
        },
      },
    })).toThrow("non-blank");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: {
        ...v2Defaults.starterModelPolicyPreference,
        exact: { ...v2Defaults.starterModelPolicyPreference.exact, thinkingLevel: " " },
      },
    })).toThrow("non-blank");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: {
        mode: "tiered",
        exact: v2Defaults.starterModelPolicyPreference.exact,
      },
    })).toThrow("requires a tier");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: { ...v2Defaults.starterModelPolicyPreference, tier: "unknown" },
    })).toThrow("tier");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreference: { mode: "exact", tier: "unknown" },
    })).toThrow("tier");
    expect(() => parseSessionDefaultsV2Response({
      ...v2Defaults,
      starterModelPolicyPreferenceError: "conflict",
    })).toThrow("both");
  });

  it("parses session info including optional persistence and creation-source signals", () => {
    expect(parseSessionInfo({
      id: "s1",
      path: "/sessions/s1.jsonl",
      cwd: "/repo",
      persisted: false,
      name: "Draft session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 0,
      firstMessage: "",
      creationSource: "session-list-plus",
    })).toEqual({
      id: "s1",
      path: "/sessions/s1.jsonl",
      cwd: "/repo",
      persisted: false,
      name: "Draft session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 0,
      firstMessage: "",
      creationSource: "session-list-plus",
    });
    expect(() => parseSessionInfo({ id: "s1", path: "", cwd: "/repo", persisted: "yes", created: "now", modified: "now", messageCount: 0, firstMessage: "" })).toThrow("Expected optional boolean field: persisted");

    expect(parseSessionInfo({
      id: "s1",
      path: "/sessions/s1.jsonl",
      cwd: "/repo",
      persisted: true,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 0,
      firstMessage: "",
      manualOrder: 3,
    })).toMatchObject({ id: "s1", manualOrder: 3 });

    for (const manualOrder of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseSessionInfo({
        id: "s1",
        path: "/sessions/s1.jsonl",
        cwd: "/repo",
        created: "now",
        modified: "now",
        messageCount: 0,
        firstMessage: "",
        manualOrder,
      })).toThrow("Expected non-negative safe integer field: manualOrder");
    }
  });

  it("parses strict normalized session reorder responses", () => {
    expect(parseSessionReorderResponse({
      orderedSessions: [
        { id: "second", cwd: "/repo", manualOrder: 0 },
        { id: "first", cwd: "/repo", manualOrder: 1 },
      ],
    })).toEqual({
      orderedSessions: [
        { id: "second", cwd: "/repo", manualOrder: 0 },
        { id: "first", cwd: "/repo", manualOrder: 1 },
      ],
    });

    for (const manualOrder of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0"]) {
      expect(() => parseSessionReorderResponse({
        orderedSessions: [{ id: "first", cwd: "/repo", manualOrder }],
      })).toThrow("Expected non-negative safe integer field: manualOrder");
    }
    expect(() => parseSessionReorderResponse({
      orderedSessions: [{ id: "first", cwd: "/repo" }],
    })).toThrow("Expected non-negative safe integer field: manualOrder");
    expect(() => parseSessionReorderResponse({ orderedSessions: {} }))
      .toThrow("Expected array response");
  });

  it("does not invent a creation source from a malformed optional field", () => {
    const parsed = parseSessionInfo({
      id: "s1",
      path: "/sessions/s1.jsonl",
      cwd: "/repo",
      created: "now",
      modified: "now",
      messageCount: 0,
      firstMessage: "",
      creationSource: "unknown",
    });

    expect(parsed).not.toHaveProperty("creationSource");
  });

  it("parses a complete session model policy response", () => {
    const value = {
      contractVersion: 1,
      policy: {
        mode: "tiered",
        exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
        tier: "advanced",
      },
      session: {
        sessionId: "s-1",
        isStreaming: false,
        isCompacting: false,
        isBashRunning: false,
        pendingMessageCount: 0,
        queuedMessages: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        modelPolicy: {
          mode: "tiered",
          tier: "advanced",
          resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
          ladderValid: true,
        },
      },
    };

    expect(parseSessionModelPolicyResponse(value)).toEqual(value);
  });

  it("accepts an omitted repair policy when status carries a non-blank blocked reason", () => {
    const value = sessionModelPolicyResponseWire();
    const repairResponse = {
      contractVersion: 1,
      session: {
        ...value.session,
        modelPolicy: {
          ...value.session.modelPolicy,
          blockedReason: "unsupported policy version",
        },
      },
    };

    expect(parseSessionModelPolicyResponse(repairResponse)).toEqual(repairResponse);
  });

  it("rejects an omitted policy without a non-blank blocked reason", () => {
    const value = sessionModelPolicyResponseWire();
    const blankReasonResponse = {
      contractVersion: 1,
      session: {
        ...value.session,
        modelPolicy: { ...value.session.modelPolicy, blockedReason: "   " },
      },
    };

    expect(() => parseSessionModelPolicyResponse({ contractVersion: 1, session: value.session })).toThrow("blockedReason");
    expect(() => parseSessionModelPolicyResponse(blankReasonResponse)).toThrow("blockedReason");
  });

  it("continues to parse legacy status without model policy", () => {
    const value = sessionModelPolicyResponseWire();
    const legacyStatus = {
      sessionId: value.session.sessionId,
      isStreaming: value.session.isStreaming,
      isCompacting: value.session.isCompacting,
      isBashRunning: value.session.isBashRunning,
      pendingMessageCount: value.session.pendingMessageCount,
      queuedMessages: value.session.queuedMessages,
      tokens: value.session.tokens,
      cost: value.session.cost,
    };

    expect(parseSessionStatus(legacyStatus)).toEqual(legacyStatus);
  });

  it("retains a canonical remembered tier while Exact policy is active", () => {
    const value = sessionModelPolicyResponseWire();
    const exact = { model: { provider: "openai", id: "gpt-exact" }, thinkingLevel: "medium" };
    const response = {
      ...value,
      policy: { mode: "exact", exact, tier: "advanced" },
      session: {
        ...value.session,
        modelPolicy: { mode: "exact", tier: "advanced", resolved: exact, ladderValid: true },
      },
    };

    expect(parseSessionModelPolicyResponse(response)).toMatchObject({
      policy: { mode: "exact", exact, tier: "advanced" },
      session: { modelPolicy: { mode: "exact", tier: "advanced", resolved: exact, ladderValid: true } },
    });
  });

  it("rejects unsupported policy contracts and unknown keys at every policy level", () => {
    const value = sessionModelPolicyResponseWire();

    expect(() => parseSessionModelPolicyResponse({ ...value, contractVersion: 2 })).toThrow("contract version");
    expect(() => parseSessionModelPolicyResponse({ ...value, unexpected: true })).toThrow("response field");
    expect(() => parseSessionModelPolicyResponse({ ...value, policy: { ...value.policy, unexpected: true } })).toThrow("policy field");
    expect(() => parseSessionModelPolicyResponse({
      ...value,
      session: { ...value.session, modelPolicy: { ...value.session.modelPolicy, unexpected: true } },
    })).toThrow("status field");
    expect(() => parseSessionModelPolicyResponse({
      ...value,
      policy: { ...value.policy, exact: { ...value.policy.exact, unexpected: true } },
    })).toThrow("exact selection field");
    expect(() => parseSessionModelPolicyResponse({
      ...value,
      policy: {
        ...value.policy,
        exact: { ...value.policy.exact, model: { ...value.policy.exact.model, unexpected: true } },
      },
    })).toThrow("model reference field");
  });

  it("rejects missing or non-canonical policy tiers", () => {
    const value = sessionModelPolicyResponseWire();

    expect(() => parseSessionModelPolicyResponse({
      ...value,
      policy: { mode: "tiered", exact: value.policy.exact },
    })).toThrow("tier");
    expect(() => parseSessionModelPolicyResponse({
      ...value,
      policy: { mode: "exact", exact: value.policy.exact, tier: "premium" },
    })).toThrow("tier");
    expect(() => parseSessionModelPolicyResponse({
      ...value,
      session: { ...value.session, modelPolicy: { ...value.session.modelPolicy, mode: "exact", tier: "premium" } },
    })).toThrow("tier");
  });

  it("rejects malformed exact selections and optional session policy status", () => {
    const value = sessionModelPolicyResponseWire();

    expect(() => parseSessionModelPolicyResponse({
      ...value,
      policy: {
        mode: "exact",
        exact: { model: { provider: " ", id: "gpt-exact" }, thinkingLevel: "medium" },
      },
    })).toThrow("provider");
    expect(() => parseSessionStatus({
      ...value.session,
      modelPolicy: { ...value.session.modelPolicy, resolved: { model: { provider: "openai" }, thinkingLevel: "high" } },
    })).toThrow("id");
    expect(() => parseSessionStatus({
      ...value.session,
      modelPolicy: { ...value.session.modelPolicy, tier: undefined },
    })).toThrow("tier");
  });

  it("validates session status including optional model, generation, and nullable context usage", () => {
    expect(parseSessionStatus({
      sessionId: "s1",
      persisted: true,
      isStreaming: false,
      isCompacting: true,
      isBashRunning: false,
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this" }, { kind: "followUp", text: "then do that" }],
      messageCount: 7,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: 0.12,
      model: { provider: "p", id: "m", contextWindow: 100, reasoning: { effort: "low" } },
      contextUsage: { tokens: null, contextWindow: 100, percent: 0.5 },
      generation: { outputTokens: 32, tokensPerSecond: 4.2 },
      thinkingLevel: "medium",
    })).toEqual({
      sessionId: "s1",
      persisted: true,
      isStreaming: false,
      isCompacting: true,
      isBashRunning: false,
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this" }, { kind: "followUp", text: "then do that" }],
      messageCount: 7,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: 0.12,
      model: { provider: "p", id: "m", contextWindow: 100, reasoning: { effort: "low" } },
      contextUsage: { tokens: null, contextWindow: 100, percent: 0.5 },
      generation: { outputTokens: 32, tokensPerSecond: 4.2 },
      thinkingLevel: "medium",
    });
  });

  it("preserves whether active generation metrics are text-derived estimates", () => {
    const parsed = parseSessionStatus({
      sessionId: "s1",
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      generation: { outputTokens: 2, tokensPerSecond: 4, estimated: true },
    });

    expect(parsed.generation).toEqual({ outputTokens: 2, tokensPerSecond: 4, estimated: true });
  });

  it("parses live session warnings including optional source and path", () => {
    const parsed = parseSessionStatus({
      sessionId: "s1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      warnings: [
        { severity: "error", message: "bad skill", source: "skill", path: "/skills/a.md" },
        { severity: "warning", message: "subscription active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
        { severity: "info", message: "heads up", source: "runtime" },
      ],
    });

    expect(parsed.warnings).toEqual([
      { severity: "error", message: "bad skill", source: "skill", path: "/skills/a.md" },
      { severity: "warning", message: "subscription active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
      { severity: "info", message: "heads up", source: "runtime" },
    ]);
  });

  it("omits warnings entirely when the field is absent", () => {
    const parsed = parseSessionStatus({
      sessionId: "s1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });

    expect(parsed.warnings).toBeUndefined();
  });

  it("rejects a warning with an invalid severity", () => {
    expect(() => parseSessionStatus({
      sessionId: "s1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      warnings: [{ severity: "fatal", message: "nope" }],
    })).toThrow("Invalid session warning severity");
  });

  it("parses workspace effective upload config when present", () => {
    expect(parseWorkspace({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      branch: "main",
      isMain: true,
      isGitRepo: true,
      isGitWorktree: false,
      effectiveConfig: { uploads: { defaultFolder: "manual/uploads" } },
    })).toEqual({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      branch: "main",
      isMain: true,
      isGitRepo: true,
      isGitWorktree: false,
      effectiveConfig: { uploads: { defaultFolder: "manual/uploads" } },
    });
  });

  it("accepts legacy workspace responses without effective config", () => {
    expect(parseWorkspace({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
    })).toEqual({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
    });
  });

  it("parses workspace activity snapshots", () => {
    expect(parseWorkspaceActivityResponse({
      generatedAt: "now",
      workspaces: [{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "later" }],
    })).toEqual({
      generatedAt: "now",
      workspaces: [{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "later" }],
    });
  });

  it("preserves the latest Git tag when supplied", () => {
    expect(parseGitStatusResponse({
      isGitRepo: true,
      hash: "h",
      branch: "main",
      latestTag: "v1.4.0",
      files: [],
    })).toEqual({
      isGitRepo: true,
      hash: "h",
      branch: "main",
      latestTag: "v1.4.0",
      files: [],
    });
  });

  it("rejects invalid enum-like fields", () => {
    expect(() => parseSlashCommand({ name: "bad", source: "remote" })).toThrow("Invalid command source");
    expect(() => parseFileSuggestion({ path: "a", kind: "deleted" })).toThrow("Invalid file kind");
    expect(() => parseGitStatusResponse({ isGitRepo: true, hash: "h", files: [{ path: "a", index: "weird", workingTree: "modified" }] })).toThrow("Invalid git file state");
  });

  it("validates file content responses", () => {
    const textFile = {
      path: "README.md",
      language: "markdown",
      encoding: "utf8",
      size: 4,
      modifiedAt: "now",
      content: "text",
      truncated: false,
      binary: false,
    };

    expect(parseFileContentResponse(textFile)).toMatchObject({ path: "README.md", language: "markdown", content: "text" });
    expect(parseFileContentResponse({ ...textFile, path: "logo.png", mediaType: "image", mimeType: "image/png", content: "", binary: true })).toMatchObject({ path: "logo.png", mediaType: "image", mimeType: "image/png" });

    expect(() => parseFileContentResponse({ encoding: "base64" })).toThrow("Invalid file encoding");
    expect(() => parseFileContentResponse({ ...textFile, mediaType: "video" })).toThrow("Invalid file media type");
  });

  it("parses terminal info with optional command-run ownership", () => {
    expect(parseTerminalInfo({
      id: "t1",
      cwd: "/repo",
      name: "Build",
      createdAt: "now",
      exited: false,
      commandRunId: "run1",
    })).toMatchObject({ id: "t1", commandRunId: "run1" });
  });

  it("parses terminal command runs", () => {
    expect(parseTerminalCommandRun({
      id: "run1",
      origin: "core",
      projectId: "p1",
      workspaceId: "w1",
      terminalId: "t1",
      title: "Build",
      command: "npm run build",
      status: "succeeded",
      exitCode: 0,
      createdAt: "now",
      startedAt: "then",
      completedAt: "later",
      metadata: { "pi.operation": "test" },
    })).toEqual({
      id: "run1",
      origin: "core",
      projectId: "p1",
      workspaceId: "w1",
      terminalId: "t1",
      title: "Build",
      command: "npm run build",
      status: "succeeded",
      exitCode: 0,
      createdAt: "now",
      startedAt: "then",
      completedAt: "later",
      metadata: { "pi.operation": "test" },
    });
    expect(() => parseTerminalCommandRun({
      id: "run1",
      origin: "core",
      projectId: "p1",
      workspaceId: "w1",
      terminalId: "t1",
      title: "Build",
      command: "npm run build",
      status: "done",
      createdAt: "now",
      metadata: {},
    })).toThrow("Invalid terminal command run status");
  });

  it("parses command result variants", () => {
    const tree = sessionTreeWire();
    expect(parseCommandResult({ type: "unsupported", message: "nope" })).toEqual({ type: "unsupported", message: "nope" });
    expect(parseCommandResult({ type: "select", requestId: "r1", title: "Pick", options: [{ value: "v", label: "Label", description: "desc" }] })).toEqual({ type: "select", requestId: "r1", title: "Pick", options: [{ value: "v", label: "Label", description: "desc" }] });
    expect(parseCommandResult({ type: "tree", tree })).toEqual({ type: "tree", tree });
    expect(parseCommandResult({ type: "done", message: "ok", promptDraft: "resend me" })).toEqual({ type: "done", message: "ok", promptDraft: "resend me" });
    expect(() => parseCommandResult({ type: "later" })).toThrow("Invalid command result type");
  });

  it("strictly parses session tree snapshots and navigation results", () => {
    const tree = sessionTreeWire();
    expect(parseSessionTreeSnapshot(tree)).toEqual(tree);
    expect(parseSessionTreeNavigateResult({ cancelled: false, editorText: "edit this" })).toEqual({ cancelled: false, editorText: "edit this" });
    expect(parseSessionTreeNavigateResult({ cancelled: false })).toEqual({ cancelled: false });
    expect(parseSessionTreeNavigateResult({ cancelled: true, aborted: true })).toEqual({ cancelled: true, aborted: true });
    expect(parseSessionTreeNavigateResult({ cancelled: true })).toEqual({ cancelled: true });
    expect(parseSessionTreeNavigateResult({ cancelled: false, editorText: "edit this", operationId: "future-metadata" })).toEqual({ cancelled: false, editorText: "edit this" });
    expect(parseSessionTreeNavigateResult({ cancelled: true, aborted: true, operationId: "future-metadata" })).toEqual({ cancelled: true, aborted: true });

    expect(() => parseSessionTreeSnapshot({ ...tree, activeLeafId: undefined })).toThrow("activeLeafId");
    expect(() => parseSessionTreeSnapshot({ ...tree, activeLeafId: "missing" })).toThrow("activeLeafId");
    expect(() => parseSessionTreeSnapshot({ ...tree, activeLeafId: "   " })).toThrow("activeLeafId");
    expect(() => parseSessionTreeSnapshot({ ...tree, activePathIds: ["root", 2] })).toThrow("activePathIds");
    expect(() => parseSessionTreeSnapshot({ ...tree, activePathIds: ["   "] })).toThrow("activePathIds");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [{ ...tree.nodes[0], id: "   " }] })).toThrow("id");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [{ ...tree.nodes[0], parentId: undefined }] })).toThrow("parentId");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [{ ...tree.nodes[0], parentId: "   " }] })).toThrow("parentId");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [tree.nodes[0], tree.nodes[0]] })).toThrow("Duplicate session tree node id");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [{ ...tree.nodes[0], kind: "future-kind" }] })).toThrow("Invalid session tree node kind");
    expect(() => parseSessionTreeNavigateResult({ cancelled: true, editorText: "wrong branch" })).toThrow("editorText");
    expect(() => parseSessionTreeNavigateResult({ cancelled: false, aborted: true })).toThrow("aborted");
    expect(() => parseSessionTreeNavigateResult({ cancelled: false, editorText: 42 })).toThrow("editorText");
    expect(() => parseSessionTreeNavigateResult({ cancelled: true, aborted: "yes" })).toThrow("aborted");
    expect(() => parseSessionTreeNavigateResult({ cancelled: false, summaryEntry: { raw: true } })).toThrow("summaryEntry");
    expect(() => parseSessionTreeNavigateResult({ cancelled: true, summaryEntry: { raw: true } })).toThrow("summaryEntry");
    expect(() => parseSessionTreeNavigateResult({ editorText: "missing discriminator" })).toThrow("cancelled");
  });

  it("parses per-message session fork results as a strict cancellation union", () => {
    const session = {
      id: "forked-session",
      path: "/sessions/forked.jsonl",
      cwd: "/repo",
      created: "2026-08-01T00:00:00.000Z",
      modified: "2026-08-01T00:01:00.000Z",
      messageCount: 2,
      firstMessage: "Start here",
    };
    expect(parseSessionMessageForkResult({ cancelled: false, session })).toEqual({ cancelled: false, session });
    expect(parseSessionMessageForkResult({ cancelled: true })).toEqual({ cancelled: true });
    expect(() => parseSessionMessageForkResult({ cancelled: true, session })).toThrow("session");
    expect(() => parseSessionMessageForkResult({ cancelled: false })).toThrow("Expected object");
  });

  it("strictly parses selected notification snapshots and realtime events", () => {
    const inbox = notificationInboxWire();

    expect(parseSessionNotificationInboxSnapshot(inbox)).toEqual(inbox);
    expect(parseSessionNotificationInboxEvent({
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 2,
      summary: { ...inbox.summary, inboxRevision: 2, retainedCount: 2, highestSeverity: "warning" },
      dismissThrough: { order: 2, overflowWatermark: 0 },
      delta: { kind: "added", notification: notificationWire(2, "warning") },
    })).toMatchObject({ type: "notifications.inbox", delta: { kind: "added", notification: { severity: "warning" } } });
  });

  it("rejects malformed, unsafe, over-cap, and oversized notification payloads", () => {
    const inbox = notificationInboxWire();
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      notifications: [{ ...notificationWire(1), severity: "fatal" }],
    })).toThrow("Invalid notification severity");
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      catalogRevision: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow("safe integer");
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      summary: { ...inbox.summary, retainedCount: SESSION_NOTIFICATION_LIMIT },
      notifications: Array.from({ length: SESSION_NOTIFICATION_LIMIT + 1 }, (_, index) => notificationWire(SESSION_NOTIFICATION_LIMIT + 1 - index)),
    })).toThrow("exceeds limit");
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      notifications: [{ ...notificationWire(1), message: "x".repeat(SESSION_NOTIFICATION_MESSAGE_BYTES + 1) }],
    })).toThrow("message exceeds byte limit");
    expect(() => parseSessionNotificationInboxEvent({
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 2,
      summary: { ...inbox.summary, inboxRevision: 2 },
      dismissThrough: { order: 1, overflowWatermark: 0 },
      delta: { kind: "cleared", reason: "future-reason" },
    })).toThrow("Invalid notification clear reason");
  });

  it("parses version 1 utility-model settings snapshots with exact model-only references", () => {
    const wire = utilityModelSettingsWire();

    expect(parseUtilityModelSettingsResponse(wire)).toEqual(wire);
    expect(parseUtilityModelSettingsResponse(wire).settings.context).toEqual({
      provider: "openai",
      id: "org/gpt-5.6-luna/medium",
    });
  });

  it("parses version 2 utility-model settings snapshots with explicit thinking levels", () => {
    const wire = utilityModelSettingsV2Wire();

    expect(parseUtilityModelSettingsResponse(wire)).toEqual(wire);
    expect(parseUtilityModelSettingsResponse(wire).settings).toEqual({
      lightweight: { provider: "openai", id: "gpt-5.6-luna", thinkingLevel: "max" },
      context: { provider: "openai", id: "org/gpt-5.6-luna/medium" },
    });
  });

  it("accepts empty version 1 utility settings and preserves stale configured references", () => {
    const empty = utilityModelSettingsWire({ settings: {}, models: [], slots: { lightweight: { valid: true }, context: { valid: true } } });
    const stale = utilityModelSettingsWire({
      settings: { lightweight: { provider: "openai", id: "retired" } },
      slots: {
        lightweight: { valid: false, reason: "lightweight utility model openai/retired is unavailable" },
        context: { valid: true },
      },
      valid: false,
    });

    expect(parseUtilityModelSettingsResponse(empty)).toEqual(empty);
    expect(parseUtilityModelSettingsResponse(stale)).toEqual(stale);
  });

  it("rejects malformed utility top-level fields, slot maps, and validation rows in both versions", () => {
    for (const wire of [utilityModelSettingsWire({ unexpected: true }), utilityModelSettingsV2Wire({ unexpected: true })]) {
      expect(() => parseUtilityModelSettingsResponse(wire)).toThrow("field");
    }
    for (const wire of [
      utilityModelSettingsWire({ slots: { lightweight: { valid: true } } }),
      utilityModelSettingsV2Wire({ slots: { lightweight: { valid: true } } }),
    ]) {
      expect(() => parseUtilityModelSettingsResponse(wire)).toThrow("slots");
    }
    for (const wire of [
      utilityModelSettingsWire({ slots: { lightweight: { valid: "yes" }, context: { valid: true } } }),
      utilityModelSettingsV2Wire({ slots: { lightweight: { valid: "yes" }, context: { valid: true } } }),
    ]) {
      expect(() => parseUtilityModelSettingsResponse(wire)).toThrow("valid");
    }
  });

  it("rejects thinking fields and malformed references in version 1 utility settings", () => {
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsWire({
      settings: { lightweight: { provider: "openai", id: "gpt", thinkingLevel: "max" } },
    }))).toThrow("thinkingLevel");
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsWire({
      models: [{ model: { provider: "openai", id: "gpt" }, thinkingLevels: ["off"] }],
    }))).toThrow("thinkingLevels");
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsWire({
      settings: { lightweight: { provider: "", id: "gpt" } },
    }))).toThrow("provider");
  });

  it("strictly parses version 2 utility thinking fields", () => {
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsV2Wire({
      models: [{ model: { provider: "openai", id: "gpt" } }],
    }))).toThrow("thinkingLevels");
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsV2Wire({
      settings: { lightweight: { provider: "openai", id: "gpt", thinkingLevel: "auto" } },
    }))).toThrow("thinkingLevel");
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsV2Wire({
      settings: { lightweight: { provider: "openai", id: "", thinkingLevel: "max" } },
    }))).toThrow("id");
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsV2Wire({
      models: [{ model: { provider: "openai", id: "gpt" }, thinkingLevels: ["off", "unknown"] }],
    }))).toThrow("thinkingLevels");
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsV2Wire({
      models: [{ model: { provider: "openai", id: "gpt" }, thinkingLevels: ["off", 1] }],
    }))).toThrow("thinkingLevels");
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsV2Wire({
      settings: { lightweight: { provider: "openai", id: "gpt", unexpected: true } },
    }))).toThrow("settings.lightweight");
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsV2Wire({
      models: [{ model: { provider: "openai", id: "gpt" }, thinkingLevels: ["off"], unexpected: true }],
    }))).toThrow("models");
  });

  it("rejects unsupported utility model contract versions", () => {
    expect(() => parseUtilityModelSettingsResponse(utilityModelSettingsWire({ contractVersion: 3 }))).toThrow("contract version");
  });

  it("parses model-tier settings snapshots with stale ladders and separate provider/model IDs", () => {
    const wire = modelTierSettingsWire();

    expect(parseModelTierSettingsResponse(wire)).toEqual(wire);
    expect(parseModelTierSettingsResponse(wire).ladder?.frontier.model).toEqual({
      provider: "openai",
      id: "org/gpt-5.6-luna/medium",
    });
  });

  it("accepts missing ladders and optional configuration errors", () => {
    const missing = modelTierSettingsWire({ ladder: undefined, valid: false });
    const malformed = modelTierSettingsWire({ ladder: undefined, configError: "missing frontier tier", valid: false });

    expect(parseModelTierSettingsResponse(missing)).not.toHaveProperty("ladder");
    expect(parseModelTierSettingsResponse(malformed)).toMatchObject({ configError: "missing frontier tier", valid: false });
    expect(parseModelTierSettingsResponse(malformed)).not.toHaveProperty("ladder");
  });

  it("rejects malformed model-tier references, thinking arrays, row maps, and contract versions", () => {
    expect(() => parseModelTierSettingsResponse(modelTierSettingsWire({
      models: [{ model: { provider: "openai" }, thinkingLevels: ["off"] }],
    }))).toThrow("id");
    expect(() => parseModelTierSettingsResponse(modelTierSettingsWire({
      models: [{ model: { provider: "openai", id: "gpt" }, thinkingLevels: ["off", 1] }],
    }))).toThrow("thinkingLevels");
    expect(() => parseModelTierSettingsResponse(modelTierSettingsWire({ rows: [] }))).toThrow("rows");
    expect(() => parseModelTierSettingsResponse(modelTierSettingsWire({
      rows: { economy: { valid: true } },
    }))).toThrow("rows");
    expect(() => parseModelTierSettingsResponse(modelTierSettingsWire({ contractVersion: 2 }))).toThrow("contract version");
  });
});

function sessionTreeWire() {
  const kinds = [
    "user",
    "assistant",
    "tool-result",
    "bash",
    "custom-message",
    "compaction",
    "branch-summary",
    "model-change",
    "thinking-level-change",
    "session-info",
    "label",
    "custom",
    "other",
  ] as const;
  const nodes = kinds.map((kind, index) => ({
    id: `entry-${String(index)}`,
    parentId: index === 0 ? null : `entry-${String(index - 1)}`,
    kind,
    summary: `${kind} summary`,
    ...(index === 0 ? { timestamp: "2026-07-20T00:00:00.000Z", label: "root label" } : {}),
  }));
  return {
    nodes,
    activeLeafId: nodes.at(-1)?.id ?? null,
    activePathIds: nodes.map((node) => node.id),
  };
}

function notificationWire(order: number, severity: "info" | "warning" | "error" = "info") {
  return {
    id: `daemon-a:${String(order)}`,
    message: `notice ${String(order)}`,
    truncated: false,
    severity,
    receivedAt: "2026-07-18T00:00:00.000Z",
    order,
  };
}

function notificationInboxWire() {
  return {
    daemonInstanceId: "daemon-a",
    catalogRevision: 1,
    summary: {
      sessionId: "session-1",
      cwd: "/repo",
      inboxRevision: 1,
      retainedCount: 1,
      discardedCount: 0,
      highestSeverity: "info" as const,
    },
    notifications: [notificationWire(1)],
    dismissThrough: { order: 1, overflowWatermark: 0 },
  };
}

function sessionModelPolicyResponseWire() {
  return {
    contractVersion: 1,
    policy: {
      mode: "tiered",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
      tier: "advanced",
    },
    session: {
      sessionId: "s-1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      modelPolicy: {
        mode: "tiered",
        tier: "advanced",
        resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
        ladderValid: true,
      },
    },
  };
}

function utilityModelSettingsWire(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    settings: {
      lightweight: { provider: "openai", id: "gpt-5.6-luna" },
      context: { provider: "openai", id: "org/gpt-5.6-luna/medium" },
    },
    models: [
      { model: { provider: "openai", id: "gpt-5.6-luna" }, name: "Luna" },
      { model: { provider: "openai", id: "org/gpt-5.6-luna/medium" } },
    ],
    slots: {
      lightweight: { valid: true },
      context: { valid: true },
    },
    valid: true,
    ...overrides,
  };
}

function utilityModelSettingsV2Wire(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 2,
    settings: {
      lightweight: { provider: "openai", id: "gpt-5.6-luna", thinkingLevel: "max" },
      context: { provider: "openai", id: "org/gpt-5.6-luna/medium" },
    },
    models: [
      {
        model: { provider: "openai", id: "gpt-5.6-luna" },
        name: "Luna",
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
      {
        model: { provider: "openai", id: "org/gpt-5.6-luna/medium" },
        thinkingLevels: ["off", "max"],
      },
    ],
    slots: {
      lightweight: { valid: true },
      context: { valid: true },
    },
    valid: true,
    ...overrides,
  };
}

function modelTierSettingsWire(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    ladder: {
      economy: { model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
      fast: { model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
      standard: { model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "high" },
      advanced: { model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "high" },
      capable: { model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "max" },
      frontier: { model: { provider: "openai", id: "org/gpt-5.6-luna/medium" }, thinkingLevel: "max" },
    },
    models: [
      { model: { provider: "openai", id: "gpt-5.6-luna" }, name: "Luna", thinkingLevels: ["off", "medium", "high", "max"] },
    ],
    rows: {
      economy: { valid: true },
      fast: { valid: true },
      standard: { valid: true },
      advanced: { valid: true },
      capable: { valid: true },
      frontier: { valid: false, reason: "tier frontier names unavailable model openai/org/gpt-5.6-luna/medium" },
    },
    valid: false,
    ...overrides,
  };
}

describe("speech input settings parser", () => {
  function speechInputSettingsResponse(overrides: Record<string, unknown> = {}) {
    return {
      contractVersion: 1,
      revision: "00000000-0000-4000-8000-000000000001",
      settings: {
        provider: "auto",
        language: "pt-BR",
        cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" },
      },
      credential: { configured: true, source: "command", resolution: "unchecked" },
      ...overrides,
    };
  }

  it("strictly parses complete speech input settings responses", () => {
    const response = speechInputSettingsResponse();

    expect(parseSpeechInputSettingsResponse(response)).toEqual(response);
    expect(parseSpeechInputSettingsResponse(speechInputSettingsResponse({ credential: { configured: false, resolution: "missing" } })))
      .toEqual(speechInputSettingsResponse({ credential: { configured: false, resolution: "missing" } }));
    expect(parseSpeechInputSettingsResponse(speechInputSettingsResponse({ credential: { configured: true, source: "environment", resolution: "unresolved" } })))
      .toEqual(speechInputSettingsResponse({ credential: { configured: true, source: "environment", resolution: "unresolved" } }));
  });

  it("rejects noncanonical revisions, wrong contract versions, and unknown or leaked fields", () => {
    const valid = speechInputSettingsResponse();

    for (const value of [
      null,
      [],
      {},
      { ...valid, contractVersion: 2 },
      { ...valid, contractVersion: "1" },
      { ...valid, revision: "01234567-89ab-4cde-8f01-23456789abcd".toUpperCase() },
      { ...valid, revision: "not-a-uuid" },
      { ...valid, revision: 42 },
      { ...valid, extra: true },
      { ...valid, settings: { ...valid.settings, extra: true } },
      { ...valid, settings: { ...valid.settings, language: "" } },
      { ...valid, settings: { ...valid.settings, language: "en-us" } },
      { ...valid, settings: { ...valid.settings, language: "auto" } },
      { ...valid, settings: { ...valid.settings, provider: "local" } },
      { ...valid, settings: { ...valid.settings, cloud: { ...valid.settings.cloud, apiKey: "sk-leak" } } },
      { ...valid, settings: { ...valid.settings, cloud: { ...valid.settings.cloud, extra: true } } },
      { ...valid, settings: { ...valid.settings, cloud: { ...valid.settings.cloud, baseUrl: "http://api.openai.com/v1" } } },
      { ...valid, settings: { ...valid.settings, cloud: { ...valid.settings.cloud, baseUrl: "https://user@api.openai.com/v1" } } },
      { ...valid, settings: { ...valid.settings, cloud: { ...valid.settings.cloud, baseUrl: "https://api.openai.com/v1?key=x" } } },
      { ...valid, settings: { ...valid.settings, cloud: { ...valid.settings.cloud, baseUrl: "https://api.openai.com/v1#frag" } } },
      { ...valid, settings: { ...valid.settings, cloud: { ...valid.settings.cloud, model: "   " } } },
      { ...valid, settings: { ...valid.settings, cloud: { baseUrl: "https://api.openai.com/v1" } } },
      { ...valid, settings: { provider: "auto", language: "pt-BR" } },
      { ...valid, credential: { configured: true, resolution: "missing" } },
      { ...valid, credential: { configured: true, source: "literal", resolution: "unresolved" } },
      { ...valid, credential: { configured: true, source: "literal", resolution: "unchecked" } },
      { ...valid, credential: { configured: true, source: "environment", resolution: "unchecked" } },
      { ...valid, credential: { configured: true, source: "command", resolution: "resolved" } },
      { ...valid, credential: { configured: true, source: "command", resolution: "missing" } },
      { ...valid, credential: { configured: false, source: "literal", resolution: "missing" } },
      { ...valid, credential: { configured: false, resolution: "resolved" } },
      { ...valid, credential: { configured: false, resolution: "missing", extra: true } },
      { ...valid, credential: { configured: true, source: "literal", resolution: "resolved", apiKey: "sk-leak" } },
      { ...valid, credential: { configured: true, source: "keychain", resolution: "resolved" } },
      { ...valid, credential: { configured: "yes", source: "literal", resolution: "resolved" } },
    ]) {
      expect(() => parseSpeechInputSettingsResponse(value)).toThrow();
    }
  });
});
