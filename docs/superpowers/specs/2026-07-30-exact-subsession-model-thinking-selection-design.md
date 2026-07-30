# Exact subsession model and thinking selection — design

**Status:** Approved specification.

## Goal

Let a parent PI WEBUI session define an exact default model and thinking level for tracked subsessions without changing the parent session's own model or thinking level.

The feature must:

- expose an unobtrusive subsession configuration control in both the pre-session starter composer and an eligible active parent composer;
- let the user choose an exact provider, model id, and supported thinking level rather than a PI WEBUI-defined capability tier;
- initialize a new parent session's child defaults from an exact snapshot of that parent's model and thinking choice;
- persist child defaults with the parent session so browser, web/API, and session-daemon restarts do not lose them;
- let `spawn_subsession` accept an optional exact per-spawn override while otherwise using the parent session's saved child defaults;
- validate model availability and thinking support before creating a child, with no silent model fallback or thinking-level clamping; and
- preserve tracked-subsessions lineage, completion notices, transcript inspection, workspace restrictions, and the existing prohibition on recursive child delegation.

This feature applies only to tracked `spawn_subsession` children. Independent `spawn_session` behavior is unchanged.

## Product decisions

### Exact choices, not routing tiers

PI WEBUI does not define `Fast`, `Standard`, `Capable`, or other model tiers. Those are task-planning concepts that users and skills may apply for themselves. The product exposes the selected machine's exact authenticated models and each model's supported thinking levels.

The persisted value is one atomic pair:

```ts
interface SubsessionModelSelection {
  model: {
    provider: string;
    id: string;
  };
  thinkingLevel: string;
}
```

Model and thinking travel together through browser state, HTTP/session-daemon transport, persisted session entries, tool overrides, validation, child creation, and tool results. Keeping them atomic prevents a model override from accidentally retaining a thinking level that the new model does not support.

### Session defaults, with explicit per-spawn overrides

The parent session owns exact defaults for future tracked children. A `spawn_subsession` call may supply a complete exact override for one child. That override does not mutate the parent's saved defaults.

Resolution order is:

```text
complete exact per-spawn override
  > active branch's persisted parent-session defaults
  > legacy current-parent model and thinking fallback
```

There is no machine-level subsession profile mapping and no project-level configuration key.

### Parent snapshot semantics

Before a parent session exists, the starter's child draft follows the starter's parent model and thinking choice. If the user changes either child field, the child draft becomes independent. **Reset to parent choice** reconnects it while still on the starter.

When the parent session is created, PI WEBUI persists an exact child selection. If the client cannot provide an exact linked value—for example, Pi resolves an unset parent default to its first available model—the server snapshots the newly created parent's actual resolved model and thinking level before the first prompt is delivered.

After creation, the saved child selection is independent. Later parent model or thinking changes do not mutate it. In an active session, **Copy current session settings** writes a new exact child selection; it does not create a dynamic inheritance link.

## Accepted user experience

### Starter composer

The pre-session starter composer keeps its existing parent model and thinking controls. When the selected machine supports exact subsession selection and tracked subsessions are enabled, it also renders a compact branch/subsession icon next to those controls.

Opening the control reveals a focused popover:

```text
Subsession defaults

Model
[ exact provider / exact model id                 ▾ ]

Thinking level
[ one exact level supported by the selected model ▾ ]

[ Reset to parent choice ]
```

Behavior:

1. The hidden draft initially follows the parent model and thinking choice.
2. Parent changes continue to update it while linked.
3. Editing either child field detaches the child draft.
4. Changing the child model preserves the selected thinking level only when the new model supports it. Otherwise the thinking field becomes incomplete and requires an explicit selection.
5. Resetting copies the current parent pair and reconnects the draft until session creation or another child edit.
6. An independently edited, incomplete, or stale selection cannot be submitted silently. The initial prompt and attachments remain intact after validation failure.

