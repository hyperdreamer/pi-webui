# Persisted Starter Model Policy Preference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember each new-session composer's last valid Exact/Tiered mode and tier per workspace and machine while keeping Exact model/thinking defaults in Pi settings.

**Architecture:** Extend the existing session-defaults contract with an additive starter preference. A daemon-owned, versioned managed-state store serializes each read-modify-write transaction and uses private atomic file replacement; pure client helpers seed the draft, and a scoped latest-write coordinator keeps persistence asynchronous and race-safe. `PiWebUiApp` composes those modules without changing active-session policy ownership.

**Tech Stack:** TypeScript, Node.js 22.19+, Fastify, Lit, Vitest, PI WEBUI capability federation, Changesets.

## Global Constraints

- The approved specification is `docs/superpowers/specs/2026-08-03-persisted-starter-model-policy-preference-design.md`; every task must preserve its domain terms and acceptance criteria.
- Node.js `22.19.0` is the runtime floor; do not use APIs newer than that.
- Add no runtime dependency.
- Store personal managed state only in `$PI_WEBUI_DATA_DIR/starter-model-policy-preferences.json`; do not use `localStorage`, `$PI_WEBUI_CONFIG`, or `<project>/.pi-webui/config.json`.
- The stored file contract is version `1`, keyed by normalized absolute workspace path, with POSIX mode `0600`.
- An in-process operation queue must serialize the entire daemon read-modify-write transaction; temporary-file-plus-rename provides file integrity but is not the serialization mechanism.
- Concurrent tabs use last-successful-write-wins semantics in daemon queue order; do not claim browser click ordering or cross-process locking.
- `mode: "tiered"` requires a canonical tier; `mode: "exact"` may retain an inactive canonical tier; never persist an incomplete first Tiered choice.
- Preserve an unavailable remembered tier and block new-session Start until explicit repair; never substitute Exact, Standard, another tier, model, or thinking level.
- Preference read/write failures must not prevent a complete Exact starter or the current in-memory valid policy from starting a session.
- Active-session model policy changes must never update the starter preference.
- Gate preference writes on the additive `sessions.modelPolicyDefaults` capability owned by both web and session daemon; older peers retain the existing in-memory behavior.
- Browser application paths remain application-relative and are resolved only through the existing `sessionsApi` request boundary.
- Do not manually edit `CHANGELOG.md`; add one patch Changeset for the user-visible behavior.
- Any implementation touching `src/server/sessiond.ts` requires the final handoff to call out a manual `pi-webui-sessiond.service` restart.

## Task 1: Add the shared preference and capability contract

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:4-24`
- Modify: `src/shared/apiTypes.ts:74-113`
- Modify: `src/shared/apiTypes.ts:773-786`
- Modify: `src/shared/capabilities.ts:10-63`
- Test: `src/shared/capabilities.test.ts:1-58`
- Modify: `src/client/src/api/parsers.ts:1-8`
- Modify: `src/client/src/api/parsers.ts:285-342`
- Modify: `src/client/src/api/parsers.ts:746-754`
- Test: `src/client/src/api/parsers.test.ts:409-423`
- Test: `src/client/src/api/clients.test.ts:409-425`

**Interfaces:**

- Consumes: existing `MODEL_TIERS`, `ModelTier`, `SessionModelPolicyMode`, `sessionsApi.sessionDefaults(cwd, machineId)`, and `sessionsApi.updateSessionDefaults(cwd, update, machineId)`.
- Produces: `StarterModelPolicyPreference = { mode: SessionModelPolicyMode; tier?: ModelTier }`.
- Produces: additive `SessionDefaultsResponse.starterModelPolicyPreference?: StarterModelPolicyPreference` and `SessionDefaultsResponse.starterModelPolicyPreferenceError?: string`.
- Produces: `SessionDefaultsUpdate` as an exclusive union of a model/thinking update or `{ starterModelPolicyPreference: StarterModelPolicyPreference }`.
- Produces: `PI_WEBUI_CAPABILITIES.sessionsModelPolicyDefaults` with wire value `"sessions.modelPolicyDefaults"`, requiring both `web` and `sessiond`.
- Produces: `parseSessionDefaultsResponse(value: unknown): SessionDefaultsResponse` with strict nested preference parsing and legacy omission support.

- [ ] **Step 1: Add failing capability coverage**

Add this case beside the existing session-model-policy capability test:

```ts
it("requires web and session daemon support for starter model policy defaults", () => {
  const defaults = PI_WEBUI_CAPABILITIES.sessionsModelPolicyDefaults;
  expect(defaults).toBe("sessions.modelPolicyDefaults");
  expect(WEB_RUNTIME_CAPABILITIES).toContain(defaults);
  expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(defaults);
  expect(parseKnownPiWebUiCapabilities([defaults, "future.capability"]))
    .toEqual([defaults]);

  expect(effectivePiWebUiCapabilities({
    web: { available: true, capabilities: [defaults] },
    sessiond: { available: true, capabilities: [] },
  })).not.toContain(defaults);
  expect(effectivePiWebUiCapabilities({
    web: { available: true, capabilities: [] },
    sessiond: { available: true, capabilities: [defaults] },
  })).not.toContain(defaults);
  expect(effectivePiWebUiCapabilities({
    web: { available: true, capabilities: [defaults] },
    sessiond: { available: true, capabilities: [defaults] },
  })).toContain(defaults);
});
```

- [ ] **Step 2: Add failing parser and browser request coverage**

Extend the session-default parser test with all four contract states:

```ts
const baseDefaults = {
  model: { provider: "openai", id: "gpt-default", reasoning: true },
  thinkingLevel: "high",
  models: [{ provider: "openai", id: "gpt-default", reasoning: true }],
  thinkingLevels: ["off", "low", "high"],
};

expect(parseSessionDefaultsResponse({
  ...baseDefaults,
  starterModelPolicyPreference: { mode: "exact", tier: "advanced" },
})).toMatchObject({
  starterModelPolicyPreference: { mode: "exact", tier: "advanced" },
});
expect(parseSessionDefaultsResponse({
  ...baseDefaults,
  starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
})).toMatchObject({
  starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
});
expect(parseSessionDefaultsResponse({
  ...baseDefaults,
  starterModelPolicyPreferenceError: "preference file is malformed",
})).toMatchObject({
  starterModelPolicyPreferenceError: "preference file is malformed",
});
expect(parseSessionDefaultsResponse(baseDefaults)).toEqual(baseDefaults);

expect(() => parseSessionDefaultsResponse({
  ...baseDefaults,
  starterModelPolicyPreference: { mode: "tiered" },
})).toThrow("requires a tier");
expect(() => parseSessionDefaultsResponse({
  ...baseDefaults,
  starterModelPolicyPreference: { mode: "automatic", tier: "standard" },
})).toThrow("mode");
expect(() => parseSessionDefaultsResponse({
  ...baseDefaults,
  starterModelPolicyPreference: { mode: "exact", tier: "unknown" },
})).toThrow("tier");
expect(() => parseSessionDefaultsResponse({
  ...baseDefaults,
  starterModelPolicyPreference: { mode: "exact", future: true },
})).toThrow("field");
expect(() => parseSessionDefaultsResponse({
  ...baseDefaults,
  starterModelPolicyPreference: { mode: "exact" },
  starterModelPolicyPreferenceError: "conflict",
})).toThrow("both");
```

Extend the existing `sessionsApi.updateSessionDefaults` test with a third response and this request:

```ts
await expect(sessionsApi.updateSessionDefaults(
  "/repo with spaces",
  { starterModelPolicyPreference: { mode: "tiered", tier: "advanced" } },
  "remote /?",
)).resolves.toEqual({
  ...response,
  starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
});

