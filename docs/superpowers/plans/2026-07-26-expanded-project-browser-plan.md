# Expanded Project Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible in-app Projects modal that shows the complete active-first project list, full paths, live name/path filtering, and existing project actions without changing project-selection behavior.

**Architecture:** Keep application state and navigation in `PiWebUiApp`, add a focused `project-browser-dialog` Lit component for modal-only interaction state, and retain `ProjectList` as the compact sidebar launcher. Move the pure project filtering/ordering projection out of the sidebar component so the sidebar and modal cannot drift in result order.

**Tech Stack:** TypeScript, Lit 3 custom elements, Vitest 4, existing PI WEBUI CSS tokens and component test helpers.

## Global Constraints

- Open an in-app modal/overlay; do not open a separate browser window or tab.
- Show a focused `Search projects` field and filter locally, immediately, and case-insensitively by project name and full path.
- Render complete paths by wrapping them; do not truncate them or create horizontal scrolling.
- Selecting a project must close the modal before using the existing `selectNavigationItem("projects", "workspaces", …)` selection path.
- Preserve active-first ordering, activity indicators, Add project, and per-project Close behavior in the expanded browser.
- Escape, backdrop click, and a labelled close control dismiss the modal. Explicit dismissal restores focus to the expand launcher; selection and Add project do not restore focus to that launcher.
- Use PI WEBUI semantic tokens and inline outline SVGs; add no dependency, API route, storage key, configuration key, URL route, or session-daemon change.
- Keep `README.md` and user documentation unchanged: this intuitive navigation affordance does not alter onboarding or the product’s top-level story.
- Add a patch Changeset; never hand-edit `CHANGELOG.md`.
- Follow TDD: run each new focused test while red before its production implementation, then rerun it green.

---

## File structure

| Path | Change | Responsibility |
| --- | --- | --- |
| `src/client/src/components/projectListProjection.ts` | Create | Pure filter and active-first projection shared by both project browsers. |
| `src/client/src/components/projectListProjection.test.ts` | Create | Direct, deterministic regression tests for the shared projection contract. |
| `src/client/src/components/ProjectList.ts` | Modify | Consume the shared projection and expose the compact-list expand launcher. |
| `src/client/src/components/ProjectList.test.ts` | Modify | Keep sidebar-only menu tests local and prove the launcher callback wiring. |
| `src/client/src/components/ProjectBrowserDialog.ts` | Create | Accessible overlay, local filtering UI, project result rows, actions, and dialog keyboard handling. |
| `src/client/src/components/ProjectBrowserDialog.test.ts` | Create | Narrow component-boundary tests for modal rendering and callbacks. |
| `src/client/src/components/appShell/AppNavigationPanel.ts` | Modify | Forward the launcher callback from `ProjectList` to the app shell. |
| `src/client/src/components/appShell/AppNavigationPanel.test.ts` | Modify | Prove navigation-panel forwarding without a DOM harness. |
| `src/client/src/components/PiWebUiApp.ts` | Modify | Own open state, focus restoration, dialog rendering, chat-obscured state, and existing-selection delegation. |
| `src/client/src/components/PiWebUiApp.modelsConfig.test.ts` | Modify | Prove app-shell open/close/Add/selection wiring using existing template-inspection conventions. |
| `.changeset/expanded-project-browser.md` | Create | Patch release note for the shipped user-visible capability. |

## Task 1: Extract the shared project-list projection

**Files:**
- Create: `src/client/src/components/projectListProjection.ts`
- Create: `src/client/src/components/projectListProjection.test.ts`
- Modify: `src/client/src/components/ProjectList.ts:1-12,51,184-205`
- Modify: `src/client/src/components/ProjectList.test.ts:1-7`

**Interfaces:**
- Consumes: `Project`, `Workspace`, and `WorkspaceActivity` from `src/client/src/api.ts`, plus `projectActivityIndicator()` from `src/client/src/workspaceActivity.ts`.
- Produces:

  ```ts
  export function filterProjects(projects: readonly Project[], queryText: string): Project[];
  export function prioritizeActiveProjects(
    projects: readonly Project[],
    workspacesByProjectId: Record<string, Workspace[]>,
    activities: Record<string, WorkspaceActivity>,
  ): Project[];
  export function displayedProjects(
    projects: readonly Project[],
    queryText: string,
    workspacesByProjectId: Record<string, Workspace[]>,
    activities: Record<string, WorkspaceActivity>,
  ): Project[];
  ```