The starter remains visually simple: the full form is hidden until the user opens the compact control.

### Ordinary parent composer

An eligible active parent composer reads its saved exact child defaults from live session status.

- When the child defaults equal the parent's current model and thinking, render only the compact branch icon.
- When they differ, keep the override visible with a chip such as `Children: gpt-5.6-luna · medium`.
- Clicking either form opens the same exact model/thinking form.
- Saving updates the chip only after the server confirms durable persistence.
- Saving remains disabled while the parent has active agent, bash, compaction, or tree-navigation work. The current values remain inspectable, but PI WEBUI does not interleave a configuration entry with an in-flight session mutation.
- **Copy current session settings** copies the parent's current exact pair into a new persisted child selection.

The control is absent when:

- tracked subsessions are disabled;
- the selected machine does not advertise the exact-selection capability;
- the current session is a tracked child and therefore cannot delegate;
- the session is archived; or
- the selected remote peer is an older version without the additive capability.

### Accessibility and responsive presentation

- The trigger's accessible label is **Configure subsession defaults**.
- The popover has a clear heading and visible labels for both fields.
- Native keyboard-operable selectors are preferred.
- Escape closes the popover and restores focus to its trigger.
- Save failures are exposed through an alert/status region while retaining the attempted values.
- Visually truncated provider/model ids remain available through accessible text and a title.
- On narrow screens, the same form renders as a compact modal sheet rather than overflowing the composer.

## Current-state constraints

PI WEBUI already has most of the runtime model path but not the public selection interface:

- `spawn_subsession` currently exposes only `prompt` and `cwd`.
- Its tool executor forwards `ctx.model`, so children silently inherit the parent model.
- `SpawnSubsessionInvocation` and `PiSessionService.spawnSubsession()` already carry a resolved model object into `initialModel`.
- Runtime creation does not currently carry an explicit child thinking level, even though Pi's SDK accepts both `model` and `thinkingLevel` when creating an agent session.
- tracked children already start without delegation tools, preventing recursive spawning.
- the starter already loads Pi's parent-session model/thinking defaults and available models.
- the active composer already renders parent model/thinking controls from `SessionStatus`.
- session managers support versioned custom entries that do not participate in LLM context; tracked-subsessions lineage already uses this persistence mechanism.

The existing starter model control changes Pi's ordinary default model. The new child draft must remain local to the not-yet-created session until session creation; it must not create another global or project setting.

## Architecture

### Deep module: subsession configuration

Introduce a focused server-side `SubsessionConfiguration` module. Its small interface hides model-catalog projection, supported-thinking discovery, exact validation, versioned persistence, active-branch lookup, and fallback resolution.

The module owns:

- `SubsessionModelSelection` and `SubsessionModelOption` domain values;
- the custom entry type and version;
- parsing and serializing persisted selections;
- reading the latest matching defaults entry on the active session branch and distinguishing no entry from an invalid authoritative entry;
- enumerating exact available models and `getSupportedThinkingLevels(model)` results;
- resolving an exact provider/id against the daemon's refreshed available model snapshot;
- validating a thinking level against that resolved model; and
- resolving one spawn's explicit override, saved defaults, or legacy fallback.

Browser components, HTTP routes, and `spawnSubsessionTool.ts` must not duplicate these rules.

A model option has explicit nesting so provider and model id remain unambiguous even when a model id contains `/`:

```ts
interface SubsessionModelOption {
  model: {
    provider: string;
    id: string;
    name?: string;
  };
  thinkingLevels: string[];
}
```

Only models in the selected machine/session daemon's authenticated available snapshot are offered. The child selector is not an automatic ranker and does not infer performance or price.

### Versioned parent-session persistence

Persist each saved parent default as a custom session entry:

```text
customType: pi-webui.subsession.defaults
data:
  version: 1
  model:
    provider: RightCode-OpenAI
    id: gpt-5.6-luna
  thinkingLevel: medium
```

