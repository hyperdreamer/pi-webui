import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  modelsConfigApi,
  type Machine,
  type ModelConnectionTestResponse,
  type ModelDiscoveryModel,
  type ModelsConfigDocument,
  type ModelsConfigModel,
  type ModelsConfigProvider,
} from "../api";
import {
  MODEL_API_OPTIONS,
  THINKING_LEVELS,
  addCustomProvider,
  addModel,
  removeModel,
  removeProvider,
  renameProvider,
  setThinkingLevelMapEntry,
  updateModel,
  updateProvider,
  type ThinkingLevel,
} from "./models/modelsConfigDraft";

type ModelsConfigApi = Pick<typeof modelsConfigApi, "config" | "save" | "test" | "discover">;

type ModelsSelection =
  | { type: "provider"; providerName: string }
  | { type: "model"; providerName: string; index: number };

type ModelTestState =
  | { phase: "testing" }
  | { phase: "success"; result: ModelConnectionTestResponse }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

interface ModelDiscoveryState {
  phase: "discovering" | "ready";
  /** Omitted while the first request is still in progress. */
  models?: readonly ModelDiscoveryModel[];
}

type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string };

type ModelCostField = "input" | "output" | "cacheRead" | "cacheWrite";

const DEEPSEEK_COMPAT: Record<string, unknown> = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
};

