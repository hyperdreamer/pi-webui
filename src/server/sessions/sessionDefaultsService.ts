import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionDefaultsResponse, SessionDefaultsUpdate, SessionModel } from "../../shared/apiTypes.js";
import { KNOWN_THINKING_LEVELS, isKnownThinkingLevel, type ThinkingLevel } from "../../shared/thinkingLevels.js";

type DefaultModel = Model<Api>;

interface SessionDefaultsSettings {
  getDefaultProvider(): string | undefined;
  getDefaultModel(): string | undefined;
  getDefaultThinkingLevel(): ThinkingLevel | undefined;
  setDefaultModelAndProvider(provider: string, modelId: string): void;
  setDefaultThinkingLevel(level: ThinkingLevel): void;
  flush(): Promise<void>;
}

export interface SessionDefaultsModelRuntime {
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  getAvailableSnapshot(): readonly DefaultModel[];
}

export interface SessionDefaultsServiceDependencies {
  agentDir: string;
  modelRuntime: SessionDefaultsModelRuntime;
  createSettingsManager?: (cwd: string, agentDir: string) => SessionDefaultsSettings;
  thinkingLevelsForModel?: (model: DefaultModel | undefined) => readonly ThinkingLevel[];
}

/** Persists Pi's default model and thinking preferences without opening a chat session. */
export class SessionDefaultsService {
  private readonly createSettingsManager: NonNullable<SessionDefaultsServiceDependencies["createSettingsManager"]>;
  private readonly thinkingLevelsForModel: NonNullable<SessionDefaultsServiceDependencies["thinkingLevelsForModel"]>;

  constructor(private readonly deps: SessionDefaultsServiceDependencies) {
    this.createSettingsManager = deps.createSettingsManager ?? ((cwd, agentDir) => SettingsManager.create(cwd, agentDir));
    this.thinkingLevelsForModel = deps.thinkingLevelsForModel ?? defaultThinkingLevelsForModel;
  }

  async read(cwd: string): Promise<SessionDefaultsResponse> {
    const settings = this.createSettingsManager(cwd, this.deps.agentDir);
    const models = await this.availableModels();
    return this.response(settings, models);
  }

  async update(cwd: string, update: SessionDefaultsUpdate): Promise<SessionDefaultsResponse> {
    const settings = this.createSettingsManager(cwd, this.deps.agentDir);
    const models = await this.availableModels();
    let model = configuredDefaultModel(settings, models);
    let changed = false;

    const requestedModel = update.model;
    if (requestedModel !== undefined) {
      model = models.find((candidate) => candidate.provider === requestedModel.provider && candidate.id === requestedModel.modelId);
      if (model === undefined) throw new Error(`Model not available: ${requestedModel.provider}/${requestedModel.modelId}`);
      if (settings.getDefaultProvider() !== model.provider || settings.getDefaultModel() !== model.id) {
        settings.setDefaultModelAndProvider(model.provider, model.id);
        changed = true;
      }
    }

    const thinkingLevels = this.thinkingLevelsForModel(model);
    const configuredThinkingLevel = settings.getDefaultThinkingLevel() ?? "off";
    let thinkingLevel = effectiveThinkingLevel(configuredThinkingLevel, thinkingLevels);
    if (update.thinkingLevel !== undefined) {
      if (!isKnownThinkingLevel(update.thinkingLevel)) throw new Error(`Invalid thinking level: ${update.thinkingLevel}`);
      if (!thinkingLevels.includes(update.thinkingLevel)) throw new Error(`Thinking level ${update.thinkingLevel} is not supported by the default model`);
      thinkingLevel = update.thinkingLevel;
    }
    if (thinkingLevel !== configuredThinkingLevel) {
      settings.setDefaultThinkingLevel(thinkingLevel);
      changed = true;
    }

    if (changed) await settings.flush();
    return responseFor(models, model, thinkingLevel, thinkingLevels);
  }

  private async availableModels(): Promise<DefaultModel[]> {
    await this.deps.modelRuntime.refresh({ allowNetwork: false });
    return [...this.deps.modelRuntime.getAvailableSnapshot()];
  }

  private response(settings: SessionDefaultsSettings, models: readonly DefaultModel[]): SessionDefaultsResponse {
    const model = configuredDefaultModel(settings, models);
    const thinkingLevels = this.thinkingLevelsForModel(model);
    const thinkingLevel = effectiveThinkingLevel(settings.getDefaultThinkingLevel() ?? "off", thinkingLevels);
    return responseFor(models, model, thinkingLevel, thinkingLevels);
  }
}

function defaultThinkingLevelsForModel(model: DefaultModel | undefined): readonly ThinkingLevel[] {
  return model === undefined ? KNOWN_THINKING_LEVELS : getSupportedThinkingLevels(model);
}

function configuredDefaultModel(settings: SessionDefaultsSettings, models: readonly DefaultModel[]): DefaultModel | undefined {
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (provider === undefined || modelId === undefined) return undefined;
  return models.find((model) => model.provider === provider && model.id === modelId);
}

function effectiveThinkingLevel(configured: ThinkingLevel, levels: readonly ThinkingLevel[]): ThinkingLevel {
  return levels.includes(configured) ? configured : (levels[0] ?? "off");
}

function responseFor(
  models: readonly DefaultModel[],
  model: DefaultModel | undefined,
  thinkingLevel: ThinkingLevel,
  thinkingLevels: readonly ThinkingLevel[],
): SessionDefaultsResponse {
  return {
    ...(model === undefined ? {} : { model: modelToClientModel(model) }),
    thinkingLevel,
    models: models.map(modelToClientModel),
    thinkingLevels: [...thinkingLevels],
  };
}

function modelToClientModel(model: DefaultModel): SessionModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
  };
}