- Produces for later tasks: `displayedProjects()` is the sole result-list projection used by both `ProjectList` and `ProjectBrowserDialog`.

- [ ] **Step 1: Write the failing projection tests**

  Create `src/client/src/components/projectListProjection.test.ts` before the implementation module exists. Use fixed projects and activities like the current `ProjectList.test.ts` fixtures, and make the contract explicit:

  ```ts
  import { describe, expect, it } from "vitest";
  import type { Project, WorkspaceActivity } from "../api";
  import { displayedProjects, filterProjects, prioritizeActiveProjects } from "./projectListProjection";

  const projects: Project[] = [
    { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-07-26T00:00:00.000Z" },
    { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-07-26T00:00:00.000Z" },
    { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-07-26T00:00:00.000Z" },
  ];

  describe("project list projection", () => {
    it("filters case-insensitively by both name and full path", () => {
      expect(filterProjects(projects, "  CLIENT  ").map((project) => project.id)).toEqual(["client", "docs"]);
    });

    it("keeps active projects first without mutating the incoming list", () => {
      const activities: Record<string, WorkspaceActivity> = {
        "/work/client-app": { cwd: "/work/client-app", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-26T01:00:00.000Z" },
      };

      expect(prioritizeActiveProjects(projects, {}, activities).map((project) => project.id)).toEqual(["client", "server", "docs"]);
      expect(projects.map((project) => project.id)).toEqual(["server", "client", "docs"]);
    });

    it("filters before it applies active-first ordering", () => {
      const activities: Record<string, WorkspaceActivity> = {
        "/work/client-guides": { cwd: "/work/client-guides", hasSessionActivity: false, hasTerminalActivity: true, updatedAt: "2026-07-26T01:00:00.000Z" },
      };

      expect(displayedProjects(projects, "client", {}, activities).map((project) => project.id)).toEqual(["docs", "client"]);
    });
  });
  ```

  Move the existing projection-specific assertions out of `ProjectList.test.ts`; leave its `ProjectList` action-menu and rendering tests in place.

- [ ] **Step 2: Run the new test to verify the red state**

  Run:

  ```bash
  npm test -- --run src/client/src/components/projectListProjection.test.ts
  ```

  Expected: Vitest cannot resolve `./projectListProjection` because the shared module does not exist yet.

- [ ] **Step 3: Implement the pure projection module and switch the sidebar to it**

  Create `projectListProjection.ts` with the exact shared contract. Preserve the stable-partition behavior and do not mutate `projects`:

  ```ts
  import type { Project, Workspace, WorkspaceActivity } from "../api";
  import { projectActivityIndicator } from "../workspaceActivity";

  export function filterProjects(projects: readonly Project[], queryText: string): Project[] {
    const query = queryText.trim().toLowerCase();
    if (query === "") return [...projects];
    return projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query));
  }

  export function prioritizeActiveProjects(
    projects: readonly Project[],
    workspacesByProjectId: Record<string, Workspace[]>,
    activities: Record<string, WorkspaceActivity>,
  ): Project[] {
    const activeProjects: Project[] = [];
    const inactiveProjects: Project[] = [];
    for (const project of projects) {
      const indicator = projectActivityIndicator(project, workspacesByProjectId[project.id] ?? [], activities);
      (indicator === undefined ? inactiveProjects : activeProjects).push(project);
    }
    return [...activeProjects, ...inactiveProjects];
  }

  export function displayedProjects(
    projects: readonly Project[],
    queryText: string,
    workspacesByProjectId: Record<string, Workspace[]>,
    activities: Record<string, WorkspaceActivity>,
  ): Project[] {
    return prioritizeActiveProjects(filterProjects(projects, queryText), workspacesByProjectId, activities);
  }
  ```

  In `ProjectList.ts`, import `displayedProjects` from the new module and remove only the three moved exports. Keep `shouldCloseProjectMenuForOrderChange()` in `ProjectList.ts`, because it remains action-menu-specific. Update the old test imports so projection tests import from `./projectListProjection` and sidebar tests still import `ProjectList` and `shouldCloseProjectMenuForOrderChange` from `./ProjectList`.

