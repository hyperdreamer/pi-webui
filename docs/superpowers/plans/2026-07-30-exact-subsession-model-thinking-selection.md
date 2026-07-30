# Exact Subsession Model and Thinking Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each eligible parent session persist an exact provider/model/thinking default for future tracked subsessions, expose that choice in the starter and active composers, and permit one complete exact override per `spawn_subsession` call.

**Architecture:** Add one focused server `SubsessionConfiguration` module that owns exact selection parsing, authenticated model catalogs, supported-thinking validation, active-branch persistence, and override/default/fallback resolution. Extend the existing tracked-subsessions runtime and protocol additively, then add a pure starter-draft reducer plus a controlled accessible Lit control; `PiWebUiApp` and `SessionController` orchestrate requests while `PromptEditor` remains layout and submission glue.

**Tech Stack:** TypeScript 6, Fastify 5, Lit 3, Vitest 4, TypeBox, Pi SDK `@earendil-works/pi-*` 0.82.x, `happy-dom` for focused real-DOM component tests, Changesets.

## Global Constraints

- Exact selections are `{ model: { provider, id }, thinkingLevel }`; do not add Fast/Standard/Capable tiers, rankings, budgets, or automatic routing.
- The complete model/thinking selection is atomic at browser, HTTP, persistence, tool, and runtime boundaries.
- A complete per-spawn override wins over the active branch's latest persisted parent default; only a branch with no matching entry uses the current parent model/thinking fallback.
- A malformed or unsupported-version latest matching entry fails closed; never revive an older entry or silently use the parent fallback.
- Never substitute an unavailable model or clamp an unsupported thinking level.
- Use only the refreshed authenticated model snapshot from `ModelRuntime.getAvailableSnapshot()`; do not accept `getModel()` as availability proof.
- Keep provider and model ID as separate fields; model IDs may contain `/`.
- Preserve existing tracked lineage, workspace validation, completion notifications, transcript access, unread exclusion, `yield_to_subsessions`, and recursive-delegation suppression.
- Independent `spawn_session` has no new public model/thinking input and otherwise remains unchanged.
- Starter child state follows the parent until edited, then persists one exact snapshot when the parent is created.
- Active parent and child settings remain independent; Copy current session settings writes a new exact child default rather than creating inheritance.
- Hide the control for unsupported peers, disabled tracked subsessions, archived sessions, and verified tracked children.
- Keep active values inspectable while work is active, but use a server-authoritative editability flag to disable mutation during agent, bash, compaction, queued, entry-mutation, tree-exclusive, or tree-navigation work.
- Keep active model options out of high-frequency `SessionStatus`; load them only when the active control opens.
- Wire thinking values remain nonblank strings for rolling compatibility; the live daemon decides whether a value is supported.
- Build browser paths application-relative, encode dynamic path segments, and use existing `sessionPath()`, `sessionQueryPath()`, and `sessionBody()` helpers.
- Do not add machine-level/project-level child profiles, a new project config file, provider/authentication changes, or upstream Pi changes.
- Update `docs/config.md` and `docs/config.html`; leave `README.md` unchanged.
- Add one patch Changeset for the implemented user-visible feature; never edit `CHANGELOG.md` manually.
- Implementation changes touch session-daemon-loaded code and require a manual restart of `pi-webui-sessiond.service` after installation.

## Ratified Transport and Validation Decisions

Use these exact shared values so every task refers to one contract:

```ts
export const SUBSESSION_PROVIDER_MAX_LENGTH = 512;
export const SUBSESSION_MODEL_ID_MAX_LENGTH = 1024;
export const SUBSESSION_THINKING_LEVEL_MAX_LENGTH = 128;

export interface SubsessionModelIdentity {
  provider: string;
  id: string;
}

export interface SubsessionModelSelection {
  model: SubsessionModelIdentity;
  thinkingLevel: string;
}

export interface SubsessionModelOption {
  model: SubsessionModelIdentity & { name?: string };
  thinkingLevels: string[];
}

export interface StarterSubsessionDefaults {
  enabled: boolean;
  options: SubsessionModelOption[];
}

export interface SubsessionDefaultsStatus {
  selection: SubsessionModelSelection;
  editable: boolean;
}

export interface SubsessionDefaultsResponse extends SubsessionDefaultsStatus {
  options: SubsessionModelOption[];
}

export interface SessionStartRequest {
  cwd: string;
  subsessionDefaults?: SubsessionModelSelection;
}
```

Extend existing responses additively:

```ts
export interface SessionDefaultsResponse {
  model?: SessionModel;
  thinkingLevel: string;
  models: SessionModel[];
  thinkingLevels: string[];
  subsessions?: StarterSubsessionDefaults;
}

export interface SessionStatus {
  // existing fields stay unchanged
  subsessionDefaults?: SubsessionDefaultsStatus;
}
```

- A new server returns `subsessions: { enabled: false, options: [] }` when protocol support exists but tracked subsessions are disabled. Older peers omit `subsessions`.
- `SessionStatus.subsessionDefaults` is omitted for disabled/ineligible sessions, verified tracked children, older peers, and malformed state that cannot be safely projected.
- Active GET and PUT both return `SubsessionDefaultsResponse`; PUT returns only after durable append succeeds.
- The server computes `editable: !hasActiveWork(session)`. This captures tree navigation and server-side mutations that the browser cannot infer from the three boolean status fields.
- Capability support is exactly `sessions.subsessionModelSelection` and requires both web and sessiond components.
- HTTP routes are:

```text
GET /sessions/:sessionId/subsession-defaults?cwd=...
PUT /sessions/:sessionId/subsession-defaults
```

- PUT body is `{ cwd, selection }`.
- Starter POST body is `{ cwd }` for linked/default snapshotting or `{ cwd, subsessionDefaults }` for an independent exact draft.
- Route parsing trims and bounds request strings. Persisted-entry parsing rejects non-normalized data rather than repairing it.
- Semantic failures use these exact messages in focused tests:

```text
Subsession model is unavailable: RightCode-OpenAI/gpt-5.6-luna
Thinking level "medium" is not supported by RightCode-OpenAI/gpt-5.6-luna
Stop current session activity before changing subsession defaults
Invalid active-branch subsession defaults entry
Unsupported active-branch subsession defaults version: 2
```

## File Responsibility Map

### New files

- `src/server/sessions/subsessionConfiguration.ts` — exact domain values at the Pi boundary, persisted-entry parser/writer, model option projection, strict validation, and spawn precedence.
- `src/server/sessions/subsessionConfiguration.test.ts` — pure persistence/catalog/validation/precedence tests.
- `src/server/sessions/piSessionService.runtimeOptions.test.ts` — one-shot initial model/thinking runtime plumbing.
- `src/server/sessions/piSessionService.subsessionDefaults.test.ts` — parent initialization, status, branch, active update, and gating behavior.
- `src/client/src/subsessionDefaultsDraft.ts` — pure linked/independent/incomplete draft state.
- `src/client/src/subsessionDefaultsDraft.test.ts` — pure starter transition and submission tests.
- `src/client/src/api/parsers.subsessionDefaults.test.ts` — focused rolling-compatible transport parser tests.
- `src/client/src/controllers/sessionController.subsessionDefaults.test.ts` — selected-session GET/PUT and start outcome orchestration.
- `src/client/src/components/SubsessionDefaultsControl.ts` — controlled accessible desktop popover/mobile sheet.
- `src/client/src/components/SubsessionDefaultsControl.test.ts` — focused `happy-dom` interaction, focus, and accessibility tests.
- `src/client/src/components/PiWebUiApp.subsessionDefaults.test.ts` — starter and active composer orchestration/capability tests.
- `.changeset/exact-subsession-model-selection.md` — patch release note.

### Existing files with focused changes

- `src/shared/apiTypes.ts` — exact transport values, bounds, starter/status fields, and capability literal.
- `src/shared/capabilities.ts` — two-runtime capability negotiation.
- `src/shared/federatedRoutes.ts` — remote GET/PUT allowlist.
- `src/server/sessions/sessionDefaultsService.ts` — additive starter availability/options.
- `src/server/sessions/piSessionService.ts` — one-shot thinking, initialization, active defaults service methods, status projection, and spawn resolution.
- `src/server/sessions/spawnSubsessionTool.ts` — optional atomic input and resolved result details.
- `src/server/sessions/sessionService.ts` / `sessionRoutes.ts` — route-facing methods and strict request parsing.
- `src/server/sessiond.ts` — one shared `SubsessionConfiguration` instance injected into defaults/session services.
- `src/client/src/api/parsers.ts` / `clients.ts` / `api.ts` — parsers, requests, and exports.
- `src/client/src/controllers/sessionController.ts` — guarded selected-session reads/writes and recoverable starter outcomes.
- `src/client/src/components/PromptEditor.ts` / `promptEditorIcons.ts` / `shared.ts` — placement, send blocking, restoration, and responsive layout glue.
- `src/client/src/components/PiWebUiApp.ts` — private starter/active UI state, capability gating, stale guards, and composer wiring.
- Existing focused tests named in each task — preserve nearby contracts without broad fixture rewrites.
- `docs/config.md` / `docs/config.html` — synchronized user-facing tracked-subsessions behavior.

---

### Task 1: Add Exact Shared Values and Rolling-Compatible Parsers

