import { LitElement, css, html, svg } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { Machine, MachineHealth, Project, SessionActivity, SessionInfo, SessionStatus, Workspace, WorkspaceActivity } from "../../api";
import type { WorkspaceLabelItem } from "../../plugins/types";
import type { NavigationSection } from "../../appShell/navigationState";
import { NAVIGATION_SECTION_ORDER } from "../../appShell/navigationState";
import type { KeyboardNavigableSection } from "../navigationFocus";
import "../MachineList";
import "../MachineSwitcher";
import "../ProjectList";
import "../WorkspaceList";
import "../SessionList";

export type NavigationFocusTarget = NavigationSection | "chat";

export const NAVIGATION_RESOURCE_UNDERBAR_ITEMS = [
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
] as const;

type NavigationResourceUnderbarItem = (typeof NAVIGATION_RESOURCE_UNDERBAR_ITEMS)[number];

@customElement("app-navigation-panel")
export class AppNavigationPanel extends LitElement {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selectedMachine?: Machine;
  @property({ attribute: false }) machineStatuses: Record<string, MachineHealth> = {};
  @property({ attribute: false }) machineActivities: Record<string, Record<string, WorkspaceActivity>> = {};
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selectedProject?: Project;
  @property({ attribute: false }) workspaces: Workspace[] = [];
  @property({ attribute: false }) selectedWorkspace?: Workspace;
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) selectedSession?: SessionInfo;
  @property({ attribute: false }) workspaceActivities: Record<string, WorkspaceActivity> = {};
  @property({ attribute: false }) sessionActivities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) sessionStatuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) sendingPrompts: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ attribute: false }) workspacesByProjectId: Record<string, Workspace[]> = {};
  @property({ attribute: false }) deletingWorkspaceIds: string[] = [];
  @property({ attribute: false }) workspaceLabelItems: (workspace: Workspace) => WorkspaceLabelItem[] = () => [];
  @property({ attribute: false }) refreshControl: unknown;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ type: Boolean }) machinesCollapsed = false;
  @property({ type: Boolean }) projectsCollapsed = false;
  @property({ type: Boolean }) workspacesCollapsed = false;
  @property({ type: Boolean }) sessionsCollapsed = false;
  @property({ type: Number }) startingSessionCount = 0;
  @property({ type: Boolean }) canStartSession = false;
  @property({ type: Boolean }) canDeleteArchivedSessions = false;
  @property({ type: Boolean }) canReloadSessions = false;
  @property({ type: Boolean }) canCleanupSessions = false;
  @property({ type: Boolean }) authoritativeSessionPersistence = false;
  @property({ type: String }) archivedDeleteUnavailableMessage = "Update and restart Pi-Web on this machine to delete archived sessions.";
  @property({ type: String }) cleanupUnavailableMessage = "Update and restart Pi-Web on this machine to clean up sessions.";
  @property({ attribute: false }) onShowActions?: () => void;
  @property({ type: Boolean }) skillsEnabled = false;
  @property({ type: Boolean }) pluginsEnabled = false;
  @property({ attribute: false }) onOpenModels?: () => void;
  @property({ attribute: false }) onOpenSkills?: () => void;
  @property({ attribute: false }) onOpenPlugins?: () => void;
  @property({ attribute: false }) onToggleMachines?: () => void;
  @property({ attribute: false }) onToggleProjects?: () => void;
  @property({ attribute: false }) onToggleWorkspaces?: () => void;
  @property({ attribute: false }) onToggleSessions?: () => void;
  @property({ attribute: false }) onAddProject?: () => void;
  @property({ attribute: false }) onSelectProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onCloseProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onSelectWorkspace?: (workspace: Workspace) => void | Promise<void>;
  @property({ attribute: false }) onDeleteWorkspace?: (workspace: Workspace) => void | Promise<void>;
  @property({ attribute: false }) onStartSession?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onRenameSessionStart?: (session: SessionInfo) => void;
  @property({ attribute: false }) onRenameSession?: (session: SessionInfo, name: string) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSessionWithDescendants?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSessions?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onRestoreSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteCachedNewSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedSessions?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onDetachParentSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onReloadSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onCleanupSessions?: () => void | Promise<void>;
  @property({ attribute: false }) onArchivedCollapsed?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onRemoveMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onFocusNavigationTarget?: (target: NavigationFocusTarget) => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;

  @query("machine-list") private machineList?: KeyboardNavigableSection;
  @query("machine-switcher") private machineSwitcher?: KeyboardNavigableSection;
  @query("project-list") private projectList?: KeyboardNavigableSection;
  @query("workspace-list") private workspaceList?: KeyboardNavigableSection;
  @query("session-list") private sessionList?: KeyboardNavigableSection;

  async focusSection(section: NavigationSection): Promise<boolean> {
    await this.updateComplete;
    switch (section) {
      case "machines": return await this.focusNavigableSection(this.compact ? this.machineList : this.machineSwitcher);
      case "projects": return await this.focusNavigableSection(this.projectList);
      case "workspaces": return await this.focusNavigableSection(this.workspaceList);
      case "sessions": return await this.focusNavigableSection(this.sessionList);
    }
  }

  override render() {
    return html`
      <header>
        <strong>PI WEBUI</strong>
        ${shouldShowMachinesSection(this.machines) ? html`
          <machine-switcher
            .machines=${this.machines}
            .selected=${this.selectedMachine}
            .statuses=${this.machineStatuses}
            .activities=${this.machineActivities}
            .onSelect=${(machine: Machine) => this.onSelectMachine?.(machine)}
            .onRemove=${(machine: Machine) => this.onRemoveMachine?.(machine)}
            .onFocusNextSection=${() => { this.focusNextFrom("machines"); }}
            .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
          ></machine-switcher>
        ` : null}
        <div class="header-actions">
          ${this.refreshControl}
          <button title="Show Actions" aria-label="Show Actions" @click=${() => { this.onShowActions?.(); }}>Actions</button>
        </div>
      </header>
      ${this.compact && shouldShowMachinesSection(this.machines) ? html`
        <machine-list
          .machines=${this.machines}
          .selected=${this.selectedMachine}
          .statuses=${this.machineStatuses}
          .activities=${this.machineActivities}
          .collapsible=${this.collapsible}
          .collapsed=${this.machinesCollapsed}
          .onToggleCollapsed=${() => { this.onToggleMachines?.(); }}
          .onSelect=${(machine: Machine) => this.onSelectMachine?.(machine)}
          .onRemove=${(machine: Machine) => this.onRemoveMachine?.(machine)}
          .onFocusNextSection=${() => { this.focusNextFrom("machines"); }}
          .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
        ></machine-list>
      ` : null}
      <project-list
        .projects=${this.projects}
        .selected=${this.selectedProject}
        .activities=${this.workspaceActivities}
        .workspacesByProjectId=${this.workspacesByProjectId}
        .collapsible=${this.collapsible}
        .collapsed=${this.projectsCollapsed}
        .onToggleCollapsed=${() => { this.onToggleProjects?.(); }}
        .onAdd=${() => { this.onAddProject?.(); }}
        .onSelect=${(project: Project) => this.onSelectProject?.(project)}
        .onClose=${(project: Project) => this.onCloseProject?.(project)}
        .onFocusPreviousSection=${() => { this.focusPreviousFrom("projects"); }}
        .onFocusNextSection=${() => { this.focusNextFrom("projects"); }}
        .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
      ></project-list>
      <workspace-list
        .workspaces=${this.workspaces}
        .selected=${this.selectedWorkspace}
        .activities=${this.workspaceActivities}
        .deletingWorkspaceIds=${this.deletingWorkspaceIds}
        .collapsible=${this.collapsible}
        .collapsed=${this.workspacesCollapsed}
        .workspaceLabelItems=${this.workspaceLabelItems}
        .onToggleCollapsed=${() => { this.onToggleWorkspaces?.(); }}
        .onSelect=${(workspace: Workspace) => this.onSelectWorkspace?.(workspace)}
        .onDelete=${(workspace: Workspace) => this.onDeleteWorkspace?.(workspace)}
        .onFocusPreviousSection=${() => { this.focusPreviousFrom("workspaces"); }}
        .onFocusNextSection=${() => { this.focusNextFrom("workspaces"); }}
        .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
      ></workspace-list>
      <session-list
        .sessions=${this.sessions}
        .statuses=${this.sessionStatuses}
        .activities=${this.sessionActivities}
        .sending=${this.sendingPrompts}
        .unreadSessionIds=${this.unreadSessionIds}
        .selected=${this.selectedSession}
        .startingCount=${this.startingSessionCount}
        .canStart=${this.canStartSession}
        .canDeleteArchived=${this.canDeleteArchivedSessions}
        .canReload=${this.canReloadSessions}
        .canCleanup=${this.canCleanupSessions}
        .authoritativeSessionPersistence=${this.authoritativeSessionPersistence}
        .archivedDeleteUnavailableMessage=${this.archivedDeleteUnavailableMessage}
        .cleanupUnavailableMessage=${this.cleanupUnavailableMessage}
        .collapsible=${this.collapsible}
        .collapsed=${this.sessionsCollapsed}
        .onToggleCollapsed=${() => { this.onToggleSessions?.(); }}
        .onArchivedCollapsed=${() => this.onArchivedCollapsed?.()}
        .onStart=${() => this.onStartSession?.()}
        .onSelect=${(session: SessionInfo) => this.onSelectSession?.(session)}
        .onRenameStart=${(session: SessionInfo) => this.onRenameSessionStart?.(session)}
        .onRename=${(session: SessionInfo, name: string) => this.onRenameSession?.(session, name)}
        .onArchive=${(session: SessionInfo) => this.onArchiveSession?.(session)}
        .onArchiveWithDescendants=${(session: SessionInfo) => this.onArchiveSessionWithDescendants?.(session)}
        .onArchiveMany=${(sessions: SessionInfo[]) => this.onArchiveSessions?.(sessions)}
        .onRestore=${(session: SessionInfo) => this.onRestoreSession?.(session)}
        .onDelete=${(session: SessionInfo) => this.onDeleteCachedNewSession?.(session)}
        .onDeleteArchived=${(session: SessionInfo) => this.onDeleteArchivedSession?.(session)}
        .onDeleteArchivedMany=${(sessions: SessionInfo[]) => this.onDeleteArchivedSessions?.(sessions)}
        .onDetachParent=${(session: SessionInfo) => this.onDetachParentSession?.(session)}
        .onReload=${(session: SessionInfo) => this.onReloadSession?.(session)}
        .onCleanup=${() => this.onCleanupSessions?.()}
        .onFocusPreviousSection=${() => { this.focusPreviousFrom("sessions"); }}
        .onFocusNextSection=${() => { this.focusNextFrom("sessions"); }}
        .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
      ></session-list>
      <footer class="resource-underbar" aria-label="Resources">
        ${NAVIGATION_RESOURCE_UNDERBAR_ITEMS.map((item) => renderNavigationResourceUnderbarButton(
          item,
          item.id === "models"
            ? () => { this.onOpenModels?.(); }
            : item.id === "skills"
              ? () => { this.onOpenSkills?.(); }
              : () => { this.onOpenPlugins?.(); },
          this.skillsEnabled,
          this.pluginsEnabled,
        ))}
      </footer>
    `;
  }

  private async focusNavigableSection(section: KeyboardNavigableSection | undefined): Promise<boolean> {
    if (section === undefined) return false;
    return await section.focusSelectedOrFirst();
  }

  private focusPreviousFrom(section: NavigationSection): void {
    const target = previousVisibleNavigationTarget(section, this.machines);
    if (target !== undefined) void this.onFocusNavigationTarget?.(target);
  }

  private focusNextFrom(section: NavigationSection): void {
    void this.onFocusNavigationTarget?.(nextVisibleNavigationTarget(section, this.machines));
  }

  private cancelKeyboardNavigation(): void {
    void this.onCancelKeyboardNavigation?.();
  }

  static override styles = css`
    :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    :host([compact]) { flex: 1 1 auto; }
    header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    header strong { flex: 0 0 auto; }
    machine-switcher { flex: 1 1 auto; min-width: 0; }
    :host([compact]) header { display: none; }
    .header-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
    machine-list, project-list, workspace-list { flex: 0 0 auto; max-height: 26%; min-height: 0; overflow: hidden; border-bottom: 1px solid var(--pi-border-muted); }
    session-list { flex: 1 1 auto; min-height: 0; overflow: hidden; }
    .resource-underbar { flex: 0 0 auto; margin-top: auto; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 7px 8px; border-top: 1px solid var(--pi-border); background: var(--pi-bg); }
    .resource-underbar button { display: flex; align-items: center; justify-content: center; gap: 5px; min-width: 0; padding: 6px 4px; border: 0; border-radius: 6px; background: transparent; color: var(--pi-muted); font: inherit; font-size: 12px; line-height: 18px; opacity: 1; }
    .resource-underbar button:not(:disabled) { cursor: pointer; }
    .resource-underbar button:not(:disabled):hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .resource-underbar button:disabled { color: var(--pi-muted); cursor: default; opacity: 1; }
    .resource-underbar-icon { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    machine-list[collapsed],
    project-list[collapsed],
    workspace-list[collapsed],
    session-list[collapsed] { flex: 0 0 auto; min-height: auto; overflow: hidden; }
    :host([compact]) machine-list,
    :host([compact]) project-list,
    :host([compact]) workspace-list,
    :host([compact]) session-list { flex: 1 1 auto; max-height: none; min-height: 0; overflow: hidden; }
    :host([compact]) machine-list[collapsed],
    :host([compact]) project-list[collapsed],
    :host([compact]) workspace-list[collapsed],
    :host([compact]) session-list[collapsed] { flex: 0 0 auto; min-height: auto; overflow: hidden; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
  `;
}

