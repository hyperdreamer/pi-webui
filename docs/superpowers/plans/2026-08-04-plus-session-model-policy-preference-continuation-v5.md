# Plus-Created Session Model Policy Final Recovery Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Complete full-policy plus-session initialization, confirmed writeback, draft readiness, client scheduling, Lit integration, documentation, and final verification from the last credited recovery boundary.

**Architecture:** Start from the independently reviewed creation-source implementation and fixes at credited HEAD 7087087. Reimplement complete-policy initialization as the first independently reviewed task, then preserve the approved server-authoritative writeback, immutable draft, confirmation coordinator, capability-gated Lit integration, compatibility, documentation, and verification boundaries in order.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Fastify, the Pi SDK session manager/custom entries, Lit, Vitest, Changesets, and PI WEBUI's existing selected-machine proxy/capability infrastructure.

## Global Constraints

- Implement the approved design in docs/superpowers/specs/2026-08-03-persisted-starter-model-policy-preference-design.md; do not edit that historical specification.
- Add no runtime dependency and do not create a second preference store or browser-owned durable preference.
- Only a top-level root carrying durable creationSource: "session-list-plus" may replace the full preference; prompt-created, imported, reopened-without-marker, spawn_session, and tracked-subsessions remain ineligible.
- Persist complete user intent: active mode, non-blank Exact provider/model/thinking, and canonical tier when Tiered; preserve unavailable inactive or active values without clearing, clamping, or substitution.
- Validate only the active branch for execution; an unavailable active branch blocks creation or mutation with its specific reason, while an unavailable inactive branch remains stored and non-blocking.
- Write a full preference only after successful creation or a server-confirmed session-policy mutation; preference failures are non-blocking and must not roll back runtime or session policy state.
- Keep unversioned defaults reads/writes and legacy starts strict and byte-compatible for old clients; send version-two fields and commands only when sessions.modelPolicyStarterSelection is effectively negotiated.
- Follow the application-relative browser URL convention, encode dynamic segments, and use URLSearchParams for starterModelPolicyContract=2 and cwd query values.
- Keep README.md unchanged; synchronize user-facing behavior in docs/config.md and docs/config.html, add one patch Changeset, and never edit CHANGELOG.md directly.
- Use red-green TDD at the narrowest useful layer, preserve existing user changes, and finish with npm run typecheck, npm run lint, and npm run verify.
- The release handoff must state that pi-webui-sessiond.service needs a manual restart because this feature changes sessiond-loaded code and protocol contracts.
- This v5 continuation starts from credited clean HEAD 7087087bb76bf72d5c745beca44846ddf2b648ac. Preserve uncredited 469b18665bcfd4bc209a9ba2127a58a9f0fca16a only on its safety branch and do not treat its code, report, or child session as evidence for this run.
- Task 1 independently reimplements complete-policy initialization from the credited source-provenance boundary; Tasks 1-6 map in order to v3 Tasks 3-8.
- Prior terminal, corrupted-ledger, interrupted-child, and mismatch artifacts remain immutable audit evidence and are not rewritten or credited here.

## Task 1: Initialize plus-created roots from a complete policy

**Implementer tier:** Capable

**Files:**

- Modify: `src/server/sessions/sessionModelPolicy.ts:1-145`
- Modify: `src/server/sessions/sessionModelPolicy.test.ts:1-360`
- Modify: `src/server/sessions/piSessionService.ts:320-350,1565-1645,4160-4210,5170-5350`
- Modify: `src/server/sessions/piSessionService.modelPolicy.test.ts:250-535`
- Modify: `src/server/sessions/piSessionService.testSupport.ts:1-260`
- Modify: `src/server/sessions/sessionService.ts:1-55`
- Modify: `src/server/sessions/sessionRoutes.ts:1-160`
- Modify: `src/server/sessions/sessionRoutes.test.ts:45-165`
- Modify: `src/client/src/api/clients.ts:250-340`
- Modify: `src/client/src/api/clients.test.ts:320-386`
- Modify: `src/client/src/api.ts:1-6`

**Interfaces:**