**Files:**
- Modify: `src/shared/apiTypes.ts:634-709,810-838`
- Modify: `src/client/src/api/parsers.ts:242-260,637-660`
- Modify: `src/client/src/api.ts:1-7`
- Create: `src/client/src/api/parsers.subsessionDefaults.test.ts`

**Interfaces:**
- Consumes: Existing `SessionModel`, `SessionDefaultsResponse`, and `SessionStatus` wire contracts.
- Produces: The constants and exact types in **Ratified Transport and Validation Decisions**, plus `parseSubsessionDefaultsResponse(value)` for Tasks 9–14.

- [ ] **Step 1: Write failing parser tests for exact nested values and old-peer omission**

Create tests with concrete slash-containing IDs and a future thinking string:

```ts
import { describe, expect, it } from "vitest";
import {
  parseSessionDefaultsResponse,
  parseSessionStatus,
  parseSubsessionDefaultsResponse,
} from "./parsers";

const selection = {
  model: { provider: "RightCode-OpenAI", id: "org/gpt-5.6-luna" },
  thinkingLevel: "future-ultra",
};

it("parses exact starter and active subsession contracts", () => {
  expect(parseSessionDefaultsResponse({
    thinkingLevel: "off",
    models: [],
    thinkingLevels: ["off"],
    subsessions: {
      enabled: true,
      options: [{ model: { ...selection.model, name: "Luna" }, thinkingLevels: ["off", "future-ultra"] }],
    },
  }).subsessions).toEqual({
    enabled: true,
    options: [{ model: { ...selection.model, name: "Luna" }, thinkingLevels: ["off", "future-ultra"] }],
  });

  expect(parseSubsessionDefaultsResponse({ selection, editable: false, options: [] }))
    .toEqual({ selection, editable: false, options: [] });
});

it("preserves omission from older peers", () => {
  expect(parseSessionDefaultsResponse({
    thinkingLevel: "off",
    models: [],
    thinkingLevels: ["off"],
  })).not.toHaveProperty("subsessions");
  expect(parseSessionStatus(baseStatus())).not.toHaveProperty("subsessionDefaults");
});

it("rejects partial exact identities", () => {
  expect(() => parseSubsessionDefaultsResponse({
    selection: { model: { provider: "RightCode-OpenAI" }, thinkingLevel: "medium" },
    editable: true,
    options: [],
  })).toThrow();
});
```

Define `baseStatus()` locally with the required existing status fields; do not import a magical shared fixture.

- [ ] **Step 2: Run the parser tests and observe the missing export/field failures**

Run:

```bash
npm test -- --run src/client/src/api/parsers.subsessionDefaults.test.ts
```

Expected: FAIL because `parseSubsessionDefaultsResponse` and the additive parser fields do not exist.

- [ ] **Step 3: Add the exact shared interfaces and parser helpers**

Add the ratified constants/types to `apiTypes.ts`. In `parsers.ts`, implement strict response parsing without a closed thinking enum:

```ts
function parseSubsessionModelIdentity(value: unknown): SubsessionModelIdentity {
  const record = requireRecord(value);
  return {
    provider: requireBoundedNonBlankString(record, "provider", SUBSESSION_PROVIDER_MAX_LENGTH),
    id: requireBoundedNonBlankString(record, "id", SUBSESSION_MODEL_ID_MAX_LENGTH),
  };
}

function requireBoundedNonBlankString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = requireNonBlankString(record, key);
  if (value.length > maxLength) throw new Error(`String field exceeds limit: ${key}`);
  return value;
}

function parseSubsessionModelSelection(value: unknown): SubsessionModelSelection {
  const record = requireRecord(value);
  return {
    model: parseSubsessionModelIdentity(record["model"]),
    thinkingLevel: requireBoundedNonBlankString(
      record,
      "thinkingLevel",
      SUBSESSION_THINKING_LEVEL_MAX_LENGTH,
    ),
  };
}

function parseSubsessionModelOption(value: unknown): SubsessionModelOption {
  const record = requireRecord(value);
  const modelRecord = requireRecord(record["model"]);
  return {
    model: {
      ...parseSubsessionModelIdentity(modelRecord),
      ...optionalField("name", optionalString(modelRecord, "name")),
    },
    thinkingLevels: arrayOfNonBlankString(record["thinkingLevels"], "thinkingLevels"),
  };
}
```

Parse `subsessions`, `subsessionDefaults`, and `editable` only when present. Re-export all new public types from `src/client/src/api.ts`.

- [ ] **Step 4: Run focused parser tests and typecheck**

Run:

```bash
npm test -- --run \
  src/client/src/api/parsers.subsessionDefaults.test.ts \
  src/client/src/api/parsers.test.ts
npm run typecheck
```

Expected: PASS; old responses remain accepted and `future-ultra` remains a string.

- [ ] **Step 5: Commit the shared transport foundation**

```bash
git add src/shared/apiTypes.ts src/client/src/api/parsers.ts src/client/src/api.ts src/client/src/api/parsers.subsessionDefaults.test.ts
git commit -m "feat(sessions): add exact subsession selection contracts"
```

---

### Task 2: Build the Focused Server Subsession Configuration Module

**Files:**
- Create: `src/server/sessions/subsessionConfiguration.ts`
- Create: `src/server/sessions/subsessionConfiguration.test.ts`

**Interfaces:**
- Consumes: `SubsessionModelSelection`, `SubsessionModelOption`, shared bounds, Pi `ModelRuntime.getAvailableSnapshot()`, and `getSupportedThinkingLevels()`.
- Produces:

```ts
export const SUBSESSION_DEFAULTS_CUSTOM_TYPE = "pi-webui.subsession.defaults";

export interface ResolvedSubsessionConfiguration {
  selection: SubsessionModelSelection;
  model: Model<Api>;
  thinkingLevel: ClientThinkingLevel;
}

export type SubsessionDefaultsInspection =
  | { kind: "selection"; source: "persisted" | "legacy"; selection: SubsessionModelSelection }
  | { kind: "invalid"; error: Error };

export class SubsessionConfiguration {
  inspect(parent: SubsessionParentState): SubsessionDefaultsInspection;
  projectOptions(models: readonly Model<Api>[]): SubsessionModelOption[];
  listOptions(): Promise<SubsessionModelOption[]>;
  validate(selection: SubsessionModelSelection): Promise<ResolvedSubsessionConfiguration>;
  resolveSpawn(input: { parent: SubsessionParentState; override?: SubsessionModelSelection }): Promise<ResolvedSubsessionConfiguration>;
  append(manager: SubsessionDefaultsEntryWriter, selection: SubsessionModelSelection): string;
}

export function parseSubsessionModelSelection(value: unknown, fieldName: string): SubsessionModelSelection;
```

- [ ] **Step 1: Write failing persistence, validation, and precedence tests**

Cover all of these scenarios in the new test file:

```ts
it("uses only the latest matching entry on the active branch", () => {
  const inspection = configuration.inspect(parent({ branch: [
    defaultsEntry(validSelection("model-a", "low")),
    { type: "message", message: { role: "user", content: "branch" } },
    defaultsEntry(validSelection("org/model-b", "medium")),
  ] }));
  expect(inspection).toEqual({
    kind: "selection",
    source: "persisted",
    selection: validSelection("org/model-b", "medium"),
  });
});

it("fails closed on the malformed latest matching entry", () => {
  const inspection = configuration.inspect(parent({ branch: [
    defaultsEntry(validSelection("model-a", "low")),
    { type: "custom", customType: SUBSESSION_DEFAULTS_CUSTOM_TYPE, data: { version: 1, model: {} } },
  ] }));
  expect(inspection).toMatchObject({ kind: "invalid" });
  expect(inspection.kind === "invalid" ? inspection.error.message : "")
    .toBe("Invalid active-branch subsession defaults entry");
});

it("lets a complete override bypass invalid persisted state", async () => {
  await expect(configuration.resolveSpawn({
    parent: parent({ branch: [unsupportedVersionEntry(2)] }),
    override: validSelection("model-a", "low"),
  })).resolves.toMatchObject({ selection: validSelection("model-a", "low") });
});
```

Also test append shape, legacy fallback, missing parent model, no-network refresh, exact authenticated options, unavailable model, unsupported thinking, bounds/trim behavior, and slash-containing IDs.

- [ ] **Step 2: Run the new tests and observe the missing module failure**

```bash
npm test -- --run src/server/sessions/subsessionConfiguration.test.ts
```

Expected: FAIL because `subsessionConfiguration.ts` does not exist.

- [ ] **Step 3: Implement the deep module with injected model/thinking seams**

Use narrow dependencies:

```ts
export interface SubsessionConfigurationModelRuntime {
  refresh(options: { allowNetwork: false }): Promise<unknown>;
  getAvailableSnapshot(): readonly Model<Api>[];
}

export interface SubsessionConfigurationDependencies {
  modelRuntime: SubsessionConfigurationModelRuntime;
  supportedThinkingLevels?: (model: Model<Api>) => readonly ClientThinkingLevel[];
}
```

Implementation invariants:

1. Scan `getBranch()` backward and stop at the first matching custom entry.
2. Never consult `getEntries()` for defaults.
3. Treat malformed data and versions other than `1` as authoritative errors.
4. Reject unexpected request/persisted selection fields rather than accepting hidden aliases or secret-bearing data.
5. Build the legacy value only when no matching entry exists.
6. Refresh exactly with `{ allowNetwork: false }` and search only `getAvailableSnapshot()`.
7. Let `projectOptions(models)` reuse a caller-owned authenticated snapshot; let `listOptions()` refresh once and delegate to that pure projection.
8. Match a wire thinking string against the selected model's returned levels and retain the matched typed value.
9. `append()` writes only `{ version: 1, model: {provider,id}, thinkingLevel }` and does not catch errors.
10. `resolveSpawn()` does not inspect persisted state when a complete override exists.

- [ ] **Step 4: Run focused tests, lint, and typecheck**

```bash
npm test -- --run src/server/sessions/subsessionConfiguration.test.ts
npx eslint src/server/sessions/subsessionConfiguration.ts src/server/sessions/subsessionConfiguration.test.ts
npm run typecheck
```

Expected: PASS with exact error assertions and no fallback/clamping.

- [ ] **Step 5: Commit the server domain module**

```bash
git add src/server/sessions/subsessionConfiguration.ts src/server/sessions/subsessionConfiguration.test.ts
git commit -m "feat(sessions): add exact subsession configuration core"
```

---

### Task 3: Expose Starter Availability and Exact Model Options

**Files:**
- Modify: `src/server/sessions/sessionDefaultsService.ts:17-128`
- Modify: `src/server/sessions/sessionDefaultsService.test.ts`
- Modify: `src/server/sessions/sessionDefaultsRoutes.test.ts`
- Modify: `src/server/sessiond.ts:47-103`

**Interfaces:**
- Consumes: `SubsessionConfiguration.projectOptions()` from Task 2 and the authenticated model snapshot already loaded by `SessionDefaultsService`.
- Produces: `SessionDefaultsResponse.subsessions` with enabled state and model-specific thinking options, without a second model-runtime refresh.

- [ ] **Step 1: Add failing enabled/disabled starter response tests**

Extend the service harness with a `subsessionsEnabled` boolean and injected `listOptions` collaborator:

```ts
it("adds exact child options when tracked subsessions are enabled", async () => {
  const option = {
    model: { provider: "RightCode-OpenAI", id: "org/gpt-5.6-luna", name: "Luna" },
    thinkingLevels: ["off", "medium"],
  };
  const harness = createHarness({
    model: testModel(),
    thinkingLevel: "high",
    subsessionsEnabled: true,
    subsessionOptions: [option],
  });

  await expect(harness.service.read("/workspace")).resolves.toMatchObject({
    subsessions: { enabled: true, options: [option] },
  });
});

it("reports disabled support without loading child options", async () => {
  const harness = createHarness({
    model: testModel(),
    thinkingLevel: "off",
    subsessionsEnabled: false,
  });
  await expect(harness.service.read("/workspace")).resolves.toMatchObject({
    subsessions: { enabled: false, options: [] },
  });
  expect(harness.listOptions).not.toHaveBeenCalled();
});
```

Update the route fixture to prove the additive response passes through unchanged; no new starter route is needed.

- [ ] **Step 2: Run focused tests and observe the missing additive field**

```bash
npm test -- --run \
  src/server/sessions/sessionDefaultsService.test.ts \
  src/server/sessions/sessionDefaultsRoutes.test.ts
```

Expected: FAIL because responses have no `subsessions` field.

- [ ] **Step 3: Inject one shared configuration object in sessiond**

Construct it once after `auth.runtime` exists:

```ts
const subsessionConfiguration = new SubsessionConfiguration({ modelRuntime: auth.runtime });
const subsessionsEnabled = spawnTargets !== undefined && config.subsessions;
```

Pass both values to `SessionDefaultsService`. Task 5 will pass the same object to `PiSessionService`; do not create a second model-catalog policy.

- [ ] **Step 4: Add the additive response without changing ordinary Pi default behavior**

Keep existing parent-default clamping untouched. Project child options from the `models` array already returned by `availableModels()`:

```ts
private subsessions(models: readonly DefaultModel[]): StarterSubsessionDefaults {
  if (!this.deps.subsessionsEnabled) return { enabled: false, options: [] };
  return {
    enabled: true,
    options: this.deps.subsessionConfiguration.projectOptions(models),
  };
}
```

Have both `read()` and `update()` include the current additive state. Do not refresh the model runtime twice, and do not mutate child draft/default persistence here.

- [ ] **Step 5: Verify service, route, and type contracts**

```bash
npm test -- --run \
  src/server/sessions/sessionDefaultsService.test.ts \
  src/server/sessions/sessionDefaultsRoutes.test.ts
npm run typecheck
```

Expected: PASS; ordinary parent model/thinking tests remain unchanged.

- [ ] **Step 6: Commit starter catalog support**

```bash
git add src/server/sessiond.ts src/server/sessions/sessionDefaultsService.ts src/server/sessions/sessionDefaultsService.test.ts src/server/sessions/sessionDefaultsRoutes.test.ts
git commit -m "feat(sessions): expose exact child options in starter defaults"
```

---

### Task 4: Carry Initial Thinking Through One-Shot Runtime Creation

**Files:**
- Modify: `src/server/sessions/piSessionService.ts:197-204,392-395,530-615,1000-1012,2451-2464`
- Create: `src/server/sessions/piSessionService.runtimeOptions.test.ts`
- Modify: `src/server/sessions/piSessionService.testSupport.ts`

**Interfaces:**
- Consumes: Existing `AgentModel` and `ClientThinkingLevel`.
- Produces: `initialThinkingLevel?: ClientThinkingLevel` beside every current `initialModel` option, consumed exactly once.

- [ ] **Step 1: Write failing one-shot runtime tests**

Test the retained factory twice:

```ts
it("forwards model and thinking once", async () => {
  const calls: unknown[] = [];
  const createRuntime = vi.fn((options) => {
    calls.push(options);
    return Promise.resolve(fakeSdkRuntime());
  });
  const wrapped = createRuntimeWithOneShotSessionOptions(createRuntime, {
    initialModel: testModel(),
    initialThinkingLevel: "high",
    delegationToolsEnabled: false,
  });

  await wrapped(baseRuntimeOptions());
  await wrapped(baseRuntimeOptions());

  expect(calls[0]).toMatchObject({
    initialModel: testModel(),
    initialThinkingLevel: "high",
    delegationToolsEnabled: false,
  });
  expect(calls[1]).not.toHaveProperty("initialModel");
  expect(calls[1]).not.toHaveProperty("initialThinkingLevel");
});
```

Also verify the default runtime factory maps `initialThinkingLevel` to Pi's `thinkingLevel` option. Export the narrow helper for testing rather than using reflection.

- [ ] **Step 2: Run the test and observe missing `initialThinkingLevel`**

```bash
npm test -- --run src/server/sessions/piSessionService.runtimeOptions.test.ts
```

Expected: FAIL because the option is absent from the chain.

- [ ] **Step 3: Change the one-shot helper to an object argument**

Use this signature to keep the atomic values adjacent:

```ts
export function createRuntimeWithOneShotSessionOptions(
  createRuntime: PiWebUiCreateAgentSessionRuntimeFactory,
  oneShot: {
    initialModel?: AgentModel;
    initialThinkingLevel?: ClientThinkingLevel;
    delegationToolsEnabled: boolean;
  },
): CreateAgentSessionRuntimeFactory;
```

Clear all pending one-shot values before the first `await`, and pass:

```ts
createAgentSessionFromServices({
  services,
  sessionManager,
  customTools,
  ...(initialModel === undefined ? {} : { model: initialModel }),
  ...(initialThinkingLevel === undefined ? {} : { thinkingLevel: initialThinkingLevel }),
});
```

- [ ] **Step 4: Run runtime, spawn-session regression, and type checks**

```bash
npm test -- --run \
  src/server/sessions/piSessionService.runtimeOptions.test.ts \
  src/server/sessions/piSessionService.spawnSession.test.ts \
  src/server/sessions/piSessionService.lifecycle.test.ts
npm run typecheck
```

Expected: PASS; independent `spawn_session` still inherits only its existing model input.

- [ ] **Step 5: Commit runtime thinking plumbing**

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.runtimeOptions.test.ts src/server/sessions/piSessionService.testSupport.ts
git commit -m "feat(sessions): pass initial thinking into child runtimes"
```

---

### Task 5: Initialize and Project Parent Subsession Defaults

**Files:**
- Modify: `src/server/sessions/piSessionService.ts:392-395,734-797,1000-1031,2451-2567,3150-3193`
- Modify: `src/server/sessiond.ts:47-91`
- Create: `src/server/sessions/piSessionService.subsessionDefaults.test.ts`
- Modify: `src/server/sessions/piSessionService.testSupport.ts`

**Interfaces:**
- Consumes: `SubsessionConfiguration.inspect()`, `.validate()`, and `.append()`; runtime thinking from Task 4.
- Produces: New-parent exact entry before activation/publication and synchronous `SessionStatus.subsessionDefaults` projection.

- [ ] **Step 1: Write failing initialization and status tests**

Include concrete tests for:

1. Linked/default creation snapshots the runtime's actual model and thinking.
2. Explicit independent selection is validated before runtime creation.
3. The custom entry exists before initial status and `session.created` publication.
4. Append failure rejects creation, aborts/disposes the candidate runtime, and publishes no `session.created`.
5. Existing parent with no entry projects the current legacy fallback.
6. Later parent model/thinking changes do not mutate a persisted child default.
7. Latest valid active-branch entry projects even if its model later becomes unavailable.
8. Malformed latest entry omits the additive status field rather than projecting stale fallback.
9. Verified tracked child status omits the field.
10. Disabled tracked subsessions omit the field.

Use a local branch-aware manager fixture whose `appendCustomEntry()` pushes a custom entry into the active branch. Do not make every global `fakeSessionManager()` silently persistent.

- [ ] **Step 2: Run the new test and observe absent initialization/status**

```bash
npm test -- --run src/server/sessions/piSessionService.subsessionDefaults.test.ts
```

Expected: FAIL because no defaults entry is appended and status has no additive field.

- [ ] **Step 3: Add explicit initialization state inside `create()`**

Use a discriminated internal option:

```ts
type InitialSubsessionDefaults =
  | { kind: "snapshot-current-session" }
  | { kind: "selection"; selection: SubsessionModelSelection };
