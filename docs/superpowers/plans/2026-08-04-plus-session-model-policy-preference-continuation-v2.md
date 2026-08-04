# Plus-Created Session Model Policy Memory Recovery Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete original Tasks 3-10 so SESSIONS `+` roots restore and become the only eligible source of each workspace's complete last confirmed model policy.

**Architecture:** Continue from the independently reviewed shared-contract and version-two-store commits. Decompose negotiated defaults into four independently reviewed boundaries: server hydration, HTTP negotiation/proxying, strict client parsing, and browser API transport; then preserve the approved provenance, initialization, confirmed writeback, Lit integration, compatibility, and documentation work unchanged.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Fastify, the Pi SDK session manager/custom entries, Lit, Vitest, Changesets, and PI WEBUI's existing selected-machine proxy/capability infrastructure.

## Global Constraints

- Implement the approved design in `docs/superpowers/specs/2026-08-03-plus-session-model-policy-preference-design.md`; do not edit that historical specification.
- Add no runtime dependency and do not create a second preference store or browser-owned durable preference.
- Only a top-level root carrying durable `creationSource: "session-list-plus"` may replace the full preference; prompt-created, imported, reopened-without-marker, `spawn_session`, and tracked-subsessions remain ineligible.
- Persist complete user intent: active mode, non-blank Exact provider/model/thinking, and canonical tier when Tiered; preserve unavailable inactive or active values without clearing, clamping, or substitution.
- Validate only the active branch for execution; an unavailable active branch blocks creation or mutation with its specific reason, while an unavailable inactive branch remains stored and non-blocking.
- Write a full preference only after successful creation or a server-confirmed session-policy mutation; preference failures are non-blocking and must not roll back runtime or session policy state.
- Keep unversioned defaults reads/writes and legacy starts strict and byte-compatible for old clients; send version-two fields and commands only when `sessions.modelPolicyStarterSelection` is effectively negotiated.
- Follow the application-relative browser URL convention, encode dynamic segments, and use `URLSearchParams` for `starterModelPolicyContract=2` and cwd query values.
- Keep `README.md` unchanged; synchronize user-facing behavior in `docs/config.md` and `docs/config.html`, add one patch Changeset, and never edit `CHANGELOG.md` directly.
- Use red-green TDD at the narrowest useful layer, preserve existing user changes, and finish with `npm run typecheck`, `npm run lint`, and `npm run verify`.
- The release handoff must state that `pi-webui-sessiond.service` needs a manual restart because this feature changes sessiond-loaded code and protocol contracts.
- This recovery continuation starts from clean reviewed commits `4ec2d58efb84a2ed75df047d4dad3a15132b7eb4` (original Task 1) and `90b78758f45ce1df749647a118aed6e2e84fdc23` (original Task 2), plus plan-only commit `9117a2bed9ba94c1ccf17edf69c6168d09a72846`; do not rewrite them.
- Recovery Tasks 1-4 jointly replace original Task 3. Recovery Tasks 5-11 map in order to original Tasks 4-10.
- Five interrupted original-Task-3 or continuation-Task-1 children produced no edits, commits, or valid role reports and receive no implementation credit; the terminal blocked runs remain immutable audit evidence.

