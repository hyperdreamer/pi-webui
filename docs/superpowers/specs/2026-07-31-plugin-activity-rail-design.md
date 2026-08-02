# Plugin Activity Rail contributions — design

**Status:** Approved design direction; awaiting review of this written specification.

## Goal

Extend PI WEBUI’s Activity Rail so enabled browser plugins can contribute a first-class activity:

- a required icon, title, stable contribution id, optional order, optional badge, visibility callback, and rendered detail view;
- a host-owned large activity dialog opened by the Rail icon;
- a consistent mobile/compact presentation of the same Rail behind a user-controlled drawer; and
- a backwards-compatible v1 plugin contract that lets one plugin optionally fall back on older PI WEBUI hosts.

The bundled Memory plugin is the first adopter. It moves from a workspace-panel tab to a Rail-only activity, retaining its current read-only Global memory and Project-specific memory content, count badge, loading/error/retry behavior, and room for future memory management operations.

## Accepted user experience

### Desktop Rail

At `min-width: 1181px`, the existing docked Activity Rail remains visible and keeps its current core behavior:

1. Core Rail controls remain rounded-square and are the only draggable/reorderable controls.
2. The persisted core Rail order remains exactly the existing six-item local-storage order. No plugin id enters that preference.
3. If visible plugin activities exist, the Rail renders one separator after core controls, then a dedicated plugin section.
4. Plugin items sort by `order ?? 1000`, then `title`, then qualified id for a deterministic final tie-breaker.
5. Plugin controls are neutral, fully circular buttons. They do not get plugin-defined color styling, drag attributes, or drop targets.
6. Settings remains fixed below the Rail spacer, after both core and plugin sections.
7. A plugin badge uses the existing compact Rail-badge treatment. A string or numeric badge is included in the accessible label; a template badge remains visual-only, matching current workspace-tab behavior.

A plugin button exists only when its plugin was discovered, enabled, imported, and registered, and its contribution’s `visible()` callback does not return `false`.

### Compact/mobile Rail

The present Activity Rail disappears below `1181px`; a Rail-only Memory activity would otherwise be inaccessible at phone, tablet, and narrow desktop widths. Replace that absence with a compact Rail drawer at every width below the desktop Rail breakpoint.

1. A persistent compact Activity Rail toggle appears in the context-bar action area whenever the docked desktop Rail is absent. It is always available because it exposes core Rail controls as well as plugin activities.
2. The drawer is closed by default and its open state is not saved across reloads.
3. Opening it overlays application content rather than narrowing the chat or workspace area.
4. The drawer uses the same core ordering, plugin section, circular plugin controls, visibility rules, badges, and fixed Settings control as desktop.
5. Selecting any item closes the drawer before that item opens its existing UI or a plugin activity dialog.
6. The drawer closes through its toggle/close control, backdrop click, or Escape, and restores focus to the toggle. A desktop activity dialog restores focus to its originating Rail button when that button remains connected; a compact activity dialog restores focus to the compact Rail toggle.
7. At `min-width: 1181px`, the compact drawer and toggle are absent; the existing docked Rail remains the only Rail presentation.

This is one responsive Activity Rail system, not a separate mobile plugin contribution point or a mobile workspace-tab fallback.

### Plugin activity dialog

Clicking a plugin Rail control opens one host-managed large dialog. The host owns the dialog chrome and lifecycle:

- plugin icon and title in the header;
- close button, Escape handling, backdrop-click close, modal semantics, focus management, and restoration to the originating Rail control;
- one active plugin activity at a time;
- responsive, scrollable body that is large on desktop and safely fills the compact viewport on mobile;
- re-evaluation with current context on host updates; and
- automatic close when the selected contribution is no longer active or visible.

The plugin renders only the body. It may call `context.host.close()` after an explicit user operation. Synchronous exceptions from a contribution’s `render()` callback are logged and replaced with a scoped dialog error state rather than breaking the entire application. A failing `visible()` callback hides only that item for the current render; a failing `badge()` callback leaves the item visible without a badge; both failures are logged with the qualified contribution id. Errors from asynchronous plugin-owned work remain the plugin’s responsibility and should be surfaced by the plugin’s own UI or browser console.

## Public plugin contract

The existing API version remains `1`. The extension is additive.

