# Composer Exact/Tiered Session Model Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user choose and persist an Exact or Tiered model policy from both the starter and active-session composers, applying a complete model/thinking tuple safely whenever that UI policy changes.

**Architecture:** Keep model-policy authority in the long-lived session daemon. A pure server module owns versioned policy-entry parsing, legacy derivation, and transition planning; `PiSessionService` owns runtime validation, model-then-thinking application, restoration, persistence, and status publication. The browser owns only drafts and confirmed display state: a pure draft module feeds a focused Lit control, while `PromptEditor` remains layout glue and `SessionController` owns selected-session transport and stale-response protection.

**Tech Stack:** TypeScript, Fastify, Lit, `@earendil-works/pi-ai`, Pi session custom entries, existing selected-machine federation/session-daemon proxy, Vitest, Changesets.

## Global Constraints

- This is the **composer policy slice** of the approved [Tiered session model policy and deterministic SDD design](../specs/2026-07-31-tiered-session-model-policy-and-deterministic-sdd-design.md). It implements UI-authorized Exact/Tiered selection, persistence, and atomic application only.
- Do **not** implement `/tier-*` directive parsing, directive-bearing busy queues, request-boundary re-resolution, `get_model_policy`, `dispatchKey`, tool-child policy inheritance, idempotent dispatch, or deterministic-SDD wiring in this plan. Those remain separate command/policy-core and dispatch tasks.
- Consequently, in this slice `ClientSessionModelPolicyStatus.resolved` means the exact tuple most recently and successfully applied by the policy UI. Do not document it as automatic live remapping after a later ladder edit.
- The canonical six-tier order is unchanged: `economy`, `fast`, `standard`, `advanced`, `capable`, `frontier`. Tiers remain policy labels rather than model identities; duplicate ladder tuples remain valid.
- A new root starts in Exact mode. Its remembered Exact branch is the Pi runtime’s resolved model/thinking pair. A starter that explicitly chooses Tiered must carry its typed policy in `POST /sessions`, and that tuple must be applied before the initial prompt can reach Pi.
- Session policy is a versioned, non-LLM-context custom entry named `pi-webui.model-policy`. Read only the active branch. The newest matching entry is authoritative; a malformed or unsupported newest matching entry must not revive an older policy or silently fall back for execution.
- Exact and Tiered remember independent branches. Switching to Tiered preserves the remembered Exact tuple; switching back to Exact restores that tuple. A Tiered policy always has a tier.
- No policy path may silently substitute a model, a tier, or a thinking level. A Tiered transition resolves through the machine’s authenticated live catalog and configured ladder. An Exact transition validates its chosen exact tuple against the live catalog.
- Apply a target tuple in the only safe order: validate target thinking against the **incoming** model, call `setModel`, then call `setThinkingLevel`, then verify both effective values. Pi may internally emit a transient thinking clamp during `setModel`; no provider request or confirmed policy status may observe a partial final policy application.
- If runtime apply or custom-entry persistence fails after a mutation has begun, restore the previous exact tuple using the same model-then-thinking order. If restoration cannot be proven, record `MODEL_POLICY_BLOCKED`, publish its reason in status, and reject prompts until an explicit successful policy repair clears it.
- UI policy changes and existing exact model/thinking mutations require a writable, idle session. Archived, streaming, bash-running, compacting, queued, tree-navigating, or session-entry-mutating sessions remain inspectable but cannot mutate policy. The server guard remains authoritative.
- Existing model/thinking routes continue to work only in Exact mode. After each successful exact route/cycle, persist the runtime’s **actual confirmed** tuple as the remembered Exact branch. Reject those routes while Tiered is active instead of creating a value that the tiered policy would overwrite.
- Add the dedicated additive capability `sessions.modelPolicy`; do not infer support from `settings.selectedMachine` or `settings.modelTiers`. The feature is shown for a remote machine only when its negotiated runtime advertises the dedicated capability.
- Browser paths remain application-relative; dynamic machine IDs, session IDs, and `cwd` query values must be encoded by the existing API path helpers. Do not introduce raw browser `fetch` or leading-root application paths.
- Keep domain decisions in pure modules, persistence/runtime effects in `PiSessionService`, HTTP conversion in routes/parsers, selected-session orchestration in `SessionController`, and Lit rendering/event glue in components.
- Follow TDD: prove pure policy/draft behavior first, then runtime/controller/route contracts, then focused component behavior, then broad verification.
- Update `docs/config.md` and `docs/config.html` together. Keep `README.md` unchanged: this staged composer capability does not alter the shortest supported first-run path. Add one patch Changeset and do not manually edit `CHANGELOG.md`.
- This changes session-daemon-loaded code and session-daemon protocol contracts. After installation, `pi-webui-sessiond.service` requires a **manual restart**; UI/API autoreload alone is insufficient.

---

## File Map

### Shared contracts and compatibility

- Modify: `src/shared/apiTypes.ts` — exact-selection, persisted-policy transport, session-policy response/update, optional session-status projection, start request support, and `sessions.modelPolicy` capability.
- Modify: `src/shared/capabilities.ts` — advertise and negotiate the dedicated capability only when both web and session daemon support it.
- Modify: `src/shared/capabilities.test.ts` — prove known-capability parsing and effective two-component negotiation.

### Daemon policy domain and runtime authority

- Create: `src/server/sessions/sessionModelPolicy.ts` — pure custom-entry parsing/serialization, active-branch inspection, legacy derivation, and transition planning.
- Create: `src/server/sessions/sessionModelPolicy.test.ts` — pure persistence and mode-transition coverage.
- Modify: `src/server/sessions/modelTierRegistry.ts` — expose fail-closed full-ladder validation to status/policy callers without duplicating config parsing.
- Modify: `src/server/sessions/modelTierRegistry.test.ts` — cover registry-level missing/invalid/current catalog validation.
- Modify: `src/server/sessions/piSessionService.ts` — root policy initialization, active-session inspection cache, atomic runtime adapter, blocked-state handling, exact route synchronization, status projection, and read/update public methods.
- Modify: `src/server/sessions/sessionService.ts` — expose typed start, inspection, and update methods to the route layer.
- Create: `src/server/sessions/piSessionService.modelPolicy.test.ts` — focused runtime/service regression harness for apply, restore, root creation, status, and guards.

### HTTP, daemon protocol, and federation

- Modify: `src/server/sessions/sessionRoutes.ts` — parse strict `POST /sessions` policy input plus `GET`/`PUT /sessions/:sessionId/model-policy`.
- Modify: `src/server/sessions/sessionRoutes.test.ts` — route body/query validation, status mapping, and typed service forwarding.
- Modify: `src/shared/federatedRoutes.ts` — add both session-scoped GET/PUT route specifications.
- Modify: `src/client/src/api/federatedRouteContract.test.ts` — assert both routes remain forwarded for selected remote machines.
- Do not modify: `src/server/sessiond/sessionProxyRoutes.ts` — its existing `app.all("/api/sessions/*")` catch-all already proxies all session-scoped methods and paths.

### Browser contracts, controller, and composer UI

