# Plugin Activity Rail Contributions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let enabled PI WEBUI browser plugins contribute circular Activity Rail controls that open host-managed detail dialogs, make the Rail available through a default-closed compact drawer below the desktop breakpoint, and move bundled Memory from a workspace tab to a Rail activity.

**Architecture:** Add an additive v1 `activityRailItems` contribution and capability handshake to the plugin registry. Keep plugin lifecycle, visibility, ordering, machine scoping, safe callback evaluation, dialog lifecycle, and responsive Rail placement in focused client modules; plugins provide only icon/body callbacks. `PiWebUiApp` composes those modules, supplies scoped context, owns one active activity and compact-drawer state, and continues to own Memory polling.

**Tech Stack:** TypeScript, Lit, Vitest, npm, Changesets.

## Global Constraints

- Keep `PiWebUiPlugin.apiVersion` at `1`; add `PluginActivationContext.capabilities?.activityRailItems === true` as the additive host feature signal.
- Preserve existing `actions`, `workspacePanels`, `workspaceLabels`, themes, theme pairs, remote-plugin behavior, and saved `pi-webui:activity-rail-order` data exactly.
- Plugin Rail icons are required-icon, neutral, circular, non-draggable items in a dedicated section after the reorderable core controls; sort by `order ?? 1000`, title, then qualified id.
- Settings remains fixed after the Rail spacer. Do not persist plugin ordering or compact-drawer state.
- At every width below `(min-width: 1181px)`, expose the same Rail from a default-closed overlay drawer; selecting any Rail item closes the drawer before opening the next surface.
- The host owns dialog header/chrome, accessibility, close paths, focus restoration, render-error containment, and plugin callback error logging. Plugins own only the body and may call `context.host.close()`.
- `ActivityRailContext` is app-wide and supplies `machine`, optional `workspaceScope`, `requestRender()`, and `close()` without exposing private app state beyond the documented plugin runtime surface.
- Memory is Rail-only in the new host. It is hidden without a selected workspace or when support is confirmed unavailable; its current loading, badge, retry, polling, and selected-machine behavior remain intact.
- Do not modify `src/server/sessiond.ts`, session ownership, session-daemon protocol, server routes, or memory mutation behavior. No manual session-daemon restart is required.
- Update both `docs/plugins.md` and `docs/plugins.html`; keep `README.md` unchanged. Add a patch Changeset and do not edit `CHANGELOG.md`.
- Follow TDD at each behavior seam. Run focused tests before broader checks. Do not stage or commit unrelated working-tree changes.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/client/src/plugins/types.ts` | Internal contribution, capability, context, qualified-contribution, and scoped-context types. |
| `src/plugin-api.ts` | Published declaration source matching the stable public Activity Rail contract. |
| `src/client/src/plugins/registry.ts` | Registration, qualification, selected-machine scoping, and activation capability delivery for activity contributions. |
| `src/client/src/plugins/registry.test.ts` | Registry contract coverage for activity contribution ids, ordering, context scoping, capabilities, and remote behavior. |
| `src/client/src/plugins/activityRail.ts` | Pure, injected-error-reporter projection of visible activity contributions and safe body rendering. |
| `src/client/src/plugins/activityRail.test.ts` | Focused safe-visibility, badge, ordering, and render-failure tests. |
| `src/client/src/components/PluginActivityDialog.ts` | Reusable host-owned activity dialog with accessibility, close behavior, and scoped render failure state. |
| `src/client/src/components/PluginActivityDialog.test.ts` | Dialog template/event/focus behavior tests. |
| `src/client/src/appShell/appShellController.ts` | Reactive desktop-Rail media signal shared by compact launcher and Rail presentation. |
| `src/client/src/appShell/appShellController.test.ts` | Desktop-Rail media transition and controller cleanup tests. |
| `src/client/src/components/ActivityRail.ts` | Core Rail plus resolved plugin controls and responsive compact drawer presentation. |
| `src/client/src/components/ActivityRail.test.ts` | Core-drag preservation, plugin-circle, badge, compact drawer, and callback tests. |
| `src/client/src/components/appShell/AppContextBar.ts` | Compact Rail launcher in the context action area. |
| `src/client/src/components/appShell/AppContextBar.test.ts` | Launcher visibility, label, and callback wiring tests. |
| `src/client/src/components/PiWebUiApp.ts` | Context factory, active activity/drawer state, focus restoration, rendering, compact launcher wiring, and Memory polling observation. |
| `src/client/src/components/PiWebUiApp.activityRail.test.ts` | App-level context, selected-machine, drawer-to-dialog, unavailable-close, and focus-restoration behavior. |
| `src/client/src/components/PiWebUiApp.memory.test.ts` | Memory polling migration from workspace panel observation to activity-Rail observation. |
| `pi-webui-plugins/workspace-memory/pi-webui-plugin.ts` | Bundled Memory activity contribution. |
| `pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts` | Memory activity contract, visibility, badge, brain icon, and removed-panel regression coverage. |
| `docs/plugins.md` and `docs/plugins.html` | Synchronized public documentation and Memory behavior explanation. |
| `.changeset/plugin-activity-rail.md` | Patch-level release note. |

## Task 1: Add additive activity-Rail plugin types and registry support

**Files:**
- Modify: `src/client/src/plugins/types.ts`
- Modify: `src/plugin-api.ts`
- Modify: `src/client/src/plugins/registry.ts`
- Modify: `src/client/src/plugins/registry.test.ts`

**Interfaces:**
- Produces `PluginHostCapabilities`, `ActivityRailContribution`, `ActivityRailContext`, `ActivityRailWorkspaceScope`, `ActivityRailHost`, `QualifiedActivityRailContribution`, and `PluginRegistry.getActivityRailItems()`.
- Produces `installActivityRailScope(context, scope)` so qualified callbacks receive the plugin-origin context just as workspace panels do.
- Consumed by Tasks 2–6.

- [ ] **Step 1: Add failing registry tests for activation capability, qualification, sort order, and selected-machine scoping.**

Add an `ActivityRailContext` test fixture beside `createWorkspacePanelContext()` in `src/client/src/plugins/registry.test.ts`. Give it a local machine, no workspace scope, a `host` with `requestRender` and `close` spies, and the existing runtime-context action helpers.

Add this test and use a second remote registration in the same describe block:

```ts
it("qualifies activity Rail items, passes the host capability, and scopes remote items", () => {
  const registry = new PluginRegistry();
  let capability: boolean | undefined;
  registry.register({
    id: "example",
    plugin: {
      apiVersion: 1,
      name: "Example",
      activate: (context) => {
        capability = context.capabilities?.activityRailItems;
        return {
          contributions: {
            activityRailItems: [
              { id: "late", title: "Zulu", icon: html`<svg></svg>`, order: 20, render: () => html`<p>Zulu</p>` },
              { id: "early", title: "Alpha", icon: html`<svg></svg>`, order: 10, render: () => html`<p>Alpha</p>` },
            ],
          },
        };
      },
    },
  });

  expect(capability).toBe(true);
  expect(registry.getActivityRailItems().map((item) => item.id)).toEqual([
    "example:early",
    "example:late",
  ]);
});
```

Also register `machineScopedPluginId("remote-1", "example")` with an `activityRailItems` entry. Assert its wrapped `visible()` is `false` for a local context and `true` for a `remote-1` context, matching existing workspace-panel machine tests.

- [ ] **Step 2: Run the focused registry test and verify it fails because activity-Rail types and registry methods do not exist.**

Run:

```bash
npm test -- --run src/client/src/plugins/registry.test.ts
```

Expected: TypeScript/Vitest failure mentioning `activityRailItems`, `capabilities`, `ActivityRailContext`, or `getActivityRailItems`.

- [ ] **Step 3: Add matching internal and public v1 types.**

In both `src/client/src/plugins/types.ts` and `src/plugin-api.ts`, add these names with the same stable public shape:

```ts
export interface PluginHostCapabilities {
  activityRailItems?: true;
}