## Task 1: Hydrate version-two session defaults in the service

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/sessions/sessionDefaultsService.ts:1-210`
- Modify: `src/server/sessions/sessionDefaultsService.test.ts:1-230`

**Interfaces:**

- Consumes: existing `StarterPreferenceInspection`, `ExactModelSelection`, `SessionDefaultsV2Response`, and `StarterModelPolicyPreferenceResponse` from reviewed commits `4ec2d58` and `90b7875`.
- Produces: `SessionDefaultsService.readV2(cwd: string): Promise<SessionDefaultsV2Response>`.
- Preserves: `read(cwd)` and `update(cwd, update)` return the existing unversioned `SessionDefaultsResponse` without nested `exact` or a contract-version field.

- [ ] **Step 1: Write failing service tests for every inspection shape**

Extend `createHarness()` with optional `configuredProvider`, `configuredModelId`, and `configuredThinkingLevel` inputs so raw Pi settings can differ from the available-model snapshot. Keep existing callers defaulting those values from `model` and `thinkingLevel`.

Add these `readV2()` cases:

```ts
it("returns a cloned full starter preference under contract version two", async () => {
  const preference = {
    mode: "tiered" as const,
    exact: {
      model: { provider: "retired", id: "remembered" },
      thinkingLevel: "retired-level",
    },
    tier: "frontier" as const,
  };
  const harness = createHarness({
    model: testModel(),
    thinkingLevel: "high",
    preferenceInspection: { kind: "full", preference },
  });

  const defaults = await harness.service.readV2("/workspace");

  expect(defaults.starterModelPolicyContractVersion).toBe(2);
  expect(defaults.starterModelPolicyPreference).toEqual(preference);
  expect(defaults.starterModelPolicyPreference).not.toBe(preference);
  expect((defaults.starterModelPolicyPreference as typeof preference).exact)
    .not.toBe(preference.exact);
});
```

Add one legacy Exact case whose raw configured tuple is absent from `models`, and assert the response hydrates that raw tuple without availability checks. Add one legacy Tiered case and assert both raw Exact and canonical tier survive. Add table cases where provider, model id, or thinking level is `undefined` or blank; each must retain the legacy `{mode, tier?}` shape and omit `exact`. Add an invalid-inspection or thrown-inspection case that still returns ordinary model/thinking defaults plus `starterModelPolicyPreferenceError`. Assert existing `read()` tests still down-project full preferences and never expose `starterModelPolicyContractVersion` or `exact`.

- [ ] **Step 2: Run the focused service test and confirm RED**

Run: `npm test -- --run src/server/sessions/sessionDefaultsService.test.ts`

Expected: FAIL because `SessionDefaultsService.readV2` does not exist.

- [ ] **Step 3: Implement raw-intent hydration without changing version one**

Import the existing V2, full-preference, legacy-preference, and Exact types. Capture raw settings before loading or projecting the model catalog:

```ts
async readV2(cwd: string): Promise<SessionDefaultsV2Response> {
  const settings = this.createSettingsManager(cwd, this.deps.agentDir);
  const configuredExact = rawConfiguredExact(settings);
  const [models, preferenceInspection] = await Promise.all([
    this.availableModels(),
    this.inspectStarterPreference(cwd),
  ]);
  return this.responseV2(settings, models, configuredExact, preferenceInspection);
}
```

`rawConfiguredExact()` must return `undefined` unless provider, model id, and thinking level are strings whose `trim()` is non-empty. Preserve the original non-blank values and do not consult `models`, `thinkingLevelsForModel`, or `effectiveThinkingLevel`:

```ts
function rawConfiguredExact(
  settings: SessionDefaultsSettings,
): ExactModelSelection | undefined {
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  const thinkingLevel = settings.getDefaultThinkingLevel();
  if (provider?.trim() === "" || id?.trim() === "" || thinkingLevel?.trim() === "") {
    return undefined;
  }
  if (provider === undefined || id === undefined || thinkingLevel === undefined) {
    return undefined;
  }
  return { model: { provider, id }, thinkingLevel };
}
```

Build ordinary model/thinking fields through the existing availability projection, but do not let its version-one `preferenceFields()` enter the V2 object. Add V2 preference fields with these exact rules:

```ts
function hydrateLegacyPreference(
  preference: LegacyStarterModelPolicyPreference,
  exact: ExactModelSelection | undefined,
): StarterModelPolicyPreferenceResponse {
  if (exact === undefined) {
    return preference.tier === undefined
      ? { mode: preference.mode }
      : { mode: preference.mode, tier: preference.tier };
  }
  return {
    mode: preference.mode,
    exact: cloneExactModelSelection(exact),
    ...(preference.tier === undefined ? {} : { tier: preference.tier }),
  };
}
```

For `kind: "full"`, deep-clone mode, nested model reference, thinking level, and optional tier. For `kind: "legacy-v1"`, use the hydration rule. For `kind: "invalid"`, return only `starterModelPolicyPreferenceError`; for `absent`, return neither preference field. Set `starterModelPolicyContractVersion: 2` exactly. Do not modify `read()`, `update()`, `responseFor()`, or version-one `preferenceFields()` semantics.

- [ ] **Step 4: Run service GREEN and static checks**

Run: `npm test -- --run src/server/sessions/sessionDefaultsService.test.ts`

Run: `npm run typecheck`

Expected: PASS; negotiated reads preserve complete raw intent while every existing unversioned read/update assertion remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/sessionDefaultsService.ts src/server/sessions/sessionDefaultsService.test.ts
git commit -m "feat(model-policy): hydrate full starter defaults"
```