expect(JSON.parse(requestBody(fetchCall(fetchMock, 2)[1]))).toEqual({
  cwd: "/repo with spaces",
  starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
});
```

- [ ] **Step 3: Run the focused tests and confirm the contract is red**

Run:

```bash
npm test -- --run src/shared/capabilities.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
```

Expected: FAIL because `sessionsModelPolicyDefaults` and the starter preference fields do not exist and the parser drops the new fields.

- [ ] **Step 4: Add the shared types and capability ownership**

Add the capability beside `sessionsModelPolicy`:

```ts
sessionsModelPolicyDefaults: "sessions.modelPolicyDefaults",
```

Add the preference beside the session model policy types:

```ts
export interface StarterModelPolicyPreference {
  mode: SessionModelPolicyMode;
  /** Remembered while Exact is active; required while Tiered is active. */
  tier?: ModelTier;
}
```

Replace the defaults update interface with the valid-state union:

```ts
export interface SessionDefaultsResponse {
  model?: SessionModel;
  thinkingLevel: string;
  models: SessionModel[];
  thinkingLevels: string[];
  starterModelPolicyPreference?: StarterModelPolicyPreference;
  starterModelPolicyPreferenceError?: string;
}

export type SessionDefaultsUpdate =
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

Add the new capability to `WEB_RUNTIME_CAPABILITIES`, `SESSIOND_RUNTIME_CAPABILITIES`, and `EFFECTIVE_CAPABILITY_REQUIREMENTS` with `['web', 'sessiond']` ownership.

- [ ] **Step 5: Parse the additive response strictly**

Import `StarterModelPolicyPreference`, then add this helper beside the existing session-policy parsers:

```ts
function parseStarterModelPolicyPreference(value: unknown): StarterModelPolicyPreference {
  const record = requirePlainRecord(value, "starter model policy preference");
  assertOnlyFields(record, ["mode", "tier"], "starter model policy preference");
  const mode = parseSessionModelPolicyMode(record["mode"]);
  const tier = parseOptionalSessionModelPolicyTier(record, "starter model policy preference");
  if (mode === "tiered" && tier === undefined) {
    throw new Error("Tiered starter model policy preference requires a tier");
  }
  return { mode, ...optionalField("tier", tier) };
}
```

Update `parseSessionDefaultsResponse` without rejecting unknown top-level fields, preserving additive response compatibility:

```ts
export function parseSessionDefaultsResponse(value: unknown): SessionDefaultsResponse {
  const record = requireRecord(value);
  const preference = record["starterModelPolicyPreference"] === undefined
    ? undefined
    : parseStarterModelPolicyPreference(record["starterModelPolicyPreference"]);
  const preferenceError = optionalString(record, "starterModelPolicyPreferenceError");
  if (preference !== undefined && preferenceError !== undefined) {
    throw new Error("Session defaults cannot contain both a starter preference and preference error");
  }
  return {
    ...(record["model"] === undefined ? {} : { model: parseSessionModel(record["model"]) }),
    thinkingLevel: requireString(record, "thinkingLevel"),
    models: arrayOf(parseSessionModel)(record["models"]),
    thinkingLevels: arrayOfString(record["thinkingLevels"], "thinkingLevels"),
    ...optionalField("starterModelPolicyPreference", preference),
    ...optionalField("starterModelPolicyPreferenceError", preferenceError),
  };
}
```

- [ ] **Step 6: Run focused verification**

Run:

```bash
npm test -- --run src/shared/capabilities.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
npx tsc --noEmit
npx eslint src/shared/apiTypes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
npx knip
```

Expected: all commands PASS. The parser test must include a legacy response with neither optional field.

- [ ] **Step 7: Commit**

```bash
git add src/shared/apiTypes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
git commit -m "feat(api): add starter model policy preference contract"
```

## Task 2: Build the daemon preference store

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/sessions/starterModelPolicyPreferenceStore.ts`
- Create: `src/server/sessions/starterModelPolicyPreferenceStore.test.ts`

**Interfaces:**

- Consumes: `StarterModelPolicyPreference = { mode: "exact" | "tiered"; tier?: ModelTier }` and `MODEL_TIERS` from Task 1.
- Produces: `StarterModelPolicyPreferenceInspection = { kind: "absent" } | { kind: "valid"; preference: StarterModelPolicyPreference } | { kind: "invalid"; reason: string }`.
- Produces: `StarterModelPolicyPreferencePersistence` with `load(): Promise<unknown | undefined>` and `save(value: unknown): Promise<void>`.
- Produces: `FileStarterModelPolicyPreferencePersistence`, constructor `(filePath?: string, renameFile?: (source: string, destination: string) => Promise<void>)`, implementing private atomic JSON replacement.
- Produces: `StarterModelPolicyPreferenceStore`, constructor `(persistence?: StarterModelPolicyPreferencePersistence)`, with `inspect(cwd: string): Promise<StarterModelPolicyPreferenceInspection>` and `replace(cwd: string, preference: StarterModelPolicyPreference): Promise<void>`.
- Produces: `defaultStarterModelPolicyPreferenceFilePath(env?: NodeJS.ProcessEnv, cwd?: string): string`.

- [ ] **Step 1: Write failing path, parsing, and round-trip tests**

Create the test file with temporary-root cleanup and these cases:

```ts
it("uses PI_WEBUI_DATA_DIR for the managed preference file", () => {
  expect(defaultStarterModelPolicyPreferenceFilePath(
    { PI_WEBUI_DATA_DIR: "managed-state" },
    "/tmp/pi-webui",
  )).toBe(resolve(
    "/tmp/pi-webui",
    "managed-state",
    "starter-model-policy-preferences.json",
  ));
});

