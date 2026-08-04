import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AuthResult,
  Model,
  ProviderHeaders,
  Usage,
} from "@earendil-works/pi-ai";
import {
  compact as piCompact,
  generateBranchSummary as piGenerateBranchSummary,
  type AgentSessionServices,
  type CompactionResult,
  type GenerateBranchSummaryOptions,
  type InlineExtension,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { runtimeThinkingLevels as piRuntimeThinkingLevels } from "./modelTierRegistry.js";
import type {
  UtilityModelResolver,
  UtilityModelResolverLogger,
  UtilityModelTask,
} from "./utilityModelResolver.js";

export interface UtilityModelExtensionRuntimeRefs {
  streamFunction?: StreamFn;
  settingsManager?: Pick<
    AgentSessionServices["settingsManager"],
    "getBranchSummarySettings" | "getRetrySettings"
  >;
}

export interface UtilityModelAuthRuntime {
  getAuth(model: Model<Api>): Promise<AuthResult | undefined>;
}

export interface UtilityModelExtensionDependencies {
  resolver: UtilityModelResolver<Model<Api>>;
  modelRuntime: UtilityModelAuthRuntime;
  refs: UtilityModelExtensionRuntimeRefs;
  logger?: UtilityModelResolverLogger;
  generateBranchSummary?: typeof piGenerateBranchSummary;
  compact?: typeof piCompact;
  runtimeThinkingLevels?: (model: Model<Api>) => readonly string[];
}

export interface UtilityBranchSummaryHandlerResult {
  cancel?: boolean;
  summary?: {
    summary: string;
    details: {
      readFiles: string[];
      modifiedFiles: string[];
    };
    usage?: Usage;
  };
}

export interface UtilityCompactionHandlerResult {
  cancel?: boolean;
  compaction?: CompactionResult;
}

export interface UtilityModelHandlerContext {
  readonly model: Model<Api> | undefined;
}

export interface UtilityModelHandlers {
  sessionBeforeTree: (
    event: SessionBeforeTreeEvent,
    ctx: UtilityModelHandlerContext,
  ) => Promise<UtilityBranchSummaryHandlerResult | undefined>;
  sessionBeforeCompact: (
    event: SessionBeforeCompactEvent,
    ctx: UtilityModelHandlerContext,
  ) => Promise<UtilityCompactionHandlerResult | undefined>;
}

interface ResolvedUtilityAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface AvailableRuntimeRefs {
  streamFunction: StreamFn;
  settingsManager: NonNullable<UtilityModelExtensionRuntimeRefs["settingsManager"]>;
}

export function createUtilityModelHandlers(
  deps: UtilityModelExtensionDependencies,
): UtilityModelHandlers {
  const generateBranchSummary =
    deps.generateBranchSummary ?? piGenerateBranchSummary;
  const compact = deps.compact ?? piCompact;
  const thinkingLevels = deps.runtimeThinkingLevels ?? piRuntimeThinkingLevels;

  return {
    sessionBeforeTree: async (event, ctx) => {
      if (
        !event.preparation.userWantsSummary ||
        event.preparation.entriesToSummarize.length === 0 ||
        ctx.model === undefined
      ) {
        return undefined;
      }

      const refs = availableRefs(deps.refs);
      if (refs === undefined) return undefined;

      let reserveTokens: number;
      let retry: ReturnType<AvailableRuntimeRefs["settingsManager"]["getRetrySettings"]>;
      try {
        reserveTokens = refs.settingsManager.getBranchSummarySettings().reserveTokens;
        retry = refs.settingsManager.getRetrySettings();
      } catch (error) {
        logNoThrow(deps.logger, { err: error, task: "lightweight" }, "utility model runtime refs failed");
        return undefined;
      }

      const candidates = await deps.resolver.configuredCandidates("lightweight");
      for (const model of candidates) {
        if (isAborted(event.signal)) return { cancel: true };
        const auth = await resolveCandidateAuth(deps, "lightweight", model);
        if (isAborted(event.signal)) return { cancel: true };
        if (auth === undefined) continue;

        try {
          const thinking = utilityThinking(model, thinkingLevels);
          const options: GenerateBranchSummaryOptions = {
            model,
            signal: event.signal,
            reserveTokens,
            streamFn: utilityStreamFunction(refs.streamFunction, thinking),
            retry,
            ...auth,
            ...(event.preparation.customInstructions === undefined
              ? {}
              : { customInstructions: event.preparation.customInstructions }),
            ...(event.preparation.replaceInstructions === undefined
              ? {}
              : { replaceInstructions: event.preparation.replaceInstructions }),
          };
          const result = await generateBranchSummary(
            event.preparation.entriesToSummarize,
            options,
          );
          if (isAborted(event.signal) || result.aborted === true) {
            return { cancel: true };
          }
          if (result.error !== undefined || result.summary?.trim() === "") {
            logCandidateFailure(
              deps.logger,
              "lightweight",
              model,
              new Error(result.error ?? "branch summary was empty"),
            );
            continue;
          }
          if (result.summary === undefined) {
            logCandidateFailure(
              deps.logger,
              "lightweight",
              model,
              new Error("branch summary was missing"),
            );
            continue;
          }
          return {
            summary: {
              summary: result.summary,
              details: {
                readFiles: result.readFiles ?? [],
                modifiedFiles: result.modifiedFiles ?? [],
              },
              ...(result.usage === undefined ? {} : { usage: result.usage }),
            },
          };
        } catch (error) {
          if (isAborted(event.signal)) return { cancel: true };
          logCandidateFailure(deps.logger, "lightweight", model, error);
        }
      }
      return undefined;
    },

    sessionBeforeCompact: async (event, ctx) => {
      if (ctx.model === undefined) return undefined;

      const refs = availableRefs(deps.refs);
      if (refs === undefined) return undefined;

      let retry: ReturnType<AvailableRuntimeRefs["settingsManager"]["getRetrySettings"]>;
      try {
        retry = refs.settingsManager.getRetrySettings();
      } catch (error) {
        logNoThrow(deps.logger, { err: error, task: "context" }, "utility model runtime refs failed");
        return undefined;
      }

      const candidates = await deps.resolver.configuredCandidates("context");
      for (const model of candidates) {
        if (isAborted(event.signal)) return { cancel: true };
        const auth = await resolveCandidateAuth(deps, "context", model);
        if (isAborted(event.signal)) return { cancel: true };
        if (auth === undefined) continue;

        try {
          const thinking = utilityThinking(model, thinkingLevels);
          const result = await compact(
            event.preparation,
            model,
            auth.apiKey,
            auth.headers,
            event.customInstructions,
            event.signal,
            thinking,
            utilityStreamFunction(refs.streamFunction, thinking),
            auth.env,
            retry,
          );
          if (isAborted(event.signal)) return { cancel: true };
          return { compaction: result };
        } catch (error) {
          if (isAborted(event.signal)) return { cancel: true };
          logCandidateFailure(deps.logger, "context", model, error);
        }
      }
      return undefined;
    },
  };
}

export function createUtilityModelExtension(
  deps: UtilityModelExtensionDependencies,
): InlineExtension {
  const handlers = createUtilityModelHandlers(deps);
  return {
    name: "pi-webui-utility-models",
    hidden: true,
    factory(pi) {
      pi.on("session_before_tree", handlers.sessionBeforeTree);
      pi.on("session_before_compact", handlers.sessionBeforeCompact);
    },
  };
}

function availableRefs(
  refs: UtilityModelExtensionRuntimeRefs,
): AvailableRuntimeRefs | undefined {
  if (refs.streamFunction === undefined || refs.settingsManager === undefined) {
    return undefined;
  }
  return {
    streamFunction: refs.streamFunction,
    settingsManager: refs.settingsManager,
  };
}

async function resolveCandidateAuth(
  deps: UtilityModelExtensionDependencies,
  task: UtilityModelTask,
  model: Model<Api>,
): Promise<ResolvedUtilityAuth | undefined> {
  try {
    const result = await deps.modelRuntime.getAuth(model);
    if (result === undefined) {
      logCandidateFailure(
        deps.logger,
        task,
        model,
        new Error("utility model authentication is unavailable"),
      );
      return undefined;
    }
    const headers = normalizeHeaders(result.auth.headers);
    return {
      ...(result.auth.apiKey === undefined ? {} : { apiKey: result.auth.apiKey }),
      ...(headers === undefined ? {} : { headers }),
      ...(result.env === undefined ? {} : { env: result.env }),
    };
  } catch (error) {
    logCandidateFailure(deps.logger, task, model, error);
    return undefined;
  }
}

function normalizeHeaders(
  headers: ProviderHeaders | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== null) normalized[name] = value;
  }
  return normalized;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function utilityThinking(
  model: Model<Api>,
  thinkingLevels: (model: Model<Api>) => readonly string[],
): "minimal" | "off" {
  return model.reasoning && thinkingLevels(model).includes("minimal")
    ? "minimal"
    : "off";
}

function utilityStreamFunction(
  streamFunction: StreamFn,
  thinking: "minimal" | "off",
): StreamFn {
  if (thinking === "off") return streamFunction;
  return (model, context, options) => streamFunction(model, context, {
    ...options,
    reasoning: "minimal",
  });
}

function logCandidateFailure(
  logger: UtilityModelResolverLogger | undefined,
  task: UtilityModelTask,
  model: Model<Api>,
  error: unknown,
): void {
  logNoThrow(
    logger,
    { err: error, task, provider: model.provider, modelId: model.id },
    "utility model candidate failed",
  );
}

function logNoThrow(
  logger: UtilityModelResolverLogger | undefined,
  details: Record<string, unknown>,
  message: string,
): void {
  try {
    logger?.info(details, message);
  } catch {
    // Diagnostics must not prevent Pi's active-session fallback.
  }
}