## Task 2: Negotiate version two at the server route and proxy boundary

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/sessionDefaultsRoutes.ts:1-35`
- Modify: `src/server/sessions/sessionDefaultsRoutes.test.ts:1-125`
- Modify: `src/server/sessiond/sessionProxyRoutes.test.ts:20-65`

**Interfaces:**

- Consumes: `SessionDefaultsService.readV2(cwd: string): Promise<SessionDefaultsV2Response>` from Recovery Task 1.
- Produces: `SessionDefaultsRouteService.readV2(cwd)` and GET `/session-defaults?cwd=...&starterModelPolicyContract=2` selection.
- Preserves: an absent selector calls `read(cwd)`; PUT `/session-defaults` and production proxy forwarding remain unchanged.

- [ ] **Step 1: Write failing route-selection and proxy-preservation tests**

Add a typed `readV2` mock and V2 fixture to `sessionDefaultsRoutes.test.ts`. Preserve the existing unversioned test and assert it calls only `read`. Add:

```ts
it("reads version-two defaults only for contract selector 2", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/session-defaults?cwd=%2Frepo%20one&starterModelPolicyContract=2",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(v2Defaults);
  expect(readV2).toHaveBeenCalledWith("/repo one");
  expect(read).not.toHaveBeenCalled();
});
```

Add table cases for `starterModelPolicyContract=`, `=1`, `=3`, `=2&starterModelPolicyContract=2`, and `=2&starterModelPolicyContract=3`. Each must return 400 and call neither `read` nor `readV2`. Fastify 5 parses duplicate keys as `string[]`; do not add a custom query parser.

In `sessionProxyRoutes.test.ts`, change only the defaults-read request/expectation to:

```ts
const read = await app.inject({
  method: "GET",
  url: "/api/machines/local/session-defaults?cwd=%2Frepo%20one&starterModelPolicyContract=2",
});

expect(daemon.requests[0]).toEqual({
  method: "GET",
  path: "/session-defaults?cwd=%2Frepo%20one&starterModelPolicyContract=2",
  body: undefined,
});
```

Keep the existing update and preference-update assertions in that test.

- [ ] **Step 2: Run the focused route/proxy tests and confirm RED**

Run: `npm test -- --run src/server/sessions/sessionDefaultsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts`

Expected: FAIL because the route service has no `readV2` branch; the proxy test already demonstrates that production forwarding needs no change.

- [ ] **Step 3: Implement one explicit selector branch**

Add `readV2` to `SessionDefaultsRouteService` using the existing service return type. Widen only the GET query type:

```ts
type SessionDefaultsQuery = {
  cwd?: string;
  starterModelPolicyContract?: string | string[];
};
```

Normalize cwd once, then branch exactly:

```ts
const cwd = normalizeRequestCwd(requireString(request.query.cwd, "cwd"));
const contract = request.query.starterModelPolicyContract;
if (contract === undefined) return await service.read(cwd);
if (contract !== "2") throw new Error("Unsupported starter model policy contract");
return await service.readV2(cwd);
```

Arrays, blank strings, and every string except `"2"` must reject before either read method is called. Leave PUT parsing and `src/server/sessiond/sessionProxyRoutes.ts` unchanged.

- [ ] **Step 4: Run route/proxy GREEN and static checks**

Run: `npm test -- --run src/server/sessions/sessionDefaultsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts`

Run: `npm run typecheck`

Expected: PASS; no selector remains version one, exactly one selector value `2` selects version two, and encoded query bytes survive the selected-machine proxy.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/sessionDefaultsRoutes.ts src/server/sessions/sessionDefaultsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts
git commit -m "feat(model-policy): negotiate starter defaults on the server"
```