it("round-trips independent workspace preferences and remembers a tier in Exact", async () => {
  const root = await temporaryRoot();
  const filePath = join(root, "preferences.json");
  const store = new StarterModelPolicyPreferenceStore(
    new FileStarterModelPolicyPreferencePersistence(filePath),
  );
  const main = resolve(root, "main");
  const feature = resolve(root, "feature");

  await store.replace(main, { mode: "exact", tier: "advanced" });
  await store.replace(feature, { mode: "tiered", tier: "frontier" });

  await expect(store.inspect(main)).resolves.toEqual({
    kind: "valid",
    preference: { mode: "exact", tier: "advanced" },
  });
  await expect(store.inspect(feature)).resolves.toEqual({
    kind: "valid",
    preference: { mode: "tiered", tier: "frontier" },
  });
  await expect(store.inspect(resolve(root, "missing"))).resolves.toEqual({ kind: "absent" });
});
```

Add table-driven invalid-file cases for unsupported version, missing/array `workspaces`, unknown root field, relative workspace key, unknown preference field, unknown mode, unknown tier, and Tiered without a tier. Every case must assert `{ kind: "invalid", reason: expect.any(String) }` rather than a thrown read error.

- [ ] **Step 2: Write a deterministic failing serialization test**

Use an injected blocking persistence so the first save cannot finish while the second replacement is enqueued:

```ts
it("serializes the complete read-modify-write transaction", async () => {
  const persistence = new BlockingPersistence();
  const store = new StarterModelPolicyPreferenceStore(persistence);
  const workspaceA = resolve("/workspace-a");
  const workspaceB = resolve("/workspace-b");
  const first = store.replace(workspaceA, { mode: "exact", tier: "fast" });
  await persistence.firstSaveStarted;

  const second = store.replace(workspaceB, { mode: "tiered", tier: "advanced" });
  expect(persistence.loadCalls).toBe(1);
  expect(persistence.saveCalls).toBe(1);

  persistence.releaseFirstSave();
  await Promise.all([first, second]);

  expect(persistence.maximumConcurrentSaves).toBe(1);
  expect(persistence.value).toMatchObject({
    version: 1,
    workspaces: {
      [workspaceA]: { mode: "exact", tier: "fast" },
      [workspaceB]: { mode: "tiered", tier: "advanced" },
    },
  });
});
```

`BlockingPersistence.load()` must return a structured clone of its current value. Its first `save()` records concurrency, waits on a deferred promise, then commits the clone. This test must fail if `load()` moves outside the exclusive operation.

- [ ] **Step 3: Write failing durability tests**

Add cases proving:

```ts
it("writes a private atomic file without leftover temporary files", async () => {
  const root = await temporaryRoot();
  const filePath = join(root, "state", "preferences.json");
  const store = new StarterModelPolicyPreferenceStore(
    new FileStarterModelPolicyPreferencePersistence(filePath),
  );
  await store.replace(resolve(root, "workspace"), { mode: "tiered", tier: "standard" });

  const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
  expect(persisted).toMatchObject({ version: 1 });
  if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  expect((await readdir(dirname(filePath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
```

Also add a real-file failed-commit case. First persist an Exact preference with the normal adapter, then construct a second adapter for the same path whose injected `renameFile` rejects with `new Error("rename failed")`. Assert the second `replace` rejects, the original JSON is byte-for-byte unchanged, and the directory contains no `.tmp` file. This is the test for atomic rollback and cleanup.

Use a separate `FailOncePersistence` to assert a rejected logical replacement does not poison the store's operation queue: a following replacement must run and persist successfully.

- [ ] **Step 4: Run the store test and confirm it is red**

Run:

```bash
npm test -- --run src/server/sessions/starterModelPolicyPreferenceStore.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 5: Implement the versioned store and file adapter**

Use this structure; keep the persistence seam small and keep parsing private:

```ts
const STARTER_MODEL_POLICY_PREFERENCE_VERSION = 1;
const STARTER_MODEL_POLICY_PREFERENCE_FILE_MODE = 0o600;

export type StarterModelPolicyPreferenceInspection =
  | { kind: "absent" }
  | { kind: "valid"; preference: StarterModelPolicyPreference }
  | { kind: "invalid"; reason: string };

export interface StarterModelPolicyPreferencePersistence {
  load(): Promise<unknown | undefined>;
  save(value: unknown): Promise<void>;
}

export class StarterModelPolicyPreferenceStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: StarterModelPolicyPreferencePersistence =
      new FileStarterModelPolicyPreferencePersistence(),
  ) {}

  async inspect(cwd: string): Promise<StarterModelPolicyPreferenceInspection> {
    try {
      requireNormalizedAbsoluteCwd(cwd);
      const data = parsePreferenceFile(await this.persistence.load());
      const preference = data.workspaces[cwd];
      return preference === undefined
        ? { kind: "absent" }
        : { kind: "valid", preference: clonePreference(preference) };
    } catch (error) {
      return { kind: "invalid", reason: errorMessage(error) };
    }
  }

  async replace(cwd: string, value: StarterModelPolicyPreference): Promise<void> {
    requireNormalizedAbsoluteCwd(cwd);
    const preference = parsePreference(value, "starter preference");
    await this.exclusive(async () => {
      const data = parsePreferenceFile(await this.persistence.load());
      data.workspaces[cwd] = clonePreference(preference);
      await this.persistence.save(data);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
```

Implement the file adapter with the existing private atomic-file pattern:

```ts
export class FileStarterModelPolicyPreferencePersistence
implements StarterModelPolicyPreferencePersistence {
  constructor(
    private readonly filePath = defaultStarterModelPolicyPreferenceFilePath(),
    private readonly renameFile: (
      source: string,
      destination: string,
    ) => Promise<void> = rename,
  ) {}

  async load(): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async save(value: unknown): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: STARTER_MODEL_POLICY_PREFERENCE_FILE_MODE,
        flag: "wx",
      });
      await this.renameFile(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
```

`parsePreferenceFile(undefined)` returns `{ version: 1, workspaces: Object.create(null) }`. For persisted data it must require exactly `version` and `workspaces`, copy entries into a null-prototype record, validate every key with `isAbsolute(cwd) && resolve(cwd) === cwd`, and validate every preference with exactly `mode` and optional `tier`.

- [ ] **Step 6: Run the store tests and focused quality checks**

Run:

```bash
npm test -- --run src/server/sessions/starterModelPolicyPreferenceStore.test.ts
npx eslint src/server/sessions/starterModelPolicyPreferenceStore.ts src/server/sessions/starterModelPolicyPreferenceStore.test.ts
npx tsc --noEmit
npx knip
```

Expected: all commands PASS. The deterministic blocking test must report one maximum concurrent save and retain both workspace entries.

- [ ] **Step 7: Prove the serialization test is falsifiable**

Copy `starterModelPolicyPreferenceStore.ts` to a temporary backup. Temporarily move the `persistence.load()` call outside the `exclusive()` callback so two replacements can read the same pre-write snapshot. Run only the test named `serializes the complete read-modify-write transaction`.

Expected: FAIL with `expected 2 to be 1` for `loadCalls`, or with one of the two workspace entries missing. Restore the byte-identical backup immediately, rerun the focused store test, and confirm `git diff -- src/server/sessions/starterModelPolicyPreferenceStore.ts` contains only the intended implementation.

- [ ] **Step 8: Commit**

```bash
git add src/server/sessions/starterModelPolicyPreferenceStore.ts src/server/sessions/starterModelPolicyPreferenceStore.test.ts
git commit -m "feat(sessiond): persist starter model policy preferences"
```

## Task 3: Integrate preferences into session defaults

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/sessionDefaultsService.ts:1-125`
- Test: `src/server/sessions/sessionDefaultsService.test.ts:1-120`
- Modify: `src/server/sessions/sessionDefaultsRoutes.ts:1-74`
- Test: `src/server/sessions/sessionDefaultsRoutes.test.ts:1-76`
- Test: `src/server/sessiond/sessionProxyRoutes.test.ts:28-44`
- Modify: `src/server/sessiond.ts:18-21`
- Modify: `src/server/sessiond.ts:84-92`

**Interfaces:**

- Consumes: `StarterModelPolicyPreference`, `SessionDefaultsResponse`, and exclusive `SessionDefaultsUpdate` from Task 1.
- Consumes: `StarterModelPolicyPreferenceStore.inspect(cwd): Promise<StarterModelPolicyPreferenceInspection>` and `.replace(cwd, preference): Promise<void>` from Task 2.
- Consumes: `StarterModelPolicyPreferenceInspection = { kind: "absent" } | { kind: "valid"; preference: StarterModelPolicyPreference } | { kind: "invalid"; reason: string }`.
- Produces: `SessionDefaultsServiceDependencies.starterModelPolicyPreferenceStore`, requiring the `inspect` and `replace` interface above.
- Produces: `SessionDefaultsService.read(cwd)` returning Exact defaults plus either a valid preference or preference-specific error.
- Produces: `SessionDefaultsService.update(cwd, update)` delegating to exactly one backing store.
- Produces: strict `PUT /session-defaults` parsing for Exact updates or one complete preference update.

- [ ] **Step 1: Add failing service tests for combined reads and isolated writes**

Extend the harness with injected `inspect` and `replace` spies. Add these cases:

```ts
it("combines Pi defaults with a valid starter preference", async () => {
  const harness = createHarness({
    model: testModel(),
    thinkingLevel: "high",
    preferenceInspection: {
      kind: "valid",
      preference: { mode: "exact", tier: "advanced" },
    },
  });

  await expect(harness.service.read("/workspace")).resolves.toMatchObject({
    thinkingLevel: "high",
    starterModelPolicyPreference: { mode: "exact", tier: "advanced" },
  });
});

it("keeps Exact defaults available when preference inspection fails", async () => {
  const harness = createHarness({
    model: testModel(),
    thinkingLevel: "high",
    inspectError: new Error("preference store unavailable"),
  });

  await expect(harness.service.read("/workspace")).resolves.toMatchObject({
    thinkingLevel: "high",
    starterModelPolicyPreferenceError: "preference store unavailable",
  });
});

it("writes only the preference store for a preference update", async () => {
  const harness = createHarness({ model: testModel(), thinkingLevel: "high" });
  harness.preferenceStore.inspect.mockResolvedValue({
    kind: "valid",
    preference: { mode: "tiered", tier: "frontier" },
  });

  await expect(harness.service.update("/workspace", {
    starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
  })).resolves.toMatchObject({
    starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
  });

  expect(harness.preferenceStore.replace).toHaveBeenCalledWith(
    "/workspace",
    { mode: "tiered", tier: "frontier" },
  );
  expect(harness.settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
  expect(harness.settings.setDefaultThinkingLevel).not.toHaveBeenCalled();
  expect(harness.settings.flush).not.toHaveBeenCalled();
});
```

Also assert an ordinary model or thinking update includes the current preference inspection in its returned response, and a rejected `replace` propagates without calling any Pi setting setter.

- [ ] **Step 2: Add failing route validation and proxy tests**

Add route cases accepting:

```ts
{ cwd: "/repo one", starterModelPolicyPreference: { mode: "exact", tier: "fast" } }
{ cwd: "/repo one", starterModelPolicyPreference: { mode: "tiered", tier: "advanced" } }
```

Assert the service receives exactly the nested update. Add rejection rows for:

```ts
{ cwd: "/repo", starterModelPolicyPreference: { mode: "tiered" } }
{ cwd: "/repo", starterModelPolicyPreference: { mode: "automatic", tier: "standard" } }
{ cwd: "/repo", starterModelPolicyPreference: { mode: "exact", tier: "unknown" } }
{ cwd: "/repo", starterModelPolicyPreference: { mode: "exact", future: true } }
{ cwd: "/repo", thinkingLevel: "low", starterModelPolicyPreference: { mode: "exact" } }
{ cwd: "/repo", unknown: true }
```

Every rejection must return `400` and make no service call. Extend the existing proxy test so a preference update body is forwarded unchanged through `/api/machines/local/session-defaults`.

- [ ] **Step 3: Run server tests and confirm they are red**

Run:

```bash
npm test -- --run src/server/sessions/sessionDefaultsService.test.ts src/server/sessions/sessionDefaultsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts
```

Expected: FAIL because the defaults service has no preference dependency or projection and the route rejects a preference-only update as empty.

- [ ] **Step 4: Deepen SessionDefaultsService behind its existing interface**

Add this dependency:

```ts
starterModelPolicyPreferenceStore: Pick<
  StarterModelPolicyPreferenceStore,
  "inspect" | "replace"
>;
```

Add an inspection wrapper that converts either an invalid inspection or a thrown collaborator error into the invalid union rather than failing Exact defaults:

```ts
private async inspectStarterPreference(
  cwd: string,
): Promise<StarterModelPolicyPreferenceInspection> {
  try {
    return await this.deps.starterModelPolicyPreferenceStore.inspect(cwd);
  } catch (error) {
    return { kind: "invalid", reason: errorMessage(error) };
  }
}
```

For `read`, load the model snapshot and preference inspection independently, then pass both into `response`. For `update`, branch before any Pi setting mutation:

```ts
const preference = update.starterModelPolicyPreference;
if (preference !== undefined) {
  await this.deps.starterModelPolicyPreferenceStore.replace(cwd, preference);
  return await this.read(cwd);
}
```

Project inspection into the response with one helper:

```ts
function preferenceFields(
  inspection: StarterModelPolicyPreferenceInspection,
): Pick<
  SessionDefaultsResponse,
  "starterModelPolicyPreference" | "starterModelPolicyPreferenceError"
> {
  if (inspection.kind === "valid") {
    return { starterModelPolicyPreference: { ...inspection.preference } };
  }
  if (inspection.kind === "invalid") {
    return { starterModelPolicyPreferenceError: inspection.reason };
  }
  return {};
}
```

Model/thinking updates must inspect and append preference fields after Pi's setting changes, without writing the preference store.

- [ ] **Step 5: Make route parsing strict and mutually exclusive**

At the start of `parseUpdate`, reject every top-level key outside:

```ts
["cwd", "model", "thinkingLevel", "starterModelPolicyPreference"]
```

Parse the nested preference as a plain record with exactly `mode` and optional `tier`. Use `MODEL_TIERS.some((tier) => tier === value)` for canonical validation. Return immediately for a preference update after proving model and thinking are absent. For Exact updates, retain existing model and thinking validation and reject an empty body.

Do not add a new route. Update the existing proxy test only; `registerSessionProxyRoutes` already forwards the application-relative path.

- [ ] **Step 6: Construct the store in the session daemon**

Import `StarterModelPolicyPreferenceStore` and pass a daemon-owned instance into the defaults module:

```ts
const defaults = new SessionDefaultsService({
  agentDir: activeAgentProfile.dir,
  modelRuntime: auth.runtime,
  starterModelPolicyPreferenceStore: new StarterModelPolicyPreferenceStore(),
});
```

Update every `SessionDefaultsService` test harness constructor with an injected fake store. Do not introduce import-time file access; the store reads lazily on `inspect` or `replace`.

- [ ] **Step 7: Run focused server verification**

Run:

```bash
npm test -- --run src/server/sessions/starterModelPolicyPreferenceStore.test.ts src/server/sessions/sessionDefaultsService.test.ts src/server/sessions/sessionDefaultsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts
npx eslint src/server/sessions/starterModelPolicyPreferenceStore.ts src/server/sessions/starterModelPolicyPreferenceStore.test.ts src/server/sessions/sessionDefaultsService.ts src/server/sessions/sessionDefaultsService.test.ts src/server/sessions/sessionDefaultsRoutes.ts src/server/sessions/sessionDefaultsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/sessiond.ts
npx tsc --noEmit
npx knip
```

Expected: all commands PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/sessions/sessionDefaultsService.ts src/server/sessions/sessionDefaultsService.test.ts src/server/sessions/sessionDefaultsRoutes.ts src/server/sessions/sessionDefaultsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/sessiond.ts
git commit -m "feat(sessiond): expose starter model policy defaults"
```

## Task 4: Add pure starter seeding and a scoped write coordinator

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/sessionModelPolicyDraft.ts:1-162`
- Test: `src/client/src/components/sessionModelPolicyDraft.test.ts:1-420`
- Create: `src/client/src/controllers/starterModelPolicyPreferenceWriter.ts`
- Create: `src/client/src/controllers/starterModelPolicyPreferenceWriter.test.ts`

**Interfaces:**

- Consumes: `SessionDefaultsResponse` and `StarterModelPolicyPreference` from Task 1.
- Consumes: existing `SessionModelPolicyDraft = { mode: "exact" | "tiered"; exact: ExactModelSelection; tier?: ModelTier }`.
- Produces: `starterExactSelection(defaults: SessionDefaultsResponse): ExactModelSelection | undefined`.
- Produces: `seedStarterModelPolicyDraft(defaults: SessionDefaultsResponse): SessionModelPolicyDraft`.
- Produces: `relinkStarterExactBranch(draft: SessionModelPolicyDraft, defaults: SessionDefaultsResponse): SessionModelPolicyDraft`.
- Produces: `starterModelPolicyPreferenceFromDraft(draft: SessionModelPolicyDraft): StarterModelPolicyPreference | undefined`.
- Produces: `sameExactSelection(left: ExactModelSelection, right: ExactModelSelection): boolean`.
- Produces: `StarterModelPolicyPreferenceWriteScope = { machineId: string; cwd: string }`.
- Produces: `StarterModelPolicyPreferenceWriteSnapshot = { saving: boolean; error?: string }`.
- Produces: `StarterModelPolicyPreferenceWriter.write(scope, preference): Promise<void>` and `.snapshot(scope): StarterModelPolicyPreferenceWriteSnapshot`.

- [ ] **Step 1: Add failing starter draft tests**

Add this exact fixture in the starter-draft test block:

```ts
function starterDefaults(
  overrides: Partial<SessionDefaultsResponse> = {},
): SessionDefaultsResponse {
  return {
    model: { provider: "openai", id: "gpt-default" },
    thinkingLevel: "medium",
    models: [{ provider: "openai", id: "gpt-default" }],
    thinkingLevels: ["low", "medium", "high"],
    ...overrides,
  };
}
```

Then add a `describe("starter model policy drafts")` block that proves:

```ts
expect(seedStarterModelPolicyDraft(starterDefaults())).toEqual({
  mode: "exact",
  exact: {
    model: { provider: "openai", id: "gpt-default" },
    thinkingLevel: "medium",
  },
});

expect(seedStarterModelPolicyDraft(starterDefaults({
  starterModelPolicyPreference: { mode: "exact", tier: "fast" },
}))).toMatchObject({ mode: "exact", tier: "fast" });

expect(seedStarterModelPolicyDraft(starterDefaults({
  starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
}))).toMatchObject({ mode: "tiered", tier: "advanced" });

const incompleteDefaults = starterDefaults({ thinkingLevel: "" });
delete incompleteDefaults.model;
expect(seedStarterModelPolicyDraft(incompleteDefaults)).toEqual({
  mode: "exact",
  exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
});
```

Assert `relinkStarterExactBranch` updates only an Exact draft, preserves an Exact draft's tier, returns the same object for a value-equivalent relink, and does not overwrite the remembered Exact branch while Tiered. Assert `starterModelPolicyPreferenceFromDraft` returns Exact with an optional remembered tier, returns complete Tiered, and returns `undefined` for Tiered without a tier. Assert inputs are not mutated.

- [ ] **Step 2: Add deterministic failing writer tests**

Use deferred saves to prove one in-flight write per scope and latest-pending coalescing:

```ts
it("serializes one scope and coalesces pending intent to the latest value", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const save = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const changes: StarterModelPolicyPreferenceWriteSnapshot[] = [];
  const writer = new StarterModelPolicyPreferenceWriter({
    save,
    onStateChange: (_scope, snapshot) => { changes.push(snapshot); },
  });
  const scope = { machineId: "remote-a", cwd: "/repo" };

  const exact = writer.write(scope, { mode: "exact", tier: "fast" });
  const advanced = writer.write(scope, { mode: "tiered", tier: "advanced" });
  const frontier = writer.write(scope, { mode: "tiered", tier: "frontier" });

  expect(save).toHaveBeenCalledTimes(1);
  first.resolve();
  await vi.waitFor(() => { expect(save).toHaveBeenCalledTimes(2); });
  expect(save.mock.calls[1]?.[1]).toEqual({ mode: "tiered", tier: "frontier" });

  second.resolve();
  await Promise.all([exact, advanced, frontier]);
  expect(writer.snapshot(scope)).toEqual({ saving: false });
  expect(changes.at(-1)).toEqual({ saving: false });
});
```

Add cases proving different machine/path scopes have independent snapshots, a first failure followed by a pending success clears the error, a latest failure remains non-throwing in `snapshot`, and an `onStateChange` callback throw does not poison the writer.

- [ ] **Step 3: Run both focused tests and confirm red**

Run:

```bash
npm test -- --run src/client/src/components/sessionModelPolicyDraft.test.ts src/client/src/controllers/starterModelPolicyPreferenceWriter.test.ts
```

Expected: FAIL because the pure starter helpers and writer module do not exist.

- [ ] **Step 4: Add pure starter helpers**

Add these implementations to `sessionModelPolicyDraft.ts`:

```ts
export function starterExactSelection(
  defaults: SessionDefaultsResponse,
): ExactModelSelection | undefined {
  const provider = defaults.model?.provider;
  const id = defaults.model?.id;
  if (provider === undefined || provider === "" || id === undefined || id === "") return undefined;
  if (defaults.thinkingLevel === "") return undefined;
  return { model: { provider, id }, thinkingLevel: defaults.thinkingLevel };
}

export function seedStarterModelPolicyDraft(
  defaults: SessionDefaultsResponse,
): SessionModelPolicyDraft {
  const exact = starterExactSelection(defaults) ?? {
    model: { provider: "", id: "" },
    thinkingLevel: "",
  };
  const preference = defaults.starterModelPolicyPreference;
  return {
    mode: preference?.mode ?? "exact",
    exact: cloneExactSelection(exact),
    ...(preference?.tier === undefined ? {} : { tier: preference.tier }),
  };
}

export function relinkStarterExactBranch(
  draft: SessionModelPolicyDraft,
  defaults: SessionDefaultsResponse,
): SessionModelPolicyDraft {
  const exact = starterExactSelection(defaults);
  if (exact === undefined || draft.mode === "tiered" || sameExactSelection(draft.exact, exact)) return draft;
  return { ...draft, exact: cloneExactSelection(exact) };
}

export function starterModelPolicyPreferenceFromDraft(
  draft: SessionModelPolicyDraft,
): StarterModelPolicyPreference | undefined {
  if (draft.mode === "tiered" && draft.tier === undefined) return undefined;
  return {
    mode: draft.mode,
    ...(draft.tier === undefined ? {} : { tier: draft.tier }),
  };
}

export function sameExactSelection(
  left: ExactModelSelection,
  right: ExactModelSelection,
): boolean {
  return left.model.provider === right.model.provider
    && left.model.id === right.model.id
    && left.thinkingLevel === right.thinkingLevel;
}
```

Import `SessionDefaultsResponse` and `StarterModelPolicyPreference` from the shared contract.

- [ ] **Step 5: Implement the scoped latest-write coordinator**

Use a map keyed by `JSON.stringify([scope.machineId, scope.cwd])`. Register the worker promise before invoking `deps.save` so a synchronous collaborator cannot start a second worker.

```ts
export interface StarterModelPolicyPreferenceWriteScope {
  machineId: string;
  cwd: string;
}

export interface StarterModelPolicyPreferenceWriteSnapshot {
  saving: boolean;
  error?: string;
}

export interface StarterModelPolicyPreferenceWriterDependencies {
  save(
    scope: StarterModelPolicyPreferenceWriteScope,
    preference: StarterModelPolicyPreference,
  ): Promise<unknown>;
  onStateChange?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    snapshot: StarterModelPolicyPreferenceWriteSnapshot,
  ) => void;
}
```

Each scope state holds one `worker`, one replaceable `pending` preference, all completion resolvers attached to that pending value, and the latest error. `write()` must:

```ts
write(
  scope: StarterModelPolicyPreferenceWriteScope,
  preference: StarterModelPolicyPreference,
): Promise<void> {
  const state = this.stateFor(scope);
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
  if (resolveCompletion === undefined) throw new Error("Preference write completion was not initialized");

  if (state.pending === undefined) {
    state.pending = { preference: clonePreference(preference), completions: [resolveCompletion] };
  } else {
    state.pending.preference = clonePreference(preference);
    state.pending.completions.push(resolveCompletion);
  }
  if (state.worker === undefined) this.startWorker(state);
  this.publish(state);
  return completion;
}
```

The worker loops while `pending` exists, clears it before awaiting the save, catches every save error into the scope's snapshot, resolves every completion even on failure, and continues to a newer pending value. A success clears an earlier error. `snapshot()` returns a clone and defaults to `{ saving: false }`. `publish()` catches observer errors so reporting cannot stop persistence.

- [ ] **Step 6: Run focused client-module verification**

Run:

```bash
npm test -- --run src/client/src/components/sessionModelPolicyDraft.test.ts src/client/src/controllers/starterModelPolicyPreferenceWriter.test.ts
npx eslint src/client/src/components/sessionModelPolicyDraft.ts src/client/src/components/sessionModelPolicyDraft.test.ts src/client/src/controllers/starterModelPolicyPreferenceWriter.ts src/client/src/controllers/starterModelPolicyPreferenceWriter.test.ts
npx tsc --noEmit
npx knip
```

Expected: all commands PASS. The coalescing test must issue Exact followed by Frontier, never the superseded Advanced request.

- [ ] **Step 7: Prove latest-pending coalescing is falsifiable**

Copy `starterModelPolicyPreferenceWriter.ts` to a temporary backup. Temporarily stop replacing `state.pending.preference` when a newer write arrives, leaving the older pending Advanced value in place. Run only the test named `serializes one scope and coalesces pending intent to the latest value`.

Expected: FAIL because the second save receives `{ mode: "tiered", tier: "advanced" }` instead of Frontier. Restore the byte-identical backup immediately, rerun the focused writer test, and confirm the source diff contains only the intended implementation.

- [ ] **Step 8: Commit**

```bash
git add src/client/src/components/sessionModelPolicyDraft.ts src/client/src/components/sessionModelPolicyDraft.test.ts src/client/src/controllers/starterModelPolicyPreferenceWriter.ts src/client/src/controllers/starterModelPolicyPreferenceWriter.test.ts
git commit -m "feat(client): queue starter model policy preferences"
```

## Task 5: Surface non-blocking warnings and block only sending

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/SessionModelPolicyControl.ts:14-152`
- Test: `src/client/src/components/SessionModelPolicyControl.test.ts:70-190`
- Modify: `src/client/src/components/PromptEditor.ts:45-66`
- Modify: `src/client/src/components/PromptEditor.ts:135-161`
- Modify: `src/client/src/components/PromptEditor.ts:533-545`
- Test: `src/client/src/components/PromptEditor.sessionConfiguration.test.ts:35-240`

**Interfaces:**

- Consumes: existing `SessionModelPolicyControl.error: string` and `ClientSessionModelPolicyStatus.blockedReason?: string`.
- Produces: diagnostic priority `blockedReason`, then Tiered invalid-ladder reason, then nonblank `error`.
- Produces: `PromptEditor.sendDisabled: boolean`, default `false`, which disables Send/Steer activation and keyboard submission without disabling model-policy repair controls, attachments, or editor input.

- [ ] **Step 1: Add failing diagnostic priority tests**

Add real-DOM cases to `SessionModelPolicyControl.test.ts`:

```ts
it("shows a non-blocking policy error when no stronger diagnostic exists", async () => {
  const control = await mountControl((element) => {
    element.status = exactStatus();
    element.error = "Could not remember this model policy";
  });
  expect(shadowRoot(control).querySelector(".policy-diagnostic")?.textContent)
    .toContain("Could not remember this model policy");
});

it("keeps a runtime block ahead of a non-blocking policy error", async () => {
  const control = await mountControl((element) => {
    element.status = { ...exactStatus(), blockedReason: "repair the live policy" };
    element.error = "preference write failed";
  });
  expect(shadowRoot(control).querySelector(".policy-diagnostic")?.textContent)
    .toContain("repair the live policy");
  expect(shadowRoot(control).querySelector(".policy-diagnostic")?.textContent)
    .not.toContain("preference write failed");
});
```

Also assert a blank `error` renders no chip.

- [ ] **Step 2: Add failing send-only blocking coverage**

In `PromptEditor.sessionConfiguration.test.ts`, configure a starter editor with a valid policy, `sendDisabled = true`, a draft, and an `onSend` spy. Assert:

```ts
const actions = renderPromptEditorActions(editor);
expect(requiredButton(actions, ".send-button").disabled).toBe(true);
expect(renderedPolicyControl(renderCompactStatusElement(editor)).editable).toBe(true);
```

Invoke the private `send` method through one small type-guarded helper to pin the keyboard path without constructing CodeMirror. Add a comment explaining that this direct call is proportionate because the DOM assertion covers the button and the helper covers the shared submission guard. Assert `onSend` is not called and the draft is not reset while blocked; set `sendDisabled = false`, invoke again, and assert one send.

- [ ] **Step 3: Run focused UI tests and confirm red**

Run:

```bash
npm test -- --run src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
```

Expected: FAIL because `error` is not projected into the diagnostic and `sendDisabled` does not exist.

- [ ] **Step 4: Render the existing error property at the right priority**

Update `compactDiagnostic`:

```ts
private compactDiagnostic(policyStatus: ClientSessionModelPolicyStatus): string | undefined {
  const blockedReason = this.blockedReason();
  if (blockedReason !== undefined) return blockedReason;
  if (policyStatus.mode === "tiered" && !policyStatus.ladderValid) return LADDER_INVALID_MESSAGE;
  const error = this.error.trim();
  return error === "" ? undefined : error;
}
```

Do not change `canMutate`; a non-blocking preference error must remain repairable.

- [ ] **Step 5: Add the send-only guard**

Add the Lit property:

```ts
@property({ type: Boolean }) sendDisabled = false;
```

Use `const sendBusy = busy || this.sendDisabled` for Send and Steer button `disabled` bindings while leaving Attach, Compact, Stop, policy editing, and the CodeMirror disabled state unchanged. Guard every programmatic submission in the shared method:

```ts
private send(streamingBehavior?: "steer" | "followUp") {
  if (this.disabled || this.sending || this.sendDisabled) return;
```

Because keyboard and button paths both call `send`, no separate keyboard-only condition is needed.

- [ ] **Step 6: Run focused UI verification**

Run:

```bash
npm test -- --run src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
npx eslint src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
npx tsc --noEmit
npx knip
```

Expected: all commands PASS. Existing tests must continue proving a blocked policy can open repair controls.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
git commit -m "feat(client): surface starter policy blocks and warnings"
```

## Task 6: Restore and persist starter policy in PiWebUiApp

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:1-35`
- Modify: `src/client/src/components/PiWebUiApp.ts:170-370`
- Modify: `src/client/src/components/PiWebUiApp.ts:590-612`
- Modify: `src/client/src/components/PiWebUiApp.ts:1144-1174`
- Modify: `src/client/src/components/PiWebUiApp.ts:1508-1561`
- Modify: `src/client/src/components/PiWebUiApp.ts:1934-1950`
- Modify: `src/client/src/components/PiWebUiApp.ts:2106-2218`
- Modify: `src/client/src/components/PiWebUiApp.ts:3088-3197`
- Modify: `src/client/src/components/PiWebUiApp.ts:3788-3890`
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts:1-1045`

**Interfaces:**

- Consumes: all Task 1 session-default preference fields and `PI_WEBUI_CAPABILITIES.sessionsModelPolicyDefaults`.
- Consumes: Task 4 `seedStarterModelPolicyDraft`, `relinkStarterExactBranch`, `starterExactSelection`, `sameExactSelection`, and `starterModelPolicyPreferenceFromDraft` with their exact signatures.
- Consumes: Task 4 `StarterModelPolicyPreferenceWriter.write(scope, preference): Promise<void>` and `.snapshot(scope): { saving: boolean; error?: string }`, where `scope = { machineId: string; cwd: string }`.
- Consumes: Task 5 `PromptEditor.sendDisabled: boolean` and `SessionModelPolicyControl.error` rendering.
- Produces: preference restoration from `SessionDefaultsResponse`, immediate valid preference writes, Tiered catalog preloading, scoped non-blocking diagnostics, and send/start blocking only for unresolved starter policy.
- Preserves: active-session policy APIs and state, successful-start draft cleanup, failed-start retry behavior, and exact model/thinking persistence through Pi defaults.

- [ ] **Step 1: Add failing restoration and capability tests**

Extend `starterDefaults()` fixtures with the additive fields. Add tests proving:

1. A returned `{ mode: "exact", tier: "fast" }` preference restores Exact and the inactive tier.
2. A returned `{ mode: "tiered", tier: "advanced" }` preference restores Tiered and immediately starts `modelTiersApi.settings(machineId)`.
3. While the catalog request is pending, the prompt editor receives `.sendDisabled=true` and the selected tier remains visible.
4. A peer without `sessions.modelPolicyDefaults` still allows existing in-memory mode/tier selection but does not call `sessionsApi.updateSessionDefaults` for a preference.
5. A runtime advertising both `sessions.modelPolicy` and `sessions.modelPolicyDefaults` does issue the selected-machine preference update.

Use a runtime fixture whose `machineId` matches the map key; do not reuse a remote-only hard-coded ID for local capability tests.

- [ ] **Step 2: Add failing immediate-write and branch-preservation tests**

For a preference-capable starter with a valid catalog, invoke the existing template callbacks and assert:

```ts
await selectPolicyTier(app, "frontier");
await vi.waitFor(() => {
  expect(sessionsApi.updateSessionDefaults).toHaveBeenCalledWith(
    mainWorkspace.path,
    { starterModelPolicyPreference: { mode: "tiered", tier: "frontier" } },
    "local",
  );
});
```

Switch to Exact and assert the write is `{ mode: "exact", tier: "frontier" }`. Add a first-time Tiered case with no remembered tier and assert opening Tiered changes the draft but issues no preference request until a valid tier is selected.

Add an Exact model/thinking update case proving the confirmed defaults relink only the Exact branch and then persist Exact mode without dropping the remembered tier. Add an active-session mode/tier selection case asserting no starter preference update is sent.

- [ ] **Step 3: Add failing invalid-tier, warning, and stale-scope tests**

Add these scenarios:

- Restored Tiered plus an invalid selected row remains Tiered, retains the tier, exposes the row/config reason, binds `.sendDisabled=true`, and does not call either start path.
- Switching from that blocked Tiered draft to a complete Exact branch works even when the tier-catalog fetch failed; Exact mode does not require a tier catalog.
- A rejected preference write leaves the valid in-memory Tiered snapshot in the subsequent `startSessionWithPrompt` call and binds a message containing `Could not remember this model policy; this session will still use it.`
- A later successful preference write clears the earlier warning.
- A write rejected after changing machine/workspace cannot appear in the current composer's `.modelPolicyError`; returning to the original scope reads that writer scope's retained warning.
- A `starterModelPolicyPreferenceError` response falls back to Exact, shows the preference diagnostic, and does not disable Send when the Exact defaults are complete.

Guard both `handleStartSessionPrompt` and `startSessionAndOpenChat`; tests must invoke the handlers directly so the server call cannot bypass `PromptEditor.sendDisabled`.

- [ ] **Step 4: Run the app test and confirm red**

Run:

```bash
npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
```

Expected: FAIL because returned preferences are ignored, no writer exists, the tier catalog is not preloaded, and the starter prompt has no send-only block.

- [ ] **Step 5: Install the scoped writer and preference support gate**

Import the Task 4 writer and helpers. Change `starterModelPolicy` to `SessionModelPolicyDraft | undefined`, add `@state() private starterModelPolicyPreferenceReadError = ""`, and construct one writer:

```ts
private readonly starterModelPolicyPreferenceWriter =
  new StarterModelPolicyPreferenceWriter({
    save: (scope, preference) => sessionsApi.updateSessionDefaults(
      scope.cwd,
      { starterModelPolicyPreference: preference },
      scope.machineId,
    ),
    onStateChange: () => { this.requestUpdate(); },
  });
```

Add current-scope and support helpers:

```ts
private starterModelPolicyPreferenceScope():
StarterModelPolicyPreferenceWriteScope | undefined {
  const workspace = this.state.selectedWorkspace;
  if (workspace === undefined) return undefined;
  return { machineId: selectedMachineId(this.state), cwd: workspace.path };
}

private starterModelPolicyPreferenceSupported(machineId: string): boolean {
  const runtime = this.state.machineRuntimes[machineId];
  return runtime?.ok === true
    && supportsPiWebUiCapability(
      runtime,
      PI_WEBUI_CAPABILITIES.sessionsModelPolicyDefaults,
    );
}
```

Do not special-case local as supported: this capability exists specifically to prevent an autoreloaded web process from writing to a stale local session daemon.

- [ ] **Step 6: Seed initial loads and relink later Exact-default responses**

In `loadStarterSessionDefaults`, after the existing machine/workspace stale guard:

```ts
this.starterSessionDefaults = defaults;
this.starterModelPolicyPreferenceReadError =
  defaults.starterModelPolicyPreferenceError ?? "";
const current = this.starterModelPolicy;
if (current === undefined) {
  const draft = seedStarterModelPolicyDraft(defaults);
  this.starterModelPolicy = draft;
  if (
    draft.mode === "tiered"
    && this.selectedMachineModelTierCatalog() === undefined
    && !this.modelTierCatalogLoading
  ) {
    void this.loadModelTierCatalog(machineId);
  }
} else {
  this.starterModelPolicy = relinkStarterExactBranch(current, defaults);
}
```

Replace the local `starterExactSelection` and `sameExactSelection` implementations at the bottom of `PiWebUiApp.ts` with imports from the pure module. Reset only the current read diagnostic on scope change; do not erase writer snapshots for old scopes.

- [ ] **Step 7: Persist only complete valid choices**

Add one helper that returns without writing when the capability, scope, or complete preference is absent:

```ts
private persistStarterModelPolicyPreference(
  draft: SessionModelPolicyDraft,
): void {
  const scope = this.starterModelPolicyPreferenceScope();
  const preference = starterModelPolicyPreferenceFromDraft(draft);
  if (
    scope === undefined
    || preference === undefined
    || !this.starterModelPolicyPreferenceSupported(scope.machineId)
  ) return;
  void this.starterModelPolicyPreferenceWriter.write(scope, preference);
}
```

Update starter handlers as follows:

- Exact mode: switch the local draft immediately without loading the tier catalog. Persist only when its Exact branch equals `starterExactSelection(starterSessionDefaults)`; otherwise leave it repairable and blocked.
- Tiered mode with no remembered tier: switch only the temporary draft and open/show the tier control; do not persist.
- Tiered mode with a remembered tier: validate against the loaded catalog; persist only when valid. An invalid remembered tier may become a temporary blocked Tiered draft but cannot overwrite a durable Exact preference.
- Tier selection: after existing catalog validation, set the draft and persist it.
- Confirmed Exact model/thinking update: relink the Exact branch; when the resulting draft is Exact and complete, persist Exact plus the remembered tier.

The preference writer response is intentionally ignored; it must never replace `starterSessionDefaults` or a newer Exact branch.

- [ ] **Step 8: Project blocking and non-blocking diagnostics separately**

Remove the early `starterExactSelection(defaults) === undefined` return from `starterModelPolicyInputs`. Build status from the draft even when Exact is incomplete.

For Tiered, set `blockedReason` whenever the selected row cannot resolve, preferring `catalog.configError`, then the current catalog request error, then `Choose a valid model tier before starting`.

For Exact, set `blockedReason: "Choose a model and thinking level before starting"` unless the draft Exact branch equals the confirmed complete Exact defaults. Do not let preference read/write errors become `blockedReason`.

Add one diagnostic helper that prioritizes the catalog error, then the read error, then the current writer scope's error formatted as:

```text
Could not remember this model policy; this session will still use it. <reason>
```

Bind the starter prompt editor with:

```ts
.sendDisabled=${policy?.status.blockedReason !== undefined}
.modelPolicyError=${this.starterModelPolicyError()}
```

Keep starter policy controls editable while a preference write is in flight; the writer serializes changes, so do not pass its `saving` state into the existing mutation lock.

- [ ] **Step 9: Guard both start paths at the app boundary**

Add:

```ts
private starterModelPolicyBlocksStart(): boolean {
  return this.starterModelPolicyInputs()?.status.blockedReason !== undefined;
}
```

Return before `sessions.startSession` in `startSessionAndOpenChat`. In `handleStartSessionPrompt`, retain the existing auth slash-command handling first, then return before snapshot/start when blocked. This keeps authentication commands reachable while preventing an invalid policy from silently starting under Exact defaults.

Do not change `clearStarterModelPolicyAfterSuccessfulStart`; a successful start still clears only the temporary draft, while the writer owns durable preference state.

- [ ] **Step 10: Run focused app and adjacent UI tests**

Run:

```bash
npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/sessionModelPolicyDraft.test.ts src/client/src/controllers/starterModelPolicyPreferenceWriter.test.ts src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
```

Expected: all commands PASS, including existing active-session policy timing and failed-start retry tests.

- [ ] **Step 11: Run client quality checks**

Run:

```bash
npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/sessionModelPolicyDraft.ts src/client/src/controllers/starterModelPolicyPreferenceWriter.ts src/client/src/components/PromptEditor.ts src/client/src/components/SessionModelPolicyControl.ts
npx tsc --noEmit
npx knip
```

Expected: all commands PASS with no staged export or unused-property finding.

- [ ] **Step 12: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "feat(client): restore starter model policy preferences"
```

## Task 7: Document and release-note persisted starter preferences

**Implementer tier:** Standard

**Files:**

- Modify: `docs/config.md:238-247`
- Modify: `docs/config.html:661-670`
- Create: `.changeset/remember-starter-model-policy.md`

**Interfaces:**

- Consumes: completed user behavior from Tasks 1-6: per-machine/per-workspace starter mode/tier persistence, Exact retained tier, invalid Tiered blocking, non-blocking persistence failure, and `sessions.modelPolicyDefaults` compatibility.
- Produces: synchronized Markdown and HTML configuration documentation.
- Produces: one patch Changeset for package `@hyperdreamer/pi-webui`.

- [ ] **Step 1: Update the canonical Markdown behavior**

Revise the model-policy bullets in `docs/config.md` so they state all of the following without describing internal class names:

```md
- **Exact fallback:** With no remembered starter preference, a new root starts in Exact mode using Pi's persisted model and thinking defaults. Selecting Exact remembers the mode while retaining the last selected tier for a later switch back.
- **Remembered starter policy:** A valid starter mode and tier are remembered per workspace on the selected machine. Starter selections update this personal managed state immediately; changes inside an existing session do not change future-session defaults.
- **Validation and recovery:** A remembered Tiered choice whose current mapping is unavailable remains selected and blocks Start until the user chooses a valid tier, switches to a complete Exact branch, or repairs the ladder. PI WEBUI never substitutes another tier or Exact mode.
- **Persistence failures:** If PI WEBUI cannot read the preference, a complete Exact starter remains usable and the composer shows the preference error. If a write fails, the current session still starts with the selected in-memory policy but PI WEBUI warns that the choice was not remembered.
- **Availability and compatibility:** Per-session policy uses `sessions.modelPolicy`; persisted starter mode/tier additionally requires `sessions.modelPolicyDefaults` on both web and session daemon. Older peers keep the previous in-memory starter behavior.
- **Managed state and concurrency:** Preferences live in `$PI_WEBUI_DATA_DIR/starter-model-policy-preferences.json` on the selected machine. One daemon serializes complete read-modify-write operations; atomic file replacement prevents partial JSON. Concurrent tabs therefore use last-successful-write-wins semantics in daemon queue order, not browser click order or cross-process locking.
```

Keep the existing controls, active-session availability, and session creation claims that remain accurate. Replace the unconditional statement `New root sessions start in Exact mode` with the conditional Exact fallback above.

- [ ] **Step 2: Mirror the claims in HTML**

Update the matching `<li>` elements in `docs/config.html` with the same scope, fallback, validation, failure, capability, managed file, and concurrency claims. Preserve the local HTML structure and use `<code>` around capability names, environment variables, and file names.

- [ ] **Step 3: Add the patch Changeset**

Create exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Remember each workspace's last selected Exact or Tiered starter mode and tier on its target machine.
```

Do not edit `CHANGELOG.md`.

- [ ] **Step 4: Check docs, Changeset, and the complete repository**

Run:

```bash
git diff --check
npm run changelog:status
npm run verify
```

Expected: no whitespace errors; Changesets reports the new patch fragment; typecheck, ESLint, Knip, and all Vitest files PASS.

- [ ] **Step 5: Inspect packaged documentation scope**

Run:

```bash
npm pack --dry-run
```

Expected: the package includes `docs/config.md`, the compiled application/server artifacts, and the Changeset remains repository-only. Do not publish.

- [ ] **Step 6: Commit**

```bash
git add docs/config.md docs/config.html .changeset/remember-starter-model-policy.md
git commit -m "docs: document starter model policy persistence"
```