@customElement("models-config-dialog")
export class ModelsConfigDialog extends LitElement {
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) modelsApi: ModelsConfigApi = modelsConfigApi;
  @property({ attribute: false }) onClose?: () => void;
  /** Opens the application-owned auth dialog for the same selected machine. */
  @property({ attribute: false }) onConfigureAuth?: () => void;
  @property({ attribute: false }) onSaved?: () => void;

  @state() private config: ModelsConfigDocument = { providers: {} };
  @state() private loading = true;
  @state() private saving = false;
  @state() private error = "";
  @state() private savedMessage = "";
  @state() private selection: ModelsSelection | undefined;
  @state() private providerNameDraft = "";
  @state() private renameError = "";
  @state() private advancedErrors: Record<string, string> = {};
  @state() private modelTests: Record<string, ModelTestState> = {};
  @state() private discoveredModels: Record<string, ModelDiscoveryState> = {};

  private loadRequestSequence = 0;
  private modelDiscoverySequence = 0;
  private readonly modelDiscoveryRequestSequences = new Map<string, number>();
  private savedMessageTimer: ReturnType<typeof setTimeout> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadConfig();
  }

  override disconnectedCallback(): void {
    if (this.savedMessageTimer !== undefined) clearTimeout(this.savedMessageTimer);
    this.savedMessageTimer = undefined;
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("machine")) return;
    if (machineIdFor(changed.get("machine")) === this.machineId()) return;
    this.resetForMachineChange();
    if (this.isConnected) void this.loadConfig();
  }

  override render(): TemplateResult {
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="models-dialog-title" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header>
            <div class="title-block">
              <span class="eyebrow">Models</span>
              <h1 id="models-dialog-title">Model configuration</h1>
              <span class="target"><code>models.json</code> on ${this.machineLabel()}</span>
            </div>
            <div class="header-actions">
              <button class="icon-button" type="button" title="Reload models configuration" aria-label="Reload models configuration" ?disabled=${this.loading} @click=${() => { void this.loadConfig(); }}>
                ${reloadIcon()}
              </button>
              <button class="icon-button" type="button" title="Close models configuration" aria-label="Close models configuration" @click=${() => { this.close(); }}>
                ${closeIcon()}
              </button>
            </div>
          </header>

          <div class="dialog-body">
            ${this.renderNavigation()}
            <main class="detail-pane">
              ${this.loading ? html`<div class="empty-state">Loading model configuration...</div>` : this.renderDetail()}
            </main>
          </div>

          <footer>
            <div class="footer-message" aria-live="polite">
              ${this.error !== "" ? html`<span class="error-message">${this.error}</span>` : null}
              ${this.savedMessage !== "" ? html`<span class="saved-message">${this.savedMessage}</span>` : null}
            </div>
            <button type="button" class="secondary" @click=${() => { this.configureAuth(); }}>
              ${keyIcon()} Authentication
            </button>
            <button type="button" class="secondary" @click=${() => { this.close(); }}>Close</button>
            <button type="button" class="primary" ?disabled=${this.saving || this.loading} @click=${() => { void this.saveConfig(); }}>
              ${this.saving ? "Saving..." : "Save"}
            </button>
          </footer>
        </section>
      </div>
    `;
  }

  private renderNavigation(): TemplateResult {
    const providers = Object.entries(this.config.providers ?? {});
    return html`
      <aside class="provider-tree" aria-label="Configured providers">
        <div class="provider-tree-scroll">
          ${providers.length === 0 ? html`
            <div class="tree-empty">
              <strong>No custom providers</strong>
              <span>Add a compatible endpoint or configure credentials for a built-in provider.</span>
            </div>
          ` : providers.map(([providerName, provider]) => this.renderProviderTreeNode(providerName, provider))}
        </div>
        <div class="tree-actions">
          <button type="button" class="add-provider" @click=${() => { this.addCustomProvider(); }}>
            ${plusIcon()} Add provider
          </button>
          <button type="button" class="auth-link" @click=${() => { this.configureAuth(); }}>
            ${keyIcon()} Configure authentication
          </button>
        </div>
      </aside>
    `;
  }

  private renderProviderTreeNode(providerName: string, provider: ModelsConfigProvider): TemplateResult {
    const providerSelected = this.selection?.type === "provider" && this.selection.providerName === providerName;
    const models = provider.models ?? [];
    return html`
      <div class="provider-node">
        <button class="tree-row provider-row ${providerSelected ? "selected" : ""}" type="button" @click=${() => { this.selectProvider(providerName); }}>
          ${providerIcon()}
          <span class="tree-label">${providerName}</span>
        </button>
        ${models.map((model, index) => {
          const selected = this.selection?.type === "model" && this.selection.providerName === providerName && this.selection.index === index;
          return html`
            <button class="tree-row model-row ${selected ? "selected" : ""}" type="button" @click=${() => { this.selectModel(providerName, index); }}>
              ${modelIcon()}
              <span class="tree-label">${model.id.trim() === "" ? "new model" : model.id}</span>
              ${model.reasoning === true ? html`<span class="thinking-mark" title="Reasoning enabled">T</span>` : null}
            </button>
          `;
        })}
        <button class="tree-row add-model" type="button" @click=${() => { this.addModel(providerName); }}>
          ${plusIcon()} <span>Add model</span>
        </button>
      </div>
    `;
  }

  private renderDetail(): TemplateResult {
    const selection = this.selection;
    if (selection === undefined) return html`
      <div class="empty-state">
        <strong>Select a provider or model</strong>
        <span>Custom endpoints are saved in the selected machine's <code>models.json</code>.</span>
      </div>
    `;
    if (selection.type === "provider") {
      const provider = this.config.providers?.[selection.providerName];
      return provider === undefined ? this.renderMissingSelection() : this.renderProviderDetail(selection.providerName, provider);
    }
    const provider = this.config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    return provider === undefined || model === undefined
      ? this.renderMissingSelection()
      : this.renderModelDetail(selection.providerName, provider, model, selection.index);
  }

  private renderMissingSelection(): TemplateResult {
    return html`<div class="empty-state"><strong>This entry was removed.</strong><span>Select another provider or add a new one.</span></div>`;
  }

  private renderProviderDetail(providerName: string, provider: ModelsConfigProvider): TemplateResult {
    const discovery = this.discoveredModels[providerName];
    const canDiscover = typeof provider.baseUrl === "string" && provider.baseUrl.trim() !== "";
    return html`
      <div class="detail-content">
        <div class="detail-heading">
          <div>
            <span class="section-label">Provider</span>
            <h2>${providerName}</h2>
          </div>
          <div class="provider-actions">
            <button type="button" class="secondary" ?disabled=${!canDiscover || discovery?.phase === "discovering"} @click=${() => { void this.discoverModels(providerName); }}>
              ${discovery?.phase === "discovering" ? spinnerIcon() : reloadIcon()} ${discovery === undefined ? "Fetch models" : discovery.phase === "discovering" ? "Fetching models..." : "Refresh models"}
            </button>
            <button type="button" class="danger" @click=${() => { this.deleteProvider(providerName); }}>${trashIcon()} Delete provider</button>
          </div>
        </div>

        <div class="field-stack provider-name-field">
          <label for="provider-name">Provider name</label>
          <div class="inline-field">
            <input id="provider-name" class="mono" .value=${this.providerNameDraft} placeholder="provider-name" @input=${(event: Event) => { this.providerNameDraft = textValue(event); this.renameError = ""; }}>
            <button type="button" class="secondary" ?disabled=${this.providerNameDraft.trim() === "" || this.providerNameDraft === providerName} @click=${() => { this.renameSelectedProvider(providerName); }}>Rename</button>
          </div>
          ${this.renameError !== "" ? html`<span class="field-error">${this.renameError}</span>` : null}
        </div>

        <div class="field-stack">
          <label for="provider-base-url">Base URL</label>
          <input id="provider-base-url" class="mono" .value=${provider.baseUrl ?? ""} placeholder="https://api.example.com/v1" @input=${(event: Event) => { this.replaceProvider(providerName, { ...provider, baseUrl: optionalText(textValue(event)) }); }}>
        </div>

        <div class="field-stack">
          <label for="provider-api-key">API key source</label>
          <input id="provider-api-key" class="mono" type="password" autocomplete="off" .value=${provider.apiKey ?? ""} placeholder="ENV_VAR_NAME, !command, or literal key" @input=${(event: Event) => { this.replaceProvider(providerName, { ...provider, apiKey: optionalText(textValue(event)) }); }}>
          <span class="help-text">Use an environment variable name, prefix a command with <code>!</code>, or configure built-in provider credentials through Authentication.</span>
        </div>

        <div class="field-stack">
          <label for="provider-api">API format</label>
          <select id="provider-api" .value=${provider.api ?? "openai-completions"} @change=${(event: Event) => { this.replaceProvider(providerName, { ...provider, api: textValue(event) }); }}>
            ${MODEL_API_OPTIONS.map((api) => html`<option value=${api}>${api}</option>`)}
          </select>
        </div>

        <span class="help-text">${discovery?.phase === "discovering"
          ? "Fetching models from this provider..."
          : discovery?.models === undefined
            ? canDiscover
              ? "Fetch models to choose from this provider's current catalog when you add or edit a model."
              : "Set a Base URL before fetching this provider's models."
            : `${String(discovery.models.length)} model${discovery.models.length === 1 ? "" : "s"} fetched from this provider.`}</span>

        <details class="advanced-fields">
          <summary>Advanced provider fields</summary>
          <div class="advanced-fields-body">
            ${this.renderJsonField("Headers", "headers", provider.headers, (value) => { this.updateProviderHeaders(providerName, provider, value); })}
            ${this.renderJsonField("Compatibility", "compat", provider.compat, (value) => { this.updateProviderObject(providerName, provider, "compat", value); })}
            ${this.renderJsonField("Model overrides", "model-overrides", provider.modelOverrides, (value) => { this.updateProviderObject(providerName, provider, "modelOverrides", value); })}
          </div>
        </details>
      </div>
    `;
  }

  private renderModelDetail(providerName: string, provider: ModelsConfigProvider, model: ModelsConfigModel, index: number): TemplateResult {
    const test = this.modelTests[modelTestKey(providerName, index)];
    return html`
      <div class="detail-content">
        <div class="detail-heading">
          <div>
            <span class="section-label">Model</span>
            <h2>${model.id.trim() === "" ? "New model" : model.id}</h2>
          </div>
          <div class="model-actions">
            ${test === undefined ? null : html`<span class="connection-state ${test.phase}">${connectionStateLabel(test)}</span>`}
            <button type="button" class="secondary" ?disabled=${model.id.trim() === "" || test?.phase === "testing"} @click=${() => { void this.testModel(providerName, index); }}>
              ${test?.phase === "testing" ? spinnerIcon() : plugIcon()} ${test?.phase === "testing" ? "Testing..." : "Test"}
            </button>
            <button type="button" class="danger" @click=${() => { this.deleteModel(providerName, index); }}>${trashIcon()} Remove</button>
          </div>
        </div>

        ${test === undefined ? null : html`<div class="connection-detail ${test.phase}">${connectionStateDetail(test)}</div>`}

        <div class="field-grid two-columns">
          ${this.renderModelIdField(providerName, model, index)}
          <div class="field-stack">
            <label for="model-name">Display name</label>
            <input id="model-name" .value=${model.name ?? ""} placeholder="Display name" @input=${(event: Event) => { this.replaceModel(providerName, index, { ...model, name: optionalText(textValue(event)) }); }}>
          </div>
        </div>

        <div class="field-stack">
          <label for="model-api">API override</label>
          <select id="model-api" .value=${model.api ?? ""} @change=${(event: Event) => { this.replaceModel(providerName, index, { ...model, api: optionalText(textValue(event)) }); }}>
            <option value="">Inherit provider API</option>
            ${MODEL_API_OPTIONS.map((api) => html`<option value=${api}>${api}</option>`)}
          </select>
        </div>

        <div class="switch-row">
          ${this.renderCheck("Reasoning / thinking", model.reasoning === true, (checked) => { this.replaceModel(providerName, index, { ...model, reasoning: checked || undefined }); })}
          ${this.renderCheck("Image input", model.input?.includes("image") === true, (checked) => { this.replaceModel(providerName, index, { ...model, input: checked ? imageInputTypes(model.input) : withoutImageInput(model.input) }); })}
        </div>

        ${model.reasoning === true ? html`
          <section class="thinking-section">
            <div class="thinking-heading">
              <div>
                <span class="section-label">Thinking configuration</span>
                <p>Map Pi thinking levels to values accepted by this model, or disable a level.</p>
              </div>
              ${this.renderCheck("DeepSeek thinking compatibility", hasDeepseekCompat(model), (checked) => { this.replaceModel(providerName, index, setDeepseekCompat(model, checked)); })}
            </div>
            <div class="thinking-map">
              ${THINKING_LEVELS.map((level) => this.renderThinkingLevel(providerName, index, model, level))}
            </div>
          </section>
        ` : null}

        <div class="field-grid two-columns">
          <div class="field-stack">
            <label for="context-window">Context window (tokens)</label>
            <input id="context-window" type="number" min="0" inputmode="numeric" .value=${numberValue(model.contextWindow)} placeholder="128000" @input=${(event: Event) => { this.replaceModel(providerName, index, { ...model, contextWindow: nonNegativeInteger(textValue(event)) }); }}>
          </div>
          <div class="field-stack">
            <label for="max-tokens">Max output tokens</label>
            <input id="max-tokens" type="number" min="0" inputmode="numeric" .value=${numberValue(model.maxTokens)} placeholder="16384" @input=${(event: Event) => { this.replaceModel(providerName, index, { ...model, maxTokens: nonNegativeInteger(textValue(event)) }); }}>
          </div>
        </div>

        <section class="cost-section">
          <div>
            <span class="section-label">Cost</span>
            <p>Per million tokens.</p>
          </div>
          <div class="field-grid cost-grid">
            ${this.renderCostField("Input", "input", providerName, index, model)}
            ${this.renderCostField("Output", "output", providerName, index, model)}
            ${this.renderCostField("Cache read", "cacheRead", providerName, index, model)}
            ${this.renderCostField("Cache write", "cacheWrite", providerName, index, model)}
          </div>
        </section>

        <details class="advanced-fields">
          <summary>Advanced model fields</summary>
          <div class="advanced-fields-body">
            ${this.renderJsonField("Compatibility", "model-compat", model.compat, (value) => { this.updateModelObject(providerName, index, model, "compat", value); })}
          </div>
        </details>
      </div>
    `;
  }

  private renderModelIdField(providerName: string, model: ModelsConfigModel, index: number): TemplateResult {
    const discovered = this.discoveredModels[providerName]?.models;
    if (discovered === undefined) {
      return html`
        <div class="field-stack">
          <label for="model-id">Model ID <span aria-hidden="true">*</span></label>
          <input id="model-id" class="mono" .value=${model.id} placeholder="model-id" @input=${(event: Event) => { this.replaceModel(providerName, index, { ...model, id: textValue(event) }); }}>
        </div>
      `;
    }

    const options = model.id.trim() === "" || discovered.some((candidate) => candidate.id === model.id)
      ? discovered
      : [{ id: model.id, ...(model.name === undefined ? {} : { name: model.name }) }, ...discovered];
    return html`
      <div class="field-stack">
        <label for="model-id">Model ID <span aria-hidden="true">*</span></label>
        <select id="model-id" class="mono" .value=${model.id} @change=${(event: Event) => { this.selectDiscoveredModel(providerName, index, textValue(event)); }}>
          ${model.id.trim() === "" ? html`<option value="" disabled>Select a model</option>` : null}
          ${options.map((candidate) => html`<option value=${candidate.id}>${candidate.name === undefined ? candidate.id : `${candidate.name} (${candidate.id})`}</option>`)}
        </select>
      </div>
    `;
  }

  private renderThinkingLevel(providerName: string, index: number, model: ModelsConfigModel, level: ThinkingLevel): TemplateResult {
    const value = model.thinkingLevelMap?.[level];
    const mode = value === undefined ? "default" : value === null ? "disabled" : "custom";
    const customValue = typeof value === "string" ? value : "";
    return html`
      <div class="thinking-row">
        <code class="thinking-level ${mode}">${level}</code>
        <div class="segmented" role="group" aria-label=${`${level} thinking level`}>
          <button type="button" class=${mode === "default" ? "selected" : ""} @click=${() => { this.setThinkingLevel(providerName, index, model, level, "default"); }}>Default</button>
          <button type="button" class=${mode === "disabled" ? "disabled-state" : ""} @click=${() => { this.setThinkingLevel(providerName, index, model, level, "disabled"); }}>Disabled</button>
        </div>
        <label class="custom-thinking">
          <span>Custom</span>
          <input class="mono" .value=${customValue} placeholder=${level} @focus=${() => { this.setThinkingLevel(providerName, index, model, level, "custom", customValue || level); }} @input=${(event: Event) => { this.setThinkingLevel(providerName, index, model, level, "custom", textValue(event)); }}>
        </label>
      </div>
    `;
  }

  private renderCostField(label: string, field: ModelCostField, providerName: string, index: number, model: ModelsConfigModel): TemplateResult {
    const id = `cost-${field}`;
    return html`
      <div class="field-stack">
        <label for=${id}>${label}</label>
        <input id=${id} type="number" min="0" step="any" inputmode="decimal" .value=${numberValue(model.cost?.[field])} placeholder="0" @input=${(event: Event) => { this.setCost(providerName, index, model, field, nonNegativeNumber(textValue(event))); }}>
      </div>
    `;
  }

  private renderCheck(label: string, checked: boolean, onChange: (checked: boolean) => void): TemplateResult {
    return html`
      <label class="check-row">
        <input type="checkbox" .checked=${checked} @change=${(event: Event) => { onChange(checkedValue(event)); }}>
        <span>${label}</span>
      </label>
    `;
  }

  private renderJsonField(label: string, field: string, value: unknown, onChange: (value: string) => void): TemplateResult {
    const id = `advanced-${field}`;
    const error = this.advancedErrors[field];
    return html`
      <div class="field-stack">
        <label for=${id}>${label} (JSON object)</label>
        <textarea id=${id} class="mono" rows="4" .value=${jsonValue(value)} @change=${(event: Event) => { onChange(textValue(event)); }}></textarea>
        ${error === undefined ? null : html`<span class="field-error">${error}</span>`}
      </div>
    `;
  }

  private async loadConfig(): Promise<void> {
    const requestSequence = ++this.loadRequestSequence;
    const machineId = this.machineId();
    this.modelDiscoveryRequestSequences.clear();
    this.discoveredModels = {};
    this.loading = true;
    this.error = "";
    this.savedMessage = "";
    try {
      const config = normalizeConfig(await this.modelsApi.config(machineId));
      if (!this.isCurrentLoad(requestSequence, machineId)) return;
      this.config = config;
      this.selection = validSelection(this.selection, config);
      this.providerNameDraft = this.selection?.type === "provider" ? this.selection.providerName : "";
      this.renameError = "";
      this.advancedErrors = {};
      this.modelTests = {};
    } catch (error) {
      if (this.isCurrentLoad(requestSequence, machineId)) this.error = `Failed to load models configuration: ${errorMessage(error)}`;
    } finally {
      if (this.isCurrentLoad(requestSequence, machineId)) this.loading = false;
    }
  }

  private async saveConfig(): Promise<void> {
    if (this.saving || this.loading) return;
    const machineId = this.machineId();
    this.saving = true;
    this.error = "";
    this.savedMessage = "";
    try {
      await this.modelsApi.save(this.config, machineId);
      if (machineId !== this.machineId()) return;
      this.setSavedMessage(`Saved and reloaded models for ${this.machineLabel()}.`);
      this.onSaved?.();
    } catch (error) {
      if (machineId === this.machineId()) this.error = `Failed to save models configuration: ${errorMessage(error)}`;
    } finally {
      if (machineId === this.machineId()) this.saving = false;
    }
  }

  private async testModel(providerName: string, index: number): Promise<void> {
    const provider = this.config.providers?.[providerName];
    const model = provider?.models?.[index];
    if (provider === undefined || model === undefined) return;
    const key = modelTestKey(providerName, index);
    if (model.id.trim() === "") {
      this.modelTests = { ...this.modelTests, [key]: { phase: "error", message: "Model ID is required." } };
      return;
    }
    const machineId = this.machineId();
    this.modelTests = { ...this.modelTests, [key]: { phase: "testing" } };
    try {
      const result = await this.modelsApi.test({ providerName, provider, model }, machineId);
      if (machineId !== this.machineId()) return;
      this.modelTests = {
        ...this.modelTests,
        [key]: result.ok
          ? { phase: "success", result }
          : failedModelTestState(result),
      };
    } catch (error) {
      if (machineId === this.machineId()) this.modelTests = { ...this.modelTests, [key]: { phase: "error", message: errorMessage(error) } };
    }
  }

  private async discoverModels(providerName: string): Promise<void> {
    const provider = this.config.providers?.[providerName];
    if (provider === undefined) return;

    const requestSequence = this.nextModelDiscoveryRequest(providerName);
    const machineId = this.machineId();
    const previous = this.discoveredModels[providerName];
    this.error = "";
    this.discoveredModels = {
      ...this.discoveredModels,
      [providerName]: previous?.models === undefined
        ? { phase: "discovering" }
        : { phase: "discovering", models: previous.models },
    };

    try {
      const result = await this.modelsApi.discover({ providerName, provider }, machineId);
      if (!this.isCurrentModelDiscovery(requestSequence, machineId, providerName, provider)) return;
      this.discoveredModels = { ...this.discoveredModels, [providerName]: { phase: "ready", models: result.models } };
    } catch (error) {
      if (!this.isCurrentModelDiscovery(requestSequence, machineId, providerName, provider)) return;
      this.discoveredModels = previous === undefined
        ? recordWithoutKey(this.discoveredModels, providerName)
        : { ...this.discoveredModels, [providerName]: previous };
      this.error = `Failed to fetch models for ${providerName}: ${errorMessage(error)}`;
    }
  }

  private selectProvider(providerName: string): void {
    this.selection = { type: "provider", providerName };
    this.providerNameDraft = providerName;
    this.renameError = "";
  }

  private selectModel(providerName: string, index: number): void {
    this.selection = { type: "model", providerName, index };
    this.providerNameDraft = "";
    this.renameError = "";
  }

  private addCustomProvider(): void {
    const added = addCustomProvider(this.config);
    this.config = added.config;
    this.selectProvider(added.providerName);
  }

  private deleteProvider(providerName: string): void {
    this.clearProviderDiscovery(providerName);
    this.config = removeProvider(this.config, providerName);
    this.modelTests = clearProviderTests(this.modelTests, providerName);
    const nextProvider = Object.keys(this.config.providers ?? {})[0];
    if (nextProvider === undefined) {
      this.selection = undefined;
      this.providerNameDraft = "";
    } else {
      this.selectProvider(nextProvider);
    }
  }

  private renameSelectedProvider(providerName: string): void {
    const renamed = renameProvider(this.config, providerName, this.providerNameDraft);
    if ("error" in renamed) {
      this.renameError = renamed.error;
      return;
    }
    const newName = this.providerNameDraft.trim();
    this.clearProviderDiscovery(providerName);
    this.config = renamed.config;
    this.modelTests = renameProviderTests(this.modelTests, providerName, newName);
    this.selectProvider(newName);
  }

  private replaceProvider(providerName: string, provider: ModelsConfigProvider): void {
    this.invalidateProviderDiscovery(providerName);
    this.config = updateProvider(this.config, providerName, provider);
    this.modelTests = clearProviderTests(this.modelTests, providerName);
  }

  private addModel(providerName: string): void {
    const count = this.config.providers?.[providerName]?.models?.length ?? 0;
    this.config = addModel(this.config, providerName);
    this.selectModel(providerName, count);
  }

  private deleteModel(providerName: string, index: number): void {
    this.config = removeModel(this.config, providerName, index);
    this.modelTests = clearProviderTests(this.modelTests, providerName);
    this.selectProvider(providerName);
  }

  private replaceModel(providerName: string, index: number, model: ModelsConfigModel): void {
    this.config = updateModel(this.config, providerName, index, model);
    const key = modelTestKey(providerName, index);
    if (this.modelTests[key] !== undefined) this.modelTests = recordWithoutKey(this.modelTests, key);
  }

  private selectDiscoveredModel(providerName: string, index: number, modelId: string): void {
    const model = this.config.providers?.[providerName]?.models?.[index];
    const discovered = this.discoveredModels[providerName]?.models?.find((candidate) => candidate.id === modelId);
    if (model === undefined || discovered === undefined) return;
    this.replaceModel(providerName, index, {
      ...model,
      id: discovered.id,
      name: discovered.name ?? discovered.id,
    });
  }

  private invalidateProviderDiscovery(providerName: string): void {
    this.nextModelDiscoveryRequest(providerName);
    const discovery = this.discoveredModels[providerName];
    if (discovery?.phase !== "discovering") return;
    if (discovery.models === undefined) {
      this.discoveredModels = recordWithoutKey(this.discoveredModels, providerName);
      return;
    }
    this.discoveredModels = { ...this.discoveredModels, [providerName]: { phase: "ready", models: discovery.models } };
  }

  private clearProviderDiscovery(providerName: string): void {
    this.nextModelDiscoveryRequest(providerName);
    if (this.discoveredModels[providerName] !== undefined) this.discoveredModels = recordWithoutKey(this.discoveredModels, providerName);
  }

  private setThinkingLevel(providerName: string, index: number, model: ModelsConfigModel, level: ThinkingLevel, mode: "default" | "disabled" | "custom", value?: string): void {
    this.replaceModel(providerName, index, {
      ...model,
      thinkingLevelMap: setThinkingLevelMapEntry(model.thinkingLevelMap, level, mode, value),
    });
  }

  private setCost(providerName: string, index: number, model: ModelsConfigModel, field: ModelCostField, value: number | undefined): void {
    const cost = { ...(model.cost ?? {}), [field]: value };
    if (Object.values(cost).every((candidate) => candidate === undefined)) {
      this.replaceModel(providerName, index, { ...model, cost: undefined });
      return;
    }
    this.replaceModel(providerName, index, { ...model, cost });
  }

  private updateProviderHeaders(providerName: string, provider: ModelsConfigProvider, input: string): void {
    const parsed = parseJsonObject(input);
    const errorKey = "headers";
    if (!parsed.ok) {
      this.setAdvancedError(errorKey, parsed.error);
      return;
    }
    if (parsed.value !== undefined && !isStringRecord(parsed.value)) {
      this.setAdvancedError(errorKey, "Headers must map string names to string values.");
      return;
    }
    this.clearAdvancedError(errorKey);
    this.replaceProvider(providerName, { ...provider, headers: parsed.value === undefined ? undefined : stringRecord(parsed.value) });
  }

  private updateProviderObject(providerName: string, provider: ModelsConfigProvider, field: "compat" | "modelOverrides", input: string): void {
    const parsed = parseJsonObject(input);
    const errorKey = field === "compat" ? "compat" : "model-overrides";
    if (!parsed.ok) {
      this.setAdvancedError(errorKey, parsed.error);
      return;
    }
    this.clearAdvancedError(errorKey);
    this.replaceProvider(providerName, { ...provider, [field]: parsed.value });
  }

  private updateModelObject(providerName: string, index: number, model: ModelsConfigModel, field: "compat", input: string): void {
    const parsed = parseJsonObject(input);
    const errorKey = "model-compat";
    if (!parsed.ok) {
      this.setAdvancedError(errorKey, parsed.error);
      return;
    }
    this.clearAdvancedError(errorKey);
    this.replaceModel(providerName, index, { ...model, [field]: parsed.value });
  }

  private setAdvancedError(key: string, error: string): void {
    this.advancedErrors = { ...this.advancedErrors, [key]: error };
  }

  private clearAdvancedError(key: string): void {
    if (this.advancedErrors[key] === undefined) return;
    this.advancedErrors = recordWithoutKey(this.advancedErrors, key);
  }

  private configureAuth(): void {
    this.onConfigureAuth?.();
  }

  private close(): void {
    this.onClose?.();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.close();
  }

  private resetForMachineChange(): void {
    this.loadRequestSequence += 1;
    this.modelDiscoveryRequestSequences.clear();
    this.config = { providers: {} };
    this.loading = true;
    this.saving = false;
    this.error = "";
    this.savedMessage = "";
    this.selection = undefined;
    this.providerNameDraft = "";
    this.renameError = "";
    this.advancedErrors = {};
    this.modelTests = {};
    this.discoveredModels = {};
  }

  private machineId(): string {
    return machineIdFor(this.machine);
  }

  private machineLabel(): string {
    const name = this.machine?.name;
    return name === undefined || name === "" ? "local machine" : name;
  }

  private isCurrentLoad(requestSequence: number, machineId: string): boolean {
    return requestSequence === this.loadRequestSequence && machineId === this.machineId();
  }

  private isCurrentModelDiscovery(requestSequence: number, machineId: string, providerName: string, provider: ModelsConfigProvider): boolean {
    return requestSequence === this.modelDiscoveryRequestSequences.get(providerName)
      && machineId === this.machineId()
      && this.config.providers?.[providerName] === provider;
  }

  private nextModelDiscoveryRequest(providerName: string): number {
    const requestSequence = ++this.modelDiscoverySequence;
    this.modelDiscoveryRequestSequences.set(providerName, requestSequence);
    return requestSequence;
  }

  private setSavedMessage(message: string): void {
    if (this.savedMessageTimer !== undefined) clearTimeout(this.savedMessageTimer);
    this.savedMessage = message;
    this.savedMessageTimer = setTimeout(() => {
      this.savedMessage = "";
      this.savedMessageTimer = undefined;
    }, 3_000);
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 9; display: block; color: var(--pi-text); }
    .backdrop { position: absolute; inset: 0; display: grid; place-items: center; box-sizing: border-box; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--pi-overlay); }
    .dialog { width: min(920px, 100%); height: min(78dvh, 760px); max-height: 100%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); }
    header, footer { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--pi-border); }
    footer { min-height: 54px; border-top: 1px solid var(--pi-border); border-bottom: 0; justify-content: flex-end; }
    .title-block { display: grid; min-width: 0; gap: 2px; }
    .eyebrow, .section-label { color: var(--pi-muted); font-size: 11px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 16px; line-height: 1.25; }
    h2 { max-width: 100%; overflow: hidden; font-size: 15px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    .target { overflow: hidden; color: var(--pi-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .header-actions, .model-actions, .provider-actions { display: flex; align-items: center; gap: 6px; }
    .icon-button { display: grid; width: 30px; height: 30px; place-items: center; padding: 0; }
    button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; font-size: 12px; line-height: 1.2; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--pi-accent-border); background: var(--pi-selection-bg); }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    button:disabled { opacity: .55; cursor: wait; }
    button.primary { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); font-weight: 700; }
    button.secondary { background: var(--pi-surface); }
    button.danger { border-color: var(--pi-danger-border); background: var(--pi-danger-surface); color: var(--pi-danger); }
    .dialog-body { display: flex; flex: 1 1 auto; min-height: 0; overflow: hidden; }
    .provider-tree { display: flex; flex: 0 0 244px; flex-direction: column; min-width: 0; border-right: 1px solid var(--pi-border); background: var(--pi-surface); }
    .provider-tree-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 6px; }
    .provider-node { margin-bottom: 6px; }
    .tree-row { display: flex; width: 100%; min-width: 0; align-items: center; gap: 7px; border: 0; border-radius: 5px; background: transparent; color: var(--pi-text-secondary); padding: 6px 8px; text-align: left; }
    .tree-row:hover:not(:disabled) { border-color: transparent; background: var(--pi-selection-bg); color: var(--pi-text); }
    .tree-row.selected { background: var(--pi-selection-bg); color: var(--pi-text); font-weight: 700; }
    .provider-row { padding-top: 7px; padding-bottom: 7px; }
    .model-row, .add-model { padding-left: 26px; font-size: 11px; }
    .add-model { color: var(--pi-muted); }
    .tree-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .thinking-mark { flex: 0 0 auto; border-radius: 3px; background: var(--pi-selection-bg); color: var(--pi-accent); padding: 1px 4px; font-size: 9px; font-weight: 700; }
    .tree-empty { display: grid; gap: 6px; padding: 12px 8px; color: var(--pi-muted); font-size: 12px; line-height: 1.45; }
    .tree-empty strong { color: var(--pi-text-secondary); }
    .tree-actions { display: grid; gap: 6px; padding: 8px; border-top: 1px solid var(--pi-border); }
    .add-provider, .auth-link { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; }
    .add-provider { border-style: dashed; }
    .auth-link { border-color: transparent; background: transparent; color: var(--pi-muted); }
    .detail-pane { flex: 1 1 auto; min-width: 0; overflow: auto; }
    .detail-content { display: grid; gap: 16px; box-sizing: border-box; max-width: 760px; margin: 0 auto; padding: 20px; }
    .detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .detail-heading > div:first-child { min-width: 0; }
    .field-stack { display: grid; gap: 5px; min-width: 0; }
    .field-stack > label { color: var(--pi-muted); font-size: 12px; font-weight: 650; }
    input, select, textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 5px; background: var(--pi-bg); color: var(--pi-text); padding: 7px 9px; font: inherit; font-size: 13px; }
    textarea { min-height: 76px; resize: vertical; }
    .inline-field { display: flex; gap: 8px; }
    .inline-field input { min-width: 0; }
    .help-text, .field-error { color: var(--pi-muted); font-size: 11px; line-height: 1.45; }
    .field-error { color: var(--pi-danger); }
    .field-grid { display: grid; gap: 10px; }
    .two-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .switch-row { display: flex; flex-wrap: wrap; gap: 14px 20px; }
    .check-row { display: inline-flex; align-items: center; gap: 7px; color: var(--pi-text-secondary); font-size: 12px; cursor: pointer; }
    .check-row input { width: 14px; height: 14px; margin: 0; accent-color: var(--pi-accent); }
    .thinking-section, .cost-section { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); }
    .thinking-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .thinking-heading p, .cost-section p { margin-top: 3px; color: var(--pi-muted); font-size: 12px; line-height: 1.4; }
    .thinking-map { display: grid; gap: 5px; }
    .thinking-row { display: grid; grid-template-columns: 72px max-content minmax(130px, 1fr); align-items: center; gap: 8px; }
    .thinking-level { color: var(--pi-text-secondary); font-size: 12px; }
    .thinking-level.disabled { color: var(--pi-muted); text-decoration: line-through; }
    .segmented { display: flex; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 5px; }
    .segmented button { border: 0; border-right: 1px solid var(--pi-border); border-radius: 0; background: var(--pi-bg); color: var(--pi-muted); padding: 5px 7px; font-size: 11px; }
    .segmented button:last-child { border-right: 0; }
    .segmented button.selected { background: var(--pi-selection-bg); color: var(--pi-accent); font-weight: 700; }
    .segmented button.disabled-state { background: var(--pi-danger-surface); color: var(--pi-danger); font-weight: 700; }
    .custom-thinking { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 6px; color: var(--pi-muted); font-size: 11px; }
    .custom-thinking input { min-width: 0; padding: 5px 7px; font-size: 11px; }
    .cost-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .advanced-fields { border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); }
    .advanced-fields summary { cursor: pointer; padding: 10px 12px; color: var(--pi-text-secondary); font-size: 12px; font-weight: 700; }
    .advanced-fields-body { display: grid; gap: 12px; padding: 0 12px 12px; }
    .connection-state { max-width: 245px; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 5px; color: var(--pi-muted); padding: 5px 7px; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .connection-state.success { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
    .connection-state.error { border-color: var(--pi-danger-border); background: var(--pi-danger-surface); color: var(--pi-danger); }
    .connection-detail { border: 1px solid var(--pi-border); border-radius: 5px; color: var(--pi-text-secondary); padding: 8px 10px; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
    .connection-detail.success { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
    .connection-detail.error { border-color: var(--pi-danger-border); background: var(--pi-danger-surface); color: var(--pi-danger); }
    .empty-state { display: grid; height: 100%; min-height: 180px; place-content: center; gap: 7px; box-sizing: border-box; padding: 24px; color: var(--pi-muted); text-align: center; }
    .empty-state strong { color: var(--pi-text-secondary); }
    .footer-message { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .error-message { color: var(--pi-danger); }
    .saved-message { color: var(--pi-success); }
    .svg-icon { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (max-width: 700px) {
      .backdrop { padding: 8px; }
      .dialog { width: 100%; height: calc(100dvh - 16px); border-radius: 7px; }
      header { padding: 10px 12px; }
      footer { flex-wrap: wrap; padding: 9px 12px; }
      .footer-message { flex-basis: 100%; }
      .dialog-body { flex-direction: column; }
      .provider-tree { flex: 0 0 auto; max-height: 34%; border-right: 0; border-bottom: 1px solid var(--pi-border); }
      .provider-tree-scroll { display: flex; gap: 5px; overflow: auto; padding: 6px; }
      .provider-node { display: contents; }
      .tree-row { width: auto; max-width: 180px; }
      .provider-row { border: 1px solid var(--pi-border-muted); }
      .model-row, .add-model { padding-left: 8px; }
      .tree-actions { grid-template-columns: 1fr 1fr; }
      .detail-content { padding: 14px; }
      .two-columns, .cost-grid { grid-template-columns: 1fr; }
      .thinking-heading, .detail-heading { align-items: stretch; flex-direction: column; }
      .model-actions, .provider-actions { flex-wrap: wrap; }
      .thinking-row { grid-template-columns: 58px minmax(0, 1fr); }
      .custom-thinking { grid-column: 1 / -1; }
    }
  `;
}

