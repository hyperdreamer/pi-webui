# Lightweight fallback for SESSIONS `+` session creation — Design

- **Status:** Draft (design); attempt-1 and attempt-2 reviews resolved (0 blockers); awaiting user sign-off
- **Date:** 2026-09-27
- **PM run:** `pm-run-20260927-021015-30213465`
- **Topic slug:** `plus-lightweight-fallback`
- **Delivery target:** `refs/heads/main` @ `13d4c52c7597160317fa7bdcc9504518f92006f0`
- **Related user request:** "We don't touch the '+' scheme; we just add a fallback Lightweight utility model (since the user is responsible for ensuring it is always available). If the system falls back to the lightweight utility model, it should be treated as the remembered one (exact mode)."

## Background

Creating a session with the SESSIONS `+` control sends a **complete model policy**
(`creationSource: "session-list-plus"` plus `initialModelPolicy`). The policy is the
workspace's remembered starter preference, consumed from
`$PI_WEBUI_DATA_DIR/starter-model-policy-preferences.json`.

When that remembered policy is structurally valid but its **active** target can no
longer resolve, the session is not created:

- **Client preflight:** `evaluateStarterModelPolicyDraft` marks the draft blocked when
  the exact model is absent from the model-tier catalog or the thinking level is
  unsupported (`Selected provider/model is unavailable`), or when the tier row is
  invalid (`Advanced has no configured model`). `startSessionAndOpenChat` publishes a
  `policy-blocked` notice and returns without a request
  (`src/client/src/components/PiWebUiApp.ts:2551`).
- **Server rejection:** when the client's cached catalog still says "valid" (that
  catalog is only invalidated on page refresh, machine switch, or tier-ladder save),
  the request reaches the daemon and `PiSessionService` rejects it —
  `Model not found: <provider>/<id>` from `resolveAvailableExactSelection`
  (`src/server/sessions/piSessionService.ts:6073`) or
  `tier <name> names unavailable model <provider>/<id>` from the tier registry
  (`src/server/sessions/modelTierRegistry.ts`). The runtime is aborted and disposed,
  no durable transcript is written, no `session.created` event is emitted, and the
  client shows a failed pending row (`Failed to start session: <message>`).

Only the **active** branch is validated: an unavailable remembered Exact branch does
not block Tiered mode, and an invalid remembered tier does not block Exact mode.

The machine already has a user-configurable **`utilityModels.lightweight`** slot
(Settings → Utility models; `docs/config.md:277-289`) resolved to a live
`{ model, thinkingLevel }` by `createUtilityModelResolver`
(`src/server/sessions/utilityModelResolver.ts`). That resolver is already injected
into `PiSessionService` (`:1296`) and uses the same runtime snapshot as session-model
validation.

This design makes that slot the session-creation fallback for the `+` path, so an
unusable remembered model no longer blocks starting a session.

## Goals

1. `+` always creates a session when the remembered policy is structurally complete
   and the machine advertises the fallback capability, falling back to the configured
   `lightweight` utility model whenever the policy's active target cannot resolve —
   including when the client's tier catalog is unavailable, loading, or failed.
2. Treat the fallback as the new remembered policy: exact mode, the resolved
   lightweight tuple, preserving the previously remembered canonical tier.
3. Make the substitution visible: a pre-start warning on the starter when the client
   can evaluate the policy, and a post-start notice naming the model actually used.
4. Fail loudly and explicitly when the fallback itself cannot resolve; the lightweight
   slot is a user responsibility.
5. Make the decision server-authoritative so the stale-client-catalog case also
   recovers, with a capability gate for older remote daemons.

## Non-goals

- The `+` interaction itself: no new dialog, repair flow, or creation-contract change.
- Policy edits on existing sessions (`saveModelPolicy`); they keep today's
  validate-and-report behavior and are not fallback-eligible.
- Non-plus creation paths (spawn, fork, legacy start) and the legacy
  `initializeSessionModelPolicy` path.
- Structurally incomplete starter drafts (no provider/model/level, or a Tiered draft
  with no canonical tier); these remain blocked with the current message.
- Corrupt or unreadable preference files; `starterModelPolicyPreferenceError`
  behavior is unchanged (valid Exact defaults are seeded instead).
