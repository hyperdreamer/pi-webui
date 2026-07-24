import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import {
  piPackagePluginsApi,
  sessionsApi,
  type Machine,
  type PiPackagePluginAction,
  type PiPackagePluginInfo,
  type PiPackagePluginScope,
  type PiPackagePluginsResponse,
  type SessionInfo,
} from "../api";

type PluginsConfigApi = Pick<typeof piPackagePluginsApi, "list" | "mutate">;
type SessionsApi = Pick<typeof sessionsApi, "runCommand">;

interface PluginsTarget {
  cwd: string;
  machineId: string;
}

interface PackageGroup {
  scope: PiPackagePluginScope;
  packages: PiPackagePluginInfo[];
}

/**
 * Workspace-aware Pi package configuration. It mirrors Pi's package resource
 * resolution while keeping installation and session reload effects at explicit
 * API boundaries.
 */
@customElement("plugins-config-dialog")
export class PluginsConfigDialog extends LitElement {
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ type: String }) cwd = "";
  @property({ attribute: false }) session: SessionInfo | undefined;
  @property({ attribute: false }) pluginsApi: PluginsConfigApi = piPackagePluginsApi;
  @property({ attribute: false }) sessionsApi: SessionsApi = sessionsApi;
  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onReloaded?: () => void | Promise<void>;

  @state() private data: PiPackagePluginsResponse | undefined;
  @state() private loading = true;
  @state() private loadError = "";
  @state() private selectedKey: string | undefined;
  @state() private addMode = false;
  @state() private installSource = "";
  @state() private installScope: PiPackagePluginScope = "global";
  @state() private busyKey: string | undefined;
  @state() private actionError = "";
  @state() private actionMessage = "";

  @query("#plugin-source") private pluginSourceInput?: HTMLInputElement;

  private loadRequestSequence = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadPlugins();
  }

  protected override updated(changed: PropertyValues<this>): void {
    const machineChanged = changed.has("machine") && machineIdFor(changed.get("machine")) !== this.machineId();
    const cwdChanged = changed.has("cwd") && changed.get("cwd") !== this.cwd;
    if (!machineChanged && !cwdChanged) return;
    this.resetForTargetChange();
    if (this.isConnected) void this.loadPlugins();
  }

  override render(): TemplateResult {
    const selectedPackage = this.selectedPackage();
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="plugins-dialog-title" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header>
            <div class="title-block">
              <h1 id="plugins-dialog-title">Plugins</h1>
              <span class="target"><code>${shortenPath(this.cwd)}</code> on ${this.machineLabel()}</span>
            </div>
            <button class="icon-button" type="button" title="Close Plugins configuration" aria-label="Close Plugins configuration" @click=${() => { this.close(); }}>
              ${closeIcon()}
            </button>
          </header>

          <div class="dialog-body">
            ${this.renderPackageList()}
            <main class="detail-pane">
              ${this.addMode
                ? this.renderAddPanel()
                : this.loading
                  ? null
                  : selectedPackage === undefined
                    ? html`<div class="empty-state">Select a package</div>`
                    : this.renderPackageDetail(selectedPackage)}
            </main>
          </div>

          ${this.renderFooter()}
        </section>
      </div>
    `;
  }

  private renderPackageList(): TemplateResult {
    const packages = this.data?.packages ?? [];
    return html`
      <aside class="package-list" aria-label="Configured Pi packages">
        <div class="package-list-scroll">
          ${this.loading
            ? html`<div class="list-message">Loading...</div>`
            : this.loadError !== ""
              ? html`<div class="list-message error-message">${this.loadError}</div>`
              : packages.length === 0
                ? html`<div class="list-message">No plugins configured</div>`
                : this.packageGroups().map((group) => html`
                  <section class="package-group" aria-label=${`${group.scope} packages`}>
                    <h2>${group.scope}</h2>
                    ${group.packages.map((pkg) => this.renderPackageListItem(pkg))}
                  </section>
                `)}
        </div>
        <div class="package-list-actions">
          <button class="add-plugin" type="button" aria-pressed=${String(this.addMode)} @click=${() => { this.openAddMode(); }}>
            ${plusIcon()} Add plugin
          </button>
        </div>
      </aside>
    `;
  }

  private renderPackageListItem(pkg: PiPackagePluginInfo): TemplateResult {
    const key = packageKey(pkg);
    const selected = !this.addMode && key === this.selectedKey;
    return html`
      <button class="package-row ${selected ? "selected" : ""}" type="button" aria-pressed=${String(selected)} @click=${() => { this.selectPackage(pkg); }}>
        <span class="package-indicator" style=${`background:${statusColor(pkg.status)}`} aria-hidden="true"></span>
        <span class="package-copy">
          <strong>${pkg.source}</strong>
          <small>${resourceSummary(pkg)}</small>
          ${pkg.version === undefined && pkg.configuredVersion === undefined ? null : html`<small>${versionSummary(pkg)}</small>`}
        </span>
      </button>
    `;
  }

  private renderPackageDetail(pkg: PiPackagePluginInfo): TemplateResult {
    const key = packageKey(pkg);
    const busy = this.busyKey?.endsWith(key) ?? false;
    const reloadBusy = this.busyKey === "reload";
    const enabled = !pkg.disabled;
    return html`
      <div class="detail-content">
        <div class="detail-heading">
          <div class="package-title-row">
            <button
              class="package-toggle ${enabled ? "enabled" : ""}"
              type="button"
              role="switch"
              aria-checked=${String(enabled)}
              aria-label=${enabled ? "Disable package" : "Enable package"}
              title=${enabled ? "Disable package" : "Enable package"}
              ?disabled=${busy || reloadBusy}
              @click=${() => { void this.runAction(pkg.disabled ? "enable" : "disable", pkg); }}
            ><span></span></button>
            <span class="scope-tag ${pkg.scope}">${pkg.scope}</span>
            ${pkg.disabled ? html`<span class="state-tag disabled">disabled</span>` : pkg.filtered ? html`<span class="state-tag filtered">filtered</span>` : null}
            <code title=${pkg.source}>${pkg.source}</code>
          </div>
          <div class="package-actions">
            <button type="button" class="secondary" ?disabled=${busy || reloadBusy} @click=${() => { void this.runAction("update", pkg); }}>
              ${this.busyKey === `update:${key}` ? "Updating..." : "Update"}
            </button>
            <button type="button" class="secondary" ?disabled=${this.session === undefined || busy || reloadBusy} title=${this.session === undefined ? "Open a session to reload" : "Reload current session"} @click=${() => { void this.reloadSession(); }}>
              ${reloadBusy ? "Reloading..." : "Reload session"}
            </button>
            <button type="button" class="danger" ?disabled=${busy || reloadBusy} @click=${() => { void this.runAction("remove", pkg); }}>
              ${this.busyKey === `remove:${key}` ? "Removing..." : "Remove"}
            </button>
          </div>
        </div>

        <dl class="metadata-grid">
          <dt>Status</dt><dd style=${`color:${statusColor(pkg.status)}`}>${pkg.status}</dd>
          <dt>Version</dt><dd><code>${versionSummary(pkg)}</code></dd>
          <dt>Package</dt><dd><code>${pkg.packageName ?? "Unknown"}</code></dd>
          <dt>Resources</dt><dd>${resourceSummary(pkg)}</dd>
          <dt>Installed path</dt><dd class=${pkg.installedPath === undefined ? "missing" : ""}><code>${pkg.installedPath === undefined ? "Not found" : shortenPath(pkg.installedPath)}</code></dd>
          <dt>Workspace</dt><dd><code>${shortenPath(this.cwd)}</code></dd>
        </dl>

        <section class="resource-section">
          <h2>Resolved resources</h2>
          ${this.renderResources(pkg)}
        </section>

        ${this.actionMessage === "" ? null : html`<div class="success-message" aria-live="polite">${this.actionMessage}</div>`}
        ${this.actionError === "" ? null : html`<div class="field-error" aria-live="polite">${this.actionError}</div>`}
      </div>
    `;
  }

  private renderResources(pkg: PiPackagePluginInfo): TemplateResult {
    const groups = ([
      ["extension", "Extensions"],
      ["skill", "Skills"],
      ["prompt", "Prompts"],
      ["theme", "Themes"],
    ] as const).flatMap(([kind, label]) => {
      const resources = pkg.resources.filter((resource) => resource.kind === kind);
      return resources.length === 0 ? [] : [{ kind, label, resources }];
    });
    if (groups.length === 0) return html`<p class="muted-copy">${pkg.disabled ? "Package disabled" : "No resolved resources"}</p>`;
    return html`
      <div class="resource-groups">
        ${groups.map((group) => html`
          <div class="resource-group">
            <h3>${group.label}</h3>
            ${group.resources.map((resource) => html`
              <div class="resource-row">
                <code title=${resource.path}>${resource.name}</code>
                <small title=${resource.path}>${resource.relativePath}</small>
              </div>
            `)}
          </div>
        `)}
      </div>
    `;
  }

  private renderAddPanel(): TemplateResult {
    const busy = this.busyKey?.startsWith("install:") ?? false;
    const installPath = this.installScope === "project"
      ? `${shortenPath(this.cwd)}/.pi/agent/{npm,git}`
      : "~/.pi/agent/{npm,git}";
    const examples = ["npm:@scope/pi-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"];
    return html`
      <div class="detail-content add-panel">
        <div class="add-heading">
          <h2>Add Plugin</h2>
          <code>${installPath}</code>
        </div>

        <div class="field-stack">
          <label for="plugin-source">Source</label>
          <input
            id="plugin-source"
            .value=${this.installSource}
            placeholder="npm:@scope/package"
            @input=${(event: Event) => { this.installSource = inputValue(event); }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key !== "Enter" || this.installSource.trim() === "" || busy) return;
              event.preventDefault();
              void this.installPlugin();
            }}
          >
        </div>

        <div class="scope-row">
          <div class="segmented" role="group" aria-label="Plugin installation scope">
            ${(["global", "project"] as const).map((scope) => html`
              <button type="button" class=${this.installScope === scope ? "selected" : ""} @click=${() => { this.installScope = scope; }}>${scope}</button>
            `)}
          </div>
          <button type="button" class="primary" ?disabled=${busy || this.installSource.trim() === ""} @click=${() => { void this.installPlugin(); }}>
            ${busy ? "Installing..." : "Install"}
          </button>
        </div>

        <section class="examples">
          <h3>Examples</h3>
          ${examples.map((example) => html`
            <button type="button" class="example" @click=${() => { this.installSource = example; }}><code>${example}</code></button>
          `)}
        </section>
        ${this.actionError === "" ? null : html`<div class="field-error">${this.actionError}</div>`}
      </div>
    `;
  }

  private renderFooter(): TemplateResult {
    const data = this.data;
    const diagnostics = data?.diagnostics ?? [];
    const busy = this.busyKey !== undefined;
    return html`
      <footer>
        <div class="footer-summary">
          ${diagnostics.length > 0
            ? html`<span class=${diagnostics.some((diagnostic) => diagnostic.type === "error") ? "error-message" : "warning-message"} title=${diagnostics.map(formatDiagnostic).join("\n")}>
              ${String(diagnostics.length)} diagnostic${diagnostics.length === 1 ? "" : "s"}
            </span>`
            : data === undefined
              ? null
              : html`<span>${String(data.totals.extensions)} ext · ${String(data.totals.skills)} skills · ${String(data.totals.prompts)} prompts · ${String(data.totals.themes)} themes</span>`}
        </div>
        <button type="button" class="secondary" ?disabled=${this.loading || busy} @click=${() => { void this.loadPlugins(); }}>Refresh</button>
        <button type="button" class="secondary" @click=${() => { this.close(); }}>Close</button>
      </footer>
    `;
  }

  private async loadPlugins(): Promise<void> {
    const target = this.target();
    if (target === undefined) {
      this.loading = false;
      this.loadError = "A selected workspace is required to manage plugins.";
      return;
    }
    const requestSequence = ++this.loadRequestSequence;
    this.loading = true;
    this.loadError = "";
    try {
      const response = await this.pluginsApi.list(target.cwd, target.machineId);
      if (!this.isCurrentTarget(target) || requestSequence !== this.loadRequestSequence) return;
      this.data = response;
      this.addMode = response.packages.length === 0 || this.addMode;
      this.selectedKey = selectedPackageKey(this.selectedKey, response.packages);
    } catch (error) {
      if (this.isCurrentTarget(target) && requestSequence === this.loadRequestSequence) {
        this.loadError = `Failed to load plugins: ${errorMessage(error)}`;
      }
    } finally {
      if (this.isCurrentTarget(target) && requestSequence === this.loadRequestSequence) this.loading = false;
    }
  }

  private async runAction(action: PiPackagePluginAction, pkg: PiPackagePluginInfo): Promise<void> {
    const target = this.target();
    if (target === undefined || this.busyKey !== undefined) return;
    const key = packageKey(pkg);
    this.busyKey = `${action}:${key}`;
    this.actionError = "";
    this.actionMessage = "";
    try {
      const response = await this.pluginsApi.mutate({ action, source: pkg.source, scope: pkg.scope, cwd: target.cwd }, target.machineId);
      if (!this.isCurrentTarget(target)) return;
      this.data = response;
      if (action === "remove") {
        this.selectedKey = selectedPackageKey(undefined, response.packages);
        if (response.packages.length === 0) this.addMode = true;
        this.actionMessage = "Package removed.";
      } else {
        this.actionMessage = actionMessage(action);
      }
    } catch (error) {
      if (this.isCurrentTarget(target)) this.actionError = errorMessage(error);
    } finally {
      if (this.isCurrentTarget(target)) this.busyKey = undefined;
    }
  }

  private async installPlugin(): Promise<void> {
    const target = this.target();
    const source = this.installSource.trim();
    if (target === undefined || source === "" || this.busyKey !== undefined) return;
    const scope = this.installScope;
    const key = `${scope}\0${source}`;
    this.busyKey = `install:${key}`;
    this.actionError = "";
    this.actionMessage = "";
    try {
      const response = await this.pluginsApi.mutate({ action: "install", source, scope, cwd: target.cwd }, target.machineId);
      if (!this.isCurrentTarget(target)) return;
      this.data = response;
      const installed = findInstalledPackage(response.packages, source, scope);
      this.selectedKey = installed === undefined ? key : packageKey(installed);
      this.addMode = false;
      this.installSource = "";
      this.actionMessage = "Package installed.";
    } catch (error) {
      if (this.isCurrentTarget(target)) this.actionError = errorMessage(error);
    } finally {
      if (this.isCurrentTarget(target)) this.busyKey = undefined;
    }
  }

  private async reloadSession(): Promise<void> {
    const target = this.target();
    const session = this.session;
    if (target === undefined || session === undefined || this.busyKey !== undefined) return;
    this.busyKey = "reload";
    this.actionError = "";
    this.actionMessage = "";
    try {
      const result = await this.sessionsApi.runCommand(session, "/reload", target.machineId);
      if (result.type !== "done") {
        throw new Error(result.type === "unsupported" ? result.message : "Session runtime reload did not complete.");
      }
      if (!this.isCurrentTarget(target)) return;
      await this.onReloaded?.();
      await this.loadPlugins();
      if (!this.isCurrentTarget(target)) return;
      this.actionMessage = "Session reloaded.";
    } catch (error) {
      if (this.isCurrentTarget(target)) this.actionError = errorMessage(error);
    } finally {
      if (this.isCurrentTarget(target)) this.busyKey = undefined;
    }
  }

  private packageGroups(): PackageGroup[] {
    const packages = this.data?.packages ?? [];
    return (["project", "global"] as const).flatMap((scope) => {
      const scopedPackages = packages.filter((pkg) => pkg.scope === scope);
      return scopedPackages.length === 0 ? [] : [{ scope, packages: scopedPackages }];
    });
  }

  private selectedPackage(): PiPackagePluginInfo | undefined {
    return (this.data?.packages ?? []).find((pkg) => packageKey(pkg) === this.selectedKey);
  }

  private selectPackage(pkg: PiPackagePluginInfo): void {
    this.selectedKey = packageKey(pkg);
    this.addMode = false;
    this.actionError = "";
    this.actionMessage = "";
  }

  private openAddMode(): void {
    this.addMode = true;
    this.actionError = "";
    this.actionMessage = "";
    void this.updateComplete.then(() => { this.pluginSourceInput?.focus(); });
  }

  private target(): PluginsTarget | undefined {
    return this.cwd === "" ? undefined : { cwd: this.cwd, machineId: this.machineId() };
  }

  private isCurrentTarget(target: PluginsTarget): boolean {
    return target.cwd === this.cwd && target.machineId === this.machineId();
  }

  private machineId(): string {
    return machineIdFor(this.machine);
  }

  private machineLabel(): string {
    const name = this.machine?.name;
    return name === undefined || name === "" ? "local machine" : name;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.close();
  }

  private close(): void {
    this.onClose?.();
  }

  private resetForTargetChange(): void {
    this.loadRequestSequence += 1;
    this.data = undefined;
    this.loading = true;
    this.loadError = "";
    this.selectedKey = undefined;
    this.addMode = false;
    this.installSource = "";
    this.installScope = "global";
    this.busyKey = undefined;
    this.actionError = "";
    this.actionMessage = "";
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 9; display: block; color: var(--pi-text); }
    .backdrop { position: absolute; inset: 0; display: grid; box-sizing: border-box; place-items: center; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--pi-overlay); }
    .dialog { display: flex; width: min(860px, 100%); height: min(78dvh, 760px); max-height: 100%; flex-direction: column; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); }
    header, footer { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--pi-border); }
    footer { min-height: 50px; border-top: 1px solid var(--pi-border); border-bottom: 0; }
    h1, h2, h3, p, dl, dd { margin: 0; }
    h1 { font-size: 16px; line-height: 1.25; }
    h2 { color: var(--pi-text-secondary); font-size: 12px; font-weight: 650; }
    h3 { color: var(--pi-muted); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    .title-block { display: grid; min-width: 0; gap: 3px; }
    .target { overflow: hidden; color: var(--pi-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    button, input { font: inherit; }
    button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font-size: 12px; line-height: 1.2; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--pi-accent-border); background: var(--pi-selection-bg); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    button:disabled { opacity: .55; cursor: wait; }
    button.primary { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); font-weight: 700; }
    button.secondary { background: var(--pi-surface); }
    button.danger { border-color: var(--pi-danger-border); background: var(--pi-danger-surface); color: var(--pi-danger); }
    .icon-button { display: grid; width: 30px; height: 30px; place-items: center; padding: 0; }
    .dialog-body { display: flex; min-height: 0; flex: 1 1 auto; overflow: hidden; }
    .package-list { display: flex; min-width: 0; flex: 0 0 245px; flex-direction: column; border-right: 1px solid var(--pi-border); background: var(--pi-surface); }
    .package-list-scroll { min-height: 0; flex: 1 1 auto; overflow: auto; padding: 8px 6px; }
    .package-group { margin-bottom: 6px; }
    .package-group h2 { padding: 4px 8px 3px; color: var(--pi-muted); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    .package-row { display: flex; width: 100%; min-width: 0; align-items: flex-start; gap: 7px; border: 0; border-radius: 5px; background: transparent; color: var(--pi-text); padding: 8px; text-align: left; }
    .package-row:hover:not(:disabled) { border-color: transparent; background: var(--pi-selection-bg); }
    .package-row.selected { background: var(--pi-selection-bg); }
    .package-row.selected strong { font-weight: 700; }
    .package-indicator { width: 7px; height: 7px; flex: 0 0 auto; margin-top: 4px; border-radius: 50%; }
    .package-copy { display: grid; min-width: 0; flex: 1 1 auto; gap: 2px; }
    .package-copy strong, .package-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .package-copy strong { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-weight: 500; }
    .package-copy small { color: var(--pi-muted); font-size: 10px; }
    .list-message { padding: 10px 8px; color: var(--pi-muted); font-size: 12px; }
    .empty-state { display: grid; min-height: 180px; height: 100%; place-content: center; box-sizing: border-box; padding: 24px; color: var(--pi-muted); font-size: 13px; text-align: center; }
    .error-message, .field-error { color: var(--pi-danger); }
    .package-list-actions { flex: 0 0 auto; padding: 8px 6px; border-top: 1px solid var(--pi-border); }
    .add-plugin { display: flex; width: 100%; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--pi-muted); padding: 7px 8px; text-align: left; }
    .add-plugin[aria-pressed="true"] { background: var(--pi-selection-bg); color: var(--pi-accent); }
    .detail-pane { min-width: 0; flex: 1 1 auto; overflow: auto; }
    .detail-content { display: grid; box-sizing: border-box; max-width: 680px; gap: 20px; margin: 0 auto; padding: 20px; }
    .detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .package-title-row { display: flex; min-width: 0; flex: 1 1 auto; align-items: center; gap: 7px; }
    .package-title-row > code { min-width: 0; overflow: hidden; color: var(--pi-text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .package-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 7px; }
    .package-toggle { position: relative; width: 40px; height: 22px; flex: 0 0 auto; border: 0; border-radius: 11px; background: var(--pi-border); padding: 0; }
    .package-toggle.enabled { background: var(--pi-accent); }
    .package-toggle span { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--pi-bg); box-shadow: 0 1px 4px rgb(0 0 0 / 22%); transition: left .18s cubic-bezier(.4, 0, .2, 1); }
    .package-toggle.enabled span { left: 21px; }
    .scope-tag, .state-tag { flex: 0 0 auto; border-radius: 3px; padding: 1px 5px; font-size: 10px; }
    .scope-tag { background: var(--pi-border-muted); color: var(--pi-muted); }
    .scope-tag.project { background: var(--pi-selection-bg); color: var(--pi-accent); }
    .state-tag.disabled { background: var(--pi-border-muted); color: var(--pi-muted); }
    .state-tag.filtered { background: var(--pi-warning-surface, rgb(217 119 6 / 12%)); color: var(--pi-warning, #d97706); }
    .metadata-grid { display: grid; grid-template-columns: minmax(96px, 130px) minmax(0, 1fr); gap: 9px 14px; font-size: 12px; line-height: 1.45; }
    .metadata-grid dt { color: var(--pi-muted); }
    .metadata-grid dd { min-width: 0; overflow-wrap: anywhere; color: var(--pi-text-secondary); }
    .metadata-grid dd.missing { color: var(--pi-danger); }
    .resource-section { display: grid; gap: 8px; }
    .resource-section > h2 { color: var(--pi-text); }
    .resource-groups { display: grid; gap: 12px; }
    .resource-group { display: grid; gap: 6px; border-top: 1px solid var(--pi-border); padding-top: 12px; }
    .resource-group:first-child { border-top: 0; padding-top: 0; }
    .resource-row { display: grid; min-width: 0; gap: 1px; }
    .resource-row code, .resource-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .resource-row code { color: var(--pi-text); font-size: 12px; }
    .resource-row small, .muted-copy { color: var(--pi-muted); font-size: 10px; }
    .success-message { color: var(--pi-success); font-size: 12px; }
    .field-error { overflow-wrap: anywhere; font-size: 12px; line-height: 1.45; }
    .add-panel { min-height: 0; }
    .add-heading { display: grid; gap: 5px; }
    .add-heading h2 { color: var(--pi-text); font-size: 14px; }
    .add-heading code { color: var(--pi-muted); font-size: 12px; }
    .field-stack { display: grid; gap: 6px; }
    .field-stack label { color: var(--pi-text-secondary); font-size: 12px; font-weight: 650; }
    input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 8px 10px; font-size: 13px; }
    .scope-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .segmented { display: flex; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 5px; }
    .segmented button { border: 0; border-right: 1px solid var(--pi-border); border-radius: 0; background: var(--pi-bg); color: var(--pi-muted); padding: 5px 10px; font-size: 12px; }
    .segmented button:last-child { border-right: 0; }
    .segmented button.selected { background: var(--pi-selection-bg); color: var(--pi-text); font-weight: 700; }
    .examples { display: grid; gap: 6px; }
    .example { width: 100%; border: 1px solid var(--pi-border); background: var(--pi-surface); color: var(--pi-muted); padding: 7px 9px; text-align: left; }
    .example:hover:not(:disabled) { color: var(--pi-text-secondary); }
    .footer-summary { min-width: 0; flex: 1 1 auto; overflow: hidden; color: var(--pi-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .warning-message { color: var(--pi-warning, #d97706); }
    .svg-icon { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (max-width: 700px) {
      .backdrop { padding: 8px; }
      .dialog { width: 100%; height: calc(100dvh - 16px); border-radius: 7px; }
      header, footer { padding: 10px 12px; }
      .dialog-body { flex-direction: column; }
      .package-list { flex: 0 0 auto; max-height: 40%; border-right: 0; border-bottom: 1px solid var(--pi-border); }
      .detail-content { gap: 16px; padding: 14px; }
      .detail-heading { flex-direction: column; }
      .package-title-row { flex-wrap: wrap; }
      .package-actions { width: 100%; }
      .metadata-grid { grid-template-columns: 96px minmax(0, 1fr); }
    }
  `;
}