export interface ActivityRailHost {
  requestRender(): void;
  close(): void;
}

export interface ActivityRailWorkspaceScope {
  workspace: Workspace;
  files: WorkspaceFiles;
  terminal: WorkspacePanelTerminal;
}

export interface ActivityRailContext extends PluginRuntimeContext {
  machine: PluginMachine;
  workspaceScope?: ActivityRailWorkspaceScope;
  host: ActivityRailHost;
}

export interface ActivityRailContribution {
  id: LocalContributionId;
  title: string;
  icon: TemplateResult;
  order?: number;
  visible?: (context: ActivityRailContext) => boolean;
  badge?: (context: ActivityRailContext) => string | number | TemplateResult | undefined;
  render: (context: ActivityRailContext) => TemplateResult;
}
```

Add `capabilities?: PluginHostCapabilities` to `PluginActivationContext`, `activityRailItems?: ActivityRailContribution[]` to `PluginContributions`, and an internal `QualifiedActivityRailContribution` equivalent to `QualifiedWorkspacePanelContribution` with `id`, `pluginId`, `localId`, optional `machineId`, and optional `sourcePluginId`.

- [ ] **Step 4: Extend `PluginRegistry` without changing existing contribution behavior.**

Add an `activityRailItems` collection and process it in `register()` immediately after workspace panels:

```ts
for (const item of contributions.activityRailItems ?? []) {
  this.activityRailItems.push(this.qualifyActivityRailItem(id, item, registration.machineId, registration.sourcePluginId));
}
```

Pass the additive capability during activation:

```ts
const result = plugin.activate({
  apiVersion: 1,
  pluginId: id,
  html,
  svg,
  capabilities: { activityRailItems: true },
});
```

Implement `getActivityRailItems()` using exactly this comparator:

```ts
return [...this.activityRailItems].sort((left, right) =>
  (left.order ?? 1000) - (right.order ?? 1000)
  || left.title.localeCompare(right.title)
  || left.id.localeCompare(right.id),
);
```

Mirror `qualifyWorkspacePanel()` for `qualifyActivityRailItem()`: qualify the id, preserve metadata, gate `visible`, `badge`, and `render` with `isContributionActive()`, and send callbacks the plugin-scoped context. Add an `activityRailScopes` `WeakMap`, `activityRailContextFor()`, and this generic scope helper so app-only context extensions retain their type:

```ts
export function installActivityRailScope<T extends ActivityRailContext>(
  context: T,
  scope: (pluginId: string) => T,
): T {
  activityRailScopes.set(context, scope);
  return context;
}
```

- [ ] **Step 5: Add a capability-free fallback regression test.**

In `registry.test.ts`, create a plugin whose `activate()` returns `activityRailItems` only when `context.capabilities?.activityRailItems === true`, otherwise returns one workspace panel. Invoke its `activate()` directly with a context that omits `capabilities` and assert it returns the workspace panel. Register it through `PluginRegistry` and assert it returns the activity item. This proves external plugin authors can branch safely without raising `apiVersion`.

- [ ] **Step 6: Run focused tests and public declaration build.**

Run:

```bash
npm test -- --run src/client/src/plugins/registry.test.ts
npm run typecheck
npm run build:plugin-api
```

Expected: all commands exit successfully. The declaration build must expose the new stable public names from `src/plugin-api.ts`; do not hand-edit generated `dist` output.

- [ ] **Step 7: Commit the independently verified registry contract.**

```bash
git add src/client/src/plugins/types.ts src/plugin-api.ts src/client/src/plugins/registry.ts src/client/src/plugins/registry.test.ts
git commit -m "feat(plugins): add activity rail contributions"
```

Expected: the commit contains only activity-Rail type/registry behavior and focused tests.

## Task 2: Isolate safe activity contribution evaluation

**Files:**
- Create: `src/client/src/plugins/activityRail.ts`
- Create: `src/client/src/plugins/activityRail.test.ts`

**Interfaces:**
- Consumes `ActivityRailContext` and `QualifiedActivityRailContribution` from Task 1.
- Produces `ActivityRailDisplayItem`, `visibleActivityRailItems()`, and `renderActivityRailBody()` for Tasks 3 and 5.

- [ ] **Step 1: Write failing pure tests for visible/badge/render failure isolation.**

Create `src/client/src/plugins/activityRail.test.ts` with a local `ActivityRailContext` fixture and a `reportError` spy. Test these exact outcomes:

```ts
expect(visibleActivityRailItems([hidden, badgeFailure, visible], context, reportError)
  .map((item) => ({ id: item.id, badge: item.badge })))
  .toEqual([
    { id: "example:badge-failure", badge: undefined },
    { id: "example:visible", badge: 3 },
  ]);

