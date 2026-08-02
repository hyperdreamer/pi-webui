import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPiWebUiCustomToolDefinitions } from "./piSessionService.js";
import { buildModelPolicyCapability } from "./modelPolicyCapability.js";
import type { ModelPolicyCapabilityResult } from "./modelPolicyCapability.js";
import type { SubsessionToolDeps } from "./spawnSubsessionTool.js";

const RUNTIME = {
  model: { provider: "TokenSupply", id: "gpt-5.6-terra" },
  thinkingLevel: "max",
};
const LADDER_FRONTIER = {
  model: { provider: "RightCode-Anthropic", id: "claude-opus-5" },
  thinkingLevel: "max",
};

const subsessions: SubsessionToolDeps = {
  spawn: vi.fn(() =>
    Promise.resolve({ sessionId: "child-1", cwd: "/workspace" })
  ),
  list: vi.fn(() => Promise.resolve([])),
  check: vi.fn(() =>
    Promise.resolve({
      sessionId: "child-1",
      cwd: "/workspace",
      status: "idle" as const,
      finalText: "",
      messageCount: 0,
    })
  ),
  read: vi.fn(() =>
    Promise.resolve({
      sessionId: "child-1",
      cwd: "/workspace",
      status: "idle" as const,
      entries: [],
      total: 0,
      matched: 0,
      start: 0,
      hasMore: false,
    })
  ),
};

function ctxFor(sessionId: string): ExtensionContext {
  // The tool reads only sessionManager.getSessionId.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tool uses.
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

/** Invokes the registered tool exactly as the runtime does. */
async function invoke(
  inspect: (sessionId: string) => ModelPolicyCapabilityResult
) {
  const tools = createPiWebUiCustomToolDefinitions(
    "/workspace",
    true,
    vi.fn(),
    subsessions,
    { inspect }
  );
  const tool = tools.find((candidate) => candidate.name === "get_model_policy");
  if (tool === undefined)
    throw new Error("get_model_policy was not registered");
  const ctx = ctxFor("session-1");
  return await tool.execute(
    "call-1",
    {},
    new AbortController().signal,
    () => undefined,
    ctx
  );
}

describe("get_model_policy tool", () => {
  it("asks only about its own session, taken from the live context", async () => {
    const inspect = vi.fn(() =>
      buildModelPolicyCapability({
        policy: { mode: "exact", exact: RUNTIME },
        currentRuntime: RUNTIME,
        ladder: { valid: true },
        resolveTier: () => RUNTIME,
      })
    );
    await invoke(inspect);
    expect(inspect).toHaveBeenCalledWith("session-1");
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("returns the capability result as both readable text and structured details", async () => {
    const capability = buildModelPolicyCapability({
      policy: { mode: "tiered", exact: RUNTIME, tier: "frontier" },
      currentRuntime: RUNTIME,
      ladder: { valid: true },
      resolveTier: () => LADDER_FRONTIER,
    });
    const result = await invoke(() => capability);

    expect(result.details).toEqual(capability);
    const text = result.content[0];
    if (text?.type !== "text") throw new Error("expected text content");
    expect(JSON.parse(text.text)).toEqual(capability);
    // The agent reads this, so the tier must be legible rather than encoded.
    expect(text.text).toContain('"currentTier": "frontier"');
  });

  it("takes no parameters, so it cannot be asked about another session", () => {
    const tools = createPiWebUiCustomToolDefinitions(
      "/workspace",
      true,
      vi.fn(),
      subsessions,
      { inspect: vi.fn() }
    );
    const tool = tools.find(
      (candidate) => candidate.name === "get_model_policy"
    );
    expect(tool?.parameters).toEqual({ type: "object", properties: {} });
  });

  it("describes itself as read-only", () => {
    const tools = createPiWebUiCustomToolDefinitions(
      "/workspace",
      true,
      vi.fn(),
      subsessions,
      { inspect: vi.fn() }
    );
    const tool = tools.find(
      (candidate) => candidate.name === "get_model_policy"
    );
    expect(tool?.description).toMatch(/read-only/i);
  });
});