- Consumes: existing `SessionStartOptions`, `StarterModelPolicyPreference`, and `SessionCreationSource`, plus credited `serializeSessionCreationSource()` / `inspectSessionCreationSource()` from the creation-source boundary at `7087087`.
- Produces: `planSessionModelPolicyInitialization(policy, resolveTier): SessionModelPolicyPlan`, cloning the full policy and resolving only its active branch.
- Produces: `sessionsApi.startPlusSession(cwd, initialModelPolicy, machineId?)`, which posts exactly `{cwd, creationSource: "session-list-plus", initialModelPolicy}`.
- Preserves: `sessionsApi.startSession()` and legacy `POST /sessions` requests with absent or active-branch-only `modelPolicy`.

- [ ] **Step 1: Write failing initializer, lifecycle, route, and client tests**

Add pure tests that Exact initialization retains an unavailable inactive tier without calling `resolveTier`, while Tiered initialization retains an unavailable inactive Exact tuple and calls `resolveTier` only for the active canonical tier:

```ts
expect(planSessionModelPolicyInitialization({
  mode: "tiered",
  exact: {
    model: { provider: "retired", id: "remembered" },
    thinkingLevel: "retired-level",
  },
  tier: "standard",
}, resolveTier)).toEqual({
  policy: {
    mode: "tiered",
    exact: {
      model: { provider: "retired", id: "remembered" },
      thinkingLevel: "retired-level",
    },
    tier: "standard",
  },
  target: standardSelection,
});
```

Extend lifecycle tests to assert model then thinking then policy append then source append all occur before `session.created`; direct response and event both contain `creationSource`. Assert invalid active Exact, unresolved active Tiered, policy append failure, and source append failure abort/dispose the unseen root and deliver no prompt/event. Assert inactive unavailability does not abort. Assert ordinary browser legacy roots get no source marker and tool/spawn/tracked creation paths never pass the source option.

Route tests must reject unknown body keys, unknown source, source without initializer, initializer without source, mixed `modelPolicy`/`initialModelPolicy`, blank Exact fields, and Tiered without tier before calling the service. Client tests must assert application-relative encoded local/remote paths and an exact body.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run: `npm test -- --run src/server/sessions/sessionModelPolicy.test.ts src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/sessionRoutes.test.ts src/client/src/api/clients.test.ts`

Expected: FAIL because only the legacy active-branch initializer and start body exist.

- [ ] **Step 3: Implement full initialization and strict route branching**

Add a full initialization planner that clones both remembered branches and resolves only the active one:

```ts
export function planSessionModelPolicyInitialization(
  policy: SessionModelPolicy,
  resolveTier: (tier: ModelTier) => ExactModelSelection,
): SessionModelPolicyPlan {
  const cloned = cloneSessionModelPolicy(policy);
  return {
    policy: cloned,
    target: cloned.mode === "exact"
      ? cloneExactModelSelection(cloned.exact)
      : cloneExactModelSelection(resolveTier(cloned.tier)),
  };
}
```

Represent PiSessionService's internal initializer as an explicit tagged union so full Exact cannot be confused with an Exact update. For a plus start, validate/apply only the planned target, append the complete supplied policy, append and inspect the source marker, then publish status/global creation only after both records verify. Keep all work inside existing create cleanup so any failure aborts and disposes the root.

Change `SessionRouteService.start(cwd, options?: SessionStartOptions)`. Strictly parse the mutually exclusive legacy and plus body shapes with exact key sets. Add `sessionsApi.startPlusSession()` rather than widening old call sites, and route both through the existing selected-machine request boundary.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- --run src/server/sessions/sessionModelPolicy.test.ts src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/sessionRoutes.test.ts src/client/src/api/clients.test.ts`

Run: `npm run typecheck`

Expected: PASS; full initialization persists both branches and provenance before announcement, while every legacy and tool-created path retains its current behavior.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/sessionModelPolicy.ts src/server/sessions/sessionModelPolicy.test.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/piSessionService.testSupport.ts src/server/sessions/sessionService.ts src/server/sessions/sessionRoutes.ts src/server/sessions/sessionRoutes.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts
git commit -m "feat(sessions): initialize plus roots from full policy"
```

## Task 2: Add server-authoritative confirmed-policy writeback

**Implementer tier:** Capable

**Files:**