```

`startSession()` behavior:

- If the feature is disabled and an explicit selection was supplied, reject instead of ignoring it.
- If an explicit selection exists, validate it before creating the runtime, then pass `{ kind: "selection" }`.
- Otherwise, for a newly created eligible non-tracked parent, pass `{ kind: "snapshot-current-session" }`.
- Opening an existing session passes no initializer; legacy sessions are not silently migrated.
- Tracked-child creation passes no initializer.

Inside `create()`'s existing cleanup `try` block, append before `active.set()` and the initial `publishStatus()`. This ensures append failure uses existing abort/dispose cleanup.

- [ ] **Step 4: Retain server-owned delegation eligibility on the active record**

Define a focused active type:

```ts
interface PiActiveSession extends ActiveSession<PiSessionRuntime> {
  delegationToolsEnabled: boolean;
}
```

Store the value computed in `create()`. Use it with the effective feature flag to decide whether status may expose defaults. Do not infer tracked-child state from a generic `parentSessionPath`.

- [ ] **Step 5: Project selection and server-authoritative editability**

When eligible:

```ts
subsessionDefaults: {
  selection,
  editable: !this.hasActiveWork(session),
}
```

Use `SubsessionConfiguration.inspect()` synchronously. On `kind: "invalid"`, omit the optional field without falling back; GET/spawn will surface the error later. Keep options out of status.

- [ ] **Step 6: Verify parent initialization, branch regressions, and lifecycle cleanup**

```bash
npm test -- --run \
  src/server/sessions/piSessionService.subsessionDefaults.test.ts \
  src/server/sessions/piSessionService.tree.test.ts \
  src/server/sessions/piSessionService.delegationTools.test.ts \
  src/server/sessions/piSessionService.lifecycle.test.ts
npm run typecheck
```

Expected: PASS; tracked child recursive delegation remains disabled.

- [ ] **Step 7: Commit parent persistence and status projection**

```bash
git add src/server/sessiond.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.subsessionDefaults.test.ts src/server/sessions/piSessionService.testSupport.ts
git commit -m "feat(sessions): persist parent child-runtime defaults"
```

---

### Task 6: Add Active Parent Read and Update Service Methods

**Files:**
- Modify: `src/server/sessions/piSessionService.ts:1439-1537,3013-3110,3150-3193`
- Modify: `src/server/sessions/piSessionService.subsessionDefaults.test.ts`

**Interfaces:**
- Consumes: Parent status eligibility from Task 5 and `SubsessionConfiguration.listOptions()/validate()/append()`.
- Produces:

```ts
subsessionDefaults(ref: PiSessionLookup): Promise<SubsessionDefaultsResponse>;
setSubsessionDefaults(ref: PiSessionLookup, selection: SubsessionModelSelection): Promise<SubsessionDefaultsResponse>;
```

- [ ] **Step 1: Add failing active read/update tests**

Test:

- GET returns persisted/legacy selection, current `editable`, and fresh exact options.
- Valid-but-stale saved identity remains visible while options exclude it.
- PUT does not append until model refresh/validation succeeds.
- PUT appends synchronously through `runSessionEntryMutation()` and publishes status only afterward.
- Streaming, compaction, bash, pending messages, another entry mutation, tree-exclusive work, and tree navigation each reject with the exact busy message.
- A prompt that starts while catalog refresh is deferred is caught by the post-refresh busy recheck.
- Archived sessions retain the existing read-only error.
- Verified tracked children and disabled configurations reject as unavailable.
- Failed append leaves the previously confirmed selection authoritative.

- [ ] **Step 2: Run focused tests and observe missing service methods**

```bash
npm test -- --run \
  src/server/sessions/piSessionService.subsessionDefaults.test.ts \
  src/server/sessions/piSessionService.tree.test.ts
```

Expected: FAIL with `service.subsessionDefaults is not a function` and `service.setSubsessionDefaults is not a function`.

- [ ] **Step 3: Implement read without validating away stale saved state**

Read the active branch with `inspect()`, throw its exact error on invalid state, and return:

```ts
{
  selection: inspection.selection,
  editable: !this.hasActiveWork(session),
  options: await this.subsessionConfiguration.listOptions(),
}
```

Recheck exact active session identity after the asynchronous option load before returning.

- [ ] **Step 4: Implement update with a post-refresh race check**

Use this order:

```text
assert writable and eligible
  → capture exact active session
  → validate exact pair (awaits no-network refresh)
  → reacquire/check the same current active session
  → reject if hasActiveWork(session)
  → runSessionEntryMutation(... append synchronously ...)
  → publish confirmed status
  → return confirmed selection/editability/options
```

Do not add a silent queue, clamp, fallback, or optimistic append.

- [ ] **Step 5: Verify active mutation and tree-race coverage**

```bash
npm test -- --run \
  src/server/sessions/piSessionService.subsessionDefaults.test.ts \
  src/server/sessions/piSessionService.tree.test.ts
npm run typecheck
```

Expected: PASS with no entry written on validation/busy/persistence failure.

- [ ] **Step 6: Commit active service behavior**

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.subsessionDefaults.test.ts
git commit -m "feat(sessions): update active subsession defaults"
```

---

### Task 7: Resolve Spawn Defaults and Create Children With Exact Thinking

**Files:**
- Modify: `src/server/sessions/piSessionService.ts:1057-1083`
- Modify: `src/server/sessions/piSessionService.spawnSubsession.test.ts`
- Modify: `src/server/sessions/piSessionService.unread.test.ts`
- Modify: `src/server/sessions/piSessionService.delegationTools.test.ts`
- Modify: `src/server/sessions/piSessionService.testSupport.ts`

**Interfaces:**
- Consumes: `SubsessionConfiguration.resolveSpawn()` and runtime model/thinking options.
- Produces:

```ts
export interface SpawnSubsessionInvocation {
  spawningCwd: string;
  parentSessionId: string;
  parentSessionFile: string | undefined;
  prompt: string;
  cwd: string | undefined;
  configuration?: SubsessionModelSelection;
}

export interface SpawnSubsessionResult {
  sessionId: string;
  cwd: string;
  configuration: SubsessionModelSelection;
}
```

- [ ] **Step 1: Add an authenticated model-runtime test helper**

The existing shared `testModelRuntime` has no configured credentials, so its authenticated available snapshot is intentionally empty. Add a helper based on the existing credential seam:

```ts
export async function createAuthenticatedTestModelRuntime(): Promise<ModelRuntime> {
  const credentials = new InMemoryCredentialStore();
  await seedCredential(credentials, TEST_MODEL_PROVIDER, { type: "api_key", key: "sk-test" });
  return createTestModelRuntime(credentials);
}
```

Use it only in strict availability tests; do not weaken production validation to satisfy unauthenticated fixtures.

- [ ] **Step 2: Write failing spawn precedence and no-stray-child tests**

Cover:

1. No override uses latest active-branch defaults.
2. Exact override applies to one child and bypasses even an invalid persisted entry.
3. Override does not append/mutate parent defaults.
4. No matching entry uses current exact parent model/thinking.
5. Malformed persisted latest entry fails closed.
6. Removed model and unsupported thinking fail before runtime creation, `session.created`, lineage markers, or prompt delivery.
7. Child `CreateAgentRuntimeOptions` receives both exact initial values.
8. Result includes the resolved configuration.
9. A child already running retains the model/thinking it was created with after the parent default changes; only later children use the new default.
10. Existing workspace-error precedence and exact wording remain unchanged.
11. Existing unread exclusion, lineage, completion, transcript, archive, and recursive-delegation tests remain green.

- [ ] **Step 3: Run focused spawn tests and observe model-only behavior**

```bash
npm test -- --run \
  src/server/sessions/piSessionService.spawnSubsession.test.ts \
  src/server/sessions/piSessionService.unread.test.ts \
  src/server/sessions/piSessionService.delegationTools.test.ts
```

Expected: FAIL because `input.model` is still used and child thinking/result details are absent.

- [ ] **Step 4: Resolve exact live parent state before child creation**

After preserving existing target validation, locate the exact active parent by ID and supplied session file. Resolve:

```ts
const resolved = await this.subsessionConfiguration.resolveSpawn({
  parent: {
    sessionManager: parent.sessionManager,
    model: parent.model,
    thinkingLevel: parent.thinkingLevel,
  },
  ...(input.configuration === undefined ? {} : { override: input.configuration }),
});
```