function renderNavigationResourceUnderbarButton(item: NavigationResourceUnderbarItem, onClick: (() => void) | undefined, skillsEnabled: boolean, pluginsEnabled: boolean) {
  const enabled = navigationResourceUnderbarItemIsEnabled(item.id, skillsEnabled, pluginsEnabled);
  return html`
    <button type="button" ?disabled=${!enabled} title=${item.label} aria-label=${item.label} @click=${onClick}>
      ${renderNavigationResourceUnderbarIcon(item.id)}
      <span>${item.label}</span>
    </button>
  `;
}

export function navigationResourceUnderbarItemIsEnabled(id: NavigationResourceUnderbarItem["id"], skillsEnabled = false, pluginsEnabled = skillsEnabled): boolean {
  return id === "models" || (id === "skills" && skillsEnabled) || (id === "plugins" && pluginsEnabled);
}

function renderNavigationResourceUnderbarIcon(id: NavigationResourceUnderbarItem["id"]) {
  switch (id) {
    case "models":
      return svg`
        <svg class="resource-underbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="4" y="4" width="16" height="16" rx="2"></rect>
          <rect x="9" y="9" width="6" height="6"></rect>
          <path d="M9 1v3m6-3v3M9 20v3m6-3v3M20 9h3m-3 5h3M1 9h3m-3 5h3"></path>
        </svg>
      `;
    case "skills":
      return svg`
        <svg class="resource-underbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m12 2 10 5-10 5L2 7l10-5Z"></path>
          <path d="m2 12 10 5 10-5"></path>
          <path d="m2 17 10 5 10-5"></path>
        </svg>
      `;
    case "plugins":
      return svg`
        <svg class="resource-underbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M9 7V2m6 5V2"></path>
          <path d="M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0Z"></path>
          <path d="M12 19v3"></path>
        </svg>
      `;
  }
}

export function shouldShowMachinesSection(machines: readonly Machine[]): boolean {
  return machines.length > 1;
}

function previousVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[]): NavigationSection | undefined {
  const sections = visibleNavigationSections(machines);
  return sections[sections.indexOf(section) - 1];
}

function nextVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[]): NavigationFocusTarget {
  const sections = visibleNavigationSections(machines);
  return sections[sections.indexOf(section) + 1] ?? "chat";
}

function visibleNavigationSections(machines: readonly Machine[]): NavigationSection[] {
  return NAVIGATION_SECTION_ORDER.filter((section) => section !== "machines" || shouldShowMachinesSection(machines));
}
