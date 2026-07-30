# Exact subsession model and thinking defaults — design

**Status:** Approved design direction; written specification awaiting Product Owner review.

## Goal

Let a PI WEBUI user choose the exact model and thinking level used by tracked subsessions without changing the parent session's own model or thinking level.

The feature must:

- add an independent subsession model-and-thinking control to the starter and ordinary prompt bars;
- initialize a new parent session's subsession defaults from an exact snapshot of the starter parent's selected model and thinking level;
- keep the starter child draft linked to parent choices until the user edits either child field;
- persist the exact child selection with the parent session so it survives browser, API, and session-daemon restarts;
- expose one optional, atomic exact override on `spawn_subsession` for task-specific dispatches;
- validate every resolved model against the selected machine's currently available model registry and every thinking level against that exact model;
- fail clearly instead of silently inheriting, substituting a model, or clamping a thinking level; and
- preserve existing tracked-child lineage, completion notifications, transcript access, workspace validation, and disabled recursive delegation.

The feature does not introduce capability tiers. Terms such as “fast,” “standard,” or “capable” remain user judgments rather than PI WEBUI configuration or product policy.

## Accepted user experience

### Starter prompt

The pre-session composer keeps its existing parent model and thinking controls. When the selected machine supports and enables tracked subsessions, it also shows a compact branch/subsession icon beside them.

Opening that icon reveals a focused **Subsession defaults** popover with:

- an exact provider/model selector;
- an exact thinking-level selector containing only levels supported by the selected model; and
- **Reset to parent choice**.

Before the user edits either child field, the child draft is linked to the parent starter settings. Changing the starter parent's model or thinking level updates the child draft. Editing either child field detaches the draft, after which parent changes do not overwrite it. Resetting reconnects the draft to the current parent pair.

Starting the conversation captures one exact child selection. Once the parent session exists, its child defaults are independent; later parent model or thinking changes do not mutate them.

The starter remains uncluttered: when the child draft still matches the parent, the toolbar shows only the compact branch icon. A child selector is not shown when tracked subsessions are unavailable or disabled.

### Ordinary prompt

An eligible active parent session shows the same subsession control:

- when saved child defaults equal the parent's current exact model and thinking level, show only the compact branch icon;
- when they differ, show a summary chip such as **`Children: gpt-5.6-luna · medium`**;
- clicking either form opens the same exact model-and-thinking form;
- **Copy current session settings** writes the parent's current exact pair as a new persisted child default; it does not create an ongoing inheritance link.

The control is absent for:

- tracked child sessions, which cannot delegate further;
- archived sessions;
- machines without the additive subsession-selection capability; and
- machines where tracked subsessions are disabled.

While the parent has active agent, bash, compaction, or tree-navigation work, the current values remain inspectable but saving is disabled so configuration entries cannot interleave with an in-flight session mutation.

### Exact selection behavior

Changing the child model preserves the selected thinking level only when the new model supports it. Otherwise the UI clears the thinking selection and disables **Save** or **Start** until the user chooses a valid exact level. The UI never silently chooses a replacement level.

Long provider/model identifiers may be visually truncated, but the full provider and model id remain available through accessible text and a tooltip. Provider and model id remain separate data fields because model ids can contain `/`.

## Terminology and precedence

A **subsession default** is an exact model plus an exact thinking level stored on a parent session:

```ts
interface SubsessionModelSelection {
  model: {
    provider: string;
    id: string;
  };
  thinkingLevel: string;
}
```

A **per-spawn override** is an optional exact selection supplied to one `spawn_subsession` call. It does not alter the parent session's saved defaults.

Resolution order is deliberately small:

```text
exact per-spawn override
  > parent session's persisted exact subsession defaults
  > legacy-session fallback to the parent's current exact model and thinking
```

The complete selection is atomic at every interface. A caller cannot override the model while accidentally retaining an unsupported thinking level.

## Current-state constraints

`PromptEditor` currently renders the current session/default model and thinking controls in one compact status row. The starter obtains Pi's persisted parent defaults from `GET /session-defaults?cwd=...`; selecting a starter parent model or thinking level updates those Pi defaults. Active-session model options come from the session service, and active thinking options currently describe only the session's current model.

`spawn_subsession` currently accepts only `prompt` and `cwd`. Its executor forwards `ctx.model`, and `PiSessionService.spawnSubsession()` passes that model through `initialModel`. Internal model plumbing therefore already exists, but the public tool cannot choose a model and no corresponding initial thinking-level value is passed.

Tracked-parent and tracked-child relationships are already persisted as versioned PI WEBUI custom entries. Custom entries do not participate in LLM context, making the same session-owned persistence mechanism appropriate for subsession defaults.

Tracked children already start without delegation tools. This feature must preserve that recursion guard.

