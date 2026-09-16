# Subsessions graduation — Design

- **Status:** Approved (design); round-1 review findings folded in, round-2 confirmation pending
- **Date:** 2026-09-16
- **PM run:** `pm-run-20260916-084204-555d6665`
- **Topic slug:** `subsession-stabilization`
- **Delivery target:** `refs/heads/main` @ `7a5ccfbc2d20efbba146a29b3e14cb8518a51969`
- **Related user request:** "Stabilize the subsession functionality (remove Beta) and enable it by default."

## Background

Tracked subsessions shipped as a Beta capability held behind their own session-daemon
setting so the feature could land on `main` without reaching releases. The capability is
now considered stable, so the Beta framing and the off-by-default setting are removed.

The capability's full surface:

| Element | Location |
| --- | --- |
| Default resolver | `src/config.ts` — `subsessionsEnabled()` |
| Effective-config assembly | `src/config.ts` — `effectivePiWebUiConfig()` |
| Config request/response + env overrides | `src/server/configRoutes.ts` |
| Daemon wiring | `src/server/sessiond.ts` |
| Tool gating and runtime comments | `src/server/sessions/piSessionService.ts` |
| Settings panel field | `src/client/src/components/settings/SettingsSessiondPanel.ts` |
| Browser API type | `src/shared/apiTypes.ts` |
| Documentation | `docs/config.md`, `docs/config.html`, `docs/install.html`, `docs/optional-skills.md` |

The setting is machine-global on the session daemon, overridden by
`PI_WEBUI_SUBSESSIONS`, and is already listed in the configuration matrix as requiring a
session-daemon restart. It additionally requires `spawnSessions`, which already defaults
to `true`.

Tool family governed by the flag: `spawn_subsession`, `list_subsessions`,
`check_subsession`, `read_subsession`, `yield_to_subsessions` — plus `get_model_policy`,
which `piSessionService.ts:996-1010` registers in the same tool batch and whose `inspect`
dependency is supplied only when `subsessionsActive` (`:1405-1409`). `CHANGELOG.md:260`
already documents that pairing ("registered only alongside the subsession tools"), so the
setting governs six tools, not five.

## Goals

1. Make subsessions on by default for every install that does not explicitly opt out.
2. Remove the Beta marker and Beta framing from code comments, UI, and documentation.
3. Keep the setting, its environment variable, and the Settings toggle as a working
   opt-out, with unchanged precedence and unchanged `spawnSessions` coupling.

## Non-goals

- Decoupling `subsessions` from `spawnSessions`.
- Removing the `subsessions` config key, the `PI_WEBUI_SUBSESSIONS` environment variable,
  or the Settings toggle.
- Any change to subsession tool behavior, transcript handling, notifications, joining, or
  the yield protocol.
- Any `README.md` change: subsession behavior is detailed configuration material and
  belongs in `docs/config.*` per the documentation guide.
- Any `CHANGELOG.md` edit: release notes are generated from Changesets at release time.

## Behavior contract

| Configuration | Before | After |
| --- | --- | --- |
| Nothing set | disabled | **enabled** |
| `subsessions: false` | disabled | disabled |
| `subsessions: true` | enabled | enabled |
| `PI_WEBUI_SUBSESSIONS=0` with config `true` | disabled | disabled |
| `PI_WEBUI_SUBSESSIONS=1` with config `false` | enabled | enabled |
| `spawnSessions` disabled | subsessions unavailable | subsessions unavailable |
| Settings checkbox, nothing set | unchecked | checked |
| Settings help text | "Off by default." | "On by default." |
| Heading badge | `beta` pill | none |

Precedence is unchanged: a non-empty `PI_WEBUI_SUBSESSIONS` value wins over the config
file; otherwise the config file value applies; otherwise the new default `true` applies.

**Upgrade consequence:** an install that never set the key begins exposing the governed
tool family — the five subsession tools and the paired `get_model_policy` — to agents once
its session daemon restarts. This is the intent of the request and is called out in the
Changeset text. Explicit `false` in the config file or environment remains the escape
hatch.

## Design

### Default resolution

`subsessionsEnabled()` mirrors `spawnSessionsEnabled()` exactly, differing only in its
environment variable name. The change is one token:

```diff
 export function subsessionsEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebUiConfig = {}): boolean {
   const fromEnv = env["PI_WEBUI_SUBSESSIONS"];
   if (fromEnv !== undefined && fromEnv !== "") return fromEnv === "1" || fromEnv.toLowerCase() === "true";
-  return config.subsessions ?? false;
+  return config.subsessions ?? true;
 }
```

`effectivePiWebUiConfig()` continues to resolve the value once, in one place, so the
runtime state, the Settings toggle, and the effective-config summary all read the same
resolved boolean within one process. A web/API process and a session-daemon process still
resolve it independently — see Rollout.

### Runtime gating

`PiSessionService` keeps its existing gate:

```ts
const subsessionsActive = this.spawnTargets !== undefined && deps.subsessionsEnabled === true;
```