Then call `startSession()` with `initialModel`, `initialThinkingLevel`, and tracked provenance. Validation must finish before this call.

- [ ] **Step 5: Return exact details while preserving lifecycle order**

Keep existing register/persist/prompt order after child creation and return:

```ts
return {
  sessionId: created.id,
  cwd: decision.cwd,
  configuration: resolved.selection,
};
```

Lineage marker persistence keeps its existing log-and-continue policy; defaults persistence remains strict.

- [ ] **Step 6: Verify focused and existing tracked-subsessions behavior**

```bash
npm test -- --run \
  src/server/sessions/piSessionService.spawnSubsession.test.ts \
  src/server/sessions/piSessionService.unread.test.ts \
  src/server/sessions/piSessionService.delegationTools.test.ts \
  src/server/sessions/spawnSubsessionTool.integration.test.ts
npm run typecheck
```

Expected: PASS with no child artifacts on exact-selection failure.

- [ ] **Step 7: Commit exact spawn resolution**

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.spawnSubsession.test.ts src/server/sessions/piSessionService.unread.test.ts src/server/sessions/piSessionService.delegationTools.test.ts src/server/sessions/piSessionService.testSupport.ts
git commit -m "feat(sessions): resolve exact tracked child configuration"
```

---

### Task 8: Extend `spawn_subsession` With an Optional Atomic Override

**Files:**
- Modify: `src/server/sessions/spawnSubsessionTool.ts:8-26,61-75,183-210`
- Modify: `src/server/sessions/spawnSubsessionTool.test.ts`
- Verify: `src/server/sessions/spawnSubsessionTool.integration.test.ts`

**Interfaces:**
- Consumes: Spawn invocation/result from Task 7 and shared bounds.
- Produces: Optional public `configuration` object; existing calls with only `prompt`/`cwd` remain valid.

- [ ] **Step 1: Write failing schema, forwarding, and result tests**

Add assertions that:

```ts
await spawnTool.execute("call", {
  prompt: "do it",
  configuration: {
    model: { provider: "RightCode-OpenAI", id: "org/gpt-5.6-luna" },
    thinkingLevel: "medium",
  },
}, undefined, undefined, context);

expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
  configuration: {
    model: { provider: "RightCode-OpenAI", id: "org/gpt-5.6-luna" },
    thinkingLevel: "medium",
  },
}));
```

Also inspect the TypeBox schema to ensure nested fields are required/bounded, legacy omission works, `ctx.model` is no longer forwarded, and result details/text report the resolved pair.

- [ ] **Step 2: Run tool tests and observe missing configuration support**

```bash
npm test -- --run \
  src/server/sessions/spawnSubsessionTool.test.ts \
  src/server/sessions/spawnSubsessionTool.integration.test.ts
```

Expected: FAIL because the schema and details have no configuration.

- [ ] **Step 3: Add the optional complete TypeBox object**

Use shared numeric limits:

```ts
configuration: Type.Optional(Type.Object({
  model: Type.Object({
    provider: Type.String({ minLength: 1, maxLength: SUBSESSION_PROVIDER_MAX_LENGTH }),
    id: Type.String({ minLength: 1, maxLength: SUBSESSION_MODEL_ID_MAX_LENGTH }),
  }, { additionalProperties: false }),
  thinkingLevel: Type.String({ minLength: 1, maxLength: SUBSESSION_THINKING_LEVEL_MAX_LENGTH }),
}, { additionalProperties: false }))
```

Pass the object through `parseSubsessionModelSelection()` so whitespace normalization and structural errors match HTTP behavior.

- [ ] **Step 4: Update model-facing success output**

Keep existing join guidance while exposing exact values, for example:

```text
Started tracked subsession child-1 in /repos/a-feature using RightCode-OpenAI/org/gpt-5.6-luna with thinking medium. Continue other work, then join with yield_to_subsessions; do not poll.
```

The structured details remain authoritative when slash-containing model IDs make prose visually ambiguous.

- [ ] **Step 5: Verify tool and agent-loop integration**

```bash
npm test -- --run \
  src/server/sessions/spawnSubsessionTool.test.ts \
  src/server/sessions/spawnSubsessionTool.integration.test.ts \
  src/server/sessions/piSessionService.spawnSubsession.test.ts
npm run typecheck
```

Expected: PASS; list/check/read/yield metadata remains unchanged.

- [ ] **Step 6: Commit the additive tool contract**

```bash
git add src/server/sessions/spawnSubsessionTool.ts src/server/sessions/spawnSubsessionTool.test.ts
git commit -m "feat(sessions): add exact tracked child overrides"
```

---

### Task 9: Add Session HTTP Routes and Federation Allowlisting

**Files:**
- Modify: `src/server/sessions/sessionService.ts:43-89`
- Modify: `src/server/sessions/sessionRoutes.ts:49-56,218-272,512-646`
- Modify: `src/server/sessions/sessionRoutes.test.ts`
- Modify: `src/shared/federatedRoutes.ts:66-108`
- Modify: `src/server/sessiond/sessionProxyRoutes.test.ts`
- Modify: `src/server/app.remoteProxy.test.ts`

**Interfaces:**
- Consumes: Service methods from Tasks 5–6 and `SessionStartRequest` from Task 1.
- Produces: Strict additive POST/GET/PUT contracts and remote route support.

Use this exact route-facing start signature:

```ts
start(
  cwd: string,
  options?: { subsessionDefaults?: SubsessionModelSelection },
): Promise<ClientSession>;
```

- [ ] **Step 1: Write failing start and active route tests**

Extend `CapturingRouteSessionService` with typed call arrays. Test:

```ts
const started = await routeApp.inject({
  method: "POST",
  url: "/sessions",
  payload: { cwd: "/repo", subsessionDefaults: selection },
});
expect(routeService.startCalls).toEqual([{
  cwd: resolve("/repo"),
  options: { subsessionDefaults: selection },
}]);

const read = await routeApp.inject({
  method: "GET",
  url: `/sessions/session-1/subsession-defaults?cwd=${encodeURIComponent("/repo")}`,
});
const update = await routeApp.inject({
  method: "PUT",
  url: "/sessions/session-1/subsession-defaults",
  payload: { cwd: "/repo", selection },
});
expect([read.statusCode, update.statusCode]).toEqual([200, 200]);
```

Add malformed/partial/blank/oversized/extra-field cases, future thinking strings, legacy `{cwd}` start, 404 missing session, and 400 semantic/busy errors.

- [ ] **Step 2: Run route tests and observe missing forwarding/routes**

```bash
npm test -- --run src/server/sessions/sessionRoutes.test.ts
```

Expected: FAIL because POST ignores the selection and active routes return 404.

- [ ] **Step 3: Add strict structural parsing and service calls**

- Parse `subsessionDefaults` only when present on POST.
- Accept one complete selection, not independent optional model/thinking fields.
- Reuse `parseSubsessionModelSelection()` for nested structure and bounds.
- Add active routes next to model/thinking routes.
- Use `sessionLookupFromQuery()`, `sessionLookupFromBody()`, and `mutationErrorStatus()`.
- Keep existing 400/404 route taxonomy.

- [ ] **Step 4: Add exact remote federation entries**

Add only:

```ts
{ method: "GET", path: "/sessions/:sessionId/subsession-defaults" },
{ method: "PUT", path: "/sessions/:sessionId/subsession-defaults" },
```

No new WebSocket or special long timeout is needed.

- [ ] **Step 5: Characterize local wildcard and remote exact proxy behavior**

In `sessionProxyRoutes.test.ts`, prove local GET/PUT prefix/query/body/status forwarding. The production local proxy wildcard should need no edit. In `app.remoteProxy.test.ts`, prove remote GET/PUT are registered only after the shared allowlist change.

- [ ] **Step 6: Run route/proxy tests and typecheck**

```bash
npm test -- --run \
  src/server/sessions/sessionRoutes.test.ts \
  src/server/sessiond/sessionProxyRoutes.test.ts \
  src/server/app.remoteProxy.test.ts
npm run typecheck
```

Expected: PASS for local and remote machine paths.

- [ ] **Step 7: Commit additive HTTP/federation support**

```bash
git add src/server/sessions/sessionService.ts src/server/sessions/sessionRoutes.ts src/server/sessions/sessionRoutes.test.ts src/shared/federatedRoutes.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.remoteProxy.test.ts
git commit -m "feat(api): add subsession defaults routes"
```

---

### Task 10: Model Starter Linked/Independent State as Pure Data

**Files:**
- Create: `src/client/src/subsessionDefaultsDraft.ts`
- Create: `src/client/src/subsessionDefaultsDraft.test.ts`

**Interfaces:**
- Consumes: Exact shared selections/options.
- Produces:

```ts
export interface SubsessionModelSelectionDraft {
  model?: SubsessionModelIdentity;
  thinkingLevel?: string;
}

export type StarterSubsessionDraft =
  | { mode: "linked"; parentSelection: SubsessionModelSelection | undefined }
  | { mode: "independent"; selection: SubsessionModelSelectionDraft };

export type StarterSubsessionSubmission =
  | { ok: true; mode: "snapshot-parent" }
  | { ok: true; mode: "exact"; selection: SubsessionModelSelection }
  | { ok: false; error: string };

