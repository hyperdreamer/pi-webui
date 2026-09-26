# Lightweight fallback for SESSIONS `+` session creation — Specification

- **Status:** Implementation-ready specification for planning
- **Date:** 2026-09-27
- **PM run:** `pm-run-20260927-021015-30213465`
- **Topic slug:** `plus-lightweight-fallback`
- **Delivery target:** `refs/heads/main` @ `13d4c52c7597160317fa7bdcc9504518f92006f0`
- **Source design:** `docs/superpowers/specs/2026-09-27-plus-lightweight-fallback-design.md` (approved,
  two frontier design reviews, 0 blockers)
- **Verification base:** every interface, type, message, call sequence, and line reference below was
  checked against the repository source checked out at `13d4c52`. Where the design's short prose and
  the source differ, the source wins; deviations are recorded in §10.

This specification does not reopen design decisions. It fixes the exact names, shapes, messages,
call order, test files, fixtures, and commands the planner and implementers need. There are no TBDs
and no implementation is performed here.

---

## 1. Scope and non-goals

### 1.1 Scope

1. Server-authoritative fallback in the complete-policy plus start path
   (`creationSource: "session-list-plus"` + `initializeModelPolicy.kind === "complete-policy"`):
   when the requested policy's **active** target fails a recognized resolution step, the daemon
   substitutes the machine's configured `utilityModels.lightweight` tuple as an Exact policy and
   completes the creation.
2. The substituted policy becomes the session's persisted policy, so the existing confirmed
   writeback (`rememberCurrentModelPolicy`, plus-root only) replaces the workspace's remembered
   starter preference; the client adopts the server-confirmed preference into the starter draft.
3. Client-visible substitution: a contingent pre-start warning when the client can evaluate the
   remembered policy, and a post-start `policy-fallback` starter notice naming the model actually
   used.
4. Explicit failure when no lightweight candidate resolves, naming the original resolution failure,
   the lightweight requirement, the precise reason, and `utilityModels.lightweight` /
   Settings → Utility models.
5. A new `sessions.modelPolicyLightweightFallback` capability advertised by web and sessiond, with
   client-side gating for remote/older daemons.

### 1.2 Non-goals (approved; do not implement)

- No change to the `+` interaction itself: no new dialog, repair flow, or creation-contract change.
- `saveModelPolicy` on existing sessions keeps today's validate-and-report behavior and is **not**
  fallback-eligible.
- Non-plus creation paths (spawn, fork, legacy start) and the legacy
  `initializeSessionModelPolicy` path are untouched.
- Structurally incomplete starter drafts stay blocked with the current message.
- Corrupt/unreadable starter preference files keep `starterModelPolicyPreferenceError` behavior.
- Client tier-catalog staleness itself is not fixed (the abandoned `model-catalog-refresh` work
  stays separate).
- `README.md` is not edited.

---

## 2. Invariants

These are binding for the implementation and for review:

1. Never fall back when the requested policy resolves: no probing, no extra notice, no preference
   change.
2. Only recognized, typed resolution failures are fallback-eligible. Infrastructure, persistence,
   verification, and programming errors keep failing hard and propagate untouched.
3. Exactly one substitution per creation. The candidate comes only from the server-side utility
   resolver; a candidate that fails session-scoped re-validation is final; no second candidate is
   attempted.
4. No silent substitution: every substitution is logged at info with the requested policy and the
   failure reason, announced by a post-start notice in current clients, and visible as the session's
   model in every client.
5. Fail closed on a missing fallback: no candidate means the explicit
   `initialPolicyUnavailableError`, never a silent reuse of the requested policy.
6. Rollback is unchanged. A resolve-phase failure wrote nothing durable and ran no setter; a later
   failure still discards the initial entries and restores the previous selection/settings, and the
   start path still aborts and disposes the runtime.
7. Canonical tier preserved: a fallback from Tiered mode keeps the remembered canonical tier.
8. The substituted policy is exact (`mode: "exact"`), even when the requested policy was Tiered; the
   inactive Exact branch is intentionally replaced by the lightweight tuple.

---

## 3. Server contract

### 3.1 Resolve split in `PiSessionService`

File: `src/server/sessions/piSessionService.ts`.

Current code (verified at `13d4c52`): `initializeCompleteSessionModelPolicy` at line 5673 plans the
requested policy inline with `planSessionModelPolicyInitialization` (5678), resolves the target via
`resolveAvailableExactSelection` (5690), then runs the post-resolution sequence (settings settle,
idle assert, `applyExactSelection`, settle, `appendSessionModelPolicy`, verify, append creation
source, `commitAndVerifyInitialSessionEntries`).

New private method, added immediately before `initializeCompleteSessionModelPolicy`:

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

`SessionModelPolicyPlan`, `ExactModelSelection`, and `SessionModelPolicy` are existing types
(`sessionModelPolicy.ts:16`, `shared/apiTypes.ts:244`, `shared/apiTypes.ts:286`). Add
`type SessionModelPolicyPlan` to the existing `sessionModelPolicy.js` import block in
`piSessionService.ts` (currently lines 186–193). `AgentModel` is the file-local alias at line 522
(`NonNullable<SpawnSessionInvocation["model"]>`); it is already used by private method return types,
so no export is needed.

Exact call sequence of `initializeCompleteSessionModelPolicy` after the change:

1. `const { plan, resolved, fallback } = await this.resolveInitialSessionModelPolicy(session, policy);`
2. If `fallback !== undefined`, log the substitution (§3.5):
   ```ts
   this.logger.info(
     {
       sessionId: session.sessionId,
       cwd: session.sessionManager.getCwd(),
       requestedPolicy: fallback.requestedPolicy,
       fallbackPolicy: plan.policy,
       reason: fallback.reason,
     },
     "session model policy fell back to the lightweight utility model",
   );
   ```
3. `const settings = modelPolicySettingsPersistence(session.settingsManager);`
4. `await settleModelPolicySettings(settings, "before complete session initialization");`
5. `this.assertModelPolicyMutationIdle(session, "initialize the session model policy");`
6. Capture `initialization: CompleteModelPolicyInitialization` exactly as today.
7. Inside `runSessionModelPolicyMutation`: `await this.applyExactSelection(session, resolved);`
   (the **bound** `{ model, selection }` from step 1 — no re-resolution), settings settle,
   `this.appendSessionModelPolicy(session, plan.policy);`, `verifyPersistedSessionModelPolicy`,
   `appendSessionCreationSource(session, source)`, `commitAndVerifyInitialSessionEntries`.
8. On any failure in steps 3–7: existing `rollbackCompleteSessionInitialization` +
   `completeInitializationFailure` (unchanged).

Exact sequence of `resolveInitialSessionModelPolicy`:

1. `await session.modelRuntime.refresh({ allowNetwork: false });` — a rejection propagates untouched
   and is never fallback-eligible. This refresh is **additional** to the refresh inside
   `resolveAvailableExactSelection` (step 3), which the method retains; the requested path therefore
   performs two refreshes, and tier planning reads the snapshot made fresh by this step.
2. Build the requested plan:
   ```ts
   const requestedPlan = planSessionModelPolicyInitialization(requested, (tier) => {
     const resolved = this.modelTierRegistry.resolve(tier);
     return {
       model: { provider: resolved.model.provider, id: resolved.model.id },
       thinkingLevel: resolved.thinkingLevel,
     };
   });
   ```
   (`planSessionModelPolicyInitialization` deep-clones the policy, so `requestedPlan.policy` is an
   owned copy.)