Only the explanatory comments change. When `subsessionsActive` is false the tracked
subsession tools and the paired `get_model_policy` tool are absent from the tool set;
`spawn_session` is unaffected.

### Settings panel (recorded UI decision)

Three field arrangements were rendered in the brainstorming companion and the user chose
**Variant A — symmetric standalone field**: badge removed, structure identical to the
adjacent "Allow agents to start sessions" field, copy rewritten. Rejected alternatives:

- **B — one grouped "Agent delegation" section:** nested checkboxes under a single shared
  explanation; would restructure a control users already know and invalidate the panel's
  layout assumptions for no user benefit.
- **C — standalone field with a neutral "requires sessions" chip:** repurposes the badge
  slot to surface the dependency; adds persistent chrome for a constraint the help text
  already states.

Companion mockup artifact (gitignored, local only):
`integration/.superpowers/brainstorm/638097-1789520057/content/subsession-field-layout.html`

Rendered result for the subsession field:

```text
ALLOW AGENTS TO START TRACKED SUBSESSIONS
[x] Enable the spawn_subsession tools
    When enabled, agents can start child sessions they stay attached to
    (spawn_subsession, list_subsessions, check_subsession, read_subsession) and are
    notified when a child finishes. Requires "Allow agents to start sessions".
    On by default.
```

Changes to `SettingsSessiondPanel.ts`:

1. Remove `<span class="beta-badge">beta</span>` from the field heading.
2. Remove the `.beta-badge` CSS rule — it has no other consumer.
3. Replace the help copy with this exact final string (the `<code>` elements around each
tool name are preserved from the current markup):

```text
When enabled, agents can start child sessions they stay attached to
(spawn_subsession, list_subsessions, check_subsession, read_subsession) and are
notified when a child finishes. Requires "Allow agents to start sessions".
On by default.
```

   The four-tool list is deliberate and matches today's copy: `yield_to_subsessions` is
   not named in this short Settings string even though `docs/config.*` enumerates it, and
   `get_model_policy` is likewise not named because it is an inspection aid rather than a
   subsession action. Adding a tool name here is a copy change the user has not approved.
4. Update the field comment from "Beta, off by default; also requires spawn to be
   enabled." to "On by default; also requires spawn to be enabled."

### Beta-marker inventory

Every site that carries the Beta or off-by-default framing, with its replacement. This
list is the falsifiable form of Goal 2; the diff must leave no Beta framing behind in the
subsessions surface.

| Location | Current | Replacement |
| --- | --- | --- |
| `src/config.ts:196` | `// Beta capability, resolved off by default.` | `// On by default, like spawnSessions; resolved here so the effective config is the single source of truth.` |
| `src/config.ts:616-622` | JSDoc "Beta: … Off by default while the capability stabilizes …" | "On by default; whether LLMs may start tracked child sessions via the `spawn_subsession` family. Disable with the env var `PI_WEBUI_SUBSESSIONS` or the `subsessions` config key; the env var takes precedence. Subsessions also require `spawnSessions` to be enabled." |
| `src/shared/apiTypes.ts:473-476` | "Beta: when true, … Off by default while the capability stabilizes." | "When true, LLMs can start tracked child sessions via the `spawn_subsession` family of tools. On by default; requires `spawnSessions` to be enabled." |
| `src/server/sessions/piSessionService.ts:1155-1160` | "Beta: when true (and `spawnTargets` is provided), the tracked-subsession tools … Off by default so the capability can ship in main without being exposed in releases." | "When true (and `spawnTargets` is provided), the tracked-subsession tools and the paired `get_model_policy` tool are available to sessions whose creation provenance permits delegation. Omit to keep the capability disabled." |
| `src/server/sessions/piSessionService.ts:1371-1372` | "Subsessions are a beta capability gated behind their own flag …" | "Subsessions have their own flag and also require the spawn capability (they share its project-scope resolver)." |
| `src/client/src/components/settings/SettingsSessiondPanel.ts:48` | `// Beta, off by default; also requires spawn to be enabled.` | `// On by default; also requires spawn to be enabled.` |
| `src/client/src/components/settings/SettingsSessiondPanel.ts:130` | `<span class="beta-badge">beta</span>` | removed |
| `src/client/src/components/settings/SettingsSessiondPanel.ts:142` | "Beta: agents can start child sessions … Off by default." | exact string specified above |
| `src/client/src/components/settings/SettingsSessiondPanel.ts:237` | `.beta-badge { … }` CSS rule | removed (no other consumer) |
| `src/config.test.ts:871-873` | `it("is off by default while the capability is in beta" …)` expecting `false` | renamed to "is on by default when nothing is configured", expecting `true` |

The effective-config summary row (`Subsessions` / `Enabled` / `Disabled`) is unchanged and
follows the resolved boolean. The checkbox remains disabled while `spawnSessions` is off
or when the environment overrides the value.

## Error handling

No new error paths. The existing behavior is preserved:

- A non-boolean `subsessions` value is rejected by the config parser, the config routes,
  and the strict browser API parsers with their current messages.
- An unrecognized `PI_WEBUI_SUBSESSIONS` value resolves to `false`
  (`fromEnv === "1" || fromEnv.toLowerCase() === "true"`), unchanged from today.
- The governed tool family stays unavailable when the session daemon runs without spawn
  targets, regardless of the setting.

## Documentation

| File | Change |
| --- | --- |
| `docs/config.md` | Example config `"subsessions": false` → `true`; matrix row label "Tracked subsessions (beta)" → "Tracked subsessions"; section text drops "is beta" and "defaults to `false`" in favor of "defaults to `true`", and the tool enumeration at `:430` adds `get_model_policy`. The join/yield/notice paragraphs are unchanged. |
| `docs/config.html` | Synchronized copies: example card, matrix row, `subsessions` section text, and the tool enumeration at `:1063` adding `get_model_policy`. |
| `docs/install.html` | "Common config" example `"subsessions": false` → `true`, matching the adjacent `"spawnSessions": true`. |
| `docs/optional-skills.md` | Requirements line "Pi with subagent support, and `subsessions` enabled in your PI WEBUI config." no longer implies an opt-in step: state that tracked subsessions are enabled by default and require `spawnSessions`. |
| `README.md` | Unchanged. |

## Test strategy

Per the testing guide, behavior is pinned at the lowest layer that owns it, and static
labels/layout are not asserted by scraping Lit templates.

1. **`src/config.test.ts` — `subsessionsEnabled` suite (primary pin):**
   - the existing case `it("is off by default while the capability is in beta")`
     (`src/config.test.ts:871-873`, currently `expect(subsessionsEnabled({}, {})).toBe(false)`)
     is rewritten to expect `true` and renamed — its title is itself Beta framing;
   - explicit config opt-out (`{ subsessions: false }` → `false`);
   - environment override in both directions (unchanged cases).
2. **`src/config.test.ts` — effective config:** add
   `expect(effectivePiWebUiConfig(testOptions()).config.subsessions).toBe(true)` next to
   the existing effective-default assertions (uploads, tts), so the boolean the session
   daemon actually consumes is pinned and not only the resolver. `spawnSessions` has no
   such assertion today; this addition does not change that.
3. **Existing suites:** no other suite is expected to fail. Both review rounds verified
   that every other fixture sets explicit values (`configRoutes`, `SettingsDialog.sessiond`,
   `SettingsSessiondPanel`, `settingsSessiondConfig`, `app.testSupport`), and that
   `src/config.test.ts:871-873` is the only default-dependent assertion. The implementer still
   runs the broad suite and lets real failures surface rather than pre-emptively editing
   fixtures.
4. **Not tested by assertion:** the Beta badge removal and the help copy. The panel suite
   documents that it asserts dynamic behavior through public seams (`sessiondPanelNotices`,
   `sessiondDescription`, save callbacks) and intentionally not static labels. Verification
   is a rendered check plus diff review at audit time.

## Release artifact

One Changeset for `@hyperdreamer/pi-webui` at **minor**:

> Enable the tracked-subsession tools (`spawn_subsession`, `list_subsessions`,
> `check_subsession`, `read_subsession`, `yield_to_subsessions`) and the paired
> `get_model_policy` tool by default. The `subsessions` session-daemon setting now
> defaults to `true`; disable it with `subsessions: false` or
> `PI_WEBUI_SUBSESSIONS=0`. The new default applies after the session daemon on each
> machine restarts.

Minor is correct: this is a backward-compatible capability enabled by default, not a
removal or a breaking narrowing. `CHANGELOG.md` is not edited.

## Rollout

The default is read when a process resolves the configuration, and the web/API process and
the session daemon resolve it independently (`configRoutes.ts` for the API response,
`sessiond.ts:138` for the live runtime). Two consequences:

1. The setting takes effect for agents only after that machine's session daemon restarts.
   Until then the live daemon keeps the previous value while the API and Settings panel
   already report the new default — Settings can show the checkbox checked and
   `Subsessions: Enabled` while the running daemon still withholds the tools.
2. An install that upgrades and restarts only the web/API therefore sees a checked toggle
   with no capability change until the daemon follows. The configuration matrix row already
   states "Restart session daemon on that machine"; its scope and behavior columns stay
   accurate.

## Verification

1. `npm run verify:fast` for implementer completion — typecheck, lint, `knip`, and the
   4-worker test profile, per `.agents/skills/testing-guide/SKILL.md`.
2. `npm run verify` as the CI-equivalent final gate before the frontier audit.
3. Rendered Settings → Session daemon panel check: checkbox checked with nothing set, no
   Beta pill, "On by default" copy, summary row `Subsessions: Enabled`.
4. Tell the user to restart the session daemon on affected machines — the new default is
   not live in the running daemon until it restarts (AGENTS.md handoff requirement).
5. Frontier implementation audit against this document and the specification.
