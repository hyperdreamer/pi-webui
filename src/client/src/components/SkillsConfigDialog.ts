import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import {
  skillsConfigApi,
  type Machine,
  type SkillInfo,
  type SkillInstallScope,
  type SkillSearchResult,
  type SkillUpdateResult,
} from "../api";

type SkillsConfigApi = Pick<typeof skillsConfigApi, "list" | "toggle" | "search" | "install" | "check" | "update">;

interface SkillsTarget {
  cwd: string;
  machineId: string;
}

interface SkillGroup {
  label: string;
  skills: SkillInfo[];
}

/**
 * Project-scoped skills.sh discovery and installed-skill management. The dialog
 * owns only browser state; filesystem, lock-file, and command effects remain
 * in the selected machine's session daemon.
 */
@customElement("skills-config-dialog")
export class SkillsConfigDialog extends LitElement {
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ type: String }) cwd = "";
  @property({ attribute: false }) skillsApi: SkillsConfigApi = skillsConfigApi;
  @property({ attribute: false }) onClose?: () => void;

  @state() private skills: SkillInfo[] = [];
  @state() private loading = true;
  @state() private loadError = "";
  @state() private selectedFilePath: string | undefined;
  @state() private togglingPaths: ReadonlySet<string> = new Set();
  @state() private saveError = "";
  @state() private addMode = false;
  @state() private searchQuery = "";
  @state() private searchResults: SkillSearchResult[] = [];
  @state() private searching = false;
  @state() private searchError = "";
  @state() private installingPackage: string | undefined;
  @state() private installError = "";
  @state() private newlyInstalledKeys: ReadonlySet<string> = new Set();
  @state() private installScope: SkillInstallScope = "global";
  @state() private updateStatuses: Record<string, SkillUpdateResult> = {};
  @state() private checkingUpdateKeys: ReadonlySet<string> = new Set();
  @state() private checkingAll = false;
  @state() private updatingKey: string | undefined;
  @state() private updateError = "";

  @query("#skill-search") private searchInput?: HTMLInputElement;

  private loadRequestSequence = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadSkills();
  }

  protected override updated(changed: PropertyValues<this>): void {
    const machineChanged = changed.has("machine") && machineIdFor(changed.get("machine")) !== this.machineId();
    const cwdChanged = changed.has("cwd") && changed.get("cwd") !== this.cwd;
    if (machineChanged || cwdChanged) {
      this.resetForTargetChange();
      if (this.isConnected) void this.loadSkills();
    }
  }

  override render(): TemplateResult {
    const selectedSkill = this.selectedSkill();
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="skills-dialog-title" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header>
            <div class="title-block">
              <h1 id="skills-dialog-title">Skills</h1>
              <span class="target"><code>${shortenPath(this.cwd)}</code> on ${this.machineLabel()}</span>
            </div>
            <button class="icon-button" type="button" title="Close skills configuration" aria-label="Close skills configuration" @click=${() => { this.close(); }}>
              ${closeIcon()}
            </button>
          </header>

          <div class="dialog-body">
            ${this.renderSkillList()}
            <main class="detail-pane">
              ${this.addMode
                ? this.renderAddPanel()
                : this.loading
                  ? null
                  : selectedSkill === undefined
                    ? html`<div class="empty-state">Select a skill</div>`
                    : this.renderSkillDetail(selectedSkill)}
            </main>
          </div>

          ${this.renderFooter()}
        </section>
      </div>
    `;
  }

  private renderSkillList(): TemplateResult {
    return html`
      <aside class="skill-list" aria-label="Installed skills">
        <div class="skill-list-scroll">
          ${this.loading
            ? html`<div class="list-message">Loading...</div>`
            : this.loadError !== ""
              ? html`<div class="list-message error-message">${this.loadError}</div>`
              : this.skills.length === 0
                ? html`<div class="list-message">No skills found</div>`
                : this.skillGroups().map((group) => html`
                  <section class="skill-group" aria-label=${group.label}>
                    <h2>${group.label}</h2>
                    ${group.skills.map((skill) => this.renderSkillListItem(skill))}
                  </section>
                `)}
        </div>
        <div class="skill-list-actions">
          <button class="add-skill" type="button" ?aria-pressed=${this.addMode} @click=${() => { this.openAddMode(); }}>
            ${plusIcon()} Add skill
          </button>
        </div>
      </aside>
    `;
  }

  private renderSkillListItem(skill: SkillInfo): TemplateResult {
    const selected = !this.addMode && skill.filePath === this.selectedFilePath;
    const status = skillUpdateStatus(skill, this.updateStatuses);
    return html`
      <button class="skill-row ${selected ? "selected" : ""}" type="button" @click=${() => { this.selectSkill(skill); }}>
        <span class="skill-indicator ${skill.disableModelInvocation ? "disabled" : ""}" aria-hidden="true"></span>
        <span class="skill-name">${skill.name}</span>
        ${status?.state === "update-available" ? html`<span class="update-available-mark" title="Update available" aria-label="Update available">↑</span>` : null}
      </button>
    `;
  }

  private renderSkillDetail(skill: SkillInfo): TemplateResult {
    const label = skillSourceLabel(skill);
    const key = skillUpdateKey(skill);
    const status = key === undefined ? undefined : this.updateStatuses[key];
    const checking = key !== undefined && this.checkingUpdateKeys.has(key);
    const updating = key !== undefined && this.updatingKey === key;
    const enabled = !skill.disableModelInvocation;
    return html`
      <div class="detail-content">
        <div class="skill-meta-row">
          <span class="scope-tag ${label}">${label}</span>
          <code class="skill-path" title=${skill.filePath}>${displaySkillPath(skill, this.cwd)}</code>
          <button
            class="skill-toggle ${enabled ? "enabled" : ""}"
            type="button"
            role="switch"
            aria-checked=${String(enabled)}
            aria-label=${enabled ? "Disable skill model invocation" : "Enable skill model invocation"}
            title=${enabled ? "Visible in model prompt — click to disable" : "Hidden from model prompt — click to enable"}
            ?disabled=${this.togglingPaths.has(skill.filePath)}
            @click=${() => { void this.toggleSkill(skill); }}
          ><span></span></button>
          ${this.saveError !== "" ? html`<span class="inline-error">${this.saveError}</span>` : null}
        </div>

        ${skill.install?.skillsShUrl === undefined ? null : html`
          <section class="detail-section">
            <h2>Source</h2>
            <a class="source-link" href=${skill.install.skillsShUrl} target="_blank" rel="noreferrer" title=${skill.install.skillsShUrl}>
              <code>${withoutProtocol(skill.install.skillsShUrl)} ↗</code>
            </a>
          </section>
        `}

        ${skill.install === undefined ? null : html`
          <section class="detail-section">
            <h2>Version</h2>
            <div class="version-row">
              <code>${shortVersion(status?.currentVersion ?? skill.install.versionHash)}</code>
              ${skill.install.canCheckForUpdates ? html`
                <button type="button" class="secondary compact-button" ?disabled=${checking || updating} @click=${() => { void this.checkForUpdates(skill); }}>
                  ${checking ? "Checking..." : "Check"}
                </button>
              ` : null}
              ${status?.state === "update-available" ? html`<code class="update-version">${shortVersion(status.latestVersion)}</code>` : null}
              ${this.renderUpdateStatus(status, checking)}
              ${status?.state === "update-available" ? html`
                <button type="button" class="primary compact-button" ?disabled=${updating || checking} @click=${() => { void this.updateInstalledSkill(skill); }}>
                  ${updating ? "Updating..." : "Update"}
                </button>
              ` : null}
            </div>
            ${this.updateError !== "" ? html`<span class="field-error">${this.updateError}</span>` : null}
          </section>
        `}

        <section class="detail-section">
          <h2>Name</h2>
          <code class="detail-name">${skill.name}</code>
        </section>

        <section class="detail-section">
          <h2>Description</h2>
          <p>${skill.description}</p>
        </section>
      </div>
    `;
  }

  private renderUpdateStatus(status: SkillUpdateResult | undefined, checking: boolean): TemplateResult | null {
    if (!checking && (status === undefined || status.state === "update-available")) return null;
    const label = checking
      ? "Checking..."
      : status?.state === "up-to-date"
        ? "Up to date"
        : status?.state === "unsupported"
          ? "Automatic checks unavailable"
          : status?.message ?? "Check failed";
    const state = checking ? "checking" : status?.state ?? "error";
    return html`<span class="update-state ${state}">${label}</span>`;
  }

  private renderAddPanel(): TemplateResult {
    const installPath = this.installScope === "global"
      ? "~/.pi/agent/skills/"
      : `${shortenPath(this.cwd)}/.pi/skills/`;
    return html`
      <div class="detail-content add-panel">
        <div class="add-heading">
          <h2>Add Skill</h2>
          <p>Search skills.sh to discover and install skills for your agent.</p>
        </div>

        <div class="search-row">
          <input
            id="skill-search"
            .value=${this.searchQuery}
            placeholder="e.g. react, testing, deploy"
            @input=${(event: Event) => { this.searchQuery = inputValue(event); }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void this.searchSkills();
              }
            }}
          >
          <button type="button" class="primary" ?disabled=${this.searching || this.searchQuery.trim() === ""} @click=${() => { void this.searchSkills(); }}>
            ${this.searching ? "Searching..." : "Search"}
          </button>
        </div>

        <div class="scope-row">
          <div class="segmented" role="group" aria-label="Skill installation scope">
            ${(["global", "project"] as const).map((scope) => html`
              <button type="button" class=${this.installScope === scope ? "selected" : ""} @click=${() => { this.installScope = scope; }}>${scope}</button>
            `)}
          </div>
          <code class="install-path">→ ${installPath}</code>
        </div>

        ${this.searchError !== "" ? html`<span class="field-error">${this.searchError}</span>` : null}
        ${this.installError !== "" ? html`<span class="field-error install-error">${this.installError}</span>` : null}

        ${this.searchResults.length > 0
          ? html`<div class="search-results">${this.searchResults.map((result) => this.renderSearchResult(result))}</div>`
          : this.searching || this.searchError !== ""
            ? null
            : html`<p class="search-hint">Search <a href="https://skills.sh" target="_blank" rel="noreferrer">skills.sh</a> to discover and install skills for your agent.</p>`}
      </div>
    `;
  }

  private renderSearchResult(result: SkillSearchResult): TemplateResult {
    const installed = this.isInstalled(result.package, this.installScope);
    const installing = this.installingPackage === result.package;
    const parts = splitPackage(result.package);
    return html`
      <article class="search-result">
        <div class="search-result-copy">
          <strong>${parts.skill ?? parts.repository}</strong>
          <div class="search-result-meta">
            <code>${parts.repository}</code>
            ${result.installs === "" ? null : html`<span>${result.installs}</span>`}
            ${result.url === "" ? null : html`<a href=${result.url} target="_blank" rel="noreferrer">skills.sh ↗</a>`}
          </div>
        </div>
        <button
          type="button"
          class="install-button ${installed ? "installed" : ""}"
          ?disabled=${installed || installing || this.installingPackage !== undefined}
          @click=${() => { if (!installed && !installing) void this.installSkill(result.package); }}
        >${installed ? "✓ Installed" : installing ? "Installing..." : "Install"}</button>
      </article>
    `;
  }

  private renderFooter(): TemplateResult {
    const updateCount = Object.values(this.updateStatuses).filter((status) => status.state === "update-available").length;
    const hasInstalledSkills = this.skills.some((skill) => skill.install !== undefined);
    return html`
      <footer>
        <div class="footer-left">
          ${hasInstalledSkills ? html`
            <button type="button" class="secondary" ?disabled=${this.checkingAll || this.updatingKey !== undefined} @click=${() => { void this.checkForUpdates(); }}>
              ${this.checkingAll ? "Checking..." : "Check updates"}
            </button>
          ` : null}
          ${updateCount === 0 ? null : html`<span class="update-count">${String(updateCount)} ${updateCount === 1 ? "update" : "updates"}</span>`}
        </div>
        <button type="button" class="secondary" @click=${() => { this.close(); }}>Close</button>
      </footer>
    `;
  }

  private async loadSkills(): Promise<void> {
    const target = this.target();
    if (target === undefined) {
      this.loading = false;
      this.loadError = "A selected workspace is required to manage skills.";
      return;
    }
    const requestSequence = ++this.loadRequestSequence;
    this.loading = true;
    this.loadError = "";
    try {
      const response = await this.skillsApi.list(target.cwd, target.machineId);
      if (!this.isCurrentTarget(target) || requestSequence !== this.loadRequestSequence) return;
      this.skills = response.skills;
      this.selectedFilePath = selectedSkillPath(this.selectedFilePath, response.skills);
    } catch (error) {
      if (this.isCurrentTarget(target) && requestSequence === this.loadRequestSequence) {
        this.loadError = `Failed to load skills: ${errorMessage(error)}`;
      }
    } finally {
      if (this.isCurrentTarget(target) && requestSequence === this.loadRequestSequence) this.loading = false;
    }
  }

  private async toggleSkill(skill: SkillInfo): Promise<void> {
    const target = this.target();
    if (target === undefined || this.togglingPaths.has(skill.filePath)) return;
    const disableModelInvocation = !skill.disableModelInvocation;
    this.togglingPaths = setWith(this.togglingPaths, skill.filePath);
    this.saveError = "";
    try {
      await this.skillsApi.toggle({ cwd: target.cwd, filePath: skill.filePath, disableModelInvocation }, target.machineId);
      if (!this.isCurrentTarget(target)) return;
      this.skills = this.skills.map((item) => item.filePath === skill.filePath ? { ...item, disableModelInvocation } : item);
    } catch (error) {
      if (this.isCurrentTarget(target)) this.saveError = errorMessage(error);
    } finally {
      if (this.isCurrentTarget(target)) this.togglingPaths = setWithout(this.togglingPaths, skill.filePath);
    }
  }

  private async searchSkills(): Promise<void> {
    const query = this.searchQuery.trim();
    if (query === "" || this.searching) return;
    const machineId = this.machineId();
    this.searching = true;
    this.searchError = "";
    this.searchResults = [];
    try {
      const response = await this.skillsApi.search({ query }, machineId);
      if (machineId !== this.machineId()) return;
      this.searchResults = response.results;
      if (response.results.length === 0) this.searchError = "No skills found";
    } catch (error) {
      if (machineId === this.machineId()) this.searchError = errorMessage(error);
    } finally {
      if (machineId === this.machineId()) this.searching = false;
    }
  }

  private async installSkill(packageName: string): Promise<void> {
    const target = this.target();
    if (target === undefined || this.installingPackage !== undefined) return;
    const scope = this.installScope;
    this.installingPackage = packageName;
    this.installError = "";
    try {
      await this.skillsApi.install({ cwd: target.cwd, package: packageName, scope }, target.machineId);
      if (!this.isCurrentTarget(target)) return;
      this.newlyInstalledKeys = setWith(this.newlyInstalledKeys, installKey(scope, packageName));
      await this.loadSkills();
    } catch (error) {
      if (this.isCurrentTarget(target)) this.installError = errorMessage(error);
    } finally {
      if (this.isCurrentTarget(target)) this.installingPackage = undefined;
    }
  }

  private async checkForUpdates(skill?: SkillInfo): Promise<void> {
    const target = this.target();
    if (target === undefined) return;
    const targets = skill === undefined ? this.skills.filter((item) => item.install !== undefined) : [skill];
    const keys = targets.flatMap((item) => {
      const key = skillUpdateKey(item);
      return key === undefined ? [] : [key];
    });
    if (keys.length === 0) return;

    this.updateError = "";
    this.checkingUpdateKeys = setWithMany(this.checkingUpdateKeys, keys);
    if (skill === undefined) this.checkingAll = true;
    try {
      const install = skill?.install;
      const response = await this.skillsApi.check(
        install === undefined
          ? { cwd: target.cwd }
          : { cwd: target.cwd, package: install.package, scope: install.scope },
        target.machineId,
      );
      if (!this.isCurrentTarget(target)) return;
      const next = { ...this.updateStatuses };
      for (const update of response.updates) next[`${update.scope}\0${update.package}`] = update;
      this.updateStatuses = next;
    } catch (error) {
      if (this.isCurrentTarget(target)) this.updateError = errorMessage(error);
    } finally {
      if (this.isCurrentTarget(target)) {
        this.checkingUpdateKeys = setWithoutMany(this.checkingUpdateKeys, keys);
        if (skill === undefined) this.checkingAll = false;
      }
    }
  }

  private async updateInstalledSkill(skill: SkillInfo): Promise<void> {
    const target = this.target();
    const install = skill.install;
    const key = skillUpdateKey(skill);
    if (target === undefined || install === undefined || key === undefined || this.updatingKey !== undefined) return;

    this.updatingKey = key;
    this.updateError = "";
    try {
      const response = await this.skillsApi.update({
        cwd: target.cwd,
        package: install.package,
        scope: install.scope,
      }, target.machineId);
      if (!this.isCurrentTarget(target)) return;
      await this.loadSkills();
      if (!this.isCurrentTarget(target)) return;
      const versionHash = response.skill?.install?.versionHash;
      this.updateStatuses = {
        ...this.updateStatuses,
        [key]: {
          package: install.package,
          scope: install.scope,
          state: "up-to-date",
          ...(versionHash === undefined ? {} : { currentVersion: versionHash, latestVersion: versionHash }),
        },
      };
    } catch (error) {
      if (this.isCurrentTarget(target)) this.updateError = errorMessage(error);
    } finally {
      if (this.isCurrentTarget(target)) this.updatingKey = undefined;
    }
  }

  private selectSkill(skill: SkillInfo): void {
    this.selectedFilePath = skill.filePath;
    this.addMode = false;
    this.saveError = "";
    this.updateError = "";
  }

  private openAddMode(): void {
    this.addMode = true;
    void this.updateComplete.then(() => { this.searchInput?.focus(); });
  }

  private selectedSkill(): SkillInfo | undefined {
    return this.skills.find((skill) => skill.filePath === this.selectedFilePath);
  }

  private skillGroups(): SkillGroup[] {
    const definitions: readonly { label: string; matches: (skill: SkillInfo) => boolean }[] = [
      { label: "project / skills.sh", matches: (skill) => skillSourceLabel(skill) === "project" && skill.install?.skillsShUrl !== undefined },
      { label: "project", matches: (skill) => skillSourceLabel(skill) === "project" && skill.install?.skillsShUrl === undefined },
      { label: "global / skills.sh", matches: (skill) => skillSourceLabel(skill) === "global" && skill.install?.skillsShUrl !== undefined },
      { label: "global", matches: (skill) => skillSourceLabel(skill) === "global" && skill.install?.skillsShUrl === undefined },
      { label: "path", matches: (skill) => skillSourceLabel(skill) === "path" },
    ];
    return definitions.flatMap((definition) => {
      const skills = this.skills.filter(definition.matches);
      return skills.length === 0 ? [] : [{ label: definition.label, skills }];
    });
  }

  private isInstalled(packageName: string, scope: SkillInstallScope): boolean {
    return this.skills.some((skill) => skill.install?.scope === scope && skill.install.package === packageName)
      || this.newlyInstalledKeys.has(installKey(scope, packageName));
  }

  private target(): SkillsTarget | undefined {
    return this.cwd === "" ? undefined : { cwd: this.cwd, machineId: this.machineId() };
  }

  private isCurrentTarget(target: SkillsTarget): boolean {
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
    this.skills = [];
    this.loading = true;
    this.loadError = "";
    this.selectedFilePath = undefined;
    this.togglingPaths = new Set();
    this.saveError = "";
    this.addMode = false;
    this.searchQuery = "";
    this.searchResults = [];
    this.searching = false;
    this.searchError = "";
    this.installingPackage = undefined;
    this.installError = "";
    this.newlyInstalledKeys = new Set();
    this.installScope = "global";
    this.updateStatuses = {};
    this.checkingUpdateKeys = new Set();
    this.checkingAll = false;
    this.updatingKey = undefined;
    this.updateError = "";
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 9; display: block; color: var(--pi-text); }
    .backdrop { position: absolute; inset: 0; display: grid; place-items: center; box-sizing: border-box; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--pi-overlay); }
    .dialog { width: min(860px, 100%); height: min(78dvh, 760px); max-height: 100%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); }
    header, footer { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--pi-border); }
    footer { min-height: 50px; border-top: 1px solid var(--pi-border); border-bottom: 0; }
    .title-block { display: grid; min-width: 0; gap: 3px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 16px; line-height: 1.25; }
    h2 { color: var(--pi-text-secondary); font-size: 12px; font-weight: 650; }
    .target { overflow: hidden; color: var(--pi-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; font-size: 12px; line-height: 1.2; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--pi-accent-border); background: var(--pi-selection-bg); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    button:disabled { cursor: wait; opacity: .55; }
    button.primary { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); font-weight: 700; }
    button.secondary { background: var(--pi-surface); }
    .icon-button { display: grid; width: 30px; height: 30px; place-items: center; padding: 0; }
    .dialog-body { display: flex; flex: 1 1 auto; min-height: 0; overflow: hidden; }
    .skill-list { display: flex; flex: 0 0 210px; min-width: 0; flex-direction: column; border-right: 1px solid var(--pi-border); background: var(--pi-surface); }
    .skill-list-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 6px; }
    .skill-group { margin-bottom: 6px; }
    .skill-group h2 { padding: 4px 8px 3px; color: var(--pi-muted); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    .skill-row { display: flex; width: 100%; min-width: 0; align-items: center; gap: 7px; border: 0; border-radius: 5px; background: transparent; color: var(--pi-text); padding: 8px; text-align: left; }
    .skill-row:hover:not(:disabled) { border-color: transparent; background: var(--pi-selection-bg); }
    .skill-row.selected { background: var(--pi-selection-bg); font-weight: 700; }
    .skill-indicator { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--pi-accent); box-shadow: 0 0 4px var(--pi-accent); }
    .skill-indicator.disabled { background: var(--pi-border); box-shadow: none; }
    .skill-name { flex: 1 1 auto; min-width: 0; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .skill-row:has(.skill-indicator.disabled) .skill-name { color: var(--pi-muted); }
    .update-available-mark, .update-count, .update-version { color: #d97706; }
    .update-available-mark { flex: 0 0 auto; font-size: 13px; line-height: 1; }
    .list-message { padding: 10px 8px; color: var(--pi-muted); font-size: 12px; }
    .error-message, .field-error, .inline-error { color: var(--pi-danger); }
    .skill-list-actions { flex: 0 0 auto; padding: 8px 6px; border-top: 1px solid var(--pi-border); }
    .add-skill { display: flex; width: 100%; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--pi-muted); padding: 7px 8px; text-align: left; }
    .add-skill[aria-pressed="true"] { background: var(--pi-selection-bg); color: var(--pi-accent); }
    .detail-pane { flex: 1 1 auto; min-width: 0; overflow: auto; }
    .detail-content { display: grid; box-sizing: border-box; max-width: 650px; gap: 20px; margin: 0 auto; padding: 20px; }
    .skill-meta-row { display: flex; min-width: 0; align-items: center; gap: 7px; }
    .scope-tag { flex: 0 0 auto; border-radius: 3px; background: var(--pi-border-muted); color: var(--pi-muted); padding: 1px 5px; font-size: 10px; }
    .scope-tag.project { background: var(--pi-selection-bg); color: var(--pi-accent); }
    .skill-path { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--pi-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .skill-toggle { position: relative; flex: 0 0 auto; width: 40px; height: 22px; border: 0; border-radius: 11px; background: var(--pi-border); padding: 0; }
    .skill-toggle.enabled { background: var(--pi-accent); }
    .skill-toggle span { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--pi-bg); box-shadow: 0 1px 4px rgb(0 0 0 / 22%); transition: left .18s cubic-bezier(.4, 0, .2, 1); }
    .skill-toggle.enabled span { left: 21px; }
    .inline-error { flex: 0 1 auto; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .detail-section { display: grid; gap: 6px; }
    .detail-section p { color: var(--pi-text-secondary); font-size: 14px; line-height: 1.6; white-space: pre-wrap; }
    .detail-name { color: var(--pi-text); font-size: 14px; }
    .source-link { width: fit-content; max-width: 100%; overflow: hidden; color: var(--pi-accent); text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
    .source-link:hover { text-decoration: underline; }
    .version-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; color: var(--pi-muted); font-size: 12px; }
    .compact-button { padding: 4px 9px; font-size: 11px; }
    .update-state { font-size: 12px; }
    .update-state.checking { color: var(--pi-accent); }
    .update-state.up-to-date { color: var(--pi-success); }
    .update-state.error { color: var(--pi-danger); }
    .update-state.unsupported { color: var(--pi-muted); }
    .field-error { overflow-wrap: anywhere; font-size: 12px; line-height: 1.45; }
    .add-panel { min-height: 0; }
    .add-heading { display: grid; gap: 5px; }
    .add-heading h2 { color: var(--pi-text); font-size: 14px; }
    .add-heading p, .search-hint { color: var(--pi-muted); font-size: 13px; line-height: 1.6; }
    .search-hint a, .search-result-meta a { color: var(--pi-accent); text-decoration: none; }
    .search-hint a:hover, .search-result-meta a:hover { text-decoration: underline; }
    .search-row { display: flex; gap: 8px; }
    .search-row input { box-sizing: border-box; flex: 1 1 auto; min-width: 0; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 10px; font: inherit; font-size: 13px; }
    .scope-row { display: flex; min-width: 0; align-items: center; gap: 10px; }
    .segmented { display: flex; flex: 0 0 auto; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 5px; }
    .segmented button { border: 0; border-right: 1px solid var(--pi-border); border-radius: 0; background: var(--pi-bg); color: var(--pi-muted); padding: 4px 10px; font-size: 12px; }
    .segmented button:last-child { border-right: 0; }
    .segmented button.selected { background: var(--pi-selection-bg); color: var(--pi-text); font-weight: 700; }
    .install-path { min-width: 0; overflow: hidden; color: var(--pi-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .install-error { word-break: break-word; }
    .search-results { overflow: auto; }
    .search-result { display: flex; align-items: center; gap: 14px; border-bottom: 1px solid var(--pi-border); padding: 12px 0; }
    .search-result-copy { flex: 1 1 auto; min-width: 0; }
    .search-result-copy strong { display: block; overflow: hidden; color: var(--pi-text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .search-result-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 3px; color: var(--pi-muted); font-size: 12px; }
    .search-result-meta code { color: var(--pi-muted); font-size: 11px; }
    .install-button { flex: 0 0 auto; padding: 5px 14px; color: var(--pi-text-secondary); }
    .install-button.installed { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
    .footer-left { display: flex; flex: 1 1 auto; min-width: 0; align-items: center; gap: 10px; }
    .empty-state { display: grid; min-height: 180px; height: 100%; place-content: center; box-sizing: border-box; padding: 24px; color: var(--pi-muted); font-size: 13px; text-align: center; }
    .svg-icon { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (max-width: 700px) {
      .backdrop { padding: 8px; }
      .dialog { width: 100%; height: calc(100dvh - 16px); border-radius: 7px; }
      header, footer { padding: 10px 12px; }
      .dialog-body { flex-direction: column; }
      .skill-list { flex: 0 0 auto; max-height: 40%; border-right: 0; border-bottom: 1px solid var(--pi-border); }
      .detail-content { gap: 16px; padding: 14px; }
      .skill-meta-row { flex-wrap: wrap; }
      .skill-path { min-width: 120px; }
      .inline-error { flex-basis: 100%; }
      .scope-row { align-items: flex-start; flex-direction: column; gap: 6px; }
      .search-result { align-items: flex-start; }
    }
  `;
}