expect(reportError).toHaveBeenCalledWith("badge", "example:badge-failure", expect.any(Error));
expect(reportError).toHaveBeenCalledWith("visible", "example:hidden", expect.any(Error));
expect(renderActivityRailBody(renderFailure, context, reportError)).toBeUndefined();
expect(reportError).toHaveBeenCalledWith("render", "example:render-failure", expect.any(Error));
```

Use a `visible` contribution that throws, a visible contribution with a throwing `badge`, and a contribution with a throwing `render`. Include two equal-order titles/ids to prove the module preserves the registry order it receives rather than re-sorting it.

- [ ] **Step 2: Run the new pure test and verify it fails because the module does not exist.**

Run:

```bash
npm test -- --run src/client/src/plugins/activityRail.test.ts
```

Expected: module-resolution failure for `./activityRail`.

- [ ] **Step 3: Create the focused projection module.**

Implement these exported types and functions:

```ts
export interface ActivityRailDisplayItem {
  id: QualifiedContributionId;
  title: string;
  icon: TemplateResult;
  badge?: string | number | TemplateResult | undefined;
}

export type ActivityRailErrorPhase = "visible" | "badge" | "render";
export type ReportActivityRailError = (
  phase: ActivityRailErrorPhase,
  contributionId: QualifiedContributionId,
  error: unknown,
) => void;
```

`visibleActivityRailItems()` iterates in input order. If `visible()` returns `false`, omit the item. If it throws, call `reportError("visible", id, error)` and omit the item. If `badge()` throws, call `reportError("badge", id, error)` and include the item with no badge. `renderActivityRailBody()` returns the body template, or reports a `render` failure and returns `undefined`.

Do not call `console` in this module; `PiWebUiApp` supplies the reporter so logging remains at the app edge.

- [ ] **Step 4: Run the pure test and typecheck.**

Run:

```bash
npm test -- --run src/client/src/plugins/activityRail.test.ts
npm run typecheck
```

Expected: PASS. The tests prove one faulty plugin callback cannot remove unrelated visible activities or break the host render.

- [ ] **Step 5: Commit the safe evaluation seam.**

```bash
git add src/client/src/plugins/activityRail.ts src/client/src/plugins/activityRail.test.ts
git commit -m "feat(activity-rail): isolate plugin callback failures"
```

Expected: the commit contains only the new pure evaluation module and its focused tests.

## Task 3: Build the host-owned plugin activity dialog

**Files:**
- Create: `src/client/src/components/PluginActivityDialog.ts`
- Create: `src/client/src/components/PluginActivityDialog.test.ts`

**Interfaces:**
- Consumes a resolved `QualifiedActivityRailContribution`, its fresh `ActivityRailContext`, `renderActivityRailBody()`, and a close callback.
- Produces `<plugin-activity-dialog>` with `.activity`, `.context`, `.onClose`, and `.onReportError` properties for Task 5. `PiWebUiApp` remains the single owner of origin-focus restoration.

- [ ] **Step 1: Write failing component-boundary tests for dialog semantics and close paths.**

Create `PluginActivityDialog.test.ts` using the existing `templateInspection.testSupport` helpers. Instantiate the dialog with an activity titled `Memory`, a brain SVG, and `render: () => html`<p>Body</p>``. Assert rendered text contains:

```ts
expect(markup).toContain('role="dialog"');
expect(markup).toContain('aria-modal="true"');
expect(markup).toContain('aria-label="Memory"');
expect(markup).toContain('aria-label="Close Memory"');
expect(markup).toContain("Body");
```

Extract and invoke the close-button, Escape-key, and exact-backdrop handlers. Assert each calls `onClose` once. Add a render-failure case whose contribution `render()` throws `new Error("broken body")`; provide an `onReportError` spy, assert the rendered state contains `This plugin activity could not be rendered.`, assert the close control remains present, and assert the spy receives `"render"`, the qualified id, and that error.

- [ ] **Step 2: Run the focused dialog test and verify it fails because the component does not exist.**

Run:

```bash
npm test -- --run src/client/src/components/PluginActivityDialog.test.ts
```

Expected: module-resolution failure for `./PluginActivityDialog`.

- [ ] **Step 3: Implement the dialog as a thin Lit adapter.**

Create `PluginActivityDialog` with host-owned markup equivalent to:

```ts
<div
  class="plugin-activity-backdrop"
  role="dialog"
  aria-modal="true"
  aria-label=${activity.title}
  @click=${this.handleBackdropClick}
  @keydown=${this.handleKeyDown}
