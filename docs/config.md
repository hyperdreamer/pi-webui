# PI WEBUI configuration reference

PI WEBUI configuration covers the machine-local and project-local settings you usually need: the web/API bind address, trusted development-host settings, UI preferences, plugin enablement, file-explorer path access, manual upload defaults, upload limits, Pi-compatible agent profiles and companion CLIs, and session-daemon tools.

This file is the markdown reference for agents and package consumers. The website page is <https://pi-webui.dev/config>.

## Config files

PI WEBUI uses two config files:

- **Global PI WEBUI config:** `$PI_WEBUI_CONFIG`, or `$XDG_CONFIG_HOME/pi-webui/config.json`, or `~/.config/pi-webui/config.json`.
- **Project-local PI WEBUI config:** `<project>/.pi-webui/config.json` for commit-able project settings.

Each PI WEBUI machine has its own config. When using Fleet/machine federation, Settings uses the selected machine for config that affects work running there: the Pi-compatible agent profile and companion CLI, session daemon tools, model tier routing ladder, PI WEBUI plugin enablement, external path access, and upload defaults. Gateway/browser-only settings stay local to the gateway: keyboard shortcuts, remote machine registry/tokens, and gateway host/port/allowed-hosts. Remote servers that do not advertise selected-machine settings support report those settings as unavailable instead of silently falling back to the gateway.

Pi package settings are separate from PI WEBUI config. They live in Pi's package-manager settings on the target machine and are managed by Pi (`pi install`, `pi remove`, `pi update`) or **Settings → Pi packages**. In a federated setup, **Settings → Pi packages** targets the currently selected machine. The PI WEBUI `plugins` config key only enables or disables discovered PI WEBUI browser plugins on the machine whose config you are editing; it does not install, remove, or update Pi packages.

If you installed services with a custom config path, rerun `pi-webui install --config /path/to/config.json` after changing that path or after upgrading from a version that only applied the custom path to the web service. This regenerates service files so the web/API and session daemon use the same `PI_WEBUI_CONFIG`.

## Reverse-proxy deployment paths

The deployment path is not a PI WEBUI config-file key or environment setting. The published client is portable: one build works at `/` and at canonical trailing-slash prefixes such as `/ai/` or `/test/ai/`.