- [ ] **Step 4: Run the focused projection and sidebar tests to verify green**

  Run:

  ```bash
  npm test -- --run src/client/src/components/projectListProjection.test.ts src/client/src/components/ProjectList.test.ts
  npm run typecheck
  ```

  Expected: both test files pass, TypeScript finds no stale `ProjectList` projection exports, and the compact sidebar keeps its current active-first behavior.

- [ ] **Step 5: Commit the independently tested refactor**

  ```bash
  git add src/client/src/components/projectListProjection.ts \
    src/client/src/components/projectListProjection.test.ts \
    src/client/src/components/ProjectList.ts \
    src/client/src/components/ProjectList.test.ts
  git commit -m "refactor: share project list projection"
  ```

## Task 2: Build the expanded project-browser dialog

**Files:**
- Create: `src/client/src/components/ProjectBrowserDialog.ts`
- Create: `src/client/src/components/ProjectBrowserDialog.test.ts`

**Interfaces:**
- Consumes: `displayedProjects()` from `./projectListProjection`, `projectActivityIndicator()` from `../workspaceActivity`, `renderActionActivityIndicator()` from `./activityBadge`, `actionMenuPanelStyle()` / `isClickWithinActionMenu()` from `./actionMenu`, and selectable-row helpers from `./selectableRow`.
- Produces the registered custom element and callback boundary:

  ```ts
  @customElement("project-browser-dialog")
  export class ProjectBrowserDialog extends LitElement {
    @property({ attribute: false }) projects: Project[] = [];
    @property({ attribute: false }) selected?: Project;
    @property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
    @property({ attribute: false }) workspacesByProjectId: Record<string, Workspace[]> = {};
    @property({ attribute: false }) onSelect?: (project: Project) => void;
    @property({ attribute: false }) onCloseProject?: (project: Project) => void | Promise<void>;
    @property({ attribute: false }) onAdd?: () => void;
    @property({ attribute: false }) onClose?: () => void;
  }
  ```

- Produces for Task 3: a client-only overlay that delegates all application behavior through callbacks; it never imports `PiWebUiApp`, controllers, or APIs.

- [ ] **Step 1: Write failing modal component tests**

  Create `ProjectBrowserDialog.test.ts` first. Use the repository’s `templateInspection.testSupport` only for callback wiring; use `templateText()` for visible content and a small reflection helper for private keyboard methods. Include these tests:

  ```ts
  import { describe, expect, it, vi } from "vitest";
  import type { Project } from "../api";
  import { templateClickHandlerForText, templateText } from "../templateInspection.testSupport";
  import { ProjectBrowserDialog } from "./ProjectBrowserDialog";

  const projects: Project[] = [
    { id: "server", name: "Server Console", path: "/very/long/path/to/server-console", createdAt: "2026-07-26T00:00:00.000Z" },
    { id: "client", name: "Client App", path: "/very/long/path/to/client-app", createdAt: "2026-07-26T00:00:00.000Z" },
  ];

  it("renders a filtered project with its complete path", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    Reflect.set(dialog, "searchQuery", "CLIENT");

    const rendered = templateText(dialog.render());
    expect(rendered).toContain("Client App");
    expect(rendered).toContain("/very/long/path/to/client-app");
    expect(rendered).not.toContain("Server Console");
    expect(ProjectBrowserDialog.styles.cssText).toMatch(/\.project-path\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  });

  it("delegates a selected row through the supplied callback", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;

    templateClickHandlerForText(dialog.render(), "Client App")({ composedPath: () => [] } as unknown as MouseEvent);

    expect(onSelect).toHaveBeenCalledWith(projects[1]);
  });
  ```

  Add explicit tests that set `searchQuery` to an unmatched value and expect `No matching projects.`, invoke the dialog Escape key handler and expect `onClose`, invoke a backdrop target/currentTarget pair and expect `onClose`, and activate the Add action and expect `onAdd`. Assert the rendered static markup includes `role="dialog"`, `aria-modal="true"`, and the labelled close control. Prove initial focus without a DOM harness by installing a fake queried input and calling `firstUpdated()` through a typed reflection helper:

  ```ts
  const dialog = new ProjectBrowserDialog();
  const focus = vi.fn();
  Reflect.set(dialog, "searchInput", { focus });
  const firstUpdated = Reflect.get(dialog, "firstUpdated");
  if (typeof firstUpdated !== "function") throw new Error("Expected ProjectBrowserDialog.firstUpdated");
  firstUpdated.call(dialog);
  expect(focus).toHaveBeenCalledOnce();
  ```

  Add one stale-menu test: set `openMenuProjectId` to an existing project, replace `projects` with a collection that omits it, call `updated(new Map([["projects", projects]]))` through a typed reflection helper, and expect `openMenuProjectId` to become `undefined`.