The entry is intentionally excluded from LLM context. Reads inspect the active branch rather than all append-order entries, so a selection on an abandoned branch cannot leak into the current branch.

New parent creation writes an exact entry before delivering the initial prompt. Active updates append another versioned entry through the existing serialized session-entry mutation path, then publish updated status.

A parent created before this feature has no matching entry; it uses its current exact model/thinking as a compatibility fallback until the user saves a selection. No background migration rewrites old session files.

Once a matching custom entry exists, the latest matching entry is authoritative. If that entry is malformed, incomplete, or uses an unsupported version, resolution fails closed with a compatibility/configuration error. PI WEBUI must not revive an older valid entry or fall back to the current parent, because either behavior would silently discard the user's latest persisted intent.

### Runtime creation

Extend the existing one-shot session-creation options from model-only to an atomic model/thinking selection:

```ts
interface StartSessionOptions {
  parentSession?: string;
  initialModel?: AgentModel;
  initialThinkingLevel?: ClientThinkingLevel;
}
```

Carry `initialThinkingLevel` through `CreateSessionRuntimeOptions`, `CreateAgentRuntimeOptions`, `PiWebUiRuntimeFactoryOptions`, `createRuntimeWithOneShotSessionOptions()`, and `createDefaultRuntimeFactory()` into Pi's `createAgentSessionFromServices({ model, thinkingLevel })` call.

The values apply only to the newly created runtime. A later runtime replacement resolves its own saved state, preserving the existing one-shot boundary.

### Tool interface

Add one optional atomic field to `spawn_subsession`:

```ts
spawn_subsession({
  prompt: "Implement the isolated task",
  cwd: "/workspace-feature",
  configuration: {
    model: {
      provider: "RightCode-OpenAI",
      id: "gpt-5.6-luna",
    },
    thinkingLevel: "medium",
  },
});
```

The nested object is optional, but when present all fields are required. Omitting it uses the parent session's saved defaults. Existing stored tool calls remain valid because the change is additive; no deprecated compatibility fields are added to the public schema.

`spawnSubsessionTool.ts` forwards identities, prompt, cwd, and the optional exact input. `PiSessionService.spawnSubsession()` owns target resolution and configuration resolution. It validates the complete effective pair before child creation, then starts the child with both initial values.

The result details and model-facing text report the exact resolved provider, model id, and thinking level. This makes cost/capability decisions observable and prevents an inherited-model surprise.

### Browser modules

Add a dedicated `SubsessionDefaultsControl` Lit module. `PromptEditor` remains layout glue: it supplies the location and passes configuration data/callbacks, but it does not own model catalogs, persistence, or validation.

The control receives:

- whether it is available and editable;
- the exact current selection;
- exact model options with supported thinking levels;
- whether the starter draft is linked to the parent;
- whether a save is running;
- any validation/save error; and
- callbacks for model change, thinking change, reset/copy, save, and close.

Use a small pure starter-draft module to model linked/independent transitions and model/thinking compatibility. `PiWebUiApp` owns the selected starter draft and resets it on machine/workspace changes. The active session's durable selection remains server-owned and reaches the browser through `SessionStatus`.

Model options are loaded when the active-session popover opens, rather than included in every frequently published status update.

## Additive transport contracts

### Capability

Advertise the new effective machine capability:

```text
sessions.subsessionModelSelection
```

Both web/API and session-daemon peers must support the additive routes/types before federation advertises it. Older peers omit the capability, and the client hides the control without issuing unsupported requests.

### Shared values

Add shared transport forms for:

- `SubsessionModelSelection`;
- `SubsessionModelOption`;
- starter subsession availability/options;
- active session status selection; and
- the resolved spawn result.

Wire-level thinking values remain strings so a newer Pi runtime's future level can parse and render without crashing an older browser. The server still validates each value against Pi's live supported set.

### Starter defaults response and session creation