function packageKey(pkg: Pick<PiPackagePluginInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function selectedPackageKey(current: string | undefined, packages: readonly PiPackagePluginInfo[]): string | undefined {
  if (current !== undefined && packages.some((pkg) => packageKey(pkg) === current)) return current;
  return packages[0] === undefined ? undefined : packageKey(packages[0]);
}

function findInstalledPackage(packages: readonly PiPackagePluginInfo[], source: string, scope: PiPackagePluginScope): PiPackagePluginInfo | undefined {
  const normalized = source.trim();
  const withoutNpmPrefix = normalized.startsWith("npm:") ? normalized.slice(4) : normalized;
  return packages.find((pkg) => pkg.scope === scope && pkg.source === normalized)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source === `npm:${withoutNpmPrefix}`)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.installedPath === normalized)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source.endsWith(normalized));
}

function resourceSummary(pkg: PiPackagePluginInfo): string {
  if (pkg.disabled) return "Disabled";
  const parts = [
    pkg.counts.extensions === 0 ? "" : `${String(pkg.counts.extensions)} ext`,
    pkg.counts.skills === 0 ? "" : `${String(pkg.counts.skills)} skills`,
    pkg.counts.prompts === 0 ? "" : `${String(pkg.counts.prompts)} prompts`,
    pkg.counts.themes === 0 ? "" : `${String(pkg.counts.themes)} themes`,
  ].filter((part) => part !== "");
  return parts.length === 0 ? "No resources" : parts.join(" · ");
}

