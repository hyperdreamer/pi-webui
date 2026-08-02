# Persisted starter model policy preference

**Date:** 2026-08-03
**Status:** Approved design

## Problem

The new-session composer appears to remember an Exact model and thinking level, but it does not remember the selected Exact/Tiered mode or the last selected tier across successful session creation, reload, or a later visit to the workspace.

The asymmetry comes from two persistence scopes. Pi already persists the starter's Exact model and thinking defaults. PI WEBUI keeps the starter mode and tier only in an in-memory draft, then clears that draft after a successful start or a machine/workspace change. Existing sessions persist their own complete session model policy, but that policy is not a default for future sessions.

Users need a personal last-used starter preference without turning it into committed project policy or changing active-session behavior.

## Goals

- Remember the starter's selected Exact/Tiered mode per workspace and machine.
- Remember the last valid tier even while Exact is selected.
- Apply a valid starter selection to the preference immediately, without waiting for session creation.
- Restore remembered Tiered intent without silently replacing an invalid or unavailable tier.
- Keep preference persistence personal and machine-local rather than committed in project configuration.
- Preserve compatibility with older remote PI WEBUI daemons.
- Keep Pi's existing Exact model/thinking settings as their current source of truth.

## Non-goals

- Changing how an existing session persists or applies its session model policy.
- Making active-session policy changes alter future-session defaults.
- Moving Exact model/thinking defaults out of Pi's settings.
- Adding project-shared or global default policy configuration.
- Persisting the preference in browser storage.
- Changing the machine tier mapping or tier-resolution rules.

## Domain model

A **starter model policy preference** is a personal, machine-local, workspace-scoped default used to initialize a future root-session composer. It is not a session model policy because no session exists yet.

```ts
export interface StarterModelPolicyPreference {
  mode: "exact" | "tiered";
  /** Retained while Exact is active; required while Tiered is active. */
  tier?: ModelTier;
}
```

The preference does not contain an Exact model selection. The complete starter draft is composed from two independently owned values:

```text
Pi model/thinking defaults + PI WEBUI starter model policy preference
```

Invariants:

1. `mode: "tiered"` always has a canonical `tier`.
2. `mode: "exact"` may retain a canonical inactive `tier`.
3. An absent preference means Exact mode with no remembered tier.
4. A canonical tier remains valid stored intent even when its current ladder row cannot resolve.
5. An incomplete first Tiered choice is a client draft, not a persistable preference.

## Persistence scope

Each session daemon stores its own preference file. This makes the selected daemon the machine scope without storing a web-process machine ID in the file.

The workspace key is the absolute path normalized by `normalizeRequestCwd()`. The store does not call `realpath()`, matching existing request scope semantics and avoiding a requirement that the path already exist during parsing.

The default file is:

```text
$PI_WEBUI_DATA_DIR/starter-model-policy-preferences.json
```

It is PI WEBUI-managed state, not user-editable configuration and not part of `<project>/.pi-webui/config.json`.

The version-one file shape is:

```json
{
  "version": 1,
  "workspaces": {
    "/absolute/workspace/path": {
      "mode": "exact",
      "tier": "advanced"
    }
  }
}
```

The parser is strict about the root shape, version, workspace values, modes, tiers, and unknown fields. A missing file is an empty store. An in-process operation queue serializes each complete read-modify-write transaction. Each transaction then replaces the file through a temporary file plus atomic rename; the rename protects file integrity but does not provide serialization. On POSIX systems, temporary and final files use mode `0600`. A failed write removes its temporary file and leaves the previous durable file unchanged.

A malformed or unsupported file is not automatically overwritten because doing so could discard other workspace preferences. Inspection reports an actionable invalid-state reason. An explicit preference write fails until the managed file is repaired or removed; this failure does not prevent the current in-memory selection from starting a session.

## Shared contract

The existing session-defaults contract gains additive optional fields:

```ts
export interface SessionDefaultsResponse {
  model?: SessionModel;
  thinkingLevel: string;
  models: SessionModel[];
  thinkingLevels: string[];
  starterModelPolicyPreference?: StarterModelPolicyPreference;
  starterModelPolicyPreferenceError?: string;
}
```

At most one of `starterModelPolicyPreference` and `starterModelPolicyPreferenceError` is present.

The update contract permits either an Exact-default update or one complete preference update, never both:

```ts
type SessionDefaultsUpdate =
  | {
      model: { provider: string; modelId: string };
      thinkingLevel?: string;
      starterModelPolicyPreference?: never;
    }
  | {
      model?: { provider: string; modelId: string };
      thinkingLevel: string;
      starterModelPolicyPreference?: never;
    }
  | {
      model?: never;
      thinkingLevel?: never;
      starterModelPolicyPreference: StarterModelPolicyPreference;
    };
```

The route rejects an empty update, mixed preference and Exact-default fields, unknown fields, malformed nested values, an unknown tier, or Tiered mode without a tier. Exact mode with an optional remembered tier is accepted.

The browser parser accepts legacy responses that omit both new fields. Existing clients ignore the additive response fields. New clients send the preference update only when the effective runtime advertises the new capability.

## Modules and interfaces

### StarterModelPolicyPreferenceStore

A new session-daemon module owns the managed file behind this interface:

```ts
export type StarterModelPolicyPreferenceInspection =
  | { kind: "absent" }
  | { kind: "valid"; preference: StarterModelPolicyPreference }
  | { kind: "invalid"; reason: string };

export interface StarterModelPolicyPreferenceStore {
  inspect(cwd: string): Promise<StarterModelPolicyPreferenceInspection>;
  replace(cwd: string, preference: StarterModelPolicyPreference): Promise<void>;
}
```

The implementation hides file versioning, strict parsing, workspace lookup, operation serialization, temporary-file cleanup, and atomic replacement. The file path is constructor-injected for filesystem tests.

### SessionDefaultsService

`SessionDefaultsService` receives the preference store as an injected dependency. Its external interface remains `read(cwd)` and `update(cwd, update)`.

`read()` combines Pi's model/thinking defaults with preference inspection. An invalid preference inspection becomes `starterModelPolicyPreferenceError`; it does not fail or hide valid Exact defaults.

`update()` delegates to exactly one backing adapter:

- model/thinking updates use Pi's `SettingsManager` and preserve the preference in the response;
- preference updates use `StarterModelPolicyPreferenceStore` and do not mutate Pi settings.

A preference write error propagates through the existing route error response. The client treats that error as a preference warning rather than as a session-start failure.

### Client starter seeding

A pure helper constructs a `SessionModelPolicyDraft` from `SessionDefaultsResponse`:

- Exact selection comes from the returned model and thinking level when complete;
- otherwise the Exact branch remains explicitly incomplete;
- mode and remembered tier come from the valid preference;
- absent or invalid preference seeds Exact with no remembered tier;
- no branch invents a model, thinking level, or tier.

The helper does not validate a stored tier against the current ladder. Catalog validation remains a separate step so unavailable stored intent stays visible.

### Client preference writer

The client keeps preference persistence separate from active-session policy writes. For each machine/workspace scope it:

- applies a valid selection to the starter draft immediately;
- serializes preference writes in selection order;
- may coalesce a not-yet-issued pending value to the newest intent;
- continues with a newer pending value if an earlier write fails;
- uses a generation/scope guard so stale completions cannot mutate another composer;
- uses a preference-write response only to confirm persistence, never to overwrite a newer Exact branch;
- lets an Exact-default response relink only the Exact branch, never reseed the current mode or remembered tier;
- retains the latest scoped persistence warning independently of the temporary draft until a later preference write succeeds.

A write already issued for an old scope may complete and persist that old scope's valid selection. Its completion is ignored by the current UI.

Between independent browser tabs, the last successfully committed replacement in the daemon's serialized queue determines the durable state. This is daemon queue order, not a guarantee about browser click order, and the in-process queue does not coordinate multiple daemon processes that share one data directory.