3. `const resolved = await this.resolveAvailableExactSelection(session, requestedPlan.target);`
4. Return `{ plan: requestedPlan, resolved }` — the success path keeps today's setter, persistence,
   and verification sequence; the only addition is the step-1 pre-plan refresh (the design's
   "refresh once" plus the method's existing internal refresh).
5. Catch:
   ```ts
   if (!(error instanceof TierResolutionError) && !(error instanceof SessionModelPolicyResolutionError)) {
     throw error;
   }
   ```
   `TierResolutionError` is imported from `./modelTierRegistry.js`,
   `SessionModelPolicyResolutionError` from `./sessionModelPolicy.js` (§3.2).
6. Fallback branch:
   ```ts
   const inspection = await this.utilityModelResolver.inspect("lightweight");
   const candidate = inspection.candidates[0];
   if (candidate === undefined) {
     throw initialPolicyUnavailableError(requested, error, inspection.unavailable);
   }
   const fallbackPlan = fallbackSessionModelPolicy(requested, {
     provider: candidate.model.provider,
     id: candidate.model.id,
     thinkingLevel: candidate.thinkingLevel,
   });
   try {
     const fallbackResolved = await this.resolveAvailableExactSelection(session, fallbackPlan.target);
     return {
       plan: fallbackPlan,
       resolved: fallbackResolved,
       fallback: {
         requestedPolicy: requested,
         reason: error instanceof Error ? error.message : String(error),
       },
     };
   } catch (fallbackError) {
     if (!(fallbackError instanceof SessionModelPolicyResolutionError)) throw fallbackError;
     throw initialPolicyUnavailableError(requested, error, undefined);
   }
   ```
7. The nested catch is final: no further candidates, no retry. Only a
   `SessionModelPolicyResolutionError` from the re-validation maps to the `unavailable === undefined`
   clause; every other re-validation error — including the internal `refresh` inside
   `resolveAvailableExactSelection` — is infrastructure and is rethrown untouched, exactly like the
   requested path (§3.2.2, §3.5). `cause` passed to `initialPolicyUnavailableError` is always the
   **original** recognized failure, not the re-validation failure (§3.3).

`this.utilityModelResolver` already exists and is the field initialized at
`piSessionService.ts:1296`/`1344`, injected via `PiSessionServiceDependencies.utilityModelResolver`
(`:1137`).

### 3.2 Recognized resolution failures

#### 3.2.1 `TierResolutionError` (`src/server/sessions/modelTierRegistry.ts`, new export)

```ts
export class TierResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierResolutionError";
  }
}
```

Throw sites (same file; every existing `throw new Error(...)` inside `resolveTier` and the config
/defensive throws inside `createModelTierRegistry().resolve` becomes `TierResolutionError`, messages
unchanged):

| Stage | Site | Message |
| --- | --- | --- |
| unknown tier | `resolveTier` | `unknown tier: ${tier}` |
| missing ladder entry | `resolveTier` | `tier ${tier} has no ladder entry` |
| unavailable model (ladder entry) | `resolveTier` | `tier ${tier} names unavailable model ${describeModel(entry.model)}` |
| unknown thinking level | `resolveTier` | `tier ${tier} names unknown thinking level ${entry.thinkingLevel}` |
| unsupported thinking level | `resolveTier` | `tier ${tier} names thinking level ${entry.thinkingLevel}, unsupported by ${describeModel(entry.model)}` |
| invalid tier configuration | `createModelTierRegistry().resolve` | `model tier configuration is invalid: ${config.modelTiersError}` |
| missing tier configuration | `createModelTierRegistry().resolve` | `model tier configuration is missing` |
| unavailable model (defensive re-lookup after `resolveTier`) | `createModelTierRegistry().resolve` | `tier ${tier} names unavailable model ${resolved.model.provider}/${resolved.model.id}` |

`validateLadder` and `ModelTierRegistry.validate()` are unchanged; `validateLadder` catches `Error`,
so it keeps returning `{ valid: false, reason }` instead of throwing. `validate()` keeps calling
`validateLadder` (which calls `resolveTier`), so a bad ladder still reports rather than throws.

#### 3.2.2 `SessionModelPolicyResolutionError` (`src/server/sessions/sessionModelPolicy.ts`, new export)

```ts
export class SessionModelPolicyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionModelPolicyResolutionError";
  }
}
```

The class is exported by `sessionModelPolicy.ts`; the throw sites are the three validation arms of
`PiSessionService.resolveAvailableExactSelection` (`piSessionService.ts:6073`), when the runtime
selection cannot be bound (all three currently plain `Error`; messages unchanged):

| Stage | Message |
| --- | --- |
| model not found in the session's candidate catalog | `Model not found: ${described}` where `described = ${selection.model.provider}/${selection.model.id}` |
| unknown thinking level | `Unknown thinking level ${selection.thinkingLevel} for ${described}` |
| unsupported thinking level for the bound model | `Thinking level ${selection.thinkingLevel} is unsupported by ${described}` |

The leading `await session.modelRuntime.refresh({ allowNetwork: false });` inside
`resolveAvailableExactSelection` is **not** wrapped: a refresh failure propagates untouched and is
never fallback-eligible (both on the requested target and on the fallback re-validation).

### 3.3 Pure helper module (`src/server/sessions/sessionModelPolicyFallback.ts`, new)

Imports: `type ExactModelSelection`, `type SessionModelPolicy` from `../../shared/apiTypes.js`;
`type SessionModelPolicyPlan` from `./sessionModelPolicy.js`; `type UtilityModelUnavailable` from
`./utilityModelResolver.js`.

```ts
export function fallbackSessionModelPolicy(
  requested: SessionModelPolicy,
  candidate: { provider: string; id: string; thinkingLevel: string },
): SessionModelPolicyPlan;
```

Behavior (pure; no mutation of either argument):

```ts
const exact: ExactModelSelection = {
  model: { provider: candidate.provider, id: candidate.id },
  thinkingLevel: candidate.thinkingLevel,
};
return {
  policy: {
    mode: "exact",
    exact,
    ...(requested.tier === undefined ? {} : { tier: requested.tier }),
  },
  target: { model: { ...exact.model }, thinkingLevel: exact.thinkingLevel },
};
```

The `target` is a separate clone of the tuple so the caller's defensive re-validation and
`plan.policy` never alias each other.

```ts
export function initialPolicyUnavailableError(
  requested: SessionModelPolicy,
  cause: unknown,
  unavailable: UtilityModelUnavailable | undefined,
): Error;
```

Behavior:

```ts
const original = cause instanceof Error ? cause.message : String(cause);
return new Error(
  `Could not start the session with the remembered model policy (${describeRequestedPolicy(requested)}): ${original} The lightweight utility model fallback is unavailable because ${unavailableClause(unavailable)}. Configure utilityModels.lightweight in Settings → Utility models.`,
  { cause },
);
```

`Error.cause` is retained via the ES2022 `ErrorOptions` overload (repo `target: ES2022`,
`lib: ES2022`).

`describeRequestedPolicy(requested)` (module-private):

| Requested shape | Description |
| --- | --- |
| `mode: "tiered"`, `tier` defined | `tier ${tier}` |
| `mode: "tiered"`, `tier` undefined (defensive) | `Tiered mode` |
| `mode: "exact"` | `${provider}/${id} at thinking level ${thinkingLevel}` |

`unavailableClause(unavailable)` — full unavailable-reason to message-clause table. `detail` is
appended as ` (${detail})` when it is a non-empty string (undefined and empty are both omitted):

| `unavailable` | Clause |
| --- | --- |
| `undefined` | `the lightweight model is not available to this session` |
| `{ reason: "slot-unset" }` | `no lightweight model is configured` |
| `{ reason: "config-invalid" }` | `the utility model configuration is invalid` |
| `{ reason: "model-unavailable" }` | `its configured model is unavailable` |
| `{ reason: "thinking-level-unsupported" }` | `its configured thinking level is unsupported` |
| `{ reason: "resolution-failed" }` | `the lightweight model could not be resolved` |

The `undefined` row is exactly the "a candidate existed but failed session-scoped re-validation"
case from §3.1 step 6. The message always contains `utilityModels.lightweight` and
`Settings → Utility models`.

### 3.4 `UtilityModelResolver.inspect`

File: `src/server/sessions/utilityModelResolver.ts`.

New exported types (above the `UtilityModelResolver` interface):

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

export interface UtilityModelInspection<TModel extends UtilityModelIdentity> {
  candidates: readonly ResolvedUtilityModel<TModel>[];
  unavailable?: UtilityModelUnavailable;
}
```

`UtilityModelResolver<TModel>` gains a required method; the array API stays:

```ts
export interface UtilityModelResolver<TModel extends UtilityModelIdentity> {
  inspect(task: UtilityModelTask): Promise<UtilityModelInspection<TModel>>;
  configuredCandidates(task: UtilityModelTask): Promise<readonly ResolvedUtilityModel<TModel>[]>;
}
```

Implementation: extract today's `configuredCandidates` body into `inspect`, then return

```ts
return {
  inspect,
  configuredCandidates: async (task) => (await inspect(task)).candidates,
};
```

`inspect` preserves the existing sequence exactly: `refresh({ allowNetwork: false })`, `loadConfig`,
`getAvailableSnapshot`, iterate `taskSlots[task]`, dedupe by model+level (first-seen order), and on a
caught `refresh`/`loadConfig`/snapshot failure still calls
`logNoThrow(deps.logger, { err: error, task }, "utility model resolution failed")` before returning
an empty result. `configuredCandidates` behavior is therefore byte-identical for the extension and
speech-polishing consumers.

Reason determination, evaluation order (first applicable wins). `unavailable` is present **iff**
`candidates.length === 0`; with at least one candidate it is omitted:

| # | Condition | `reason` | `detail` |
| --- | --- | --- | --- |
| 1 | `refresh()` rejects, `loadConfig()` throws, or `getAvailableSnapshot()` throws | `resolution-failed` | the thrown error's `message` (`String(error)` when not an `Error`) |
| 2 | `config.utilityModelsError !== undefined` | `config-invalid` | the `utilityModelsError` string |
| 3 | `config.utilityModels === undefined` | `slot-unset` | omitted |
| 4 | For the slot in `taskSlots[task]` order, the slot's model reference is `undefined` | `slot-unset` | omitted |
| 5 | The referenced model is absent from `getAvailableSnapshot()` | `model-unavailable` | `${provider}/${id}` from the configured reference |
| 6 | `effectiveThinkingLevel(reference, thinkingLevelsForModel(candidate))` returned `undefined` for an explicitly configured `thinkingLevel` the model does not support | `thinking-level-unsupported` | the explicit configured level |
| 7 | No candidate, no slot-level failure recorded (defensive only) | `resolution-failed` | omitted |

Rows 4–6 are evaluated in `taskSlots` order; the first slot failure is kept. Config-level failures
(rows 1–3) precede slot-level failures. For `"lightweight"` there is exactly one slot, so rows 4–6
are unambiguous. For `"context"` (`["context", "lightweight"]`) `unavailable` only appears when both
slots produced nothing, and the first failure in slot order is reported (see OQ-2).

`effectiveThinkingLevel` returns `undefined` only for an explicitly configured `thinkingLevel` the
model does not support; its automatic branch returns `"minimal"` or `"off"` unconditionally and
therefore never yields `thinking-level-unsupported`. `effectiveThinkingLevel` and
`configuredCandidates` stay byte-identical to today, and the resolver's `minimal`-then-`off` rule
itself is unchanged (§ design: "the resolver's `minimal`-then-`off` fallback applies only when the
slot's level is unset"). The session service never clamps or substitutes a level; it uses
`candidate.thinkingLevel` verbatim.

### 3.5 Fallback eligibility, logging, and rollback

Fallback-eligible (only these):

- `planSessionModelPolicyInitialization` failures caused by `modelTierRegistry.resolve` throwing
  `TierResolutionError` (all rows of §3.2.1).
- `resolveAvailableExactSelection(session, requestedPlan.target)` throwing
  `SessionModelPolicyResolutionError` (all rows of §3.2.2).
- The fallback candidate's re-validation throwing `SessionModelPolicyResolutionError` (final;
  reported as `unavailable === undefined`, bounded by the typed nested catch in §3.1 step 6).

Not fallback-eligible (propagate exactly as today):

- The resolve-phase refresh in §3.1 step 1, and the internal refresh inside
  `resolveAvailableExactSelection` on both the requested and fallback paths (any re-validation error
  other than `SessionModelPolicyResolutionError` is rethrown by §3.1 step 6).
- `planSessionModelPolicyInitialization`'s own
  `tiered policy is missing a canonical tier` plain `Error` (unreachable from the validated request
  path; it would be a bug and must not silently downgrade the model).
- Every failure after the resolve phase: settings settle, mutation idle assert, `applyExactSelection`,
  policy append, verification, creation-source append, durable commit, post-commit verification.
- `utilityModelResolver.inspect` throwing (the resolver contains its own errors; an escaped throw is
  an infrastructure failure).

Rollback behavior: unchanged. For a resolve-phase failure, `completeInitialization` is still
`undefined` in `start`, so the catch aborts and disposes the runtime, removes the active entry, and
publishes no `session.created`; nothing durable was written and no setter ran. For a later failure,
`rollbackCompleteSessionInitialization` restores the previous runtime selection and Pi settings,
discards the initial entries, re-inspects, and `completeInitializationFailure` aggregates cleanup
failures.

Logging: exactly one info record per substitution, emitted in `initializeCompleteSessionModelPolicy`
immediately after the resolve phase returns (fields and message in §3.1 step 2). No log on the
non-fallback path.

---

## 4. Client contract

### 4.1 `starterPolicyStartDecision` module (`src/client/src/components/starterPolicyStartDecision.ts`, new)

Imports: `evaluateStarterModelPolicyDraft`, `isCanonicalTier`,
`isSyntacticallyCompleteExactSelection`, `type SessionModelPolicyDraft` from
`./sessionModelPolicyDraft`; `type ModelTierSettingsResponse`,
`type StarterModelPolicyPreference` from `../../../shared/apiTypes`. The two syntax helpers must be
exported from `sessionModelPolicyDraft.ts` (`isSyntacticallyCompleteExactSelection` currently private
at line 338; `isCanonicalTier` currently private at line 344).

Exports:

```ts
export const STARTER_POLICY_FALLBACK_WARNING_CLAUSE =
  "The session may start with the Lightweight utility model.";

export function isStructurallyCompleteStarterPolicy(
  draft: SessionModelPolicyDraft,
): boolean;

export function starterModelPolicyPreference(
  draft: SessionModelPolicyDraft,
): StarterModelPolicyPreference;

export type StarterStartDecision =
  | { kind: "ready" }
  | { kind: "fallback"; requested: StarterModelPolicyPreference; warning?: string }
  | { kind: "blocked"; reason: string };

export function starterStartDecision(input: {
  draft: SessionModelPolicyDraft | undefined;
  catalog: ModelTierSettingsResponse | undefined;
  fallbackSupported: boolean;
  /**
   * The caller's existing catalog-loading / catalog-error text
   * (`"Loading model policy choices"` or `modelTierCatalogError`). Required so
   * the blocked reason stays byte-identical to today's when the catalog is
   * unavailable. See OQ-1.
   */
  catalogUnavailableReason: string;
}): StarterStartDecision | undefined;
```

`isStructurallyCompleteStarterPolicy` implements the completeness contract the server request parser
enforces for the fields a draft can carry (`sessionRoutes.ts:743-757`):
`isSyntacticallyCompleteExactSelection(draft.exact)` in **both** modes, plus
`draft.mode === "exact" || isCanonicalTier(draft.tier)`. Known, type-unreachable deviation: the
parser also rejects a present non-canonical `tier` in exact mode (`tierFromUnknown`,
`sessionRoutes.ts:800-806`), while this predicate ignores a stray tier in exact mode.
`SessionModelPolicyDraft.tier` is `ModelTier | undefined`, so no client-produced draft can carry a
non-canonical tier without a cast.

`starterModelPolicyPreference(draft)` returns the complete `{ mode, exact: clone, tier? }` shape and
throws `new Error("Cannot build a complete starter model policy from an incomplete draft")` when the
predicate is false. It must deep-clone `exact.model` (no aliasing into the draft). The legacy
`starterModelPolicyPreferenceFromDraft` (mode/tier only) is untouched and must not be used for the
plus request.

Decision logic, exact precedence (the row numbers are the decision table; higher rows win):

| Row | `draft` | `catalog` | `fallbackSupported` | Result |
| --- | --- | --- | --- | --- |
| 1 | `undefined` | any | any | `undefined` (inputs still loading) |
| 2 | structurally incomplete | `undefined` | any | `{ kind: "blocked", reason: catalogUnavailableReason }` |
| 3 | structurally incomplete | defined | any | `{ kind: "blocked", reason: evaluateStarterModelPolicyDraft(draft, catalog).reason }` |
| 4 | complete | `undefined` | `true` | `{ kind: "fallback", requested: starterModelPolicyPreference(draft) }` (no warning) |
| 5 | complete | `undefined` | `false` | `{ kind: "blocked", reason: catalogUnavailableReason }` |
| 6 | complete | defined, evaluation `ready` | any | `{ kind: "ready" }` |
| 7 | complete | defined, evaluation `blocked` | `true` | `{ kind: "fallback", requested, warning: `${evaluation.reason}. ${STARTER_POLICY_FALLBACK_WARNING_CLAUSE}` }` |
| 8 | complete | defined, evaluation `blocked` | `false` | `{ kind: "blocked", reason: evaluation.reason }` |

Reason precedence:

1. A structurally incomplete draft is always `blocked`, and it is checked **before** the capability
   or the catalog: rows 2–3. With a catalog present the evaluator returns the today-identical reason
   (Exact syntax first; Tiered row/config/syntax reason); with the catalog unavailable the reason is
   the caller's catalog-loading/catalog-error text, exactly today's reason. A structurally incomplete
   draft is never `fallback`.
2. When the draft is complete and the catalog is unavailable, only the capability decides:
   fallback (row 4) vs today's hard block (row 5).
3. When the catalog is present, `evaluateStarterModelPolicyDraft` decides ready (row 6) vs blocked
   (rows 7–8); the blocked reason is used verbatim as the **block** reason, and as the warning prefix
   with exactly one added period (row 7). `status.blockedReason` itself stays byte-identical to
   today's evaluator reason, with no added period.
4. For a fallback with no catalog (row 4) `warning` is omitted entirely
   (`exactOptionalPropertyTypes: true`), not set to `undefined` or `""`.
5. Non-selection (legacy) machines never call this function; the app keeps today's projection.

### 4.2 Starter input projection and start gating (`PiWebUiApp.ts`)

`starterModelPolicyInputs()` (line 2938) return type becomes:

```ts
private starterModelPolicyInputs():
  | {
      status: ClientSessionModelPolicyStatus;
      response: SessionModelPolicyResponse;
      decision?: StarterStartDecision;
      warning?: string;
    }
  | undefined;
```

Selection-capable branch (`this.starterModelPolicySelectionSupported()`), changes only:

1. Compute the existing `evaluation` exactly as today, using a new private helper for the
   unavailable text:
   ```ts
   private modelTierCatalogUnavailableReason(): string {
     return this.modelTierCatalogError === ""
       ? "Loading model policy choices"
       : this.modelTierCatalogError;
   }
   ```
   (replaces the inline expression at line 2948; the legacy branch at lines 2997–3001 keeps its own
   text). Evidence: `PiWebUiApp.ts:2946-2949`.
2. `const decision = starterStartDecision({ draft: policy, catalog, fallbackSupported: this.starterModelPolicyLightweightFallbackSupported(), catalogUnavailableReason: this.modelTierCatalogUnavailableReason() });`
   `decision` is always defined here because `policy` is defined.
3. Status `blockedReason` is emitted from the decision, not the evaluation:
   ```ts
   ...(decision.kind === "blocked" ? { blockedReason: decision.reason } : {}),
   ```
   `resolved`, `mode`, `tier`, and `ladderValid` are computed exactly as today
   (`resolved: evaluation.kind === "ready" ? evaluation.resolved : policy.exact`,
   `ladderValid: catalog?.valid ?? true`). With the decision and evaluation both derived from the
   same catalog, `decision.reason === evaluation.reason` for every blocked row, so the only
   observable change is that a `fallback` decision omits `blockedReason`.
4. Return `decision`, and `warning` present iff `decision.kind === "fallback" && decision.warning !== undefined`.
5. Legacy branch: return `{ status, response }` with no `decision`/`warning`.

Consequences required by the design, all achieved through the omitted `blockedReason`:

- `sendDisabled=${policy?.status.blockedReason !== undefined}` at the `prompt-editor` binding (line
  2899) becomes `false` in the fallback state.
- `shouldRetainStarterNotice` for a retained `policy-blocked` notice receives `undefined` and drops
  it on the next `willUpdate()` (`syncStarterNotice`, lines 2018–2021).
- The compact danger diagnostic disappears because the control receives a warning instead (§4.3).

Start gating:

```ts
private starterModelPolicyFallbackPreference(): StarterModelPolicyPreference | undefined {
  const decision = this.starterModelPolicyInputs()?.decision;
  return decision?.kind === "fallback" ? decision.requested : undefined;
}

private starterModelPolicyBlocksStart(): boolean {
  const inputs = this.starterModelPolicyInputs();
  if (inputs === undefined) return false;
  return inputs.decision !== undefined
    ? inputs.decision.kind === "blocked"
    : inputs.status.blockedReason !== undefined;
}
```

`startSessionAndOpenChat()` (line 2530):

1. Compute `let decision = this.starterModelPolicyInputs()?.decision;` and
   `let plusInitializer = this.starterPlusModelPolicyInitializer();`.
2. The "load missing inputs" wait must not run for a fallback start. Keep the existing wait only
   when `plusInitializer === undefined && decision?.kind !== "fallback"` (plus the existing
   `starterModelPolicy === undefined || catalog === undefined` condition). Recompute `decision` and
   `plusInitializer` after the wait as today.
3. Replace the `blockedReason` check with `if (this.starterModelPolicyBlocksStart())` → publish the
   existing `starterPolicyBlockedNotice` and return. The predicate consults the decision when the
   selection-capable branch produced one and otherwise falls back to `inputs.status.blockedReason`,
   so a legacy non-selection refusal still publishes the notice and returns. `fallback` and `ready`
   both continue.
4. When `usePlusStart` and `plusInitializer === undefined`, use
   `this.starterModelPolicyFallbackPreference()` as the plus initializer. If it is still undefined,
   return as today.
5. Everything else (pending-row capture, notice reset, start dispatch, catch → `start-failed`)
   is unchanged; the plus dispatch calls `this.sessions.startPlusSession(plusInitializer)` with the
   fallback preference.

`handleStartSessionPrompt` (line 4136):

1. `const decision = this.starterModelPolicyInputs()?.decision;`
2. `if (this.starterModelPolicyBlocksStart())` → publish the blocked notice and return. As in
   `startSessionAndOpenChat`, the predicate falls back to the legacy `status.blockedReason` when
   `decision` is `undefined`, so a legacy blocked prompt send is still refused.
3. `const plusInitializer = decision?.kind === "fallback" ? decision.requested : this.starterPlusModelPolicyInitializer();`
   with `usePlusStart = this.starterModelPolicySelectionSupported(startMachineId)`; return when
   `usePlusStart && plusInitializer === undefined` (today's behavior).
4. The rest (notice reset, `startPlusSessionWithPrompt` / `startSessionWithPrompt`, catch) is
   unchanged.

`starterPlusModelPolicyInitializer()` keeps its ready-only behavior (it returns `undefined` when the
evaluation is blocked); it is not used for fallback starts.

Starter defaults are still required: `starterModelPolicyInputs()` returns `undefined` without
defaults, and a defaults failure keeps the `defaults-failed` notice path. The tier catalog is still
loaded for the pre-start warning; only the *wait* is skipped when the decision is `fallback`.

### 4.3 Warning properties and rendering

`SessionModelPolicyControl` (`src/client/src/components/SessionModelPolicyControl.ts`):

- New property: `@property() warning = "";`
- Render: compute
  ```ts
  const warningText = this.warning.trim() === "" ? undefined : this.warning;
  const compactDiagnostic = warningText === undefined ? this.compactDiagnostic(policyStatus) : undefined;
  ```
  Always render the live region in the same position as the diagnostic:
  ```ts
  <span class="policy-warning" role="status">${warningText ?? ""}</span>
  ```
  so the region exists before its text changes (stable announcement target). `role="status"`
  supplies the polite live-region and atomic semantics.
- The compact danger diagnostic is suppressed whenever `warningText !== undefined`; `ladderValid`
  stays on the status, but the ladder message is not repeated because the warning carries the live
  reason.
- CSS (add beside `.policy-diagnostic`):
  ```css
  .policy-warning { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; color: var(--pi-muted); font-size: 11px; line-height: 1.3; }
  ```
  No `overflow: hidden`, no `text-overflow: ellipsis`, no `white-space: nowrap`: the line is
  untruncated by requirement.

`PromptEditor` (`src/client/src/components/PromptEditor.ts`):

- New property beside `modelPolicyError`: `@property() modelPolicyWarning = "";`
- Pass `.warning=${this.modelPolicyWarning}` to `<session-model-policy-control>` (line 431).
- `shouldUpdate` needs no allowlist change: a warning-only change yields a `changed` set that fails
  the `status`/`modelPolicyStatus` early-return and renders; during streaming the warning string is
  stable, so Lit does not put it in `changed` and the existing coalescing is preserved.

`PiWebUiApp` start-screen binding adds `.modelPolicyWarning=${policy?.warning ?? ""}` to the
`<prompt-editor>` at line 2899.

### 4.4 Confirmed event, writer, and adoption

`src/client/src/controllers/sessionController.ts`:

```ts
export type StarterModelPolicyConfirmedEvent =
  | {
      reason: "creation";
      machineId: string;
      session: SessionInfo;
      requestedPolicy: StarterModelPolicyPreference;
    }
  | {
      reason: "policy-save";
      machineId: string;
      session: SessionInfo;
      policy: StarterModelPolicyPreference;
    };

export interface StarterModelPolicySubstitutionEvent {
  machineId: string;
  session: SessionInfo;
  requestedPolicy: StarterModelPolicyPreference;
  confirmed: { mode: SessionModelPolicyMode; resolved: ExactModelSelection };
}

export interface SessionControllerDependencies {
  // ...existing members...
  onStarterModelPolicySubstitution?: (event: StarterModelPolicySubstitutionEvent) => void;
}
```

Producers:

- `startSessionRequest` plus path (`:342-352`, publish call at 346) publishes
  `{ reason: "creation", machineId, session: { ...session }, requestedPolicy: pending.request.initialModelPolicy }`.
  The existing guards (`!pending.discarded`, `request.kind === "plus"`,
  `session.creationSource === "session-list-plus"`) are unchanged.
- `saveModelPolicy` plus-root path (`:1253-1264`, publish call at 1259) publishes
  `{ reason: "policy-save", machineId, session: { ...sessionInfo }, policy: cloneStarterModelPolicyPreference(response.policy) }`.

`src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.ts`:

```ts
export type ConfirmedPreferenceWriteContext =
  | { reason: "creation"; requestedPolicy: StarterModelPolicyPreference }
  | { reason: "policy-save" };

export interface ConfirmedStarterModelPolicyPreferenceWriterDependencies {
  remember(
    scope: StarterModelPolicyPreferenceWriteScope,
    session: SessionInfo,
  ): Promise<StarterModelPolicyPreference>;
  onRemembered?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    preference: StarterModelPolicyPreference,
    context: ConfirmedPreferenceWriteContext,
  ) => void;
  onStateChange?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    snapshot: StarterModelPolicyPreferenceWriteSnapshot,
  ) => void;
}
```

- `write(scope: StarterModelPolicyPreferenceWriteScope, session: SessionInfo, context: ConfirmedPreferenceWriteContext): Promise<void>`.
- `PendingConfirmedPreferenceWrite` stores `{ session, context, completions }`. Every `write` call
  replaces the pending `session` **and** `context` (newest context wins) and appends its completion;
  an in-flight batch keeps the context captured when it started. A work item reports
  `onRemembered(cloneScope(scope), remembered, pending.context)` once per processed batch.
- The worker catches `remember` failures into `state.error` exactly as today; `onRemembered` is
  invoked only on success and is wrapped in its own try/catch so an observer throw cannot poison the
  scope worker (mirroring `publish`). `snapshot`, pruning, and scope independence are unchanged.

`PiWebUiApp` wiring (`:465-485`):

```ts
private readonly confirmedStarterModelPolicyPreferenceWriter =
  new ConfirmedStarterModelPolicyPreferenceWriter({
    remember: (scope, session) => sessionsApi.rememberCurrentModelPolicy(session, scope.machineId),
    onRemembered: (scope, preference, context) => {
      this.handleConfirmedStarterModelPolicyRemembered(scope, preference, context);
    },
    onStateChange: (scope, snapshot) => { /* unchanged body */ },
  });