- Modify: `src/client/src/api/parsers.ts` — strict parsers for all additive model-policy fields and policy responses.
- Modify: `src/client/src/api/clients.ts` — optional typed policy on session start plus active-session GET/PUT methods using existing URL helpers.
- Modify: `src/client/src/api/clients.test.ts` and `src/client/src/api/parsers.test.ts` — request-path/body and strict parser coverage.
- Modify: `src/client/src/appState.ts` — selected-session policy inspection/loading/saving/error state.
- Modify: `src/client/src/controllers/sessionController.ts` — selected-session policy fetch/save operations, stale-selection guards, response-to-status application, and typed starter creation snapshot.
- Create: `src/client/src/controllers/sessionController.modelPolicy.test.ts` — controller request, confirmed-state, and stale-result coverage.
- Create: `src/client/src/components/sessionModelPolicyDraft.ts` — framework-free policy-control draft transitions and catalog validation.
- Create: `src/client/src/components/sessionModelPolicyDraft.test.ts` — pure draft coverage.
- Create: `src/client/src/components/SessionModelPolicyControl.ts` — accessible Exact/Tiered mode trigger, tier display/selection, repair form, and responsive popover/sheet.
- Create: `src/client/src/components/SessionModelPolicyControl.test.ts` — component-boundary and real-DOM accessibility/keyboard coverage.
- Modify: `src/client/src/components/PromptEditor.ts` — render policy control first; render normal model/thinking controls only in Exact mode; include policy state in the streaming-safe equality check.
- Modify: `src/client/src/components/PromptEditor.sessionConfiguration.test.ts` — starter/active control ordering and narrow callback-wiring coverage.
- Modify: `src/client/src/components/PiWebUiApp.ts` — load selected-machine tier catalog on demand, connect active-policy controller state, maintain/reset starter policy draft, and pass a typed start snapshot.
- Create: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts` — starter reset, capability gate, catalog stale-response, and start snapshot coverage.

### Documentation and release metadata

- Modify: `docs/config.md` and `docs/config.html` — stage-accurate Exact/Tiered composer behavior, persistence, validation, busy/blocked failures, capability compatibility, and manual daemon restart.
- Create: `.changeset/composer-session-model-policy.md` — patch-level user-facing release note.

## Task 1: Define Shared Session-Policy Contracts and Dedicated Capability

**Files:**
- Modify: `src/shared/apiTypes.ts`
- Modify: `src/shared/capabilities.ts`
- Modify: `src/shared/capabilities.test.ts`

**Consumes:** Existing `TierModelRef`, `ModelTier`, `ModelTierModelOption`, `SessionStatus`, `PI_WEBUI_CAPABILITIES`, and the two-component effective-capability model.

**Produces:** Shared `ExactModelSelection`, `SessionModelPolicy`, `SessionModelPolicyUpdate`, `SessionModelPolicyResponse`, `ClientSessionModelPolicyStatus`, and `PI_WEBUI_CAPABILITIES.sessionsModelPolicy` for every subsequent task.

- [ ] **Step 1: Add failing capability-negotiation tests.**

  Add cases to `src/shared/capabilities.test.ts` that construct web/session-daemon component snapshots and assert all three outcomes:

  ```ts
  expect(effectivePiWebUiCapabilities({
    web: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsModelPolicy] },
    sessiond: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsModelPolicy] },
  })).toContain(PI_WEBUI_CAPABILITIES.sessionsModelPolicy);

  expect(effectivePiWebUiCapabilities({
    web: { available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsModelPolicy] },
    sessiond: { available: true, capabilities: [] },
  })).not.toContain(PI_WEBUI_CAPABILITIES.sessionsModelPolicy);

  expect(parseKnownPiWebUiCapabilities(["sessions.modelPolicy", "unknown.capability"]))
    .toEqual([PI_WEBUI_CAPABILITIES.sessionsModelPolicy]);
  ```

- [ ] **Step 2: Run the focused capability test and confirm the new key is absent.**

  Run: `npm test -- --run src/shared/capabilities.test.ts`

  Expected: FAIL because `sessionsModelPolicy` does not yet exist and cannot enter the effective capability set.

- [ ] **Step 3: Add the shared domain and wire contracts.**

  In `src/shared/apiTypes.ts`, place the domain values beside the existing model-tier values. Use this exact shape, retaining the optional remembered tier in Exact mode:

  ```ts
  export interface ExactModelSelection {
    model: TierModelRef;
    thinkingLevel: string;
  }

  export type SessionModelPolicyMode = "exact" | "tiered";

  export interface SessionModelPolicy {
    mode: SessionModelPolicyMode;
    exact: ExactModelSelection;
    /** Remembered after the first Tiered choice, including while Exact is active. */
    tier?: ModelTier;
  }

  export type SessionModelPolicyUpdate =
    | { mode: "exact"; exact: ExactModelSelection }
    | { mode: "tiered"; tier: ModelTier };

  export interface ClientSessionModelPolicyStatus {
    mode: SessionModelPolicyMode;
    tier?: ModelTier;
    /** The tuple last confirmed by the policy runtime adapter in this staged slice. */
    resolved: ExactModelSelection;
    ladderValid: boolean;
    blockedReason?: string;
  }

  export interface SessionModelPolicyResponse {
    contractVersion: 1;
    /** Omitted only when the newest persisted entry is malformed and requires repair. */
    policy?: SessionModelPolicy;
    session: SessionStatus;
  }
  ```

  Add `modelPolicy?: ClientSessionModelPolicyStatus` to `SessionStatus`. Add `sessionsModelPolicy: "sessions.modelPolicy"` to `PI_WEBUI_CAPABILITIES`; retain every existing key unchanged.

  In `src/shared/capabilities.ts`, add that capability to both `WEB_RUNTIME_CAPABILITIES` and `SESSIOND_RUNTIME_CAPABILITIES`, and give it `['web', 'sessiond']` in `EFFECTIVE_CAPABILITY_REQUIREMENTS`. Do not use either selected-machine-settings capability as a compatibility fallback.

- [ ] **Step 4: Run shared type and capability tests.**

  Run:

  ```bash
  npm test -- --run src/shared/capabilities.test.ts
  npm run typecheck
  ```

  Expected: PASS. `sessions.modelPolicy` is known, but it is effective only when both components advertise it.

- [ ] **Step 5: Commit the shared contract seam.**

  ```bash
  git add src/shared/apiTypes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts
  git commit -m "feat: add session model policy contracts"
  ```

## Task 2: Build the Pure Versioned Session-Policy Domain Module

**Files:**
- Create: `src/server/sessions/sessionModelPolicy.ts`
- Create: `src/server/sessions/sessionModelPolicy.test.ts`

**Consumes:** `ExactModelSelection`, `SessionModelPolicy`, `SessionModelPolicyUpdate`, `ModelTier`, and session-manager branch entries supplied as `readonly unknown[]`.

**Produces:** `SESSION_MODEL_POLICY_CUSTOM_TYPE`, `inspectSessionModelPolicy`, `serializeSessionModelPolicy`, `planSessionModelPolicyUpdate`, and typed inspection/plan values used by `PiSessionService`.

- [ ] **Step 1: Write failing pure tests for persistence authority and branch transitions.**

  Create a small fixture helper that wraps custom data in the Pi entry envelope:

  ```ts
  function policyEntry(data: unknown): unknown {
    return { type: "custom", customType: SESSION_MODEL_POLICY_CUSTOM_TYPE, data };
  }

  const fallback: ExactModelSelection = {
    model: { provider: "openai", id: "gpt-default" },
    thinkingLevel: "medium",
  };
  ```

  Cover these observable behaviors:

  ```ts
  expect(inspectSessionModelPolicy([], fallback)).toEqual({
    kind: "legacy",
    policy: { mode: "exact", exact: fallback },
  });

  expect(inspectSessionModelPolicy([
    policyEntry(serializeSessionModelPolicy({ mode: "exact", exact: fallback })),
    policyEntry({ version: 99 }),
  ], fallback)).toMatchObject({ kind: "invalid" });

  const plan = planSessionModelPolicyUpdate(
    { mode: "exact", exact: fallback },
    { mode: "tiered", tier: "advanced" },
    (tier) => ({ model: { provider: "openai", id: `gpt-${tier}` }, thinkingLevel: "high" }),
  );
  expect(plan).toEqual({
    policy: { mode: "tiered", exact: fallback, tier: "advanced" },
    target: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
  });
  ```

  Add tests proving reverse-order authority, rejected missing-tier tiered policy, strict version-one serialization, exact-update preservation of a remembered tier, and propagation of a resolver failure without a fallback.

- [ ] **Step 2: Run the pure test before implementing the module.**

  Run: `npm test -- --run src/server/sessions/sessionModelPolicy.test.ts`

  Expected: FAIL because the module and exports do not exist.

- [ ] **Step 3: Implement entry inspection and transition planning with no runtime dependencies.**

  Implement these public types and functions:

  ```ts
  export const SESSION_MODEL_POLICY_CUSTOM_TYPE = "pi-webui.model-policy";

  export type SessionModelPolicyInspection =
    | { kind: "legacy"; policy: SessionModelPolicy }
    | { kind: "persisted"; policy: SessionModelPolicy }
    | { kind: "invalid"; reason: string; fallback: SessionModelPolicy };

  export interface SessionModelPolicyPlan {
    policy: SessionModelPolicy;
    target: ExactModelSelection;
  }

  export function inspectSessionModelPolicy(
    entries: readonly unknown[],
    fallback: ExactModelSelection,
  ): SessionModelPolicyInspection;

  export function serializeSessionModelPolicy(policy: SessionModelPolicy): Record<string, unknown>;

  export function planSessionModelPolicyUpdate(
    current: SessionModelPolicy,
    update: SessionModelPolicyUpdate,
    resolveTier: (tier: ModelTier) => ExactModelSelection,
  ): SessionModelPolicyPlan;
  ```

  `inspectSessionModelPolicy` must iterate from `entries.length - 1` down to zero. Ignore non-policy entries. Once it sees the newest matching `customType`, parse only that entry: return `{ kind: 'invalid' }` on malformed data, unsupported version, blank provider/id/thinking level, an extra/unknown data key, or a Tiered policy without a canonical tier. Do not continue scanning after that invalid entry.

  `serializeSessionModelPolicy` must write exactly `{ version: 1, mode, exact: { model: { provider, id }, thinkingLevel }, tier? }` and clone caller-owned nested objects. `planSessionModelPolicyUpdate` must preserve `current.exact` when entering/changing Tiered mode and preserve `current.tier` when applying Exact mode; it delegates only Tiered target resolution to its injected resolver.

- [ ] **Step 4: Run the pure suite and lint the new module.**

  Run:

  ```bash
  npm test -- --run src/server/sessions/sessionModelPolicy.test.ts
  npx eslint src/server/sessions/sessionModelPolicy.ts src/server/sessions/sessionModelPolicy.test.ts
  ```

  Expected: PASS. The test for a malformed newest entry proves no older valid policy is revived.

- [ ] **Step 5: Commit the domain boundary.**

  ```bash
  git add src/server/sessions/sessionModelPolicy.ts src/server/sessions/sessionModelPolicy.test.ts
  git commit -m "feat: add persisted session model policy domain"
  ```

## Task 3: Hydrate Policy State, Initialize Root Sessions, and Project It in Status

**Files:**
- Modify: `src/server/sessions/modelTierRegistry.ts`
- Modify: `src/server/sessions/modelTierRegistry.test.ts`
- Modify: `src/server/sessions/piSessionService.ts`
- Modify: `src/server/sessions/sessionService.ts`
- Create: `src/server/sessions/piSessionService.modelPolicy.test.ts`

**Consumes:** Task 1 contracts, Task 2 pure inspection, `PiSessionService.create()`, `startSession()`, active-session rebind callbacks, `statusFromSession()`, and Pi session custom entries.

**Produces:** A root-session creation seam that persists a default Exact policy before `session.created`/initial prompts, an active-session inspection cache, `SessionStatus.modelPolicy`, and `PiSessionService.modelPolicy()` inspection for the route layer.

- [ ] **Step 1: Create failing service-harness tests for lifecycle behavior.**

  Build `createModelPolicyHarness()` in the new test file around the existing `PiSessionService` dependency-injection seams. Its fake session must expose:

  ```ts
  model: { provider: "openai", id: "gpt-default" },
  thinkingLevel: "medium",
  sessionManager: {
    getBranch: vi.fn(() => []),
    appendCustomEntry: vi.fn(),
  },
  setModel: vi.fn(async () => undefined),
  setThinkingLevel: vi.fn(),
  getAvailableThinkingLevels: vi.fn(() => ["off", "medium", "high"]),
  ```

  Add assertions for:

  1. `service.start(cwd)` writes one `pi-webui.model-policy` version-one Exact entry using the newly created runtime’s resolved tuple before the test calls `service.prompt()`.
  2. A reopen whose branch contains the latest persisted Tiered entry projects `status.modelPolicy` with `mode: 'tiered'`, its remembered tier, the runtime’s resolved tuple, and no policy fallback.
  3. A reopen whose latest matching entry is malformed exposes `blockedReason` and does not select an older entry as `policy` in `service.modelPolicy(ref)`.
  4. A new root with no explicit policy writes exactly one default Exact entry before the session-created event is published.

- [ ] **Step 2: Run the lifecycle tests to establish the missing behavior.**

  Run: `npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts`

  Expected: FAIL because `PiSessionService` has no model-policy lifecycle state or public methods.

- [ ] **Step 3: Expose full-ladder validity from the existing registry.**

  Extend `ModelTierRegistry` in `src/server/sessions/modelTierRegistry.ts` with:

  ```ts
  export interface ModelTierRegistry<TModel extends { provider: string; id: string }> {
    resolve(tier: ModelTier): ResolvedRuntimeTier<TModel>;
    validate(): LadderValidation;
  }
  ```

  Make `createModelTierRegistry(...).validate()` reread `loadConfig()` and return `{ valid: false, reason }` for `modelTiersError`, a missing ladder, or `validateLadder(...)` failure against the current model snapshot/supported-thinking callback. It must not cache an older valid file after an invalid external edit. Add focused `modelTierRegistry.test.ts` cases for missing config, externally invalid config, unavailable configured model, and a complete valid ladder.

  Run: `npm test -- --run src/server/sessions/modelTierRegistry.test.ts`

  Expected: PASS. `PiSessionService` can now report full Tiered availability without reaching into registry internals or duplicating global-config parsing.

- [ ] **Step 4: Add the inspection route-service signature and root-only default initialization option.**

  In `src/server/sessions/sessionService.ts`, extend the route-service contract with:

  ```ts
  modelPolicy(ref: SessionRouteLookup): Promise<SessionModelPolicyResponse>;
  ```

  Keep the existing public `start(cwd)` signature in this task. In `piSessionService.ts`, keep `startSession()` private and add an internal `initializeDefaultModelPolicy?: true` option:

  - browser-root `start(cwd)` passes `initializeDefaultModelPolicy: true`;
  - `spawnSession()` and `spawnSubsession()` call private `startSession()` with no initializer in this staged plan;
  - the initializer derives and persists the runtime’s actual Exact tuple only; it does not yet accept an explicit Tiered request.

- [ ] **Step 5: Add one bounded policy cache at the daemon lifecycle boundary.**

  Add private `WeakMap<PiAgentSession, SessionModelPolicyInspection>`, `WeakMap<PiAgentSession, LadderValidation>`, and `WeakMap<PiAgentSession, string>` fields to `PiSessionService` for inspection, last-inspected ladder validity, and blocked reasons. Add focused private methods with these responsibilities:

  ```ts
  private exactSelectionFromSession(session: PiAgentSession): ExactModelSelection;
  private inspectAndCacheSessionModelPolicy(session: PiAgentSession): SessionModelPolicyInspection;
  private modelPolicyStatusFromSession(session: PiAgentSession): ClientSessionModelPolicyStatus;
  private policyEntries(session: PiAgentSession): readonly unknown[];
  ```

  `exactSelectionFromSession()` must require a nonempty runtime model provider/id and thinking level; for a newly created root, absence is a startup error rather than an incomplete persisted policy. `policyEntries()` must use `session.sessionManager.getEntries?.() ?? session.sessionManager.getBranch()`. `inspectAndCacheSessionModelPolicy()` must call the Task 2 inspector against the actual runtime exact selection and cache `this.modelTierRegistry.validate()` beside it. It must refresh both caches once on create/rebind, explicit policy GET, and after every successful local policy-entry append; it must not rescan the branch or reread global configuration from `statusFromSession()` on every streaming token.

  On a malformed persisted entry, cache `{ kind: 'invalid' }`, save its clear reason in the blocked map, and return a status projection using the current runtime tuple only as a **display value** plus `blockedReason`. Do not treat that display tuple as an executable replacement for the malformed persisted intent.

- [ ] **Step 6: Initialize/hydrate at the existing runtime lifecycle points.**

  In `create()`:

  1. inspect and cache the opened session policy after the runtime exists;
  2. when `initializeDefaultModelPolicy` is set, append a version-one Exact entry derived from the runtime’s current selection after the session is active but before the first `publishStatus()`;
  3. call the same inspection helper in `runtime.setRebindSession(...)` before rebinding/publishing the replacement runtime’s status;
  4. let default-entry initialization errors enter `create()`’s existing catch/cleanup path rather than leaving a half-created active session.

  The root initializer must require `appendCustomEntry` and throw if persistence is unavailable or fails. It must append only the runtime-derived Exact policy in this task. Explicit Exact/Tiered transitions and their atomic runtime adapter arrive in Task 4.

  Add `modelPolicy: this.modelPolicyStatusFromSession(session)` to `statusFromSession()`. Read `ladderValid` from the cached `LadderValidation`; Exact sessions remain usable when it is false, while the status clearly reports that Tiered selection is unavailable.

- [ ] **Step 7: Return a typed inspection response without duplicating model catalog transport.**

  Implement `modelPolicy(ref)` to open the session, refresh the inspection/ladder cache for that explicit request, then return:

  ```ts
  {
    contractVersion: 1,
    ...(inspection.kind === "invalid" ? {} : { policy: inspection.policy }),
    session: this.statusFromSession(session),
  }
  ```

  The browser will load the selectable model/tier catalog through the already-existing selected-machine `modelTiersApi.settings()` resource. Do not create a second catalog route or embed a high-churn model list in session status.

- [ ] **Step 8: Run lifecycle tests and focused existing service tests.**

  Run:

  ```bash
  npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts
  npm test -- --run src/server/sessions/piSessionService.spawnSession.test.ts src/server/sessions/piSessionService.spawnSubsession.test.ts
  npm run typecheck
  ```

  Expected: PASS. Existing tool-created sessions retain their current behavior because this task initializes policy only for the browser root-start path.

- [ ] **Step 9: Commit lifecycle and status projection.**

  ```bash
  git add src/server/sessions/modelTierRegistry.ts src/server/sessions/modelTierRegistry.test.ts src/server/sessions/piSessionService.ts src/server/sessions/sessionService.ts src/server/sessions/piSessionService.modelPolicy.test.ts
  git commit -m "feat: persist model policy for root sessions"
  ```

## Task 4: Add the Atomic Policy Runtime Adapter and Exact-Mode Mutation Synchronization

**Files:**
- Modify: `src/server/sessions/piSessionService.ts`
- Modify: `src/server/sessions/sessionService.ts`
- Modify: `src/server/sessions/piSessionService.modelPolicy.test.ts`

**Consumes:** Task 2 transition plans, Task 3 lifecycle/cache/status support, existing `ModelTierRegistry`, `runSessionEntryMutation`, `assertWritable`, `assertTreeNavigationInactive`, and existing exact model/thinking methods.

**Produces:** `PiSessionService.setModelPolicy()`, strict model-then-thinking application/restoration, typed Tiered root creation, blocked-prompt protection, server-side idle guards, and exact-route policy synchronization.

- [ ] **Step 1: Add failing tests for ordering, validation, restore, and mode guards.**

  Extend the harness to record operations in an array. Add these exact assertions:

  ```ts
  await service.setModelPolicy(ref, { mode: "tiered", tier: "advanced" });
  expect(calls).toEqual([
    "setModel:openai/gpt-advanced",
    "setThinkingLevel:high",
    "appendCustomEntry:pi-webui.model-policy",
  ]);

  await expect(service.setModelPolicy(ref, { mode: "tiered", tier: "advanced" }))
    .rejects.toThrow(/unsupported by openai\/gpt-advanced/i);
  expect(calls).toEqual([]);
  ```

  Add cases proving all of the following:

  - `service.start(cwd, { modelPolicy: { mode: "tiered", tier: "advanced" } })` preserves the runtime’s original tuple as `policy.exact`, applies the resolved advanced tuple in model-then-thinking order, appends the Tiered policy before `session.created`, and completes before a following `service.prompt()` can reach Pi;
  - an append failure restores the original model and thinking pair before rejecting;
  - an unrecoverable restoration failure adds `blockedReason`, and `prompt()` rejects with that reason without calling `session.prompt()`;
  - an archived or active-work session rejects policy mutation before setters run;
  - `setModel`, `cycleModel`, `setThinkingLevel`, and `cycleThinkingLevel` reject with a clear Tiered-mode error while Tiered is active;
  - successful Exact model/cycle/thinking operations append an updated policy whose `exact` equals the session’s confirmed effective tuple, including Pi’s normal model-selection clamp behavior;
  - a successful explicit Exact policy update clears a prior blocked reason and replaces an invalid latest entry with a valid new authoritative entry.

- [ ] **Step 2: Run the focused runtime test and verify failures are red.**

  Run: `npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts`

  Expected: FAIL on missing `setModelPolicy`, no setter ordering, and unguarded existing exact mutations.

- [ ] **Step 3: Extend the public root-start contract and implement a single policy mutation guard.**

  In `src/server/sessions/sessionService.ts`, change the route-facing start signature to:

  ```ts
  start(cwd: string, options?: { modelPolicy?: SessionModelPolicyUpdate }): Promise<ClientSession>;
  ```

  In `piSessionService.ts`, mirror that optional object on public `start()`. Replace the Task 3 internal boolean with `initializeModelPolicy?: true | SessionModelPolicyUpdate`: browser-root `start(cwd)` passes `true`; browser-root `start(cwd, { modelPolicy })` passes the supplied union; `spawnSession()` and `spawnSubsession()` continue to omit it. Keep tool-child inheritance out of this task.

  Add private helpers with explicit boundaries:

  ```ts
  private assertModelPolicyMutationIdle(session: PiAgentSession, action: string): void;
  private async resolveAvailableExactSelection(
    session: PiAgentSession,
    selection: ExactModelSelection,
  ): Promise<{ model: AgentModel; selection: ExactModelSelection }>;
  private async applyExactSelection(
    session: PiAgentSession,
    target: { model: AgentModel; selection: ExactModelSelection },
  ): Promise<void>;
  private async restoreExactSelection(session: PiAgentSession, previous: ExactModelSelection): Promise<boolean>;
  private appendSessionModelPolicy(session: PiAgentSession, policy: SessionModelPolicy): void;
  ```

  `assertModelPolicyMutationIdle` must reject when `hasActiveWork(session)` is true and when tree navigation is active. Call `assertWritable(ref)` before obtaining the runtime. `resolveAvailableExactSelection` must refresh the session model runtime with `{ allowNetwork: false }`, limit candidates to scoped models when a scope exists, find provider/id exactly, and check the target thinking string against `runtimeThinkingLevels(targetModel)` before any setter runs.

- [ ] **Step 4: Apply policy changes atomically under the existing serialized mutation seam.**

  Implement root initialization and `setModelPolicy(ref, update)` in this sequence:

  1. for a root initializer, capture the just-created runtime exact selection as its `current` policy; for an active route, assert writable/idle and open the session, refresh its inspection/ladder cache, then read the inspection;
  2. if an active inspection is malformed, use its `fallback` only to construct a new explicit update, never as a silent execution path;
  3. use `planSessionModelPolicyUpdate`; resolve a Tiered target with `this.modelTierRegistry.resolve(tier)` and convert it to `ExactModelSelection`;
  4. validate the full target with `resolveAvailableExactSelection`;
  5. inside one `runSessionEntryMutation(session, 'change session model policy', ...)`, snapshot the prior exact tuple, call `await session.setModel(model)`, then `session.setThinkingLevel(level)`, and verify `exactSelectionFromSession(session)` equals the target;
  6. append the versioned policy entry only after verification; update the cache only after append succeeds;
  7. if any step after the first setter fails, call `restoreExactSelection`; if it returns false, set a deterministic `MODEL_POLICY_BLOCKED: <reason>` message in the blocked map;
  8. on success, clear the blocked map, publish one confirmed activity/status update, and return `modelPolicy(ref)` for active routes. For root initialization, finish before `startSession()` emits `session.created` and returns to the caller.

  Do not publish success between the setters or before persistence. Do not accept Pi’s silent thinking clamp as success: a mismatched verified tuple is a failed transition.

- [ ] **Step 5: Synchronize the existing Exact model/thinking methods.**

  At the start of `setModel`, `cycleModel`, `setThinkingLevel`, and `cycleThinkingLevel`, refresh the inspection cache, then reject if the authoritative policy is Tiered or the session is blocked. Apply the same writable/idle guard.

  After the existing route’s model/thinking operation succeeds, build a new policy with:

  ```ts
  {
    mode: "exact",
    exact: this.exactSelectionFromSession(session),
    ...(currentPolicy.tier === undefined ? {} : { tier: currentPolicy.tier }),
  }
  ```

  Append/cache that policy inside the same serialized mutation lifecycle. If the append fails, restore the pre-route tuple and use the same blocked fallback when restoration cannot be proven. This deliberately records Pi’s actual confirmed pair for ordinary Exact selection/cycle behavior instead of inventing a silent target-thinking replacement.

  Add `assertPromptModelPolicyAllowed(session)` that refreshes the policy-entry inspection cache, rejects a malformed authoritative newest entry, and rejects a blocked-runtime reason. Call it in `prompt()` after `getOrOpen(ref)` and before queue/submit logic so the browser receives a normal route error. Call it again at the beginning of `submitPrompt()` before activity publication or `session.prompt()` so a prompt held in the existing compaction queue cannot bypass a policy entry that became invalid while it waited. This is only a restoration/corrupt-policy safety block in this staged slice; do not add request-boundary tier remapping or directive behavior.

- [ ] **Step 6: Run all model and prompt-queue regressions.**

  Run:

  ```bash
  npm test -- --run src/server/sessions/piSessionService.modelPolicy.test.ts
  npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/piSessionService.tree.test.ts
  npm run typecheck
  ```

  Expected: PASS. No provider-facing prompt can run after an unproven restoration, and existing compaction queue semantics are unchanged.

- [ ] **Step 7: Commit the runtime adapter.**

  ```bash
  git add src/server/sessions/piSessionService.ts src/server/sessions/sessionService.ts src/server/sessions/piSessionService.modelPolicy.test.ts
  git commit -m "feat: apply session model policy atomically"
  ```

## Task 5: Expose Strict Start and Active-Session Policy Routes Through Federation

**Files:**
- Modify: `src/server/sessions/sessionRoutes.ts`
- Modify: `src/server/sessions/sessionRoutes.test.ts`
- Modify: `src/shared/federatedRoutes.ts`
- Modify: `src/client/src/api/federatedRouteContract.test.ts`

**Consumes:** Task 1 policy update types and Task 3/4 `SessionRouteService` methods; existing `sessionLookupFromQuery`, `sessionLookupFromBody`, `mutationErrorStatus`, and federated route specifications.

**Produces:** Additive `POST /sessions` input, `GET /sessions/:sessionId/model-policy`, and `PUT /sessions/:sessionId/model-policy` that local and selected remote machines can forward safely.

- [ ] **Step 1: Write route contract tests before adding parsers.**

  Add Fastify tests that assert:

  ```ts
  await app.inject({
    method: "POST",
    url: "/sessions",
    payload: { cwd: "/work", modelPolicy: { mode: "tiered", tier: "advanced" } },
  });
  expect(service.start).toHaveBeenCalledWith("/work", {
    modelPolicy: { mode: "tiered", tier: "advanced" },
  });

  await app.inject({
    method: "PUT",
    url: "/sessions/s-1/model-policy",
    payload: {
      cwd: "/work",
      policy: {
        mode: "exact",
        exact: { model: { provider: "openai", id: "org/gpt" }, thinkingLevel: "high" },
      },
    },
  });
  ```

  Add negative requests for a missing `cwd`, an unknown root body key, partial exact selections, a Tiered payload without `tier`, an Exact payload with `tier`, unknown tier values, and an unknown policy field. Assert `400` with a meaningful error and no service call. Add GET coverage proving the `cwd` query becomes the service lookup.

- [ ] **Step 2: Run the route test to verify the endpoints do not exist.**

  Run: `npm test -- --run src/server/sessions/sessionRoutes.test.ts`

  Expected: FAIL for absent endpoints and unsupported start options.

- [ ] **Step 3: Add strict route-boundary parsers.**

  In `sessionRoutes.ts`, add private route helpers that parse the exact discriminated union rather than casting request JSON:

  ```ts
  function sessionModelPolicyUpdateFromUnknown(value: unknown): SessionModelPolicyUpdate;
  function exactModelSelectionFromUnknown(value: unknown): ExactModelSelection;
  function tierFromUnknown(value: unknown): ModelTier;
  ```

  Require plain records, reject unknown keys at each nested level, require bounded nonempty provider/model/thinking strings, and validate the tier against `MODEL_TIERS`. Use `{ cwd, modelPolicy? }` for `POST /sessions`; use `{ cwd, policy }` for the PUT body so `cwd` cannot be confused with a policy field.

  Register:

  ```ts
  app.get(`${prefix}/sessions/:sessionId/model-policy`, ...);
  app.put(`${prefix}/sessions/:sessionId/model-policy`, ...);
  ```

  GET uses `sessionLookupFromQuery`. PUT uses `sessionLookupFromBody` and maps operational mutation errors through `mutationErrorStatus`, matching the existing model/thinking mutation family.

- [ ] **Step 4: Add the federated route declarations.**

  Put these entries beside the existing session model/thinking paths in `FEDERATED_HTTP_ROUTES`:

  ```ts
  { method: "GET", path: "/sessions/:sessionId/model-policy" },
  { method: "PUT", path: "/sessions/:sessionId/model-policy" },
  ```

  Add `federatedRouteContract.test.ts` assertions for exactly those method/path pairs. Do not add explicit session-proxy registration: `src/server/sessiond/sessionProxyRoutes.ts` already accepts `/api/sessions/*` for every method and strips `/api` exactly once.

- [ ] **Step 5: Run route and federation verification.**

  Run:

  ```bash
  npm test -- --run src/server/sessions/sessionRoutes.test.ts
  npm test -- --run src/client/src/api/federatedRouteContract.test.ts
  npx eslint src/server/sessions/sessionRoutes.ts src/shared/federatedRoutes.ts
  ```

  Expected: PASS. A malformed client cannot reach the service with a partial policy, and remote forwarding recognizes the new additive paths.

- [ ] **Step 6: Commit the HTTP/protocol contract.**

  ```bash
  git add src/server/sessions/sessionRoutes.ts src/server/sessions/sessionRoutes.test.ts src/shared/federatedRoutes.ts src/client/src/api/federatedRouteContract.test.ts
  git commit -m "feat: expose session model policy routes"
  ```

## Task 6: Parse and Call the Additive Browser API Contracts

**Files:**
- Modify: `src/client/src/api/parsers.ts`
- Modify: `src/client/src/api/clients.ts`
- Modify: `src/client/src/api/clients.test.ts`
- Modify: `src/client/src/api/parsers.test.ts`

**Consumes:** Task 1 shared response/update types and Task 5 HTTP shapes; existing `request`, `sessionQueryPath`, `sessionPath`, `sessionBody`, `machinePrefix`, and `parseSessionStatus` helpers.

**Produces:** `sessionsApi.startSession(..., modelPolicy?)`, `sessionsApi.modelPolicy(...)`, and `sessionsApi.setModelPolicy(...)`, all returning strictly parsed values.

- [ ] **Step 1: Add failing parser tests for valid and hostile policy payloads.**

  In `parsers.test.ts`, add a valid response fixture:

  ```ts
  const value = {
    contractVersion: 1,
    policy: {
      mode: "tiered",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
      tier: "advanced",
    },
    session: {
      sessionId: "s-1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      modelPolicy: {
        mode: "tiered",
        tier: "advanced",
        resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
        ladderValid: true,
      },
    },
  };
  ```

  Assert that `parseSessionModelPolicyResponse(value)` retains all fields. Add rejection tests for contract version 2, unexpected response/policy/status/exact keys, a missing Tiered tier, an Exact policy containing a tier, and a malformed optional `SessionStatus.modelPolicy`.

- [ ] **Step 2: Run parser tests before implementation.**

  Run: `npm test -- --run src/client/src/api/parsers.test.ts`

  Expected: FAIL because the parser is missing and `parseSessionStatus` ignores the new status field.

- [ ] **Step 3: Implement strict parsers and extend status parsing.**

  Add private helpers in `parsers.ts` that mirror the server’s discriminated union:

  ```ts
  function parseExactModelSelection(value: unknown): ExactModelSelection;
  function parseSessionModelPolicy(value: unknown): SessionModelPolicy;
  function parseClientSessionModelPolicyStatus(value: unknown): ClientSessionModelPolicyStatus;
  export function parseSessionModelPolicyResponse(value: unknown): SessionModelPolicyResponse;
  ```

  Reuse existing primitive parsers and reject unknown keys. `parseSessionModelPolicyResponse` requires `contractVersion === 1`, requires `session` through `parseSessionStatus`, and permits omitted `policy` only for the server’s explicit blocked/corrupt-entry repair case. Extend `parseSessionStatus` with `optionalField('modelPolicy', ...)` so websocket status updates parse the additive field safely.

- [ ] **Step 4: Add the API client methods without raw URL construction.**

  Change the start method signature and body assembly to:

  ```ts
  startSession: (cwd: string, machineId = "local", modelPolicy?: SessionModelPolicyUpdate) =>
    request(`${machinePrefix(machineId)}/sessions`, parseSessionInfo, {
      method: "POST",
      body: JSON.stringify({ cwd, ...(modelPolicy === undefined ? {} : { modelPolicy }) }),
    }),
  ```

  Add these session-scoped methods beside the existing model/thinking operations:

  ```ts
  modelPolicy: (session: SessionLookup, machineId = "local") =>
    request(sessionQueryPath(session, "model-policy", machineId), parseSessionModelPolicyResponse),

  setModelPolicy: (session: SessionLookup, policy: SessionModelPolicyUpdate, machineId = "local") =>
    request(sessionPath(session, "model-policy", machineId), parseSessionModelPolicyResponse, {
      method: "PUT",
      body: sessionBody(session, { policy }),
    }),
  ```

  Preserve `cwd` in a PUT body through `sessionBody`; retain `encodeURIComponent` through the existing path helpers.

- [ ] **Step 5: Add client request assertions and run focused API tests.**

  In `clients.test.ts`, mock `request`/fetch and assert a nested-deployment-safe request path such as:

  ```ts
  expect(requestUrl).toBe("api/machines/remote%2Fone/sessions/s%2F1/model-policy?cwd=%2Fwork%20tree");
  expect(requestInit).toMatchObject({ method: "PUT" });
  expect(JSON.parse(String(requestInit?.body))).toEqual({
    cwd: "/work tree",
    policy: { mode: "tiered", tier: "advanced" },
  });
  ```

  Add a start-session assertion proving omitted policy keeps the legacy `{ cwd }` body, while a tiered starter request adds exactly one `modelPolicy` field.

  Run:

  ```bash
  npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
  npm run typecheck
  ```

  Expected: PASS. Older status payloads without `modelPolicy` still parse.

- [ ] **Step 6: Commit the browser API seam.**

  ```bash
  git add src/client/src/api/parsers.ts src/client/src/api/clients.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
  git commit -m "feat: add browser session model policy api"
  ```

## Task 7: Give SessionController Confirmed Selected-Session Policy State

**Files:**
- Modify: `src/client/src/appState.ts`
- Modify: `src/client/src/controllers/sessionController.ts`
- Create: `src/client/src/controllers/sessionController.modelPolicy.test.ts`

**Consumes:** Task 6 API methods and response parser; existing `selectionSeq`, `isCurrentSessionSelection`, `applyStatus`, selected-session lifecycle, and pending-start machinery.

**Produces:** Controller-owned `loadModelPolicy()` and `saveModelPolicy()` methods, stale-safe AppState fields, and starter creation that snapshots an optional typed policy before the async session request begins.

- [ ] **Step 1: Add AppState fields and a failing controller harness test.**

  Add these fields near the existing selected-session UI state:

  ```ts
  modelPolicy: SessionModelPolicyResponse | undefined;
  isLoadingModelPolicy: boolean;
  isSavingModelPolicy: boolean;
  modelPolicyError: string | undefined;
  ```

  Initialize them in `initialAppState()`.

  In `sessionController.modelPolicy.test.ts`, construct the existing controller test harness with fake `api.modelPolicy` and `api.setModelPolicy`. Cover:

  ```ts
  await controller.loadModelPolicy();
  expect(api.modelPolicy).toHaveBeenCalledWith({ id: "s-1", cwd: "/work" }, "remote");
  expect(state.modelPolicy?.policy?.mode).toBe("tiered");
  expect(state.status?.modelPolicy?.tier).toBe("advanced");
  ```

  Also cover a save that applies the returned full `SessionStatus`, a stale GET resolving after a selection change without writing selected-session state, a stale save error that does not overwrite a newly selected session’s error, and clearing policy state when deselecting/selecting a different session.

- [ ] **Step 2: Run the new controller test before implementation.**

  Run: `npm test -- --run src/client/src/controllers/sessionController.modelPolicy.test.ts`

  Expected: FAIL because the controller has no policy methods or state contract.

- [ ] **Step 3: Add selected-session load/save methods with the established sequence guard.**

  Implement:

  ```ts
  async loadModelPolicy(): Promise<void>;
  async saveModelPolicy(update: SessionModelPolicyUpdate): Promise<void>;
  ```

  Each method must:

  1. reject/no-op when no selected session exists, it is archived, or it is a client-pending start;
  2. capture `session.id`, `cwd`, selected `machineId`, and `selectionSeq` before awaiting;
  3. for `loadModelPolicy()`, clear a prior `modelPolicy` response and set loading state only for that selected identity; for `saveModelPolicy()`, retain the currently displayed draft/response while setting saving state;
  4. call `this.api.modelPolicy(session, machineId)` or `this.api.setModelPolicy(session, update, machineId)`;
  5. use `isCurrentSessionSelection(session.id, machineId, selectionSeq)` before every post-await state write;
  6. on success store the confirmed response, clear only this feature’s error, and call `applyStatus(response.session)`;
  7. on error set only `modelPolicyError` for the still-current selection.

  Extract one private `clearSelectedModelPolicyState()` and invoke it wherever selection lifecycle currently increments `selectionSeq` and clears selected-session transient state. Do not leave a prior session’s remembered exact branch visible after a selection/machine change.

- [ ] **Step 4: Thread a starter policy snapshot through pending creation.**

  Change the methods to these explicit signatures:

  ```ts
  async startSession(modelPolicy?: SessionModelPolicyUpdate): Promise<void>;
  async startSessionWithPrompt(
    text: string,
    streamingBehavior?: "steer" | "followUp",
    attachments?: PromptAttachment[],
    delivery: PromptAttachmentDelivery = "inline",
    modelPolicy?: SessionModelPolicyUpdate,
  ): Promise<void>;
  ```

  Capture the optional policy in the `PendingSessionStart` record before `await this.api.startSession(...)`, then call:


  ```ts
  const session = await this.api.startSession(workspace.path, machineId, modelPolicy);
  ```

  Keep queued prompt behavior unchanged: `startSessionWithPrompt()` begins the pending root start, and `send()` places the initial prompt in that pending session’s existing client queue. `resolvePendingSessionStart()` flushes it only after `POST /sessions` resolves. This makes the daemon’s policy initialization complete before the first initial prompt is submitted.

- [ ] **Step 5: Run controller regression coverage.**

  Run:

  ```bash
  npm test -- --run src/client/src/controllers/sessionController.modelPolicy.test.ts
  npm test -- --run src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.sendQueue.test.ts
  npm run typecheck
  ```

  Expected: PASS. A late remote response cannot mutate the current composer after selection has changed.

- [ ] **Step 6: Commit controller orchestration.**

  ```bash
  git add src/client/src/appState.ts src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.modelPolicy.test.ts
  git commit -m "feat: manage selected session model policy state"
  ```

## Task 8: Build a Pure Composer Policy Draft Module

**Files:**
- Create: `src/client/src/components/sessionModelPolicyDraft.ts`
- Create: `src/client/src/components/sessionModelPolicyDraft.test.ts`

**Consumes:** Shared policy types and the existing `ModelTierSettingsResponse` catalog/row-validation model.

**Produces:** Framework-free draft transitions used identically by the active and starter composer control.

- [ ] **Step 1: Write failing pure draft tests.**

  Build a catalog fixture with a complete valid ladder and two models with distinct supported thinking levels. Add tests for:

  ```ts
  const exact = { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" };
  const initial = modelPolicyDraftFromPolicy({ mode: "exact", exact });

  expect(selectDraftTier(initial, "advanced")).toEqual({
    mode: "tiered",
    exact,
    tier: "advanced",
  });

  expect(selectDraftExact(selectDraftTier(initial, "advanced"))).toEqual({
    mode: "exact",
    exact,
    tier: "advanced",
  });
  ```

  Add cases proving an unsupported repaired thinking level is cleared rather than clamped when selecting a new exact model, incomplete/stale exact draft cannot form an Exact update, a missing/invalid ladder cannot form a Tiered update, and an Exact draft preserves a remembered tier.

- [ ] **Step 2: Run the pure test before implementation.**

  Run: `npm test -- --run src/client/src/components/sessionModelPolicyDraft.test.ts`

  Expected: FAIL because the draft module is absent.

- [ ] **Step 3: Implement the small, immutable draft API.**

  Export these deliberately narrow values/functions:

  ```ts
  export interface SessionModelPolicyDraft {
    mode: "exact" | "tiered";
    exact: ExactModelSelection;
    tier?: ModelTier;
  }

  export function modelPolicyDraftFromPolicy(policy: SessionModelPolicy): SessionModelPolicyDraft;
  export function selectDraftTier(draft: SessionModelPolicyDraft, tier: ModelTier): SessionModelPolicyDraft;
  export function selectDraftExact(draft: SessionModelPolicyDraft): SessionModelPolicyDraft;
  export function updateDraftExactModel(
    draft: SessionModelPolicyDraft,
    option: ModelTierModelOption,
  ): SessionModelPolicyDraft;
  export function updateDraftExactThinking(
    draft: SessionModelPolicyDraft,
    thinkingLevel: string,
  ): SessionModelPolicyDraft;
  export function sessionModelPolicyUpdateFromDraft(
    draft: SessionModelPolicyDraft,
    catalog: ModelTierSettingsResponse,
  ): SessionModelPolicyUpdate | undefined;
  ```

  `sessionModelPolicyUpdateFromDraft` validates exact provider/id/thinking against `catalog.models`; validates a Tiered choice by requiring `catalog.valid`, a complete `catalog.ladder`, and a valid row for the selected tier; returns `undefined` rather than throwing for an incomplete browser draft. It returns `{ mode: 'exact', exact }` for Exact and `{ mode: 'tiered', tier }` for Tiered. It must not mutate a supplied draft or catalog.

- [ ] **Step 4: Run and lint the pure module.**

  Run:

  ```bash
  npm test -- --run src/client/src/components/sessionModelPolicyDraft.test.ts
  npx eslint src/client/src/components/sessionModelPolicyDraft.ts src/client/src/components/sessionModelPolicyDraft.test.ts
  ```

  Expected: PASS. Browser draft validation prevents accidental submission but does not replace daemon validation.

- [ ] **Step 5: Commit the browser domain seam.**

  ```bash
  git add src/client/src/components/sessionModelPolicyDraft.ts src/client/src/components/sessionModelPolicyDraft.test.ts
  git commit -m "feat: add composer model policy draft"
  ```

## Task 9: Implement the Accessible, Responsive SessionModelPolicyControl

**Files:**
- Create: `src/client/src/components/SessionModelPolicyControl.ts`
- Create: `src/client/src/components/SessionModelPolicyControl.test.ts`

**Consumes:** Task 8 pure draft functions, `SessionModelPolicyResponse`, `ClientSessionModelPolicyStatus`, `ModelTierSettingsResponse`, and user callbacks supplied by the parent.

**Produces:** A focused Lit component that renders the mode control first, keeps Tiered resolution read-only, provides repair/select UI in a popover or narrow-screen sheet, and never owns HTTP/session state.

- [ ] **Step 1: Define the public component boundary and write failing DOM tests.**

  Give the component this public contract:

  ```ts
  /** Additive live-status projection; sufficient to render the closed trigger. */
  @property({ attribute: false }) status?: ClientSessionModelPolicyStatus;
  /** Fresh GET/PUT inspection result; required before the opened form can save. */
  @property({ attribute: false }) response?: SessionModelPolicyResponse;
  @property({ attribute: false }) catalog?: ModelTierSettingsResponse;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property({ type: Boolean }) editable = false;
  @property() error = "";
  @property({ attribute: false }) onOpen?: () => void;
  @property({ attribute: false }) onSave?: (update: SessionModelPolicyUpdate) => void;
  ```

  Use a lightweight real-DOM/custom-element harness for these tests:

  1. Exact renders an accessible `Session model mode: Exact` trigger before any model/thinking sibling supplied by its host.
  2. Tiered renders `Tiered`, its tier label, and a read-only `→ provider/id · thinking` resolution label; it does not render an editable exact-model control in the compact row.
  3. Opening the control shows visible labels for Mode, Tier, Exact model, and Thinking level as applicable.
  4. A first Tiered selection has no Save action until a valid canonical tier is selected.
  5. Changing an exact repair model clears an incompatible thinking level and disables Save until a compatible value is selected.
  6. Escape closes the panel and restores focus to the trigger; a save error is rendered in an `aria-live="assertive"`/alert region without losing the draft.
  7. `editable = false`, `saving = true`, invalid catalog, and server `blockedReason` make mutation actions disabled while preserving readable current policy/diagnostic text.

- [ ] **Step 2: Run the component suite and confirm it is red.**

  Run: `npm test -- --run src/client/src/components/SessionModelPolicyControl.test.ts`

  Expected: FAIL because the custom element is not registered.

- [ ] **Step 3: Implement a thin Lit rendering/control adapter.**

  Create `@customElement('session-model-policy-control')` with local `@state()` fields only for `open` and `draft`. The closed trigger reads `status` so it remains visible from live websocket status before any GET has completed. In `willUpdate`, rebuild the editable draft from `response.policy` only when a new confirmed response arrives; if `response.policy` is omitted because a malformed entry needs repair, initialize the exact repair draft from `response.session.modelPolicy?.resolved` and keep the server blocked message visible.

  The component must:

  - render its compact trigger as the first internal element, with an explicit `aria-label="Session model mode"` and a visible Exact/Tiered label;
  - invoke `onOpen` only when opening, leaving transport/loading to the parent;
  - use native keyboard-operable `<select>` controls inside the opened surface;
  - derive all draft state and save eligibility via Task 8 functions;
  - invoke `onSave(update)` only after `sessionModelPolicyUpdateFromDraft()` returns a complete update;
  - show Tiered resolution from `catalog.ladder[draft.tier]` only when its configured row is valid, and otherwise show the catalog’s actionable invalid/config error;
  - use CSS media rules to render the opened surface as a positioned compact popover on wide layouts and a constrained modal-style bottom sheet on narrow layouts; do not let it overflow the composer;
  - close on Escape, restore focus through a retained trigger reference, and avoid event listeners outside the component lifecycle.

  Do not call APIs, mutate AppState, inspect machine capability, or duplicate catalog validation in this element.

- [ ] **Step 4: Run component tests and lint.**

  Run:

  ```bash
  npm test -- --run src/client/src/components/SessionModelPolicyControl.test.ts
  npx eslint src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/SessionModelPolicyControl.test.ts
  ```

  Expected: PASS. Use TemplateResult handler extraction only for one narrow click-wiring assertion if the DOM harness cannot exercise it; add the required inline comment explaining why that isolated extraction is proportionate. Do not use extraction for Escape/focus/accessibility tests.

- [ ] **Step 5: Commit the reusable control.**

  ```bash
  git add src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/SessionModelPolicyControl.test.ts
  git commit -m "feat: add session model policy composer control"
  ```

## Task 10: Make PromptEditor a Policy-Aware Layout Shell

**Files:**
- Modify: `src/client/src/components/PromptEditor.ts`
- Modify: `src/client/src/components/PromptEditor.sessionConfiguration.test.ts`

**Consumes:** Task 9 custom element, optional `SessionStatus.modelPolicy`, starter session configuration, and callbacks/data supplied by `PiWebUiApp`.

**Produces:** Composer rendering where mode is always first when supported, Exact retains existing model/thinking controls, Tiered displays only tier/resolution policy controls, and streaming status updates re-render on meaningful policy changes.

- [ ] **Step 1: Extend the existing session-control test with failing policy layout assertions.**

  Add an active Tiered `SessionStatus` fixture with:

  ```ts
  modelPolicy: {
    mode: "tiered",
    tier: "advanced",
    resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    ladderValid: true,
  },
  ```

  Assert rendered compact-status text/order contains the policy control before the model control position and omits the normal Select model/Select thinking buttons in Tiered mode. Add an Exact fixture proving the policy control is first and existing model/thinking buttons remain. Add an assertion that two statuses differing only in `modelPolicy.tier`, `ladderValid`, or `blockedReason` are not `sessionStatusRenderEqual`.

- [ ] **Step 2: Run the focused PromptEditor test before implementation.**

  Run: `npm test -- --run src/client/src/components/PromptEditor.sessionConfiguration.test.ts`

  Expected: FAIL because PromptEditor has no policy properties or render branch.

- [ ] **Step 3: Add narrow PromptEditor inputs and layout logic.**

  Import `./SessionModelPolicyControl` so the custom element registers with PromptEditor, then add properties for the policy response/catalog/loading/saving/error and callbacks:

  ```ts
  @property({ attribute: false }) modelPolicyStatus?: ClientSessionModelPolicyStatus;
  @property({ attribute: false }) modelPolicyResponse?: SessionModelPolicyResponse;
  @property({ attribute: false }) modelTierCatalog?: ModelTierSettingsResponse;
  @property({ type: Boolean }) modelPolicyLoading = false;
  @property({ type: Boolean }) modelPolicySaving = false;
  @property() modelPolicyError = "";
  @property({ attribute: false }) onOpenModelPolicy?: () => void;
  @property({ attribute: false }) onSaveModelPolicy?: (update: SessionModelPolicyUpdate) => void;
  ```

  For starter mode, accept an equivalent synthetic `SessionModelPolicyResponse` from the app; do not teach PromptEditor how to create one.

  In `renderCompactStatus()`:

  1. derive `policyStatus` from `this.modelPolicyStatus ?? status?.modelPolicy` and preserve the old branch unchanged when it is absent (older peers remain compatible);
  2. render `<session-model-policy-control>` first when `policyStatus` is present, passing that live status independently from any lazily loaded `modelPolicyResponse`;
  3. pass `editable=false` when the existing `disabled` flag is true, when active status indicates streaming/bash/compacting/queued work, or when save is in progress;
  4. render existing model/thinking buttons only when policy mode is Exact;
  5. let the policy component render Tiered tier/resolved status instead of duplicating it in PromptEditor.

  Expand `sessionStatusRenderEqual` to compare each displayed model-policy field, including nested resolved provider/id/thinking, mode, tier, ladder validity, and block reason. Keep all non-policy token-stream churn ignored.

- [ ] **Step 4: Run focused editor tests and typecheck.**

  Run:

  ```bash
  npm test -- --run src/client/src/components/PromptEditor.sessionConfiguration.test.ts src/client/src/components/PromptEditor.draft.test.ts
  npm run typecheck
  ```

  Expected: PASS. Existing starter controls continue to render unchanged for an unsupported/older peer.

- [ ] **Step 5: Commit the layout integration.**

  ```bash
  git add src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
  git commit -m "feat: show model policy in prompt editor"
  ```

## Task 11: Wire Active and Starter Composers in PiWebUiApp

**Files:**
- Modify: `src/client/src/components/PiWebUiApp.ts`
- Create: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

**Consumes:** Task 6 `modelTiersApi`, Task 7 SessionController methods/state, Task 8/9 policy data shape, Task 10 PromptEditor inputs, selected-machine runtime capabilities, existing starter defaults loading, and `selectedMachineId` stale guards.

**Produces:** On-demand selected-machine catalog loading, capability-safe active controls, an independent starter draft, correct reset behavior, and a typed policy snapshot passed into initial session creation.

- [ ] **Step 1: Write failing app-level tests for capability, starter state, and stale catalog responses.**

  In a focused `PiWebUiApp.sessionModelPolicy.test.ts` harness, cover:

  1. a selected remote machine that lacks `PI_WEBUI_CAPABILITIES.sessionsModelPolicy` does not render/request the policy control, even if it advertises `settings.modelTiers`;
  2. an active selected session with `status.modelPolicy` opens by calling `this.sessions.loadModelPolicy()` and loads `modelTiersApi.settings(machineId)` once for the selected machine;
  3. a catalog promise resolving after the selected machine/workspace changes does not replace the new selection’s catalog;
  4. startup begins with a local Exact policy constructed from `starterSessionDefaults`, then preserves that exact branch while selecting `advanced` Tiered;
  5. `handleStartSessionPrompt()` forwards `{ mode: 'tiered', tier: 'advanced' }` to `startSessionWithPrompt`, while ordinary Exact defaults pass no policy and retain the existing `POST /sessions` body;
  6. workspace or machine change clears the starter tier/draft/catalog error and reinitializes a linked Exact branch only after the fresh starter defaults arrive.

- [ ] **Step 2: Run the new app test before implementation.**

  Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

  Expected: FAIL because app state and handlers do not exist.

- [ ] **Step 3: Add explicit, local UI ownership for catalog and starter draft.**

  Add private reactive fields to `PiWebUiApp` for:

  ```ts
  @state() private modelTierCatalog: ModelTierSettingsResponse | undefined;
  @state() private modelTierCatalogLoading = false;
  @state() private modelTierCatalogError = "";
  @state() private starterModelPolicy: SessionModelPolicy | undefined;
  ```

  Implement `sessionModelPolicySupported()` using only `supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsModelPolicy)` for remote machines; local support is available from the same current application/daemon deployment. If the remote runtime is not yet known, leave the control unavailable rather than issuing an unsupported request.

  Implement `loadModelTierCatalog(machineId)` by calling `modelTiersApi.settings(machineId)`, capturing the starting `machineId` and current workspace ID, and checking both after `await` before updating any field. Reuse the same per-machine catalog for starter and active policy controls; do not duplicate the server’s catalog projection.

- [ ] **Step 4: Maintain starter policy independently from Pi default settings.**

  After `loadStarterSessionDefaults()` confirms current machine/workspace identity, derive the starter Exact branch from the resolved default model/thinking pair. Preserve `starterModelPolicy.exact` while the user is Tiered; while it is Exact, update the draft’s exact branch after existing starter model/thinking selection updates return confirmed defaults.

  Add stable callbacks passed to PromptEditor with these concrete effects:

  ```ts
  private readonly handleOpenStarterModelPolicy = (): void => {
    void this.loadModelTierCatalog(selectedMachineId(this.state));
  };

  private readonly handleSaveStarterModelPolicy = (update: SessionModelPolicyUpdate): void => {
    const current = this.starterModelPolicy;
    const catalog = this.modelTierCatalog;
    if (current === undefined || catalog === undefined) return;
    const draft = modelPolicyDraftFromPolicy(current);
    const next = update.mode === "tiered"
      ? selectDraftTier(draft, update.tier)
      : { ...draft, mode: "exact" as const, exact: update.exact };
    if (sessionModelPolicyUpdateFromDraft(next, catalog) !== undefined) this.starterModelPolicy = next;
  };

  private readonly handleOpenActiveModelPolicy = (): void => {
    void this.sessions.loadModelPolicy();
    void this.loadModelTierCatalog(selectedMachineId(this.state));
  };

  private readonly handleSaveActiveModelPolicy = (update: SessionModelPolicyUpdate): void => {
    void this.sessions.saveModelPolicy(update);
  };
  ```

  The starter save callback stores a full local `SessionModelPolicy` by applying the Task 8 draft transition; it does not write a global Pi setting merely by choosing Tiered. The active save callback delegates to `this.sessions.saveModelPolicy(update)` and lets the confirmed controller response replace the UI state.

- [ ] **Step 5: Pass the correct active/starter response to PromptEditor.**

  For the active composer, pass `state.status?.modelPolicy` as `modelPolicyStatus` and pass `state.modelPolicy` separately as its lazy inspection response, together with `modelTierCatalog`, `state.isLoadingModelPolicy`, `state.isSavingModelPolicy`, `state.modelPolicyError`, and controller callbacks. Supply them only when both live status/capability support exist.

  For the starter composer, after confirming both `starterSessionDefaults` and `starterModelPolicy` exist, derive `starterPolicyStatus` from the local draft and catalog before rendering:

  ```ts
  const selectedTier = this.starterModelPolicy?.tier;
  const selectedTierRow = selectedTier === undefined ? undefined : this.modelTierCatalog?.rows[selectedTier];
  const selectedTierEntry = selectedTier !== undefined && selectedTierRow?.valid === true
    ? this.modelTierCatalog?.ladder?.[selectedTier]
    : undefined;
  const starterPolicyStatus: ClientSessionModelPolicyStatus = {
    mode: this.starterModelPolicy?.mode ?? "exact",
    ...(this.starterModelPolicy?.tier === undefined ? {} : { tier: this.starterModelPolicy.tier }),
    resolved: selectedTierEntry ?? this.starterModelPolicy!.exact,
    ladderValid: this.modelTierCatalog?.valid === true,
    ...(this.starterModelPolicy?.mode === "tiered" && selectedTierEntry === undefined
      ? { blockedReason: this.modelTierCatalog?.configError ?? "Choose a valid model tier before starting" }
      : {}),
  };
  ```

  Then synthesize a `SessionModelPolicyResponse` only when starter defaults include a resolved provider/id, `starterModelPolicy` exists, and policy support is available:

  ```ts
  {
    contractVersion: 1,
    policy: this.starterModelPolicy,
    session: {
      sessionId: "starter",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      model: defaults.model,
      thinkingLevel: defaults.thinkingLevel,
      modelPolicy: starterPolicyStatus,
    },
  }
  ```

  Pass `starterPolicyStatus` as PromptEditor’s `modelPolicyStatus` and the synthetic object as `modelPolicyResponse`. Keep the synthetic object local to rendering; never send its `sessionId` to an API.

  In `handleStartSessionPrompt`, derive a `SessionModelPolicyUpdate` only when the starter policy is Tiered or an explicit repaired Exact selection differs from the linked defaults. Pass that immutable snapshot as the fifth `modelPolicy` argument to `this.sessions.startSessionWithPrompt(text, streamingBehavior, attachments, delivery, modelPolicy)` before focusing the composer. Clear/reset starter state on successful start through the existing start-screen transition rather than mutating it after the request begins.

- [ ] **Step 6: Run app, controller, and component integration tests.**

  Run:

  ```bash
  npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
  npm test -- --run src/client/src/controllers/sessionController.modelPolicy.test.ts src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
  npm run typecheck
  ```

  Expected: PASS. The starter can choose Tiered without changing Pi defaults, and an old remote peer remains on the current Exact-only composer UI.

- [ ] **Step 7: Commit active/starter orchestration.**

  ```bash
  git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
  git commit -m "feat: wire composer session model policy"
  ```

## Task 12: Document the Staged Composer Capability, Add the Changeset, and Verify Broadly

**Files:**
- Modify: `docs/config.md`
- Modify: `docs/config.html`
- Create: `.changeset/composer-session-model-policy.md`

**Consumes:** Completed daemon contracts, composer behavior, current model-tier Settings documentation, and project documentation/release conventions.

**Produces:** Accurate user-facing configuration guidance and a patch release note without claiming unimplemented directive/request-boundary behavior.

- [ ] **Step 1: Add paired documentation coverage before final release metadata.**

  In the canonical model-tier/session configuration sections of both `docs/config.md` and `docs/config.html`, add matching content that explains:

  - Exact is the default for new root sessions; it retains the existing provider/model/thinking controls.
  - Tiered is selected from the first composer control, stores one canonical ladder tier plus a remembered Exact branch, and applies the selected ladder tuple atomically when the user saves the policy or starts the root session.
  - Tiered needs a complete valid selected-machine six-tier ladder and fails visibly for removed models/authentication or unsupported thinking levels; PI WEBUI never silently chooses a replacement.
  - Changes are disabled during active work and for archived sessions; a failed restoration blocks prompts until repaired instead of running with an ambiguous model state.
  - Policy selection persists in the session and older selected-machine peers hide the additive control safely.
  - This staged release does not add `/tier-*` commands or automatic remapping after a later ladder edit. Do not promise either behavior.
  - Restart `pi-webui-sessiond.service` manually once after installing this release; ordinary UI/API autoreload does not load daemon changes.

  Keep `README.md` unchanged. Do not describe internal custom-entry names, TypeScript types, or cache implementation to end users.

- [ ] **Step 2: Add the patch Changeset.**

  Create `.changeset/composer-session-model-policy.md` with exactly:

  ```md
  ---
  "@hyperdreamer/pi-webui": patch
  ---

  Add persistent Exact and Tiered model-policy controls to session composers with validated model and thinking-level application.
  ```

  Do not edit `CHANGELOG.md`.

- [ ] **Step 3: Run focused documentation and release-metadata checks.**

  Run:

  ```bash
  git diff --check
  git diff -- docs/config.md docs/config.html .changeset/composer-session-model-policy.md
  ```

  Expected: no whitespace errors; Markdown/HTML make the same product claims and no README expansion exists.

- [ ] **Step 4: Run the full verification sequence with fresh evidence.**

  Run:

  ```bash
  npm run typecheck
  npm run lint
  npm run knip
  npm test
  git diff --check
  npm run verify
  ```

  Expected: every command exits `0`. If a failure is pre-existing, capture its exact command/output and separate it from this feature before claiming completion.

- [ ] **Step 5: Commit documentation and release metadata.**

  ```bash
  git add docs/config.md docs/config.html .changeset/composer-session-model-policy.md
  git commit -m "docs: describe composer model policy"
  ```

## Final Acceptance Checklist

- [ ] New root Exact sessions persist their runtime-resolved exact tuple before their initial prompt; a starter Tiered selection persists both the original Exact branch and chosen tier before its initial prompt.
- [ ] An active session can inspect and atomically switch Exact/Tiered policy only when idle and writable; all mutations have daemon-authoritative validation.
- [ ] Model setter order is model then thinking; unsupported target thinking, model disappearance, persistence errors, and failed restoration are demonstrated by focused tests without silent fallback/clamping.
- [ ] The newest active-branch policy entry controls behavior; malformed newest entries cannot revive older intent and produce an explicit blocked/recovery path.
- [ ] Existing exact model/thinking routes persist confirmed exact state and reject Tiered-mode direct mutation.
- [ ] `sessions.modelPolicy` is independently capability-gated across web/session daemon and remote peers omit the UI safely.
- [ ] Active browser reads/saves use session/machine/selection-sequence stale guards; starter catalog/default requests use machine/workspace identity guards.
- [ ] Exact/Tiered control is first in the composer; Exact retains existing controls, Tiered displays a read-only resolved tuple; keyboard, focus restoration, errors, and narrow layout have real component coverage.
- [ ] No `/tier-*` parsing, busy directive queue, tool dispatch inheritance/idempotency, `get_model_policy`, automatic next-request mapping refresh, or deterministic-SDD behavior leaks into this scoped implementation.
- [ ] `docs/config.md`/`docs/config.html` are synchronized, the patch Changeset exists, `CHANGELOG.md` remains untouched, all verification commands pass, and the handoff explicitly calls for manually restarting `pi-webui-sessiond.service`.
