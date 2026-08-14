import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { DEFAULT_WORKSPACE_UPLOADS_FOLDER, HttpRequestError, type HostSpeechStatus, type PiWebUiConfigEnvOverrides, type PiWebUiConfigResponse, type PiWebUiConfigValues, type SpeechInputSettingsResponse, type SpeechInputSettingsUpdate } from "../../api";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import {
  emptyGatewayServerConfigDraft,
  emptyHostSpeechConfigDraft,
  emptyMachineAccessConfigDraft,
  gatewayServerConfigFromDraft,
  gatewayServerDraftFromConfig,
  hostSpeechConfigFromDraft,
  hostSpeechDraftFromConfig,
  hostSpeechDraftMatchesConfig,
  machineAccessConfigPatchFromDraft,
  machineAccessDraftFromConfig,
  speechInputDraftFromResponse,
  speechInputUpdateFromDraft,
  type GatewayServerConfigDraft,
  type HostSpeechConfigDraft,
  type MachineAccessConfigDraft,
  type SpeechInputSettingsDraft,
} from "./settingsConfigDraft";

function generalDescription(targetLabel: string): TemplateResult {
  return html`Gateway server fields edit this local gateway. File access and upload defaults edit ${targetLabel}.`;
}

@customElement("settings-general-panel")
export class SettingsGeneralPanel extends LitElement {
  @property({ attribute: false }) configResponse: PiWebUiConfigResponse | undefined;
  @property({ attribute: false }) machineConfigResponse: PiWebUiConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) machineLoading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() machineError = "";
  @property() savedMessage = "";
  @property() targetLabel = "selected machine";
  @property({ type: Boolean }) showHostSpeechSettings = false;
  @property({ attribute: false }) hostSpeechStatus?: HostSpeechStatus;
  @property({ type: Boolean }) hostSpeechStatusLoading = false;
  @property({ attribute: false }) speechInputSettings?: SpeechInputSettingsResponse;
  @property({ type: Number }) speechInputAdoptionGeneration = 0;
  @property({ type: Number }) speechInputCredentialClearGeneration = 0;
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onReloadMachine?: () => void | Promise<void>;
  @property({ attribute: false }) onReloadHostSpeech?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebUiConfigValues) => void | Promise<void>;
  @property({ attribute: false }) onSaveSpeechInput?: (update: SpeechInputSettingsUpdate) => SpeechInputSettingsResponse | Promise<SpeechInputSettingsResponse>;
  @property({ attribute: false }) onSaveMachineConfig?: (config: PiWebUiConfigValues) => void | Promise<void>;
  @query(".speech-input-api-key") private speechInputApiKeyInput?: HTMLInputElement;
  @state() private gatewayDraft: GatewayServerConfigDraft = emptyGatewayServerConfigDraft();
  @state() private hostSpeechDraft: HostSpeechConfigDraft = emptyHostSpeechConfigDraft();
  @state() private machineDraft: MachineAccessConfigDraft = emptyMachineAccessConfigDraft();
  @state() private speechInputDraft: SpeechInputSettingsDraft = emptySpeechInputSettingsDraft();
  @state() private speechInputSavedResponse: SpeechInputSettingsResponse | undefined;
  @state() private speechInputDraftDirty = false;
  @state() private credentialEntryDirty = false;
  @state() private speechInputStale = false;
  @state() private speechInputLocalError = "";
  private appliedSpeechInputAdoptionGeneration = 0;
  private appliedSpeechInputCredentialClearGeneration = 0;
  @state() private gatewayLocalError = "";
  @state() private hostSpeechDraftDirty = false;
  @state() private hostSpeechLocalError = "";
  @state() private machineLocalError = "";

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("configResponse") && this.configResponse !== undefined) {
      this.gatewayDraft = gatewayServerDraftFromConfig(this.configResponse.config);
      this.gatewayLocalError = "";
    }
    if (changed.has("configResponse")) {
      if (this.configResponse === undefined) {
        this.hostSpeechDraft = emptyHostSpeechConfigDraft();
        this.hostSpeechDraftDirty = false;
        this.hostSpeechLocalError = "";
      } else if (!this.hostSpeechDraftDirty || hostSpeechDraftMatchesConfig(this.hostSpeechDraft, this.configResponse.config)) {
        this.hostSpeechDraft = hostSpeechDraftFromConfig(this.configResponse.config);
        this.hostSpeechDraftDirty = false;
        this.hostSpeechLocalError = "";
      }
    }
    if (changed.has("machineConfigResponse") && this.machineConfigResponse !== undefined) {
      this.machineDraft = machineAccessDraftFromConfig(this.machineConfigResponse.config);
      this.machineLocalError = "";
    }
    if (changed.has("speechInputSettings") || changed.has("speechInputAdoptionGeneration") || changed.has("speechInputCredentialClearGeneration")) {
      this.adoptSpeechInputProperties();
    }
  }

  override render(): TemplateResult {
    return html`
      <settings-panel-frame
        heading="General configuration"
        .description=${generalDescription(this.targetLabel)}
        actionLabel="Reload"
        .actionDisabled=${this.loading || this.machineLoading}
        .notices=${this.panelNotices()}
        .onAction=${() => { this.reloadAll(); }}
      >
        <div class="settings-sections">
          ${this.renderGatewayServerSettings()}
          ${this.renderSpeechInputSettings()}
          ${this.showHostSpeechSettings ? this.renderHostSpeechSettings() : null}
          ${this.renderSelectedMachineAccessSettings()}
        </div>
      </settings-panel-frame>
    `;
  }

  private renderGatewayServerSettings(): TemplateResult {
    const config = this.configResponse;
    return html`
      <section class="settings-card" aria-label="Gateway server settings">
        <div class="card-heading">
          <h3>Gateway server</h3>
          <p>Host, port, and allowed hosts are saved in the gateway config. Address changes require the web service to restart before the running server binds to the new address.</p>
        </div>
        ${config === undefined && this.loading ? html`<div class="loading-card">Loading gateway configuration…</div>` : html`
          <div class="config-path-card">
            <span>Gateway config file</span>
            <code>${config?.path ?? "Unknown"}</code>
            <small>${config?.exists === true ? "Existing file" : "This file will be created on save"}</small>
          </div>
          <form class="config-form" @submit=${(event: Event) => { void this.saveGatewayConfig(event); }}>
            <label class="field">
              <span class="field-heading">
                <span>Host</span>
                ${this.renderOverrideBadge("host")}
              </span>
              <input .value=${this.gatewayDraft.host} placeholder="127.0.0.1" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateGatewayDraft({ host: inputValue(event) }); }}>
              <small>Address the web server should bind to. Leave empty to use PI WEBUI's default.</small>
            </label>

            <label class="field">
              <span class="field-heading">
                <span>Port</span>
                ${this.renderOverrideBadge("port")}
              </span>
              <input .value=${this.gatewayDraft.port} inputmode="numeric" pattern="[0-9]*" placeholder="8808" autocomplete="off" @input=${(event: Event) => { this.updateGatewayDraft({ port: inputValue(event) }); }}>
              <small>TCP port from 1 to 65535. Leave empty to use PI WEBUI's default.</small>
            </label>

            <div class="field">
              <span class="field-heading">
                <span>Allowed hosts</span>
                ${this.renderOverrideBadge("allowedHosts")}
              </span>
              <select .value=${this.gatewayDraft.allowedHostsMode} @change=${(event: Event) => { this.updateGatewayDraft({ allowedHostsMode: selectValue(event) === "all" ? "all" : "list" }); }}>
                <option value="list">Only listed hosts</option>
                <option value="all">Allow every host</option>
              </select>
              <textarea .value=${this.gatewayDraft.allowedHostsText} ?disabled=${this.gatewayDraft.allowedHostsMode === "all"} rows="4" placeholder="example.local&#10;192.168.1.20" spellcheck="false" @input=${(event: Event) => { this.updateGatewayDraft({ allowedHostsText: textAreaValue(event) }); }}></textarea>
              <small>Enter one host per line, or choose “Allow every host” to write <code>true</code>.</small>
            </div>

            ${this.renderGatewayEffectiveConfig()}

            <footer class="form-actions">
              <button class="primary" ?disabled=${this.loading || this.saving}>${this.saving ? "Saving…" : "Save gateway server config"}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private renderSpeechInputSettings(): TemplateResult {
    const response = this.speechInputSavedResponse ?? this.speechInputSettings;
    const disabled = this.saving || this.speechInputStale || response === undefined;
    const clearDisabled = disabled || !speechInputCredentialConfigured(response);
    return html`
      <section class="settings-card speech-input-card" aria-label="Speech input settings">
        <div class="card-heading">
          <h3>Speech input</h3>
          <p>Dictation settings are stored on this gateway and apply regardless of the selected coding machine.</p>
          <p class="speech-input-boundary">Browser recognition may be processed by the browser vendor's speech service. Cloud sends audio to the configured HTTPS endpoint through the gateway. Cloud audio and the resolved credential go only to that endpoint, with redirects disabled. Gateway access is administrative because PI WEBUI adds no authentication.</p>
        </div>
        ${response === undefined ? html`<div class="loading-card">${this.loading ? "Loading speech input settings…" : "Speech input settings are unavailable. Reload before saving."}</div>` : html`
          <div class="speech-input-status" role="status">${speechInputCredentialStatusText(response.credential)}</div>
          ${this.speechInputLocalError === "" ? null : html`<div class="message error-message" role="alert">${this.speechInputLocalError}</div>`}
          <form class="config-form" @submit=${(event: Event) => { void this.saveSpeechInputSettings(event); }}>
            <label class="field">
              <span class="field-heading"><span>Provider</span></span>
              <select
                .value=${this.speechInputDraft.provider}
                ?disabled=${disabled}
                @change=${(event: Event) => {
                  const value = selectValue(event);
                  this.updateSpeechInputDraft({ provider: value === "browser" || value === "cloud" ? value : "auto" });
                }}
              >
                <option value="auto">Auto</option>
                <option value="browser">Browser</option>
                <option value="cloud">Cloud</option>
              </select>
              <small>Auto uses Browser when available, then Cloud.</small>
            </label>
            <label class="field">
              <span class="field-heading"><span>Language</span></span>
              <input .value=${this.speechInputDraft.language} ?disabled=${disabled} placeholder="Auto" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateSpeechInputDraft({ language: inputValue(event) }); }}>
              <small>Leave empty for the provider default.</small>
            </label>
            <label class="field">
              <span class="field-heading"><span>Cloud base URL</span></span>
              <input .value=${this.speechInputDraft.baseUrl} ?disabled=${disabled} type="url" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateSpeechInputDraft({ baseUrl: inputValue(event) }); }}>
            </label>
            <label class="field">
              <span class="field-heading"><span>Cloud model</span></span>
              <input .value=${this.speechInputDraft.model} ?disabled=${disabled} autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateSpeechInputDraft({ model: inputValue(event) }); }}>
            </label>
            <label class="field">
              <span class="field-heading"><span>API key source</span></span>
              <input class="speech-input-api-key" type="password" ?disabled=${disabled} placeholder="Leave blank to preserve the saved source" autocomplete="off" spellcheck="false" @input=${() => { this.markSpeechInputCredentialEntryDirty(); }}>
              <small>Enter a literal, environment reference, or trusted short-lived command only when replacing the saved source.</small>
            </label>
            <footer class="form-actions speech-input-actions">
              <button type="button" ?disabled=${clearDisabled} @click=${() => { void this.clearSpeechInputCredential(); }}>Clear credential</button>
              <button class="primary" ?disabled=${disabled}>${this.saving ? "Saving…" : "Save speech input settings"}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private renderSelectedMachineAccessSettings(): TemplateResult {
    const config = this.machineConfigResponse;
    return html`
      <section class="settings-card" aria-label="Selected machine file access and upload settings">
        <div class="card-heading">
          <h3>Selected machine file access and uploads</h3>
          <p>External filesystem roots and upload defaults are saved on ${this.targetLabel}.</p>
        </div>
        ${this.renderMachineMessages()}
        ${config === undefined ? html`<div class="loading-card">${this.machineLoading ? "Loading selected-machine file access config…" : "Selected-machine file access config is unavailable. Reload before saving file/upload settings."}</div>` : html`
          <div class="config-path-card">
            <span>Selected machine config file</span>
            <code>${config.path}</code>
            <small>${config.exists ? "Existing file" : "This file will be created on save"}</small>
          </div>
          <form class="config-form" @submit=${(event: Event) => { void this.saveMachineAccessConfig(event); }}>
            <label class="field">
              <span class="field-heading">
                <span>External filesystem roots</span>
              </span>
              <textarea .value=${this.machineDraft.allowedPathsText} rows="4" placeholder="~/SDKs&#10;/opt/reference" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ allowedPathsText: textAreaValue(event) }); }}></textarea>
              <small>Allowlist for absolute <code>@</code> completions and file explorer reads outside a workspace on ${this.targetLabel}. Enter one absolute path, Windows absolute path, or <code>~</code>-prefixed path per line. Leave empty to deny external paths by default.</small>
            </label>

            <label class="field">
              <span class="field-heading">
                <span>Default upload folder</span>
              </span>
              <input .value=${this.machineDraft.uploadDefaultFolder} placeholder=${DEFAULT_WORKSPACE_UPLOADS_FOLDER} autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateMachineDraft({ uploadDefaultFolder: inputValue(event) }); }}>
              <small>Workspace-relative folder for manual file uploads on ${this.targetLabel}. Leave empty to use PI WEBUI's default <code>${DEFAULT_WORKSPACE_UPLOADS_FOLDER}</code>.</small>
            </label>

            ${this.renderMachineEffectiveConfig()}

            <footer class="form-actions">
              <button class="primary" ?disabled=${this.machineLoading || this.saving}>${this.saving ? "Saving…" : "Save file/upload config"}</button>
            </footer>
          </form>
        `}
      </section>
    `;
  }

  private renderHostSpeechSettings(): TemplateResult {
    const status = this.hostSpeechStatus;
    const available = status?.available === true;
    const gatewayConfigUnavailable = this.configResponse === undefined;
    const disabled = this.saving || this.hostSpeechStatusLoading || !available || this.loading || gatewayConfigUnavailable;
    const configuredVoice = this.hostSpeechDraft.voice.trim();
    const voices = hostSpeechVoiceOptions(status?.voices ?? [], configuredVoice, available);
    const hasConfiguredVoice = status?.voices.some((voice) => voice.name === configuredVoice) === true;
    const staleVoice = available && configuredVoice !== "" && !hasConfiguredVoice;
    const unavailableReason = status?.reason ?? (this.hostSpeechStatusLoading
      ? "Checking OS speech availability."
      : "Host speech is unavailable on this gateway host.");
    return html`
      <section class="settings-card" aria-label="Text to speech settings">
        <div class="card-heading">
          <h3>Text to speech</h3>
          <p>Text to speech plays through audio on this gateway host. It does not play on a selected remote machine.</p>
        </div>
        ${available ? null : html`<div class="host-speech-unavailable" role="status">${unavailableReason}</div>`}
        ${gatewayConfigUnavailable ? html`<div class="loading-card" role="status">${this.loading ? "Gateway configuration is still loading. Text to speech settings cannot be saved yet." : "Gateway configuration is unavailable. Reload before saving text to speech settings."}</div>` : null}
        <form class="config-form" @submit=${(event: Event) => { void this.saveHostSpeechConfig(event); }}>
          <label class="field">
            <span class="field-heading"><span>OS voice</span></span>
            <select
              .value=${configuredVoice}
              ?disabled=${disabled}
              @change=${(event: Event) => { this.updateHostSpeechDraft({ voice: selectValue(event) }); }}
            >
              <option value="">System default</option>
              ${voices.map((voice) => html`<option .value=${voice.name}>${voice.label}</option>`)}
            </select>
            ${staleVoice ? html`<small>The saved voice is no longer available. Playback uses the system default until you choose another voice.</small>` : html`<small>Choose an OS voice, or keep the system default.</small>`}
          </label>
          <div class="field">
            <span class="field-heading"><span>Speech rate</span></span>
            <div class="host-speech-rate-controls">
              <input
                aria-label="Speech rate slider"
                type="range"
                min="-100"
                max="100"
                step="1"
                .value=${String(hostSpeechRangeRate(this.hostSpeechDraft.rate))}
                ?disabled=${disabled}
                @input=${(event: Event) => { this.updateHostSpeechDraft({ rate: inputValue(event) }); }}
              >
              <input
                aria-label="Speech rate"
                type="number"
                min="-100"
                max="100"
                step="1"
                inputmode="numeric"
                .value=${this.hostSpeechDraft.rate}
                ?disabled=${disabled}
                @input=${(event: Event) => { this.updateHostSpeechDraft({ rate: inputValue(event) }); }}
              >
            </div>
            <small>Set an integer from -100 to 100. Leave this at 0 for the system's normal rate.</small>
          </div>
          <footer class="form-actions">
            <button class="primary" ?disabled=${disabled}>${this.saving ? "Saving…" : "Save text to speech settings"}</button>
          </footer>
        </form>
      </section>
    `;
  }

  private adoptSpeechInputProperties(): void {
    const response = this.speechInputSettings;
    if (response === undefined) return;
    if (this.speechInputAdoptionGeneration !== this.appliedSpeechInputAdoptionGeneration) {
      this.appliedSpeechInputAdoptionGeneration = this.speechInputAdoptionGeneration;
      this.appliedSpeechInputCredentialClearGeneration = this.speechInputCredentialClearGeneration;
      this.adoptSpeechInputResponse(response, true);
      return;
    }
    if (this.speechInputCredentialClearGeneration !== this.appliedSpeechInputCredentialClearGeneration) {
      this.appliedSpeechInputCredentialClearGeneration = this.speechInputCredentialClearGeneration;
      this.adoptSpeechInputCredentialClear(response);
      return;
    }

    const saved = this.speechInputSavedResponse;
    if (saved === undefined || saved.revision === response.revision) {
      if (saved === undefined) this.adoptSpeechInputResponse(response, false);
      else this.speechInputSavedResponse = response;
      return;
    }
    if (this.speechInputDraftDirty || this.credentialEntryDirty) {
      this.speechInputStale = true;
      this.speechInputLocalError = "Speech input settings changed in another tab. Reload before saving.";
      return;
    }
    this.adoptSpeechInputResponse(response, false);
  }

  private adoptSpeechInputResponse(response: SpeechInputSettingsResponse, clearCredentialInput: boolean): void {
    this.speechInputSavedResponse = response;
    this.speechInputDraft = speechInputDraftFromResponse(response);
    this.speechInputDraftDirty = false;
    this.credentialEntryDirty = false;
    this.speechInputStale = false;
    this.speechInputLocalError = "";
    if (clearCredentialInput) this.clearSpeechInputCredentialInput();
  }

  private adoptSpeechInputCredentialClear(response: SpeechInputSettingsResponse): void {
    this.speechInputSavedResponse = response;
    if (!this.speechInputDraftDirty) this.speechInputDraft = speechInputDraftFromResponse(response);
    this.credentialEntryDirty = false;
    this.speechInputStale = false;
    this.speechInputLocalError = "";
    this.clearSpeechInputCredentialInput();
  }

  private async saveSpeechInputSettings(event: Event): Promise<void> {
    event.preventDefault();
    const saved = this.speechInputSavedResponse;
    if (saved === undefined || this.speechInputStale || this.saving) return;
    this.speechInputLocalError = "";
    const credentialValue = this.speechInputApiKeyInput?.value ?? "";
    const credential = credentialValue === "" ? { action: "preserve" } as const : { action: "replace", value: credentialValue } as const;
    try {
      const response = await this.onSaveSpeechInput?.(speechInputUpdateFromDraft(this.speechInputDraft, saved.revision, credential));
      if (response !== undefined) this.adoptSpeechInputResponse(response, true);
    } catch (error) {
      this.handleSpeechInputSaveError(error);
    }
  }

  private async clearSpeechInputCredential(): Promise<void> {
    const saved = this.speechInputSavedResponse;
    if (saved === undefined || this.speechInputStale || this.saving) return;
    if (typeof globalThis.confirm !== "function" || !globalThis.confirm("Clear the saved speech input credential?")) return;
    this.speechInputLocalError = "";
    try {
      const response = await this.onSaveSpeechInput?.({
        expectedRevision: saved.revision,
        settings: saved.settings,
        credential: { action: "clear" },
      });
      if (response !== undefined) this.adoptSpeechInputCredentialClear(response);
    } catch (error) {
      this.handleSpeechInputSaveError(error);
    }
  }

  private handleSpeechInputSaveError(error: unknown): void {
    if (error instanceof HttpRequestError && error.status === 409) {
      this.speechInputStale = true;
      this.speechInputLocalError = "Speech input settings changed in another tab. Reload before saving.";
      return;
    }
    if (error instanceof HttpRequestError
      && error.status === 400
      && error.message === "Re-enter the API key source when changing the cloud base URL.") {
      this.speechInputLocalError = "Re-enter the API key source when changing the cloud base URL, or clear the saved credential first.";
      return;
    }
    this.speechInputLocalError = errorMessage(error);
  }

  private updateSpeechInputDraft(patch: Partial<SpeechInputSettingsDraft>): void {
    this.speechInputDraft = { ...this.speechInputDraft, ...patch };
    this.speechInputDraftDirty = true;
    this.speechInputLocalError = "";
  }

  private markSpeechInputCredentialEntryDirty(): void {
    this.credentialEntryDirty = true;
    this.speechInputLocalError = "";
  }

  private clearSpeechInputCredentialInput(): void {
    if (this.speechInputApiKeyInput !== undefined) this.speechInputApiKeyInput.value = "";
  }

  private panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    const gatewayError = this.gatewayLocalError || this.error;
    if (gatewayError !== "") notices.push({ type: "error", title: "Gateway server", content: gatewayError });
    if (this.hostSpeechLocalError !== "") notices.push({ type: "error", title: "Text to speech", content: this.hostSpeechLocalError });
    if (this.speechInputLocalError !== "") notices.push({ type: "error", title: "Speech input", content: this.speechInputLocalError });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    return notices;
  }

  private renderMachineMessages(): TemplateResult | null {
    const error = this.machineLocalError || this.machineError;
    if (error === "") return null;
    return html`<div class="message error-message">${error}</div>`;
  }

  private renderOverrideBadge(key: keyof PiWebUiConfigEnvOverrides): TemplateResult | null {
    if (this.configResponse?.envOverrides[key] !== true) return null;
    return html`<span class="override-badge">environment override</span>`;
  }

  private renderGatewayEffectiveConfig(): TemplateResult {
    const effective = this.configResponse?.effectiveConfig ?? {};
    return html`
      <section class="effective-card" aria-label="Effective gateway configuration summary">
        <h3>Effective gateway settings after environment overrides</h3>
        <dl>
          <div><dt>Host</dt><dd>${effective.host ?? html`<span class="muted">127.0.0.1 default</span>`}</dd></div>
          <div><dt>Port</dt><dd>${effective.port ?? html`<span class="muted">8808 default</span>`}</dd></div>
          <div><dt>Allowed hosts</dt><dd>${formatAllowedHosts(effective.allowedHosts)}</dd></div>
        </dl>
      </section>
    `;
  }

  private renderMachineEffectiveConfig(): TemplateResult {
    const effective = this.machineConfigResponse?.effectiveConfig ?? {};
    return html`
      <section class="effective-card" aria-label="Effective selected machine file access and upload summary">
        <h3>Effective selected-machine settings</h3>
        <dl>
          <div><dt>External roots</dt><dd>${formatAllowedPaths(effective.pathAccess?.allowedPaths)}</dd></div>
          <div><dt>Upload folder</dt><dd>${effective.uploads?.defaultFolder ?? html`<span class="muted">${DEFAULT_WORKSPACE_UPLOADS_FOLDER} default</span>`}</dd></div>
        </dl>
      </section>
    `;
  }

  private reloadAll(): void {
    void this.onReload?.();
    void this.onReloadMachine?.();
    if (this.showHostSpeechSettings) void this.onReloadHostSpeech?.();
  }

  private async saveGatewayConfig(event: Event): Promise<void> {
    event.preventDefault();
    this.gatewayLocalError = "";
    try {
      await this.onSave?.(gatewayServerConfigFromDraft(this.gatewayDraft, this.configResponse?.config ?? {}));
    } catch (error) {
      this.gatewayLocalError = errorMessage(error);
    }
  }

  private async saveMachineAccessConfig(event: Event): Promise<void> {
    event.preventDefault();
    this.machineLocalError = "";
    try {
      await this.onSaveMachineConfig?.(machineAccessConfigPatchFromDraft(this.machineDraft));
    } catch (error) {
      this.machineLocalError = errorMessage(error);
    }
  }

  private async saveHostSpeechConfig(event: Event): Promise<void> {
    event.preventDefault();
    this.hostSpeechLocalError = "";
    const configResponse = this.configResponse;
    if (configResponse === undefined) {
      this.hostSpeechLocalError = "Reload gateway configuration before saving text to speech settings.";
      return;
    }
    try {
      await this.onSave?.(hostSpeechConfigFromDraft(this.hostSpeechDraft, configResponse.config));
    } catch (error) {
      this.hostSpeechLocalError = errorMessage(error);
    }
  }

  private updateGatewayDraft(patch: Partial<GatewayServerConfigDraft>): void {
    this.gatewayDraft = { ...this.gatewayDraft, ...patch };
    this.gatewayLocalError = "";
  }

  private updateMachineDraft(patch: Partial<MachineAccessConfigDraft>): void {
    this.machineDraft = { ...this.machineDraft, ...patch };
    this.machineLocalError = "";
  }

  private updateHostSpeechDraft(patch: Partial<HostSpeechConfigDraft>): void {
    this.hostSpeechDraft = { ...this.hostSpeechDraft, ...patch };
    this.hostSpeechDraftDirty = true;
    this.hostSpeechLocalError = "";
  }

  static override styles = css`
    :host { display: block; }
    .card-heading { display: grid; gap: 6px; min-width: 0; }
    h3, p { margin: 0; }
    h3 { font-size: 13px; line-height: 1.3; }
    p { color: var(--pi-muted); line-height: 1.45; }
    button, input, select, textarea { font: inherit; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .settings-sections { display: grid; gap: 14px; }
    .settings-card, .message, .loading-card, .config-path-card, .effective-card, .host-speech-unavailable { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .settings-card { display: grid; gap: 14px; }
    .message { margin-bottom: 12px; }
    .settings-card .message { margin-bottom: 0; }
    .speech-input-status { min-width: 0; color: var(--pi-muted); line-height: 1.45; overflow-wrap: anywhere; }
    .speech-input-boundary { min-width: 0; overflow-wrap: anywhere; }
    .speech-input-actions { flex-wrap: wrap; }
    .error-message { border-color: var(--pi-danger); color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 10%, var(--pi-surface)); }
    .host-speech-unavailable { border-color: var(--pi-warning-border); color: var(--pi-warning); background: var(--pi-warning-surface); }
    .loading-card { color: var(--pi-muted); }
    .config-path-card { display: grid; gap: 5px; }
    .config-path-card span, .field-heading, dt { color: var(--pi-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .config-path-card small, .field small { color: var(--pi-muted); }
    .config-form { display: grid; gap: 14px; }
    .field { display: grid; gap: 7px; }
    .field-heading { display: flex; align-items: center; gap: 8px; }
    input, select, textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 9px 10px; outline: none; font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); }
    input:focus, select:focus, textarea:focus { border-color: var(--pi-accent); box-shadow: 0 0 0 1px var(--pi-accent-border); }
    textarea { resize: vertical; min-height: 94px; font-family: var(--pi-control-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    textarea:disabled { opacity: .55; }
    .override-badge { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); background: var(--pi-warning-surface); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: none; }
    .effective-card { display: grid; gap: 10px; }
    .effective-card dl { display: grid; gap: 8px; margin: 0; }
    .effective-card dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; align-items: baseline; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .muted { color: var(--pi-muted); }
    .form-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px; }
    .primary { border-color: var(--pi-accent); background: var(--pi-selection-bg); color: var(--pi-text-bright); }
    .host-speech-rate-controls { display: grid; grid-template-columns: minmax(0, 1fr) 76px; gap: 10px; align-items: center; }
    .host-speech-rate-controls input[type="range"] { padding: 0; }

    @media (max-width: 760px) {
      .effective-card dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
    }
  `;
}