```

Adoption algorithm in `handleConfirmedStarterModelPolicyRemembered(scope, preference, context)`:

```ts
if (context.reason === "policy-save") return;               // saves adopt immediately (below)
if (!this.starterModelPolicyPreferenceScopeMatchesCurrentSelection(scope)) return;
const draft = this.starterModelPolicy;
if (draft === undefined) return;
if (!sameStarterModelPolicyDraft(draft, modelPolicyDraftFromPolicy(context.requestedPolicy))) return;
this.starterModelPolicy = modelPolicyDraftFromPolicy(preference);
this.confirmedStarterModelPolicyUiScope = scope;
this.confirmedStarterModelPolicyUiGeneration = this.starterModelPolicySelectionGeneration;
this.requestUpdate();
```

- `modelPolicyDraftFromPolicy(context.requestedPolicy)` is the dispatch snapshot; no separate
  captured draft or generation is introduced.
- A user edit after dispatch changes `starterModelPolicy` away from the snapshot, so the guard
  fails and the edit is never clobbered.
- A scope change resets the draft (`resetStarterModelPolicyForScopeChange`), so the scope check plus
  `draft === undefined` keeps a stale confirmation out of the new scope.

`handleStarterModelPolicyConfirmed(event)` changes:

- Compute `scope` and the existing UI-scope bookkeeping (read-error clear,
  `confirmedStarterModelPolicyUiScope`, `confirmedStarterModelPolicyUiGeneration`, the sibling-scope
  reset) for both reasons, exactly as today.
- Adopt the draft immediately **only** for `reason === "policy-save"`:
  `this.starterModelPolicy = modelPolicyDraftFromPolicy(event.policy)`.
- For `reason === "creation"` do not touch `starterModelPolicy`.
- Call `this.confirmedStarterModelPolicyPreferenceWriter.write(scope, event.session, event.reason === "creation" ? { reason: "creation", requestedPolicy: event.requestedPolicy } : { reason: "policy-save" })`
  (passing `event`'s own values; no extra cloning beyond the writer's).

Warning text reword: replace `CONFIRMED_STARTER_MODEL_POLICY_WARNING` (line 139) with
`"Could not remember this model policy for future sessions."` so the writer-failure warning never
claims the session still uses the unremembered policy. The legacy non-selection warning at
`starterModelPolicyError()` (`` `Could not remember this model policy; this session will still use it. ${writerError}` ``)
is unchanged.

### 4.5 Substitution detection (`sessionController.ts`)

New private state:

```ts
interface StarterPolicySubstitutionCheck {
  machineId: string;
  session: SessionInfo;
  requestedPolicy: StarterModelPolicyPreference;
  /** Set once an applied status has decided the check; never re-armed. */
  observed: boolean;
}
private readonly starterModelPolicySubstitutionChecks = new Map<string, StarterPolicySubstitutionCheck>();
```

Capture (idempotent, keyed by created session id):

```ts
private captureStarterModelPolicySubstitution(
  session: SessionInfo,
  machineId: string,
  requestedPolicy: StarterModelPolicyPreference,
): void {
  if (this.starterModelPolicySubstitutionChecks.has(session.id)) return;
  const check: StarterPolicySubstitutionCheck = {
    machineId,
    session: { ...session },
    requestedPolicy: cloneStarterModelPolicyPreference(requestedPolicy),
    observed: false,
  };
  this.starterModelPolicySubstitutionChecks.set(session.id, check);
  const stored = this.getState().sessionStatuses[session.id];
  if (stored !== undefined) this.runStarterPolicySubstitutionCheck(session.id, stored);
}

