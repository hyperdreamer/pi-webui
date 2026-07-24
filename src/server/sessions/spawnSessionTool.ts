import { Type } from "typebox";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SpawnSessionResult {
  sessionId: string;
  cwd: string;
}

export type SpawnSessionModel = NonNullable<ExtensionContext["model"]>;

export interface SpawnSessionInvocation {
  spawningCwd: string;
  prompt: string;
  cwd: string | undefined;
  /** Current model from the dispatching session, used as the spawned session's default. */
  model?: SpawnSessionModel;
}

export interface SpawnSessionToolDeps {
  spawn(input: SpawnSessionInvocation): Promise<SpawnSessionResult>;
}

type SpawnSessionToolDetails = SpawnSessionResult;

const SpawnSessionParams = Type.Object({
  prompt: Type.String({
    description: "The first instruction to send to the newly created session. The new session runs independently; you do not receive its output.",
  }),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the new session. Must be a workspace (worktree, or root) of the same project as this session. Defaults to this session's working directory.",
  })),
});

/**
 * Custom tool that lets the LLM start a new, independent pi-webui session and
 * deliver an initial prompt to it. The spawned session is a normal pi-webui session
 * a human can open and interact with. The tool is constructed per-session, so it
 * carries the spawning session's cwd for project-scope validation.
 */
export function createSpawnSessionToolDefinition(spawningCwd: string, deps: SpawnSessionToolDeps) {
  return defineTool<typeof SpawnSessionParams, SpawnSessionToolDetails>({
    name: "spawn_session",
    label: "Spawn session",
    description: "Start a fully independent session; its transcript and results are unavailable here. Use only when the user or active workflow explicitly requests a separate session.",
    promptSnippet: "spawn_session: independent session; results unavailable here; explicit requests only",
    parameters: SpawnSessionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Failures throw: the agent loop turns the thrown message into an error
      // tool result the model sees, so the spawning agent can adapt (e.g. pick a
      // valid workspace) rather than crash.
      const result = await deps.spawn({
        spawningCwd,
        prompt: params.prompt,
        cwd: params.cwd,
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
      });
      return {
        content: [{ type: "text", text: `Started independent session ${result.sessionId} in ${result.cwd}.` }],
        details: result,
      };
    },
  });
}
