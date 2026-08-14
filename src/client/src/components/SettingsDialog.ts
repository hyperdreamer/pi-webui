import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppAction } from "../actions";
import { configApi, modelTiersApi, piPackagesApi, pluginsApi, speechInputApi, utilityModelsApi, type HostSpeechStatus, type Machine, type MachineRuntime, type ModelTierLadder, type ModelTierSettingsResponse, type PiPackageMutationResponse, type PiPackageScope, type PiPackagesResponse, type PiWebUiConfigResponse, type PiWebUiConfigValues, type PiWebUiPluginsResponse, type SpeechInputSettingsResponse, type SpeechInputSettingsUpdate, type UtilityModelSettingsResponse, type UtilityModelSettingsUpdate } from "../api";
import type { SettingsSection } from "../settingsRoute";
import "./settings/SettingsGeneralPanel";
import "./settings/SettingsSessiondPanel";
import "./settings/SettingsPackagesPanel";
import "./settings/SettingsPluginsPanel";
import "./settings/SettingsModelTiersPanel";
import "./settings/SettingsShortcutsPanel";
import "./settings/SettingsUtilityModelsPanel";
import { friendlyPiPackageErrorMessage, isPiPackageManagementUnsupported, piPackageManagementSupport, piPackageManagementSupportKey, piPackageMutationFollowUpMessage, piPackageTargetLabel, shouldRefreshGatewayPluginsAfterPiPackageMutation, type PiPackageManagementSupport, type PiPackageOperationState, type PiPackageTargetContext } from "./settings/piPackageSettings";
import { loadGatewaySettingsData, loadPiPackagesData } from "./settings/settingsDataLoading";
import { mergeSelectedMachineAccessConfig } from "./settings/settingsMachineAccessConfig";
import { agentProfileSettingsSupport, friendlySelectedMachineSettingsErrorMessage, isAgentProfileSettingsSupported, isSelectedMachineSettingsUnsupported, modelTierSettingsSupport, selectedMachineSettingsSupport, selectedMachineSettingsSupportKey, settingsMachineTarget, settingsMachineTargetLabel, utilityModelSettingsSupport, type AgentProfileSettingsSupport, type SelectedMachineSettingsSupport, type SettingsMachineTarget, type UtilityModelSettingsSupport } from "./settings/settingsMachineTarget";
import { mergeSelectedMachinePluginConfig, pluginEnabledConfigPatch } from "./settings/settingsPluginConfig";
import { mergeSelectedMachineSessiondConfig } from "./settings/settingsSessiondConfig";