function versionSummary(pkg: PiPackagePluginInfo): string {
  const parts = [
    pkg.version === undefined ? undefined : `installed ${pkg.version}`,
    pkg.configuredVersion === undefined ? undefined : `configured ${pkg.configuredVersion}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "Unknown" : parts.join(" · ");
}

function statusColor(status: PiPackagePluginInfo["status"]): string {
  if (status === "loaded") return "var(--pi-accent)";
  if (status === "installed") return "#d97706";
  if (status === "disabled") return "var(--pi-muted)";
  return "var(--pi-danger)";
}

function actionMessage(action: Exclude<PiPackagePluginAction, "remove">): string {
  switch (action) {
    case "install": return "Package installed.";
    case "update": return "Package updated.";
    case "disable": return "Package disabled.";
    case "enable": return "Package enabled.";
  }
}

function machineIdFor(machine: unknown): string {
  if (!isRecord(machine)) return "local";
  const id = machine["id"];
  return typeof id === "string" && id !== "" ? id : "local";
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");
}

function formatDiagnostic(diagnostic: PiPackagePluginsResponse["diagnostics"][number]): string {
  return `${diagnostic.type}: ${diagnostic.source === undefined ? "" : `${diagnostic.source}: `}${diagnostic.message}`;
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plusIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function closeIcon() {
  return svg`<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"></path></svg>`;
}
