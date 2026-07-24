import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSpawnSessionToolDefinition } from "./spawnSessionTool.js";

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tool reads.
const ctx = {} as ExtensionContext;
const dispatchModel = { provider: "anthropic", id: "claude-sonnet" };
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tool reads.
const ctxWithModel = { model: dispatchModel } as ExtensionContext;

describe("createSpawnSessionToolDefinition", () => {
  it("passes the spawning cwd, explicit cwd, dispatching model, and prompt to spawn callback", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "new-1", cwd: "/repos/a-feature" }));
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn });

    const result = await tool.execute("call-1", { prompt: "do the thing", cwd: "/repos/a-feature" }, undefined, undefined, ctxWithModel);

    expect(spawn).toHaveBeenCalledWith({ spawningCwd: "/repos/a", prompt: "do the thing", cwd: "/repos/a-feature", model: dispatchModel });
    expect(result.details).toEqual({ sessionId: "new-1", cwd: "/repos/a-feature" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "Started independent session new-1 in /repos/a-feature." });
  });

  it("describes a fully independent session and restricts it to explicit requests", () => {
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn: vi.fn() });

    expect(tool.description).toBe("Start a fully independent session; its transcript and results are unavailable here. Use only when the user or active workflow explicitly requests a separate session.");
    expect(tool.promptSnippet).toBe("spawn_session: independent session; results unavailable here; explicit requests only");
    expect(tool.description).not.toMatch(/subsession|child|parent/i);
  });

  it("forwards omitted cwd as undefined and omits a missing dispatching model", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "new-2", cwd: "/repos/a" }));
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn });

    await tool.execute("call-2", { prompt: "continue" }, undefined, undefined, ctx);

    expect(spawn).toHaveBeenCalledWith({ spawningCwd: "/repos/a", prompt: "continue", cwd: undefined });
  });

  it("propagates the spawn callback error so the agent loop reports it", async () => {
    const spawn = vi.fn(() => Promise.reject(new Error("cwd must be a workspace of this project. Allowed: /repos/a")));
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn });

    await expect(tool.execute("call-4", { prompt: "x", cwd: "/elsewhere" }, undefined, undefined, ctx))
      .rejects.toThrow("cwd must be a workspace of this project. Allowed: /repos/a");
  });
});
