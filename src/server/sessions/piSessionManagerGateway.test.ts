import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionDirEnvKeys } from "../../config.js";
import { createPiSessionManagerGateway, defaultPiSessionDir, defaultPiSessionsRoot, filterSessionsForCwd, SessionDirResolver } from "./piSessionManagerGateway.js";
import type { PiSessionListEntry } from "./piSessionService.js";
import type { PiSessionManager } from "./piSessionService.js";
import { inspectSessionCreationSource, SESSION_CREATION_SOURCE_CUSTOM_TYPE, serializeSessionCreationSource } from "./sessionCreationSource.js";
import { sep } from "node:path";

let tempDir: string;
let agentDir: string;
let cwd: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-session-gateway-test-"));
  agentDir = join(tempDir, "agent");
  cwd = join(tempDir, "workspace");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SessionDirResolver", () => {
  it("uses Pi default session storage when no Pi override is configured", () => {
    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "pi-default", sessionDir: defaultPiSessionDir(cwd, agentDir), usesConfiguredSessionDir: false });
    expect(defaultPiSessionsRoot(agentDir)).toBe(join(agentDir, "sessions"));
  });

  it("uses Pi sessionDir settings and resolves relative paths against the session cwd", async () => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: ".pi/sessions" }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "settings", sessionDir: join(cwd, ".pi", "sessions"), usesConfiguredSessionDir: true });
  });

  it("lets project-local Pi sessionDir settings override global Pi settings for that cwd", async () => {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "global-sessions") }, null, 2)}\n`, "utf8");
    await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify({ sessionDir: ".workspace-sessions" }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "settings", sessionDir: join(cwd, ".workspace-sessions"), usesConfiguredSessionDir: true });
  });

  it("lets the Pi sessionDir environment override Pi settings", async () => {
    const envDir = join(tempDir, "env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: envDir }));

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: envDir, usesConfiguredSessionDir: true });
  });

  it("uses PI WEBUI sessionDir environment overrides before settings", async () => {
    const envDir = join(tempDir, "pi-webui-env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions({ PI_WEBUI_AGENT_SESSION_DIR: envDir }));

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: envDir, usesConfiguredSessionDir: true });
  });

  it("snapshots the daemon epoch's injected session-directory environment", () => {
    const firstDir = join(tempDir, "first-env-sessions");
    const env = { PI_WEBUI_AGENT_SESSION_DIR: firstDir };
    const sessionDirEnvKeys = ["PI_WEBUI_AGENT_SESSION_DIR"];
    const resolver = new SessionDirResolver({ agentDir, env, sessionDirEnvKeys });

    env.PI_WEBUI_AGENT_SESSION_DIR = join(tempDir, "mutated-env-sessions");
    sessionDirEnvKeys[0] = "OTHER_SESSION_DIR";

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: firstDir, usesConfiguredSessionDir: true });
  });
});

describe("Pi session manager gateway", () => {
  it("durably commits initial custom entries and leaves the manager appendable", async () => {
    const gateway = createPiSessionManagerGateway(piProfileOptions());
    const manager = gateway.create(cwd);
    const sessionFile = manager.getSessionFile();
    if (sessionFile === undefined) throw new Error("Expected a persistent session file");
    manager.appendCustomEntry?.("test.policy", { mode: "exact" });
    manager.appendCustomEntry?.(
      SESSION_CREATION_SOURCE_CUSTOM_TYPE,
      serializeSessionCreationSource("session-list-plus", {
        sessionId: manager.getSessionId(),
        sessionFile,
      })
    );

    await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    if (gateway.commitInitialEntries === undefined) throw new Error("Expected an initial-entry commit seam");
    await gateway.commitInitialEntries(manager);

    await expect(readFile(sessionFile, "utf8")).resolves.toContain("test.policy");
    manager.appendCustomEntry?.("test.after-commit", { durable: true });
    expect(gateway.open(sessionFile).getEntries?.()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customType: "test.after-commit" }),
      ])
    );
  });

  it("removes a newly materialized file when manager reload fails during commit", async () => {
    const gateway = createPiSessionManagerGateway(piProfileOptions());
    const manager = gateway.create(cwd);
    const sessionFile = manager.getSessionFile();
    if (sessionFile === undefined) throw new Error("Expected a persistent session file");
    manager.appendCustomEntry?.("test.policy", { mode: "exact" });
    if (!(manager instanceof SessionManager))
      throw new Error("Expected an SDK SessionManager");
    vi.spyOn(manager, "setSessionFile").mockImplementation(() => {
      throw new Error("manager reload failed");
    });

    if (gateway.commitInitialEntries === undefined) throw new Error("Expected an initial-entry commit seam");
    await expect(gateway.commitInitialEntries(manager)).rejects.toThrow("manager reload failed");
    await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a copied plus origin bound to its parent after a real branched-session extraction", async () => {
    const gateway = createPiSessionManagerGateway(piProfileOptions());
    if (gateway.commitInitialEntries === undefined) throw new Error("Expected an initial-entry commit seam");
    const root = gateway.create(cwd);
    const rootFile = root.getSessionFile();
    if (rootFile === undefined) throw new Error("Expected a persistent root file");
    root.appendCustomEntry?.(
      SESSION_CREATION_SOURCE_CUSTOM_TYPE,
      serializeSessionCreationSource("session-list-plus", {
        sessionId: root.getSessionId(),
        sessionFile: rootFile,
      })
    );
    await gateway.commitInitialEntries(root);

    const branching = gateway.open(rootFile);
    if (!(branching instanceof SessionManager))
      throw new Error("Expected an SDK SessionManager");
    const leafId = branching.getLeafId();
    if (leafId === null) throw new Error("Expected a source marker leaf");
    const childFile = branching.createBranchedSession(leafId);
    if (childFile === undefined) throw new Error("Expected a persistent child file");
    await gateway.commitInitialEntries(branching);

    const child = gateway.open(childFile);
    const source = inspectSessionCreationSource(child.getEntries?.() ?? child.getBranch());
    expect(child.getHeader?.()?.parentSession).toBe(rootFile);
    expect(child.getSessionId()).not.toBe(root.getSessionId());
    expect(source).toMatchObject({
      kind: "valid",
      origin: { sessionId: root.getSessionId(), sessionFile: rootFile },
    });
  });

  it("lists legacy id-only sessions from the default Pi session store", async () => {
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-a", cwd);
    await writeSessionFile(defaultPiSessionDir(otherCwd, agentDir), "session-b", otherCwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    if (gateway.listAll === undefined) throw new Error("Expected legacy listing support");
    await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "session-a", cwd }), expect.objectContaining({ id: "session-b", cwd: otherCwd })]));
  });

  it("includes an absolute env-configured session directory in global listing", async () => {
    const envSessionDir = join(tempDir, "env-sessions");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "default-session", cwd);
    await writeSessionFile(envSessionDir, "env-session", cwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: envSessionDir }));

    if (gateway.listAll === undefined) throw new Error("Expected legacy listing support");
    await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "default-session", cwd }), expect.objectContaining({ id: "env-session", cwd })]));
  });

  it("includes generic env session directories in global listing", async () => {
    for (const envKey of ["PI_WEBUI_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
      const envSessionDir = join(tempDir, `${envKey.toLowerCase()}-sessions`);
      await writeSessionFile(envSessionDir, `${envKey.toLowerCase()}-session`, cwd);
      const gateway = createPiSessionManagerGateway({
        agentDir,
        env: { [envKey]: envSessionDir },
        sessionDirEnvKeys: [envKey],
      });

      if (gateway.listAll === undefined) throw new Error("Expected legacy listing support");
      await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: `${envKey.toLowerCase()}-session`, cwd })]));
    }
  });

  it("lists only sessions for the requested cwd when a custom Pi sessionDir is shared", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(sharedSessionDir, "session-a", cwd);
    await writeSessionFile(sharedSessionDir, "session-b", otherCwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-a", cwd }]);
    const created = gateway.create(cwd);
    expect(hasSessionDir(created)).toBe(true);
    if (!hasSessionDir(created)) throw new Error("Expected SDK session manager");
    expect(created.getSessionDir()).toBe(sharedSessionDir);
  });

  it("lists sessions for cwds that differ from the server process cwd", async () => {
    // Regression: SessionManager.list("", dir) filtered against process.cwd(),
    // hiding every session outside the daemon's own launch directory.
    expect(cwd).not.toBe(process.cwd());
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-elsewhere", cwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-elsewhere", cwd }]);
  });

  it("projects a valid persisted plus-session creation source", async () => {
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "plus-session", cwd, [
      sourceEntry("source-1", serializeSessionCreationSource("session-list-plus")),
    ]);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([
      { id: "plus-session", creationSource: "session-list-plus" },
    ]);
  });

  it("does not project a source when the newest persisted marker is malformed", async () => {
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "malformed-source", cwd, [
      sourceEntry("source-1", serializeSessionCreationSource("session-list-plus")),
      sourceEntry("source-2", { version: 1, source: "unknown" }),
    ]);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    const [listed] = await gateway.list(cwd);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("creationSource");
  });

  it("lists legacy sessions without rewriting their JSONL contents", async () => {
    const sessionDir = defaultPiSessionDir(cwd, agentDir);
    const sessionPath = join(sessionDir, "legacy-plus.jsonl");
    const contents = [
      JSON.stringify({ type: "session", version: 2, id: "legacy-plus", timestamp: "2026-01-01T00:00:00.000Z", cwd }),
      JSON.stringify(sourceEntry("source-1", serializeSessionCreationSource("session-list-plus"))),
      '{"type":"message","message":{"role":"assistant","content":"truncated by a crash',
    ].join("\n");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, contents, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([
      { id: "legacy-plus", creationSource: "session-list-plus" },
    ]);
    await expect(readFile(sessionPath, "utf8")).resolves.toBe(contents);
  });

  it("keeps a session listed when its JSONL contains a null entry", async () => {
    const sessionDir = defaultPiSessionDir(cwd, agentDir);
    await writeSessionFile(sessionDir, "session-with-null", cwd, [
      null,
      {
        type: "message",
        id: "message-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Still visible" },
      },
    ]);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([
      {
        id: "session-with-null",
        messageCount: 1,
        firstMessage: "Still visible",
      },
    ]);
  });

  it("keeps healthy sessions listed when another listed file has an invalid header", async () => {
    const sessionDir = defaultPiSessionDir(cwd, agentDir);
    await writeSessionFile(sessionDir, "healthy-session", cwd);
    await writeFile(
      join(sessionDir, "invalid-header.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: 12345, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
      "utf8"
    );
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "healthy-session", cwd }),
      ])
    );
  });
});

describe("filterSessionsForCwd", () => {
  it("matches cwds that differ only by trailing separator or redundant segments", () => {
    const sessions = [sessionEntry("a", cwd)];

    expect(filterSessionsForCwd(sessions, `${cwd}${sep}`)).toHaveLength(1);
    expect(filterSessionsForCwd(sessions, join(cwd, "."))).toHaveLength(1);
  });

  it("excludes sessions with an empty cwd instead of matching the process cwd", () => {
    expect(filterSessionsForCwd([sessionEntry("a", "")], process.cwd())).toHaveLength(0);
  });

  it("excludes sessions from other cwds", () => {
    expect(filterSessionsForCwd([sessionEntry("a", join(tempDir, "other"))], cwd)).toHaveLength(0);
  });
});

describe("session listing canonicalization", () => {
  it("canonicalizes session header cwds written by external tools", async () => {
    // Headers are written by the Pi CLI / SDK consumers and may contain
    // unnormalized paths (trailing separators, redundant segments).
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-messy", `${cwd}${sep}.${sep}`);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-messy", cwd }]);
  });
});

function piProfileOptions(env: NodeJS.ProcessEnv = {}) {
  return { agentDir, env, sessionDirEnvKeys: agentSessionDirEnvKeys() };
}

function hasSessionDir(manager: PiSessionManager): manager is PiSessionManager & { getSessionDir(): string } {
  return "getSessionDir" in manager && typeof manager.getSessionDir === "function";
}

function sessionEntry(id: string, sessionCwd: string): PiSessionListEntry {
  return { path: join(tempDir, `${id}.jsonl`), id, cwd: sessionCwd, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" };
}

function sourceEntry(id: string, data: unknown): unknown {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: SESSION_CREATION_SOURCE_CUSTOM_TYPE,
    data,
  };
}

async function writeSessionFile(dir: string, id: string, sessionCwd: string, entries: readonly unknown[] = []): Promise<void> {
  await mkdir(dir, { recursive: true });
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: sessionCwd },
    ...entries,
  ];
  await writeFile(join(dir, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}