- [ ] **Step 2: Run the modal test file to verify the red state**

  Run:

  ```bash
  npm test -- --run src/client/src/components/ProjectBrowserDialog.test.ts
  ```

  Expected: Vitest reports that `./ProjectBrowserDialog` cannot yet be resolved.

- [ ] **Step 3: Implement the self-contained dialog**

  Create `ProjectBrowserDialog.ts` with these behaviors:

  ```ts
  @state() private searchQuery = "";
  @state() private openMenuProjectId: string | undefined;
  @state() private menuStyle = "";
  @query(".project-browser-search") private searchInput?: HTMLInputElement;

  override firstUpdated(): void {
    this.searchInput?.focus();
  }

  private get visibleProjects(): Project[] {
    return displayedProjects(this.projects, this.searchQuery, this.workspacesByProjectId, this.activities);
  }

  private close(): void {
    this.openMenuProjectId = undefined;
    this.onClose?.();
  }

  private select(project: Project): void {
    this.openMenuProjectId = undefined;
    this.onSelect?.(project);
  }
  ```

  Render a fixed overlay using a backdrop and a `section` with `role="dialog"`, `aria-modal="true"`, `aria-labelledby="project-browser-title"`, and `tabindex="-1"`. Render a header with title **Projects**, the Add control, and an icon-only close control labelled **Close expanded project browser**. Render the static labelled search input and a vertically scrollable result area.

  Render each result as a keyed selectable row. Reuse `activateSelectableRow()` and `handleSelectableRowKeyboard()` so Enter, Space, and row-navigation behavior stay consistent with the sidebar. Reuse the existing activity-indicator and action-menu helpers. The row’s project path must be rendered as:

  ```ts
  <span class="project-path">${project.path}</span>
  ```

  Style it with `min-width: 0`, `white-space: normal`, and `overflow-wrap: anywhere`; do not apply `text-overflow`, `overflow: hidden`, or `white-space: nowrap` to that path element.

  Reuse the project-close confirmation text from `ProjectList` exactly before calling `onCloseProject`. Keep the dialog open after the callback so reactive project updates can refresh the list. In `updated(changed: PropertyValues<this>)`, clear `openMenuProjectId` when a `projects` update no longer contains that id; never invoke an action for a removed project. Render `No matching projects.` for an active query with no results, and `No projects are open.` plus an Add project button for an empty collection.

  Copy the established `SessionTreeNavigator.trapTabFocus()` approach into a local `trapTabFocus()` method: enumerate enabled buttons, inputs, textareas, and `[tabindex='0']` in `renderRoot`; wrap Tab/Shift+Tab at the ends; fall back to the dialog section if no focusable item exists. In the dialog keydown handler, invoke it for Tab and close on Escape. Register/remove the capture-phase document click listener in `connectedCallback`/`disconnectedCallback` so an open row action menu closes only when the click is outside the menu.

  Use a large bounded desktop dialog such as `width: min(960px, 100%)` and `height: min(760px, 100%)` inside padded `100dvh` backdrop; at `max-width: 760px`, remove the padding, border, and radius so it becomes edge-to-edge. Use only existing `--pi-*` color/shadow/border tokens and visible `:focus-visible` outlines.