```ts
interface PluginHostCapabilities {
  /** Present and true when this host supports activityRailItems. */
  activityRailItems?: true;
}

interface PluginActivationContext {
  apiVersion: 1;
  pluginId: PluginId;
  html: HtmlTemplateTag;
  svg: SvgTemplateTag;
  capabilities?: PluginHostCapabilities;
}

interface PluginContributions {
  activityRailItems?: ActivityRailContribution[];
  actions?: PluginAction[];
  workspacePanels?: WorkspacePanelContribution[];
  workspaceLabels?: WorkspaceLabelContribution[];
  themes?: ThemeContribution[];
  themePairs?: ThemePairContribution[];
}

interface ActivityRailContribution {
  id: LocalContributionId;
  title: string;
  icon: TemplateResult;
  order?: number;
  visible?: (context: ActivityRailContext) => boolean;
  badge?: (context: ActivityRailContext) => string | number | TemplateResult | undefined;
  render: (context: ActivityRailContext) => TemplateResult;
}

interface ActivityRailHost {
  requestRender(): void;
  close(): void;
}

interface ActivityRailWorkspaceScope {
  workspace: Workspace;
  files: WorkspaceFiles;
  terminal: WorkspacePanelTerminal;
}

interface ActivityRailContext extends PluginRuntimeContext {
  machine: PluginMachine;
  workspaceScope?: ActivityRailWorkspaceScope;
  host: ActivityRailHost;
}
```

`PluginRuntimeContext` continues to provide documented app-level helpers and prompt access. `workspaceScope` is absent when no workspace is selected, allowing genuinely app-wide activities while giving workspace-aware activities a stable, explicit scope bundle. It deliberately does not expose the host’s complete private workspace-panel state.

`icon` is required. Plugin authors supply an SVG/template using the activation `svg` helper; the host applies the circular button frame, neutral styling, hover/focus/disabled treatment, and badge layout. There is no accent-color field.

## Registry and host architecture

### Plugin registry

`PluginRegistry` gains an activity-Rail collection that mirrors existing action/panel qualification:

1. During `register()`, it validates each local contribution id, qualifies it as `<runtime-plugin-id>:<local-id>`, tracks it in the existing duplicate-id set, and records plugin/source/machine metadata.
2. It wraps `visible`, `badge`, and `render` with the existing selected-machine and gateway-vs-remote duplicate checks.
3. It exposes qualified activity-Rail contributions in deterministic order.
4. Local, remote, and `machineSpecific` plugin behavior follows the existing contribution rules. A remote activity appears only while its corresponding selected machine is active.

The registry passes `{ apiVersion: 1, pluginId, html, svg, capabilities: { activityRailItems: true } }` to plugins on new hosts.

### App orchestration

`PiWebUiApp` owns all mutable host state and framework wiring:

- creates the current `ActivityRailContext`, including app-level plugin runtime helpers, selected machine, optional workspace scope, and a contribution-bound `host.close()`;
- retrieves, filters, and maps qualified contributions into a small presentation model for `ActivityRail` so the Rail component does not know plugin registry internals;
- stores one active qualified activity id plus the originating focus target;
- renders a dedicated reusable activity-dialog component around the selected contribution body; and
- owns compact-drawer open state and the context-bar toggle callback.

The Activity Rail remains a presentation component. It receives core callbacks/order plus already-resolved plugin display items and emits an open callback by qualified id. It owns no plugin state, registry access, dialog state, or persistence beyond its existing core drag behavior.

The activity-dialog component is the UI adapter around the dialog lifecycle above. It receives the resolved contribution, fresh context, and close callback. It does not know Memory-specific state or APIs.

## Memory migration

The bundled `workspace-memory` plugin becomes the canonical example of an `activityRailItems` contribution:

- id: `workspace.memory`;
- existing brain SVG icon;
- existing count badge logic;
- visibility only when `workspaceScope` exists and memory support has not been confirmed unavailable; and
- existing Memory custom-element body and retry wiring rendered inside the activity dialog.

Remove Memory’s `workspacePanels` contribution completely. This intentionally frees desktop and mobile workspace-tab space.

Memory’s browser controller remains core-owned. `PiWebUiApp` continues to expose its internal state and refresh callback only through the bundled Memory plugin’s narrow internal cast; those controller details are not added to the public third-party Rail API.

Memory polling must observe the presence and visibility of the selected-machine Memory **activity-Rail contribution**, rather than the former workspace panel. The existing immediate refresh, approximately 30-second polling cadence, retry behavior, and selected local/remote machine handling remain unchanged. If Memory is absent, disabled, hidden because no workspace is selected, or confirmed unavailable, polling is inactive.

## Backward compatibility

### Existing plugins on the new host

This change is backwards-compatible for existing v1 plugins:

- all existing contribution fields remain unchanged;
- an existing plugin does not need to declare a Rail contribution;
- `apiVersion` remains `1`; and
- the core Rail-order preference needs no migration.

### New Rail-capable plugins on old hosts