@customElement("settings-dialog")
export class SettingsDialog extends LitElement {
  @property({ attribute: false }) section: SettingsSection = "general";
  @property({ attribute: false }) actions: AppAction[] = [];
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) machineRuntime: MachineRuntime | undefined;
  @property({ attribute: false }) onNavigate?: (section: SettingsSection) => void;
  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onConfigSaved?: (config: PiWebUiConfigValues) => void;
  @property({ attribute: false }) onRefreshMachineRuntime?: (machineId: string) => void | Promise<void>;
  @property({ attribute: false }) onModelTiersSaved?: (machineId: string, response: ModelTierSettingsResponse) => void;
  @property({ type: Boolean }) showHostSpeechSettings = false;
  @property({ attribute: false }) hostSpeechStatus?: HostSpeechStatus;
  @property({ type: Boolean }) hostSpeechStatusLoading = false;
  @property({ attribute: false }) onReloadHostSpeech?: () => void | Promise<void>;
  @property({ attribute: false }) speechInputSettings?: SpeechInputSettingsResponse;
  @property({ attribute: false }) speechInputSettingsRequestSeq = 0;
  @property({ attribute: false }) isSpeechInputSettingsRequestCurrent?: (requestSeq: number) => boolean;
  @property({ attribute: false }) onSpeechInputSettingsLoaded?: (response: SpeechInputSettingsResponse) => void;
  @property({ attribute: false }) onSpeechInputSettingsSaved?: (response: SpeechInputSettingsResponse) => void;
  @state() private configResponse: PiWebUiConfigResponse | undefined;
  @state() private accessConfigResponse: PiWebUiConfigResponse | undefined;
  @state() private sessiondConfigResponse: PiWebUiConfigResponse | undefined;
  @state() private pluginsResponse: PiWebUiPluginsResponse | undefined;
  @state() private selectedPluginConfigResponse: PiWebUiConfigResponse | undefined;
  @state() private selectedPluginsResponse: PiWebUiPluginsResponse | undefined;
  @state() private packagesResponse: PiPackagesResponse | undefined;
  @state() private modelTiersConfigResponse: ModelTierSettingsResponse | undefined;
  @state() private utilityModelsConfigResponse: UtilityModelSettingsResponse | undefined;
  @state() private loading = true;
  @state() private accessLoading = true;
  @state() private sessiondLoading = true;
  @state() private pluginLoading = true;
  @state() private packageLoading = true;
  @state() private modelTiersLoading = true;
  @state() private utilityModelsLoading = true;
  @state() private saving = false;
  @state() private packageOperation: PiPackageOperationState | undefined;
  @state() private error = "";
  @state() private accessError = "";
  @state() private sessiondError = "";
  @state() private pluginError = "";
  @state() private packageError = "";
  @state() private modelTiersError = "";
  @state() private utilityModelsError = "";
  @state() private speechInputAdoptionGeneration = 0;
  @state() private speechInputCredentialClearGeneration = 0;
  @state() private savedMessage = "";
  @state() private packageMessage = "";
  private savedMessageTimer: number | undefined;
  private loadRequestSeq = 0;
  private accessLoadRequestSeq = 0;
  private sessiondLoadRequestSeq = 0;
  private pluginLoadRequestSeq = 0;
  private packageLoadRequestSeq = 0;
  private packageMutationSeq = 0;
  private modelTiersLoadRequestSeq = 0;
  private utilityModelsLoadRequestSeq = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadConfig();
    void this.loadAccessConfigForTarget();
    void this.reloadSessiondState();
    void this.loadPluginsForTarget();
    void this.loadPackagesForTarget();
    void this.loadModelTiersForTarget();
    void this.loadUtilityModelsForTarget();
  }

  override disconnectedCallback(): void {
    if (this.savedMessageTimer !== undefined) window.clearTimeout(this.savedMessageTimer);
    this.savedMessageTimer = undefined;
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    const currentTarget = this.settingsTarget();
    if (changed.has("machine")) {
      const previousTarget = settingsMachineTarget(changed.get("machine"));
      if (previousTarget.id !== currentTarget.id) {
        this.resetAccessStateForTargetChange();
        if (this.isConnected) void this.loadAccessConfigForTarget(currentTarget);
        this.resetSessiondStateForTargetChange();
        if (this.isConnected) void this.loadSessiondConfigForTarget(currentTarget);
        this.resetPluginStateForTargetChange();
        if (this.isConnected) void this.loadPluginsForTarget(currentTarget);
        this.resetPackageStateForTargetChange();
        if (this.isConnected) void this.loadPackagesForTarget(currentTarget);
        this.resetModelTiersStateForTargetChange();
        if (this.isConnected) void this.loadModelTiersForTarget(currentTarget);
        this.resetUtilityModelsStateForTargetChange();
        if (this.isConnected) void this.loadUtilityModelsForTarget(currentTarget);
        return;
      }
    }

    if (!changed.has("machineRuntime")) return;
    if (this.selectedMachineSettingsSupportNeedsReload(changed.get("machineRuntime"), currentTarget)) {
      this.resetAccessStateForTargetChange();
      if (this.isConnected) void this.loadAccessConfigForTarget(currentTarget);
      this.resetSessiondStateForTargetChange();
      if (this.isConnected) void this.loadSessiondConfigForTarget(currentTarget);
      this.resetPluginStateForTargetChange();
      if (this.isConnected) void this.loadPluginsForTarget(currentTarget);
      this.resetModelTiersStateForTargetChange();
      if (this.isConnected) void this.loadModelTiersForTarget(currentTarget);
    }
    if (this.utilityModelSettingsSupportNeedsReload(changed.get("machineRuntime"), currentTarget)) {
      this.resetUtilityModelsStateForTargetChange();
      if (this.isConnected) void this.loadUtilityModelsForTarget(currentTarget);
    }
    if (!this.packageManagementSupportNeedsReload(changed.get("machineRuntime"), currentTarget)) return;
    this.resetPackageStateForTargetChange();
    if (this.isConnected) void this.loadPackagesForTarget(currentTarget);
  }

  override render(): TemplateResult {
    return html`
      <div class="backdrop" @mousedown=${() => this.onClose?.()}>
        <section class="settings-shell" role="dialog" aria-modal="true" aria-label="PI WEBUI settings" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header class="settings-header">
            <div>
              <span class="eyebrow">Settings</span>
              <h1>PI WEBUI</h1>
            </div>
            <button class="close-button" title="Close settings" aria-label="Close settings" @click=${() => this.onClose?.()}>×</button>
          </header>
          <div class="settings-body">
            <nav class="settings-nav" aria-label="Settings sections">
              ${this.renderNavButton("general", "General", "Gateway + selected machine")}
              ${this.renderNavButton("sessiond", "Session daemon", "Selected machine")}
              ${this.renderNavButton("packages", "Pi packages", "Selected machine")}
              ${this.renderNavButton("plugins", "PI WEBUI plugins", "Selected machine")}
              ${this.renderNavButton("modeltiers", "Model tiers", "Selected machine")}
              ${this.renderNavButton("utilitymodels", "Utility models", "Selected machine")}
              ${this.renderNavButton("shortcuts", "Keyboard", "Gateway shortcuts")}
            </nav>
            <main class="settings-content">
              ${this.renderActiveSection()}
            </main>
          </div>
        </section>
      </div>
    `;
  }

  private renderActiveSection(): TemplateResult {
    // Keep the section -> panel routing in sync with the public
    // `activeSettingsPanelTag` seam below, which tests assert against instead of
    // scraping this template's markup.
    if (this.section === "sessiond") {
      return html`
        <settings-sessiond-panel
          .configResponse=${this.sessiondConfigResponse}
          .loading=${this.sessiondLoading}
          .saving=${this.saving}
          .error=${this.sessiondError}
          .savedMessage=${this.savedMessage}
          .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
          .activeAgentProfile=${this.machineRuntime?.components?.sessiond.activeAgentProfile}
          .agentProfileSupport=${this.agentProfileSettingsSupport()}
          .onReload=${() => this.reloadSessiondState()}
          .onSave=${(config: PiWebUiConfigValues) => this.saveSessiondConfig(config)}
        ></settings-sessiond-panel>
      `;
    }
    if (this.section === "shortcuts") {
      return html`
        <settings-shortcuts-panel
          .actions=${this.actions}
          .configResponse=${this.configResponse}
          .loading=${this.loading}
          .saving=${this.saving}
          .error=${this.error}
          .savedMessage=${this.savedMessage}
          .onReload=${() => this.loadConfig()}
          .onSave=${(config: PiWebUiConfigValues) => this.saveConfig(config)}
        ></settings-shortcuts-panel>
      `;
    }
    if (this.section === "packages") {
      return html`
        <settings-packages-panel
          .packagesResponse=${this.packagesResponse}
          .targetMachine=${this.packageTarget()}
          .managementSupport=${this.packageManagementSupport()}
          .loading=${this.packageLoading}
          .operation=${this.packageOperation}
          .error=${this.packageError}
          .operationMessage=${this.packageMessage}
          .onReload=${() => this.loadPackagesForTarget()}
          .onInstallPackage=${(source: string) => this.installPiPackage(source)}
          .onRemovePackage=${(source: string, scope: PiPackageScope) => this.removePiPackage(source, scope)}
          .onUpdatePackage=${(source?: string) => this.updatePiPackage(source)}
        ></settings-packages-panel>
      `;
    }
    if (this.section === "modeltiers") {
      return html`
        <settings-model-tiers-panel
          .response=${this.modelTiersConfigResponse}
          .loading=${this.modelTiersLoading}
          .saving=${this.saving}
          .error=${this.modelTiersError}
          .savedMessage=${this.savedMessage}
          .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
          .support=${this.modelTierSettingsSupport()}
          .onReload=${() => this.loadModelTiersForTarget()}
          .onSave=${(ladder: ModelTierLadder) => this.saveModelTiers(ladder)}
        ></settings-model-tiers-panel>
      `;
    }
    if (this.section === "utilitymodels") {
      return html`
        <settings-utility-models-panel
          .response=${this.utilityModelsConfigResponse}
          .loading=${this.utilityModelsLoading}
          .saving=${this.saving}
          .error=${this.utilityModelsError}
          .savedMessage=${this.savedMessage}
          .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
          .support=${this.utilityModelSettingsSupport()}
          .onReload=${() => this.loadUtilityModelsForTarget()}
          .onSave=${(update: UtilityModelSettingsUpdate) => this.saveUtilityModels(update)}
        ></settings-utility-models-panel>
      `;
    }
    if (this.section === "plugins") {
      return html`
        <settings-plugins-panel
          .configResponse=${this.selectedPluginConfigResponse}
          .pluginsResponse=${this.selectedPluginsResponse}
          .loading=${this.pluginLoading}
          .saving=${this.saving}
          .error=${this.pluginError}
          .savedMessage=${this.savedMessage}
          .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
          .onReload=${() => this.loadPluginsForTarget()}
          .onTogglePlugin=${(pluginId: string, enabled: boolean) => this.togglePlugin(pluginId, enabled)}
        ></settings-plugins-panel>
      `;
    }
    const showHostSpeechSettings = this.showHostSpeechSettings && this.settingsTarget().kind === "local";
    return html`
      <settings-general-panel
        .configResponse=${this.configResponse}
        .machineConfigResponse=${this.accessConfigResponse}
        .loading=${this.loading}
        .machineLoading=${this.accessLoading}
        .saving=${this.saving}
        .error=${this.error}
        .machineError=${this.accessError}
        .savedMessage=${this.savedMessage}
        .targetLabel=${settingsMachineTargetLabel(this.settingsTarget())}
        .showHostSpeechSettings=${showHostSpeechSettings}
        .hostSpeechStatus=${showHostSpeechSettings ? this.hostSpeechStatus : undefined}
        .hostSpeechStatusLoading=${showHostSpeechSettings && this.hostSpeechStatusLoading}
        .speechInputSettings=${this.speechInputSettings}
        .speechInputAdoptionGeneration=${this.speechInputAdoptionGeneration}
        .speechInputCredentialClearGeneration=${this.speechInputCredentialClearGeneration}
        .onReload=${() => this.loadConfig(true)}
        .onReloadMachine=${() => this.loadAccessConfigForTarget()}
        .onReloadHostSpeech=${showHostSpeechSettings ? this.onReloadHostSpeech : undefined}
        .onSave=${(config: PiWebUiConfigValues) => this.saveConfig(config)}
        .onSaveSpeechInput=${(update: SpeechInputSettingsUpdate) => this.saveSpeechInputSettings(update)}
        .onSaveMachineConfig=${(config: PiWebUiConfigValues) => this.saveMachineAccessConfig(config)}
      ></settings-general-panel>
    `;
  }

  private renderNavButton(section: SettingsSection, label: string, detail: string): TemplateResult {
    const selected = this.section === section;
    return html`
      <button class=${selected ? "selected" : ""} aria-current=${selected ? "page" : "false"} @click=${() => { this.navigate(section); }}>
        <strong>${label}</strong>
        <small>${detail}</small>
      </button>
    `;
  }

  private navigate(section: SettingsSection): void {
    this.onNavigate?.(section);
  }

  private async loadConfig(forceSpeechInputAdoption = false): Promise<void> {
    const requestSeq = ++this.loadRequestSeq;
    const speechInputSettingsAtStart = this.speechInputSettings;
    const speechInputSettingsRequestSeqAtStart = this.speechInputSettingsRequestSeq;
    this.loading = true;
    this.error = "";
    try {
      const result = await loadGatewaySettingsData({
        loadConfig: () => configApi.config(),
        loadPlugins: () => pluginsApi.plugins(),
        loadSpeechInputSettings: () => speechInputApi.settings(),
      });
      if (!this.isCurrentLoad(requestSeq)) return;

      if (result.config !== undefined) this.configResponse = result.config;
      if (result.plugins !== undefined) this.pluginsResponse = result.plugins;
      if (
        result.speechInputSettings !== undefined
        && this.speechInputSettings === speechInputSettingsAtStart
        && (this.isSpeechInputSettingsRequestCurrent?.(speechInputSettingsRequestSeqAtStart) ?? true)
      ) {
        this.speechInputSettings = result.speechInputSettings;
        if (forceSpeechInputAdoption) this.speechInputAdoptionGeneration += 1;
        this.onSpeechInputSettingsLoaded?.(result.speechInputSettings);
      }
      this.error = result.error;
    } finally {
      if (this.isCurrentLoad(requestSeq)) this.loading = false;
    }
  }

  private async loadAccessConfigForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.accessLoadRequestSeq;
    const support = this.selectedMachineSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.accessConfigResponse = undefined;
      this.accessLoading = false;
      this.accessError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    this.accessLoading = true;
    this.accessError = "";
    try {
      const response = await configApi.config(target.id);
      if (!this.isCurrentAccessLoad(requestSeq, target)) return;
      this.accessConfigResponse = response;
    } catch (error) {
      if (this.isCurrentAccessLoad(requestSeq, target)) {
        this.accessError = `Failed to load file access/upload config from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      if (this.isCurrentAccessLoad(requestSeq, target)) this.accessLoading = false;
    }
  }

  private async reloadSessiondState(target = this.settingsTarget()): Promise<void> {
    await Promise.all([
      this.loadSessiondConfigForTarget(target),
      this.onRefreshMachineRuntime?.(target.id),
    ]);
  }

  private async loadSessiondConfigForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.sessiondLoadRequestSeq;
    const support = this.selectedMachineSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.sessiondConfigResponse = undefined;
      this.sessiondLoading = false;
      this.sessiondError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    this.sessiondLoading = true;
    this.sessiondError = "";
    try {
      const response = await configApi.config(target.id);
      if (!this.isCurrentSessiondLoad(requestSeq, target)) return;
      this.sessiondConfigResponse = response;
    } catch (error) {
      if (this.isCurrentSessiondLoad(requestSeq, target)) {
        this.sessiondError = `Failed to load session-daemon config from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      if (this.isCurrentSessiondLoad(requestSeq, target)) this.sessiondLoading = false;
    }
  }

  private async loadPluginsForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.pluginLoadRequestSeq;
    const support = this.selectedMachineSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.selectedPluginConfigResponse = undefined;
      this.selectedPluginsResponse = undefined;
      this.pluginLoading = false;
      this.pluginError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    this.pluginLoading = true;
    this.pluginError = "";
    try {
      const [config, plugins] = await Promise.allSettled([configApi.config(target.id), pluginsApi.plugins(target.id)]);
      if (!this.isCurrentPluginLoad(requestSeq, target)) return;

      const errors: string[] = [];
      if (config.status === "fulfilled") this.selectedPluginConfigResponse = config.value;
      else errors.push(`config: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(config.reason), target)}`);

      if (plugins.status === "fulfilled") this.selectedPluginsResponse = plugins.value;
      else errors.push(`PI WEBUI plugins: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(plugins.reason), target)}`);

      this.pluginError = errors.length === 0 ? "" : `Failed to load PI WEBUI plugin settings from ${settingsMachineTargetLabel(target)}: ${errors.join("; ")}`;
    } finally {
      if (this.isCurrentPluginLoad(requestSeq, target)) this.pluginLoading = false;
    }
  }

  private async loadPackagesForTarget(target = this.packageTarget()): Promise<void> {
    const requestSeq = ++this.packageLoadRequestSeq;
    this.packageLoading = true;
    this.packageError = "";
    this.packageMessage = "";
    try {
      const result = await loadPiPackagesData(target, (targetId) => piPackagesApi.packages(targetId), this.packageManagementSupport(target));
      if (!this.isCurrentPackageLoad(requestSeq, target)) return;

      this.packagesResponse = result.packagesResponse;
      this.packageError = result.error;
    } finally {
      if (this.isCurrentPackageLoad(requestSeq, target)) this.packageLoading = false;
    }
  }

  private async loadModelTiersForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.modelTiersLoadRequestSeq;
    const support = this.modelTierSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.modelTiersConfigResponse = undefined;
      this.modelTiersLoading = false;
      this.modelTiersError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    this.modelTiersLoading = true;
    this.modelTiersError = "";
    try {
      const response = await modelTiersApi.settings(target.id);
      if (!this.isCurrentModelTiersLoad(requestSeq, target)) return;
      this.modelTiersConfigResponse = response;
    } catch (error) {
      if (this.isCurrentModelTiersLoad(requestSeq, target)) {
        this.modelTiersError = `Failed to load model tier settings from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      if (this.isCurrentModelTiersLoad(requestSeq, target)) this.modelTiersLoading = false;
    }
  }

  private async loadUtilityModelsForTarget(target = this.settingsTarget()): Promise<void> {
    const requestSeq = ++this.utilityModelsLoadRequestSeq;
    const support = this.utilityModelSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.utilityModelsConfigResponse = undefined;
      this.utilityModelsLoading = false;
      this.utilityModelsError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    this.utilityModelsLoading = true;
    this.utilityModelsError = "";
    try {
      const response = await utilityModelsApi.settings(target.id);
      if (!this.isCurrentUtilityModelsLoad(requestSeq, target)) return;
      this.utilityModelsConfigResponse = response;
    } catch (error) {
      if (this.isCurrentUtilityModelsLoad(requestSeq, target)) {
        this.utilityModelsError = `Failed to load utility model settings from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      if (this.isCurrentUtilityModelsLoad(requestSeq, target)) this.utilityModelsLoading = false;
    }
  }

  private async togglePlugin(pluginId: string, enabled: boolean): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    const support = this.selectedMachineSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.pluginError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    if (this.selectedPluginConfigResponse === undefined) {
      this.pluginError = `Plugin config is not loaded for ${settingsMachineTargetLabel(target)}. Reload before changing plugin enablement.`;
      return;
    }
    const patch = pluginEnabledConfigPatch(this.selectedPluginConfigResponse.config, pluginId, enabled);
    this.saving = true;
    this.pluginError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.saveConfig(patch, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.selectedPluginConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) {
        this.configResponse = mergeSelectedMachinePluginConfig(this.configResponse, response);
        this.onConfigSaved?.(this.configResponse.effectiveConfig);
      }
      const pluginRefreshError = await this.refreshPluginsForTarget(target);
      if (!this.isCurrentSettingsTarget(target)) return;
      if (pluginRefreshError !== undefined) this.pluginError = pluginRefreshError;
      this.showSavedMessage();
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        this.pluginError = `Failed to save PI WEBUI plugin config on ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveConfig(config: PiWebUiConfigValues): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.error = "";
    this.savedMessage = "";
    try {
      const response = await configApi.saveConfig(config);
      this.configResponse = response;
      this.onConfigSaved?.(response.effectiveConfig);
      this.showSavedMessage();
    } catch (error) {
      this.error = `Failed to save config: ${errorMessage(error)}`;
    } finally {
      this.saving = false;
    }
  }

  private async saveSpeechInputSettings(update: SpeechInputSettingsUpdate): Promise<SpeechInputSettingsResponse> {
    if (this.saving) throw new Error("A settings operation is already running.");
    this.saving = true;
    this.savedMessage = "";
    try {
      const response = await speechInputApi.saveSettings(update);
      this.speechInputSettings = response;
      if (update.credential.action === "clear") this.speechInputCredentialClearGeneration += 1;
      else this.speechInputAdoptionGeneration += 1;
      this.onSpeechInputSettingsSaved?.(response);
      this.showSavedMessage();
      return response;
    } finally {
      this.saving = false;
    }
  }

  private async saveMachineAccessConfig(config: PiWebUiConfigValues): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    const support = this.selectedMachineSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.accessError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    this.saving = true;
    this.accessError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.saveConfig(config, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.accessConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) {
        this.configResponse = mergeSelectedMachineAccessConfig(this.configResponse, response);
        this.onConfigSaved?.(this.configResponse.effectiveConfig);
      }
      this.showSavedMessage();
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        this.accessError = `Failed to save file access/upload config on ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveSessiondConfig(config: PiWebUiConfigValues): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    const support = this.selectedMachineSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.sessiondError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    if (config.agent !== undefined) {
      const profileSupport = this.agentProfileSettingsSupport(target);
      if (!isAgentProfileSettingsSupported(profileSupport)) {
        this.sessiondError = profileSupport.message ?? `Pi-compatible agent profile settings are not available on ${settingsMachineTargetLabel(target)}.`;
        return;
      }
    }
    this.saving = true;
    this.sessiondError = "";
    this.savedMessage = "";
    try {
      const response = await configApi.saveConfig(config, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.sessiondConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) this.configResponse = mergeSelectedMachineSessiondConfig(this.configResponse, response);
      this.showSavedMessage();
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        this.sessiondError = `Failed to save session-daemon config on ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveModelTiers(ladder: ModelTierLadder): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    const support = this.modelTierSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.modelTiersError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    this.saving = true;
    this.modelTiersError = "";
    this.savedMessage = "";
    try {
      const response = await modelTiersApi.save(ladder, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.modelTiersConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined && response.ladder !== undefined) {
        const ladder = response.ladder;
        this.configResponse = {
          ...this.configResponse,
          config: {
            ...this.configResponse.config,
            modelTiers: ladder,
          },
          effectiveConfig: {
            ...this.configResponse.effectiveConfig,
            modelTiers: ladder,
          },
        };
        this.onConfigSaved?.(this.configResponse.effectiveConfig);
      }
      // Report the successful save only once the response is current for the
      // target the save targeted; local and remote saves both notify here.
      this.onModelTiersSaved?.(target.id, response);
      this.showSavedMessage();
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        this.modelTiersError = `Failed to save model tier settings on ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveUtilityModels(update: UtilityModelSettingsUpdate): Promise<void> {
    if (this.saving) return;
    const target = this.settingsTarget();
    const loadedResponse = this.utilityModelsConfigResponse;
    if (loadedResponse === undefined) {
      this.utilityModelsError = "Utility model settings must be loaded before saving.";
      return;
    }
    const support = this.utilityModelSettingsSupport(target);
    if (isSelectedMachineSettingsUnsupported(support)) {
      this.utilityModelsError = support.message ?? `Selected-machine settings are not available on ${settingsMachineTargetLabel(target)}.`;
      return;
    }
    this.saving = true;
    this.utilityModelsError = "";
    this.savedMessage = "";
    try {
      const response = await utilityModelsApi.save(update, loadedResponse.contractVersion, target.id);
      if (!this.isCurrentSettingsTarget(target)) return;
      this.utilityModelsConfigResponse = response;
      if (target.kind === "local" && this.configResponse !== undefined) {
        const settings = response.settings;
        this.configResponse = {
          ...this.configResponse,
          config: {
            ...this.configResponse.config,
            utilityModels: settings,
          },
          effectiveConfig: {
            ...this.configResponse.effectiveConfig,
            utilityModels: settings,
          },
        };
        this.onConfigSaved?.(this.configResponse.effectiveConfig);
      }
      this.showSavedMessage();
    } catch (error) {
      if (this.isCurrentSettingsTarget(target)) {
        this.utilityModelsError = `Failed to save utility model settings on ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
      }
    } finally {
      this.saving = false;
    }
  }

  private async installPiPackage(source: string): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation({ kind: "install", source }, "install Pi package", target, () => piPackagesApi.install(source, target.id));
  }

  private async removePiPackage(source: string, scope: PiPackageScope): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation({ kind: "remove", source }, "remove Pi package", target, () => piPackagesApi.remove(source, scope, target.id));
  }

  private async updatePiPackage(source?: string): Promise<void> {
    const target = this.packageTarget();
    await this.runPiPackageMutation(source === undefined ? { kind: "update-all" } : { kind: "update", source }, "update Pi packages", target, () => piPackagesApi.update(source, target.id));
  }

  private async runPiPackageMutation(operation: PiPackageOperationState, label: string, target: PiPackageTargetContext, mutate: () => Promise<PiPackageMutationResponse>): Promise<void> {
    const support = this.packageManagementSupport(target);
    if (isPiPackageManagementUnsupported(support)) {
      this.packageError = support.message ?? `Pi package management is not available on ${piPackageTargetLabel(target)}.`;
      throw new Error(this.packageError);
    }
    if (this.saving) throw new Error("A settings operation is already running.");
    const requestSeq = ++this.packageMutationSeq;
    this.packageLoadRequestSeq += 1;
    this.packageLoading = false;
    this.saving = true;
    this.packageOperation = operation;
    this.packageError = "";
    this.packageMessage = "";
    try {
      const response = await mutate();
      if (!this.isCurrentPackageMutation(requestSeq, target)) return;
      this.packagesResponse = { packages: response.packages };
      const pluginRefreshError = shouldRefreshGatewayPluginsAfterPiPackageMutation(target) ? await this.refreshGatewayPlugins() : undefined;
      if (!this.isCurrentPackageMutation(requestSeq, target)) return;
      if (pluginRefreshError !== undefined) this.packageError = pluginRefreshError;
      this.packageMessage = piPackageMutationFollowUpMessage(response.action, target);
    } catch (error) {
      if (this.isCurrentPackageMutation(requestSeq, target)) this.packageError = `Failed to ${label} on ${piPackageTargetLabel(target)}: ${friendlyPiPackageErrorMessage(errorMessage(error), target)}`;
      throw error;
    } finally {
      if (this.packageMutationSeq === requestSeq) {
        this.packageOperation = undefined;
        this.saving = false;
      }
    }
  }

  private async refreshGatewayPlugins(): Promise<string | undefined> {
    try {
      this.pluginsResponse = await pluginsApi.plugins();
      return undefined;
    } catch (error) {
      return `Failed to refresh gateway PI WEBUI plugins: ${errorMessage(error)}`;
    }
  }

  private async refreshPluginsForTarget(target: SettingsMachineTarget): Promise<string | undefined> {
    try {
      const response = await pluginsApi.plugins(target.id);
      if (this.isCurrentSettingsTarget(target)) this.selectedPluginsResponse = response;
      return undefined;
    } catch (error) {
      return `Config saved, but failed to refresh PI WEBUI plugins from ${settingsMachineTargetLabel(target)}: ${friendlySelectedMachineSettingsErrorMessage(errorMessage(error), target)}`;
    }
  }

  private settingsTarget(): SettingsMachineTarget {
    return settingsMachineTarget(this.machine);
  }

  private packageTarget(): PiPackageTargetContext {
    return this.settingsTarget();
  }

  private selectedMachineSettingsSupport(target = this.settingsTarget()): SelectedMachineSettingsSupport {
    return selectedMachineSettingsSupport(target, this.machineRuntime);
  }

  private agentProfileSettingsSupport(target = this.settingsTarget()): AgentProfileSettingsSupport {
    return agentProfileSettingsSupport(target, this.machineRuntime);
  }

  private modelTierSettingsSupport(target = this.settingsTarget()): SelectedMachineSettingsSupport {
    return modelTierSettingsSupport(target, this.machineRuntime);
  }

  private utilityModelSettingsSupport(target = this.settingsTarget()): UtilityModelSettingsSupport {
    return utilityModelSettingsSupport(target, this.machineRuntime);
  }

  private selectedMachineSettingsSupportNeedsReload(previousRuntime: MachineRuntime | undefined, target: SettingsMachineTarget): boolean {
    const previousSupport = selectedMachineSettingsSupport(target, previousRuntime);
    const currentSupport = this.selectedMachineSettingsSupport(target);
    return selectedMachineSettingsSupportKey(previousSupport) !== selectedMachineSettingsSupportKey(currentSupport);
  }

  private utilityModelSettingsSupportNeedsReload(previousRuntime: MachineRuntime | undefined, target: SettingsMachineTarget): boolean {
    const previousSupport = utilityModelSettingsSupport(target, previousRuntime);
    const currentSupport = this.utilityModelSettingsSupport(target);
    return selectedMachineSettingsSupportKey(previousSupport) !== selectedMachineSettingsSupportKey(currentSupport);
  }

  private packageManagementSupport(target = this.packageTarget()): PiPackageManagementSupport {
    return piPackageManagementSupport(target, this.machineRuntime);
  }

  private packageManagementSupportNeedsReload(previousRuntime: MachineRuntime | undefined, target: PiPackageTargetContext): boolean {
    const previousSupport = piPackageManagementSupport(target, previousRuntime);
    const currentSupport = this.packageManagementSupport(target);
    if (piPackageManagementSupportKey(previousSupport) === piPackageManagementSupportKey(currentSupport)) return false;
    return previousSupport.state === "unsupported" || currentSupport.state === "unsupported";
  }

  private isCurrentLoad(requestSeq: number): boolean {
    return requestSeq === this.loadRequestSeq;
  }

  private isCurrentAccessLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.accessLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentSessiondLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.sessiondLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentPluginLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.pluginLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentModelTiersLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.modelTiersLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentUtilityModelsLoad(requestSeq: number, target: SettingsMachineTarget): boolean {
    return requestSeq === this.utilityModelsLoadRequestSeq && this.isCurrentSettingsTarget(target);
  }

  private isCurrentPackageLoad(requestSeq: number, target: PiPackageTargetContext): boolean {
    return requestSeq === this.packageLoadRequestSeq && this.isCurrentPackageTarget(target);
  }

  private isCurrentPackageMutation(requestSeq: number, target: PiPackageTargetContext): boolean {
    return requestSeq === this.packageMutationSeq && this.isCurrentPackageTarget(target);
  }

  private isCurrentPackageTarget(target: PiPackageTargetContext): boolean {
    return this.packageTarget().id === target.id;
  }

  private isCurrentSettingsTarget(target: SettingsMachineTarget): boolean {
    return this.settingsTarget().id === target.id;
  }

  private resetAccessStateForTargetChange(): void {
    this.accessLoadRequestSeq += 1;
    this.accessLoading = false;
    this.accessError = "";
    this.accessConfigResponse = undefined;
    this.savedMessage = "";
  }

  private resetSessiondStateForTargetChange(): void {
    this.sessiondLoadRequestSeq += 1;
    this.sessiondLoading = false;
    this.sessiondError = "";
    this.sessiondConfigResponse = undefined;
    this.savedMessage = "";
  }

  private resetPluginStateForTargetChange(): void {
    this.pluginLoadRequestSeq += 1;
    this.pluginLoading = false;
    this.pluginError = "";
    this.selectedPluginConfigResponse = undefined;
    this.selectedPluginsResponse = undefined;
    this.savedMessage = "";
  }

  private resetPackageStateForTargetChange(): void {
    const hadPackageOperation = this.packageOperation !== undefined;
    this.packageLoadRequestSeq += 1;
    this.packageMutationSeq += 1;
    this.packageLoading = false;
    this.packageOperation = undefined;
    this.packageMessage = "";
    this.packageError = "";
    this.packagesResponse = undefined;
    if (hadPackageOperation) this.saving = false;
  }

  private resetModelTiersStateForTargetChange(): void {
    this.modelTiersLoadRequestSeq += 1;
    this.modelTiersLoading = false;
    this.modelTiersError = "";
    this.modelTiersConfigResponse = undefined;
    this.savedMessage = "";
  }

  private resetUtilityModelsStateForTargetChange(): void {
    this.utilityModelsLoadRequestSeq += 1;
    this.utilityModelsLoading = false;
    this.utilityModelsError = "";
    this.utilityModelsConfigResponse = undefined;
    this.savedMessage = "";
  }

  private showSavedMessage(): void {
    this.savedMessage = "Config saved.";
    if (this.savedMessageTimer !== undefined) window.clearTimeout(this.savedMessageTimer);
    this.savedMessageTimer = window.setTimeout(() => {
      if (this.savedMessage === "Config saved.") this.savedMessage = "";
      this.savedMessageTimer = undefined;
    }, 3000);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.onClose?.();
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 30; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .backdrop { box-sizing: border-box; width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); background: var(--pi-overlay); overflow: hidden; }
    .settings-shell { width: min(980px, 100%); max-height: min(760px, 100%); min-height: min(620px, 100%); display: grid; grid-template-rows: auto minmax(0, 1fr); border: 1px solid var(--pi-border); border-radius: 14px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); overflow: hidden; }
    .settings-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border); }
    .eyebrow { display: block; color: var(--pi-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 20px; line-height: 1.2; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; cursor: pointer; }
    .close-button { width: 34px; height: 34px; display: grid; place-items: center; border: 0; background: transparent; color: var(--pi-muted); padding: 0; font-size: 24px; }
    .close-button:hover, .close-button:focus { color: var(--pi-text); background: var(--pi-surface-hover); }
    .settings-body { min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
    .settings-nav { min-height: 0; padding: 10px; border-right: 1px solid var(--pi-border); background: var(--pi-surface); overflow: auto; }
    .settings-nav button { display: grid; gap: 2px; width: 100%; margin: 0 0 6px; text-align: left; border-color: transparent; background: transparent; }
    .settings-nav button:hover, .settings-nav button:focus { background: var(--pi-surface-hover); }
    .settings-nav button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .settings-nav small { color: var(--pi-muted); }
    .settings-content { min-width: 0; min-height: 0; overflow: auto; padding: 18px; }

    @media (max-width: 760px) {
      .backdrop { padding: 0; place-items: stretch; }
      .settings-shell { width: 100%; height: 100dvh; max-height: none; min-height: 0; border: 0; border-radius: 0; }
      .settings-header { padding: max(12px, env(safe-area-inset-top)) 12px 12px; }
      .settings-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .settings-nav { display: flex; gap: 8px; padding: 8px; border-right: 0; border-bottom: 1px solid var(--pi-border); overflow-x: auto; overflow-y: hidden; }
      .settings-nav button { flex: 0 0 auto; width: auto; min-width: 128px; margin: 0; }
      .settings-content { padding: 14px 12px calc(18px + env(safe-area-inset-bottom)); }
    }
  `;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SettingsPanelTag =
  | "settings-general-panel"
  | "settings-sessiond-panel"
  | "settings-packages-panel"
  | "settings-plugins-panel"
  | "settings-shortcuts-panel"
  | "settings-model-tiers-panel"
  | "settings-utility-models-panel";

/**
 * The single custom-element panel the settings dialog renders for a section.
 *
 * This is the public routing contract behind `renderActiveSection`: each section
 * maps to exactly one panel element and nothing else (no per-tab "scope note"
 * wrapper). Tests assert this mapping instead of inspecting the rendered
 * `TemplateResult`'s markup.
 */
export function activeSettingsPanelTag(section: SettingsSection): SettingsPanelTag {
  switch (section) {
    case "sessiond":
      return "settings-sessiond-panel";
    case "packages":
      return "settings-packages-panel";
    case "plugins":
      return "settings-plugins-panel";
    case "shortcuts":
      return "settings-shortcuts-panel";
    case "modeltiers":
      return "settings-model-tiers-panel";
    case "utilitymodels":
      return "settings-utility-models-panel";
    case "general":
      return "settings-general-panel";
  }
}