- Create: `src/server/sessions/rememberCurrentModelPolicy.ts`
- Create: `src/server/sessions/rememberCurrentModelPolicy.test.ts`
- Modify: `src/server/sessions/piSessionService.ts:1000-1220,5080-5180`
- Modify: `src/server/sessions/piSessionService.modelPolicy.test.ts:535-700`
- Modify: `src/server/sessions/sessionService.ts:35-70`
- Modify: `src/server/sessions/sessionRoutes.ts:130-230`
- Modify: `src/server/sessions/sessionRoutes.test.ts:80-230`
- Modify: `src/server/sessiond.ts:560-720`
- Modify: `src/server/sessiond/sessionProxyRoutes.ts:1-180`
- Modify: `src/server/sessiond/sessionProxyRoutes.test.ts:1-280`
- Modify: `src/shared/federatedRoutes.ts:1-190`
- Modify: `src/client/src/api/parsers.ts:700-790`
- Modify: `src/client/src/api/clients.ts:300-380`
- Modify: `src/client/src/api/clients.test.ts:320-430`
- Modify: `src/client/src/api/federatedRouteContract.test.ts:1-190`
- Modify: `src/client/src/api.ts:1-6`

**Interfaces:**

- Consumes: source inspection from the credited creation-source boundary at `7087087`, newest `SessionModelPolicyInspection` from the existing policy module, and tagged full store writes from reviewed commit `90b7875`.
- Produces: `RememberCurrentModelPolicyCommand.remember(session: SessionRouteLookup): Promise<StarterModelPolicyPreference>` using injected `loadSnapshot` and `preferenceStore` dependencies.
- Produces: `SessionRouteService.rememberCurrentModelPolicy(ref)` and `POST /sessions/:sessionId/model-policy/remember?cwd=...`, with no policy body and a strict full-preference response.
- Produces: `sessionsApi.rememberCurrentModelPolicy(session, machineId?)` using the same encoded session/cwd path helper as existing policy routes.

- [ ] **Step 1: Write failing command, route, proxy, federation, and client tests**

Create command tests with injected snapshots and store. Cover eligible persisted Exact and Tiered policies, absent/malformed/newest-invalid source, absent/legacy/malformed policy, and `transitionInFlight: true`. Verify store calls only this shape:

```ts
expect(preferenceStore.replace).toHaveBeenCalledWith("/workspace", {
  kind: "full",
  preference: confirmedPolicy,
});
```

Add a deferred concurrency test: queue command A, mutate the injected snapshot to policy B before command B executes, release A, and assert both execution-time reads return/write B as the newest truth and the final write is B. Rejecting one save must not poison the command queue.

In PiSessionService coverage, assert a store rejection leaves the already confirmed session runtime/policy unchanged. Route/client tests must assert no caller policy payload, normalized cwd lookup, encoded app-relative local/remote URLs, strict response parsing, and this status mapping: malformed request/body/query is 400, missing session is 404, ineligible source/absent or malformed persisted policy/transient policy mutation is 409, and preference-store failure is 500. Add the new POST route to the federated allowlist and proxy-contract tests.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run: `npm test -- --run src/server/sessions/rememberCurrentModelPolicy.test.ts src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/sessionRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts`

Expected: FAIL because the command, route, proxy contract, and browser method are absent.

- [ ] **Step 3: Implement the serialized policy-free command**

Use these command boundaries:

```ts
export interface ConfirmedPolicySnapshot {
  cwd: string;
  creationSource: CreationSourceInspection;
  modelPolicy: SessionModelPolicyInspection;
  transitionInFlight: boolean;
}

export interface RememberCurrentModelPolicyDependencies {
  loadSnapshot(session: SessionRouteLookup): Promise<ConfirmedPolicySnapshot>;
  preferenceStore: Pick<StarterModelPolicyPreferenceStore, "replace">;
}

export class RememberCurrentModelPolicyCommand {
  remember(session: SessionRouteLookup): Promise<StarterModelPolicyPreference>;
}
```

Serialize the entire `loadSnapshot` plus store replacement operation, not merely the file write, so delayed commands reread policy at execution time. Require source inspection `{kind: "valid", source: "session-list-plus"}`, no policy mutation count, and policy inspection `{kind: "persisted"}`. Convert by deep clone to the distinct starter type; do not resolve catalogs or accept fallback/legacy policy.

