# PI WEBUI configuration reference

PI WEBUI configuration covers the machine-local and project-local settings you usually need: the web/API bind address, trusted development-host settings, UI preferences, plugin enablement, file-explorer path access, manual upload defaults, upload limits, Pi-compatible agent profiles and companion CLIs, and session-daemon tools.

This file is the markdown reference for agents and package consumers. The website page is <https://pi-webui.dev/config>.

## Config files

PI WEBUI uses two config files:

- **Global PI WEBUI config:** `$PI_WEBUI_CONFIG`, or `$XDG_CONFIG_HOME/pi-webui/config.json`, or `~/.config/pi-webui/config.json`.
- **Project-local PI WEBUI config:** `<project>/.pi-webui/config.json` for commit-able project settings.

Each PI WEBUI machine has its own config. When using Fleet/machine federation, Settings uses the selected machine for config that affects work running there: the Pi-compatible agent profile and companion CLI, session daemon tools, model tier routing ladder, utility model routing, PI WEBUI plugin enablement, external path access, and upload defaults. Gateway/browser-only settings stay local to the gateway: keyboard shortcuts, speech input (dictation), remote machine registry/tokens, and gateway host/port/allowed-hosts. Remote servers that do not advertise selected-machine settings support report those settings as unavailable instead of silently falling back to the gateway.

Pi package settings are separate from PI WEBUI config. They live in Pi's package-manager settings on the target machine and are managed by Pi (`pi install`, `pi remove`, `pi update`) or **Settings → Pi packages**. In a federated setup, **Settings → Pi packages** targets the currently selected machine. The PI WEBUI `plugins` config key only enables or disables discovered PI WEBUI browser plugins on the machine whose config you are editing; it does not install, remove, or update Pi packages.

If you installed services with a custom config path, rerun `pi-webui install --config /path/to/config.json` after changing that path or after upgrading from a version that only applied the custom path to the web service. This regenerates service files so the web/API and session daemon use the same `PI_WEBUI_CONFIG`.

The same applies to a custom managed data directory: a nonempty `PI_WEBUI_DATA_DIR` present when you run `pi-webui install` is resolved and pinned into both generated process-owner services. If you change either setting, rerun `pi-webui install` before restarting so the web/API process and session daemon keep resolving the identical config file and managed-state root.

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
- `utilityModels`: saved settings apply immediately in **Settings → Utility models**; existing sessions use updated values on their next utility operation.
- `tts`: saved voice/rate settings apply to the next utterance; no service restart required.
- `speechInput`: saved provider, language, and cloud settings apply to the next dictation run; no service restart required for saves. Installing or updating this feature requires one manual `pi-webui-sessiond.service` restart because both services adopt the shared config-mutation coordinator.
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
  "utilityModels": {
    "lightweight": {
      "provider": "anthropic",
      "id": "claude-haiku",
      "thinkingLevel": "low"
    },
    "context": {
      "provider": "anthropic",
      "id": "claude-sonnet"
    }
  },
  "tts": {
    "voice": "en-US-Test",
    "rate": 20
  },
  "speechInput": {
    "provider": "auto",
    "language": "en-US",
    "cloud": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini-transcribe",
      "apiKey": "$OPENAI_API_KEY"
    }
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

Rows with JSON key `—` are runtime-only environment variables, not config-file keys. `Global` means machine-global. In Settings, selected-machine-safe global keys (`pathAccess`, `uploads`, `maxUploadBytes`, `agent`, `spawnSessions`, `subsessions`, `modelTiers`, `utilityModels`, and `plugins`) are edited for the selected machine; gateway host/port/allowed-hosts, keyboard shortcuts, and machine registry/tokens stay local.

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
| Utility model routing | `utilityModels` | — | Global | Not supported locally | Saved settings apply immediately on the next utility operation; requires remote peer capability `settings.utilityModels` |
| Local gateway text to speech | `tts` | — | Global | Not supported locally | Next utterance after settings save; no service restart |
| Speech input (dictation) | `speechInput` | — | Global (gateway) | Not supported locally | Next dictation run after settings save; installing/updating this feature requires one manual session-daemon restart |
| Plugin enablement/settings and global tasks | `plugins.<id>.enabled`, `plugins.<id>.settings`, `plugins.workspace-tasks.settings.globalTasks` | — | Global | Plugin-owned global settings; Project task catalogs remain in each selected workspace's `.pi-webui/tasks.json` | Reload browser tab / Tasks panel |
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

