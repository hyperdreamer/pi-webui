import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiWebUiCustomToolDefinitions, sessionAllowsDelegationTools, type PiSessionManager } from "./piSessionService.js";
import type { SubsessionToolDeps } from "./spawnSubsessionTool.js";
import { fakeSessionManager } from "./piSessionService.testSupport.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function delegationDeps() {
  const spawn = vi.fn(() => Promise.resolve({ sessionId: "independent-1", cwd: "/workspace" }));
  const subsessions: SubsessionToolDeps = {
    spawn: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace" })),
    list: vi.fn(() => Promise.resolve([])),
    check: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace", status: "idle" as const, finalText: "", messageCount: 0 })),
    read: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace", status: "idle" as const, entries: [], total: 0, matched: 0, start: 0, hasMore: false })),
  };
  return { spawn, subsessions };
}

function toolNames(definitions: ReturnType<typeof createPiWebUiCustomToolDefinitions>): string[] {
  return definitions.map((definition) => definition.name);
}

function manager(id: string, file: string | undefined, entries: readonly unknown[] = []): PiSessionManager {
  return fakeSessionManager("/workspace", {
    getSessionId: () => id,
    getSessionFile: () => file,
    getEntries: () => entries,
  });
}

describe("delegation tool capability boundary", () => {
  it("provides every globally enabled delegation tool to unrestricted sessions", () => {
    const { spawn, subsessions } = delegationDeps();

    expect(toolNames(createPiWebUiCustomToolDefinitions("/workspace", true, spawn, subsessions))).toEqual([
      "edit",
      "spawn_session",
      "spawn_subsession",
      "list_subsessions",
      "check_subsession",
      "read_subsession",
      "yield_to_subsessions",
    ]);
  });

  it("continues to honor global delegation feature flags for unrestricted sessions", () => {
    const { spawn } = delegationDeps();

    expect(toolNames(createPiWebUiCustomToolDefinitions("/workspace", true, spawn))).toEqual(["edit", "spawn_session"]);
    expect(toolNames(createPiWebUiCustomToolDefinitions("/workspace", true))).toEqual(["edit"]);
  });

  it("removes every delegation tool but retains ordinary tools for restricted tracked children", () => {
    const { spawn, subsessions } = delegationDeps();

    expect(toolNames(createPiWebUiCustomToolDefinitions("/workspace", false, spawn, subsessions))).toEqual(["edit"]);
  });

  it.each(["human-created", "spawn_session-created"])("allows delegation for a %s session without tracked-child provenance", async () => {
    const sessionManager = manager("session-1", undefined);
    const open = vi.fn(() => { throw new Error("no parent session should be opened"); });

    await expect(sessionAllowsDelegationTools(sessionManager, { open })).resolves.toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("removes delegation when persisted records verify exact tracked-child provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-webui-delegation-provenance-"));
    tempDirs.push(dir);
    const parentFile = join(dir, "parent.jsonl");
    const childFile = join(dir, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace", parentSession: parentFile })}\n`, "utf8");

    const childManager = manager("child-1", childFile, [
      { type: "custom", customType: "pi-webui.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } },
    ]);
    const parentManager = manager("parent-1", parentFile, [
      { type: "custom", customType: "pi-webui.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace" } },
    ]);

    await expect(sessionAllowsDelegationTools(childManager, { open: () => parentManager })).resolves.toBe(false);
  });

  it("does not treat a copied child marker as tracked provenance without an exact reciprocal file link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-webui-delegation-copy-"));
    tempDirs.push(dir);
    const parentFile = join(dir, "parent.jsonl");
    const originalChildFile = join(dir, "original-child.jsonl");
    const copiedChildFile = join(dir, "copied-child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
    await writeFile(copiedChildFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace", parentSession: parentFile })}\n`, "utf8");

    const copiedChildManager = manager("child-1", copiedChildFile, [
      { type: "custom", customType: "pi-webui.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } },
    ]);
    const parentManager = manager("parent-1", parentFile, [
      { type: "custom", customType: "pi-webui.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: originalChildFile, cwd: "/workspace" } },
    ]);

    await expect(sessionAllowsDelegationTools(copiedChildManager, { open: () => parentManager })).resolves.toBe(true);
  });
});