For a nested deployment, redirect the slashless prefix to the trailing-slash URL, strip the prefix before forwarding to PI WEBUI, and proxy authenticated HTTP and WebSocket traffic through the same location. Relative browser and PWA URLs then stay within that prefix. See the [reverse proxy installation guide](https://pi-webui.dev/install#reverse-proxy-prefix) for a complete Nginx example.

## Precedence and reloads

Machine-global runtime values are resolved as:

```text
defaults → global config file → environment overrides
```

Supported project-local settings are then applied for that project's workspaces. For upload defaults, `<project>/.pi-webui/config.json` overrides the global value.

Environment overrides include `PI_WEBUI_HOST`, `PI_WEBUI_PORT` / `PORT`, `PI_WEBUI_ALLOWED_HOSTS`, `PI_WEBUI_MAX_UPLOAD_BYTES`, `PI_WEBUI_AGENT_COMMAND`, `PI_WEBUI_AGENT_DIR`, `PI_WEBUI_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` for Pi compatibility, `PI_WEBUI_SPAWN_SESSIONS`, and `PI_WEBUI_SUBSESSIONS`.

Process restarts depend on the key:

- `host` / `port`: restart the gateway web/API service or process.
- `maxUploadBytes`: restart both the web/API process and the session daemon on that machine.
- `agent.command` / `agent.dir` / `spawnSessions` / `subsessions`: restart the session daemon on that machine.
- `modelTiers`: saved settings apply immediately in **Settings → Model tiers**; validates all six ladder rows atomically.
- `pathAccess`: applies on the next request; existing file views may need a browser refresh.
- `uploads.defaultFolder`: applies to newly opened Files upload dialogs and new direct drag/drop batches after config/workspace refresh.
- `plugins`: reload the browser tab after changing PI WEBUI plugin enablement.
- Pi package install/remove/update: not a PI WEBUI config key; after a mutation, type `/reload` in each idle PI WEBUI session on the target machine to refresh Pi runtime resources such as extensions, skills, prompt templates, themes, and context/system prompt files as supported by Pi. Reload the browser page separately for PI WEBUI browser plugin changes. A routine session daemon restart is not required.
- `shortcuts`: saved settings apply in the browser after config refresh/save.

## Global config example

```json
{
  "host": "127.0.0.1",
  "port": 8808,
  "pathAccess": {
    "allowedPaths": ["~/SDKs", "/opt/reference"]
  },
  "uploads": {
    "defaultFolder": ".pi-webui/uploads"
  },
  "maxUploadBytes": 67108864,
  "agent": {
    "command": "pi",
    "dir": "~/agent-profiles/research"
  },
  "modelTiers": {
    "economy": { "provider": "anthropic", "modelId": "claude-3-5-haiku-20241022", "thinkingLevel": "off" },
    "fast": { "provider": "anthropic", "modelId": "claude-3-5-haiku-20241022", "thinkingLevel": "off" },
    "standard": { "provider": "anthropic", "modelId": "claude-3-5-sonnet-20241022", "thinkingLevel": "off" },
    "advanced": { "provider": "openai", "modelId": "gpt-4o", "thinkingLevel": "off" },
    "capable": { "provider": "anthropic", "modelId": "claude-3-7-sonnet-20250219", "thinkingLevel": "high" },
    "frontier": { "provider": "openai", "modelId": "o3-mini", "thinkingLevel": "high" }
  },
  "spawnSessions": true,
  "subsessions": false,
  "plugins": {
    "workspace-tasks": { "enabled": true },
    "updates": { "enabled": true },
    "info": { "enabled": false }
  },
  "shortcuts": {
    "core:view.chat": "mod+1",
    "core:session.stop": null
  }
}
```

## Project-local config

Project-local config lives at `<project>/.pi-webui/config.json`. Use it for settings that should follow a repository.

```json
{
  "version": 1,
  "pathAccess": {
    "allowedPaths": ["~/SDKs", "/opt/reference"]
  },
  "uploads": {
    "defaultFolder": "manual/uploads"
  }
}
```

Project-local `pathAccess.allowedPaths` entries are merged after the global list and deduplicated. Paths must still be host-absolute or `~`-prefixed; relative roots are not supported.

Project-local `uploads.defaultFolder` overrides the global upload destination for workspaces in that project. Current PI WEBUI servers include this workspace-effective value on the existing workspace responses used locally and through machine federation. Older remote servers may omit the optional field; the browser falls back to the global/default upload folder.

Plugins may own separate project files, such as `.pi-webui/tasks.json` for the built-in Workspace Tasks plugin.

## Configuration matrix

Rows with JSON key `—` are runtime-only environment variables, not config-file keys. `Global` means machine-global. In Settings, selected-machine-safe global keys (`pathAccess`, `uploads`, `maxUploadBytes`, `agent`, `spawnSessions`, `subsessions`, `modelTiers`, and `plugins`) are edited for the selected machine; gateway host/port/allowed-hosts, keyboard shortcuts, and machine registry/tokens stay local.

| Config | JSON key | Env var | Scope | Project-local behavior | Applies / restart |
| --- | --- | --- | --- | --- | --- |
| **Config-file keys** |  |  |  |  |  |
| Web/API bind host | `host` | `PI_WEBUI_HOST` | Global | Not supported locally | Restart web/API |
| Web/API port | `port` | `PI_WEBUI_PORT`, `PORT` | Global | Not supported locally | Restart web/API |
| Dev-server allowed hosts | `allowedHosts` | `PI_WEBUI_ALLOWED_HOSTS` | Global | Not supported locally | Restart dev web/UI |
| External filesystem roots | `pathAccess.allowedPaths` | — | Global + project | **Merges**: global roots first, then project roots; duplicates removed | Next file request; refresh existing views if needed |
| Manual file upload default folder | `uploads.defaultFolder` | — | Global + project | **Overrides**: project value wins for workspaces in that project; otherwise global/default applies | New Upload dialogs and direct drag/drop batches after config/workspace refresh |
| Upload/body limit | `maxUploadBytes` | `PI_WEBUI_MAX_UPLOAD_BYTES` | Global | Not supported locally | Restart web/API and session daemon on that machine |
| Companion CLI command | `agent.command` | `PI_WEBUI_AGENT_COMMAND` | Global/session daemon | Not supported locally | Restart session daemon on that machine; affects doctor/status/update checks |
| Agent profile state directory | `agent.dir` | `PI_WEBUI_AGENT_DIR` (`PI_CODING_AGENT_DIR` for Pi compatibility) | Global/session daemon | Not supported locally | Restart session daemon on that machine; affects auth, models, settings, sessions, Pi packages, and package-backed plugins |
| Agent can spawn sessions | `spawnSessions` | `PI_WEBUI_SPAWN_SESSIONS` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Tracked subsessions (beta) | `subsessions` | `PI_WEBUI_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon on that machine |
| Model tier routing ladder | `modelTiers` | — | Global | Not supported locally | Saved settings apply immediately on save; requires remote peer capability `settings.modelTiers` |
| Plugin enablement/settings | `plugins.<id>.enabled`, `plugins.<id>.settings` | — | Global | Not core local config; plugins may read their own project files | Reload browser tab |
| Keyboard shortcuts | `shortcuts.<actionId>` | — | Global | Not supported locally | Applies after settings save/config refresh |
| Project config version | `version` | — | Project | Project-local only; must be `1` when present | Next project-config read |
| **Runtime-only environment variables** |  |  |  |  |  |
| Global config file path | — | `PI_WEBUI_CONFIG` (`XDG_CONFIG_HOME` affects the default path) | Process/env | Selects the global config file; not a project config | Restart services/processes after changing env |
| Managed data directory | — | `PI_WEBUI_DATA_DIR` | Process/env | Not supported locally | Restart web/API and session daemon |
| Session daemon socket | — | `PI_WEBUI_SESSIOND_SOCKET` | Web/API + session daemon env | Not supported locally | Restart daemon and web/API; both must match |
| Session daemon TCP port | — | `PI_WEBUI_SESSIOND_PORT` | Session daemon env | Not supported locally | Restart session daemon; set `PI_WEBUI_SESSIOND_URL` for web/API too |
| Session daemon TCP host | — | `PI_WEBUI_SESSIOND_HOST` | Session daemon env | Not supported locally | Restart session daemon |
| Web-to-daemon URL | — | `PI_WEBUI_SESSIOND_URL` | Web/API env | Not supported locally | Restart web/API |
| Projects storage file | — | `PI_WEBUI_PROJECTS_FILE` | Web/API + session daemon env | Not supported locally | Restart services; advanced state override |
| Remote machines storage file | — | `PI_WEBUI_MACHINES_FILE` | Web/API env | Not supported locally | Restart web/API; advanced state override |
| Agent profile session storage directory | — | `PI_WEBUI_AGENT_SESSION_DIR` (`PI_CODING_AGENT_SESSION_DIR` for Pi compatibility) | Session daemon env | Not supported locally | Restart session daemon; env-only session storage override |
| Agent profile state directory | — | `PI_WEBUI_AGENT_DIR` (`PI_CODING_AGENT_DIR` for Pi compatibility) | Web/API + session daemon env | Not supported locally | Restart services |
| Skip update checks | — | `PI_WEBUI_SKIP_VERSION_CHECK`, `PI_WEBUI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_OFFLINE` | Web/API env | Not supported locally | Restart web/API after env changes |

## Key details

### Managed data directory

`PI_WEBUI_DATA_DIR` sets the root for PI WEBUI-managed runtime state and defaults to `~/.pi-webui`. Unless a more specific path override is configured, PI WEBUI stores its project and machine registries (`projects.json` and `machines.json`), remembered starter model policy preferences (`starter-model-policy-preferences.json`, see [Model tiers](#model-tiers)), locally discovered plugins, default session-daemon socket, and session archives beneath this root.

This managed state is not the user-editable config API. Edit it through PI WEBUI rather than by hand.

This setting does not change the PI WEBUI config file selected by `PI_WEBUI_CONFIG` or Pi-owned state such as the active session files selected by `PI_CODING_AGENT_SESSION_DIR`.

### External path access

`pathAccess.allowedPaths` grants PI WEBUI's file explorer and absolute `@` path completions access to specific filesystem roots outside the current workspace.

By default, workspace-relative file reads stay inside the workspace and absolute paths are denied. Add only roots you trust PI WEBUI to list and read through the browser UI.

Accepted root forms:

- Unix absolute paths: `/opt/reference`
- Home-relative paths: `~/SDKs`
- Windows absolute paths on Windows hosts: `C:\Users\dev\SDKs`

When an absolute request is served, PI WEBUI expands `~`, canonicalizes the configured roots with `realpath`, requires roots to be existing directories, and rejects symlink escapes outside the allowed roots.

In **Settings → General**, external filesystem roots are saved on the selected machine. Gateway host, port, and allowed-hosts fields stay on the gateway config.

This is not a sandbox for the underlying Pi Coding Agent or your OS user. It only controls PI WEBUI UI/API file exposure outside a workspace.

### Manual upload defaults

The Files panel can upload one or more files in two ways:

- Drop files onto the Files panel to upload immediately to the workspace-effective default folder.
- Use the toolbar **Upload** button to open the review dialog, edit the destination, and opt into upload options.

`uploads.defaultFolder` sets the workspace-effective default destination. The built-in default is `.pi-webui/uploads`; a global config value applies to every project unless `<project>/.pi-webui/config.json` sets a project-local override.

```json
{
  "uploads": {
    "defaultFolder": "manual/uploads"
  }
}
```

The value must be a non-empty workspace-relative folder. PI WEBUI normalizes repeated separators and backslashes to `/`, and rejects absolute paths or `..` traversal. In the upload dialog only, clearing the destination field uploads that batch to the workspace root.

Manual uploads use the workspace file-write path: paths stay workspace-relative, parent folder creation is enabled by default, and overwrite is disabled by default. Direct drag/drop always keeps `overwrite` off; the review dialog lets you explicitly enable overwrite when needed. Browser-owned XHR progress is shown per batch/file, conflicts and errors stay visible in the upload progress UI, and the final file-write response is the source of truth.

For machine federation, Settings saves the global upload default on the selected machine. Current remote PI WEBUI servers also return `workspace.effectiveConfig.uploads.defaultFolder` on the existing workspace-list response. Older remote servers can omit that optional field without breaking clients; the Files panel falls back to the global/default upload folder.

The per-request size limit is still controlled by `maxUploadBytes` / `PI_WEBUI_MAX_UPLOAD_BYTES` on the machine serving the upload.

### Pi-compatible agent profile and companion CLI

`agent.command` selects the Pi-compatible companion CLI used by `pi-webui doctor` and, when it can be generated safely, package-managed update commands. It defaults to `pi`. This setting does **not** replace the embedded runtime: every session continues to use PI WEBUI's bundled Pi SDK.

`agent.dir` selects the Pi-compatible state profile used for auth providers, models, settings, sessions, Pi packages, and Pi-package-backed PI WEBUI plugin discovery. It defaults to `~/.pi/agent` only for a canonical Pi companion command. The directory must use the data layout supported by the bundled Pi SDK; PI WEBUI does not load or convert incompatible fork formats, migrate profile data, or repartition PI WEBUI-managed archives when the profile changes.

```json
{
  "agent": {
    "command": "pi-lab",
    "dir": "/opt/pi-profiles/lab"
  }
}
```

An alternate command always requires an explicit state directory. The command must be a safe bare executable name such as `pi-lab` or a host-absolute executable path such as `/opt/pi/bin/pi`; relative paths, shell expressions, and launcher strings are rejected. The state directory must be host-absolute or start with `~`. In a federated save, the gateway transports Unix and Windows absolute paths without reinterpreting them, and the target machine validates and returns the persisted profile.

Environment variables take precedence over the config file. `PI_WEBUI_AGENT_COMMAND` selects the companion CLI, `PI_WEBUI_AGENT_DIR` sets the profile state directory, and `PI_WEBUI_AGENT_SESSION_DIR` overrides session storage separately from `agent.dir`. The legacy `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` names apply only to a canonical Pi companion command; PI WEBUI never derives ambient environment-variable names from an arbitrary command. Use the explicit `PI_WEBUI_AGENT_*` names for alternate commands. `PI_WEBUI_AGENT_DIR` is an unconditional override, while a legacy `PI_CODING_AGENT_DIR` override stops applying when Settings selects an alternate command so the command and directory can transition together.

The session daemon resolves the persisted desired values plus its environment once at startup. That secret-free active profile stays fixed for the daemon lifetime. **Settings → Session daemon** saves command and directory together as desired configuration and shows whether the profile is active, needs a restart, or cannot be compared. Until the daemon restarts, sessions, Pi package operations, package-backed plugin discovery, status/install detection, and update planning continue to use the daemon-owned active profile; a web/API restart recovers that same active profile instead of applying the newly saved values.

If the session daemon cannot report a valid active profile, profile-dependent package and plugin operations report unavailable instead of falling back to independently resolved config. A package-managed update command is shown only when PI WEBUI can preserve the active profile with a recognized, safe Pi companion CLI; otherwise the command is omitted. Remote profile editing likewise requires advertised support, and the gateway rejects a remote save if the target does not return the requested profile. Restart the session daemon on the selected machine to establish the next active profile.

### Models and skills

The navigation footer exposes **Models** for the selected machine and **Skills** after you select a workspace. **Models** edits custom providers and model settings in that machine's Pi-compatible profile `models.json`. Saving reloads model configuration in the session daemon, and the dialog can send a small authenticated request to test a configured model. For a provider with a Base URL, **Fetch models** retrieves its current model catalog using the unsaved provider draft and credentials on the selected machine. The fetched catalog is scoped to that provider for the open dialog: Model ID becomes a selector, and choosing a model fills its editable display-name default. Use **Refresh models** after changing provider settings or when the provider's catalog changes. This is Pi profile state, not a PI WEBUI config-file key.

**Skills** lists the skills available to the selected workspace. It can toggle the `disable-model-invocation` frontmatter setting in a `SKILL.md`, search skills.sh, and install or update skills at global or project scope. Review third-party skill sources before installing them. After changing, installing, or updating a skill, use `/reload` in each idle session that should pick up the changed resource.

### Model tiers

`modelTiers` is a machine-global setting stored in `$PI_WEBUI_CONFIG` or `~/.config/pi-webui/config.json` that configures tier-based model routing for sessions.

In **Settings → Model tiers**, you edit one complete six-rung ladder: `economy`, `fast`, `standard`, `advanced`, `capable`, and `frontier`.

- **Row configuration:** Each row selects an authenticated model available on that machine (provider and model ID) and a supported thinking level (such as `off`, `low`, `medium`, `high`, or `max`).
- **Duplicate tuples:** Selecting the same model and thinking level tuple in multiple tiers is valid (for example, using the same fallback model across `economy` and `fast`).
- **Stale models:** If a configured model or provider is no longer in the authenticated model catalog, it remains visible as a stale entry in the ladder editor and must be explicitly repaired before saving.
- **Atomic validation:** Save validates all six rows atomically against the authenticated model catalog. Invalid or incomplete ladder configurations are rejected without silent clamping or fallback.
- **Missing or malformed ladder:** If `modelTiers` is missing or malformed, Exact-mode model selection remains fully usable, but tiered model routing becomes unavailable.
- **Machine federation:** Model tier settings are saved for the selected machine. Editing remote machine settings requires a remote daemon advertising the additive `settings.modelTiers` capability.

Sessions can also use a per-session model policy from the composer:

- **Composer controls:** The composer action row has three cascading controls: a mode pill, a mode-dependent second control, and an Exact-only thinking menu. The mode pill opens a two-item mode menu: **Exact model** with the hint "Choose a model and thinking level", and **Tiered** with the hint "Use a configured model tier". A checkmark marks the current mode. There is no policy panel or Save button.
- **Exact fallback:** With no remembered starter preference, a new root starts in Exact mode using Pi's persisted model and thinking defaults. Selecting Exact remembers the mode while retaining the last selected tier for a later switch back.
- **Exact controls:** The second control is the searchable model picker, and the third is a thinking level menu whose trigger is a bar gauge showing the current level's rank, with the level name in its tooltip. The menu lists levels relevant to the selected model in canonical ascending order: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A level the model does not support stays visible but dimmed, says `unsupported by this model`, and cannot be selected. An Exact change applies once both a model and a supported thinking level are selected.
- **Remembered starter policy:** A valid starter mode and tier are remembered per workspace on the selected machine. Starter selections update this personal managed state immediately; changes inside an existing session do not change future-session defaults.
- **Tiered:** In Tiered mode, the second control is a tier menu listing all six ladder tiers. An unusable tier stays visible with its specific reason inline instead of being hidden, and selecting a valid tier applies immediately. No thinking control renders in Tiered mode; it is absent rather than disabled. Switching modes is non-destructive in both directions: the remembered tier and the remembered Exact model/thinking selection stay intact.
- **Validation and recovery:** A remembered Tiered choice whose current mapping is unavailable remains selected and blocks Start until the user chooses a valid tier, switches to a complete Exact branch, or repairs the ladder. PI WEBUI never substitutes another tier or Exact mode.
- **Persistence failures:** If PI WEBUI cannot read the preference, a complete Exact starter remains usable and the composer shows the preference error. If a write fails, the current session still starts with the selected in-memory policy but PI WEBUI warns that the choice was not remembered.
- **When changes are available:** You can change a policy only while its session is idle and writable. During active work and for archived sessions, the current policy and any block reason remain visible but the controls are disabled. Once the session is idle and writable, a blocked policy remains repairable through an explicit update.
- **Availability and compatibility:** Per-session policy uses `sessions.modelPolicy`; persisted starter mode/tier additionally requires `sessions.modelPolicyDefaults` on both web and session daemon. Older peers keep the previous in-memory starter behavior.
- **Managed state and concurrency:** Preferences live in `$PI_WEBUI_DATA_DIR/starter-model-policy-preferences.json` on the selected machine. One daemon serializes complete read-modify-write operations; atomic file replacement prevents partial JSON. Concurrent tabs therefore use last-successful-write-wins semantics in daemon queue order, not browser click order or cross-process locking.
- **Starting and persistence:** The selected policy is carried into root-session creation from both the first-prompt and **New Session** paths, persists with that session, and remains selected after a failed creation so a retry uses the same choice.
- **Scope and installation:** This release does not add `/tier-*` commands, and editing the tier ladder later does not automatically remap an existing Tiered session. After installing this release, restart `pi-webui-sessiond.service` manually once; ordinary UI/API autoreload does not load session-daemon changes.

### Session daemon tools

`spawnSessions` controls whether agents receive the `spawn_session` tool. It defaults to `true`; set it to `false` if you do not want an agent to start independent PI WEBUI sessions.

`subsessions` is beta and controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, and `yield_to_subsessions`. It defaults to `false` and also requires `spawnSessions` to be enabled.

Tracked subsessions are join-oriented. Calling `spawn_subsession` returns immediately, so the parent can continue independent work while the child runs. Work whose result the parent does not need to join belongs in the fire-and-forget `spawn_session` tool instead.

At a join point, after finishing its independent work, the parent calls `yield_to_subsessions` alone as the final action in its tool batch. Pi ends a tool batch early only when every result in that batch is terminating. If any tracked child is still working, the action ends the current agent run so the parent becomes idle. If none are working, it does not end the run and clearly reports that there is nothing to wait for.

A completion notice wakes an idle parent or queues behind in-flight work. Each notice lists any other tracked children still working, so the parent can continue work or call `yield_to_subsessions` again at the next join point. Further notices arrive automatically; do not poll. The notice includes the child's final output when it fits. If that output is too long, PI WEBUI omits it entirely instead of adding a truncated duplicate to the parent's context and directs the parent to retrieve it with `check_subsession`.

`list_subsessions`, `check_subsession`, and `read_subsession` never yield or change control flow. They are for deliberate inspection or recovery, not completion polling. While a child works, agent-facing `check_subsession` and `read_subsession` withhold partial output and direct the parent to continue independent work or yield at the join point. Output becomes available when the child stops. Included output and transcripts follow a labeled marker and come last, after PI WEBUI guidance.

In **Settings → Session daemon**, these keys are saved on the selected machine. Restart the session daemon on that machine after changing them.

### Plugin config

The `plugins` key is only for PI WEBUI browser plugin enablement/settings on the machine whose config you are editing. It does not install, remove, or update Pi packages; use **Settings → Pi packages** or Pi's package manager for package operations. In a federated setup, **Settings → PI WEBUI plugins** and **Settings → Pi packages** both target the currently selected machine, and each panel labels where changes will be saved or run.

Plugins are enabled by default. Set `plugins.<id>.enabled` to `false` to remove a plugin from that machine's `/pi-webui-plugins/manifest.json` before the browser imports it. Settings lists discovered plugins from the selected machine, including disabled entries exposed by that machine.

```json
{
  "plugins": {
    "workspace-tasks": { "enabled": true, "settings": {} },
    "updates": { "enabled": false }
  }
}
```

Reload the browser tab after changing plugin enablement. Already-loaded plugin JavaScript is not unloaded from the current page.

### Shortcut config

Shortcut values are keyed by action id. Values are shortcut strings such as `mod+k` or `mod+g p`; `null` disables that action's shortcut.

```json
{
  "shortcuts": {
    "core:view.chat": "mod+1",
    "core:session.stop": null
  }
}
```

Prefer Settings → Keyboard for editing shortcuts interactively.

## Optional completion tools

File and path `@` completions work without extra tools. If `fzf` is available on the PI WEBUI server's `PATH`, PI WEBUI uses it to improve completion filtering/ranking; otherwise it falls back to built-in ranking.