private plusPendingStartPolicy(cwd: string, machineId: string): StarterModelPolicyPreference | undefined {
  for (const pending of this.pendingSessionStarts.values()) {
    if (
      pending.cwd === cwd
      && pending.machineId === machineId
      && !pending.discarded
      && pending.request.kind === "plus"
    ) {
      return pending.request.initialModelPolicy;
    }
  }
  return undefined;
}
```

Capture points:

- `applyCreatedSession(session)` (`:1877`): before/with the existing
  `hasPendingStartFor(session.cwd, machineId)` suppression branch, when that predicate is true,
  call `const requested = this.plusPendingStartPolicy(session.cwd, machineId); if (requested !== undefined) this.captureStarterModelPolicySubstitution(session, machineId, requested);`.
  A legacy pending start yields `undefined` and captures nothing.
- `resolvePendingSessionStart(tempId, session)` (`:1718`): for the non-discarded path
  (`pending.request.kind === "plus"`), call
  `this.captureStarterModelPolicySubstitution(session, pending.machineId, pending.request.initialModelPolicy)`.
  Place it after the `if (pending.discarded) { ... }` block (so discarded starts never capture) and
  before/around `rememberCachedNewSession`; the map guard makes a second capture from the broadcast
  path a no-op.

Comparison and emission:

```ts
private runStarterPolicySubstitutionCheck(sessionId: string, status: SessionStatus): void {
  const check = this.starterModelPolicySubstitutionChecks.get(sessionId);
  if (check === undefined || check.observed) return;
  const modelPolicy = status.modelPolicy;
  if (modelPolicy === undefined) return;
  check.observed = true;
  const requested = check.requestedPolicy;
  const substituted = requested.mode === "exact"
    ? modelPolicy.mode !== "exact" || !sameExactSelection(modelPolicy.resolved, requested.exact)
    : modelPolicy.mode === "exact";
  if (!substituted) return;
  const event: StarterModelPolicySubstitutionEvent = {
    machineId: check.machineId,
    session: { ...check.session },
    requestedPolicy: cloneStarterModelPolicyPreference(requested),
    confirmed: { mode: modelPolicy.mode, resolved: { model: { ...modelPolicy.resolved.model }, thinkingLevel: modelPolicy.resolved.thinkingLevel } },
  };
  try {
    this.onStarterModelPolicySubstitution?.(event);
  } catch {
    // Substitution reporting is observational and must not block session work.
  }
}
```

- Hook: call `this.runStarterPolicySubstitutionCheck(status.sessionId, status)` at the end of
  `applyStatus(status)` (`:1908`) for every applied status, selected or not. A status with no
  `modelPolicy` leaves the check pending.
- Consumption: the entry is marked `observed` on the first applied status that carries
  `modelPolicy`, whether or not it is a substitution, and the entry is retained (not deleted) so a
  later capture from the other capture point cannot re-arm the check. Later statuses never re-emit.
  Observed entries are cleared on `dispose()`; they are one small object per plus-created session.
- `sameExactSelection` is imported from `../components/sessionModelPolicyDraft` (pure data module,
  single source of truth for provider/id/level equality).
- `dispose()` clears `starterModelPolicySubstitutionChecks`.

Event ordering this algorithm covers (all must be tested, §7.4):

| Ordering | Capture source | Result |
| --- | --- | --- |
| `session.created` broadcast, then HTTP response | `applyCreatedSession` correlation | capture once; response path no-ops |
| HTTP response, then `session.created` | `resolvePendingSessionStart` | capture once; later `applyCreatedSession` early-returns (id already in `state.sessions`) |
| Status applied before capture | immediate reconciliation against `state.sessionStatuses` | compare at capture |
| Status buffered (rAF pending) before capture | none yet | compare on the next `applyStatus` |
| Discarded pending start | never captured | no callback, no notice, no preference write |
| Legacy pending start | `plusPendingStartPolicy` returns undefined | no capture |
| Requested policy resolves | compare runs and is consumed | no callback; later statuses ignored |

### 4.6 `policy-fallback` notice

`src/client/src/components/starterNotice.ts`:

```ts
export type StarterNoticeKind = "policy-blocked" | "start-failed" | "defaults-failed" | "policy-fallback";