## Chosen architecture

### Deep module: subsession configuration

Introduce a focused server-side **SubsessionConfiguration** module. Its small interface hides model-catalog conversion, thinking-level discovery, validation, persistence parsing, branch lookup, and fallback behavior.

The module owns:

- `SubsessionModelSelection` and model-option transport conversion;
- the versioned custom-entry type and parser;
- reading the latest configuration entry on the active session branch;
- enumerating currently available exact models and each model's supported thinking levels;
- validating an exact selection against a cwd/session model runtime;
- resolving an optional per-spawn override against saved defaults; and
- producing clear domain errors without fallback or clamping.

Browser components, HTTP routes, and the tool adapter must not reproduce model or thinking validation.

### Versioned parent-session persistence

Persist exact defaults as a non-context custom entry:

```text
customType: pi-webui.subsession.defaults

data:
  version: 1
  selection:
    model:
      provider: RightCode-OpenAI
      id: gpt-5.6-luna
    thinkingLevel: medium
```

A newly created eligible parent receives this entry before its initial prompt is delivered. Updating from the ordinary prompt appends another entry through the existing serialized session-entry mutation seam.

Read the latest applicable entry from `sessionManager.getBranch()`, not from append-order `getEntries()`. An abandoned branch cannot change the active branch's child defaults. Unknown future versions or a malformed latest configuration are not interpreted as an older value; spawning fails with a compatibility/configuration error rather than reviving stale settings.

Existing sessions without this entry retain backward compatibility: each spawn falls back to the parent session's current exact model and thinking level. The fallback is not silently persisted during an active tool call, avoiding custom-entry insertion between an assistant tool call and its result. Once the user saves from the ordinary prompt, the session has durable independent defaults.

### Runtime creation

Extend the one-shot session-creation options to carry both:

```ts
{
  initialModel?: AgentModel;
  initialThinkingLevel?: ClientThinkingLevel;
}
```

Pass both through `createRuntimeWithOneShotSessionOptions()` and `createDefaultRuntimeFactory()` to `createAgentSessionFromServices({ model, thinkingLevel })`. Pi's SDK already supports an explicit `thinkingLevel`; PI WEBUI should use that supported seam rather than mutating the child after creation.

Model availability and thinking support are validated before creating the child. A validation failure creates no child session and no parent/child tracking entries.

### Tool interface

Add one optional atomic field to `spawn_subsession`:

```ts
spawn_subsession({
  prompt: "Implement task 2",
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

Omitting `configuration` uses the parent session's saved defaults or the legacy fallback. Existing stored tool calls therefore remain valid. The model and tool-result details report the resolved provider, model id, and thinking level.

The public schema accepts one complete configuration object, not independent optional provider/model/thinking fields. Provider and model strings are bounded and non-empty. Thinking syntax is accepted as a bounded string and then validated against the selected model's live supported levels so PI WEBUI does not hardcode a permanently closed enum.

`spawn_session` remains unchanged; this design applies only to tracked subsessions whose result is joined by the parent.

### Browser modules

Add a dedicated `SubsessionDefaultsControl` Lit module. `PromptEditor` owns placement only and passes data/callbacks through a small interface. The control owns:

- compact icon versus summary-chip rendering;
- popover/sheet open state;
- exact model and thinking form state;
- model-change compatibility handling;
- Save/reset/copy actions;
- accessible labels, error presentation, Escape handling, and focus restoration; and
- responsive popover versus mobile-sheet presentation.

Keep starter linkage logic in a small pure state helper. Its states are:

```ts
type StarterSubsessionDraft =
  | { mode: "linked"; selection: SubsessionModelSelection }
  | { mode: "independent"; selection: SubsessionModelSelection };
```

This helper follows parent changes only in `linked` mode, detaches after either child field changes, preserves a thinking level only when supported by a replacement model, and resets to the current parent pair. `PiWebUiApp` orchestrates loading and session creation; it does not contain these transition rules inline.

Active-session selection is server-authoritative. The browser updates the chip only after a successful save response and retains the prior persisted value when saving fails.

## API and rolling compatibility

### Additive capability

Advertise a new effective machine capability:

```text
sessions.subsessionModelSelection
```

The browser only uses the new fields/routes when the selected machine advertises this capability. Older local and federated peers omit it and retain their current UI and tool behavior.

### Starter/default model options

Extend the existing `GET /session-defaults?cwd=...` response additively with tracked-subsession availability and exact model options:

```ts
interface SubsessionModelOption {
  model: SessionModel;
  thinkingLevels: string[];
}