function machineIdFor(machine: unknown): string {
  if (!isRecord(machine)) return "local";
  const id = machine["id"];
  return typeof id === "string" && id !== "" ? id : "local";
}

function selectedSkillPath(current: string | undefined, skills: readonly SkillInfo[]): string | undefined {
  if (current !== undefined && skills.some((skill) => skill.filePath === current)) return current;
  return skills[0]?.filePath;
}

function skillSourceLabel(skill: SkillInfo): "global" | "project" | "path" {
  const source = skill.sourceInfo.source;
  const scope = skill.sourceInfo.scope;
  if (scope === "user" || source === "user") return "global";
  if (scope === "project" || source === "project") return "project";
  return "path";
}

function displaySkillPath(skill: SkillInfo, cwd: string): string {
  if (skillSourceLabel(skill) === "project" && skill.filePath.startsWith(cwd)) {
    const relative = skill.filePath.slice(cwd.length).replace(/^[/\\]/u, "");
    return `./${relative}`;
  }
  return shortenPath(skill.filePath);
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");
}

function withoutProtocol(value: string): string {
  return value.replace(/^https?:\/\//u, "");
}

function shortVersion(value: string | undefined): string {
  return value === undefined || value === "" ? "unknown" : value.slice(0, 8);
}

function skillUpdateKey(skill: SkillInfo): string | undefined {
  return skill.install === undefined ? undefined : `${skill.install.scope}\0${skill.install.package}`;
}

function skillUpdateStatus(skill: SkillInfo, statuses: Readonly<Record<string, SkillUpdateResult>>): SkillUpdateResult | undefined {
  const key = skillUpdateKey(skill);
  return key === undefined ? undefined : statuses[key];
}

function installKey(scope: SkillInstallScope, packageName: string): string {
  return `${scope}\0${packageName}`;
}

function splitPackage(packageName: string): { repository: string; skill: string | undefined } {
  const at = packageName.lastIndexOf("@");
  return at < 0
    ? { repository: packageName, skill: undefined }
    : { repository: packageName.slice(0, at), skill: packageName.slice(at + 1) };
}

function setWith(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  return new Set([...values, value]);
}

function setWithMany(values: ReadonlySet<string>, additions: readonly string[]): ReadonlySet<string> {
  return new Set([...values, ...additions]);
}

function setWithout(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  next.delete(value);
  return next;
}

function setWithoutMany(values: ReadonlySet<string>, removals: readonly string[]): ReadonlySet<string> {
  const next = new Set(values);
  for (const value of removals) next.delete(value);
  return next;
}

function inputValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ? target.value : "";
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