## Task 3: Parse negotiated defaults strictly

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/api/parsers.ts:1-370,740-790`
- Modify: `src/client/src/api/parsers.test.ts:1-5,409-505`

**Interfaces:**

- Consumes: existing shared `SessionDefaultsV2Response`, `StarterModelPolicyPreferenceResponse`, `ExactModelSelection`, and canonical `MODEL_TIERS`.
- Produces: `parseSessionDefaultsV2Response(value: unknown): SessionDefaultsV2Response`.
- Preserves: `parseSessionDefaultsResponse()` remains the unversioned, legacy-preference parser and is not widened or made stricter by this task.

- [ ] **Step 1: Write failing strict-parser tests**

Import `parseSessionDefaultsV2Response`. Add one valid full Tiered response and one valid legacy Exact response:

```ts
const v2Defaults = {
  starterModelPolicyContractVersion: 2,
  model: { provider: "acme", id: "available" },
  thinkingLevel: "high",
  models: [{ provider: "acme", id: "available" }],
  thinkingLevels: ["off", "high"],
  starterModelPolicyPreference: {
    mode: "tiered",
    exact: {
      model: { provider: "retired", id: "remembered" },
      thinkingLevel: "retired-level",
    },
    tier: "standard",
  },
};
expect(parseSessionDefaultsV2Response(v2Defaults)).toEqual(v2Defaults);
```

Assert a legacy `{mode: "exact", tier: "frontier"}` preference also parses without inventing `exact`. Add one rejection assertion for each contract invariant:

- missing `starterModelPolicyContractVersion`;
- version `1`, `3`, or string `"2"`;
- unknown top-level response field;
- unknown preference field;
- unknown `exact` field;
- unknown nested Exact `model` field;
- blank Exact provider, id, or thinking level;
- full Tiered preference without a canonical tier;
- full or legacy preference with an unknown tier;
- simultaneous `starterModelPolicyPreference` and `starterModelPolicyPreferenceError`.

Retain all existing V1 parser tests unchanged.

- [ ] **Step 2: Run the parser test and confirm RED**

Run: `npm test -- --run src/client/src/api/parsers.test.ts`

Expected: FAIL because `parseSessionDefaultsV2Response` is not exported.

- [ ] **Step 3: Implement a dedicated strict V2 parser**

Import the V2 and full-preference response types. Add this private preference boundary near the existing legacy parser:

```ts
function parseStarterModelPolicyPreferenceResponse(
  value: unknown,
): StarterModelPolicyPreferenceResponse {
  const record = requirePlainRecord(value, "starter model policy preference");
  if (!Object.hasOwn(record, "exact")) {
    return parseStarterModelPolicyPreference(record);
  }
  assertOnlyFields(record, ["mode", "exact", "tier"], "starter model policy preference");
  const mode = parseSessionModelPolicyMode(record["mode"]);
  const tier = parseOptionalSessionModelPolicyTier(record, "starter model policy preference");
  if (mode === "tiered" && tier === undefined) {
    throw new Error("Tiered starter model policy preference requires a tier");
  }
  return {
    mode,
    exact: parseExactModelSelection(record["exact"]),
    ...optionalField("tier", tier),
  };
}
```

Add the exported response parser next to `parseSessionDefaultsResponse()`:

```ts
export function parseSessionDefaultsV2Response(
  value: unknown,
): SessionDefaultsV2Response {
  const record = requirePlainRecord(value, "version-two session defaults response");
  assertOnlyFields(record, [
    "starterModelPolicyContractVersion",
    "model",
    "thinkingLevel",
    "models",
    "thinkingLevels",
    "starterModelPolicyPreference",
    "starterModelPolicyPreferenceError",
  ], "version-two session defaults response");
  if (record["starterModelPolicyContractVersion"] !== 2) {
    throw new Error("Invalid starter model policy contract version");
  }
  const preference = record["starterModelPolicyPreference"] === undefined
    ? undefined
    : parseStarterModelPolicyPreferenceResponse(record["starterModelPolicyPreference"]);
  const preferenceError = optionalString(record, "starterModelPolicyPreferenceError");
  if (preference !== undefined && preferenceError !== undefined) {
    throw new Error("Session defaults cannot contain both a starter preference and preference error");
  }
  return {
    starterModelPolicyContractVersion: 2,
    ...(record["model"] === undefined ? {} : { model: parseSessionModel(record["model"]) }),
    thinkingLevel: requireString(record, "thinkingLevel"),
    models: arrayOf(parseSessionModel)(record["models"]),
    thinkingLevels: arrayOfString(record["thinkingLevels"], "thinkingLevels"),
    ...optionalField("starterModelPolicyPreference", preference),
    ...optionalField("starterModelPolicyPreferenceError", preferenceError),
  };
}
```

Reuse the existing strict `parseExactModelSelection()` and canonical tier helper. Distinguish full from legacy only through own `exact` presence. Do not add fields to or call this parser from the V1 parser.

- [ ] **Step 4: Run parser GREEN and static checks**

Run: `npm test -- --run src/client/src/api/parsers.test.ts`

Run: `npm run typecheck`

Expected: PASS; V2 is strict at the negotiated response/preference/Exact boundaries, while V1 behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts
git commit -m "feat(model-policy): parse negotiated starter defaults"
```

