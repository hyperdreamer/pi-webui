# Memory workspace badge, availability, and provider compatibility — design

**Status:** Approved design direction; awaiting review of this written specification.

## Goal

Make the Memory workspace icon communicate how much memory is currently effective for the selected project while remaining unobtrusive when memory support is unavailable.

The feature must:

- show a compact numeric badge equal to the selected scope's **global entries plus project-specific entries**;
- use the same shared workspace-tab badge presentation and zero-count behavior as Terminal;
- refresh immediately when the selected project/workspace scope changes and then every 30 seconds while the Memory tab is present;
- hide the complete Memory tab when no compatible memory provider is available;
- keep the tab visible, but omit the numeric badge, when a compatible provider is available and currently has zero entries;
- isolate the current `pi-hermes-memory` file convention behind a provider seam so future formats can be added without rewriting the tab, polling, or routes.

The Memory tab remains strictly read-only.

## Accepted user experience

### Tab visibility and badge

1. On a selected workspace, PI WEBUI begins a memory availability/snapshot load immediately.
2. While availability is unknown or an operational error is being resolved, the Memory tab remains visible without a number. This avoids incorrectly treating a temporary server/profile failure as “memory support is not installed.”
3. When the server confirms that no provider is available, the entire Memory tab, including its brain icon, disappears. The generic workspace panel uses its existing fallback behavior if the hidden tab had been selected.
4. When at least one provider is available, the Memory tab remains visible even if it has no entries.
5. A positive badge is the sum of available global and project-specific entries. A zero total renders no badge, exactly as Terminal returns `undefined` when its active-terminal count is zero.
6. The existing shared workspace-tab markup supplies the visual treatment and accessible label, so the tab is announced as, for example, **“Memory, 7.”** No new icon or bespoke badge styling is introduced.

### Scope and refresh behavior

- A project selection produces a new selected workspace; the Memory snapshot is loaded immediately for that workspace.
- The cache key includes the selected machine plus the existing memory scope identity: project id, workspace id, and workspace path. Including the workspace path is intentional: the current Hermes project lookup derives its storage directory from that path, so switching between worktrees in one project can point at a different project-memory store.
- On a scope change, any prior numeric value disappears while the new scope loads. A result for an old scope is ignored.
- For an unchanged scope, the controller refreshes every 30 seconds. It keeps the last successful value during a refresh so the badge does not flicker.
- The timer is active only while the badge element is connected in the workspace tab strip. It is cleared when that element disconnects; no background polling survives a removed workspace panel or page teardown.
- A timer schedules the next poll after the current request settles, rather than starting overlapping requests.

This deliberately uses polling rather than a filesystem watcher or a new realtime event. Terminal changes are PI WEBUI-owned operations and already emit `terminal.created`, `terminal.exited`, and `terminal.closed` events. Memory writes originate outside PI WEBUI and have no equivalent event stream. A 30-second bounded poll is proportionate to two small read-only memory sources.

## Current-state constraints

`workspace.terminal` supplies its number through the synchronous workspace-panel callback:

```ts
badge: (context) => context.activeTerminalCount > 0
  ? context.activeTerminalCount
  : undefined
```

`PiWebUiApp` owns and updates that count from a workspace refresh and terminal realtime events. In contrast, the bundled Workspace Memory plugin currently loads only after its panel custom element connects. Its server-side `MemoryService` reads hard-coded Hermes paths and treats every file-read failure as an empty entry array.

That current behavior cannot distinguish:

- no `pi-hermes-memory` support;
- a compatible provider with no entries yet; and
- a permission or I/O failure.

It also couples the browser panel to two private routes and prevents an icon count before the panel has been opened.

## Architecture

### Deep module: memory catalog

Introduce a server-side **MemoryCatalog** module with one browser-facing interface:

```ts
read(projectPath: string): Promise<MemorySnapshot>
```

`MemorySnapshot` communicates all state required by the browser in one response:

- whether at least one compatible provider is available;
- global entries;
- project-specific entries;
- a project-scope unavailable message when global data remains usable but project data cannot be read; and
- an explicit global-load failure when a complete, trustworthy total cannot be produced.

The catalog hides provider detection, file-system layout, parsing, aggregation, and provider-specific errors. Browser code must not inspect agent directories, package configuration, or individual provider paths.