export function createStarterSubsessionDraft(parent: SubsessionModelSelection | undefined): StarterSubsessionDraft;
export function reduceStarterSubsessionDraft(state: StarterSubsessionDraft, event: StarterSubsessionDraftEvent): StarterSubsessionDraft;
export function starterSubsessionSubmission(state: StarterSubsessionDraft, options: readonly SubsessionModelOption[]): StarterSubsessionSubmission;
export function subsessionSelectionsEqual(left: SubsessionModelSelection | undefined, right: SubsessionModelSelection | undefined): boolean;
```

- [ ] **Step 1: Write failing pure transition tests**

Cover linked parent changes, detachment after either field, compatible/incompatible model changes, reset/relink, stale independent identity, unsupported thinking, linked snapshot projection, exact independent projection, and provider/ID/thinking equality.

A key assertion is:

```ts
expect(reduceStarterSubsessionDraft(independentHigh, {
  type: "select-model",
  option: { model: { provider: "p", id: "org/new" }, thinkingLevels: ["off"] },
})).toEqual({
  mode: "independent",
  selection: { model: { provider: "p", id: "org/new" }, thinkingLevel: undefined },
});
```

- [ ] **Step 2: Run the pure tests and observe missing module exports**

```bash
npm test -- --run src/client/src/subsessionDefaultsDraft.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement a reducer without side effects or fallback selection**

Rules:

- `parent-changed` updates only linked state.
- Either child edit returns independent state.
- A model edit preserves thinking only if the exact selected option supports it.
- Incompatibility clears thinking; never choose the first supported level.
- Linked submission always requests server snapshotting, even when the displayed parent pair is exact.
- Independent submission validates current exact option presence and thinking membership.
- Stale values remain visible in draft state while submission returns an actionable error.

- [ ] **Step 4: Verify pure behavior and lint**

```bash
npm test -- --run src/client/src/subsessionDefaultsDraft.test.ts
npx eslint src/client/src/subsessionDefaultsDraft.ts src/client/src/subsessionDefaultsDraft.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit pure starter state**

```bash
git add src/client/src/subsessionDefaultsDraft.ts src/client/src/subsessionDefaultsDraft.test.ts
git commit -m "feat(client): model subsession starter drafts"
```

---

### Task 11: Build the Accessible Responsive Lit Control

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/client/src/components/SubsessionDefaultsControl.ts`
- Create: `src/client/src/components/SubsessionDefaultsControl.test.ts`

**Interfaces:**
- Consumes: Pure draft values/events and exact shared options.
- Produces a controlled component contract:

```ts
export type SubsessionDefaultsControlState =
  | { available: false }
  | {
      available: true;
      open: boolean;
      editable: boolean;
      loading: boolean;
      saving: boolean;
      draft: SubsessionModelSelectionDraft;
      options: readonly SubsessionModelOption[];
      error?: string;
      presentation:
        | { mode: "starter"; linkedToParent: boolean }
        | {
            mode: "active";
            confirmedSelection: SubsessionModelSelection;
            parentSelection: SubsessionModelSelection | undefined;
          };
    };

export interface SubsessionDefaultsControlActions {
  onOpen(): void;
  onClose(): void;
  onModelChange(model: SubsessionModelIdentity): void;
  onThinkingLevelChange(level: string): void;
  onResetToParent(): void;
  onCopyCurrentSession(): void;
  onSave(): void;
}
```

- [ ] **Step 1: Install the focused DOM test environment**

```bash
npm install --save-dev happy-dom@^20.11.1
```

Keep the default suite in Node; put this at the top of only the new component test:

```ts
// @vitest-environment happy-dom
```

- [ ] **Step 2: Write failing real-DOM tests**

Interact through the custom element's shadow DOM, not TemplateResult internals. Test:

1. unavailable state renders no trigger;
2. exact accessible trigger label;
3. click opens the rendered dialog;
4. visible Model and Thinking level labels are associated with native selects;
5. slash-containing model identity reaches the callback as nested fields;
6. full provider/model is in accessible text/title despite visual truncation;
7. equal active pair renders icon only;
8. provider, ID, or thinking difference renders `Children: ...`;
9. incomplete/busy state disables Save while remaining inspectable;
10. errors use `role="alert"` and retain attempted values;
11. Escape closes and restores trigger focus;
12. desktop uses non-modal dialog behavior;
13. narrow `matchMedia("(max-width: 640px)")` uses modal sheet semantics with the same form;
14. media/outside-click listeners are cleaned up on disconnect.

- [ ] **Step 3: Run the DOM test and observe missing element/module**

```bash
npm test -- --run src/client/src/components/SubsessionDefaultsControl.test.ts
```

Expected: FAIL because the custom element is not registered.

- [ ] **Step 4: Implement controlled rendering and focus lifecycle**

- Use native `<select>` controls.
- Map option indices or JSON tuple keys back to nested identities; never split `provider/id`.
- Render a disabled synthetic option for a stale selected identity.
- Use `aria-haspopup="dialog"`, `aria-expanded`, and `aria-controls` on the trigger.
- Use one form template in a native `<dialog>`; call `show()` on desktop and `showModal()` on narrow screens.
- Restore focus after close/Escape and trap focus when modal.
- Keep confirmed active selection separate from local draft.
- Render Copy current session settings only in active mode and Reset to parent choice only in starter mode.

- [ ] **Step 5: Verify component behavior and lint**

```bash
npm test -- --run src/client/src/components/SubsessionDefaultsControl.test.ts
npx eslint src/client/src/components/SubsessionDefaultsControl.ts src/client/src/components/SubsessionDefaultsControl.test.ts
npm run typecheck
```

Expected: PASS without handler extraction.

- [ ] **Step 6: Commit the component and focused test dependency**

```bash
git add package.json package-lock.json src/client/src/components/SubsessionDefaultsControl.ts src/client/src/components/SubsessionDefaultsControl.test.ts
git commit -m "feat(client): add subsession defaults control"
```

---

### Task 12: Keep `PromptEditor` as Layout Glue and Make Starter Submission Recoverable

**Files:**
- Modify: `src/client/src/components/PromptEditor.ts:25-49,84-92,110-186,474-516`
- Modify: `src/client/src/components/promptEditorIcons.ts`
- Modify: `src/client/src/components/shared.ts:897-949`
- Modify: `src/client/src/components/PromptEditor.sessionConfiguration.test.ts`
- Modify: `src/client/src/components/PromptEditor.draft.test.ts`

**Interfaces:**
- Consumes: Controlled component state/actions from Task 11.
- Produces:

```ts
export interface PromptEditorSubmission {
  text: string;
  streamingBehavior?: "steer" | "followUp";
  attachments?: PromptAttachment[];
  delivery?: PromptAttachmentDelivery;
}

restoreSubmission(submission: PromptEditorSubmission): void;
```

Add `subsessionDefaultsControl`, `subsessionDefaultsActions`, `sendBlocked`, and `sendBlockedReason` properties.

- [ ] **Step 1: Write failing layout, blocking, restoration, and churn tests**

Test:

- the child control appears immediately after model/thinking controls;
- `sendBlocked` disables only Send and keyboard submission, not editing/attachments;
- blocked send leaves draft/attachments unchanged;
- `restoreSubmission()` restores text, full attachment objects, and delivery mode;
- child status selection/editability changes trigger render;
- token/cost-only status churn with semantically equal parent/child fields remains suppressed.

Template handler extraction remains limited to narrow placement/wiring assertions; component accessibility stays in Task 11's DOM suite.

- [ ] **Step 2: Run focused PromptEditor tests and observe missing properties/recovery**

```bash
npm test -- --run \
  src/client/src/components/PromptEditor.sessionConfiguration.test.ts \
  src/client/src/components/PromptEditor.draft.test.ts
```

Expected: FAIL because the control and recovery API do not exist.

- [ ] **Step 3: Render the controlled child component inside `.compact-status`**

Import/register the new component and pass state/actions only. Keep catalog/request logic out of `PromptEditor`.

- [ ] **Step 4: Delay reset until the send callback accepts the submission**

Allow the send callback to return `boolean | void | Promise<boolean | void>`. Capture the complete submission, await the callback, and reset only when the result is not `false`. `sendBlocked` returns before any mutation.

- [ ] **Step 5: Preserve render suppression semantically**

Extend equality to compare:

- parent provider/model/thinking;
- confirmed child provider/model/thinking;
- server `editable`;
- controlled open/loading/saving/error scalar state.

When the only changed properties are `status` and the child-control projection and both are semantically equal, skip the render.

- [ ] **Step 6: Verify focused editor and type behavior**

```bash
npm test -- --run \
  src/client/src/components/PromptEditor.sessionConfiguration.test.ts \
  src/client/src/components/PromptEditor.draft.test.ts
npx eslint src/client/src/components/PromptEditor.ts src/client/src/components/promptEditorIcons.ts src/client/src/components/shared.ts
npm run typecheck
```

Expected: PASS with attachment bytes retained by restoration.

- [ ] **Step 7: Commit the composer seam**

```bash
git add src/client/src/components/PromptEditor.ts src/client/src/components/promptEditorIcons.ts src/client/src/components/shared.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts src/client/src/components/PromptEditor.draft.test.ts
git commit -m "feat(client): place recoverable child defaults in composer"
```