Extend the existing starter session-defaults response additively with tracked-subsession availability and exact options. The starter already requests this resource, so no second eager request is required.

Extend `POST /sessions` with an optional `subsessionDefaults` exact value. The server validates an independent value before persisting it. For the linked/default path, it may snapshot the actual parent session's resolved model/thinking after runtime creation so an unset or unavailable Pi default still produces an exact persisted pair.

### Active session routes and status

Add an optional `subsessionDefaults` field to `SessionStatus`. Omission means the control is unavailable for that session/peer; it is not interpreted as a valid empty selection.

Add active-session read/update routes under the existing session route family:

```text
GET api/.../sessions/:sessionId/subsession-defaults?cwd=...
PUT api/.../sessions/:sessionId/subsession-defaults
```

The GET response supplies the saved exact selection plus exact model options. The PUT accepts one complete selection, validates it, persists it, and returns confirmed state. Saving uses the existing writable-session, active-branch, and serialized session-entry mutation protections. While agent, bash, compaction, or tree-navigation work is active, the browser leaves the values inspectable but disables the mutation. These paths use the existing application-relative browser request boundary and federation/session-daemon proxy conventions.

## Data flow

### Starter

```text
workspace/machine selected
  → load parent session defaults + additive subsession availability/options
  → initialize linked child draft from parent model/thinking
  → parent changes update linked child draft
  → child edit detaches draft
  → start request carries independent exact pair, or linked path requests a server snapshot
  → create parent runtime
  → validate/derive exact child pair
  → append pi-webui.subsession.defaults entry
  → return/select parent session
  → queued initial prompt is delivered
```

A stale response from another machine or workspace cannot replace the current starter draft; existing machine/workspace identity guards remain in force.

### Active parent update

```text
status snapshot includes saved child defaults
  → PromptEditor renders icon or differing-value chip
  → user opens control
  → lazy GET returns current selection + exact options
  → user chooses exact model and supported thinking
  → PUT validates and appends a custom entry
  → server publishes updated status
  → browser replaces chip only after confirmed response/status
```

### Child spawn

```text
parent invokes spawn_subsession
  → resolve and validate optional exact override
  → otherwise read the active branch's authoritative latest matching defaults
  → if that entry is invalid, fail closed
  → otherwise use legacy current-parent fallback only when no matching entry exists
  → resolve target workspace
  → refresh available model registry without network discovery
  → find exact provider + model id
  → validate exact thinking level against that model
  → create tracked child with initial model + thinking
  → persist existing lineage markers and register completion tracking
  → deliver initial prompt
  → return child id/cwd plus resolved model/thinking
```

Validation completes before child creation. An invalid selection never leaves a stray child session behind.

## Error handling

### Removed or unauthenticated model

If a saved or explicit model is no longer in the authenticated available snapshot, spawning fails with the exact unavailable provider/model. PI WEBUI does not substitute the parent model or another catalog entry.

The active configuration form retains the user's attempted value and presents the server error. A refreshed options list lets the user choose a replacement.

### Unsupported thinking level

If a thinking level is no longer supported by the exact model, save/spawn fails and reports both values. The server never clamps to `off`, the first supported value, or the parent's level.

In the browser, changing models preserves the current thinking level only if the new option advertises it. Otherwise the field becomes incomplete and Save/Start remains disabled until the user chooses explicitly.

### Stale starter catalog

The server revalidates on session creation. If the catalog changed after the browser loaded, creation reports an actionable error while preserving the user's draft, initial prompt, and attachments. It does not create a parent whose requested independent child default was silently discarded.

### Failed active save

The last confirmed persisted selection remains authoritative. The control stays open, displays the error, and does not optimistically update the summary chip. Archived sessions remain read-only. During agent, bash, compaction, or tree-navigation work, the current selection remains inspectable but Save is disabled; server-side writable-session and serialized-mutation checks remain authoritative against stale or forged requests.

### Persistence failure