export function starterPolicyFallbackNotice(
  message: string,
  scope: StarterNoticeScope,
): StarterNotice {
  return { kind: "policy-fallback", message, scope };
}
```

`starterNoticeVisibleText` needs no change: `policy-fallback` is captured text, so it returns
`notice.message` and ignores the live `blockedReason`. `shouldRetainStarterNotice` needs no change:
it is retained while in scope (only `policy-blocked` is live-gated).

`PiWebUiApp`:

```ts
private handleStarterModelPolicySubstitution(event: StarterModelPolicySubstitutionEvent): void {
  const workspace = this.state.workspaces.find((candidate) => candidate.path === event.session.cwd);
  if (workspace === undefined) return;
  this.publishStarterNotice(starterPolicyFallbackNotice(
    `Session started with the Lightweight utility model (${event.confirmed.resolved.model.provider}/${event.confirmed.resolved.model.id}) because the remembered model was unavailable.`,
    { machineId: event.machineId, workspaceId: workspace.id },
  ));
}
```

Wire it in the `SessionController` deps (`:266-277`):
`onStarterModelPolicySubstitution: (event) => { this.handleStarterModelPolicySubstitution(event); },`.

Lifecycle, reusing the existing single notice slot:

- Visible text is the captured message; the notice renders through `renderStarterNotice()`
  (`role="alert"` sibling of the error banner), so it is visible on the start screen and while a
  session is selected.
- Retained in scope until the next start attempt (`startSessionAndOpenChat`/`handleStartSessionPrompt`
  set `starterNotice = undefined`), any starter edit (`setStarterModelPolicyDraft`), or a
  machine/workspace scope change (`resetStarterModelPolicyForScopeChange` / `syncStarterNotice`),
  matching the existing captured-notice semantics.
- One-time: the controller marks the substitution check observed on the first status that decides
  it and retains the entry, so neither capture point can re-arm it and no second notice is emitted
  for the same creation.
- A missing workspace for `event.session.cwd` drops the notice; `publishStarterNotice` drops
  out-of-scope notices (existing behavior).

---

## 5. Capability

`src/shared/apiTypes.ts` (`PI_WEBUI_CAPABILITIES`, new last key):

```ts
sessionsModelPolicyLightweightFallback: "sessions.modelPolicyLightweightFallback",
```

`src/shared/capabilities.ts`:

- Add `PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback` to `WEB_RUNTIME_CAPABILITIES`
  (after `sessionsModelPolicyStarterSelection`) and to `SESSIOND_RUNTIME_CAPABILITIES` (after
  `sessionsModelPolicyStarterSelection`).
- Add `[PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback]: ["web", "sessiond"]` to
  `EFFECTIVE_CAPABILITY_REQUIREMENTS` so `effectivePiWebUiCapabilities` requires both components.

Client helper in `PiWebUiApp.ts`, mirroring `starterModelPolicySelectionSupportedForState`
(line 4951):

```ts
function lightweightModelPolicyFallbackSupportedForState(
  state: Pick<AppState, "machineRuntimes">,
  machineId: string,
): boolean {
  const runtime = state.machineRuntimes[machineId];
  return runtime?.ok === true
    && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback);
}
```

plus the private wrapper
`private starterModelPolicyLightweightFallbackSupported(machineId = selectedMachineId(this.state)): boolean`.

The daemon substitutes unconditionally; capability gating is client-side only. An older client
bundle against a new daemon substitutes by design and shows the lightweight model without the new
notice (accepted residual, §11). A new client against an older daemon keeps today's hard block (row 5/8
of §4.1 with `fallbackSupported === false`).

---

## 6. Data and state transitions

| # | Phase | Condition | Daemon state | Client state | Output |
| --- | --- | --- | --- | --- | --- |
| 1 | Starter load | remembered preference + defaults | — | draft seeded; catalog loads in background | start screen |
| 2 | Decision | catalog ready + complete + evaluation blocked + capability | — | `decision = fallback`; status has no `blockedReason` | contingent warning shown, Start enabled |
| 3 | Decision | catalog unavailable + complete + capability | — | `decision = fallback`; no warning | Start enabled, server-authoritative |
| 4 | Decision | incomplete or capability absent | — | `decision = blocked` | today's refusal |
| 5 | Plus dispatch | — | — | pending start stores requested policy; pending row selected | `POST` with complete `initialModelPolicy` |
| 6 | Resolve | requested active target resolves | plan = requested; bound `resolved`; no fallback | — | today's path |
| 7 | Resolve | recognized failure + lightweight candidate | plan = substituted exact (tier preserved); `fallback` logged | — | apply/persist substituted policy |
| 8 | Resolve | recognized failure + no candidate | `initialPolicyUnavailableError` thrown | — | request fails; runtime aborted/disposed; no `session.created`; no durable transcript |
| 9 | Resolve | candidate fails re-validation with `SessionModelPolicyResolutionError` | `initialPolicyUnavailableError(requested, originalCause, undefined)` thrown, final | — | as row 8 |
| 10 | Creation success | mutation committed | persisted policy = plan.policy; creation source appended | — | `session.created` + status published |
| 11 | Capture | created session correlates to a non-discarded plus pending start | — | check recorded under session id (idempotent) | — |
| 12 | Compare | first applied `status.modelPolicy` after capture | — | entry consumed | `onStarterModelPolicySubstitution` iff substituted |
| 13 | Notice | substitution event, session workspace visible/current | — | `policy-fallback` notice with `provider/id` | notice visible in start screen and chat |
| 14 | Remember | plus creation confirmed | `POST /model-policy/remember` re-reads persisted policy and replaces the workspace preference | writer `remember` resolves confirmed policy | workspace preference = substituted policy |
| 15 | Adoption | `onRemembered` + scope match + draft equals dispatch snapshot | — | `starterModelPolicy = confirmed preference` | next `+` resolves the lightweight policy directly |
| 16 | Adoption | user edited the draft after dispatch | — | guard fails; draft kept | edit wins; preference still replaced by the daemon |
| 17 | Write failure | `remember` rejects | preference unchanged | writer warning (reworded); notice already emitted from status | next `+` falls back again |
| 18 | Discarded | user discards the pending row | — | no capture, no notice, no preference write | today's discarded-start behavior |
| 19 | Non-fallback | requested policy resolves | persisted policy = requested | contingent warning may have shown; no notice; no draft change | unchanged preference |
| 20 | Older daemon | capability absent | daemon does not fall back | `decision.blocked` | today's hard block |

Any other error during the fallback re-validation — the internal `refresh` or an escaped `inspect`
throw — is infrastructure: it propagates untouched and the start aborts/disposes exactly as row 8,
without the lightweight clause (§3.5).

---

## 7. Test specification

Follow `.agents/skills/testing-guide/SKILL.md`: smallest proving layer, typed fakes, deterministic
promises/timers, no assertion of incidental internals. Run commands from the repository root.

### 7.1 Pure helper tests

**`src/server/sessions/sessionModelPolicyFallback.test.ts` (new)**

Fixture values:

```ts
const REQUESTED_TIERED: SessionModelPolicy = {
  mode: "tiered",
  exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
  tier: "advanced",
};
const REQUESTED_EXACT: SessionModelPolicy = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
};
const CANDIDATE = { provider: "acme", id: "small", thinkingLevel: "minimal" };
```

Cases:

1. `fallbackSessionModelPolicy` returns
   `{ policy: { mode: "exact", exact: { acme/small @ minimal }, tier: "advanced" }, target: { acme/small @ minimal } }`
   for `REQUESTED_TIERED`; the target and the policy's `exact` are not the same object.
2. Omits `tier` for `REQUESTED_EXACT` (assert `"tier" in plan.policy === false`).
3. Mutating the returned policy/target does not change `REQUESTED_TIERED`.
4. `initialPolicyUnavailableError`: for each of the five reasons plus `undefined`, assert the message
   contains the original cause message, the §3.3 clause, `utilityModels.lightweight`, and
   `Settings → Utility models`; for `config-invalid`/`model-unavailable`/
   `thinking-level-unsupported`/`resolution-failed` with a `detail`, assert `(detail)` is present.
5. `Error.cause` retention: `error.cause === cause` for an `Error` cause, and the message uses
   `String(cause)` for a non-Error cause.
6. Requested-policy description: `initialPolicyUnavailableError` for a Tiered request with a tier
   contains `(tier advanced)`; for an Exact request it contains
   `(openai/gpt-default at thinking level medium)`.

**`src/client/src/components/starterPolicyStartDecision.test.ts` (new)**

Reuse the `sessionModelPolicyDraft.test.ts` catalog shape: `defaultModelOption`
(`openai/gpt-default`, levels `["low","medium","high"]`), `repairModelOption`
(`openai/gpt-repair`, levels `["off","low"]`), `validCatalog()` with the standard ladder.

Drafts:

```ts
const COMPLETE_EXACT = { mode: "exact", exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" } } as const;
const UNAVAILABLE_EXACT = { mode: "exact", exact: { model: { provider: "openai", id: "retired" }, thinkingLevel: "medium" } } as const;
const UNSUPPORTED_LEVEL = { mode: "exact", exact: { model: { provider: "openai", id: "gpt-repair" }, thinkingLevel: "high" } } as const;
const COMPLETE_TIERED = { mode: "tiered", exact: COMPLETE_EXACT.exact, tier: "standard" } as const;
const INCOMPLETE_EXACT = { mode: "exact", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } } as const;
const INCOMPLETE_TIERED = { mode: "tiered", exact: COMPLETE_EXACT.exact } as const;
```

Cases:

1. Predicate: true for `COMPLETE_EXACT` and `COMPLETE_TIERED`; false for blank provider, blank id,
   blank level, `INCOMPLETE_TIERED`, and `{ ...COMPLETE_TIERED, tier: "nonsense" }`.
2. Builder: returns the complete `{ mode, exact, tier? }` clone (mutating the clone does not change
   the draft); throws for `INCOMPLETE_EXACT`.
3. Decision rows 1–8 exactly as the §4.1 table:
   - row 1: `draft: undefined` → `undefined`;
   - row 2: `INCOMPLETE_EXACT`, `catalog: undefined`, `catalogUnavailableReason: "Loading model policy choices"` → blocked with that text;
   - row 3: `INCOMPLETE_EXACT` + `validCatalog()` → blocked with
     `"Choose a provider, model, and thinking level before starting"`; `INCOMPLETE_TIERED` +
     `validCatalog()` → blocked with `"Selected model tier is unavailable"` (the evaluator's tier
     reason, because the draft has no canonical tier);
   - row 4: `COMPLETE_EXACT`, no catalog, supported → fallback, no `warning` key
     (`expect(Object.hasOwn(decision, "warning")).toBe(false)`), `requested` equals
     `starterModelPolicyPreference(COMPLETE_EXACT)`;
   - row 5: `COMPLETE_EXACT`, no catalog, unsupported → blocked with the passed reason;
   - row 6: `COMPLETE_EXACT` + `validCatalog()` → `{ kind: "ready" }`; `COMPLETE_TIERED` → ready;
   - row 7: `UNAVAILABLE_EXACT` + catalog + supported → fallback with
     `warning === "Selected provider/model is unavailable. The session may start with the Lightweight utility model."`;
     `UNSUPPORTED_LEVEL` → warning starts with
     `"Selected thinking level is unsupported by the selected model"`;
   - row 8: the same blocked drafts with `fallbackSupported: false` → blocked with the evaluator
     reason verbatim.
4. `UNSUPPORTED_LEVEL` + no catalog + supported is **fallback**, not blocked (catalog absence is not
   a client-side level check).
5. Incomplete drafts are never fallback even when `fallbackSupported` is true.

### 7.2 Resolver tests

**`src/server/sessions/utilityModelResolver.test.ts` (extend)**

Add an `inspect` describe block using the existing `createHarness`, plus:

- `expect((await resolver.inspect("lightweight")).candidates).toEqual(await resolver.configuredCandidates("lightweight"))`
  for a configured candidate (parity).
- `slot-unset`: `{}` and `{ utilityModels: {} }` → `{ reason: "slot-unset" }`, no `detail`.
- `config-invalid`: `{ utilityModelsError: "utilityModels.lightweight.id is required" }` →
  `{ reason: "config-invalid", detail: "utilityModels.lightweight.id is required" }`, no candidates.
- `model-unavailable`: `{ utilityModels: { lightweight: { provider: "acme", id: "retired" } } }` →
  `{ reason: "model-unavailable", detail: "acme/retired" }`.
- `thinking-level-unsupported` explicit: lightweight `{ provider: "acme", id: "small", thinkingLevel: "max" }`
  with `thinkingLevelsForModel: () => ["off", "minimal"]` →
  `{ reason: "thinking-level-unsupported", detail: "max" }`. There is no automatic variant: the
  resolver's automatic branch returns `"minimal"` or `"off"` and never produces this reason (§3.4).
- `resolution-failed`: `loadConfigError` and `refreshError` harness options →
  `{ reason: "resolution-failed", detail: <message> }`; build one resolver directly with a `logger`
  spy (as in the existing "refreshes without network" test) and assert it is called with
  `{ err, task }` and `"utility model resolution failed"`.
- `unavailable` is omitted when a candidate exists.

Extend every existing `UtilityModelResolver` object literal to the two-method interface (add an
`inspect` whose result contains the same `configuredCandidates` array; a tiny
`resolverFor(candidates)` helper per file is enough):

- `src/server/sessions/utilityModelExtension.test.ts:468` `resolverFor` (the single helper behind
  all of that file's resolver fakes).
- `src/server/sessions/piSessionService.promptQueue.test.ts:113,146,178,213,241,264,304,336` — all
  eight literals, including the four an earlier list missed.
- `src/server/sessions/piSessionService.rateLimits.test.ts:68,147` — the inline literals passed to
  `createDefaultRuntimeFactory`.
- `src/server/speechInput/speechInputPolishingService.test.ts:237,276` — the two
  `UtilityModelResolver<Model<Api>>` literals — and
  `speechInputPolishingService.rateLimits.test.ts:39` — the `candidateResolver()` helper used at
  lines 50 and 68.
- `src/server/sessions/utilityModelResolver.test.ts:210-212,263-265` — the two
  `UtilityModelResolver<FakeModel>` literals used with `runWithUtilityModelFallback`.

`inspect` is a required member, so every listed literal fails `npm run typecheck` until it is added.

**`src/server/sessions/modelTierRegistry.test.ts` (extend)**

For each `resolveTier` failure and each `createModelTierRegistry().resolve` config/defensive failure,
assert the thrown value `instanceof TierResolutionError` and the message in the §3.2.1 table.
`validateLadder` keeps returning `{ valid: false, reason }` for the same inputs (existing coverage
plus one explicit assertion that it does not throw).

### 7.3 Server service tests (`src/server/sessions/piSessionService.modelPolicy.test.ts`)

#### 7.3.1 Harness changes (`createModelPolicyHarness`)

1. New option:
   ```ts
   utilityModelResolver?: NonNullable<PiSessionServiceDependencies["utilityModelResolver"]>;
   ```
   Passed into the `PiSessionService` deps; default is an empty-candidate fake
   (`inspect` → `{ candidates: [] }`, `unavailable: { reason: "slot-unset" }`).
2. New option `plainTierError?: boolean`: when true the harness's stub `resolve` throws a plain
   `Error` with the same message instead of `TierResolutionError`.
3. The stub tier-registry `resolve` (line 363) throws `TierResolutionError` by default:
   ```ts
   if (model === undefined) throw new TierResolutionError(`tier ${tier} names unavailable model`);
   ```
   This is what exercises the typed catch; import `TierResolutionError` from `./modelTierRegistry.js`.
4. New option `failModelRuntimeRefresh?: () => Error | undefined`: make the delegating `modelRuntime`
   proxy reject `refresh` with the returned error before delegating; returning `undefined` delegates
   unchanged (a separate wrapper from the existing `onModelRuntimeRefresh` hook). The option is
   consulted once per intercepted `refresh`, so a test can fail only a specific refresh by consulting
   its own state.
5. New option `logger?: PiSessionLogger` (default a `vi.fn()` `{ info }`) passed to the service deps
   and returned as `logger`.
6. The harness returns the resolver fake (or exposes an `inspect` spy) and the logger.

Test-local helper (in the test file):

```ts
type ResolverFake = NonNullable<PiSessionServiceDependencies["utilityModelResolver"]> & {
  inspect: ReturnType<typeof vi.fn>;
  configuredCandidates: ReturnType<typeof vi.fn>;
};