## Task 4: Request negotiated defaults from the browser client

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/api/clients.ts:45-70,292-310`
- Modify: `src/client/src/api/clients.test.ts:409-445`
- Modify: `src/client/src/api.ts:1-6`

**Interfaces:**

- Consumes: `parseSessionDefaultsV2Response(value): SessionDefaultsV2Response` from Recovery Task 3 and existing `request()` / `machinePrefix()` browser URL boundaries.
- Produces: `sessionsApi.sessionDefaultsV2(cwd: string, machineId?: string): Promise<SessionDefaultsV2Response>`.
- Produces: public type export `SessionDefaultsV2Response` from `src/client/src/api.ts`.
- Preserves: `sessionsApi.sessionDefaults()` URL bytes, parser, and return contract remain unchanged.

- [ ] **Step 1: Write failing local and selected-machine client tests**

Use two valid V2 JSON responses and call the new method for local and remote machines. Assert exact browser-ready URLs:

```ts
const fetchMock = stubSequenceFetch([
  jsonResponse(v2Defaults),
  jsonResponse(v2Defaults),
]);

await sessionsApi.sessionDefaultsV2("/repo with spaces");
await sessionsApi.sessionDefaultsV2("/repo with spaces", "remote /?");

expect(fetchCall(fetchMock, 0)[0]).toBe(
  "https://pi.example.test/api/machines/local/session-defaults?cwd=%2Frepo+with+spaces&starterModelPolicyContract=2",
);
expect(fetchCall(fetchMock, 1)[0]).toBe(
  "https://pi.example.test/api/machines/remote%20%2F%3F/session-defaults?cwd=%2Frepo+with+spaces&starterModelPolicyContract=2",
);
```

Parse each URL with `new URL(...)` and assert `searchParams.getAll("starterModelPolicyContract")` equals `["2"]`. Retain the existing legacy URL assertion exactly.

- [ ] **Step 2: Run the client test and confirm RED**

Run: `npm test -- --run src/client/src/api/clients.test.ts`

Expected: FAIL because `sessionsApi.sessionDefaultsV2` does not exist.

- [ ] **Step 3: Add the additive browser method and public type export**

Import `parseSessionDefaultsV2Response` beside the V1 parser. Add one block-bodied method without changing `sessionDefaults`:

```ts
sessionDefaultsV2: (cwd: string, machineId = "local") => {
  const params = new URLSearchParams({
    cwd,
    starterModelPolicyContract: "2",
  });
  return request(
    `${machinePrefix(machineId)}/session-defaults?${params.toString()}`,
    parseSessionDefaultsV2Response,
  );
},
```

The path remains application-relative and `request()` resolves it exactly once. In `src/client/src/api.ts`, extend the existing defaults type-export line to include `SessionDefaultsV2Response`; do not duplicate it in another export list.

- [ ] **Step 4: Run client GREEN and static checks**

Run: `npm test -- --run src/client/src/api/clients.test.ts`

Run: `npm run typecheck`

Expected: PASS; both machine scopes encode cwd with `URLSearchParams`, include exactly one selector, and legacy callers remain byte-compatible.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts
git commit -m "feat(model-policy): request negotiated starter defaults"
```

## Task 5: Persist and project plus-session creation source

**Implementer tier:** Capable

**Files:**