- [ ] **Step 4: Run the modal tests to verify green**

  Run:

  ```bash
  npm test -- --run src/client/src/components/ProjectBrowserDialog.test.ts
  npx eslint src/client/src/components/ProjectBrowserDialog.ts src/client/src/components/ProjectBrowserDialog.test.ts
  ```

  Expected: the dialog tests pass; ESLint reports no errors; the component remains independent of APIs/controllers/app-shell state.

- [ ] **Step 5: Commit the dialog and its tests**

  ```bash
  git add src/client/src/components/ProjectBrowserDialog.ts \
    src/client/src/components/ProjectBrowserDialog.test.ts
  git commit -m "feat: add expanded project browser dialog"
  ```

## Task 3: Wire the launcher, overlay state, and existing navigation flow

**Files:**
- Modify: `src/client/src/components/ProjectList.ts:20-28,63-76,120-145,177-183`
- Modify: `src/client/src/components/ProjectList.test.ts:1-7,97-113`
- Modify: `src/client/src/components/appShell/AppNavigationPanel.ts:72-103,148-169`
- Modify: `src/client/src/components/appShell/AppNavigationPanel.test.ts:47-66`
- Modify: `src/client/src/components/PiWebUiApp.ts:66-108,280-312,407-430,1433-1511,2835-2850`
- Modify: `src/client/src/components/PiWebUiApp.modelsConfig.test.ts:13-28,225-270`

**Interfaces:**
- Consumes: `ProjectBrowserDialog` from Task 2 and its exact property/callback interface.
- Produces:

  ```ts
  // ProjectList and AppNavigationPanel callback shape
  onOpenExpanded?: (restoreFocus: () => void) => void;
  onOpenProjectBrowser?: (restoreFocus: () => void) => void;

  // PiWebUiApp private state and operations
  @state() private projectBrowserOpen = false;
  private projectBrowserRestoreFocus: (() => void) | undefined;
  private openProjectBrowser(restoreFocus: () => void): void;
  private closeProjectBrowser(options?: { restoreFocus?: boolean }): void;
  private selectProjectFromBrowser(project: Project): void;
  private addProjectFromBrowser(): void;
  ```

- Produces for Task 4: a complete UI flow with no server or session-daemon changes.

- [ ] **Step 1: Write failing launcher and app-boundary tests**

  Add a sidebar test that proves the new heading icon forwards its callback even when the list is collapsed:

  ```ts
  it("forwards the expanded project browser action from the Projects heading", () => {
    const list = new ProjectList();
    list.collapsed = true;
    const onOpenExpanded = vi.fn();
    list.onOpenExpanded = onOpenExpanded;

    templateEventHandlerNearMarker(list.render(), 'aria-label="Open expanded project browser"')(new Event("click"));

    expect(onOpenExpanded).toHaveBeenCalledOnce();
  });
  ```

  Add an `AppNavigationPanel` test that assigns `onOpenProjectBrowser`, extracts `.onOpenExpanded=` from its rendered `project-list`, invokes it with a no-op restore callback, and expects the panel callback to receive that same callback. Use a local type guard rather than treating this callback as the existing zero-argument navigation callback:

  ```ts
  type ProjectBrowserOpenCallback = (restoreFocus: () => void) => void;

  function projectBrowserOpenCallback(value: unknown): ProjectBrowserOpenCallback {
    if (typeof value !== "function") throw new Error("Expected expanded project browser callback");
    return value as ProjectBrowserOpenCallback;
  }
  ```

  Add these `PiWebUiApp.modelsConfig.test.ts` cases using its existing `createApp`, `renderNavigationPanel`, `renderApp`, and private-method reflection helpers:

  ```ts
  it("opens the expanded project browser and marks chat as obscured", () => {
    const app = createApp();
    const restoreFocus = vi.fn();
    const open = projectBrowserOpenCallback(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".onOpenProjectBrowser=",
    ));

    open(restoreFocus);

    expect(Reflect.get(app, "projectBrowserOpen")).toBe(true);
    expect(isChatObscured(app)).toBe(true);
    expect(templateStrings(renderApp(app)).join("")).toContain("<project-browser-dialog");
  });
  ```

  Add a dismissal test that invokes the dialog’s `.onClose=` callback, awaits `app.updateComplete`, and expects `projectBrowserOpen` to be false and `restoreFocus` to have been called once. Add an Add-project test that invokes `.onAdd=`, expects the browser to be closed and `state.projectDialogOpen` true. Add a selection test that replaces the private `selectNavigationItem` with a `vi.fn` resolving promise, calls `selectProjectFromBrowser`, and asserts the browser flag is already false when that spy runs.