- Fixing the client tier-catalog staleness itself. This feature mitigates its
  user-visible failure but does not replace that work (the abandoned
  `model-catalog-refresh` run).
- `README.md`: this is detailed configuration behavior; it belongs in `docs/config.*`
  per the documentation guide.

## Behavior contract

### Trigger

All of the following must hold:

1. Creation is the complete-policy plus path (`creationSource: "session-list-plus"`,
   `initializeModelPolicy.kind === "complete-policy"`).
2. The requested policy is structurally valid (guaranteed by the request parser).
3. Resolving the requested policy's **active target** fails with a recognized
   resolution error — tier planning (`planSessionModelPolicyInitialization` via the
   tier registry) or runtime validation (`resolveAvailableExactSelection`).
4. The utility resolver returns a lightweight candidate.

Unrecognized errors (infrastructure failures, programming errors) never trigger the
fallback; they propagate exactly as today.

### Substituted policy

```ts
{
  mode: "exact",
  exact: { model: { provider, id }, thinkingLevel },
  // preserved when the requested policy carried a canonical tier
  ...(requested.tier === undefined ? {} : { tier: requested.tier }),
}
```

The model and level are exactly the resolved `candidate.model` and
`candidate.thinkingLevel` from the utility resolver. The resolver's own rule applies:
an explicitly configured `thinkingLevel` that the model does not support makes the
slot produce **no candidate** (documented behavior at `docs/config.md:284`); the
resolver's `minimal`-then-`off` fallback applies only when the slot's level is unset.
The session service never clamps or substitutes a level itself.

### Remember semantics

The created session's persisted policy is the substituted policy, so the existing
confirmed writeback (`rememberCurrentModelPolicy`, plus-root only) stores it as the
workspace's remembered starter preference. The client adopts the server-confirmed
preference into the starter draft. Future `+` starts resolve the remembered
lightweight policy directly; the original model returns only when the user reselects
it.

### Visibility

- **Pre-start (start screen), when the client can evaluate:** the model-policy control
  shows a warning built from the live evaluation reason plus a contingent clause,
  e.g. `Selected provider/model is unavailable. The session may start with the
  Lightweight utility model.` Start stays enabled. The warning is a non-blocking,
  untruncated `role="status"` line, not the compact danger diagnostic. It is
  contingent because the client catalog can be stale in either direction.
- **Pre-start, when the client cannot evaluate** (catalog absent/loading/failed):
  no warning; the start proceeds server-authoritatively.
- **Post-start (start screen and chat view):** a one-time `policy-fallback` starter
  notice names the model actually used, e.g. `Session started with the Lightweight
  utility model (provider/id) because the remembered model was unavailable.` The
  notice uses the existing notice channel, which renders as a sibling of the error
  banner and is therefore visible even when a session is selected. It is retained in
  scope until the next start attempt, starter edit, or scope change (existing
  captured-notice semantics).
- **Starter draft:** replaced by the server-confirmed preference after a successful
  creation, unless the user edited the draft after dispatching the start.
- **Session:** its model status shows the lightweight model; no extra marker.

### Failure

When no lightweight candidate resolves (slot unset, utility config invalid, model
absent, level unsupported, resolution failure, or the candidate fails session-scoped
re-validation), the
start fails with one error naming the original resolution failure, the lightweight
model requirement, the precise reason, and the configuration location
(`utilityModels.lightweight` / Settings → Utility models). The runtime is aborted and
disposed and no durable transcript is written. The client failure reporting is
unchanged (`Failed to start session: <message>`).

### Non-fallback behavior

When the requested policy resolves, behavior is identical to today's server path: no
substitution, no preference change. The client may still have shown the contingent
pre-start warning when its catalog was stale; that is an accepted consequence of the
contingent wording.

## Architecture

### Server: resolution split in `PiSessionService`

`initializeCompleteSessionModelPolicy` (`piSessionService.ts:5673`) keeps its current
post-resolution sequence (settings settle, idle assert, apply, persist, verify,
commit). Its resolve phase becomes a private method whose return type carries the
**bound runtime model** that `applyExactSelection` consumes:

```ts
private async resolveInitialSessionModelPolicy(
  session: PiAgentSession,
  requested: SessionModelPolicy,
): Promise<{
  plan: SessionModelPolicyPlan;
  resolved: { model: AgentModel; selection: ExactModelSelection };
  fallback?: { requestedPolicy: SessionModelPolicy; reason: string };
}>;
```