Have PiSessionService supply the snapshot by opening the normalized session, reading entries once for both strict inspectors, and checking `modelPolicyMutationCounts`. Inject the same `StarterModelPolicyPreferenceStore` instance into PiSessionService and `SessionDefaultsService` from `sessiond.ts`. The POST route accepts only path plus optional cwd query and an empty body, calls the command, and returns the full preference directly. Add the selected-machine federated route and strict browser parser/client.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- --run src/server/sessions/rememberCurrentModelPolicy.test.ts src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/sessionRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts`

Run: `npm run typecheck`

Expected: PASS; eligibility is independently enforced server-side, delayed commands read newest persisted truth, and preference failures cannot roll back session state.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/rememberCurrentModelPolicy.ts src/server/sessions/rememberCurrentModelPolicy.test.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/sessionService.ts src/server/sessions/sessionRoutes.ts src/server/sessions/sessionRoutes.test.ts src/server/sessiond.ts src/server/sessiond/sessionProxyRoutes.ts src/server/sessiond/sessionProxyRoutes.test.ts src/shared/federatedRoutes.ts src/client/src/api/parsers.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts src/client/src/api.ts
git commit -m "feat(model-policy): remember confirmed plus-session policy"
```

## Task 3: Model full starter drafts and active-branch readiness

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/sessionModelPolicyDraft.ts:1-260`
- Modify: `src/client/src/components/sessionModelPolicyDraft.test.ts:1-620`

**Interfaces:**

- Consumes: legacy/version-two defaults from the earlier negotiated-defaults boundary tasks, the existing complete starter-preference contract, the model-tier catalog, and existing immutable draft selectors.
- Produces: `seedStarterModelPolicyDraft(defaults)`, accepting `SessionDefaultsResponse | SessionDefaultsV2Response` and preserving the response's exact/full/legacy semantics.
- Produces: `completeUnownedStarterExactFromActiveTier(draft, defaults, catalog): SessionModelPolicyDraft` and `evaluateStarterModelPolicyDraft(draft, catalog): StarterModelPolicyEvaluation`.
- Produces: ready evaluation `{kind: "ready", initialModelPolicy, resolved}` or blocked evaluation `{kind: "blocked", reason}`; returned values are deep clones and no helper mutates draft/default/catalog inputs.

- [ ] **Step 1: Replace old starter assumptions with failing pure tests**

Add cases for:

```ts
expect(seedStarterModelPolicyDraft(v2Defaults({}))).toEqual({
  mode: "tiered",
  tier: "standard",
  exact: completePiDefault,
});

expect(seedStarterModelPolicyDraft(v2Defaults({
  starterModelPolicyPreference: {
    mode: "exact",
    exact: unavailableExact,
    tier: "frontier",
  },
}))).toEqual({
  mode: "exact",
  exact: unavailableExact,
  tier: "frontier",
});
```

Also prove: old unversioned peers still seed Exact; full Tiered retains its unavailable Exact branch; fresh/legacy Tiered with no complete Exact fills that unowned branch from the active tier only after the tier validly resolves; incomplete legacy Exact stays incomplete and blocked; full remembered Exact is never replaced by tier resolution.

For readiness, assert active Exact returns provider/model-unavailable or thinking-unsupported reasons while ignoring an unavailable inactive tier. Assert active Tiered returns the selected row's exact reason while ignoring unavailable inactive Exact. Mode round trips must expose a retained branch's block only when that branch becomes active. Configuration repair must turn the same draft from blocked to ready without changing its values. A ready result must include all three Exact strings and a Tiered tier.

- [ ] **Step 2: Run the pure tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/sessionModelPolicyDraft.test.ts`

Expected: FAIL because absent version-two preferences still seed Exact, full initialization/readiness helpers do not exist, and current validation cannot report specific active-branch reasons.

- [ ] **Step 3: Implement immutable seeding, completion, and readiness**

Use this explicit result type:

```ts
export type StarterModelPolicyEvaluation =
  | {
      kind: "ready";
      initialModelPolicy: StarterModelPolicyPreference;
      resolved: ExactModelSelection;
    }
  | { kind: "blocked"; reason: string };
```

Seed rules:

```ts
// Version 1: retain current Exact/Pi-default behavior.
// Version 2 full: clone mode, exact, and optional tier verbatim.
// Version 2 legacy: clone mode/tier and use complete raw Pi Exact when present.
// Version 2 absent: mode "tiered", tier "standard", complete Pi Exact or an empty draft branch.
```