Add a private **MemoryProvider** seam behind the catalog. A provider owns its own availability probe and scoped read behavior. Its interface receives an agent profile directory and selected project/workspace path, and returns either unavailable, loaded data, a project-only failure, or a global failure. Providers are registered by PI WEBUI server code; they are not browser modules.

The first adapter is `PiHermesMemoryProvider`:

- global entries come from `pi-hermes-memory/MEMORY.md` and `pi-hermes-memory/failures.md` beneath the active agent profile directory;
- project entries come from `join(agentDir, "projects-memory", basename(workspacePath), "MEMORY.md")`;
- parsing continues to use the existing Hermes-compatible parser;
- provider availability is based on the presence of either the `join(agentDir, "pi-hermes-memory")` directory or the selected scope's `join(agentDir, "projects-memory", basename(workspacePath))` directory, not on a nonzero entry count. Those provider state roots establish availability even when their files are empty;
- `ENOENT` means an absent optional file. Permission, malformed-path, and other I/O failures remain errors instead of being silently collapsed into an empty list.

A catalog with no available provider returns a successful `unavailable` snapshot. That is distinct from a failed catalog request.

### Provider compatibility boundary

The provider seam makes future first-party compatibility work local: a new format needs one adapter plus catalog registration, rather than edits to the UI tab, polling controller, shared tab component, and route behavior.

If more than one provider is registered and available, the catalog aggregates their entries by scope. Provider-qualified entry ids prevent collisions between otherwise identical provider-local ids. The badge counts the aggregated entries.

This does **not** claim automatic compatibility with every arbitrary Pi package. PI WEBUI currently has no server-side extension contribution protocol for memory providers. A third-party provider must opt into a documented provider contract or be added as a PI WEBUI adapter. Designing that external registration protocol is explicitly deferred until there is a second real provider to support.

### Snapshot route and client

Add one internal combined route:

```text
GET api/agent-memory/snapshot?projectPath=...
```

Its response maps directly to `MemorySnapshot`. The bundled Memory client moves to this route so a single request supplies availability, both scopes, and the badge total. Existing scope-specific routes may remain temporarily for compatibility, but the bundled panel and badge must use the snapshot route exclusively.

The client continues to use application-relative paths, `URLSearchParams` for the query value, and the existing browser request boundary conventions.

### Browser-owned workspace state

Create a focused plugin-local **MemoryWorkspaceState** module. It is the only browser module that owns:

- the current scope key;
- the last successful snapshot;
- the in-flight request and generation guard;
- the 30-second timer;
- subscriptions from the Memory panel and tab-badge element; and
- calls to `context.host.requestRender()` when asynchronous state changes affect `visible`, `badge`, or panel rendering.

Its public interface stays small: consumers provide a workspace context, observe the current state, and release their observation on disconnect. Fetching and timer details remain internal. Inject the snapshot fetcher and clock/timer dependencies into the controller/factory so focused tests do not depend on real fetches or elapsed time.

Use a small custom `pi-webui-memory-tab-badge` element as the connected lifecycle owner in the workspace tab strip. It subscribes to `MemoryWorkspaceState`, renders only a positive numeric total, and stops its observation when disconnected. The panel custom element subscribes to the same state and renders the same snapshot, eliminating duplicate initial loads and keeping open panel content synchronized with polling results.

The Memory contribution becomes synchronous from the host's perspective:

- `visible(context)` calls the controller's synchronous `ensure(context)` operation and returns false only for a confirmed unavailable provider;
- `badge(context)` returns the badge element; the element displays nothing for loading, errors, or zero;
- `render(context)` returns the existing Memory panel element, now backed by the shared state.

No change is needed to the generic `WorkspacePanel` badge implementation. It continues to render `WorkspacePanelContribution.badge` values and derive the accessible label.

## Data flow

```text
selected project / selected workspace changes
  → workspace-panel asks Memory contribution for visibility and badge
  → MemoryWorkspaceState switches to a new machine + workspace scope key
  → immediate GET api/agent-memory/snapshot?projectPath=...
  → MemoryCatalog probes registered providers
  → PiHermesMemoryProvider (and future adapters) loads scoped entries
  → MemorySnapshot
  → MemoryWorkspaceState stores only a current-generation result
  → context.host.requestRender()
  → visible tab decision + shared tab badge + Memory panel re-render

connected Memory tab badge
  → schedule next refresh 30 seconds after the prior request settles
  → same snapshot flow
```