- [ ] **Step 2: Run the changed test files to verify the red state**

  Run:

  ```bash
  npm test -- --run \
    src/client/src/components/ProjectList.test.ts \
    src/client/src/components/appShell/AppNavigationPanel.test.ts \
    src/client/src/components/PiWebUiApp.modelsConfig.test.ts
  ```

  Expected: the new launcher/property markers and `projectBrowserOpen` behavior are absent, so the added assertions fail.

- [ ] **Step 3: Implement callback plumbing and app ownership**

  In `ProjectList.ts`, add the `onOpenExpanded` property and render an inline outline expand SVG button beside the Projects heading. The control must use both title and ARIA label **Open expanded project browser**. Its click handler stops propagation and forwards a focus-restoration closure for its `currentTarget`:

  ```ts
  private openExpandedBrowser(event: MouseEvent): void {
    event.stopPropagation();
    const launcher = event.currentTarget as HTMLButtonElement;
    this.onOpenExpanded?.(() => { launcher.focus(); });
  }
  ```

  Render this button independently of `collapsed` so it remains available while the Projects section is collapsed. Give it the same 30px compact-control footprint as the search button and use a 15px outward-corners outline SVG.

  In `AppNavigationPanel.ts`, declare and forward `onOpenProjectBrowser` without altering any selection callback behavior:

  ```ts
  .onOpenExpanded=${(restoreFocus: () => void) => this.onOpenProjectBrowser?.(restoreFocus)}
  ```

  In `PiWebUiApp.ts`, import `./ProjectBrowserDialog`, add the reactive boolean and non-reactive focus closure, and implement these methods:

  ```ts
  private openProjectBrowser(restoreFocus: () => void): void {
    this.projectBrowserRestoreFocus = restoreFocus;
    this.projectBrowserOpen = true;
  }

  private closeProjectBrowser(options: { restoreFocus?: boolean } = {}): void {
    const restoreFocus = options.restoreFocus === true ? this.projectBrowserRestoreFocus : undefined;
    this.projectBrowserRestoreFocus = undefined;
    this.projectBrowserOpen = false;
    if (restoreFocus !== undefined) void this.updateComplete.then(() => { restoreFocus(); });
  }

  private selectProjectFromBrowser(project: Project): void {
    this.closeProjectBrowser();
    void this.selectNavigationItem("projects", "workspaces", () => this.workspaces.selectProject(project));
  }

  private addProjectFromBrowser(): void {
    this.closeProjectBrowser();
    this.openProjectDialog();
  }
  ```

  Wire `.onOpenProjectBrowser=${(restoreFocus) => this.openProjectBrowser(restoreFocus)}` into `renderNavigationPanel()`. Add `this.projectBrowserOpen` to `isChatObscured()`. Render the dialog beside the existing overlay components with explicit bound callbacks so `PiWebUiApp` remains the state owner:

  ```ts
  <project-browser-dialog
    .projects=${state.projects}
    .selected=${state.selectedProject}
    .activities=${state.workspaceActivities}
    .workspacesByProjectId=${state.workspacesByProjectId}
    .onSelect=${(project: Project) => { this.selectProjectFromBrowser(project); }}
    .onClose=${() => { this.closeProjectBrowser({ restoreFocus: true }); }}
    .onAdd=${() => { this.addProjectFromBrowser(); }}
    .onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}
  ></project-browser-dialog>
  ```

  Do not change `ProjectController`, `WorkspaceController`, API clients, server files, routes, or `src/server/sessiond.ts`.