A requested active update is successful only after the custom entry is appended. New-session creation must not report an independently requested selection as saved if persistence failed. Errors cross the existing session route boundary with actionable messages.

### Legacy sessions and peers

- Older parent sessions without a defaults entry use the current parent model/thinking fallback.
- Existing `spawn_subsession` calls without `configuration` remain valid.
- Older remote peers omit the capability and new status fields; the browser hides the control.
- Unknown future thinking strings parse safely at the browser boundary but cannot be selected or spawned unless the live daemon reports them as supported.

## Security and operational properties

- The selector uses only models already available through the selected session daemon's authenticated model runtime. It cannot introduce arbitrary provider endpoints or credentials.
- Provider and model identifiers are bounded, trimmed strings at route/tool boundaries and remain separate to avoid ambiguous slash parsing.
- No credentials, headers, tokens, or provider secrets are written to session entries or returned in tool results.
- Existing same-project workspace validation runs before child creation.
- Existing tracked-child delegation suppression remains unchanged, preventing recursive model-spending trees.
- Model-option catalogs are loaded lazily for active sessions and are not added to high-frequency status events.

This feature changes session-runtime code and the session-daemon protocol. After implementation is installed in the current local environment, `pi-webui-sessiond.service` requires a manual restart; web/API/UI autoreload alone is insufficient. Once that implementation is active, changing a parent session's saved subsession model or thinking level applies immediately and does not require another daemon restart.

## Verification strategy

Follow TDD and add focused regression coverage before production edits.

### Pure configuration-module tests

1. Parse and serialize the versioned custom entry.
2. Read the latest matching entry from the active branch and distinguish no entry from an invalid authoritative entry.
3. Treat a malformed, incomplete, or unsupported-version latest matching entry as a fail-closed compatibility/configuration error without reviving an older value.
4. Enumerate exact available models and their supported thinking levels.
5. Reject unavailable models and unsupported thinking without fallback/clamping.
6. Resolve exact override, persisted defaults, and legacy fallback in the required order.
7. Preserve provider/model separation when model ids contain `/`.

### Starter draft tests

1. Follow parent model/thinking while linked.
2. Detach after either child field changes.
3. Preserve a thinking level supported by a newly selected model.
4. Clear a level unsupported by the newly selected model.
5. Reset to and resume following the current parent pair.
6. Reset on machine/workspace change and ignore stale option responses.

### Session service tests

1. New parent creation persists an exact child snapshot before the initial prompt.
2. Runtime creation receives both `initialModel` and `initialThinkingLevel` exactly once.
3. Active updates append a serialized custom entry and publish confirmed status; conflicting agent, bash, compaction, or tree-navigation work blocks the mutation without hiding the current values.
4. Session reopening recovers the saved selection.
5. Tree navigation derives defaults from the active branch, not an abandoned branch.
6. `spawnSubsession()` uses saved defaults when no override is supplied.
7. A complete exact override applies to one child without changing parent defaults.
8. Removed models and unsupported thinking fail before child runtime creation.
9. Legacy sessions use their current parent pair when no entry exists.
10. Existing workspace validation, lineage persistence, notifications, transcript reads, and disabled child delegation remain green.

### Tool and route tests

1. `spawn_subsession` exposes and forwards the optional atomic configuration.
2. Legacy calls without the new field remain accepted.
3. Tool results expose the resolved provider, model, and thinking level.
4. Session creation and active update routes reject malformed/partial values.
5. Starter/options and active routes preserve selected-machine federation forwarding.
6. Capability and response fields are additive and older-peer omission is safe.

### Client and component tests