## Capability and federation

Add this capability:

```ts
sessions.modelPolicyDefaults
```

Both web and session daemon must advertise it for the effective capability to be present. The existing `/session-defaults` machine proxy already forwards the route, so no new proxy path is required.

Capability behavior:

- A current local daemon supports persisted starter preferences after restart.
- A remote daemon with `sessions.modelPolicyDefaults` supports read and write persistence for its own workspace paths.
- An older daemon without the capability returns legacy defaults. The client uses today's in-memory starter behavior and sends no unsupported preference update.
- The separate `sessions.modelPolicy` capability continues to control per-session policy selection.

## Starter data flow

### Initial load

1. The new-session screen requests `GET /session-defaults` for the selected machine and workspace.
2. The client seeds one starter draft from Exact defaults plus the optional preference.
3. If the restored mode is Tiered, the client immediately requests the selected machine's tier catalog.
4. Start remains blocked while the remembered tier cannot be proven resolvable, including catalog loading or fetch failure.
5. Once the catalog confirms the row, the resolved tuple is displayed and Start becomes available.

An invalid remembered ladder row does not rewrite the preference. The selected tier and its specific reason remain visible until the user chooses a valid tier, switches to Exact, or repairs the machine ladder.

### Selection updates

- Selecting Exact persists `{ mode: "exact", tier?: rememberedTier }` immediately.
- Opening Tiered with no remembered tier changes only the temporary draft. Reloading before a tier selection restores the previously durable preference.
- Selecting a valid tier persists `{ mode: "tiered", tier }` immediately.
- Switching to Tiered with an already remembered and currently valid tier persists and applies it immediately.
- An Exact model or thinking change continues to update Pi defaults and does not erase mode or remembered tier.
- Active-session mode, tier, model, and thinking changes never update the starter preference.

### Session creation

Session creation always snapshots the current in-memory starter policy. It does not wait for preference persistence:

- a preference write failure cannot change which policy the new session receives;
- if a write fails after the starter leaves the screen, its warning appears when that machine/workspace starter is next shown and never contaminates an active-session composer;
- a successful start clears the temporary draft as it does today;
- returning to the new-session screen reconstructs the draft from durable defaults;
- a failed start retains the current draft for retry.

## Failure behavior

### Unresolvable stored tier

Preserve Tiered mode and the canonical tier. Show the catalog's reason and block Start. Never substitute Standard, a neighboring tier, or Exact.

### Preference read failure

Return valid Exact defaults plus `starterModelPolicyPreferenceError`. Seed Exact with no tier and show a preference-specific diagnostic. Do not block an otherwise complete Exact starter.

### Preference write failure

Keep the selected in-memory policy and allow Start. Show a non-blocking message equivalent to:

```text
Could not remember this model policy; this session will still use it.
```

A later successful selection clears the warning. An earlier failed write must not overwrite the status of a newer successful write.

### Exact-default failure

Existing model/thinking failure behavior remains authoritative. This design does not convert a failed Pi default update into a local Exact selection.

### Stale asynchronous completion

Machine ID, workspace identity, and request generation guard every UI update. Stale responses may finish their correctly scoped durable operation but cannot replace the current draft, Exact defaults, catalog, saving state, or error message.

## User interface

No new settings page or control is added. The existing composer controls gain persistence behavior.

- Restored mode and tier appear in their existing controls.
- Existing blocked and row-reason surfaces explain an unusable restored tier.
- Existing saving/error plumbing reports preference persistence without disabling Start.
- Exact remains the visible compatibility fallback when no valid preference can be read.

## Verification strategy

### Preference store tests

- Missing file returns `absent`.
- Exact and Tiered preferences round-trip.
- Exact retains an inactive remembered tier.
- Normalized workspace keys remain isolated.
- Unsupported versions, malformed roots, unknown fields, modes, and tiers produce invalid inspection.
- Concurrent replacements are serialized and leave valid JSON.
- A failed replacement leaves the previous durable file intact and removes its temporary file.