>
  <section class="plugin-activity-frame">
    <header>
      <span class="plugin-activity-icon" aria-hidden="true">${activity.icon}</span>
      <h2>${activity.title}</h2>
      <button type="button" aria-label=${`Close ${activity.title}`} @click=${this.close}>×</button>
    </header>
    <div class="plugin-activity-body">${body ?? this.renderFailure()}</div>
  </section>
</div>
```

Add an `onReportError?: ReportActivityRailError` property and call `renderActivityRailBody(activity, context, this.onReportError ?? defaultReportActivityRailError)`. `defaultReportActivityRailError` must call `console.warn` with the phase and qualified contribution id. The close helper must invoke `onClose`; `PiWebUiApp` performs origin-focus restoration after clearing active state. Add `firstUpdated()` focus to the close button and a small Tab/Shift+Tab focus loop between dialog focusables so keyboard focus remains inside the modal.

- [ ] **Step 4: Run focused dialog tests and inspect styles.**

Run:

```bash
npm test -- --run src/client/src/components/PluginActivityDialog.test.ts
npx eslint src/client/src/components/PluginActivityDialog.ts src/client/src/components/PluginActivityDialog.test.ts
```

Expected: PASS. The CSS keeps the backdrop fixed, body scrollable, dialog large within desktop viewport margins, and compact-width dialog safe within the viewport.

- [ ] **Step 5: Commit the dialog boundary.**

```bash
git add src/client/src/components/PluginActivityDialog.ts src/client/src/components/PluginActivityDialog.test.ts
git commit -m "feat(activity-rail): add plugin activity dialog"
```

Expected: the commit contains the generic dialog and its direct tests, with no Memory-specific rendering.

## Task 4: Extend ActivityRail with circular plugin controls and compact drawer behavior

**Files:**
- Modify: `src/client/src/appShell/appShellController.ts`
- Create: `src/client/src/appShell/appShellController.test.ts`
- Modify: `src/client/src/components/ActivityRail.ts`
- Modify: `src/client/src/components/ActivityRail.test.ts`

**Interfaces:**
- Consumes `ActivityRailDisplayItem` from Task 2 and `AppShellController.isDesktopActivityRailLayout` through the shared desktop-Rail media constant.
- Produces `pluginItems`, `onOpenPluginActivity`, `compactOpen`, and `onCloseCompact` properties while preserving all existing core Rail properties and drag callbacks.
- Produces `ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY` and a reactive `AppShellController.isDesktopActivityRailLayout` signal for Task 5.
- Consumed by Task 5.

- [ ] **Step 1: Add failing desktop-Rail media and component tests.**

Create `src/client/src/appShell/appShellController.test.ts` with an injected `MediaQueryList` fake initially set to `matches: false`. Construct `AppShellController` with a host whose `requestUpdate` is a spy, dispatch a matching change event, and assert `isDesktopActivityRailLayout` becomes `true` and requests an update. Call `hostDisconnected()` and assert the media listener is removed.

In `ActivityRail.test.ts`, set:

```ts
rail.pluginItems = [
  { id: "tasks:open", title: "Tasks", icon: html`<svg data-icon="tasks"></svg>` },
  { id: "memory:open", title: "Memory", icon: html`<svg data-icon="brain"></svg>`, badge: 2 },
];
```

Assert the desktop template places `Open system info` before the plugin separator, `Memory` and `Tasks` before `Open settings`, and marks plugin controls with a stable `plugin-rail-button` class plus circular styling. Assert the Memory accessible label includes `Memory, 2`.

Set the desktop media stub to `matches: false`, leave `compactOpen = false`, and assert no Rail is rendered. Then set `compactOpen = true` and assert the template contains `role="dialog"`, `aria-label="Activity rail"`, the same plugin controls, a close control, and backdrop/Escape handlers. Invoke a plugin click handler and assert `onCloseCompact` runs before `onOpenPluginActivity("memory:open", source)`.

Assert plugin controls have neither `draggable` nor `data-rail-item`; preserve the existing core drag tests unchanged.

- [ ] **Step 2: Run the focused Rail test and verify it fails because the new properties and markup do not exist.**

Run:

```bash
npm test -- --run src/client/src/appShell/appShellController.test.ts
npm test -- --run src/client/src/components/ActivityRail.test.ts
```

Expected: the controller test fails because the desktop-Rail media signal does not exist, and the Rail test fails for missing plugin controls and compact drawer markup.

- [ ] **Step 3: Add the shared desktop-Rail media signal and resolved-plugin display contract.**

In `appShellController.ts`, export `ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY = "(min-width: 1181px)"`. Add an injected-or-browser `activityRailDesktopMedia` field, `isDesktopActivityRailLayout` state, and a change listener that updates the boolean and calls `host.requestUpdate()`. Register and remove the listener alongside the existing mobile-navigation media listener.

Import `ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY` and `ActivityRailDisplayItem` into `ActivityRail.ts`, then add:

```ts
@property({ attribute: false }) pluginItems: readonly ActivityRailDisplayItem[] = [];
@property({ attribute: false }) onOpenPluginActivity?: (id: QualifiedContributionId, source: HTMLElement) => void;
@property({ type: Boolean }) compactOpen = false;
@property({ attribute: false }) onCloseCompact?: () => void;
```

Render core controls exactly as today. Render the separator only when `pluginItems.length > 0`, then map plugin items through one `renderPluginButton()` method. That method must use `type="button"`, `class="icon-button plugin-rail-button"`, a circular frame, host-provided icon, title/badge-aware accessible name, and no drag/drop attributes.

- [ ] **Step 4: Make the existing component responsive rather than introducing a second Rail implementation.**

Use `ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY` for the component’s media query. When it matches, render the docked `<nav>` as today with the plugin section. When it does not match and `compactOpen` is true, render an overlay backdrop containing the same Rail navigation. The overlay must close on exact-backdrop click and Escape, offer a labelled close button, and call `onCloseCompact` before any selected core or plugin action runs. When it does not match and `compactOpen` is false, render nothing.

Use the same `renderRailContents()` helper for docked and drawer variants so ordering, accessibility labels, circular shape, badges, and core controls cannot drift. Change `onDesktopMediaChange` to request a Lit update and call `onCloseCompact` when the media query becomes desktop while the drawer is open; this prevents a stale compact-open state from resurfacing after a resize. Keep all core reorder logic scoped to `ReorderableRailItem` values.

- [ ] **Step 5: Run focused tests, typecheck, and lint.**

Run:

```bash
npm test -- --run src/client/src/appShell/appShellController.test.ts
npm test -- --run src/client/src/components/ActivityRail.test.ts
npm run typecheck
npx eslint src/client/src/appShell/appShellController.ts src/client/src/appShell/appShellController.test.ts src/client/src/components/ActivityRail.ts src/client/src/components/ActivityRail.test.ts
```

Expected: PASS. Existing core order/drag tests and new plugin/drawer tests all pass.

- [ ] **Step 6: Commit the responsive Rail presentation.**

```bash
git add src/client/src/appShell/appShellController.ts src/client/src/appShell/appShellController.test.ts src/client/src/components/ActivityRail.ts src/client/src/components/ActivityRail.test.ts
git commit -m "feat(activity-rail): render plugin controls and compact drawer"
```

Expected: the commit preserves stored core-order behavior and adds no persistence for compact drawer state.

## Task 5: Add the compact launcher and compose activity-Rail behavior in PiWebUiApp

**Files:**
- Modify: `src/client/src/components/appShell/AppContextBar.ts`
- Modify: `src/client/src/components/appShell/AppContextBar.test.ts`
- Modify: `src/client/src/components/PiWebUiApp.ts`
- Create: `src/client/src/components/PiWebUiApp.activityRail.test.ts`

**Interfaces:**
- Consumes Task 1 registry/context APIs, Task 2 safe projection/dialog, and Task 4 Rail properties.
- Produces app-owned `createActivityRailContext()`, active activity state, compact Rail state, focus restoration, and context-bar launcher wiring.
- Consumed by Task 6.

- [ ] **Step 1: Add failing context-bar launcher tests.**

Extend `AppContextBar.test.ts` to instantiate the component, set `onToggleActivityRail`, and inspect the rendered template. Assert a button with `aria-label="Open activity rail"` invokes the callback. Add a second test with `activityRailOpen = true` that asserts its label changes to `Close activity rail`.

- [ ] **Step 2: Add failing app integration tests.**

Create `PiWebUiApp.activityRail.test.ts` using the existing `PiWebUiApp.memory.test.ts` window stubs as the fixture pattern. Register an activity plugin with id `example:dashboard`, set a selected workspace/machine, and assert:

```ts
expect(activityRailItems(app).map((item) => item.id)).toEqual(["example:dashboard"]);
openActivityRailItem(app, "example:dashboard", restoreFocus);
expect(activeActivityId(app)).toBe("example:dashboard");
closeActivityRailItem(app);
expect(restoreFocus).toHaveBeenCalledOnce();
```

Add cases proving `workspaceScope` is absent without a workspace, contains the selected workspace/files/terminal helpers with a workspace, and that a contribution hidden after state change clears the active id. Add a compact case proving opening a plugin item closes the compact Rail before the plugin dialog state is set.

- [ ] **Step 3: Run focused launcher and app tests to verify they fail.**

Run:

```bash
npm test -- --run src/client/src/components/appShell/AppContextBar.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.activityRail.test.ts
```

Expected: failures for missing launcher properties and missing app activity-Rail methods/state.

- [ ] **Step 4: Add the context-bar launcher without changing desktop behavior.**

In `AppContextBar.ts`, add `activityRailOpen` and `onToggleActivityRail` properties. Render a labelled context action button beside the existing Actions button. Use CSS so this control is hidden at `min-width: 1181px` and visible below that breakpoint.

In `PiWebUiApp.renderContextBar()`, use the reactive `this.appShell.isDesktopActivityRailLayout` signal: render `app-context-bar` whenever the docked desktop Rail is absent, not only below the 760px mobile-navigation breakpoint. Preserve the existing machine/project/workspace/session chips and callbacks so the same action-area launcher is reachable for the 761–1180px compact layout as well as narrow mobile layout. In `AppContextBar.hasContextActions()`, treat `onToggleActivityRail` as an action so the wrapper renders even when no other context action is present.

- [ ] **Step 5: Create one scoped activity context factory.**

Refactor the repeated plugin-runtime construction into a private `createPluginRuntimeContextForOrigin(origin, machineId)` helper. Extract the current inline workspace-panel terminal object into `createWorkspacePanelTerminal(workspace, machineId, origin)` so its `open()` and `runCommand()` behavior stays identical.

Declare this private app-only extension near the other local interfaces:

```ts
interface InternalActivityRailContext extends ActivityRailContext {
  onRefreshMemory: () => void;
}
```

Then create the scoped factory with this shape:

```ts
private createActivityRailContext(): ActivityRailContext {
  const machine = pluginMachineFromState(this.state);
  const workspace = this.state.selectedWorkspace;
  const createContext = (origin: string): InternalActivityRailContext => installActivityRailScope({
    ...this.createPluginRuntimeContextForOrigin(origin, machine.id),
    machine,
    ...(workspace === undefined ? {} : {
      workspaceScope: {
        workspace,
        files: this.createWorkspaceFiles(workspace, machine.id),
        terminal: this.createWorkspacePanelTerminal(workspace, machine.id, origin),
      },
    }),
    host: {
      requestRender: () => { this.requestUpdate(); },
      close: () => { this.closeActivityRailItem(); },
    },
    onRefreshMemory: () => { void this.memory.refresh(); },
  }, createContext);
  return createContext("core");
}
```

Keep `InternalActivityRailContext.onRefreshMemory` outside the exported `ActivityRailContext` declaration. The bundled Memory plugin may retain a narrow internal cast; third-party plugins cannot rely on that field.

- [ ] **Step 6: Add active-item, compact-drawer, and dialog orchestration.**

Add `@state()` fields for `compactRailOpen` and `activeActivityRailId`, plus a private focus-restoration callback. Add helpers that:

1. project `this.plugins.getActivityRailItems()` through `visibleActivityRailItems()` with a reporter that calls `console.warn` with phase and qualified id;
2. open one qualified id only when it is currently visible;
3. close the compact Rail before opening any core or plugin item;
4. close an active item and restore focus after `updateComplete`; and
5. reconcile active visibility in `updated()` so a disabled, remote-inactive, no-workspace, or unavailable contribution closes its dialog; also close `compactRailOpen` when `this.appShell.isDesktopActivityRailLayout` becomes true.

Pass the resolved display items, `compactRailOpen`, open callback, and close callback into `<activity-rail>`. Pass the new launcher callback/state into `<app-context-bar>`. Render `<plugin-activity-dialog>` next to other top-level dialogs only when an active visible contribution resolves, and pass the same app-edge reporter used for display projection through its `.onReportError` property.

Treat `compactRailOpen` and `activeActivityRailId !== undefined` as chat-obscuring state in `isChatObscured()`. Return early from the global shortcut dispatcher while either is open so capture-phase shortcuts cannot run behind the drawer or modal; let the local Escape handlers receive the event. Keep the existing core Rail callbacks unchanged apart from calling the compact close helper first when the drawer is open.

- [ ] **Step 7: Run focused integration tests, then lint the changed client files.**

Run:

```bash
npm test -- --run src/client/src/components/appShell/AppContextBar.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.activityRail.test.ts
npm run typecheck
npx eslint src/client/src/components/appShell/AppContextBar.ts src/client/src/components/appShell/AppContextBar.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.activityRail.test.ts
```

Expected: PASS. The tests prove all compact widths have an opener, context is correctly scoped, an activity dialog cannot outlive visibility, and focus restoration is explicit.

- [ ] **Step 8: Commit app-shell and application orchestration.**

```bash
git add src/client/src/components/appShell/AppContextBar.ts src/client/src/components/appShell/AppContextBar.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.activityRail.test.ts
git commit -m "feat(activity-rail): wire plugin activities into app shell"
```

Expected: the commit contains launcher/context/dialog composition and no Memory contribution migration yet.

## Task 6: Move bundled Memory from the workspace panel to the Activity Rail

**Files:**
- Modify: `pi-webui-plugins/workspace-memory/pi-webui-plugin.ts`
- Modify: `pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts`
- Modify: `src/client/src/components/PiWebUiApp.memory.test.ts`

**Interfaces:**
- Consumes the new `ActivityRailContribution` and app-provided internal Memory callback from Task 5.
- Produces a Rail-only `workspace-memory:workspace.memory` activity and preserves Memory controller polling semantics.

- [ ] **Step 1: Rewrite the Memory plugin contract tests first.**

Replace workspace-panel expectations in `pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts` with activity-Rail expectations:

```ts
expect(result.contributions.workspacePanels).toBeUndefined();
expect(result.contributions.activityRailItems).toHaveLength(1);
expect(result.contributions.activityRailItems?.[0]).toMatchObject({
  id: "workspace.memory",
  title: "Memory",
  order: 50,
});
```

Keep the brain SVG, `render`, badge-total, loading badge omission, and unavailable tests. Add one visibility assertion that a context without `workspaceScope` returns `false`; retain `loading` as visible only when a workspace scope exists.

- [ ] **Step 2: Update app Memory lifecycle tests to register an activity contribution and run them red.**

In `PiWebUiApp.memory.test.ts`, rename panel-oriented helpers to activity-oriented helpers. Register `activityRailItems` instead of `workspacePanels`, replace reflected `workspacePanels()` calls with the app’s activity-Rail projection helper, and assert polling behavior for:

- selected local Memory activity;
- selected remote Memory activity;
- machine-specific gateway/remote replacement;
- absent or removed Memory activity; and
- no selected workspace.

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.memory.test.ts
```