- [ ] **Step 4: Run the UI boundary tests and static checks to verify green**

  Run:

  ```bash
  npm test -- --run \
    src/client/src/components/projectListProjection.test.ts \
    src/client/src/components/ProjectList.test.ts \
    src/client/src/components/ProjectBrowserDialog.test.ts \
    src/client/src/components/appShell/AppNavigationPanel.test.ts \
    src/client/src/components/PiWebUiApp.modelsConfig.test.ts
  npm run typecheck
  npx eslint \
    src/client/src/components/ProjectList.ts \
    src/client/src/components/ProjectBrowserDialog.ts \
    src/client/src/components/appShell/AppNavigationPanel.ts \
    src/client/src/components/PiWebUiApp.ts
  ```

  Expected: all focused tests pass, `isChatObscured()` is true only while the expanded dialog is present, dismissal restores launcher focus, Add transitions directly to the existing project dialog, and selection delegates through the existing project navigation flow.

- [ ] **Step 5: Commit the wiring change**

  ```bash
  git add src/client/src/components/ProjectList.ts \
    src/client/src/components/ProjectList.test.ts \
    src/client/src/components/appShell/AppNavigationPanel.ts \
    src/client/src/components/appShell/AppNavigationPanel.test.ts \
    src/client/src/components/PiWebUiApp.ts \
    src/client/src/components/PiWebUiApp.modelsConfig.test.ts
  git commit -m "feat: open projects in an expanded browser"
  ```

## Task 4: Record the release note and complete verification

**Files:**
- Create: `.changeset/expanded-project-browser.md`

**Interfaces:**
- Consumes: the completed client-only feature from Tasks 1–3.
- Produces: a patch release note; no `CHANGELOG.md`, README, public API, server, or session-daemon change.

- [ ] **Step 1: Write the patch Changeset**

  Create the exact file contents:

  ```md
  ---
  "@hyperdreamer/pi-webui": patch
  ---

  Add an expanded Projects browser with full paths and live filtering.
  ```

- [ ] **Step 2: Validate the Changeset before committing it**

  Run:

  ```bash
  npm run changelog:status
  git diff --check
  ```

  Expected: Changesets reports a valid pending patch release and `git diff --check` reports no whitespace errors.

- [ ] **Step 3: Run the complete automated verification suite**

  Run:

  ```bash
  npm run verify
  ```

  Expected: typecheck, lint, Knip, and the entire Vitest suite pass. If an unrelated pre-existing failure occurs, record its exact command output and do not mask it with a feature change.

- [ ] **Step 4: Perform the visual and accessibility acceptance check**

  Start or use the existing UI/API development service; do not restart the session daemon because this plan changes only client-side files. At desktop width and a narrow width, verify all of the following in the browser:

  ```text
  1. The Projects heading shows an outward-corners icon with the announced accessible name.
  2. The icon still works while Projects is collapsed.
  3. The modal opens above the normal app without changing the chat/workspace layout.
  4. Search filters by both name and path; a miss shows “No matching projects.”
  5. A deliberately long project path wraps completely with no horizontal scrollbar or clipped suffix.
  6. Enter, Space, Escape, Tab, Shift+Tab, backdrop click, Add, Close project, and the close icon behave as specified.
  7. Selecting a project removes the modal before the normal workspace navigation takes over.
  ```

  When an Argent browser target is available, capture stable full-resolution screenshots of the desktop and narrow modal states and use the screenshot-diff workflow to inspect spacing, wrapping, clipping, contrast, focus visibility, and edge-to-edge narrow layout. Treat the pixel diff as supporting evidence; retain the focused test and accessibility evidence as the behavioral proof.

- [ ] **Step 5: Commit release metadata and verification-ready work**

  ```bash
  git add .changeset/expanded-project-browser.md
  git commit -m "chore: add expanded project browser changeset"
  git status --short
  ```

  Expected: `git status --short` is empty. The implementation is now ready for the Team Leader code-review gate; do not merge, publish, deploy, or run `npm publish`.
