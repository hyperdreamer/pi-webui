import { describe, expect, it } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import { SESSION_NOTIFICATION_LIMIT, SESSION_NOTIFICATION_MESSAGE_BYTES, SESSION_UNREAD_CATALOG_ID_MAX_LENGTH } from "../../../shared/apiTypes";
import { parseAuthProvidersResponse, parseCommandResult, parseFileContentResponse, parseFileSuggestion, parseGitStatusResponse, parseMachineRuntime, parseMemorySnapshotResponse, parseMessagePage, parseModelTierSettingsResponse, parseOAuthFlowState, parsePiPackageMutationResponse, parsePiPackagesResponse, parsePiWebUiConfigResponse, parsePiWebUiPluginsResponse, parsePiWebUiRuntimeResponse, parsePiWebUiStatusResponse, parseSessionBulkArchiveResponse, parseSessionBulkDeleteArchivedResponse, parseSessionCleanupExecuteResponse, parseSessionCleanupPreviewResponse, parseSessionDefaultsResponse, parseSessionInfo, parseSessionMessageForkResult, parseSessionModelPolicyResponse, parseSessionNotificationInboxEvent, parseSessionNotificationInboxSnapshot, parseSessionStatus, parseSessionStreamSnapshot, parseSessionSystemPrompt, parseSessionTreeNavigateResult, parseSessionTreeSnapshot, parseSessionUnreadCatalogSnapshot, parseSessionUnreadEvent, parseSlashCommand, parseSystemInfoResponse, parseSystemMetricsResponse, parseTerminalCommandRun, parseTerminalInfo, parseWorkspace, parseWorkspaceActivityResponse } from "./parsers";

describe("API parsers", () => {
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

  it("parses session info including optional persistence signals", () => {
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
    });
    expect(() => parseSessionInfo({ id: "s1", path: "", cwd: "/repo", persisted: "yes", created: "now", modified: "now", messageCount: 0, firstMessage: "" })).toThrow("Expected optional boolean field: persisted");
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