1. Refresh once (`session.modelRuntime.refresh({ allowNetwork: false })`) so tier
   planning and exact validation see the same snapshot. A refresh failure propagates
   untouched (never fallback-eligible).
2. Try `planSessionModelPolicyInitialization(requested, tierResolver)` then
   `resolveAvailableExactSelection(session, plan.target)`. On success return the plan
   and the bound `resolved` unchanged; the caller must apply `resolved` without
   re-resolving.
3. Catch only recognized resolution failures (below). Rethrow everything else.
4. On a recognized failure, inspect the utility resolver, take the first lightweight
   candidate, build the substituted plan with the pure helper, defensively
   re-validate it through `resolveAvailableExactSelection`, and return the plan,
   bound `resolved`, and fallback metadata for logging. A re-validation failure is
   final — no further candidates are attempted.

Only this resolve phase is fallback-eligible. Failures after it (settings, apply,
append, verification, durable commit) keep failing hard with the existing rollback.

**Recognized resolution failures.** A typed class bounds the catch:

- `TierResolutionError` (new, exported by `modelTierRegistry.ts`) is thrown by
  `resolve()` and `resolveTier()` for: unknown tier, missing ladder entry, unavailable
  model, unknown/unsupported thinking level, and missing/invalid tier configuration.
  `validateLadder` continues to report rather than throw for bad ladders.
- `SessionModelPolicyResolutionError` (new, exported by `sessionModelPolicy.ts`) is
  thrown by `resolveAvailableExactSelection` for its three validation failures:
  model not found, unknown thinking level, unsupported thinking level. The runtime
  refresh it performs is not wrapped; a refresh failure propagates.

`planSessionModelPolicyInitialization`'s own `tiered policy is missing a canonical
tier` error is unreachable from the validated request path and is deliberately **not**
recognized; it would indicate a bug and must not silently downgrade the model.

**Pure helper module** `src/server/sessions/sessionModelPolicyFallback.ts`:

```ts
export function fallbackSessionModelPolicy(
  requested: SessionModelPolicy,
  candidate: { provider: string; id: string; thinkingLevel: string },
): SessionModelPolicyPlan;

export function initialPolicyUnavailableError(
  requested: SessionModelPolicy,
  cause: unknown,
  unavailable: UtilityModelUnavailable | undefined,
): Error;
```

`cause` is retained as `Error.cause`. The message maps `UtilityModelUnavailable` to a
clause: `slot-unset` — no lightweight model configured; `config-invalid` — the utility
configuration is invalid; `model-unavailable` — its model is unavailable;
`thinking-level-unsupported` — its configured thinking level is unsupported;
`resolution-failed` — the lightweight model could not be resolved; and an `undefined`
unavailable (a candidate existed but failed session-scoped re-validation) — the
lightweight model is not available to this session. It always names
Settings → Utility models.

**Resolver diagnostics.** `UtilityModelResolver` gains an additive method that reports
why a task produced no candidate, while `configuredCandidates` remains the array API
used by the extension and speech polishing:

```ts
export type UtilityModelUnavailableReason =
  | "slot-unset"
  | "config-invalid"
  | "model-unavailable"
  | "thinking-level-unsupported"
  | "resolution-failed";

export interface UtilityModelUnavailable {
  reason: UtilityModelUnavailableReason;
  detail?: string;
}

export interface UtilityModelInspection<TModel> {
  candidates: readonly ResolvedUtilityModel<TModel>[];
  unavailable?: UtilityModelUnavailable;
}

inspect(task: UtilityModelTask): Promise<UtilityModelInspection<TModel>>;
```

`configuredCandidates` becomes a thin `(await inspect(task)).candidates` wrapper.
Existing fakes and consumers are updated to the extended interface.

### Client: one start decision for both `+` and prompt send

New client module `src/client/src/components/starterPolicyStartDecision.ts`:

```ts
export function isStructurallyCompleteStarterPolicy(
  draft: SessionModelPolicyDraft,
): boolean;

export type StarterStartDecision =
  | { kind: "ready" }
  | { kind: "fallback"; requested: StarterModelPolicyPreference; warning?: string }
  | { kind: "blocked"; reason: string };