Expected: failures because the bundled plugin still contributes a workspace panel and app polling still observes workspace panels.

- [ ] **Step 3: Migrate the bundled plugin without changing its read-only body.**

Change the narrowed context type to extend `ActivityRailContext`. Move the current contribution object from `workspacePanels` to `activityRailItems`. Keep id, title, brain SVG, order, `memoryBadge()`, `render()` custom element, and retry binding unchanged. Make `visible()` return `false` when `context.workspaceScope === undefined`; otherwise use `isMemoryPanelVisible()` on the existing internal Memory state.

Do not add write, edit, delete, or initialization behavior to `memoryPanelElement.ts`.

- [ ] **Step 4: Switch Memory polling observation in PiWebUiApp.**

Replace `MEMORY_WORKSPACE_PANEL_*` constants/helpers with `MEMORY_ACTIVITY_RAIL_*` names. Make `synchronizeMemoryPollingForSelectedWorkspace()` obtain the current activity-Rail context and check the selected-machine qualified Memory activity’s safe visibility. Keep the existing `MemoryController.updatePolling(false)` path when no workspace exists, the contribution is absent, disabled, remote-inactive, or unavailable.

Ensure `registerExternalPlugins()` updates trigger the same observation after plugin registration so a newly loaded enabled Memory plugin starts polling for the active workspace.