function fallbackResolver(input: {
  candidates?: readonly { model: NonNullable<PiAgentSession["model"]>; thinkingLevel: ThinkingLevel }[];
  unavailable?: UtilityModelUnavailable;
}): ResolverFake { /* builds ResolvedUtilityModel entries with slot: "lightweight" */ }
```

New fixture constants (reuse `runtimeModel`, `DEFAULT_SCOPED_MODELS` with `gpt-basic`
non-reasoning → only `"off"` is supported):

```ts
const LIGHTWEIGHT_SELECTION: ExactModelSelection = {
  model: { provider: "openai", id: "gpt-basic" },
  thinkingLevel: "off",
};
const LIGHTWEIGHT_CANDIDATE = { model: runtimeModel("openai", "gpt-basic", false), thinkingLevel: "off" as const };
```

#### 7.3.2 Recast existing tests

- "cleans up an unseen plus root when its active Exact selection is unavailable" (line 823) becomes
  "starts a plus root on the lightweight utility model when the active Exact selection is
  unavailable": harness `{ existing: false, utilityModelResolver: fallbackResolver({ candidates: [LIGHTWEIGHT_CANDIDATE] }) }`,
  request `{ mode: "exact", exact: { retired/unavailable @ medium }, tier: "standard" }`; expects
  completion (no rejection), persisted policy
  `{ version: 1, mode: "exact", exact: LIGHTWEIGHT_SELECTION, tier: "standard" }`, calls
  `setModel:openai/gpt-basic`, `setThinkingLevel:off`, policy+source appends, `session.created`,
  `activeCount() === 1`, abort/dispose `0`, and one substitution log record
  `{ sessionId: TEST_SESSION_ID, cwd: TEST_CWD, requestedPolicy, fallbackPolicy, reason: "Model not found: retired/unavailable" }`.
- "cleans up an unseen plus root when its active Tiered selection cannot resolve" (line 847) becomes
  the Tiered fallback variant: `tierTarget` = retired model; request
  `{ mode: "tiered", exact: DEFAULT_SELECTION, tier: "advanced" }`; expects the same lightweight
  persisted policy with `tier: "advanced"`, `harness.resolve` called once, and the log reason
  `tier advanced names unavailable model`.
- Their original rejection assertions move to two new tests that pass
  `fallbackResolver({ candidates: [], unavailable: { reason: "model-unavailable", detail: "retired/unavailable" } })`
  and assert the rejection message contains the original recognized cause, the lightweight clause
  `its configured model is unavailable (retired/unavailable)`, `utilityModels.lightweight`, and
  `Settings → Utility models`, plus `harness.calls === []`, `activeCount() === 0`, abort/dispose 1,
  no `session.created`. Each moved test keeps its own cause assertion:
  - the moved Exact test asserts `Model not found: retired/unavailable`;
  - the moved Tiered test keeps the recast `tierTarget`
    (`retired/unavailable-tier-target`) and asserts the harness stub's message
    `tier advanced names unavailable model` (no model interpolation), matching the
    original assertion at test line 857.

#### 7.3.3 New cases

1. "falls back when the precise Exact thinking level is unsupported": request
   `{ mode: "exact", exact: { openai/gpt-basic @ minimal } }` + candidate → persisted
   `LIGHTWEIGHT_SELECTION`; a no-candidate variant passes an explicitly empty candidate set and
   asserts the rejection carries the `unavailable` clause chosen by the fake (the requested policy's
   level never appears in the clause; the clause always describes the lightweight slot).
2. "preserves the remembered canonical tier through a Tiered fallback" (covered by the recast
   Tiered test) and "omits the tier when the requested policy had none": exact request without tier
   → persisted policy has no `tier` key.
3. "does not fall back when the requested policy resolves": plus start with `DEFAULT_SELECTION`,
   candidate injected → `harness.inspect` not called; persisted policy equals the request; no
   substitution log.
4. "does not fall back on a plain tier error with a recognized message": `plainTierError: true` →
   rejects with the original message, `inspect` not called, abort/dispose 1.
5. "does not fall back when the model runtime refresh fails": `failModelRuntimeRefresh: () => refreshError`
   → `rejects.toBe(refreshError)`, `inspect` not called, abort/dispose 1.
6. "propagates a fallback re-validation refresh failure untouched": requested Exact selection
   `retired/unavailable @ medium` (a recognized failure) + `LIGHTWEIGHT_CANDIDATE`, with
   `failModelRuntimeRefresh: () => (inspected ? refreshError : undefined)` where the resolver fake's
   `inspect` sets `inspected = true` (so only the fallback re-validation's refresh fails) →
   `rejects.toBe(refreshError)`: the rejection is **not** `initialPolicyUnavailableError`, its
   message contains neither `utilityModels.lightweight` nor the §3.3 clause, and it carries no
   original-cause attachment; `inspect` called once; abort/dispose 1; no `session.created`.
7. "does not attempt a second candidate when the first fails re-validation": candidate model absent
   from `scopedModels` (e.g. `runtimeModel("openai", "gpt-retired")`) → rejects with the clause
   `the lightweight model is not available to this session` and the original cause; `inspect` called
   once; abort/dispose 1; no `session.created`.
8. `it.each` over the five reasons plus `undefined` with an explicitly empty candidate set: the
   rejection message contains the cause message and the matching clause from §3.3, plus
   `utilityModels.lightweight` and `Settings → Utility models`; abort/dispose 1; `commitInitialEntries`
   not called; no `session.created` global event.
9. "remembers the substituted policy": after a fallback start, call
   `harness.service.rememberCurrentModelPolicy(sessionRef(TEST_SESSION_ID, TEST_CWD))` with the
   harness's `starterModelPolicyPreferenceStore` fake and assert
   `replace(TEST_CWD, { kind: "full", preference: { mode: "exact", exact: LIGHTWEIGHT_SELECTION, ...(tier) } })`
   and the returned value.
10. "does not consult the fallback for a runtime-default or non-plus start": `await harness.service.start(TEST_CWD)`
    and a legacy `{ modelPolicy: { mode: "tiered", tier: "advanced" } }` start with a candidate
    injected → `inspect` not called, today's persisted policy.
11. Non-plus creation paths untouched: a spawn/subsession start with a candidate injected does not
    call `inspect` (reuse the existing spawn harness setup).

### 7.4 Client tests

**`src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts` (extend)**

Fixtures: add
`function lightweightFallbackStarterState(): AppState` = `fullPreferenceCapableStarterState()` plus
`PI_WEBUI_CAPABILITIES.sessionsModelPolicyLightweightFallback` on the local runtime. Do **not** add
the capability to the existing fixtures, so all existing plus-path tests keep their
`fallbackSupported === false` behavior.

Recast (behavior change, not just rename):

- All seven direct `confirmStarterPolicy(...)` calls (lines 1528, 1633, 1645, 1727, 1728, 1764,
  1768) become the creation arm, each keeping its own policy as `requestedPolicy`:
  `confirmStarterPolicy(app, { reason: "creation", machineId: "local", session, requestedPolicy })`.
  Six pass `completeDefaultPolicy` (lines 1528, 1633, 1645, 1727, 1764, 1768); the `otherSession`
  call at line 1728 keeps its own tiered policy
  (`{ mode: "tiered", tier: "advanced", exact: advancedModelOption.model @ "high" }`). Seed the
  starter draft with that same policy (`setStarterModelPolicy(app, requestedPolicy)`) before each
  call whose assertion depends on adoption, then `await vi.waitFor(...)` for the writer to settle;
  the "retains the policy in memory" assertion
  moves after the mocked `rememberCurrentModelPolicy` resolves. The controller-driven save test
  ("remembers a server-confirmed policy mutation only for a plus-created root", line 1552) exercises
  the `policy-save` arm through the real emitter and keeps its immediate-adoption assertion.
- Replace the `CONFIRMED_STARTER_MODEL_POLICY_WARNING` assertions at lines 1637 and 1649 with
  `"Could not remember this model policy for future sessions."`; keep the legacy-path assertions at
  lines 1901 and 1933 (`"Could not remember this model policy; this session will still use it."`)
  unchanged.

New cases (use `lightweightFallbackStarterState()`, `validCatalog()`, `starterDefaultsV2()`):

1. "shows the contingent warning and keeps Start enabled when the remembered model is
   unavailable": set state, `starterModelPolicy = UNAVAILABLE_EXACT` (model absent from the
   catalog), render the start screen; assert the `<prompt-editor>` template's
   `.modelPolicyWarning=` equals
   `"Selected provider/model is unavailable. The session may start with the Lightweight utility model."`,
   `.sendDisabled=` is `false`, and `starterModelPolicyBlocksStart()` is `false`.
2. "renders no warning and starts server-authoritatively when the catalog is unavailable": state has
   the capability but no catalog and no `modelTiersApi.settings` response; assert
   `.modelPolicyWarning=` is `""`, `starterModelPolicyBlocksStart()` is `false`, and
   `startSessionAndOpenChat` calls `startPlusSession` with `starterModelPolicyPreference(draft)`
   (assert on the mock argument) instead of waiting for the catalog.
3. "starts the fallback preference from the prompt path":
   `startSessionPrompt(app, "hello")` with the same state → `startPlusSessionWithPrompt` called with
   the complete requested preference.
4. "still blocks an incomplete draft with the fallback capability present": draft
   `INCOMPLETE_EXACT`, catalog ready → `starterModelPolicyBlocksStart()` true; both start paths
   publish `policy-blocked` and dispatch nothing.
5. "still blocks when the fallback capability is absent": `fullPreferenceCapableStarterState()` +
   `UNAVAILABLE_EXACT` + `validCatalog()` → `starterModelPolicyBlocksStart()` true and the projected
   status still carries `blockedReason`.
6. "drops a retained `policy-blocked` notice in the fallback state": publish
   `starterPolicyBlockedNotice(scope)`, then render with the fallback decision and run
   `runWillUpdate(app)`; assert `starterNotice(app)` is `undefined`.
7. "publishes a `policy-fallback` notice naming the used model": seed a workspace; call
   `substitutionEvent(app, { machineId: "local", session: plusCreatedSession(), requestedPolicy, confirmed: { mode: "exact", resolved: LIGHTWEIGHT_SELECTION } })`;
   assert `templateText(renderApp(app))` contains
   `"Session started with the Lightweight utility model (openai/gpt-basic) because the remembered model was unavailable."`;
   assert it survives a session selection in the same workspace and is dropped by
   `setStarterModelPolicyDraft`.
8. "adopts the confirmed preference only when the draft is unchanged": seed the draft with the
   requested policy, mock the writer `remember` to resolve a *different* confirmed preference (the
   lightweight exact policy with the same remembered tier), invoke the creation confirmation with
   `requestedPolicy` equal to the seeded draft, and assert the draft becomes that confirmed
   preference after `vi.waitFor`; then repeat with a draft edited after dispatch and assert the edit
   survives. The differing resolved value is what proves adoption rather than a no-op.
9. "save-path adoption is unchanged": the existing save test updated to `reason: "policy-save"`
   asserts immediate draft adoption from `event.policy`.
10. "still refuses a legacy blocked start without the starter-selection capability":
    `preferenceCapableStarterState()` (no `sessions.modelPolicyStarterSelection`) with
    `UNAVAILABLE_EXACT` + `validCatalog()` → the legacy projection carries `blockedReason`,
    `starterModelPolicyBlocksStart()` is `true`, and both `startSessionAndOpenChat` and
    `startSessionPrompt` publish `policy-blocked` and dispatch nothing.

Add a small harness helper `substitutionEvent(app, event)` (mirroring `confirmStarterPolicy`, i.e.
invoking the private `handleStarterModelPolicySubstitution`), define
`const LIGHTWEIGHT_SELECTION: ExactModelSelection = { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "off" };`
for case 7, and keep `plusCreatedSession()` unchanged.

**`src/client/src/components/SessionModelPolicyControl.test.ts` (extend)**

1. "renders an untruncated role=status warning instead of the compact diagnostic": mount with
   `status = { ...exactStatus(), blockedReason: "Selected provider/model is unavailable" }` and
   `warning = "Selected provider/model is unavailable. The session may start with the Lightweight utility model."`;
   assert `.policy-warning` exists, `getAttribute("role") === "status"`, its `textContent` is the
   full warning, and `.policy-diagnostic` is `null`.
2. "suppresses the ladder diagnostic under a warning": `status = { ...tieredStatus(), ladderValid: false }`
   + warning → `.policy-diagnostic` `null`, warning text intact.
3. "keeps the compact diagnostic when there is no warning": `warning = ""` with a blocked status →
   `.policy-diagnostic` present as today; `.policy-warning` `textContent` `""`.
4. "style rule is untruncated": using the existing `componentStyleRule` helper assert
   `.policy-warning` has `white-space: normal` and `text-overflow: initial`/no ellipsis (assert
   `rule.textOverflow === ""` or `"initial"`), and no `overflow: hidden`.

**`src/client/src/components/PromptEditor.sessionConfiguration.test.ts` (extend)**

1. "forwards the warning to the policy control": set `editor.modelPolicyWarning = "..."` and a
   `modelPolicyStatus`, render, and assert the rendered `<session-model-policy-control>`'s `warning`
   property (via the existing `RenderedPolicyControl` accessor) is the string; blank when unset.
2. Existing `shouldUpdate` coverage: setting only `modelPolicyWarning` re-renders (no early-return);
   setting `status`/`modelPolicyStatus` re-binds.

**`src/client/src/controllers/sessionController.starterPolicySubstitution.test.ts` (new)**

Harness: copy the `pendingStartHarness` pattern from `sessionController.pendingStarts.test.ts`,
adding `onStarterModelPolicySubstitution` and `onStarterModelPolicyConfirmed` callbacks plus
`applySessionStatus` access. Fixtures: `workspace` from `sessionController.testSupport`, session
`{ id: "started-session", cwd: "/repo", creationSource: "session-list-plus" }`, requested exact
`{ mode: "exact", exact: { openai/gpt-default @ medium } }`, requested tiered
`fullStarterModelPolicyPreference` (tiered advanced), substituted status
`{ mode: "exact", resolved: { openai/gpt-basic @ off }, ladderValid: true }`.

Cases (the §4.5 ordering table is the checklist):

1. Exact requested + different Exact status → one event with cloned `session`,
   `requestedPolicy`, and `confirmed`.
2. Exact requested + same Exact status → no event; a later different status still emits nothing
   (consumed).
3. Tiered requested + Exact status → one event.
4. Tiered requested + Tiered status (same or different resolved tuple) → no event.
5. Status applied before the HTTP response resolves (call `applySessionStatus` first, then resolve)
   → one event at capture.
6. Status buffered (rAF) before capture → no event until `runPendingAnimationFrames()` applies it.
7. First status without `modelPolicy` → check stays pending; next status with `modelPolicy` decides.
8. Discarded pending start → no event.
9. Legacy `startSession()` resolving a plus-provenance session → no event.
10. `session.created` broadcast before the HTTP response → exactly one event, and a second broadcast
    does not duplicate it.
11. Non-plus workspace/cwd correlation mismatch → no capture.
12. Exact requested with the same model but a different level (`openai/gpt-default@medium`
    requested vs status `openai/gpt-default@off`) → one event whose `confirmed.resolved` is the
    status tuple.
13. Both capture points in one creation: `session.created` broadcast → substituted status applied
    (immediate reconciliation emits one event) → then resolve the start response (second capture
    attempt) and apply a second substituted status → still exactly one event and one
    `policy-fallback` notice.

Also update `sessionController.pendingStarts.test.ts` confirmations to the `reason: "creation"`
union shape (lines 332–479) and `sessionController.modelPolicy.test.ts` save confirmation to
`reason: "policy-save"` (line 211) with the observer-mutation assertions moved to `event.policy`.

**`src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts` (extend)**

- `remember` mocks resolve a `StarterModelPolicyPreference` instead of `undefined`; `write` calls
  take a third `context` argument.
- New: "reports each processed batch through `onRemembered` with its own context": two writes on one
  scope with `{ reason: "creation", requestedPolicy: A }` then `{ reason: "policy-save" }`; assert
  two `onRemembered` calls, the second context `{ reason: "policy-save" }`, and each preference is
  the resolved `remember` value.
- New: "coalesces the newest context": a pending write replaced before the worker picks it up reports
  only the newest context.
- New: "contains observer throws": `onRemembered` throws; assert `write` resolves, `snapshot().error`
  stays unset, and the next write still runs.
- Existing scope/serialization/failure cases keep their assertions with the new call shape.

**`src/client/src/components/starterNotice.test.ts` (extend)**

1. `starterPolicyFallbackNotice("...", scope)` equals `{ kind: "policy-fallback", message, scope }`.
2. `starterNoticeVisibleText` returns the captured message and ignores a live reason.
3. `shouldRetainStarterNotice` retains it in scope and drops it out of scope.

**`src/shared/capabilities.test.ts` (extend)**

Mirror the starter-selection test: value string
`"sessions.modelPolicyLightweightFallback"`, present in `WEB_RUNTIME_CAPABILITIES` and
`SESSIOND_RUNTIME_CAPABILITIES`, parsed by `parseKnownPiWebUiCapabilities`, and effective only when
both components are `available: true` and advertise it (the four-cell matrix).

### 7.5 Commands

Run the narrowest checks while iterating:

```bash
npm test -- --run src/server/sessions/sessionModelPolicyFallback.test.ts
npm test -- --run src/server/sessions/utilityModelResolver.test.ts
npm test -- --run src/server/sessions/modelTierRegistry.test.ts
npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts
npm test -- --run src/server/sessions/utilityModelExtension.test.ts
npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts
npm test -- --run src/server/sessions/piSessionService.rateLimits.test.ts
npm test -- --run src/server/speechInput/speechInputPolishingService.test.ts
npm test -- --run src/server/speechInput/speechInputPolishingService.rateLimits.test.ts
npm test -- --run src/client/src/components/starterPolicyStartDecision.test.ts
npm test -- --run src/client/src/components/sessionModelPolicyDraft.test.ts
npm test -- --run src/client/src/components/SessionModelPolicyControl.test.ts
npm test -- --run src/client/src/components/PromptEditor.sessionConfiguration.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
npm test -- --run src/client/src/controllers/sessionController.starterPolicySubstitution.test.ts
npm test -- --run src/client/src/controllers/sessionController.pendingStarts.test.ts
npm test -- --run src/client/src/controllers/sessionController.modelPolicy.test.ts
npm test -- --run src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts
npm test -- --run src/client/src/components/starterNotice.test.ts
npm test -- --run src/shared/capabilities.test.ts
```

Then the repository gates:

```bash
npm run typecheck
npm run lint
npx knip
npm run verify:fast   # cross-cutting completion
```

Knip note: every new export (`TierResolutionError`, `SessionModelPolicyResolutionError`,
`fallbackSessionModelPolicy`, `initialPolicyUnavailableError`, `UtilityModelUnavailable`,
`UtilityModelUnavailableReason`, `UtilityModelInspection`, `isStructurallyCompleteStarterPolicy`,
`starterModelPolicyPreference`, `StarterStartDecision`, `starterStartDecision`,
`StarterModelPolicySubstitutionEvent`, `ConfirmedPreferenceWriteContext`,
`starterPolicyFallbackNotice`, `isSyntacticallyCompleteExactSelection`, `isCanonicalTier`) is
consumed by production code in this same change. If the work is split across tasks, order the tasks
so no task leaves an export without a production consumer, and keep any staged exports Knip-clean
(no no-op references, no blanket ignores).

---

## 8. Documentation and release

Documentation guide: `docs/config.*` is the canonical configuration surface; `docs/faq.html` owns
troubleshooting; `README.md` is not touched.

1. `docs/config.md`, **Utility models** section (currently lines 275–289): add a bullet after the
   existing behavior list (and nothing in the README):
   - An unusable remembered `+` policy (its active model or tier cannot resolve) starts the session
     in Exact mode on `lightweight`; the substituted policy becomes the workspace's remembered
     starter policy, so the original model returns only when the user reselects it.
   - Keep `lightweight` configured and available: if it cannot resolve, `+` fails with the original
     resolution error plus the lightweight reason instead of starting.
   - Older clients show the substitution only as the session's model; current clients also warn
     before the start when they can evaluate the policy and show a notice naming the used model.
2. `docs/config.html`, **Utility models** section (currently lines 728–746): mirror the same three
   points in the existing `<ul>` with live `<code>` markup; keep the HTML and Markdown claims
   identical.
3. `docs/faq.html`: add `<a href="#lightweight-model-session">Session started on the lightweight
   model</a>` to the FAQ TOC and an `<article id="lightweight-model-session" class="faq-item">`
   entry — "My session started on the lightweight model — how do I restore my model?" — explaining
   that the remembered starter model was unavailable, that the workspace's remembered policy is now
   the lightweight model, and how to restore it: open the session's model policy, choose the
   intended Exact model/thinking (or repair the tier ladder and choose a tier), and reselect it next
   time; also point at **Settings → Utility models** to fix or replace `lightweight`. Do not claim
   the substitution is reversible automatically or that the original model returns on its own.
4. Changeset: **minor** (user-visible feature). Create
   `.changeset/plus-lightweight-fallback.md`:
   ```md
   ---
   "@hyperdreamer/pi-webui": minor
   ---

   Start SESSIONS `+` sessions on the configured lightweight utility model when the remembered
   model policy cannot resolve, remember that substitution, and surface it with a pre-start warning
   when available plus a notice naming the model actually used.
   ```
   No version bump, no `CHANGELOG.md` edit, no `npm publish` (release stays via GitHub Actions per
   `.agents/skills/npm-release-via-github-actions/SKILL.md`).
5. Repo-shipped docs check: `docs/config.md` is in `package.json` `files`; `docs/config.html` and
   `docs/faq.html` are website-only but must stay synchronized (documentation guide).

---

## 9. Acceptance criteria mapped to test cases

| AC (design) | Proving tests |
| --- | --- |
| AC1: complete but unresolvable remembered policy + valid lightweight → `+` creates an Exact session on lightweight in one attempt (Exact-invalid, Tier-invalid, level-invalid) | §7.3.2 recast Exact and Tiered tests; §7.3.3 case 1 and case 2 |
| AC2: persisted policy is the substituted exact policy; confirmed writeback replaces the workspace preference | §7.3.2 persisted-policy assertions; §7.3.3 case 9; §7.4 writer + writer-`onRemembered` adoption tests |
| AC3: pre-start warning when the client can evaluate; post-start notice naming the used model on substitution | §7.4 `PiWebUiApp` cases 1, 2, 7; §7.4 `SessionModelPolicyControl` cases 1–4 |
| AC4: invalid/missing lightweight slot → `+` fails with an explicit error naming the original failure and the lightweight reason; no session created or left published | §7.3.2 moved rejection tests; §7.3.3 cases 7–8; §7.1 error-message tests |
| AC5: requested policy resolves → session starts on it, preference unchanged; contingent warning may have shown | §7.3.3 case 3; §7.4 decision row 6 tests; §7.4 adoption test (no-op adoption) |
| AC6: incomplete drafts and daemons without the capability are blocked as today; complete draft + unavailable catalog starts server-authoritatively | §7.1 rows 2–3, 5, 8; §7.4 cases 2, 4, 5 |
| AC7: older client bundle against a new daemon whose cached catalog is stale-valid substitutes and shows only the model; older client whose cached catalog blocks still refuses | §5 capability matrix tests; §7.4 decision rows 5/8 (capability absent); residual documented in §8 docs |

---

## 10. Open questions

**OQ-1 (resolved by PM ruling — not open).** The design declares
`starterStartDecision(input: { draft; catalog; fallbackSupported })`, but the required blocked
reasons for an unavailable catalog are computed by the app (`modelTierCatalogError === "" ? "Loading
model policy choices" : this.modelTierCatalogError`) and cannot be derived from those three fields.
The spec therefore adds the required fourth field `catalogUnavailableReason: string` (§4.1) so the
pure decision reproduces today's reason texts exactly (rows 2 and 5). No behavior is added beyond
the design's rules; if the reviewer rejects the extra field, the alternative is to keep the
catalog-unavailable blocked reason app-composed, which moves rule 2's reason selection out of the
pure module. Evidence: `PiWebUiApp.ts:2943-2950` (the catalog-unavailable text is app state) and
design §"Rules" bullet 2 plus the closing sentence of that paragraph.