`completeUnownedStarterExactFromActiveTier()` may fill an empty/incomplete Exact branch only when the response has no full preference, the draft is Tiered, and the selected tier resolves through a valid row/complete ladder. It must never modify a non-blank remembered full Exact selection.

`evaluateStarterModelPolicyDraft()` validates syntax plus availability only for the active branch. Exact locates provider/model in `catalog.models` and checks the selected model's thinking list. Tiered requires a canonical tier, valid selected row, and resolved ladder entry; prefer the row's `reason`, then `configError`, then a stable specific fallback. After active validation, require a syntactically complete inactive Exact only to form the protocol's full initializer; the completion helper supplies it for fresh/legacy Tiered cases. Clone the complete draft into the ready result.

Retain the existing legacy preference conversion helper for old peers, but type its return as `LegacyStarterModelPolicyPreference`; it must not be used as a full write.

- [ ] **Step 4: Run the pure tests and static checks**

Run: `npm test -- --run src/client/src/components/sessionModelPolicyDraft.test.ts`

Run: `npm run typecheck`

Expected: PASS; unavailable intent survives untouched, only active availability gates readiness, and full initializers are complete and immutable.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/sessionModelPolicyDraft.ts src/client/src/components/sessionModelPolicyDraft.test.ts
git commit -m "feat(model-policy): validate complete starter drafts"
```

## Task 4: Schedule writeback from confirmed client session outcomes

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.ts`
- Create: `src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts`
- Modify: `src/client/src/controllers/sessionController.ts:65-120,260-325,1020-1160,1375-1515`
- Modify: `src/client/src/controllers/sessionController.testSupport.ts:1-180`
- Modify: `src/client/src/controllers/sessionController.pendingStarts.test.ts:1-335`
- Modify: `src/client/src/controllers/sessionController.modelPolicy.test.ts:150-730`

**Interfaces:**

- Consumes: `sessionsApi.startPlusSession()` from Task 1, `sessionsApi.rememberCurrentModelPolicy()` from Task 2, complete starter policy, and projected `SessionInfo.creationSource` from the credited creation-source boundary.
- Produces: additive `SessionController.startPlusSession(initialModelPolicy)` and `startPlusSessionWithPrompt(text, streamingBehavior, attachments, delivery, initialModelPolicy, onStarted?)`; legacy start methods remain unchanged.
- Produces: optional dependency callback `onStarterModelPolicyConfirmed(event)` where `event = {machineId: string; session: SessionInfo; policy: StarterModelPolicyPreference}`.
- Produces: `ConfirmedStarterModelPolicyPreferenceWriter.write(scope, session)` and `.snapshot(scope)`, serializing/coalescing policy-free remember commands per `{machineId, cwd}` and reporting scoped non-blocking saving/error state.

- [ ] **Step 1: Write failing pending-start, confirmation, and writer tests**

Add controller tests that a plus start:

```ts
const start = controller.startPlusSession(fullPreference);
expect(api.startPlusSession).toHaveBeenCalledWith("/repo", fullPreference, "local");
started.resolve({ ...replacementSession, creationSource: "session-list-plus" });
await expect(start).resolves.toBe(true);
expect(onStarterModelPolicyConfirmed).toHaveBeenCalledWith({
  machineId: "local",
  session: expect.objectContaining({ id: "new-session", creationSource: "session-list-plus" }),
  policy: fullPreference,
});
```

Assert the temporary row also carries source, request/draft values are cloned once, queued initial prompt waits for creation, and failed/discarded/stale plus starts produce no callback. Legacy starts and resolved sessions without the returned source produce no callback.

Extend policy-save tests so only a successful response with a full `response.policy` for a selected plus-created root invokes the callback. Failed, blocked, omitted-policy, archived, imported, and ordinary roots do not. A callback receives the server response clone, not the optimistic draft.

For the new writer, use deferred requests to prove one scope serializes and coalesces pending session references, scopes remain independent, an older failure cannot overwrite a later success, a later success clears the warning, observer exceptions do not poison writes, and idle successful scopes are pruned. The writer must never accept a policy payload.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run: `npm test -- --run src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.modelPolicy.test.ts`

Expected: FAIL because plus-specific start methods, confirmed callbacks, and policy-free scoped writer are absent.

- [ ] **Step 3: Add the plus start path and confirmation coordinator**