- [ ] **Step 5: Run all Memory-focused checks.**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts
npm test -- --run pi-webui-plugins/workspace-memory/memoryPanelElement.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.memory.test.ts
npm run typecheck
npm run build:plugins
```

Expected: PASS. The panel element remains read-only and reusable, but the host no longer lists Memory among workspace panels.

- [ ] **Step 6: Commit the Memory migration.**

```bash
git add pi-webui-plugins/workspace-memory/pi-webui-plugin.ts pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts src/client/src/components/PiWebUiApp.memory.test.ts
git commit -m "feat(memory): move memory to activity rail"
```

Expected: the commit contains Memory contribution/polling migration and targeted regression tests only.

## Task 7: Document the public API and add the release note

**Files:**
- Modify: `docs/plugins.md`
- Modify: `docs/plugins.html`
- Create: `.changeset/plugin-activity-rail.md`

**Interfaces:**
- Documents the stable v1 public types produced by Task 1 and the visible behavior produced by Tasks 3–6.
- Produces the patch release metadata consumed later by the release workflow.

- [ ] **Step 1: Add the Markdown API reference before editing the website page.**

In `docs/plugins.md`:

1. Add Activity Rail activities to the opening supported-capabilities list and `PluginContributions` interface.
2. Add a dedicated `### Activity Rail activities` section after workspace panels. Document required icon/title/render, host-owned circular styling, dedicated non-draggable section/order, synchronous `visible`/`badge` rules, optional `workspaceScope`, `host.requestRender()`, `host.close()`, dialog behavior, and compact drawer availability below 1181px.
3. Include this compatibility example exactly, with an explanatory paragraph that a missing capability selects the old-host branch:

```js
activate: ({ capabilities, html, svg }) => ({
  contributions: capabilities?.activityRailItems === true
    ? {
      activityRailItems: [{
        id: "workspace.dashboard",
        title: "Dashboard",
        icon: svg`<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"></path></svg>`,
        render: () => html`<p>Dashboard</p>`,
      }],
    }
    : {
      workspacePanels: [{
        id: "workspace.dashboard",
        title: "Dashboard",
        render: () => html`<p>Dashboard</p>`,
      }],
    },
});
```

4. Replace the Memory description’s workspace-tab wording with Rail-only behavior, selected-workspace visibility, count badge, detail dialog, and continued read-only scope.

- [ ] **Step 2: Mirror user-visible claims in the HTML documentation.**

Update `docs/plugins.html` so its extension list includes Activity Rail activities, the canonical example text recognizes the new contribution type, and the built-in Memory section describes the Rail-only detail view rather than a workspace tab. Add a concise link to `plugins.md` for the full contract rather than duplicating the complete type reference.

- [ ] **Step 3: Add the patch Changeset.**

Create `.changeset/plugin-activity-rail.md` with exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Add plugin-contributed Activity Rail activities with responsive dialog access, and move bundled Memory from the workspace tab to the Activity Rail.
```

Do not run `changeset version`, update package versions, or edit `CHANGELOG.md`.