export function starterStartDecision(input: {
  draft: SessionModelPolicyDraft | undefined;
  catalog: ModelTierSettingsResponse | undefined;
  fallbackSupported: boolean; // sessions.modelPolicyLightweightFallback
}): StarterStartDecision | undefined;
```

Rules (selection-capable machines only; the legacy non-selection path is unchanged):

- `draft === undefined` → `undefined` (still loading).
- Draft not structurally complete → `blocked` with the existing reason.
- `catalog === undefined` and `fallbackSupported` → `fallback` with no warning
  (server-authoritative).
- Catalog evaluation ready → `ready`.
- Catalog evaluation blocked and `fallbackSupported` → `fallback` with the live
  evaluation reason plus the contingent warning clause.
- Catalog evaluation blocked and not supported, or catalog undefined and not
  supported → `blocked` with the existing reason.
- A structurally incomplete draft is always `blocked` with today's reason precedence
  unchanged, including the catalog-loading and catalog-error texts when the missing
  part could still be filled by the catalog.

`isStructurallyCompleteStarterPolicy` matches the server request parser: non-blank
Exact provider/id/thinking in **both** modes, and a canonical tier when the mode is
Tiered. It reuses the existing syntax checks in `sessionModelPolicyDraft.ts` (exported
for the predicate). The preference sent for a fallback start is built by a new
exported complete-policy builder, `starterModelPolicyPreference(draft)`, which is the
same `{ mode, exact, tier? }` shape `evaluateStarterModelPolicyDraft` already produces.
The legacy `starterModelPolicyPreferenceFromDraft` (mode/tier only, no `exact`) is not
used for the plus request.

`PiWebUiApp` extends its starter input projection:

- `starterModelPolicyInputs()` additionally returns the decision and the warning.
- In the fallback state the projected status omits `blockedReason`, so the danger
  diagnostic, `sendDisabled`, and `policy-blocked` notice retention all turn off. The
  warning travels `PiWebUiApp` → `PromptEditor` (new `.modelPolicyWarning` property)
  → `SessionModelPolicyControl` (new `warning` property) and renders as an
  untruncated `role="status"` line. When a warning is present the control suppresses
  its compact danger diagnostic; `ladderValid` remains on the status, but the ladder
  message is not repeated because the warning text already carries the live reason.
- `starterModelPolicyBlocksStart()`, `startSessionAndOpenChat`, and
  `handleStartSessionPrompt` all consult the decision: `blocked` keeps today's
  refusal; `fallback` starts with the structurally complete preference and no
  catalog validation; `ready` is unchanged.
- The start path no longer waits for the tier catalog when the fallback capability is
  present; the catalog still loads for the pre-start warning. Starter defaults are
  still required (their failure keeps the `defaults-failed` path).

### Client: substitution detection and preference adoption

The two outcomes are deliberately decoupled:

- **Substitution notice — from the created session's persisted status.** The
  controller correlates a created session with an outstanding plus pending start by
  machine and cwd (the correlation `applyCreatedSession` already uses) and records the
  pending start's requested policy under the created session id. Capture is idempotent
  from either correlation point (`session.created` observation or pending-start
  resolution), so it does not depend on HTTP-response ordering. On capture, and on
  every applied model-policy status for that id, the comparison runs once:
  - requested Exact → substitution iff the status is not `exact` with a
    `sameExactSelection` tuple;
  - requested Tiered → substitution iff the status mode is `exact` (a resolved
    Tiered creation always persists `mode: "tiered"`).
  If a status was already stored for the id at capture time, it is compared
  immediately; otherwise the next status is. On substitution the controller emits
  `onStarterModelPolicySubstitution`, and the app publishes a `policy-fallback`
  notice scoped to the session's machine and workspace. The entry is consumed once.
  Because this is driven by the server-persisted session status, it does not depend
  on the client preference POST succeeding.
- **Preference adoption — from the writeback response.**
  `StarterModelPolicyConfirmedEvent` becomes a discriminated union carrying the write
  reason and the creation's requested policy:

```ts
export type StarterModelPolicyConfirmedEvent =
  | { reason: "creation"; machineId: string; session: SessionInfo; requestedPolicy: StarterModelPolicyPreference }
  | { reason: "policy-save"; machineId: string; session: SessionInfo; policy: StarterModelPolicyPreference };