An older host ignores the unknown `activityRailItems` property safely. A new plugin that declares only that property will not show a Rail icon there, but will not crash.

Plugins that need an intentional old-host fallback can branch on the optional capability:

```ts
activate: ({ capabilities, html, svg }) => ({
  contributions: capabilities?.activityRailItems === true
    ? { activityRailItems: [/* modern Rail activity */] }
    : { workspacePanels: [/* legacy fallback */] },
});
```

Older hosts do not supply `capabilities`, so this branch naturally selects the legacy contribution. New hosts supply the capability. The bundled Memory plugin need not carry this fallback because the bundled host and plugin ship in the same PI WEBUI release.

Mixed-version federation remains best-effort as today: a newer gateway can render an older remote plugin normally; an older gateway safely ignores an activity-Rail contribution from a newer remote module.

## Testing and verification

Follow the repository testing guide: use focused tests at the smallest seam first, then broad verification.

1. **Registry tests** cover validation, qualified ids, sort order, local/remote/machine-specific activation, visibility/badge/render context scoping, duplicate ids, and the activation capability.
2. **Activity Rail component tests** cover desktop plugin section rendering, separator omission when empty, circular plugin buttons, accessible names/badges, click dispatch, and the invariant that only core controls have drag/drop behavior.
3. **Compact drawer/component tests** cover default-closed state, opener, backdrop/Escape close, focus restoration, identical plugin presentation, and closing before a selected activity opens.
4. **Activity dialog tests** cover title/icon shell, close paths, single-active behavior, unavailable-contribution closure, scoped synchronous render failure, and host `close()`.
5. **App wiring tests** cover context construction with and without workspace scope, active id resolution, compact-to-dialog handoff, and selected-machine filtering.
6. **Memory tests** migrate current panel assertions to activity-Rail contribution assertions: no workspace panel, correct visibility/badge/rendering, polling continuity, retry wiring, unavailable state, and remote/machine-specific behavior.
7. **Public API tests/builds** prove that exported declarations contain the contribution/context/capability types and that a capability-branching plugin compiles.

Run focused Vitest files first, then `npm run typecheck`, lint changed TypeScript files, `npm run build:plugin-api`, the relevant bundled-plugin build, `npm run build`, `git diff --check`, and finally `npm run verify`.

## Documentation and release impact

Update the canonical plugin documentation in both `docs/plugins.md` and `docs/plugins.html`:

- list Activity Rail activities among supported plugin extensions;
- document the contribution contract, circular host-owned controls, ordering, visibility/badge constraints, app-wide optional workspace scope, and dialog behavior;
- document compact/mobile drawer availability;
- document the optional capability fallback for older hosts; and
- replace the Memory workspace-tab description with the Rail-only Memory activity behavior.

Do not expand `README.md`; this is detailed plugin behavior with an existing canonical documentation page.

Add one patch Changeset for the user-visible plugin capability. Do not edit `CHANGELOG.md` manually.

The work changes client/UI/plugin code only. It does not change `src/server/sessiond.ts`, session ownership, the session-daemon protocol, or session-daemon-only code. The normal UI/API development-service autoreload path is sufficient; no manual session-daemon restart is required.

## Scope boundaries

- Do not make plugin activity icons part of the existing saved core Rail order.
- Do not add plugin-defined colors, arbitrary host CSS, or a per-plugin Rail layout API.
- Do not retain a Memory workspace-panel fallback in the new bundled host.
- Do not add server routes, session-daemon hooks, or memory mutation behavior in this feature.
- Do not persist compact-drawer open state or introduce a user configuration file for it.
- Do not redesign unrelated mobile tabs, workspace panels, core Rail controls, or terminal-modal preferences.

## Expected implementation areas

- `src/client/src/plugins/types.ts` and `src/plugin-api.ts`: internal and public activity-Rail/capability/context types.
- `src/client/src/plugins/registry.ts` and registry tests: registration, qualification, machine scoping, ordering, and activation capabilities.
- `src/client/src/components/ActivityRail.ts` and tests: plugin display items, circular controls, desktop section, compact drawer presentation, and preserved core drag behavior.
- A focused client activity-dialog component and tests: shared host-managed dialog lifecycle.
- `src/client/src/components/PiWebUiApp.ts` and focused tests: context construction, active activity state, compact Rail toggle/drawer, activity dialog, and Memory polling observation.
- `pi-webui-plugins/workspace-memory/` and its tests: migrate from workspace panel to activity-Rail contribution without changing the panel body’s read-only behavior.
- `docs/plugins.md`, `docs/plugins.html`, generated public plugin API output, and `.changeset/` when implementation begins.