function emptySpeechInputSettingsDraft(): SpeechInputSettingsDraft {
  return { provider: "auto", language: "", baseUrl: "", model: "" };
}

function speechInputCredentialConfigured(response: SpeechInputSettingsResponse | undefined): boolean {
  return response?.credential.configured ?? false;
}

function speechInputCredentialStatusText(credential: SpeechInputSettingsResponse["credential"]): string {
  if (!credential.configured) return "No API key source is configured.";
  if (credential.source === "literal") return "A literal API key source is configured.";
  if (credential.source === "environment") {
    return credential.resolution === "resolved"
      ? "An environment API key source is configured and resolves for this gateway."
      : "An environment API key source is configured but is not currently resolved for this gateway.";
  }
  return "A command API key source is configured and is checked when transcription starts.";
}

function formatAllowedHosts(value: PiWebUiConfigValues["allowedHosts"]): string | TemplateResult {
  if (value === true) return "Any host";
  if (Array.isArray(value)) return value.length === 0 ? html`<span class="muted">None listed</span>` : value.join(", ");
  return html`<span class="muted">Unset</span>`;
}

function formatAllowedPaths(value: string[] | undefined): string | TemplateResult {
  if (value === undefined || value.length === 0) return html`<span class="muted">External paths denied</span>`;
  return value.join(", ");
}