Use one private pending-start request union:

```ts
type PendingSessionStartRequest =
  | { kind: "legacy"; modelPolicy?: SessionModelPolicyUpdate }
  | { kind: "plus"; initialModelPolicy: StarterModelPolicyPreference };
```

Keep public legacy methods delegating with `kind: "legacy"`; add plus methods delegating with `kind: "plus"`. Build the pending row with `creationSource: "session-list-plus"` only for the plus branch and call the matching API method. After HTTP creation succeeds, invoke `onStarterModelPolicyConfirmed` only if the returned session independently projects `session-list-plus`; use the successfully accepted initializer as the confirmed policy event. After `saveModelPolicy()` settles successfully, invoke the callback only when the selected captured session has plus source and the response contains a full policy. Preserve all existing request-order and selection guards.

Implement `ConfirmedStarterModelPolicyPreferenceWriter` with this dependency:

```ts
export interface ConfirmedStarterModelPolicyPreferenceWriterDependencies {
  remember(scope: StarterModelPolicyPreferenceWriteScope, session: SessionInfo): Promise<unknown>;
  onStateChange?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    snapshot: StarterModelPolicyPreferenceWriteSnapshot,
  ) => void;
}
```

Clone session refs at enqueue boundaries, keep one worker per scope, and replace only the pending target when coalescing. Contain `remember()` rejection as a scoped error; resolve callers without throwing so session work is never blocked. Preserve generation ordering by letting a later queued success clear an earlier failure only after it settles.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- --run src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.modelPolicy.test.ts`

Run: `npm run typecheck`

Expected: PASS; only successful plus creation/confirmation emits writeback intent, and the writer queues no caller-supplied policy.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.ts src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.testSupport.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.modelPolicy.test.ts
git commit -m "feat(model-policy): queue confirmed plus-session writeback"
```

## Task 5: Integrate negotiated full-policy behavior in the Lit application

**Implementer tier:** Capable

**Files:**

- Modify: `src/shared/capabilities.ts:8-55`
- Modify: `src/shared/capabilities.test.ts:1-215`
- Modify: `src/client/src/components/PiWebUiApp.ts:180-380,1120-1220,1560-1665,1980-2070,2220-2370,3000-3265,3280-3410`
- Modify: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts:220-1695`
- Modify: `src/client/src/components/PromptEditor.sessionConfiguration.test.ts:1-230`

**Interfaces:**

- Consumes: the credited version-two defaults client boundary from the earlier negotiated-defaults work, starter evaluation from Task 3, plus start/confirmed callback and scoped writer from Task 4, and remember client from Task 2.
- Produces: effective-capability-gated app flow that requests V2 defaults, seeds/restores both branches, sends full plus starts, retains confirmed in-memory policy, and writes back only confirmed eligible outcomes.
- Advertises: `sessions.modelPolicyStarterSelection` from both `WEB_RUNTIME_CAPABILITIES` and `SESSIOND_RUNTIME_CAPABILITIES`; this is the feature activation point.
- Preserves: old peers use the current unversioned defaults/start/update path and receive no new field, query, or command.

- [ ] **Step 1: Rewrite/add failing application tests around the approved behavior**

Keep existing active policy mutation tests, but replace the obsolete assertion that active-session changes never write starter preferences with capability- and provenance-aware cases. Add tests proving:

```ts
// Fully capable, no preference:
expect(starterDraft(app)).toEqual({
  mode: "tiered",
  tier: "standard",
  exact: completePiDefault,
});
expect(sessionDefaultsV2).toHaveBeenCalledWith("/repo", "local");

