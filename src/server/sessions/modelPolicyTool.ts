import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ModelPolicyCapabilityResult } from "./modelPolicyCapability.js";

/** Reads one session's model policy; the session is the tool's own. */
export interface ModelPolicyToolDeps {
  inspect(sessionId: string): ModelPolicyCapabilityResult;
}

const GetModelPolicyParams = Type.Object({});

/**
 * A zero-parameter, read-only view of the calling session's model policy.
 *
 * It never mutates policy, never applies a tier, and returns no credentials or
 * endpoints. Its purpose is to let an agent confirm *before* dispatching work
 * what model the next request resolves to and whether tier dispatch is
 * trustworthy, rather than discovering a broken ladder partway through a run.
 *
 * The session is taken from the live extension context, so a session cannot ask
 * about another session's policy.
 */
export function createModelPolicyToolDefinition(deps: ModelPolicyToolDeps) {
  return defineTool<typeof GetModelPolicyParams, ModelPolicyCapabilityResult>({
    name: "get_model_policy",
    label: "Get model policy",
    description:
      "Read this session's model policy: active mode, current and next-request model tuples, tier ladder status, and tracked-dispatch capability. Read-only; applies nothing.",
    promptSnippet:
      "get_model_policy: inspect this session's model policy and tier ladder; read-only",
    parameters: GetModelPolicyParams,
    execute: (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const result = deps.inspect(ctx.sessionManager.getSessionId());
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      });
    },
  });
}