interface SessionDefaultsResponse {
  // existing parent fields
  subsessions?: {
    enabled: boolean;
    options: SubsessionModelOption[];
  };
}
```

The server derives options from the selected machine/cwd's available model snapshot and `getSupportedThinkingLevels(model)`. This keeps the starter on its existing defaults request instead of adding another startup round trip. It does not add model tiers or modify `models.json`.

### Session creation

Extend `POST /sessions` with optional `subsessionDefaults: SubsessionModelSelection`. The client includes an exact pair when the feature is supported and enabled. The server validates it before creating the parent and persists it before initial prompting.

### Active status and updates

Add an optional `subsessionDefaults` field to `SessionStatus`. Keep model options out of status because status is republished frequently during streaming.

When the active popover opens, reuse the cwd-scoped session-defaults/options request to obtain a fresh model catalog. Save through:

```text
PUT /sessions/:sessionId/subsession-defaults
```

The body contains the existing cwd identity plus one exact selection. The response returns the updated `SessionStatus`. The route applies the same writable-session, active-branch, and serialized-mutation protections as other session setting changes.

Federation proxies and route allowlists carry these additive requests to the selected machine. Client parsers tolerate omitted fields from older peers but validate any field that is present.

## Data flow

### Starter

```text
workspace selected
  → GET session defaults for selected machine + cwd
  → parent default model/thinking + available child model options
  → initialize linked child draft from exact parent pair

parent starter model/thinking changes while linked
  → update linked child draft

user edits child model or thinking
  → detach draft
  → if model changed, retain thinking only when supported

user starts conversation
  → POST sessions with cwd + exact child snapshot
  → validate complete child selection
  → create parent runtime
  → append pi-webui.subsession.defaults v1 entry
  → queue/deliver initial prompt and attachments
  → status exposes persisted exact child defaults
```

A stale or invalid child selection rejects session creation without clearing the prompt draft or attachments.

### Ordinary prompt

```text
session status
  → exact persisted child defaults
  → compare with current parent pair
  → compact icon or visible summary chip

user opens control
  → refresh cwd-scoped exact model options
  → render current persisted selection

user saves
  → PUT exact atomic selection
  → validate against current model runtime
  → serialized custom-entry append on active branch
  → publish/return updated status
  → update chip only after confirmation
```

### Spawn

```text
parent calls spawn_subsession
  → optional exact tool override
  → otherwise latest active-branch persisted defaults
  → otherwise legacy current-parent pair
  → refresh available model snapshot without network discovery
  → resolve exact provider + model id
  → validate exact supported thinking level
  → create tracked child with initial model + thinking
  → persist existing parent/child relationship entries
  → deliver child prompt
  → report child id, cwd, resolved model, and thinking