**OQ-2 (resolved by PM ruling — not open).** The design says `inspect` "reports why a task produced no
candidate" but does not define multi-slot precedence. This spec fixes the first-blocker-in-slot-order
rule (§3.4 rows 4–6) for the two-slot `context` task; only `lightweight` (single slot) is consumed by
the fallback path and tested here. If a different precedence is intended for `context`, it changes
only the untested `unavailable` value, never `candidates`, `configuredCandidates`, or the fallback
behavior.

**OQ-3 (resolved by PM ruling — not open).** The design leaves the `policy-fallback` and reworded writer-warning
strings to the implementation. This spec pins
`Session started with the Lightweight utility model (${provider}/${id}) because the remembered model
was unavailable.` and `Could not remember this model policy for future sessions.`; if the PM prefers
different wording, only the constant, the §8 docs text, and the §7.4 assertions change.

**OQ-4 (resolved by PM ruling — not open).** *Automatic unsupported thinking level.* The proposed
`thinking-level-unsupported` probe for an automatic (unset) slot level cannot exist: the resolver's
automatic branch is `supported.includes("minimal") ? "minimal" : "off"` and never returns
`undefined`, so it cannot produce that reason. Ruling: keep `effectiveThinkingLevel` and
`configuredCandidates` byte-identical. The automatic reason-table row and its §7.2 test variant are
removed; `thinking-level-unsupported` remains reachable only through an explicitly configured,
unsupported level (§3.4).