### Session-defaults service tests

- Read combines Pi Exact defaults with a valid preference.
- Absent preference omits both optional fields.
- Invalid preference returns Exact defaults plus a diagnostic.
- Preference-only update does not call Pi setting setters.
- Model/thinking updates retain the preference in the response.
- Preference write failure propagates without changing Exact defaults.

### Route and browser-contract tests

- Accept Exact with or without a remembered tier.
- Accept Tiered with a canonical tier.
- Reject Tiered without a tier, unknown tiers, unknown fields, malformed values, empty updates, and mixed preference/Exact updates.
- Parse new and legacy session-default responses.
- Send preference updates through the application-relative selected-machine path.
- Preserve the existing session-default proxy route.
- Require both web and session daemon for `sessions.modelPolicyDefaults`.

### Pure draft tests

- No preference seeds Exact.
- Exact restores its remembered tier.
- Tiered restores its selected tier.
- A canonical but currently unusable tier remains selected.
- Missing Exact defaults remain incomplete.
- Inputs are not mutated.

### Focused application tests

- Restored Tiered starts catalog loading and remains blocked until validation.
- Valid selections update the draft immediately and enqueue the scoped write.
- Opening first-time Tiered without choosing a tier does not persist an incomplete preference.
- Rapid selections persist in order with latest intent winning.
- Workspace and machine changes ignore stale completions.
- A save failure warns without blocking Start, and Start carries the selected policy.
- A later successful write clears an older warning.
- Active-session changes never write the starter preference.
- A successful start clears the draft and a later load restores the preference.

### Verification commands

Run focused Vitest files first, followed by TypeScript checking and linting for changed files. Because the implementation changes shared contracts, session-daemon persistence, capability federation, and client state, finish with:

```bash
npm run verify
```

## Documentation and rollout

Implementation updates the canonical model-policy behavior in `docs/config.md` and `docs/config.html`. The README remains unchanged because this is detailed configuration behavior, not a change to the shortest install path or top-level product identity.

The user-visible behavior requires a Changeset. Release notes should state that future root-session composers remember their last mode and tier per workspace and machine.

The persistence module, capability, and route contract are loaded by the session daemon. After deploying the implementation, users must restart `pi-webui-sessiond.service` manually; UI/API autoreload alone is insufficient.

## Alternatives rejected

### Dedicated preference route

A separate starter-policy endpoint would isolate the wire contract but add another request, route, federation proxy, loading state, and synchronization path for values always consumed with session defaults. Extending the existing deep session-defaults module keeps one caller interface while hiding the two backing stores.

### Browser localStorage

Browser storage is simple but is scoped to one browser profile, does not follow the selected machine authoritatively, and can disagree across devices. It does not satisfy personal machine-local persistence.

### Project configuration

Storing last-used state in `<project>/.pi-webui/config.json` would turn a personal preference into commit-able team policy and create unnecessary repository churn.

### Persisting the resolved Tiered tuple

A Tiered preference stores the canonical tier, not its current model/thinking resolution. Persisting the tuple would freeze a dynamic machine-owned mapping and contradict Tiered semantics.

## Acceptance criteria

1. A valid starter Tiered choice survives successful creation, browser reload, and a later return to the same workspace on the same machine.
2. Exact/Tiered mode survives under the same scope.
3. Switching to Exact preserves the remembered tier, and switching back restores it when valid.
4. Another workspace or machine has an independent preference.
5. Active-session changes do not alter the preference.
6. An unusable remembered tier remains visible and blocks Start without fallback.
7. Preference read/write failures do not prevent a valid Exact starter or the current in-memory policy from starting a session.
8. Older remote daemons retain existing behavior without receiving unsupported writes.
9. Exact model/thinking defaults continue to use Pi's existing settings.
10. All focused tests, type checking, linting, and `npm run verify` pass.