1. Starter creation sends or requests the correct exact snapshot based on linked/independent state.
2. Active saves update UI state only after server confirmation.
3. Unsupported machines, disabled subsessions, archived sessions, and tracked children omit the control; eligible parents with active work keep it inspectable but cannot save.
4. Icon and summary-chip states compare the exact child pair with the current parent pair.
5. The form shows exact provider/model options and only the selected model's supported thinking levels.
6. Changing to an incompatible model clears thinking and disables Save.
7. Popover labels, keyboard Escape/focus restoration, error announcement, and mobile sheet behavior work through real DOM interaction.
8. Use TemplateResult handler extraction only for narrow event-wiring tests where a DOM harness would be disproportionate, following the repository testing guide.

Run focused Vitest files first, followed by:

```text
npm run typecheck
lint changed TypeScript files
git diff --check
npm run verify
```

## Documentation and release impact

Update the canonical tracked-subsessions sections in both `docs/config.md` and `docs/config.html` to describe:

- the independent exact model/thinking defaults;
- starter snapshot and active-session persistence behavior;
- optional exact per-spawn overrides;
- supported-model/thinking validation; and
- failure without silent fallback.

`README.md` remains unchanged. The implementation is a backward-compatible, user-visible feature and requires a patch Changeset. `CHANGELOG.md` remains generated during release preparation and must not be edited manually.

The design/specification commit itself is internal repository documentation and does not require a Changeset.

## Alternatives considered

### Machine-level Fast/Standard/Capable profiles

Rejected by the user. Capability tiers are subjective planning concepts. Fixed product tiers add configuration and force PI WEBUI to own a policy the user should weigh directly.

### Standalone subprocess subagent extension

Useful for standalone Pi workflows, but rejected for this integration. It would duplicate or bypass PI WEBUI's tracked lineage, join notifications, transcript access, workspace constraints, selected-machine routing, and long-lived session-daemon ownership.

### Separate model-aware spawn extension

Rejected because the existing tracked-subsessions path already owns the required lifecycle and already carries an initial model internally. Extending that path preserves locality and avoids competing spawn implementations.

### Parent model cycling before spawning

Rejected as a fragile session-wide side effect. It risks the wrong model under concurrent dispatch, disturbs the parent session and prompt cache, and still does not provide independent thinking selection.

### Settings-only child defaults

Rejected because the main workflow is session-specific: a capable planning parent may need a different worker default for one conversation. The starter/ordinary composer keeps that choice close to the spawning context while remaining collapsed by default.

## Scope boundaries

- Do not add model tiers, model ranking, cost estimates, token budgets, or automatic routing.
- Do not add machine-level or project-level subsession profile mappings.
- Do not change independent `spawn_session` behavior.
- Do not enable recursive delegation from tracked children.
- Do not silently fall back to another model or clamp thinking levels.
- Do not modify provider installation, authentication, model discovery, or upstream Pi.
- Do not add a new project configuration file.
- Do not put detailed feature documentation in `README.md`.
- Do not manually edit `CHANGELOG.md`.

## Expected implementation areas

- `src/server/sessions/subsessionConfiguration.ts` (or an equivalently focused module): domain values, persistence parsing, options, validation, and resolution.
- `src/server/sessions/spawnSubsessionTool.ts`: optional atomic tool input and resolved-result reporting.
- `src/server/sessions/piSessionService.ts` plus focused service helpers: start/update/spawn orchestration and initial thinking plumbing.
- `src/server/sessions/sessionRoutes.ts`, `sessionService.ts`, session-daemon proxy/capability wiring, and route tests: additive transport.
- `src/shared/apiTypes.ts` and client parsers: exact selection/options/status contracts.
- `src/client/src/controllers/sessionController.ts` and API clients: starter creation, active read/update, and stale-selection guards.
- `src/client/src/components/SubsessionDefaultsControl.ts`: reusable accessible popover/mobile sheet.
- `src/client/src/components/PromptEditor.ts` and `PiWebUiApp.ts`: layout and starter/active wiring.
- Focused pure, service, route, controller, and component tests described above.
- `docs/config.md` and `docs/config.html`: synchronized canonical documentation.
- `.changeset/`: one patch-level user-facing release note when implementation begins.