- [ ] **Step 4: Verify documentation and release metadata.**

Run:

```bash
rg -n "Activity Rail|activityRailItems|Rail-only|workspace tab" docs/plugins.md docs/plugins.html
npm run build:plugin-api
npm run build:plugins
git diff --check
git diff -- docs/plugins.md docs/plugins.html .changeset/plugin-activity-rail.md
```

Expected: both documentation surfaces describe the same user-visible contract, generated declarations and bundled plugins build, and the diff has no whitespace errors.

- [ ] **Step 5: Commit documentation and release metadata.**

```bash
git add docs/plugins.md docs/plugins.html .changeset/plugin-activity-rail.md
git commit -m "docs(plugins): document activity rail contributions"
```

Expected: the commit contains only published plugin documentation and one patch Changeset.

## Task 8: Run end-to-end verification and inspect the complete change

**Files:**
- Inspect: all files changed by Tasks 1–7

**Interfaces:**
- Verifies the complete v1 activity-Rail contract, responsive UI behavior, bundled Memory migration, public declaration build, documentation, and release metadata.

- [ ] **Step 1: Run the focused suite in dependency order.**

Run:

```bash
npm test -- --run src/client/src/plugins/registry.test.ts
npm test -- --run src/client/src/plugins/activityRail.test.ts
npm test -- --run src/client/src/components/PluginActivityDialog.test.ts
npm test -- --run src/client/src/components/ActivityRail.test.ts
npm test -- --run src/client/src/components/appShell/AppContextBar.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.activityRail.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.memory.test.ts
npm test -- --run pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts
npm test -- --run pi-webui-plugins/workspace-memory/memoryPanelElement.test.ts
```

Expected: every focused file passes. If a failure appears, fix its owning task before moving to broad verification rather than masking it with unrelated changes.

- [ ] **Step 2: Run complete static, build, and test verification.**

Run:

```bash
npm run typecheck
npm run lint
npm run build:plugin-api
npm run build:plugins
npm run build
npm run verify
git diff --check
git status --short
```

Expected: every command exits successfully. After the task commits, `git status --short` is clean in the isolated execution worktree and shows no generated artifacts that the repository does not track.

- [ ] **Step 3: Inspect the requirements matrix before final review.**

Confirm each item against the actual diff and focused test output:

| Requirement | Evidence to inspect |
| --- | --- |
| Existing v1 plugins remain valid | unchanged existing contribution tests plus Task 1 capability test |
| New plugins can fall back on older hosts | Task 1 capability-free fixture and docs example |
| Plugin controls are circular, ordered, non-draggable | `ActivityRail.test.ts` desktop/drawer tests |
| Core saved Rail order is untouched | existing `activityRailOrder.test.ts` and unchanged storage key/type |
| Compact Rail is default-closed below 1181px | `ActivityRail.test.ts`, `AppContextBar.test.ts`, app integration tests |
| Dialog owns close/focus/error behavior | `PluginActivityDialog.test.ts` and app integration tests |
| Memory is Rail-only and still polls correctly | Memory plugin and app memory tests |
| Public docs and release note ship | `docs/plugins.md`, `docs/plugins.html`, `.changeset/plugin-activity-rail.md` |
| No session-daemon change | `git diff -- src/server/sessiond.ts` is empty |

- [ ] **Step 4: Request code review with the verification evidence.**

Summarize the exact focused and broad commands that passed, the public compatibility behavior, the compact Rail behavior, and the fact that no session-daemon restart is required. Ask the reviewer to inspect the activity-Rail type contract, focus/error lifecycle, selected-machine scoping, Memory polling migration, and documentation claims.

## Spec coverage review

| Approved requirement | Plan coverage |
| --- | --- |
| Add a generic plugin Activity Rail extension | Tasks 1–2 define and safely evaluate the additive contribution contract. |
| Plugin controls redefine behavior through a large host window | Task 3 provides the generic dialog; Task 5 owns active selection and context. |
| Memory is the initial example and no longer a workspace tab | Task 6 migrates contribution and polling; Task 7 documents it. |
| Hide Memory without a selected workspace | Tasks 5–6 create optional `workspaceScope` and assert Memory visibility. |
| Keep plugin controls in a dedicated ordered section | Tasks 1 and 4 implement deterministic order and Rail placement. |
| Preserve core drag ordering and fixed Settings | Task 4 retains core-only drag behavior and tests it. |
| Use circular plugin controls, not color semantics | Task 4 asserts `plugin-rail-button` circular presentation; no color field exists in Task 1. |
| Provide app-wide activities | Task 1’s optional scope and Task 5’s context factory support no-workspace contributions. |
| Preserve backward compatibility | Task 1 keeps apiVersion 1 and tests the capability-free fallback; Task 7 documents it. |
| Make the Rail reachable below the desktop breakpoint | Tasks 4–5 add the default-closed compact drawer and launcher across all compact widths. |
| Host-owned accessibility, close behavior, and failure containment | Tasks 2 and 5 provide focused dialog/app lifecycle tests. |
| Preserve selected-machine/machine-specific behavior | Task 1 registry tests and Task 6 Memory remote tests cover it. |
| Update canonical docs and release note | Task 7 updates both docs surfaces and adds the patch Changeset. |
| No session-daemon or server-side expansion | Global Constraints and Task 8’s diff inspection enforce the boundary. |