---

### Task 13: Add Client Requests and Guarded `SessionController` Orchestration

**Files:**
- Modify: `src/client/src/api/clients.ts:79-126,279-330`
- Modify: `src/client/src/api/clients.test.ts`
- Modify: `src/client/src/api/federatedRouteContract.test.ts`
- Modify: `src/client/src/controllers/sessionController.ts:22-198,883-949,997-1059,1100-1221,1337-1472`
- Modify: `src/client/src/controllers/sessionController.testSupport.ts`
- Modify: `src/client/src/controllers/sessionController.pendingStarts.test.ts`
- Modify: `src/client/src/controllers/sessionController.sendQueue.test.ts`
- Create: `src/client/src/controllers/sessionController.subsessionDefaults.test.ts`

**Interfaces:**
- Consumes: HTTP contracts from Task 9 and exact values from Task 1.
- Produces:

```ts
export interface ClientStartSessionOptions {
  subsessionDefaults?: SubsessionModelSelection;
}

export type SessionStartOutcome =
  | { ok: true; session: SessionInfo }
  | { ok: false; error: string };

readSelectedSubsessionDefaults(): Promise<SubsessionDefaultsResponse | undefined>;
updateSelectedSubsessionDefaults(selection: SubsessionModelSelection): Promise<SubsessionDefaultsResponse | undefined>;
```

- [ ] **Step 1: Write failing API URL/body tests**

Assert:

- linked start body is `{ cwd }`;
- independent start body includes exact `subsessionDefaults`;
- active GET uses encoded machine/session and `URLSearchParams` cwd;
- active PUT uses `sessionPath()`/`sessionBody()` and `{ cwd, selection }`;
- nested deployment resolution occurs exactly once.

Add both calls to the federated route coverage test and assert no new socket.

- [ ] **Step 2: Write failing selected-session GET/PUT tests**

Test:

1. eligible selection makes one lazy GET;
2. archived/pending/status-omitted selections make no request;
3. generic `parentSessionPath` does not suppress server-declared eligibility;
4. machine/session change while GET is pending returns `undefined`;
5. PUT does not update status before confirmation;
6. confirmed PUT merges only `subsessionDefaults` into the newest status;
7. failed PUT rejects and leaves status unchanged;
8. selection/status eligibility change during PUT prevents stale application.

Use existing `selectionSeq`, `isCurrentSessionSelection()`, and exact machine/session identity guards.

- [ ] **Step 3: Write failing recoverable starter outcome tests**

Keep bare navigation `startSession()` failure behavior unchanged, but make `startSessionWithPrompt()` return a recoverable outcome. Test that its failure outcome retains the caller-owned text, attachment object references, and delivery mode while removing the temporary starter-prompt row so the start screen can reappear.

Do not serialize attachment base64 into `AppState` or local storage.

- [ ] **Step 4: Run focused client/controller tests and observe missing methods/signatures**

```bash
npm test -- --run \
  src/client/src/api/clients.test.ts \
  src/client/src/api/federatedRouteContract.test.ts \
  src/client/src/controllers/sessionController.subsessionDefaults.test.ts \
  src/client/src/controllers/sessionController.pendingStarts.test.ts \
  src/client/src/controllers/sessionController.sendQueue.test.ts
```

Expected: FAIL because API methods, guarded operations, and typed outcomes are absent.

- [ ] **Step 5: Implement API methods through existing URL helpers**

Use:

```ts
subsessionDefaults: (session, machineId = "local") =>
  request(sessionQueryPath(session, "subsession-defaults", machineId), parseSubsessionDefaultsResponse),

updateSubsessionDefaults: (session, selection, machineId = "local") =>
  request(sessionPath(session, "subsession-defaults", machineId), parseSubsessionDefaultsResponse, {
    method: "PUT",
    body: sessionBody(session, { selection }),
  }),
```

Extend `startSession()` without changing its existing first two arguments:

```ts
startSession(
  cwd: string,
  machineId = "local",
  options: ClientStartSessionOptions = {},
): Promise<SessionInfo>;
```

Existing callers that pass `(cwd, machineId)` remain source-compatible; new callers pass the exact selection as the third argument.

- [ ] **Step 6: Implement stale-safe controller methods without optimistic status**

Capture selected session, machine ID, and `selectionSeq` before each request. Return `undefined` on stale identity. Let server errors reject so the controlled form can display them locally.

For confirmed PUT, merge only:

```ts
const newest = this.getState().status;
if (newest !== undefined) {
  this.applyStatus({
    ...newest,
    subsessionDefaults: {
      selection: response.selection,
      editable: response.editable,
    },
  });
}
```

Never replace current token/cost/queue fields with a stale response snapshot.

- [ ] **Step 7: Implement recoverable starter-prompt failure separately from bare start**

- Bare `startSession()` keeps its discardable failed transient row.
- `startSessionWithPrompt()` uses a failure mode that removes the temporary row/queued preview and returns `{ ok: false, error }` without setting global `state.error`, allowing the starter to render again.
- The caller still owns the full submission object and restores it through `PromptEditor.restoreSubmission()` in Task 14.

- [ ] **Step 8: Verify client/controller/federation behavior**

```bash
npm test -- --run \
  src/client/src/api/clients.test.ts \
  src/client/src/api/federatedRouteContract.test.ts \
  src/client/src/controllers/sessionController.subsessionDefaults.test.ts \
  src/client/src/controllers/sessionController.pendingStarts.test.ts \
  src/client/src/controllers/sessionController.sendQueue.test.ts
npm run typecheck
```

Expected: PASS; no optimistic chip update and no lost attachment objects.

- [ ] **Step 9: Commit client transport/orchestration**

```bash
git add src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.testSupport.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.sendQueue.test.ts src/client/src/controllers/sessionController.subsessionDefaults.test.ts
git commit -m "feat(client): orchestrate exact child defaults"
```

---

### Task 14: Wire Starter and Active Composer UX, Then Advertise Capability

**Files:**
- Modify: `src/client/src/components/PiWebUiApp.ts:147-310,493-512,1010-1047,1196-1209,1334-1390,1741-1768,2306-2499,2898-2906`
- Modify: `src/client/src/components/PiWebUiApp.onboarding.test.ts`
- Create: `src/client/src/components/PiWebUiApp.subsessionDefaults.test.ts`
- Modify: `src/shared/apiTypes.ts:4-22`
- Modify: `src/shared/capabilities.ts:9-57`
- Modify: `src/shared/capabilities.test.ts`
- Modify: `src/server/app.machines.test.ts`

**Interfaces:**
- Consumes: Pure reducer, controlled component, recoverable controller outcome, and status response.
- Produces: Approved starter/active behavior gated by positively negotiated `sessions.subsessionModelSelection`.

- [ ] **Step 1: Write failing capability-negotiation tests**

Assert the literal, web/sessiond array membership, effective absence with either peer missing, effective presence with both peers, and unknown capability filtering.

Do not advertise the capability in production arrays until the complete server, routes, parsers, component, and controller paths from prior tasks exist.

- [ ] **Step 2: Write failing starter orchestration tests**

Cover:

1. healthy negotiated capability plus `subsessions.enabled: true` exposes the control;
2. missing/unhealthy runtime, old peer, disabled response, and omitted response hide it;
3. initial response creates linked draft;
4. ordinary parent model/thinking updates advance only linked draft;
5. child edits never call `updateSessionDefaults()`;
6. reset relinks to the newest parent pair;
7. linked start omits exact defaults;
8. independent valid start sends one atomic pair;
9. incomplete/stale independent state blocks only Send and keeps the composer editable;
10. same-scope out-of-order responses commit only the newest request;
11. machine/workspace change resets draft and invalidates requests;
12. failed POST restores exact text, attachment bytes, names, and delivery after `updateComplete`.

- [ ] **Step 3: Write failing active orchestration tests**

Cover:

1. status field plus capability renders the control;
2. archived/status-omitted/old-peer sessions omit it;
3. a generic parent-linked session remains eligible when the server includes the field;
4. rendering does not load options;
5. opening performs one lazy GET;
6. close/reopen and session/machine generations suppress stale responses;
7. icon-only versus summary chip uses exact provider, ID, and thinking equality;
8. model incompatibility clears thinking without replacement;
9. Save waits for confirmed PUT;
10. failure keeps form open, attempted draft intact, and alert visible;
11. Copy current session settings writes the latest exact parent pair;
12. server `editable: false` or a browser-local in-flight prompt upload keeps the form inspectable but disables mutation.

Use TemplateResult inspection only for the narrow `PiWebUiApp → PromptEditor` property/callback boundary. User interaction/accessibility remains covered by Task 11.

- [ ] **Step 4: Run app/capability tests and observe missing wiring**

```bash
npm test -- --run \
  src/shared/capabilities.test.ts \
  src/client/src/components/PiWebUiApp.onboarding.test.ts \
  src/client/src/components/PiWebUiApp.subsessionDefaults.test.ts
```

Expected: FAIL because the capability and composer projections are absent.

- [ ] **Step 5: Add private starter and active UI state with generations**

Keep outside `AppState`:

```ts
@state() private starterSubsessionDraft: StarterSubsessionDraft | undefined;
@state() private starterSubsessionError: string | undefined;
private starterSubsessionGeneration = 0;

@state() private activeSubsessionDefaultsUi: ActiveSubsessionDefaultsUi | undefined;
private activeSubsessionGeneration = 0;
```

Invalidate starter state on machine/workspace identity changes, including same workspace IDs on different machines. Invalidate active state whenever selected chat identity changes.

- [ ] **Step 6: Reconcile parent starter defaults without persisting child edits**

After each successful parent defaults load/update:

- derive an exact parent selection only when provider, ID, and thinking are present;
- initialize/reduce linked state with `parent-changed`;
- leave independent state untouched;
- pass `snapshot-parent` as omission and exact independent selection as POST options.

- [ ] **Step 7: Restore failed starter submission through the current editor**

Capture the complete `PromptEditorSubmission`, await `startSessionWithPrompt()`, and on failure:

```ts
this.starterSubsessionError = outcome.error;
await this.updateComplete;
this.promptEditor?.restoreSubmission(submission);
return false;
```

On success, clear the starter error and return true. Do not lose the user's independent child draft when a start fails.

- [ ] **Step 8: Orchestrate lazy active GET/PUT with two stale guards**

Use both `SessionController` identity checks and an app UI generation so an older same-session close/reopen response cannot overwrite the latest form. Keep confirmed status unchanged until PUT resolves.

- [ ] **Step 9: Add and advertise the capability only now**

Add:

```ts
sessionsSubsessionModelSelection: "sessions.subsessionModelSelection"
```

Include it in both runtime arrays and map it to `['web', 'sessiond']`. `PiWebUiApp` must require a healthy selected runtime and positively negotiated support even for local; there is no legacy local fallback.

- [ ] **Step 10: Verify app, capability, component, and churn behavior**

```bash
npm test -- --run \
  src/shared/capabilities.test.ts \
  src/server/app.machines.test.ts \
  src/client/src/components/PiWebUiApp.onboarding.test.ts \
  src/client/src/components/PiWebUiApp.subsessionDefaults.test.ts \
  src/client/src/components/SubsessionDefaultsControl.test.ts \
  src/client/src/components/PromptEditor.sessionConfiguration.test.ts
npm run typecheck
```

Expected: PASS; old peers never receive the new POST field.

- [ ] **Step 11: Commit complete UI and capability negotiation**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.onboarding.test.ts src/client/src/components/PiWebUiApp.subsessionDefaults.test.ts src/shared/apiTypes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts src/server/app.machines.test.ts
git commit -m "feat: configure exact tracked child models"
```

---

### Task 15: Document the Feature and Add the Patch Changeset

**Files:**
- Modify: `docs/config.md:215-229`
- Modify: `docs/config.html:624-668`
- Create: `.changeset/exact-subsession-model-selection.md`
- Do not modify: `README.md`
- Do not modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Final user-visible behavior from Tasks 1–14.
- Produces: Synchronized canonical documentation and release note.

- [ ] **Step 1: Update the Markdown tracked-subsessions section**

Document in user language:

- the compact starter and active parent controls;
- linked starter snapshot versus independently edited exact pair;
- active persistence and Copy current session settings;
- optional exact `spawn_subsession.configuration` example;
- model availability and supported-thinking validation;
- no silent fallback/clamping;
- controls hidden for tracked children, archived sessions, disabled config, and old peers;
- implementation installation requires restarting sessiond, while later selection changes apply immediately.

Include this copyable example:

```ts
spawn_subsession({
  prompt: "Implement the isolated task",
  cwd: "/workspace-feature",
  configuration: {
    model: { provider: "RightCode-OpenAI", id: "gpt-5.6-luna" },
    thinkingLevel: "medium",
  },
});
```

- [ ] **Step 2: Mirror the same claims in the HTML configuration page**

Keep headings and behavior synchronized without copying internal module/type details into user docs.

- [ ] **Step 3: Add the patch Changeset**

Create exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Add exact model and thinking defaults for tracked subsessions, including independent starter and active-session controls plus optional per-spawn overrides.
```

- [ ] **Step 4: Check docs consistency and release metadata**

```bash
rg -n "exact model|thinking|spawn_subsession|subsession" docs/config.md docs/config.html
npm run changelog:status
git diff --check
```

Expected: both canonical docs describe the same behavior; Changesets reports the patch fragment; README and CHANGELOG have no diff.

- [ ] **Step 5: Commit docs and release note**

```bash
git add docs/config.md docs/config.html .changeset/exact-subsession-model-selection.md
git commit -m "docs: document exact tracked child defaults"
```

---

### Task 16: Run Integrated Verification and Manual Acceptance

**Files:**
- Verify all files changed by Tasks 1–15.
- Modify only files required by a reproduced verification failure; do not bundle unrelated cleanup.

**Interfaces:**
- Consumes: Complete vertical feature.
- Produces: Evidence that the feature is type-safe, lint-clean, test-covered, buildable, documented, and operationally activated.

- [ ] **Step 1: Run focused server/runtime coverage**

```bash
npm test -- --run \
  src/server/sessions/subsessionConfiguration.test.ts \
  src/server/sessions/piSessionService.runtimeOptions.test.ts \
  src/server/sessions/piSessionService.subsessionDefaults.test.ts \
  src/server/sessions/piSessionService.spawnSubsession.test.ts \
  src/server/sessions/piSessionService.unread.test.ts \
  src/server/sessions/piSessionService.tree.test.ts \
  src/server/sessions/piSessionService.delegationTools.test.ts \
  src/server/sessions/spawnSubsessionTool.test.ts \
  src/server/sessions/spawnSubsessionTool.integration.test.ts \
  src/server/sessions/sessionDefaultsService.test.ts \
  src/server/sessions/sessionDefaultsRoutes.test.ts \
  src/server/sessions/sessionRoutes.test.ts \
  src/server/sessiond/sessionProxyRoutes.test.ts \
  src/server/app.remoteProxy.test.ts
```

Expected: all focused server files pass.

- [ ] **Step 2: Run focused client/shared coverage**

```bash
npm test -- --run \
  src/shared/capabilities.test.ts \
  src/client/src/subsessionDefaultsDraft.test.ts \
  src/client/src/api/parsers.subsessionDefaults.test.ts \
  src/client/src/api/clients.test.ts \
  src/client/src/api/federatedRouteContract.test.ts \
  src/client/src/controllers/sessionController.subsessionDefaults.test.ts \
  src/client/src/controllers/sessionController.pendingStarts.test.ts \
  src/client/src/controllers/sessionController.sendQueue.test.ts \
  src/client/src/components/SubsessionDefaultsControl.test.ts \
  src/client/src/components/PromptEditor.sessionConfiguration.test.ts \
  src/client/src/components/PromptEditor.draft.test.ts \
  src/client/src/components/PiWebUiApp.onboarding.test.ts \
  src/client/src/components/PiWebUiApp.subsessionDefaults.test.ts
```

Expected: all focused client/shared files pass.

- [ ] **Step 3: Run static and repository-wide verification**

```bash
npm run typecheck
npm run lint
npm run knip
git diff --check
npm run verify
npm run build
```

Expected: every command exits successfully. Record pre-existing Knip configuration hints separately; do not misreport them as feature failures.

- [ ] **Step 4: Verify release/documentation boundaries**

```bash
npm run changelog:status
git diff -- README.md CHANGELOG.md
git status --short
```

Expected: the patch Changeset is present; README and CHANGELOG have no feature-development diff; only intended implementation files are changed/committed.

- [ ] **Step 5: Restart the long-lived session daemon manually**

After the implementation is installed in the local development environment, inform the user and have them run:

```bash
systemctl --user restart pi-webui-sessiond.service
systemctl --user status pi-webui-sessiond.service --no-pager
```

The UI/API dev service may autoreload, but that is not sufficient for runtime/tool/protocol changes.

- [ ] **Step 6: Perform desktop and mobile acceptance checks**

With `subsessions: true` and a restarted daemon:

1. Open the starter; confirm the control is collapsed and linked to the parent defaults.
2. Change the parent model/thinking while linked; confirm the child draft follows.
3. Edit the child model, including a model ID containing `/`; confirm the draft detaches and unsupported thinking clears without replacement.
4. Force a start validation failure; confirm text, attachment bytes/names, exact child draft, and delivery choice remain recoverable.
5. Start a valid parent; confirm one version-1 custom entry exists before the first prompt is delivered.
6. Change the parent's own model/thinking; confirm child defaults do not change.
7. Save active child defaults; confirm the summary chip updates only after confirmation.
8. Start agent/bash/compaction/tree work; confirm values remain visible and Save is disabled.
9. Spawn with no override, then with a complete override; confirm child runtime model/thinking and tool details are exact.
10. Request an unavailable model or unsupported thinking level; confirm no child is created and no fallback/clamp occurs.
11. Check a verified tracked child and archived session; confirm the control is absent.
12. At approximately `390×844`, confirm the form uses a bottom sheet without covering prompt actions and Escape/close restores focus.
13. Select an older remote peer without the capability; confirm the control is hidden and no new POST field or active request is sent.

- [ ] **Step 7: Commit only if verification required a focused correction**

If no correction was needed, create no empty commit. If a reproduced issue required a focused fix, rerun the failing focused test plus `npm run verify`, then commit only those files with an appropriate Conventional Commit message.