A project or worktree switch invalidates the previous generation before starting the new request. Late responses cannot update the new project's count or panel contents.

## Error handling

- **Confirmed no provider:** return `unavailable`; hide the Memory tab. Do not show an error badge.
- **Available provider, no entries:** return a loaded empty snapshot; keep the tab visible without a badge and preserve the existing empty panel states.
- **Initial global/profile/network error:** keep the tab visible without a numeric count and show the existing retryable panel-level error when the panel is open. Do not hide the tab, because availability was not disproven.
- **Polling global error after a successful load:** retain the last successful snapshot and count; record the failure for the panel's retry/status presentation. A transient failure must not turn a known provider into an unavailable provider.
- **Project-only failure:** retain global entries and use their count for the badge. The panel continues to show a scoped project-unavailable message.
- **Stale request:** discard it silently when its machine/workspace key or generation no longer matches.
- **Multiple provider entries:** prefix provider-local identifiers before aggregation so UI expansion state and rendered lists do not collide.

## Verification strategy

Follow TDD and add focused regression coverage before production changes.

### Server tests

1. `PiHermesMemoryProvider` distinguishes absent roots, empty-but-available roots, global files, failure files, and project files.
2. `ENOENT` produces the intended unavailable/empty result; permission and non-ENOENT read failures are surfaced as typed failures.
3. `MemoryCatalog` reports no-provider availability, aggregates entries from registered adapters, namespaces ids, and preserves project-only failure semantics.
4. The snapshot route validates `projectPath`, maps active-profile failures to the existing service-unavailable response, and returns the complete snapshot contract.

### Plugin/browser tests

1. `MemoryWorkspaceState` immediately loads a new scope, sums global and project entries, and omits the badge at zero.
2. Fake timers verify a 30-second refresh, no overlapping requests, cleanup on unsubscribe/disconnect, and retention of the last good value during same-scope polling.
3. Scope changes clear stale values, ignore late responses, and refresh when a different worktree has the same project id but a different path.
4. A confirmed unavailable snapshot removes the contribution; an available empty snapshot retains it; a transient fetch error does not hide a previously available tab.
5. The tab-badge element and panel consume one shared state source and update together after a poll.
6. Plugin contribution tests cover `visible`, `badge`, brain icon preservation, and the shared generic accessible-label behavior.

Run focused Vitest files first, then `npm run typecheck`, lint changed TypeScript files, `git diff --check`, and `npm run verify` before implementation review.

## Documentation and release impact

The canonical user-facing explanation belongs in `docs/plugins.md` and its paired `docs/plugins.html` Memory section. It should describe:

- the tab's provider-dependent visibility;
- that a compatible but empty provider still shows the tab;
- the global-plus-project badge; and
- the immediate plus periodic refresh behavior without promising realtime delivery.

`README.md` remains unchanged. The implementation is a user-visible bundled-plugin feature and requires a patch Changeset; `CHANGELOG.md` is generated during release preparation and must not be edited directly.

## Scope boundaries

- Do not add filesystem watching, server-side file-watch lifecycle management, or a new realtime event type.
- Do not modify `src/server/sessiond.ts`, session ownership, or the session-daemon protocol. The change belongs to the web/API and browser-plugin paths, so the normal UI/API development service reload path is sufficient.
- Do not write, initialize, migrate, or delete any memory files.
- Do not add a user configuration toggle, a new project configuration file, arbitrary package-name heuristics, or an external provider-registration protocol in this change.
- Do not redesign the generic workspace tab badge or alter Terminal behavior.

## Expected implementation areas

- `src/server/memory/`: provider adapter, catalog, snapshot route, and focused tests.
- `src/shared/apiTypes.ts`: snapshot/provider-facing response types required by the internal route.
- `pi-webui-plugins/workspace-memory/`: snapshot client, shared workspace-state controller, lifecycle-owned badge element, panel migration, contribution wiring, and tests.
- `docs/plugins.md` and `docs/plugins.html`: synchronized user-facing Memory documentation.
- `.changeset/`: one patch-level user-facing release note when implementation begins.