export type ConfirmedPreferenceWriteContext =
  | { reason: "creation"; requestedPolicy: StarterModelPolicyPreference }
  | { reason: "policy-save" };
```

- `SessionControllerDependencies` gains an optional
  `onStarterModelPolicySubstitution(event)` callback carrying
  `{ machineId, session, requestedPolicy, confirmed: { mode, resolved } }`; the app
  maps it to the `StarterNoticeScope` for the session's workspace.
- `handleStarterModelPolicyConfirmed` no longer adopts `event.policy` for creations;
  it forwards the context to `ConfirmedStarterModelPolicyPreferenceWriter.write(...)`.
  For saves it keeps today's immediate adoption from the confirmed save policy.
- `write(scope, session, context)` coalesces per workspace scope as today; the newest
  write context wins, and the preference written is the daemon's newest confirmed
  policy for that workspace.
- On success the writer reports `onRemembered(scope, preference, context)`; for
  creations the app adopts the preference only when the scope still matches and the
  current draft is value-equal to the dispatch snapshot, which is exactly
  `modelPolicyDraftFromPolicy(context.requestedPolicy)` — no separate captured draft
  or generation is needed. A user edit after dispatch wins and is never clobbered.
- On write failure the writer records the existing warning; the preference is
  unchanged, the notice has already been emitted from the status, and the next `+`
  falls back again. The warning text is reworded so it does not claim the preference
  was updated.
- A discarded pending start remains exactly as today: no selection, no status
  observation, no notice, and no preference write for that creation.

`StarterNoticeKind` gains `"policy-fallback"` with captured text, alongside
`start-failed`/`defaults-failed`.

### Capability

New `sessions.modelPolicyLightweightFallback` in `PI_WEBUI_CAPABILITIES`, advertised
by **web and sessiond** with an effective-requirements entry. The client only softens
the block when the selected machine's runtime is `ok` and advertises it, following
`starterModelPolicySelectionSupportedForState` (`PiWebUiApp.ts:4951`). An older daemon
keeps today's hard block.

| Service component | Capability |
| --- | --- |
| web | `sessions.modelPolicyLightweightFallback` |
| sessiond | `sessions.modelPolicyLightweightFallback` |

The daemon substitutes unconditionally; capability gating is client-side. An older
client bundle talking to a new daemon therefore receives the substituted session
without the new notice (user-confirmed residual; the session model itself still shows
the lightweight model).

### Files and seams

| Concern | Location |
| --- | --- |
| Resolve split, typed failures, fallback orchestration | `src/server/sessions/piSessionService.ts` |
| Typed resolution errors | `src/server/sessions/modelTierRegistry.ts`, `src/server/sessions/sessionModelPolicy.ts` |
| Pure substituted-policy and error builders | `src/server/sessions/sessionModelPolicyFallback.ts` (new) |
| Resolver diagnostics | `src/server/sessions/utilityModelResolver.ts` |
| Structural predicate, decision | `src/client/src/components/starterPolicyStartDecision.ts` (new), `sessionModelPolicyDraft.ts` |
| Start gating, warning projection, notice, adoption | `src/client/src/components/PiWebUiApp.ts` |
| Warning rendering | `src/client/src/components/PromptEditor.ts`, `src/client/src/components/SessionModelPolicyControl.ts` |
| Status-derived substitution detection / notice event | `src/client/src/controllers/sessionController.ts` |
| Write context and `onRemembered` | `src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.ts` |
| Notice kind | `src/client/src/components/starterNotice.ts` |
| Capability | `src/shared/apiTypes.ts`, `src/shared/capabilities.ts` |

## Data flow

1. Starter load: remembered preference → draft; catalog loads in the background.
2. Decision:
   - catalog ready + policy valid → `ready`;
   - catalog ready + policy blocked → `fallback` + contingent warning;
   - catalog unavailable → `fallback` without a warning;
   - structurally incomplete → `blocked`.
3. `+` / prompt send → complete `initialModelPolicy` sent; the controller captures
   the requested policy for status comparison.
4. Daemon: `start` → `initializeModelPolicy: complete-policy` →
   `resolveInitialSessionModelPolicy`:
   - requested resolves → today's path;
   - recognized resolution failure → lightweight candidate → substituted exact policy
     → defensive re-validation → apply → persist policy + creation source → durable
     commit → `session.created`.
5. Client resolves the pending start, selects the session, and observes the first
   model-policy status.
6. Status comparison detects a substitution → `policy-fallback` notice.
7. The plus creation triggers the confirmed writeback with the creation context;
   the daemon re-reads the persisted policy, replaces the workspace preference, and
   returns it.
8. The writer reports the confirmed preference; the app adopts it into the starter
   draft when the draft is unchanged since dispatch.

## Invariants

1. **Never fall back when the requested policy resolves.** No probing, no extra
   notice, no preference change.
2. **Only recognized resolution failures are fallback-eligible.** Infrastructure,
   persistence, verification, and programming errors keep failing hard.
3. **Exactly one substitution per creation.** The candidate comes only from the
   server-side utility resolver; the client never invents one. A candidate that fails
   session-scoped re-validation is final.
4. **No silent substitution.** Every substitution is logged (info) with the requested
   policy and failure reason, announced by a post-start notice in current clients, and
   visible as the session's model in every client.
5. **Fail closed on a missing fallback.** No candidate means an explicit error naming
   `utilityModels.lightweight`, never the requested policy's silent reuse.
6. **Rollback unchanged.** A failed creation still aborts/disposes the runtime. On a
   resolve-phase failure nothing durable was written; on a later failure the existing
   discard path still applies.
7. **Canonical tier preserved.** A fallback from Tiered mode keeps the remembered
   canonical tier for a later switch back.
8. **The substituted policy is exact.** Any Tiered request that falls back persists
   `mode: "exact"`; its inactive Exact branch is intentionally replaced by the
   lightweight tuple, which the policy shape can express.

## Testing strategy

Per the repository testing guide; smallest layer that proves the behavior.

- **Pure helper tests**
  - `fallbackSessionModelPolicy`: exact shape, candidate tuple, tier preserved and
    absent.
  - `initialPolicyUnavailableError`: each unavailable reason maps to its clause; the
    original cause is retained.
  - `isStructurallyCompleteStarterPolicy`: both modes, blank fields, Tiered without a
    canonical tier.
  - `starterStartDecision`: ready / fallback (catalog blocked) / fallback (catalog
    unavailable) / blocked / unsupported capability / undefined draft, including the
    precedence of structural incompleteness.
- **Resolver tests**
  - `inspect` reports each unavailable reason; `configuredCandidates` stays
    behaviorally identical for existing consumers.
  - Existing fakes updated to the extended interface.
- **Server service tests** (`piSessionService.modelPolicy.test.ts`)
  - Harness change: `createModelPolicyHarness` accepts an injected
    `utilityModelResolver` fake with deterministic candidates and inspection; the
    harness's tier-registry fake must throw `TierResolutionError` so the typed catch
    is exercised. New fallback tests use the fakes, and no-candidate tests pass an
    explicitly empty result.
  - The two existing plus-rejection tests (`:823-868`) are recast as fallback-success
    tests with a candidate present; their original rejection assertions move to new
    tests with an explicitly empty candidate set.
  - Exact invalid / tier unresolvable / unsupported level → fallback applied;
    persisted policy is exact lightweight with the remembered tier;
    `creationSource` remains `session-list-plus`.
  - Requested policy resolves → no fallback; persisted policy unchanged.
  - Unrecognized error (e.g. refresh failure, injected programming error) → no
    fallback.
  - Lightweight invalid/missing → explicit error per reason; abort/dispose and no
    `session.created`.
  - Candidate found but session-scoped re-validation fails → final explicit error.
  - Remember command stores the fallback preference.
  - Non-plus creation paths untouched.
- **Client tests**
  - Start decision wiring: fallback starts both from the nav `+` and prompt send;
    incomplete still blocks; capability absent still blocks; catalog-unavailable
    starts without a warning.
  - Warning projection: fallback omits `blockedReason`, enables Start, renders the
    untruncated `role="status"` warning, and drops a retained `policy-blocked`
    notice.
  - Status-derived substitution detection: exact tuple, tiered mode, level-only
    difference, no substitution when the requested policy resolves, one-shot
    consumption, and capture-time reconciliation when the status was applied before
    the creation could be correlated.
  - Adoption: from `onRemembered` only when the draft is unchanged; not adopted after
    a user edit; save-path adoption unchanged.
  - `policy-fallback` notice scope and retention.
- **Capability tests** (`src/shared/capabilities.test.ts`) for both runtime lists and
  the effective-requirements record.
- No route or parser changes, so no new route-contract tests.

## Documentation and release

- `docs/config.md` utility-models section: document that an unusable remembered `+`
  policy starts on `lightweight` in exact mode, that this becomes the remembered
  policy, that the slot must stay configured or starts fail, and that older clients
  see the substitution only as the session's model. Mirror the change in
  `docs/config.html`.
- `docs/faq.html`: short troubleshooting entry, "my session started on the lightweight
  model — how do I restore my model".
- Changeset: **minor** (user-visible feature).
- No `README.md` change.

## Risks and residual behavior

- **Transient unavailability becomes permanent.** A provider outage or expired auth
  also swaps the remembered model to lightweight. Accepted by the user; mitigated by
  the visible warning and notice. There is no clean "durably gone" signal — the live
  runtime snapshot is the only availability authority.
- **Catalog staleness is not fixed.** A client-stale-invalid catalog shows a
  contingent warning that may not come true; a client-stale-valid catalog substitutes
  with the post-start notice. The abandoned `model-catalog-refresh` work remains
  separate.
- **Older client bundles** talking to a new daemon substitute without the new notice
  (user-confirmed residual); the session's model selector still shows lightweight.
- **Discarded pending starts** are not announced and do not update the preference
  (today's behavior); the created session, if surfaced later, shows the lightweight
  model.
- **Remember-write failure** leaves the preference unchanged; the notice has already
  been published from the status, and the next `+` falls back again.
- **Remote daemons without the capability** keep the hard block; they recover only
  after an upgrade.
- **Weaker model by design.** A coding session may continue on a small model; the user
  accepts this as the price of never blocking `+`.

## Acceptance criteria

1. With a complete but unresolvable remembered policy and a valid lightweight slot,
   `+` creates a session in exact mode on the lightweight model in one attempt —
   Exact-invalid, Tier-invalid, and level-invalid cases alike.
2. The created session's persisted policy is the substituted exact policy; when the
   confirmed writeback runs and succeeds, the workspace preference is replaced by it.
3. When the client can evaluate the policy, the user sees the contingent pre-start
   warning; when a substitution occurs, the user sees the post-start notice naming
   the used model.
4. With an invalid or missing lightweight slot, `+` fails with an explicit error
   naming the original failure and the lightweight configuration reason; no session is
   created or left published.
5. When the server resolves the requested policy, the session starts on it and the
   remembered preference is unchanged; the client may have shown the contingent
   warning.
6. Structurally incomplete drafts and daemons without the capability are blocked as
   today; a structurally complete draft with an unavailable catalog starts
   server-authoritatively.
7. An older client bundle against a new daemon whose cached catalog is stale-valid
   substitutes and shows the lightweight model without the new notice (accepted
   residual); an older client whose cached catalog blocks still refuses before
   sending.

## Design review history

- **Attempt 1** (subsession `01a0deea-e85c-743c-84b2-86d9d23873f4`, report
  `reports/design-review-attempt-1.md`): CHANGES REQUIRED — 3 blockers, 8 majors,
  5 minors, 3 observations. All resolved: the seam returns the bound runtime model;
  the notice equality is mode-aware; the write context is explicit and the notice no
  longer depends on the client POST; resolver level semantics, warning projection,
  diagnostics, structural predicate, contingency wording, test harness seam, tier
  refresh, and minor clarifications are incorporated.
- **Attempt 2** (subsession `01a0df00-a298-743c-84b2-86dfd11b315c`, report
  `reports/design-review-attempt-2.md`): CHANGES REQUIRED — **0 blockers**, 4 majors,
  5 minors. All attempt-1 blockers verified resolved. The four majors are resolved in
  this revision: the complete-policy builder is named and the legacy builder excluded;
  the write context is carried on a discriminated confirmation event with a
  draft-equality adoption guard; the status capture reconciles against an
  already-applied status; and the unavailable-reason clauses and type are declared.
  Minors folded in: compact ladder diagnostic suppression under a warning, harness
  tier-fake typing, the `PromptEditor` warning property, the substitution callback
  surface, and AC2/AC7 qualification.