// Ready plus start:
expect(startPlusSession).toHaveBeenCalledWith(expect.objectContaining({
  mode: "tiered",
  tier: "standard",
  exact: completePiDefault,
}));
expect(startSession).not.toHaveBeenCalled();
```

Add full Exact/Tiered restoration tests that preserve both branches; exact provider/model missing, exact thinking unsupported, and tier-row unavailable tests that keep the selected value visible and block only in the matching active mode; mode-switch and configuration-repair tests that do not call a preference endpoint before confirmation; fresh/legacy Tiered completion from Standard resolution when Pi Exact defaults are incomplete; and incomplete legacy Exact repair.

Add creation/writeback tests: successful plus start schedules one policy-free remember; failed creation does not; server-confirmed mode/model/thinking/tier mutations on a plus-created root schedule remember; imported/prompt-created/no-marker sessions do not; preference failure leaves start/mutation successful and displays `Could not remember this model policy; this session still uses it.`; later success clears it; workspace/machine/session changes suppress stale warning or draft publication. Assert that navigating away before a successful plus start settles still queues writeback against the event's originating machine/workspace, without publishing saving/error state into the newly selected scope. Assert a confirmed policy updates the current scope's in-memory starter draft even when durable writeback fails, so another `+` in the same page uses that confirmation.

Add capability-ordering tests: an unknown/legacy capability state followed by effective V2 support triggers a V2 defaults reload, and a late unversioned response for the same workspace cannot replace the newer V2 response.

Retain explicit old-peer tests: exact Pi-default seed, legacy preference updates, old `startSession(modelPolicy)` call, and no V2 query/source/full initializer/remember command. Extend PromptEditor coverage only where needed to prove an unavailable selected Exact value remains rendered and repair controls stay enabled while Send is disabled.

- [ ] **Step 2: Run focused app tests and confirm they fail**

Run: `npm test -- --run src/shared/capabilities.test.ts src/client/src/components/sessionModelPolicyDraft.test.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts`

Expected: FAIL because the app still uses version-one defaults, persists pre-session mode/tier immediately, clears the starter after success, and sends only an active-branch start snapshot.

- [ ] **Step 3: Wire capability negotiation, readiness, plus start, and confirmed writeback**

Add a helper that checks `sessions.modelPolicyStarterSelection` on the selected machine. In `loadStarterSessionDefaults()`, call `sessionDefaultsV2()` only when supported; otherwise call the current method. Keep the state typed as `SessionDefaultsResponse | SessionDefaultsV2Response`. Give defaults loads a monotonically increasing request sequence plus captured machine/workspace identity, and publish only the newest matching response. When runtime discovery changes the current peer from unknown/legacy to effectively supporting the capability, issue a fresh V2 load so an earlier unversioned response cannot strand or overwrite full behavior. Seed through Task 3, load the selected machine's tier catalog for every V2 starter in either mode, and rerun `completeUnownedStarterExactFromActiveTier()` whenever defaults or that catalog changes.

Project starter status from `evaluateStarterModelPolicyDraft()`. Use its exact active-branch reason as `blockedReason`; do not compare full Exact intent to Pi defaults. Keep unavailable selected Exact values in the trigger/status and include the unavailable current model/thinking choice in existing menus without making it an automatic replacement. Under the new capability, starter model/thinking edits modify only the draft and wait for successful creation; under old capability, retain existing Pi-default update and version-one preference behavior.

For ready V2 starts, call `startPlusSession()` / `startPlusSessionWithPrompt()` with the complete initializer. For legacy peers, retain `startSession()` / `startSessionWithPrompt()` and active-branch snapshots. Do not clear a V2 starter draft after success; update it from each guarded `onStarterModelPolicyConfirmed` event so server-confirmed page-lifetime intent survives a write failure. Reset it only on the existing machine/workspace scope transitions.

Instantiate `ConfirmedStarterModelPolicyPreferenceWriter` with:

```ts
remember: (scope, session) =>
  sessionsApi.rememberCurrentModelPolicy(session, scope.machineId),