```

Changing a parent session's saved defaults affects only future children. Existing children retain the model and thinking with which they were created.

## Error handling and invariants

### No silent fallback

If a saved or overridden model is no longer available, spawning fails before child creation with the exact provider/model in the message. If a thinking level is unsupported, spawning fails with the requested level and selected model. Neither case inherits the parent model, picks another model, or clamps the level.

### UI validation

When changing models, preserve the current thinking level only if supported. Otherwise clear it and disable Save/Start until the user chooses a valid value. A stale catalog rejected by the server leaves the form and starter draft intact and shows an actionable error.

An active-session save failure keeps the prior server-confirmed selection and chip, keeps the form open, and announces the error. Archived sessions remain read-only.

### Availability and authentication

Only models in the selected machine's currently available model snapshot are offered and accepted. The persisted entry stores provider, model id, and thinking level only—never credentials, endpoint secrets, or resolved headers.

### Session integrity

Configuration updates use the session-entry mutation seam and are disabled during conflicting work. Branch lookup is authoritative. Tracked-child delegation remains disabled. Existing workspace/project restrictions for spawned cwd values are unchanged.

## Accessibility and responsive behavior

- The trigger's accessible label is **Configure subsession defaults**.
- Model and thinking fields have visible labels and keyboard-operable selectors.
- Escape closes the popover and returns focus to its trigger.
- Save failures use an alert/status region.
- The trigger and chip expose full values to assistive technology even when visual text is truncated.
- Desktop uses the approved compact popover. Narrow layouts render the same form as a modal sheet so it cannot overflow or cover prompt actions.
- Hidden/unsupported states do not leave a disabled mystery control in the toolbar.

## Verification strategy

Follow test-driven development and prove each behavior at the narrowest meaningful layer.

### Pure module tests

1. Parse and serialize the versioned `pi-webui.subsession.defaults` custom entry.
2. Select the latest valid configuration from the active branch only.
3. Treat malformed or unknown latest versions as a compatibility/configuration error rather than reviving stale data.
4. Reject incomplete model/thinking selections.
5. Validate exact models against the available snapshot.
6. Reject unsupported thinking levels without clamping.
7. Resolve explicit override, persisted default, and legacy fallback precedence.
8. Verify starter draft linked, detached, reset, model-change, and thinking-compatibility transitions.

### Session service tests

1. New parent creation persists the exact child snapshot before initial prompting.
2. Runtime creation receives both `initialModel` and `initialThinkingLevel` exactly once.
3. Active updates append a validated custom entry and publish updated status.
4. Reopening a session recovers its saved selection.
5. Tree navigation derives defaults from the active branch.
6. `spawnSubsession()` uses saved defaults when no override is supplied.
7. One atomic exact override wins without changing parent defaults.
8. Legacy sessions use their current exact parent model/thinking when no entry exists.
9. Unavailable models and unsupported levels fail before child creation or tracking persistence.
10. Existing tracking, notifications, workspace validation, and recursion prevention remain unchanged.

### Route, tool, and federation tests

1. `spawn_subsession` exposes and forwards the optional atomic configuration.
2. Legacy calls without it remain accepted.
3. Tool output/details report the resolved exact selection.
4. Session creation and active update routes validate bounded provider/model/thinking values and map domain failures consistently.
5. Session-defaults options contain supported levels for each available exact model.
6. Capability and response additions remain optional for older peers.
7. Federated proxy contracts carry the starter creation field and active update route to the selected machine.

### Client and component tests

1. Starter creation sends the exact linked or independent snapshot.
2. Machine/workspace changes discard stale option responses.
3. Active saves update the visible chip only after server confirmation.
4. Unsupported machines, disabled configurations, tracked children, and archived sessions omit the editable control as specified.
5. Exact-equality comparison produces icon versus summary-chip states.
6. Real DOM tests cover popover labels, model/thinking interaction, disabled Save, errors, Escape/focus restoration, and mobile-sheet presentation.
7. Use TemplateResult event-handler extraction only for narrow callback wiring where a DOM harness would be disproportionate, following the repository testing guide.

Run focused Vitest files first, followed by:

```text
npm run typecheck
lint changed TypeScript files
git diff --check
npm run verify
```

## Documentation and release impact

Update `docs/config.md` and `docs/config.html` under **Session daemon tools**. Document:

- the independent exact child defaults;
- starter snapshot/link behavior;
- active parent updates;
- optional exact per-spawn overrides;
- validation against available models and supported thinking levels; and
- failure without silent fallback.

`README.md` remains unchanged. The implementation is a backward-compatible user-visible feature and requires one patch Changeset. `CHANGELOG.md` remains generated during release preparation and is not edited manually.

The design specification itself is internal planning material and does not receive a Changeset before implementation begins.

## Scope boundaries

Included:

- tracked `spawn_subsession` model and thinking selection;
- starter and ordinary parent-session controls;
- exact session-owned defaults and one exact per-spawn override;
- session-runtime creation with initial model and thinking;
- additive capability/API/status contracts;
- rolling-compatible federation behavior;
- focused user documentation and a patch Changeset during implementation.

Excluded:

- Fast/Standard/Capable tiers, model ranking, or automatic routing;
- machine-level subsession profiles or new PI WEBUI configuration keys;
- cost budgets or automatic token optimization;
- changes to independent `spawn_session`;
- recursive delegation from tracked children;
- silent model fallback or thinking-level clamping;
- provider installation, model-catalog editing, or authentication changes;
- changes to upstream Pi; and
- manual `CHANGELOG.md` edits.

## Expected implementation areas

- `src/server/sessions/subsessionConfiguration.ts` (or equivalently focused module): domain values, persistence parser, options, validation, and resolution.
- `src/server/sessions/spawnSubsessionTool.ts`: optional atomic override and resolved result details.
- `src/server/sessions/piSessionService.ts`: parent persistence, status projection, active update, model/thinking runtime creation, and spawn resolution orchestration.
- `src/server/sessions/sessionService.ts` and `sessionRoutes.ts`: additive start/update contracts.
- session-daemon proxy/capability declarations and federation tests.
- `src/shared/apiTypes.ts`: exact selection, model option, starter response, capability, and status types.
- `src/client/src/controllers/sessionController.ts` and API clients/parsers: starter creation, option loading, active updates, and stale-response guards.
- `src/client/src/components/SubsessionDefaultsControl.ts`: approved control and responsive form.
- `src/client/src/components/PromptEditor.ts` and `PiWebUiApp.ts`: placement and orchestration only.
- focused pure, service, route, federation, controller, and component tests.
- `docs/config.md`, `docs/config.html`, and one `.changeset/*.md` file during implementation.

## Operational consideration

This feature changes session-runtime creation, session-daemon routes/capabilities, and tool definitions. After integrating the implementation into a running local environment, `pi-webui-sessiond.service` requires a manual restart. UI/API autoreload alone cannot apply the complete feature.