`$PI_WEBUI_DATA_DIR/config-mutations/` holds a private coordination database PI WEBUI uses to serialize read-modify-write updates to the shared global config file across the web/API process and the session daemon. It contains no config, credential, audio, or transcript data; see [Speech input](#speech-input).

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

### Utility models

`utilityModels` is a machine-global setting stored in `$PI_WEBUI_CONFIG` or `~/.config/pi-webui/config.json`. In **Settings → Utility models**, configure models and thinking levels for utility work on the selected machine. This is separate from **Settings → Model tiers**, which controls session model routing.

- `lightweight` handles automatic titles and requested branch summaries. `context` handles compaction.
- Each row selects one model and one thinking level for every operation routed through that row.
- The UI displays the automatic choice as lowercase `auto`; it is represented by an omitted `thinkingLevel` in config rather than a literal `auto` value.
- `auto` uses `minimal` when the exact selected model supports it, otherwise `off`.
- Explicit options are derived from the selected model's supported levels and may include `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Changing a model resets that row to `auto`. A saved explicit level that the model no longer supports remains visible, blocks save, and causes only that utility slot to be skipped until repaired.
- Title generation and branch summaries try `lightweight`, then the active session model. Compaction tries `context`, then `lightweight`, then the active session model; the Context-to-Lightweight fallback uses each row's own configured level.
- When both settings are unset, existing active-session behavior is preserved. An unset, malformed, unavailable, unauthenticated, authentication-failing, or call-failing candidate advances to the next fallback in its order. The active-session fallback keeps its existing behavior.
- Utility calls never change the selected session model, its thinking level, or Pi's remembered default.
- Version 1 remotes remain model-configurable but require an upgraded runtime for explicit thinking levels.
- Settings target the selected machine. Existing sessions read saved changes on their next utility operation; remote editing requires the additive `settings.utilityModels` capability.

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
- **Default and restoration:** On a fully capable peer, a fresh workspace starts in Tiered mode at Standard. The starter model policy preference restores the full policy for the selected machine and normalized workspace: mode, Exact provider/model/thinking, and remembered tier.
- **Exact controls:** The second control is the searchable model picker, and the third is a thinking level menu whose trigger is a bar gauge showing the current level's rank, with the level name in its tooltip. The menu lists levels relevant to the selected model in canonical ascending order: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A level the model does not support stays visible but dimmed, says `unsupported by this model`, and cannot be selected. An Exact change applies once both a model and a supported thinking level are selected.
- **Remembered starter policy:** Only a root created successfully through **SESSIONS +** owns future full-policy updates to this personal managed state. Imported, prompt-created, spawned, and tracked sessions never become preference sources. Selecting Exact retains the remembered tier for a later switch back.
- **Tiered:** In Tiered mode, the second control is a tier menu listing all six ladder tiers. An unusable tier stays visible with its specific reason inline instead of being hidden, and selecting a valid tier applies immediately. No thinking control renders in Tiered mode; it is absent rather than disabled. Switching modes is non-destructive in both directions: the remembered tier and the remembered Exact model/thinking selection stay intact.
- **Validation and recovery:** Unavailable active intent remains selected, blocks Start, and shows its specific reason until the user repairs that active branch. Intent remembered in the inactive branch is retained and non-blocking until that branch becomes active. PI WEBUI never substitutes another tier or Exact mode. A refused Start reports its reason without closing the new-session screen, and the reason is shown whether or not a session is currently selected in that workspace. The message follows the current reason and disappears once the block is repaired.
- **Persistence failures:** If PI WEBUI cannot read the preference, it shows the preference error without discarding the in-memory policy. A writeback failure is non-blocking: the current session retains its selected policy, and PI WEBUI warns that the choice was not remembered.
- **When changes are available:** You can change a policy only while its session is idle and writable. During active work and for archived sessions, the current policy and any block reason remain visible but the controls are disabled. Once the session is idle and writable, a blocked policy remains repairable through an explicit update.
- **Availability and compatibility:** Per-session policy uses `sessions.modelPolicy`; restoring and writing back the full starter preference additionally requires `sessions.modelPolicyStarterSelection` on both web and session daemon. `sessions.modelPolicyDefaults` remains the version-one mode/tier preference path. Older peers retain version-one behavior.
- **Managed state and concurrency:** Preferences live in `$PI_WEBUI_DATA_DIR/starter-model-policy-preferences.json` on the selected machine. One daemon serializes complete read-modify-write operations; atomic file replacement prevents partial JSON. Concurrent tabs therefore use last-successful-write-wins semantics in daemon queue order, not browser click order or cross-process locking.
- **Starting and persistence:** The selected policy is carried into root-session creation from both the first-prompt and **New Session** paths, persists with that session, and remains selected after a failed creation so a retry uses the same choice.
- **Scope and installation:** This release does not add `/tier-*` commands, and editing the tier ladder later does not automatically remap an existing Tiered session. Installing this change requires one manual `pi-webui-sessiond.service` restart; ordinary UI/API autoreload does not load session-daemon changes.

### Local gateway text-to-speech

PI WEBUI can read assistant replies aloud through the operating-system speech service on the machine running the local gateway. The browser is only the control surface: it sends the controls, and audio is audible on the gateway host, not in the browser. The capability is opt-in and local-gateway-only — there is no text-to-speech for remote machines or remote sessions, no browser-native synthesis or browser audio, no audio-file generation, and no online provider account, API key, or engine picker.

On Linux, the gateway host must run the Speech Dispatcher service, and the PI WEBUI web/API process must be able to reach its local socket. If the service is missing or unreachable, the **Listen to assistant reply** action and the settings card stay visible but disabled with the availability reason. PI WEBUI treats speech as an opaque OS capability: Speech Dispatcher output modules may use network-backed services, so playback is not guaranteed to work offline, and PI WEBUI does not report whether the backend is offline or network-backed.

The **Text to speech** card in **Settings → General** appears only while the local gateway is selected:

- **OS voice** selects an installed Speech Dispatcher voice or **System default**.
- **Speech rate** is an integer from `-100` to `100`; `0` is the system's normal rate.
- Eligible assistant replies show a **Listen to assistant reply** icon action that starts speech immediately; the same position becomes **Stop reading assistant reply** while that utterance is active. Stop affects only the utterance PI WEBUI started.

```json
{
  "tts": {
    "voice": "en-US-Test",
    "rate": 20
  }
}
```

The `tts` key is a gateway-only setting in `$PI_WEBUI_CONFIG` or `~/.config/pi-webui/config.json`. It is not a selected-machine key and never applies to remote machines. Omitting the whole object or any field means the system default voice and rate `0`. The object accepts only `voice` (a nonempty string) and `rate` (an integer from `-100` to `100`); unknown keys are rejected. A saved named voice that the OS speech service no longer reports stays configured but is not used: playback falls back to the system default and the settings card marks the saved voice unavailable until you choose another voice. Saving settings does not alter an utterance already in progress; the next utterance uses the saved values, with no service restart required.

Operational notes:

- `SPEECHD_ADDRESS` (Unix hosts only) overrides the Speech Dispatcher socket and must be `unix:` or `unix_socket:` followed by an absolute path; otherwise PI WEBUI uses the standard runtime/cache socket path.
- PI WEBUI speaks at Speech Dispatcher's normal `text` priority. Its speech can cancel lower-priority `notification` or `progress` speech from other Speech Dispatcher clients, and higher-priority speech from another client (such as a screen reader) can cancel PI WEBUI's utterance. That external cancellation returns the message action to Listen and is not an error. PI WEBUI never issues a global Speech Dispatcher stop/cancel that would affect other clients' speech.
- PI WEBUI has no authentication layer: any client that can reach the gateway HTTP surface can trigger audible speech on the host and enumerate its installed voices. Keep the gateway on a trusted network, VPN, tunnel, or behind an authenticated reverse proxy; see [Remote access](https://pi-webui.dev/install#remote-access) and the [reverse proxy deployment example](https://pi-webui.dev/install#reverse-proxy-prefix).

### Speech input

PI WEBUI can turn spoken dictation into editable prompt text in the starter and active-session composers. Dictation only edits the prompt draft at the captured selection: it never sends, queues, steers, or starts anything on its own, and the inserted text is always editable before you act on it. The microphone action sits immediately before Send in both composers, and the agent-work Stop control remains independently available during dictation.

`speechInput` is a gateway-only setting in `$PI_WEBUI_CONFIG` or `~/.config/pi-webui/config.json`. It is not a selected-machine key and never applies to remote machines, and project-local config does not support it. **Settings → General** shows the full-width **Speech input** card regardless of the selected coding machine; dictation and cloud transcription both run on the gateway that serves the browser UI.

```json
{
  "speechInput": {
    "provider": "auto",
    "language": "en-US",
    "cloud": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini-transcribe",
      "apiKey": "$OPENAI_API_KEY"
    }
  }
}
```

The object accepts only `provider` (`auto`, `browser`, or `cloud`; default `auto`), `language` (a BCP 47 tag such as `en-US`; omitted means Auto), `cloud.baseUrl` (HTTPS only; default `https://api.openai.com/v1`), `cloud.model` (default `gpt-4o-mini-transcribe`), and `cloud.apiKey` (a Pi-compatible credential source). Unknown keys are rejected. Stored limits are: language tag 128 characters, base URL 2,048 characters, model 256 characters, and credential source 8 KiB of UTF-8 text. Language validation is syntactic only: it canonicalizes case and structure (`en-us` becomes `en-US`) but stores well-formed tags it cannot verify, so a tag such as `qq-ZZ` is saved and forwarded to the provider, which decides whether it is usable.

The **Speech input** card exposes a Provider select (Auto, Browser, Cloud), a Language input (empty means Auto, which is never sent as a BCP 47 tag), **Cloud base URL**, **Cloud model**, a password-style **API key source** input with literal, `$ENV_VAR`, and `!command` placeholder guidance (never prepopulated; blank means preserve), the redacted credential status, a separate **Clear credential** action that clears only the saved credential, and **Save speech input settings**. Cloud fields stay editable in Auto because Cloud may be the selected fallback candidate.

**Provider selection.** The Settings card offers **Auto**, **Browser**, and **Cloud**.

- **Browser** uses the browser's built-in Web Speech recognition. PI WEBUI does not record or upload audio itself; the browser implementation may process your speech through a browser-vendor service under that vendor's policy.
- **Cloud** records a short audio clip in the browser, uploads it to the PI WEBUI gateway, and the gateway sends it to the configured OpenAI-compatible endpoint (`baseUrl` + `/audio/transcriptions`). Cloud is eligible only when a microphone and `MediaRecorder` are available and the gateway credential status is `resolved` or `unchecked`.
- **Auto** (the default) evaluates providers once, immediately before a run starts, in the order Browser, then Cloud. An explicit Browser or Cloud choice never falls back. Once permission, capture, recognition, upload, or transcription has begun, Auto never changes providers; a failure is shown for the selected provider and retry is user-initiated.
- The resolved provider is visible in the microphone tooltip before capture and in the composer status while active. The microphone stays visible but disabled with the specific reason when the selected provider cannot run.

Dictation, cloud transcription, and settings all require a secure browser context. Loopback `http://127.0.0.1` (and `localhost`) retains the browser's secure-context exemption; any non-loopback deployment must use HTTPS before the microphone or the credential form can be used.

The gateway's authoritative settings are captured once per transcription request. Browser recognition applies the language observed when the run starts; a Cloud transcription uses the gateway's language, model, and base URL at transcription time because the uploaded audio carries no settings override. A Settings save in another tab during recording can therefore affect that Cloud transcription, but never changes the already selected provider or causes fallback.

**Credential sources.** `cloud.apiKey` accepts Pi's documented provider value language:

- literal: `sk-...`;
- environment interpolation: `$OPENAI_API_KEY`, `${OPENAI_API_KEY}`, or interpolation inside a larger value;
- command: a leading `!command`, resolved from the command's trimmed stdout;
- escapes: `$$` produces a literal `$`, and `$!` produces a literal `!` without command execution.

A plain `OPENAI_API_KEY` (no `$`) is a literal, not an environment reference. Missing or empty referenced variables make the source unresolved. Commands execute **only** when a cloud transcription starts, never during settings reads or availability checks: they run uncached as the gateway service account, receive no audio or transcript input, capture at most 64 KiB of stdout, and fail credential resolution after a ten-second total monotonic budget or request cancellation. PI WEBUI best-effort terminates the spawned command's process group/tree, but portable Node APIs cannot reclaim intentionally detached descendants (`setsid`, double-fork, services). Configure only trusted, short-lived commands that do not daemonize.

The settings card shows only a redacted status — **Credential missing**, **Literal credential configured**, **Environment credential resolved/unresolved**, or **Command credential configured; checked when used** — never the source text, the resolved key, an environment name, or command text. The API key field is never prepopulated; the browser holds a newly entered source only in the password input and the in-flight same-origin request, and clears it after a successful save (retaining it after a failure for correction).

**Capture and transcription limits.** Every run is bounded:

- Capture/listening is hard-limited to ten minutes from the provider's successful start.
- Browser recognition is stopped and finalized at the limit; because a recognition instance may never emit its terminal `end` event, a Stop request starts a 2,000 ms settlement watchdog that finalizes accumulated text when it expires.
- Cloud recording stops at ten minutes or exactly 20 MiB (`20 * 1024 * 1024` bytes), whichever comes first, and a chunk that would cross the bound discards the recording rather than truncating encoded audio.
- The gateway admits at most two concurrent transcription requests; a third receives `429` before its body is parsed. Each admitted request has one 130-second admission-to-body-completion deadline, so a stalled or trickled upload is aborted and releases its slot.
- Cloud credential command resolution is bounded to ten seconds, the provider request to 120 seconds (one total budget each, never reset between stages), and the client owns a 130-second Transcribing watchdog covering upload, credential resolution, provider request, and response even if the gateway connection is lost. Combined with the capture limit, a cloud run ends at most 12 minutes 10 seconds after recording starts, excluding user-controlled permission time.
- Accepted recording types are `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4;codecs=mp4a.40.2`, and `audio/mp4`. Other codec/parameter combinations are rejected.
- Every accepted transcript must be nonempty and at most 1 MiB of UTF-8 text.

**Settings concurrency.** Every speech mutation must match the latest opaque revision; a stale tab receives a `409` conflict and performs no write. Saving rotates the revision and tells other tabs (through a nonsecret channel containing only the new revision) to refetch; a burst of notifications requests one trailing refetch so no revision is lost. A dirty form preserves its draft and password, marks itself stale, and requires an explicit reload before retrying. Because a preserved credential cannot be silently redirected to a new endpoint, changing the cloud base URL while a credential is configured requires re-entering a replacement credential source in the same save, or clearing the saved credential first.

**Shared persistence coordination.** Because the autoreloading web/API process and the long-lived session daemon both perform read-modify-write updates on the shared global config file, production config mutations run under a private SQLite transaction mutex. Its database lives at `$PI_WEBUI_DATA_DIR/config-mutations/<config-path-hash>.sqlite` (named by a SHA-256 digest of the resolved global config path), inside a `0700` directory, with the database file tightened to `0600`. It stores only a random opaque speech-input revision and a fingerprint of nonsecret config-file identity metadata — no config, credential, audio, or transcript bytes, and it never hashes file contents. Audio and transcription never touch SQLite. Lock acquisition uses one ten-second monotonic budget; exhaustion surfaces as a typed "config is busy" failure (HTTP `503`) rather than a hang. Selected-machine config patches are forwarded atomically to the target gateway, where that gateway's own coordinator merges them. Manual config-file edits while either service is running are unsupported: stop both services first, then edit, then start them again. Installing this change requires one manual `pi-webui-sessiond.service` restart because the daemon's existing config writes adopt the shared coordinator; ordinary web/UI autoreload does not load that daemon-side change.

**Privacy and security.**

- PI WEBUI does not persist dictated audio, browser interim text, or cloud request bodies. Audio lives only in bounded process memory and browser buffers for the duration of a run; no object URL, download, attachment, workspace file, IndexedDB record, or session entry is created.
- Browser-provider processing may leave the device under the browser vendor's implementation and policy.
- Cloud audio leaves the gateway only for the explicitly configured endpoint, which must be HTTPS with no credentials, query, or fragment; redirects are rejected so audio and the resolved credential cannot be forwarded to another origin. No automatic provider fallback can change that boundary mid-run.
- Audio, transcript text, credential sources, and resolved credentials are excluded from logs and error messages; provider error bodies are never forwarded to the browser.
- PI WEBUI has no authentication layer, and this feature adds none. Treat any client that can reach the gateway HTTP surface as an administrator: it can call transcription, mutate speech settings, redirect the endpoint, replace the credential source, and trigger a configured `!command`. A configured cloud credential is therefore a network-reachable spending capability, and an accepted endpoint receives the resolved credential. Configure cloud transcription only on a gateway restricted to a trusted network, VPN, tunnel, or authenticated reverse proxy, and prefer an environment or command source over a stored literal key when the gateway is shared.

For troubleshooting permission denial, unsupported browsers or codecs, unresolved credentials, no-speech results, timeouts, provider rejections, and config-busy failures, see the [FAQ](https://pi-webui.dev/faq#speech-input).

### Session daemon tools

`spawnSessions` controls whether agents receive the `spawn_session` tool. It defaults to `true`; set it to `false` if you do not want an agent to start independent PI WEBUI sessions.

`subsessions` is beta and controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, and `yield_to_subsessions`. It defaults to `false` and also requires `spawnSessions` to be enabled.

Tracked subsessions are join-oriented. Calling `spawn_subsession` returns immediately, so the parent can continue independent work while the child runs. Work whose result the parent does not need to join belongs in the fire-and-forget `spawn_session` tool instead.

At a join point, after finishing its independent work, the parent calls `yield_to_subsessions` alone as the final action in its tool batch. Pi ends a tool batch early only when every result in that batch is terminating. If any tracked child is still working, the action ends the current agent run so the parent becomes idle. If none are working, it does not end the run and clearly reports that there is nothing to wait for.

A completion notice wakes an idle parent or queues behind in-flight work. Each notice lists any other tracked children still working, so the parent can continue work or call `yield_to_subsessions` again at the next join point. Further notices arrive automatically; do not poll. The notice includes the child's final output when it fits. If that output is too long, PI WEBUI omits it entirely instead of adding a truncated duplicate to the parent's context and directs the parent to retrieve it with `check_subsession`.

`list_subsessions`, `check_subsession`, and `read_subsession` never yield or change control flow. They are for deliberate inspection or recovery, not completion polling. While a child works, agent-facing `check_subsession` and `read_subsession` withhold partial output and direct the parent to continue independent work or yield at the join point. Output becomes available when the child stops. Included output and transcripts follow a labeled marker and come last, after PI WEBUI guidance.

In **Settings → Session daemon**, these keys are saved on the selected machine. Restart the session daemon on that machine after changing them.

### Plugin config

The `plugins` key is for PI WEBUI browser plugin enablement and plugin-owned settings on the machine whose config you are editing. It does not install, remove, or update Pi packages; use **Settings → Pi packages** or Pi's package manager for package operations. In a federated setup, **Settings → PI WEBUI plugins** and **Settings → Pi packages** both target the currently selected machine, and each panel labels where changes will be saved or run.

Plugins are enabled by default. Set `plugins.<id>.enabled` to `false` to remove a plugin from that machine's `/pi-webui-plugins/manifest.json` before the browser imports it. Settings lists discovered plugins from the selected machine, including disabled entries exposed by that machine.

The built-in Workspace Tasks plugin stores its machine-global catalog at the exact nested key `plugins.workspace-tasks.settings.globalTasks`. The value is a version-one task catalog, uses the same task fields as `.pi-webui/tasks.json`, and does not add a scope field to individual tasks:

```json
{
  "plugins": {
    "workspace-tasks": {
      "enabled": true,
      "settings": {
        "globalTasks": {
          "version": 1,
          "tasks": []
        }
      }
    },
    "updates": { "enabled": false }
  }
}
```

If `globalTasks` is absent, Workspace Tasks treats it as the canonical empty version-one catalog. If it is present but malformed, the Tasks panel reports the global catalog as invalid and does not replace it with an empty value. Repair malformed global data through normal PI WEBUI configuration administration, such as a reviewed configuration update or a carefully reviewed config-file change while the relevant service is stopped; do not use the Tasks panel's Project-file reset for global data.

Global reads and writes use an opaque semantic revision for compare-and-swap (CAS). The revision represents the canonical supported task projection: unchanged task content keeps the same revision, a semantic change produces a new one, and replacing a catalog with the same content is a no-op. A stale conditional write is rejected without changing either the catalog or unrelated configuration, so the browser must **Refresh** before trying again. Browser writes canonicalize supported fields and drop unknown fields.

This protection covers coordinated PI WEBUI task mutations, not arbitrary external editors, Git operations, or other processes writing the same files. External conflict detection is best-effort and is not an atomic cross-process CAS guarantee. Promotion and demotion use guarded server-owned recovery: a destination collision or source conflict leaves both catalogs unchanged; an uncertain or partial move requires **Refresh** and, only when offered, **Retry move**. There is no automatic merge, retry, compensation, or overwrite of an unrecognized intermediate state.

Move ownership is process-local. A web/API restart loses ownership of an intermediate move, so the resulting state is manual-resolution-only rather than automatically retried. Run exactly one active web/API route owner for a machine's PI WEBUI config; multiple web/API processes serving the same config are unsupported for guarded moves because process-local recovery is not a distributed lock.

Reload the browser tab after changing plugin enablement or the global task catalog. Already-loaded plugin JavaScript is not unloaded from the current page.

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