**OQ-5 (resolved by PM ruling — not open).** *Refresh failure during fallback re-validation.*
`resolveAvailableExactSelection` begins with `session.modelRuntime.refresh({ allowNetwork: false })`,
and that infrastructure failure must propagate untouched on both the requested and fallback paths
(design Invariant 2). Ruling: the §3.1 step 6 nested catch is narrowed to
`SessionModelPolicyResolutionError` and rethrows everything else; §3.5 records the narrowed
eligibility, and §7.3.3 case 6 covers the fallback re-validation refresh failure.

---

## 11. Accepted residuals

Carried from the design's "Risks and residual behavior" and the spec review; accepted, not fixed:

- **Transient unavailability becomes permanent** (design risk). A provider outage or expired auth
  also swaps the remembered policy to the lightweight tuple until the user reselects the original;
  the pre-start warning and post-start notice are the only signals, and the runtime snapshot cannot
  distinguish a transient outage from a durable removal.
- **Weaker model by design** (design risk). A coding session may continue on a small model; the user
  accepted this as the price of never blocking `+`.
- **Concurrent plus starts for the same cwd and machine** can attribute the requested policy to the
  wrong created session, because `plusPendingStartPolicy` returns the first matching plus pending
  start. Only the substitution notice and the adoption guard are affected, in an already-racy
  scenario; the design's machine+cwd correlation is unchanged (spec-review observation).
- **Older client bundle against a new daemon** substitutes without the new notice; the session's
  model selector still shows the lightweight model (§5).