function normalizeConfig(config: ModelsConfigDocument): ModelsConfigDocument {
  return config.providers === undefined ? { ...config, providers: {} } : config;
}

function validSelection(selection: ModelsSelection | undefined, config: ModelsConfigDocument): ModelsSelection | undefined {
  if (selection?.type === "provider" && config.providers?.[selection.providerName] !== undefined) return selection;
  if (selection?.type === "model" && config.providers?.[selection.providerName]?.models?.[selection.index] !== undefined) return selection;
  const firstProvider = Object.keys(config.providers ?? {})[0];
  return firstProvider === undefined ? undefined : { type: "provider", providerName: firstProvider };
}

function machineIdFor(machine: unknown): string {
  if (!isRecord(machine)) return "local";
  const id = machine["id"];
  return typeof id === "string" && id !== "" ? id : "local";
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : value;
}

function textValue(event: Event): string {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return target.value;
  return "";
}

function checkedValue(event: Event): boolean {
  return event.target instanceof HTMLInputElement && event.target.checked;
}

function numberValue(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function nonNegativeInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const number = Number(trimmed);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function nonNegativeNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function imageInputTypes(input: readonly string[] | undefined): string[] {
  const existing = input ?? ["text"];
  return existing.includes("image") ? [...existing] : [...existing, "image"];
}

function withoutImageInput(input: readonly string[] | undefined): string[] | undefined {
  const remaining = (input ?? []).filter((type) => type !== "image");
  return remaining.length === 0 ? undefined : remaining;
}

function hasDeepseekCompat(model: ModelsConfigModel): boolean {
  return model.compat?.["thinkingFormat"] === "deepseek";
}

function setDeepseekCompat(model: ModelsConfigModel, enabled: boolean): ModelsConfigModel {
  if (enabled) return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  if (model.compat === undefined) return model;
  const compat = { ...model.compat };
  delete compat["thinkingFormat"];
  delete compat["requiresReasoningContentOnAssistantMessages"];
  return { ...model, compat: Object.keys(compat).length === 0 ? undefined : compat };
}

function parseJsonObject(input: string): JsonObjectResult {
  if (input.trim() === "") return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, error: "Value must be a JSON object." };
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${errorMessage(error)}` };
  }
}

function jsonValue(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function isStringRecord(value: Record<string, unknown>): boolean {
  return Object.values(value).every((entry) => typeof entry === "string");
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") strings[name] = entry;
  }
  return strings;
}

function modelTestKey(providerName: string, index: number): string {
  return `${providerName}\u0000${String(index)}`;
}

function clearProviderTests(tests: Record<string, ModelTestState>, providerName: string): Record<string, ModelTestState> {
  const prefix = `${providerName}\u0000`;
  const next: Record<string, ModelTestState> = {};
  for (const [key, test] of Object.entries(tests)) {
    if (!key.startsWith(prefix)) next[key] = test;
  }
  return next;
}

function renameProviderTests(tests: Record<string, ModelTestState>, oldName: string, newName: string): Record<string, ModelTestState> {
  const oldPrefix = `${oldName}\u0000`;
  const newPrefix = `${newName}\u0000`;
  const next: Record<string, ModelTestState> = {};
  for (const [key, test] of Object.entries(tests)) {
    const nextKey = key.startsWith(oldPrefix) ? `${newPrefix}${key.slice(oldPrefix.length)}` : key;
    next[nextKey] = test;
  }
  return next;
}

function recordWithoutKey<T>(record: Record<string, T>, keyToRemove: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== keyToRemove) next[key] = value;
  }
  return next;
}

function failedModelTestState(result: ModelConnectionTestResponse): Extract<ModelTestState, { phase: "error" }> {
  return {
    phase: "error",
    message: result.error ?? "Model returned an error.",
    ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
    ...(result.status === undefined ? {} : { status: result.status }),
  };
}

function connectionStateLabel(test: ModelTestState): string {
  if (test.phase === "testing") return "Testing connection";
  if (test.phase === "success") return test.result.latencyMs === undefined ? "Connected" : `Connected in ${String(test.result.latencyMs)} ms`;
  return "Connection failed";
}

function connectionStateDetail(test: ModelTestState): string {
  if (test.phase === "testing") return "Sending a small test request...";
  if (test.phase === "success") {
    const parts = [
      test.result.status === undefined ? undefined : `HTTP ${String(test.result.status)}`,
      test.result.latencyMs === undefined ? undefined : `${String(test.result.latencyMs)} ms`,
      test.result.responseText === undefined || test.result.responseText === "" ? undefined : test.result.responseText,
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? "Connection succeeded." : parts.join(" - ");
  }
  const parts = [
    test.status === undefined ? undefined : `HTTP ${String(test.status)}`,
    test.latencyMs === undefined ? undefined : `${String(test.latencyMs)} ms`,
    test.message,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" - ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><path d="M9 1v3m6-3v3M9 20v3m6-3v3M20 9h3m-3 5h3M1 9h3m-3 5h3"></path></svg>`;
}

function modelIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7"></circle><path d="M12 8v4l3 2"></path></svg>`;
}

function plusIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function trashIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-3h4l1 3m-9 0 1 13h10l1-13"></path></svg>`;
}

function reloadIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 11a8 8 0 1 0 2 5.5"></path><path d="M20 4v7h-7"></path></svg>`;
}

function closeIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"></path></svg>`;
}

function keyIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="8" cy="15" r="4"></circle><path d="m11 12 9-9m-3 0h3v3"></path></svg>`;
}

function plugIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 22v-5M8 4v5m8-5v5M7 9h10v3a5 5 0 0 1-10 0V9Z"></path></svg>`;
}

function spinnerIcon() {
  return svg`<svg class="svg-icon spin" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8" opacity=".25"></circle><path d="M20 12a8 8 0 0 0-8-8"></path></svg>`;
}