- Create: `src/server/sessions/sessionCreationSource.ts`
- Create: `src/server/sessions/sessionCreationSource.test.ts`
- Modify: `src/server/sessions/piSessionManagerGateway.ts:1-190`
- Modify: `src/server/sessions/piSessionManagerGateway.test.ts:80-190`
- Modify: `src/server/sessions/piSessionService.ts:1450-1645,4460-4550`
- Modify: `src/server/sessions/sessionArchiveStore.ts:1-260`
- Modify: `src/server/sessions/sessionArchiveStore.test.ts:45-190`
- Modify: `src/client/src/api/parsers.ts:370-440`
- Modify: `src/client/src/api/parsers.test.ts:462-486`
- Modify: `src/client/src/cachedNewSessions.ts:1-145`
- Modify: `src/client/src/cachedNewSessions.test.ts:1-95`

**Interfaces:**

- Consumes: existing shared `SessionCreationSource = "session-list-plus"` and optional `SessionInfo.creationSource` from reviewed commit `4ec2d58`.
- Produces: `SESSION_CREATION_SOURCE_CUSTOM_TYPE = "pi-webui.session-creation-source"`, `serializeSessionCreationSource(source)`, `inspectSessionCreationSource(entries)`, and `CreationSourceInspection` with absent/valid/invalid variants.
- Produces: optional `creationSource` on `PiSessionListEntry`, `ArchiveSessionInput`, and `ArchivedSessionRecord`; every browser/session projection clones only a valid known source.

- [ ] **Step 1: Write failing pure-domain and projection tests**

Create `sessionCreationSource.test.ts` with a strict version-one round trip and newest-authoritative cases:

```ts
expect(serializeSessionCreationSource("session-list-plus")).toEqual({
  version: 1,
  source: "session-list-plus",
});
expect(inspectSessionCreationSource([
  customSourceEntry({ version: 1, source: "session-list-plus" }),
])).toEqual({ kind: "valid", source: "session-list-plus" });
expect(inspectSessionCreationSource([
  customSourceEntry({ version: 1, source: "session-list-plus" }),
  customSourceEntry({ version: 1, source: "unknown" }),
])).toMatchObject({ kind: "invalid" });
```

Also test absent entries, unsupported version, missing/unknown fields, and ensure a malformed newest matching marker never falls back. Extend gateway, archive-store, API-parser, and cached-new-session tests to assert `creationSource` survives list, archive index round trip, restore projection, localStorage round trip, marker stripping, and server-list merge. Add malformed optional source tests that do not invent eligibility.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `npm test -- --run src/server/sessions/sessionCreationSource.test.ts src/server/sessions/piSessionManagerGateway.test.ts src/server/sessions/sessionArchiveStore.test.ts src/client/src/api/parsers.test.ts src/client/src/cachedNewSessions.test.ts`

Expected: FAIL because the source domain module and projections do not exist.

- [ ] **Step 3: Implement one strict source domain and use it everywhere**

Use a custom-entry serializer/parser with this public result:

```ts
export type CreationSourceInspection =
  | { kind: "absent" }
  | { kind: "valid"; source: SessionCreationSource }
  | { kind: "invalid"; reason: string };
```

Scan matching custom entries newest-first. Validate exactly `version` and `source`; return invalid immediately for a malformed newest marker. Do not infer source from root status, parentage, transcript length, cache markers, or current selection.

When `PiSessionManagerGateway` maps a listed session, open its manager at the listed path, feed entries to the pure parser, and attach only a valid source. Have active/direct `PiSessionService` projections use the same parser. Copy source into archive input/index records at archive time and back into archived projections; restoration keeps the JSONL marker itself. Strictly parse the archive field as the one known value. Preserve the optional field in browser parsing, cached-new serialization/parsing, `markCachedNewSessionInfo()`, and `stripCachedNewSessionMarker()`.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- --run src/server/sessions/sessionCreationSource.test.ts src/server/sessions/piSessionManagerGateway.test.ts src/server/sessions/sessionArchiveStore.test.ts src/client/src/api/parsers.test.ts src/client/src/cachedNewSessions.test.ts`

Run: `npm run typecheck`

Expected: PASS; valid provenance survives every projection and malformed/absent markers project no eligible source.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/sessionCreationSource.ts src/server/sessions/sessionCreationSource.test.ts src/server/sessions/piSessionManagerGateway.ts src/server/sessions/piSessionManagerGateway.test.ts src/server/sessions/piSessionService.ts src/server/sessions/sessionArchiveStore.ts src/server/sessions/sessionArchiveStore.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/cachedNewSessions.ts src/client/src/cachedNewSessions.test.ts
git commit -m "feat(sessions): persist plus-session creation source"
```