function hostSpeechVoiceOptions(
  voices: readonly NonNullable<HostSpeechStatus["voices"]>[number][],
  configuredVoice: string,
  voiceInventoryAvailable: boolean,
): { name: string; label: string }[] {
  const unique = new Map<string, { name: string; label: string }>();
  for (const voice of voices) {
    if (!unique.has(voice.name)) unique.set(voice.name, { name: voice.name, label: hostSpeechVoiceLabel(voice) });
  }
  const stale = configuredVoice.trim();
  if (stale !== "" && !unique.has(stale)) {
    unique.set(stale, {
      name: stale,
      label: voiceInventoryAvailable ? `${stale} (no longer available)` : `${stale} (configured)`,
    });
  }
  return [...unique.values()];
}

function hostSpeechVoiceLabel(voice: NonNullable<HostSpeechStatus["voices"]>[number]): string {
  return `${voice.name} (${voice.language}${voice.variant === undefined ? "" : `, ${voice.variant}`})`;
}

function hostSpeechRangeRate(value: string): number {
  const rate = Number(value.trim());
  return Number.isInteger(rate) && rate >= -100 && rate <= 100 ? rate : 0;
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

function selectValue(event: Event): string {
  return event.target instanceof HTMLSelectElement ? event.target.value : "";
}

function textAreaValue(event: Event): string {
  return event.target instanceof HTMLTextAreaElement ? event.target.value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