onStateChange: (scope) => {
  if (scopeMatchesCurrentSelection(scope)) this.requestUpdate();
},
```

The SessionController callback must derive its writer scope from the event's captured `machineId` and `session.cwd`. Because the returned plus source proves that the originating peer supports the command, queue writeback for that originating scope even if selection has since changed. Only adopt the confirmed policy into the in-memory starter draft, clear read diagnostics, or render saving/error state when current machine/workspace/session generation guards still match. Show a current scope's writer error through the existing starter notice/diagnostic path without setting `state.error` or disabling session work. A subsequent successful command clears both its prior write warning and that current scope's preference-read diagnostic.

Finally add the new capability to both runtime advertisement arrays and update capability tests to require both sides.

- [ ] **Step 4: Run the full focused feature matrix and static checks**

Run: `npm test -- --run src/shared/capabilities.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/cachedNewSessions.test.ts src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.modelPolicy.test.ts src/client/src/components/sessionModelPolicyDraft.test.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts`

Run: `npm run typecheck`

Run: `npm run knip`

Expected: PASS; V2 peers use full confirmed behavior, old peers remain byte-compatible, and every new export has a production consumer.

- [ ] **Step 5: Commit**

```bash
git add src/shared/capabilities.ts src/shared/capabilities.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
git commit -m "feat(model-policy): restore plus-session policy selections"
```

## Task 6: Document, changeset, and verify the complete feature

**Implementer tier:** Advanced

**Files:**

- Modify: `docs/config.md:227-255`
- Modify: `docs/config.html:643-676`
- Inspect: `CONTEXT.md:1-55`
- Create: `.changeset/remember-plus-session-model-policy.md`

**Interfaces:**

- Consumes: completed behavior and compatibility contract from credited predecessor work plus Tasks 1-5 and the approved terminology already committed in CONTEXT.md.
- Produces: synchronized canonical Markdown/HTML user documentation and one patch Changeset for `@hyperdreamer/pi-webui`.
- Produces no code API; this task is the merge-level verification and release-handoff boundary.

- [ ] **Step 1: Update the canonical docs and add the patch Changeset**

Replace stale claims that absent preference means Exact, starter edits persist immediately, or active-session changes never affect future defaults. The synchronized Markdown and HTML must state:

- on fully capable peers, a fresh workspace starts Tiered / Standard;
- only successful SESSIONS `+` roots own future full preference updates;
- mode, Exact provider/model/thinking, and remembered tier are restored per selected machine and normalized workspace;
- unavailable active intent stays selected and blocks with its reason, while inactive intent is retained and non-blocking;
- imported, prompt-created, spawned, and tracked sessions never become sources;
- old peers retain version-one behavior;
- writeback failure is non-blocking; and
- installing this change requires one manual `pi-webui-sessiond.service` restart.

Keep `README.md` unchanged. Confirm the already approved `CONTEXT.md` definitions still match implementation names; edit it only if an implementation name differs from the approved terms.

Create exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Restore each workspace's last confirmed model policy from a session created through SESSIONS +, including Exact model/thinking and Tiered tier selections.
```

- [ ] **Step 2: Run documentation and diff checks**

Run: `git diff --check`

Run: `! rg -n "starts in Exact mode|Starter selections update|changes inside an existing session do not" docs/config.md docs/config.html`

Expected: `git diff --check` exits 0 and the negated stale-claim search exits 0 with no matches.

- [ ] **Step 3: Run focused server and client regression suites**

Run: `npm test -- --run src/server/sessions/starterModelPolicyPreferenceStore.test.ts src/server/sessions/sessionDefaultsService.test.ts src/server/sessions/sessionDefaultsRoutes.test.ts src/server/sessions/sessionCreationSource.test.ts src/server/sessions/piSessionManagerGateway.test.ts src/server/sessions/sessionArchiveStore.test.ts src/server/sessions/sessionModelPolicy.test.ts src/server/sessions/piSessionService.modelPolicy.test.ts src/server/sessions/rememberCurrentModelPolicy.test.ts src/server/sessions/sessionRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts src/client/src/cachedNewSessions.test.ts src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.modelPolicy.test.ts src/client/src/components/sessionModelPolicyDraft.test.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts src/shared/capabilities.test.ts`

Expected: PASS for all listed files.

- [ ] **Step 4: Run the merge-level gates**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm run verify`

Expected: all commands exit 0; `verify` passes typecheck, lint, Knip, and the complete Vitest suite.

- [ ] **Step 5: Review the final diff against acceptance criteria**

Run: `git status --short`

Run: `git diff --stat 2b6bd8c`

Run: `git diff --check 2b6bd8c`

Expected: only feature, tests, synchronized config docs, and one patch Changeset differ in the worktree after the approved design commit; no `README.md`, `CHANGELOG.md`, package version, lockfile version, generated build output, or unrelated file appears.

- [ ] **Step 6: Commit**

```bash
git add docs/config.md docs/config.html CONTEXT.md .changeset/remember-plus-session-model-policy.md
git commit -m "docs: explain plus-session model policy memory"
```

After committing, record in the implementation handoff that `pi-webui-sessiond.service` must be restarted manually; web/API/UI autoreload alone does not activate the sessiond protocol, store, provenance, or command changes.