## Task 6: Initialize plus-created roots from a complete policy

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

- Consumes: existing `SessionStartOptions`, `StarterModelPolicyPreference`, and `SessionCreationSource`, plus `serializeSessionCreationSource()` / `inspectSessionCreationSource()` from Recovery Task 5.
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

## Task 7: Add server-authoritative confirmed-policy writeback

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

- Consumes: source inspection from Recovery Task 5, newest `SessionModelPolicyInspection` from the existing policy module, and tagged full store writes from reviewed commit `90b7875`.
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

## Task 8: Model full starter drafts and active-branch readiness

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/sessionModelPolicyDraft.ts:1-260`
- Modify: `src/client/src/components/sessionModelPolicyDraft.test.ts:1-620`

**Interfaces:**

- Consumes: legacy/version-two defaults from Recovery Tasks 1-4, the existing complete starter-preference contract, the model-tier catalog, and existing immutable draft selectors.
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

## Task 9: Schedule writeback from confirmed client session outcomes

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.ts`
- Create: `src/client/src/controllers/confirmedStarterModelPolicyPreferenceWriter.test.ts`
- Modify: `src/client/src/controllers/sessionController.ts:65-120,260-325,1020-1160,1375-1515`
- Modify: `src/client/src/controllers/sessionController.testSupport.ts:1-180`
- Modify: `src/client/src/controllers/sessionController.pendingStarts.test.ts:1-335`
- Modify: `src/client/src/controllers/sessionController.modelPolicy.test.ts:150-730`

**Interfaces:**

- Consumes: `sessionsApi.startPlusSession()` from Recovery Task 6, `sessionsApi.rememberCurrentModelPolicy()` from Recovery Task 7, complete starter policy, and projected `SessionInfo.creationSource` from Recovery Task 5.
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

## Task 10: Integrate negotiated full-policy behavior in the Lit application

**Implementer tier:** Capable

**Files:**

- Modify: `src/shared/capabilities.ts:8-55`
- Modify: `src/shared/capabilities.test.ts:1-215`
- Modify: `src/client/src/components/PiWebUiApp.ts:180-380,1120-1220,1560-1665,1980-2070,2220-2370,3000-3265,3280-3410`
- Modify: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts:220-1695`
- Modify: `src/client/src/components/PromptEditor.sessionConfiguration.test.ts:1-230`

**Interfaces:**

- Consumes: version-two defaults client from Recovery Task 4, starter evaluation from Recovery Task 8, plus start/confirmed callback and scoped writer from Recovery Task 9, and remember client from Recovery Task 7.
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

Add a helper that checks `sessions.modelPolicyStarterSelection` on the selected machine. In `loadStarterSessionDefaults()`, call `sessionDefaultsV2()` only when supported; otherwise call the current method. Keep the state typed as `SessionDefaultsResponse | SessionDefaultsV2Response`. Give defaults loads a monotonically increasing request sequence plus captured machine/workspace identity, and publish only the newest matching response. When runtime discovery changes the current peer from unknown/legacy to effectively supporting the capability, issue a fresh V2 load so an earlier unversioned response cannot strand or overwrite full behavior. Seed through Recovery Task 8, load the selected machine's tier catalog for every V2 starter in either mode, and rerun `completeUnownedStarterExactFromActiveTier()` whenever defaults or that catalog changes.

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

## Task 11: Document, changeset, and verify the complete feature

**Implementer tier:** Advanced

**Files:**

- Modify: `docs/config.md:227-255`
- Modify: `docs/config.html:643-676`
- Inspect: `CONTEXT.md:1-55`
- Create: `.changeset/remember-plus-session-model-policy.md`

**Interfaces:**

- Consumes: completed behavior and compatibility contract from Recovery Tasks 1-10 and the approved terminology already committed in `CONTEXT.md`.
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
