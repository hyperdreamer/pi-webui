# Speech Prompt Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editable prompt dictation through browser speech recognition and gateway-mediated OpenAI-compatible cloud transcription, with gateway-scoped provider/language settings and write-only Pi-compatible credentials.

**Architecture:** The gateway owns private speech-input configuration, credential resolution, bounded cloud transcription, and redacted versioned HTTP contracts. As an explicit prerequisite, Task 1 makes PI WEBUI's existing shared JSON config read-modify-write safe across the autoreloading web/API process and long-lived session daemon using a secret-free SQLite transaction database under managed state; speech audio and transcription never use SQLite. Each mounted `PromptEditor` owns one provider-neutral `SpeechInputController`; injected Browser and Cloud adapters report normalized lifecycle events, while the editor alone owns CodeMirror selection capture, interim decoration, read-only locking, stale-target checks, and final draft insertion. `PiWebUiApp` owns the latest redacted settings snapshot and passes it to starter and active-session composers and to the General Settings surface.

**Tech Stack:** TypeScript 6 with `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`; Node.js 22.19+ built-ins (`child_process`, `fs`, `node:sqlite`, Fetch/FormData/Blob); Fastify 5; Lit 3; CodeMirror 6; Vitest 4; raw Chromium CDP; and Changesets.

## Global Constraints

- Implement the audited `docs/superpowers/specs/2026-08-13-speech-prompt-input-design.md` exactly. Browser and Cloud are the only visible V1 providers; Auto resolves once per run in Browser, then Cloud order. Do not expose Local, download models, manage Whisper, or add a provider/plugin registry.
- Speech only edits the prompt draft. Never invoke Send, Queue, Steer, session start, or any prompt-submission callback from dictation completion.
- Capture the complete editor text, selection, and machine/project/workspace/session identity before asynchronous work. Navigation, disposal, cancellation, a changed identity, or a changed document must suppress every late interim/final result.
- The capture/listening phase is bounded to ten minutes from successful provider start. Cloud credential command resolution has one ten-second monotonic budget; cloud provider headers and bounded body reading share one 120-second monotonic budget. Do not reset either deadline between serial stages.
- Cloud recordings retain at most exactly `20 * 1024 * 1024` bytes and are never truncated. The route pins the same 20 MiB limit independently of global `maxUploadBytes` and admits at most two requests in `onRequest` before body parsing; a third receives `429`.
- Accept only `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4;codecs=mp4a.40.2`, and `audio/mp4`, mapped to `speech.webm`, `speech.ogg`, and `speech.m4a`. Reject every other codec/parameter combination.
- Cloud endpoints are HTTPS-only, contain no credentials/query/fragment, and use `redirect: "manual"`. Never forward provider bodies, audio, transcript text, credential sources, resolved credentials, environment names, or command text in browser errors or logs.
- The API key source follows Pi's documented value language: literals, `$ENV_VAR`/`${ENV_VAR}` interpolation, leading `!command`, `$$`, and `$!`. Commands are uncached, run as the gateway account, capture at most 64 KiB stdout, and receive no audio/transcript input. Use only trusted short-lived commands that do not daemonize; PI WEBUI bounds credential resolution and best-effort terminates the tracked process group/tree, but portable Node APIs cannot reclaim intentionally detached descendants.
- `speechInput.cloud.apiKey` is write-only at the browser boundary. Generic config responses omit all `speechInput`; generic config writes reject attempts to mutate it and preserve the existing raw object. Dedicated settings reads return only source kind/resolution, and blank credential input means preserve.
- PI WEBUI has no authentication layer. Do not add an ad hoc feature-specific auth mechanism; document that any client reaching the gateway can spend the configured cloud credential and trigger a configured credential command.
- Speech input remains gateway-only. Do not add speech selected-machine aliases, `FEDERATED_HTTP_ROUTES` entries, remote speech proxy paths, session-daemon speech/audio routes or runtime ownership, workspace files, attachments, browser storage, audio persistence, or transcript history. Task 1 may correct the existing generic selected-machine config proxy so its patch is merged atomically by the target gateway; that is shared config infrastructure, not speech federation. The only sessiond-loaded change is use of the shared config mutation coordinator for its existing model-tier/utility-model writes.
- Use application-relative browser paths `api/speech-input/settings` and `api/speech-input/transcribe` through `request()`. Do not add raw browser `fetch`, leading-root app paths, or WebSockets.
- Match existing composer geometry: microphone immediately before Send, 36 px icon controls above the 430 px breakpoint and 34 px below it. Agent-work Stop remains independently available during dictation.
- `PiWebUiApp.onKeyDown` remains the single capture-phase owner for global `Escape`: it delegates to `PromptEditor.cancelSpeechInput()` before shortcut dispatch. Do not add another window/document keydown listener.
- Use existing project patterns and no new runtime or development dependency. Keep exports consumed in the same task or meaningfully covered so every task is Knip-clean.
- Follow strict red-green TDD. Prove each RED failure is caused by the missing behavior, use injected clocks/timers/subprocess/media/fetch collaborators, and never use sleep ordering in automated tests.
- Run focused tests, typecheck, targeted ESLint, and Knip in every task. Never use `git commit --no-verify`; preserve the repository's pre-commit verification.
- Keep `README.md` and `CHANGELOG.md` unchanged. Synchronize `docs/config.md` and `docs/config.html`, add focused FAQ guidance, and create one minor Changeset for `@hyperdreamer/pi-webui`.
- This feature changes sessiond-loaded config persistence code but adds no speech/audio daemon route. A manual `pi-webui-sessiond.service` restart is required after implementation; ordinary web/API/UI changes still use the autoreload path.

## Task 1: Shared JSON config persistence prerequisite and speech-config redaction

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:245-315`
- Modify: `src/config.ts:1-380,430-470`
- Test: `src/config.test.ts:1-460`
- Modify: `src/cli.ts:90-100,345-350,821-840`
- Test: `src/cli.test.ts`
- Create: `src/configMutationCoordinator.ts`
- Create: `src/configMutationCoordinator.test.ts`
- Modify: `src/server/configRoutes.ts:1-180`
- Test: `src/server/configRoutes.test.ts:1-335`
- Modify: `src/server/machines/machineProxyRoutes.ts:1-115`
- Test: `src/server/app.machines.test.ts:100-280`
- Modify: `src/server/app.ts:195-215`
- Modify: `src/server/app.testSupport.ts:216-225`
- Test: `src/server/app.agentConfig.test.ts`
- Test: `src/server/app.activeAgentProfile.test.ts:119-140`
- Modify: `src/server/sessiond.ts:38,75-160`
- Create: `src/server/sessiond/configMutationWriters.ts`
- Create: `src/server/sessiond/configMutationWriters.test.ts`
- Modify: `src/server/sessions/modelTierSettingsRoutes.ts`
- Test: `src/server/sessions/modelTierSettingsRoutes.test.ts`
- Modify: `src/server/sessions/utilityModelSettingsRoutes.ts`
- Test: `src/server/sessions/utilityModelSettingsRoutes.test.ts`
- Test: `src/client/src/api/parsers.test.ts`

**Interfaces:**

- Consumes: existing `PiWebUiConfigValues`, `piWebUiConfigPath`, `piWebUiDataDir`, `loadPiWebUiConfig`, `savePiWebUiConfig`, `currentPiWebUiConfigResponse`, `PiWebUiConfigService`, native-service environment planning, generic/local/remote selected-machine config routes, and sessiond's model-tier/utility-model save callbacks.
- Produces in `src/shared/apiTypes.ts`:

```ts
export type SpeechInputProviderPreference = "auto" | "browser" | "cloud";

export interface PiWebUiSpeechInputCloudConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface PiWebUiSpeechInputConfig {
  provider?: SpeechInputProviderPreference;
  language?: string;
  cloud?: PiWebUiSpeechInputCloudConfig;
}
```

- Produces `speechInput?: PiWebUiSpeechInputConfig` on `PiWebUiConfigValues`.
- Produces exported `parseSpeechInputConfig(value: unknown, path: string): PiWebUiSpeechInputConfig` from `src/config.ts`.
- Produces cross-process mutation authority in `src/configMutationCoordinator.ts`:

```ts
export class PiWebUiConfigMutationBusyError extends Error {
  readonly code = "PI_WEBUI_CONFIG_BUSY";
}

export const PI_WEBUI_CONFIG_MUTATION_LOCK_TIMEOUT_MS = 10_000;
export const PI_WEBUI_CONFIG_MUTATION_RETRY_MS = 25;

export interface PiWebUiConfigMutationSnapshot {
  loaded: LoadedPiWebUiConfig;
  speechInputRevision: string;
}

export interface PiWebUiConfigMutationCoordinator {
  read(): Promise<PiWebUiConfigMutationSnapshot>;
  mutate(
    mutate: (current: PiWebUiConfigMutationSnapshot) => PiWebUiConfigValues,
    options?: { rotateSpeechInputRevision?: boolean },
  ): Promise<PiWebUiConfigMutationSnapshot>;
}

export interface PiWebUiConfigLockState {
  speechInputRevision: string;
  fileFingerprint: string;
}

export interface PiWebUiConfigLockDatabase {
  beginImmediate(): void;
  readState(): PiWebUiConfigLockState | undefined;
  writeState(state: PiWebUiConfigLockState): void;
  commit(): void;
  rollback(): void;
  close(): void;
}

export interface PiWebUiConfigFileIdentity {
  exists: boolean;
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface PiWebUiConfigMutationCoordinatorOptions {
  config?: LoadOptions;
  dataDir?: string;
  now?: () => number;
  scheduleRetry?: (callback: () => void, delayMs: number) => () => void;
  openDatabase?: (path: string) => PiWebUiConfigLockDatabase;
  readFileIdentity?: (path: string) => PiWebUiConfigFileIdentity;
  createRevision?: () => string;
}

export function piWebUiConfigMutationDatabasePath(
  configPath: string,
  dataDir: string,
): string;

export function createPiWebUiConfigMutationCoordinator(
  options?: PiWebUiConfigMutationCoordinatorOptions,
): PiWebUiConfigMutationCoordinator;
```

The private lock database path is `join(realpath(piWebUiDataDir(env, cwd)), "config-mutations", `${sha256(resolvedPiWebUiConfigPath)}.sqlite`)`, derived once for coordinator construction after ensuring the data root exists. This is PI WEBUI-managed state, never a sibling of a project-local `.pi-webui/config.json`, and it stores only one random opaque speech-input revision and a nonsecret fingerprint of config-file identity metadata; it stores no config, credential, audio, or transcript data. A configured data-root symlink is allowed only by canonicalizing it once to its target. On POSIX, require that canonical root to be a directory owned by `process.geteuid()` and not group/other-writable. Securely create/validate the owned `config-mutations` child at `0700`: reject a child symlink, non-directory, wrong owner, or group/other mode bits. Precreate the database exclusively at `0600` when absent; before every open, `lstat` and reject symlinks, non-regular files, POSIX wrong-owner files, or link count other than one, then chmod an accepted existing file to `0600` before `DatabaseSync` opens it. Keep DELETE journaling and create/use a one-row state table only after `BEGIN IMMEDIATE`; the journal remains inside the private owned child. Tests skip only unavailable owner/mode assertions on Windows, not path/type/symlink assertions.

Each attempt uses `PRAGMA busy_timeout=0`; SQLite contention is classified only by numeric `errcode === 5`, rolls back when needed, closes that database handle, and schedules another event-loop retry under one monotonic ten-second acquisition budget. Any other SQLite error fails immediately after close. Once acquired, load/stat current config while no production writer can replace it and assert `loaded.path` still equals the construction-time path. The default `readFileIdentity` uses bigint stat values and hashes fixed labels plus `exists/device/inode/size/mtimeNs/ctimeNs`; initialize or rotate the injected/default `randomUUID()` speech revision when that fingerprint differs, covering offline/manual replacement and a prior crash after JSON rename. Never hash file contents or expose raw metadata. `read()` returns that snapshot and commits. `mutate()` invokes the synchronous pure callback, then orders durability as: atomic JSON rename, authoritative reread/stat, explicit field-equality comparison of the pre-write raw `speechInput` against the authoritative post-write raw `speechInput`, revision/fingerprint state write, SQLite commit. Rotate speech revision only when that persisted subtree actually changed or `rotateSpeechInputRevision` is true. Speech PUT passes true so even an idempotent preserve/clear consumes its CAS revision; unrelated coordinated config mutations preserve it even when the requested value omitted fields that the low-level writer carried forward. A crash after JSON rename but before state commit leaves old state, whose fingerprint mismatch forces conservative revision rotation on recovery; state is never committed ahead of JSON. Throw/timeout/path mismatch rolls back and closes. Process crash releases the OS transaction; SQLite performs journal recovery on the next acquisition. Both web and sessiond pass the same frozen environment so they derive the same config and data paths. Concurrent manual file editing is unsupported; edit while services are stopped.
- Produces a config service backed by that coordinator:

```ts
export interface PiWebUiConfigService {
  read(): PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>;
  write(config: PiWebUiConfigValues): PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>;
  update(
    mutate: (current: PiWebUiConfigValues) => PiWebUiConfigValues,
  ): PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>;
}
```

`createFilePiWebUiConfigService` creates/injects one coordinator. Add a pure `piWebUiConfigResponseFromSnapshot(snapshot, options)` that calls `resolveEffectivePiWebUiConfig(snapshot.loaded, options)` without disk I/O. `write` calls `coordinator.mutate(() => config)`; `update` calls `coordinator.mutate(snapshot => mutate(snapshot.loaded.config))`; both project the returned HTTP/internal response from that exact committed snapshot after the coordinator resolves. Never call `currentPiWebUiConfigResponse()` after lock release for a mutation response, because a later writer may already have committed. The interface retains sync-or-Promise returns for simple injected test services, while the production file service is async. `invalidatePiWebUiStatusOnWrite` awaits/forwards and invalidates after both operations. No process-local queue is treated as cross-process safety.
- Produces exported pure `nativeServiceConfigEnvironment(configPathOverride, env, cwd): Readonly<Record<string, string>>` from `src/cli.ts`: when `configPathOverride` is defined it adds that already resolved value as `PI_WEBUI_CONFIG`; when `env.PI_WEBUI_DATA_DIR` is nonempty it adds `resolve(cwd, value)` as `PI_WEBUI_DATA_DIR`; absent/empty inputs add no corresponding override. Production and development native-service plans pass the same frozen result to web/sessiond (or sessiond/uiDev). This adds no new CLI flag and does not alter the default data directory.
- Produces exported `redactSpeechInputConfigResponse(response: PiWebUiConfigResponse): PiWebUiConfigResponse` from `src/server/configRoutes.ts`; only route serialization calls it. `PiWebUiConfigService.read()` remains full-fidelity because internal path-access/runtime consumers and later speech modules need the raw config.
- Persisted bounds are canonical language `.length <= 128`, trimmed base URL `.length <= 2_048`, trimmed model `.length <= 256`, and exact credential source `Buffer.byteLength(source, "utf8") <= 8 * 1024`. Base URL/model persist without outer whitespace. Credential source uses `source.trim()` only to reject blank input and otherwise persists byte-for-byte. Language uses `Intl.getCanonicalLocales`; this canonicalizes syntax only and preserves a well-formed unknown tag such as `qq-ZZ`.
- The config writer performs symlink-preserving same-directory atomic temp-file replacement through an injected sync file-operation seam used only by config persistence. It resolves an existing or dangling configured file symlink to the physical write target, creates/renames the temp beside that target, and leaves the configured symlink itself intact. A merged file containing a nonempty saved speech credential uses POSIX mode `0600`; later writes and explicit credential clearing preserve that restrictive existing mode. Credential-free config writes retain existing mode behavior.
- Produces from `src/config.ts`:

```ts
export interface PiWebUiConfigFileOperations {
  resolveWriteTarget(path: string): { path: string; mode?: number };
  writeExclusive(path: string, contents: string, mode: number): void;
  setMode(path: string, mode: number): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fileOperations?: PiWebUiConfigFileOperations;
}
```

The default adapter wraps Node sync filesystem calls and resolves write targets with the same physical-path semantics as `ProjectStore`: follow an existing configured symlink to its real file; for a dangling symlink, walk links without prematurely collapsing `..`, reject cycles/non-file terminal paths, and use the physical target parent. Existing callers omit the adapter; tests inject target/write/setMode/rename failures deterministically. `savePiWebUiConfig` writes the fully merged raw object to a unique temp beside that resolved physical target, adjusts final mode, atomically renames over the target, then returns by reloading the configured path. Every failure best-effort removes only its own temp and leaves the prior target or configured symlink readable.

- [ ] **Step 1: Write failing config and redaction tests**

Extend `src/config.test.ts` with exact cases that:

```ts
savePiWebUiConfig({
  speechInput: {
    provider: "cloud",
    language: "en-us",
    cloud: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-transcribe",
      apiKey: "$OPENAI_API_KEY",
    },
  },
}, testOptions());

expect(loadPiWebUiConfig(testOptions()).config.speechInput).toEqual({
  provider: "cloud",
  language: "en-US",
  cloud: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    apiKey: "$OPENAI_API_KEY",
  },
});
```

Also cover:

- omitted provider/language/cloud fields;
- syntactically valid `qq-ZZ` preserved;
- unknown root/cloud keys, provider outside `auto|browser|cloud`, exact/over character limits for language/base URL/model, exact/over UTF-8 byte limits for a multibyte credential source, malformed language, blank model/source, HTTP URL, URL credentials/query/fragment rejected;
- unrelated `savePiWebUiConfig({ port: 9000 })` preserving raw `speechInput` bytes semantically;
- an explicit internal save with `speechInput` replacing the prior raw speech subtree, plus a later speech object with no `cloud.apiKey` clearing only the credential source while retaining submitted nonsecret settings;
- symlink-preserving atomic replacement: an existing configured symlink remains a symlink while its physical target changes; a relative dangling symlink writes to its intended physical target without replacing the link; cycles and directory targets reject without artifacts; injected resolve/write/setMode/rename failures leave the prior target byte-identical and no owned `.*.tmp` file; success leaves no temp and reloads through the configured path;
- POSIX mode `0600` after creating a credential config, an existing `0644`/`0755` target tightened to `0600` when a credential is added, and clear/later writes preserving `0600`. Also prove a credential-free write preserves an existing `0644` mode instead of introducing unrelated tightening. Skip only numeric mode assertions on Windows, not persistence assertions.

Extend `src/server/configRoutes.test.ts` so a service response containing literal `speechInput.cloud.apiKey` is redacted from both generic GET response branches. Assert generic PUT with any `speechInput` key returns `400`, does not mutate, and mentions the dedicated endpoint. Assert unrelated generic/local-selected-machine updates preserve raw speech. Typed `PiWebUiConfigMutationBusyError` from generic or selected-machine mutation maps to safe `503 { error: "PI WEBUI config is busy. Try again." }`; ordinary unlocked read failures and unexpected mutation failures remain `500`.

Extend route fakes with synchronous `update` mutators and add event-ordered concurrent generic/local-selected-machine request tests that prove existing route semantics: selected-machine PUT merges into current config; generic PUT remains a full replacement of ordinary known keys while carrying forward private `speechInput`. In `src/server/app.machines.test.ts`, replace the old remote GET/merge/PUT expectation: remote selected-machine GET and PUT target `/api/machines/local/config`, PUT forwards only the validated portable patch once, the target response still undergoes safe projection and agent-profile persistence verification, unsafe keys are rejected before proxying, and no remote `/api/config` pre-read occurs. The local route/coordinator tests, not the proxy fake, prove the target merge serializes with sessiond. Update `invalidatePiWebUiStatusOnWrite`, `fakeConfigService()`, and `emptyConfigService()` for the async write/update signatures; extend `app.agentConfig.test.ts` so both local routes still invalidate status after success.

In `src/configMutationCoordinator.test.ts`, use structural fake databases plus injected clock/retry scheduler to prove immediate read/mutation acquisition, `errcode === 5` rollback/close/retry without blocking, one total 10,000 ms acquisition budget with no reset, non-contention error passthrough after close, rollback/close after callback/save/path-mismatch failure, queue recovery, deterministic canonical data-dir path keyed by the resolved config path, identical path derivation through a trusted data-root symlink, rejection of an untrusted POSIX group/other-writable root, private child/database mode and owner/type/link validation, child/database symlink rejection before SQLite open, no config/credential/audio/transcript bytes written to SQLite, stable random speech revision for one metadata fingerprint, preservation across unrelated coordinated writes including a callback result that omits a low-level-preserved speech subtree, automatic rotation when the authoritative persisted raw speech changes, forced rotation for an idempotent speech mutation, rotation after offline replacement without hashing file contents, and crash-after-rename fingerprint recovery.

Add a real two-process regression probe with a temporary JavaScript worker under `mkdtemp(join(tmpdir(), ...))`, launched by `process.execPath --import tsx/esm`. Worker A calls the production coordinator, reports an exact stdout milestone from inside its mutation callback after `BEGIN IMMEDIATE`, then blocks only its test process on `readSync(stdin)` while holding the transaction. Worker B calls the production coordinator with an injected retry scheduler that reports its first SQLite-contention milestone before scheduling the real retry. Wait for that explicit contention milestone, release A through stdin, then assert B's callback reads A's committed key and merges a different key. Repeat with A killed after B reports contention and prove B recovers without stale-lock cleanup. A deliberate no-lock control uses barriers to load both old snapshots before ordered writes and demonstrably loses one key. Do not use sleeps, polling, or a permanent fixture; enforce one outer test-process deadline only to fail/clean up a broken probe.

In `src/server/sessiond/configMutationWriters.test.ts`, inject one coordinator into a small production factory consumed by `sessiond.ts`; prove both model-tier and utility-model save callbacks call `mutate(current => next)` and preserve a concurrent speech subtree. Extend the two existing settings-route tests: typed `PiWebUiConfigMutationBusyError` maps to safe `503 { error: "PI WEBUI config is busy. Try again." }`; ordinary catalog/config validation remains `400`. Add a guarded production scan that allows direct `savePiWebUiConfig` only in `src/configMutationCoordinator.ts` and low-level config definitions/tests; `src/server/sessiond.ts` must not call `replacePiWebUiModelTiers` or `replacePiWebUiUtilityModels`.

Extend a generic config parser case in `src/client/src/api/parsers.test.ts` with a malicious `speechInput` field and assert `parsePiWebUiConfigResponse` does not project it into either parsed config object.

In `src/cli.test.ts`, test exported `nativeServiceConfigEnvironment` with explicit config-path override/env/cwd: custom config plus relative `PI_WEBUI_DATA_DIR` produces both absolute values; data-dir alone produces only its absolute value; missing/empty inputs produce no overrides. Through the existing native-service plan seam, assert production web/sessiond and development sessiond/uiDev receive byte-identical environment maps. Restore process env after each test.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npm test -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/cli.test.ts src/server/configRoutes.test.ts src/server/app.machines.test.ts src/server/app.agentConfig.test.ts src/server/app.activeAgentProfile.test.ts src/server/sessiond/configMutationWriters.test.ts src/server/sessions/modelTierSettingsRoutes.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/client/src/api/parsers.test.ts
```

Expected: FAIL because speech parsing/redaction, private atomic writes, native-service data-dir parity, target-side selected-machine patching, and cross-process mutation coordination do not exist. Verify each failing assertion reaches its intended missing behavior; the malicious client-parser projection assertion is defense in depth and may already pass against the current unknown-key-dropping parser, so do not count that assertion alone as RED.

- [ ] **Step 3: Implement strict persisted parsing and atomic private writes**

In `src/config.ts`:

- add `speechInput` to `piWebUiConfigRecord` and `parsePiWebUiConfig`;
- implement `parseSpeechInputConfig` with exact key allowlists at both levels, outer-whitespace trimming plus post-normalization `.length` checks for base URL/model, canonical language length checks, `Buffer.byteLength(..., "utf8")` only for the byte-exact credential source, `Intl.getCanonicalLocales`, and URL validation;
- delete `existing["speechInput"]` only when normalized input explicitly contains `speechInput`; omission preserves it;
- implement the `PiWebUiConfigFileOperations` adapter above and replace the direct final `writeFileSync(path, ...)` with resolved-physical-target `writeExclusive`, `setMode`, `rename`, and best-effort temp cleanup through the injected adapter; preserve existing/dangling configured symlinks rather than renaming over them;
- choose the final mode from the merged raw object. Always create the exclusive temp at `0o600`. If it contains a nonempty `speechInput.cloud.apiKey`, keep/set `0o600`; otherwise, when a target exists, `setMode(temp, existingMode & 0o777)` before rename so umask cannot silently change existing credential-free permissions. For a new credential-free file, set `0o666 & process.umask()`. Once a credential write has made the target `0600`, clear and later credential-free writes preserve that mode. Do not tighten unrelated credential-free existing configs.

Do not turn config loading into a browser-redacted representation.

After the low-level atomic writer is green, implement `configMutationCoordinator.ts` exactly as the interface above. Derive its private managed database path from both the resolved config path and `piWebUiDataDir`; validate the owned directory/file boundary before SQLite open. Keep SQLite synchronous calls limited to nonwaiting open/`BEGIN IMMEDIATE`/state read-write/commit/rollback/close; close every failed attempt and perform all contention waiting through injected event-loop retries. The mutation callback is synchronous and pure, so no network, provider, or user-controlled await occurs while holding the transaction. Keep the final authoritative reread inside the transaction. At the one total deadline, reject `PiWebUiConfigMutationBusyError`; do not fall back to an unlocked save.

In `cli.ts`, replace private `configEnvironment` with the exported pure helper above. Pass `options.config === undefined ? undefined : configPath`, plus the installer's environment/cwd; read only those injected values, trim only to classify absent/empty data-dir input, resolve the original nonempty data-dir value, and feed the resulting map unchanged to both process-owner service definitions in production and development installs. Do not add `--data-dir` or change doctor/restart parsing.

In `configRoutes.ts`, add a pure projection that shallow-copies both config objects and deletes `speechInput`. Apply it to GET and successful PUT of `/api/config`; selected-machine projections already exclude the key. Reject `Object.hasOwn(value, "speechInput")` in generic browser updates before parsing other fields.

Change generic and local-selected-machine read-modify-write routes to call `service.update`. Generic PUT's mutator receives current raw config and returns `{ ...parsedRequest, ...(current.speechInput === undefined ? {} : { speechInput: current.speechInput }) }`; local-selected-machine PUT returns `mergeSelectedMachineConfig(current, patch)`. Redact only returned generic browser responses. `createFilePiWebUiConfigService.read()` keeps the existing atomic JSON read path because ordinary reads expose no revision and need not acquire a write transaction; `write`/`update` use the injected coordinator and project effective/env-derived fields from the exact committed snapshot. It does not expose `speechInputRevision` through generic config. Map typed coordinator contention on mutations. Add a deferred response-order test: let mutation A commit, then B commit before A's route response is serialized; A must return A's own committed config, not B's later disk state.

In `machineProxyRoutes.ts`, keep the public federated path `/api/machines/:machineId/config` unchanged but translate remote selected-machine GET/PUT to the target gateway's existing `/api/machines/local/config`. Validate the PUT patch locally, forward exactly `{ config: patch }` once, and retain response filtering plus explicit agent-profile persistence verification. Remove the proxy-side generic `/api/config` GET/merge/PUT sequence. Do not add speech routes to federation.

In `sessiond.ts`, construct one coordinator with `daemonEnvironment`. Replace both direct low-level replacement callbacks with async coordinator mutations: model tiers return `{ ...current.loaded.config, modelTiers: ladder }`; utility models return `{ ...current.loaded.config, utilityModels: settings }`. Do not add a sessiond route, capability, secret transport, or new runtime ownership. This is a daemon-loaded persistence change and requires manual restart after deployment.

- [ ] **Step 4: Run focused and static checks**

Run:

```bash
npm test -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/cli.test.ts src/server/configRoutes.test.ts src/server/app.machines.test.ts src/server/app.agentConfig.test.ts src/server/app.activeAgentProfile.test.ts src/server/sessiond/configMutationWriters.test.ts src/server/sessions/modelTierSettingsRoutes.test.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/client/src/api/parsers.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/config.ts src/config.test.ts src/configMutationCoordinator.ts src/configMutationCoordinator.test.ts src/cli.ts src/cli.test.ts src/server/configRoutes.ts src/server/configRoutes.test.ts src/server/machines/machineProxyRoutes.ts src/server/app.machines.test.ts src/server/app.ts src/server/app.testSupport.ts src/server/app.agentConfig.test.ts src/server/app.activeAgentProfile.test.ts src/server/sessiond.ts src/server/sessiond/configMutationWriters.ts src/server/sessiond/configMutationWriters.test.ts src/server/sessions/modelTierSettingsRoutes.ts src/server/sessions/modelTierSettingsRoutes.test.ts src/server/sessions/utilityModelSettingsRoutes.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/client/src/api/parsers.test.ts
npx knip
```

Expected: focused tests pass with no failures; TypeScript and ESLint pass; Knip has no new unused export; native service plans give both process owners the same explicit data-dir when configured; the deliberate no-lock control loses an update while the real two-process coordinator probe preserves both keys and recovers after holder death; only existing Knip configuration hints may print.

- [ ] **Step 5: Commit**

```bash
git add src/shared/apiTypes.ts src/config.ts src/config.test.ts src/configMutationCoordinator.ts src/configMutationCoordinator.test.ts src/cli.ts src/cli.test.ts src/server/configRoutes.ts src/server/configRoutes.test.ts src/server/machines/machineProxyRoutes.ts src/server/app.machines.test.ts src/server/app.ts src/server/app.testSupport.ts src/server/app.agentConfig.test.ts src/server/app.activeAgentProfile.test.ts src/server/sessiond.ts src/server/sessiond/configMutationWriters.ts src/server/sessiond/configMutationWriters.test.ts src/server/sessions/modelTierSettingsRoutes.ts src/server/sessions/modelTierSettingsRoutes.test.ts src/server/sessions/utilityModelSettingsRoutes.ts src/server/sessions/utilityModelSettingsRoutes.test.ts src/client/src/api/parsers.test.ts
git commit -m "feat(config): coordinate cross-process mutations"
```

## Task 2: Pi-compatible asynchronous credential resolution

**Implementer tier:** Capable

**Files:**

- Modify: `src/shared/apiTypes.ts:245-315`
- Create: `src/server/speechInput/piCompatibleCredentialResolver.ts`
- Test: `src/server/speechInput/piCompatibleCredentialResolver.test.ts`

**Interfaces:**

- Consumes: `PiWebUiSpeechInputConfig["cloud"]["apiKey"]` from Task 1 and Pi's documented literal/environment/command behavior captured in the design spec.
- Produces in `src/shared/apiTypes.ts`:

```ts
export interface SpeechInputCredentialStatus {
  configured: boolean;
  source?: "literal" | "environment" | "command";
  resolution: "missing" | "resolved" | "unresolved" | "unchecked";
}
```

- Produces from `piCompatibleCredentialResolver.ts`:

```ts
export const SPEECH_INPUT_CREDENTIAL_COMMAND_TIMEOUT_MS = 10_000;
export const SPEECH_INPUT_CREDENTIAL_MAX_STDOUT_BYTES = 64 * 1024;

export interface CredentialCommandRequest {
  command: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
}

export type CredentialCommandRunner = (request: CredentialCommandRequest) => Promise<string>;

export interface CredentialSpawnedProcess {
  readonly pid: number | undefined;
  onStdout(listener: (chunk: Uint8Array) => void): () => void;
  onStderr(listener: (chunk: Uint8Array) => void): () => void;
  onClose(listener: (result: { code: number | null; error?: Error }) => void): () => void;
}

export interface CredentialProcessHost {
  spawn(command: string): CredentialSpawnedProcess;
  terminateTrackedProcesses(process: CredentialSpawnedProcess): void;
  scheduleDeadline(callback: () => void, delayMs: number): () => void;
}

export function createCredentialCommandRunner(host?: CredentialProcessHost): CredentialCommandRunner;

export interface ResolveCredentialOptions {
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  runCommand?: CredentialCommandRunner;
}

export function inspectPiCompatibleCredentialSource(
  source: string | undefined,
  env?: NodeJS.ProcessEnv,
): SpeechInputCredentialStatus;

export function resolvePiCompatibleCredentialSource(
  source: string | undefined,
  options: ResolveCredentialOptions,
): Promise<string>;
```

- Literal/template parsing exactly matches Pi: valid `$NAME` and `${NAME}` interpolate; missing/empty env values make the whole template unresolved; `$$` emits `$`; `$!` emits `!`; malformed braced references remain literal; leading unescaped `!` makes the entire remainder a command.
- The default runner uses nonblocking `spawn(..., { shell: true })`, one timer from spawn acceptance through process close, bounded stdout bytes, ignored-but-drained stderr, caller abort propagation, and idempotent cleanup/kill. It never uses `execSync`/`spawnSync`.

- [ ] **Step 1: Write failing resolver tests**

Create tests for these exact values:

```ts
expect(await resolvePiCompatibleCredentialSource("literal-key", options())).toBe("literal-key");
expect(await resolvePiCompatibleCredentialSource("$TOKEN", options({ TOKEN: "env-key" }))).toBe("env-key");
expect(await resolvePiCompatibleCredentialSource("${PREFIX}_${SUFFIX}", options({ PREFIX: "a", SUFFIX: "b" }))).toBe("a_b");
expect(await resolvePiCompatibleCredentialSource("$$cash-$!bang", options())).toBe("$cash-!bang");
```

Assert inspections for missing, literal resolved, environment resolved/unresolved, and command unchecked. Use an injected fake command runner to prove the leading `!` is stripped and the exact timeout/stdout bounds and caller signal are passed. Pin Pi's environment precedence with scoped process-environment restoration: a nonempty supplied value wins, an empty supplied value falls through to nonempty `process.env`, and the reference is unresolved only when the effective fallback value is also missing/empty.

Separately test `createCredentialCommandRunner` with an event-controlled structural `CredentialProcessHost`: emit stdout/process-exit/stream-close milestones to prove normal success waits for `close`, includes trailing stdout delivered after `exit`, trims once, and drains stderr. Also cover empty output, nonzero close code, synchronous spawn throw, asynchronous spawn error with undefined PID, 64 KiB exact success, one byte over rejection, caller abort, timeout, tracked-process cleanup once when a PID exists, no cleanup attempt without a PID, listener/timer cleanup, prompt rejection before a never-closing process settles, and late close after rejection. Never use sleeps or a real shell for these unit cases. Assert no thrown message contains command text or resolved value.

Add one POSIX-only default-host boundary test with temporary Node scripts: the configured command launches a `{ detached: true, stdio: "ignore" }` child, writes its PID atomically to a watched temp file, then remains pending. Wait on the file-watch/readiness event, abort the credential request, and assert prompt rejection plus tracked parent-group cleanup. Confirm the detached child is still outside the portable guarantee, then kill/reap it explicitly in `finally` and remove all temp files. Skip on Windows; use no sleeps or polling. This test documents why supported credential commands must not daemonize rather than pretending cleanup is stronger than Node permits.

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- --run src/server/speechInput/piCompatibleCredentialResolver.test.ts
```

Expected: FAIL with the module missing.

- [ ] **Step 3: Implement the parser and asynchronous runner**

Port only the documented value-language behavior, not Pi's private package file. Keep template tokenization pure and command execution behind `CredentialCommandRunner`. Resolve each name exactly as Pi does: `env?.[name] || process.env[name] || undefined`; a nonempty supplied value wins, an empty supplied value falls through, and only a missing/empty effective value is unresolved.

Implement the default `CredentialProcessHost` with nonblocking `spawn(..., { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true })`; adapt stdout/stderr plus child `error` and `close` into one idempotent structural close signal. Never settle success on child `exit`, which can precede trailing stdout and stream closure. On POSIX, `terminateTrackedProcesses` best-effort signals the original detached process group with `process.kill(-pid, "SIGKILL")` only when PID exists. On Windows it best-effort launches `taskkill /PID <pid> /T /F` with ignored stdio, again only with a PID. The original ten-second budget is not restarted for cleanup, and the runner rejects promptly once cleanup is issued without waiting for close. Arbitrary `setsid`/double-fork descendants are outside the portable guarantee; support only trusted non-daemonizing commands and document that limitation.

`createCredentialCommandRunner` must attach all listeners before exposing cancellation, use one idempotent `finish` function, clear its timer exactly once, drain stderr without storing it, and call `terminateTrackedProcesses` once on timeout, abort, or stdout overflow. Normalize failures to stable credential-resolution errors without source text; cleanup errors are swallowed after resolution ownership is settled.

- [ ] **Step 4: Run focused and static checks**

Run:

```bash
npm test -- --run src/server/speechInput/piCompatibleCredentialResolver.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/server/speechInput/piCompatibleCredentialResolver.ts src/server/speechInput/piCompatibleCredentialResolver.test.ts
npx knip
```

Expected: all resolver tests pass; no synchronous child-process API or unused export exists.

- [ ] **Step 5: Commit**

```bash
git add src/shared/apiTypes.ts src/server/speechInput/piCompatibleCredentialResolver.ts src/server/speechInput/piCompatibleCredentialResolver.test.ts
git commit -m "feat(speech-input): resolve Pi-compatible credentials"
```

## Task 3: Redacted speech settings HTTP and browser contracts

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:245-340`
- Create: `src/shared/speechInput.ts`
- Test: `src/shared/speechInput.test.ts`
- Create: `src/server/speechInput/speechInputSettingsService.ts`
- Test: `src/server/speechInput/speechInputSettingsService.test.ts`
- Create: `src/server/speechInput/speechInputSettingsRoutes.ts`
- Test: `src/server/speechInput/speechInputSettingsRoutes.test.ts`
- Modify: `src/server/app.ts:1-70,244-335`
- Modify: `src/server/app.testSupport.ts`
- Modify: `src/server/app.activeAgentProfile.test.ts`
- Create: `src/server/app.speechInput.test.ts`
- Modify: `src/client/src/api/parsers.ts:1-90,1760-1870`
- Test: `src/client/src/api/parsers.test.ts`
- Modify: `src/client/src/api/clients.ts:1-180`
- Test: `src/client/src/api/clients.test.ts:1-110`
- Modify: `src/client/src/api.ts:1-12`

**Interfaces:**

- Consumes: `PiWebUiConfigMutationCoordinator` and config projection/persistence from Task 1, plus `inspectPiCompatibleCredentialSource` from Task 2.
- Produces shared defaults and helpers:

```ts
export const SPEECH_INPUT_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const SPEECH_INPUT_DEFAULT_MODEL = "gpt-4o-mini-transcribe";

export interface SpeechInputSettings {
  provider: SpeechInputProviderPreference;
  language?: string;
  cloud: { baseUrl: string; model: string };
}

export interface SpeechInputSettingsResponse {
  contractVersion: 1;
  /** Canonical lowercase UUID; opaque to clients. */
  revision: string;
  settings: SpeechInputSettings;
  credential: SpeechInputCredentialStatus;
}

export type SpeechInputCredentialMutation =
  | { action: "preserve" }
  | { action: "replace"; value: string }
  | { action: "clear" };

export interface SpeechInputSettingsUpdate {
  expectedRevision: string;
  settings: SpeechInputSettings;
  credential: SpeechInputCredentialMutation;
}

export function effectiveSpeechInputSettings(config: PiWebUiSpeechInputConfig | undefined): SpeechInputSettings;
export function speechInputCloudLanguage(language: string | undefined): string | undefined;
export function speechInputTranscriptionEndpoint(baseUrl: string): string;
```

- `speechInputCloudLanguage("pt-BR")` returns `"pt"`; Auto returns `undefined`.
- `speechInputTranscriptionEndpoint` reparses an already validated HTTPS base URL, canonicalizes URL syntax, removes only trailing path slashes, and appends exactly one `/audio/transcriptions`; both preserved-credential endpoint comparison and the provider use this helper.
- Produces `SpeechInputSettingsService` with `read(): Promise<SpeechInputSettingsResponse>` and `update(value: unknown): Promise<SpeechInputSettingsResponse>`. It uses the shared cross-process `PiWebUiConfigMutationCoordinator`: `read()` projects `speechInputRevision` from one locked snapshot as public `revision`; `update()` strictly parses before mutation, compares `expectedRevision` inside the transaction, throws a typed conflict without writing on mismatch, and projects the committed rotated speech revision. Preserve/replace/clear keep the merge semantics below. A successful mutation calls an injected `onCommitted()` exactly once for PI WEBUI status-cache invalidation; conflict/failure does not.
- Produces gateway-only `GET/PUT /api/speech-input/settings`.
- Produces strict client parser `parseSpeechInputSettingsResponse` and `speechInputApi.settings()/saveSettings(update)` using application-relative paths.

- [ ] **Step 1: Write failing shared, service, route, parser, and client tests**

In pure tests, assert omitted config resolves to Auto, no language, OpenAI base URL, and default model; explicit values remain canonical; `pt-BR` maps to `pt`. Pin endpoint construction/canonical equivalence for host case, default HTTPS port, and trailing path slashes while preserving non-root base paths. Assert malformed/non-BCP-47 update language is rejected with `400`; omission is the only Auto wire representation.

In service tests use an in-memory full-fidelity `PiWebUiConfigMutationCoordinator` with explicit canonical UUID speech revisions and assert:

- reads return the coordinator's opaque `speechInputRevision` as response `revision`, never execute a command, and never return source text;
- literal/environment/command statuses are exactly `resolved`, `resolved|unresolved`, and `unchecked`;
- matching-revision `{ action: "preserve" }` changes provider/language/model without changing raw source and returns the rotated speech revision;
- when a credential source exists, preserve with the same derived transcription endpoint permits equivalent trailing-slash/canonical URL spelling, while preserve with a different endpoint rejects before save/onCommitted with safe `400 { error: "Re-enter the API key source when changing the cloud base URL." }`; no credential, replace, and clear follow their ordinary rules;
- replace stores the exact nonblank source but returns only redacted status;
- stale expected revision rejects with typed conflict before mutation/onCommitted for preserve, replace, and clear, leaking neither current revision nor settings;
- clear ignores submitted nonsecret values after validating shape, copies the matching current raw speech/cloud subtree inside `coordinator.mutate`, removes only `apiKey` without materializing defaults, and returns the committed effective snapshot/revision;
- mutations delegate to the coordinator; event-controlled tests interleave speech with generic, selected-machine, model-tier, and utility-model updates in both orderings and prove intended fields survive;
- unknown fields at update/settings/cloud/credential levels, missing/noncanonical UUID `expectedRevision`, an unexpected PUT `contractVersion`, invalid provider, malformed language/URL/model, invalid credential action, blank replacement, and extra mutation fields reject before coordinator mutation.

In route tests assert strict `400`, including the exact preserved-credential endpoint error `{ error: "Re-enter the API key source when changing the cloud base URL." }`; typed conflict `409` with exact `{ error: "Speech input settings changed. Reload and try again." }`; typed config-busy `503` with exact `{ error: "PI WEBUI config is busy. Try again." }`; safe unexpected `500`; and no selected-machine alias. In `app.speechInput.test.ts`, use `registerAppTestHooks()` to prove `/api/speech-input/settings` exists while `/api/machines/local/speech-input/settings` is `404`, and a successful speech PUT invalidates status exactly once while validation/conflict/busy does not.

In parser tests require exact nested fields and reject noncanonical UUID revision, wrong contract version, unknown keys at response/settings/cloud/credential levels, inconsistent `configured/source/resolution` combinations, and leaked source-like fields.

In the nested-base client test assert exact URLs and JSON:

```ts
const current = await speechInputApi.settings();
await speechInputApi.saveSettings({
  expectedRevision: current.revision,
  settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" } },
  credential: { action: "preserve" },
});
```

Expected URLs end in `nested/pi-webui/api/speech-input/settings`; GET uses `cache: "no-store"`; PUT body is the exact update.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
npm test -- --run src/shared/speechInput.test.ts src/server/speechInput/speechInputSettingsService.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
```

Expected: FAIL because settings types/helpers/service/routes/client do not exist.

- [ ] **Step 3: Implement the deep settings module and strict browser edge**

Keep raw config knowledge inside `SpeechInputSettingsService`. `read()` calls `coordinator.read()` and derives effective nonsecret settings plus status from that locked snapshot; it calls only the nonexecuting credential inspector and maps `speechInputRevision` to public `revision`. `update()` strictly parses the whole object before `coordinator.mutate(current => next, { rotateSpeechInputRevision: true })`, then compares `expectedRevision` with `current.speechInputRevision` inside the mutation callback. Throw the typed conflict before constructing a replacement on mismatch, so conflict never rotates. For preserve, compare `speechInputTranscriptionEndpoint` for the current effective base URL and submitted base URL. If a raw credential source exists and those endpoints differ, throw a typed settings validation error with exact safe text `Re-enter the API key source when changing the cloud base URL.` before save; changing the endpoint requires replace in the same request or a prior clear. Preserve otherwise retains the source, and replace builds the submitted settings with the new source. Clear copies `current.loaded.config.speechInput` and its cloud object, deletes only `apiKey`, and does not materialize defaults into raw config or apply submitted nonsecret fields. Return the committed snapshot's rotated `speechInputRevision` as `revision` and call `onCommitted()` once only after success. Do not add a speech-only queue or coordinator.

In production `buildApp`, construct one coordinator, pass it to `createFilePiWebUiConfigService`, and pass that exact same instance to `SpeechInputSettingsService` with `onCommitted: piWebUiStatusCache.invalidate`. Preserve existing `deps.config` test injection: `app.testSupport.ts` and `app.activeAgentProfile.test.ts` explicitly pair their custom config services with an injected fake speech settings service; production never silently creates a second authority. Add optional injectable coordinator/settings dependencies to `AppDependencies`; do not route speech settings through sessiond or add close hooks/machine routes.

Implement strict unknown-input parsers at both server and browser edges. Export types and `speechInputApi` through `src/client/src/api.ts` once they are consumed by production code or meaningfully covered by client tests in this task.

- [ ] **Step 4: Run focused and static checks**

Run:

```bash
npm test -- --run src/shared/speechInput.test.ts src/server/speechInput/speechInputSettingsService.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/shared/speechInput.ts src/shared/speechInput.test.ts src/server/speechInput/speechInputSettingsService.ts src/server/speechInput/speechInputSettingsService.test.ts src/server/speechInput/speechInputSettingsRoutes.ts src/server/speechInput/speechInputSettingsRoutes.test.ts src/server/app.ts src/server/app.testSupport.ts src/server/app.activeAgentProfile.test.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts
npx knip
```

Expected: tests and static checks pass; preserving a configured credential cannot redirect it to a different cloud endpoint; no response contains raw credential material; no machine speech route is added.

- [ ] **Step 5: Commit**

```bash
git add src/shared/apiTypes.ts src/shared/speechInput.ts src/shared/speechInput.test.ts src/server/speechInput/speechInputSettingsService.ts src/server/speechInput/speechInputSettingsService.test.ts src/server/speechInput/speechInputSettingsRoutes.ts src/server/speechInput/speechInputSettingsRoutes.test.ts src/server/app.ts src/server/app.testSupport.ts src/server/app.activeAgentProfile.test.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts
git commit -m "feat(speech-input): add redacted gateway settings API"
```

## Task 4: Bounded OpenAI-compatible transcription gateway

**Implementer tier:** Capable

**Files:**

- Modify: `src/shared/apiTypes.ts:245-350`
- Create: `src/shared/speechInputAudio.ts`
- Test: `src/shared/speechInputAudio.test.ts`
- Create: `src/server/speechInput/openAiCompatibleTranscriptionProvider.ts`
- Test: `src/server/speechInput/openAiCompatibleTranscriptionProvider.test.ts`
- Create: `src/server/speechInput/speechTranscriptionService.ts`
- Test: `src/server/speechInput/speechTranscriptionService.test.ts`
- Create: `src/server/speechInput/speechInputTranscriptionRoutes.ts`
- Test: `src/server/speechInput/speechInputTranscriptionRoutes.test.ts`
- Modify: `src/server/app.ts:1-75,244-345`
- Modify: `src/server/app.speechInput.test.ts`
- Modify: `src/client/src/api/parsers.ts:1-100`
- Test: `src/client/src/api/parsers.test.ts`
- Modify: `src/client/src/api/clients.ts:150-190`
- Test: `src/client/src/api/clients.test.ts:1-145`
- Modify: `src/client/src/api.ts:1-12`

**Interfaces:**

- Consumes: `PiWebUiConfigMutationCoordinator.read()` for a short locked private-config snapshot, `resolvePiCompatibleCredentialSource`, `effectiveSpeechInputSettings`, `speechInputCloudLanguage`, and `speechInputTranscriptionEndpoint` from Tasks 1-3.
- Produces:

```ts
export interface SpeechInputTranscribeResponse { text: string; }

export const SPEECH_INPUT_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const SPEECH_INPUT_MAX_TRANSCRIPT_BYTES = 1024 * 1024;
export const SPEECH_INPUT_PROVIDER_TIMEOUT_MS = 120_000;
export const SPEECH_INPUT_UPLOAD_TIMEOUT_MS = 130_000;

export type SpeechInputAudioMimeType =
  | "audio/webm;codecs=opus"
  | "audio/ogg;codecs=opus"
  | "audio/mp4;codecs=mp4a.40.2"
  | "audio/mp4";

export function parseSpeechInputAudioMimeType(value: string | undefined): SpeechInputAudioMimeType | undefined;
export function speechInputAudioFilename(value: SpeechInputAudioMimeType): "speech.webm" | "speech.ogg" | "speech.m4a";
```

- Produces `OpenAiCompatibleTranscriptionProvider.transcribe(request): Promise<string>` with injected `fetch`, monotonic clock, and deadline scheduler.
- Produces `SpeechTranscriptionService.transcribe({ audio: Buffer; mimeType; signal }): Promise<string>`.
- Produces gateway-only `POST /api/speech-input/transcribe`, strict 20 MiB per-route body limit, exact MIME parser/validation, two-request pre-parse admission, one 130-second admission-to-body-completion deadline, close cancellation, and safe `400/413/415/429/500/502/503/504` mapping. Missing or syntactically valid unsupported media, including a parameterized nonallowlisted type, is normalized to `400`; a syntactically invalid `Content-Type` is rejected by Fastify as `415` before parser lookup and is covered explicitly. Upload deadline destroys the partial connection; it does not promise a deliverable HTTP status after parsing has begun.
- Extends `speechInputApi` with `transcribe(audio: Blob, mimeType: SpeechInputAudioMimeType, signal?: AbortSignal)`.

- [ ] **Step 1: Write failing audio and provider tests**

Pure tests pin all four case-insensitive/whitespace-normalized accepted MIME values and filenames; reject charset, unknown codecs, missing codec on WebM/Ogg, and arbitrary parameters.

Provider tests inject a fake `fetch`, monotonic `now`, and a deadline scheduler whose callbacks are released by explicit events. Include an abort-ignoring deferred Fetch and an abort-ignoring deferred body read. Caller abort must reject promptly before either collaborator settles; independently, releasing the 120-second callback must reject promptly before settlement. When the deferred Fetch later resolves with a response whose body has not been acquired, assert its body is canceled once; when a deferred reader later resolves, assert the reader is canceled/released once. No late settlement may change the already returned result or produce an unhandled rejection. Assert:

- endpoint `https://api.openai.com/v1/audio/transcriptions`;
- `redirect: "manual"`, exact Bearer header, multipart `file`, `model`, and optional primary language;
- filename and Blob type match the MIME helper;
- no language field in Auto;
- HTTP redirect/auth/error/provider-body cases become stable errors that do not include body/key/audio/transcript and call `response.body?.cancel()` best-effort before return without reading the body; an endless error stream observes cancellation;
- exactly 1 MiB response succeeds, one byte over cancels the active reader and aborts bounded reading, with the size check applied to response bytes before text decoding;
- malformed JSON, nonobject, missing/blank/over-limit text reject;
- caller abort and one 120-second total deadline cover fetch and body reading without timeout reset.

Use controllable `ReadableStream` and injected scheduler/clock milestones; do not sleep.

- [ ] **Step 2: Write failing service and route tests**

Service tests inject the same in-memory coordinator shape from Task 3 and assert each request performs exactly one short `coordinator.read()`, copies the raw cloud source plus effective URL/model/language, and releases that read transaction before credential resolution/provider awaits. Missing/unresolved/empty credential fails before provider call; command source resolves once per request; URL/model/language come only from that captured persisted snapshot; resolver/provider receive the same request-close abort signal; no request field can override config. Add one cancellation-order probe with a deferred resolver: abort while credential resolution is pending, assert the provider is never called after resolver settlement, and assert the request rejects without a second deadline. Pin typed error ownership: config contention maps to `503`; absent/unresolved/failed credential resolution, including command timeout, maps to `503`; provider's internal 120-second timeout maps to `504`; a request-close abort performs cleanup and does not attempt a second reply; unexpected faults map to a generic `500`.

Route tests configure small injectable test limits while preserving production defaults. Prove:

- accepted raw Buffer reaches service with exact normalized MIME;
- empty/missing-type/unsupported/oversized requests map correctly, including `video/webm;codecs=vp9` producing the same safe `400` as an unsupported unparameterized media type, while a syntactically invalid content-type header is explicitly `415`;
- a route `bodyLimit: 5` accepts 3 bytes even when Fastify global limit is 2, rejects 6 bytes, and still rejects 6 when global limit is 100;
- two deferred admitted requests hold the gate, a third returns `429` without a service call, and admission recovers after success, handler/service error, body-limit `413`, malformed-content pre-parser `415`, upload connection destruction, and client close;
- a real `net.Socket` TCP test sends valid request headers and trickles partial audio without completing the body. Use an injected deadline scheduler released by an explicit test event (not 130 seconds of wall time); assert the server aborts/destroys the request, releases admission exactly once, a third complete request is admitted, and late socket events do not release twice;
- request/reply close aborts provider work and releases admission exactly once, using a real listener plus `fetch`/`AbortController` patterned after TTS; normal request-stream completion followed by deferred provider work keeps admission held and is not mistaken for disconnect;
- route scheduler records one 130,000 ms upload deadline from `onRequest`, proves trickled chunks do not reset it, and proves raw body completion clears it before provider work;
- stable safe mappings never include injected secret/provider body strings.

Extend the app test to assert the gateway route exists and `/api/machines/local/speech-input/transcribe` is `404`.

Extend client parser/client tests for strict `{ text }`, raw Blob body, explicit content type/signal, nested base URL, and absence of `/machines/`.

- [ ] **Step 3: Run all new tests and confirm RED**

Run:

```bash
npm test -- --run src/shared/speechInputAudio.test.ts src/server/speechInput/openAiCompatibleTranscriptionProvider.test.ts src/server/speechInput/speechTranscriptionService.test.ts src/server/speechInput/speechInputTranscriptionRoutes.test.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
```

Expected: FAIL because audio/provider/service/transcription routes and client method are missing.

- [ ] **Step 4: Implement provider and service deadlines**

Use `speechInputTranscriptionEndpoint(baseUrl)` from Task 3 at the provider edge rather than rebuilding URL semantics locally, and reject redirects. Wrap the Fetch promise immediately in a terminal-aware continuation: if cancellation/timeout already won when an abort-ignoring Fetch resolves later, best-effort cancel that response body and consume any continuation rejection without reviving the operation. For redirect/non-2xx responses, call `response.body?.cancel()` best-effort before throwing the typed safe error; never read or log that body. Compose caller cancellation with one internal deadline controller plus explicit caller-abort and deadline-rejection promises; race both against Fetch plus bounded success-body reading so cancellation/timeout settles even if a collaborator ignores abort. Clear one timer in `finally`, detach caller listeners, cancel any acquired success reader on overflow/abort/timeout, release its lock on every terminal path, and terminal-check again when any deferred `reader.read()` resolves so a late chunk cannot escape cleanup. Read success chunks with a running byte count before decoding/JSON parsing. Check `signal.aborted` before calling Fetch and after each awaited read so a deferred collaborator cannot revive canceled work.

`SpeechTranscriptionService` calls the shared coordinator's `read()` once per request, immediately copies the current raw credential source plus effective URL/model/language, and lets the read transaction close before any credential command or provider await. It rejects absent cloud config/source, resolves the captured source only after audio validation, then rechecks `signal.aborted` before provider invocation and sends the captured persisted settings to the provider. A settings save after this snapshot affects the next transcription request, not a half-started one. Define narrow custom error classes or discriminated error codes so routes can map stable statuses without inspecting provider messages.

- [ ] **Step 5: Implement pre-parse admission and raw route ownership**

Within the speech route's encapsulated Fastify plugin, register exact/base buffer parsers for the accepted audio families plus a final local `*` buffer parser so even parameterized unsupported media reaches strict route validation. Fastify's exact/base allowlist parsers take precedence; the catch-all is scoped to this plugin and must not affect any other route. Validate the full original `Content-Type` header with `parseSpeechInputAudioMimeType` before using the Buffer. Do not rely on `registerWorkspaceExplorerRoutes` registration order.

Implement a route-local admission module whose `acquire()` returns an idempotent release callback or `undefined`. Acquire in route `onRequest`; create one upload-deadline canceler and store cleanup in a `WeakMap<FastifyRequest, ...>`. Start the 130,000 ms deadline immediately after admission and never reset it on chunks. Attach raw request `end`/`aborted` listeners before parsing: `end` clears only the upload timer; timeout aborts the per-request controller, idempotently releases admission, and destroys the partial socket without promising an HTTP response. Attach `reply.raw.once("close", ...)` with the TTS `writableEnded` guard for disconnected responses. Route `onResponse`/`onError` call the same cleanup; parse failures release admission. Final cleanup clears timer/listeners, aborts active downstream work, and releases once. A rejected request sends `429` before parsing.

Register the default service in `buildApp` with injectable route service support for app tests. Production passes the exact coordinator already shared by generic config and `SpeechInputSettingsService`; it never constructs a second file authority. Existing custom-config test harnesses explicitly inject fake settings and transcription services, so app tests perform no hidden config/data-directory I/O. Add no on-close work beyond active request aborts and no machine/federated route.

- [ ] **Step 6: Run focused and static checks**

Run:

```bash
npm test -- --run src/shared/speechInputAudio.test.ts src/server/speechInput/openAiCompatibleTranscriptionProvider.test.ts src/server/speechInput/speechTranscriptionService.test.ts src/server/speechInput/speechInputTranscriptionRoutes.test.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/shared/speechInputAudio.ts src/shared/speechInputAudio.test.ts src/server/speechInput/openAiCompatibleTranscriptionProvider.ts src/server/speechInput/openAiCompatibleTranscriptionProvider.test.ts src/server/speechInput/speechTranscriptionService.ts src/server/speechInput/speechTranscriptionService.test.ts src/server/speechInput/speechInputTranscriptionRoutes.ts src/server/speechInput/speechInputTranscriptionRoutes.test.ts src/server/app.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts
npx knip
```

Expected: all pass; no raw browser fetch, remote route, unbounded read, or new dependency.

- [ ] **Step 7: Commit**

```bash
git add src/shared/apiTypes.ts src/shared/speechInputAudio.ts src/shared/speechInputAudio.test.ts src/server/speechInput/openAiCompatibleTranscriptionProvider.ts src/server/speechInput/openAiCompatibleTranscriptionProvider.test.ts src/server/speechInput/speechTranscriptionService.ts src/server/speechInput/speechTranscriptionService.test.ts src/server/speechInput/speechInputTranscriptionRoutes.ts src/server/speechInput/speechInputTranscriptionRoutes.test.ts src/server/app.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts
git commit -m "feat(speech-input): add bounded cloud transcription"
```

## Task 5: Provider selection and transcript insertion core

**Implementer tier:** Standard

**Files:**

- Create: `src/client/src/speechInput/speechInputCore.ts`
- Test: `src/client/src/speechInput/speechInputCore.test.ts`

**Interfaces:**

- Consumes: `SpeechInputSettingsResponse`, credential status, transcript/audio bounds, and MIME types from Tasks 3-4.
- Produces:

```ts
export type SpeechInputProviderId = "browser" | "cloud";
export type SpeechInputAvailability =
  | { available: true }
  | { available: false; reason: string };

export interface SpeechInputAvailabilityMap {
  browser: SpeechInputAvailability;
  cloud: SpeechInputAvailability;
}

export type SpeechInputProviderResolution =
  | { available: true; provider: SpeechInputProviderId }
  | { available: false; reason: string };

export type SpeechInputComposerIdentity =
  | { kind: "starter"; machineId: string; projectId: string; workspaceId: string }
  | { kind: "session"; machineId: string; projectId: string; workspaceId: string; sessionId: string };

export interface SpeechInputTargetSnapshot {
  identity: SpeechInputComposerIdentity;
  text: string;
  from: number;
  to: number;
}

export type SpeechTranscriptInsertion =
  | { ok: true; insert: string; from: number; to: number; caret: number }
  | { ok: false; reason: "empty" | "too-large" | "changed" };

export function resolveSpeechInputProvider(
  settings: SpeechInputSettingsResponse,
  availability: SpeechInputAvailabilityMap,
): SpeechInputProviderResolution;

export function buildSpeechTranscriptInsertion(
  captured: SpeechInputTargetSnapshot,
  currentText: string,
  transcript: string,
): SpeechTranscriptInsertion;

export function chooseSpeechInputAudioMimeType(
  isTypeSupported: (type: string) => boolean,
): SpeechInputAudioMimeType | undefined;
```

- Auto selects Browser then Cloud; explicit choices never fall back. Cloud is unavailable for credential `missing|unresolved`, eligible for `resolved|unchecked` when media capability is available.
- Insertion trims only outer transcript whitespace, checks exact captured/current text equality and 1 MiB UTF-8 transcript bound, replaces the captured range, and returns one insert string/caret using the spec's opening/closing punctuation rules.

- [ ] **Step 1: Write failing pure tests**

Cover the complete provider matrix: Auto browser success; Auto cloud fallback; neither available with combined stable reason; explicit Browser/Cloud no fallback; command `unchecked` Cloud eligible; unresolved Cloud ineligible. Two settings responses differing only in opaque `revision` must resolve identically; revision is persistence metadata, not provider input.

Cover insertion into empty text, middle caret, selected replacement, astral characters before/inside the selected UTF-16 range, existing left/right whitespace, opening delimiters `([{`, closing punctuation `.,;:!?%)]}`, dictated punctuation/capitalization preservation, stale text, blank transcript, exact 1 MiB UTF-8 text, and one byte over. Assert the returned `caret` equals `from + insert.length` in JavaScript/CodeMirror UTF-16 offsets.

Cover exact ordered MIME selection and no-supported-type behavior.

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- --run src/client/src/speechInput/speechInputCore.test.ts
```

Expected: FAIL with the module missing.

- [ ] **Step 3: Implement pure deterministic helpers**

Use `TextEncoder` for browser UTF-8 byte counts; never import or rely on Node `Buffer` in client code. Validate `0 <= from <= to <= captured.text.length`; an invalid captured range returns `changed`. Use explicit sets `([{` and `.,;:!?%)]}`. Add a left boundary space only when both sides are nonwhitespace, the previous character is not an opening delimiter, and transcript does not begin with closing punctuation. Apply the symmetric rule on the right, including no space after a transcript-ending opening delimiter or before suffix closing punctuation. Do not normalize internal transcript whitespace.

Use the exact MIME order from the design and Task 4.

- [ ] **Step 4: Run focused and static checks**

Run:

```bash
npm test -- --run src/client/src/speechInput/speechInputCore.test.ts
npm run typecheck
npx eslint src/client/src/speechInput/speechInputCore.ts src/client/src/speechInput/speechInputCore.test.ts
npx knip
```

Expected: all pass with no DOM/global stubs.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/speechInput/speechInputCore.ts src/client/src/speechInput/speechInputCore.test.ts
git commit -m "feat(speech-input): add provider and insertion core"
```

## Task 6: Browser speech-recognition adapter

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/speechInput/speechInputProvider.ts`
- Create: `src/client/src/speechInput/speechRecognitionAdapter.ts`
- Test: `src/client/src/speechInput/speechRecognitionAdapter.test.ts`

**Interfaces:**

- Consumes: provider IDs and availability from Task 5.
- Produces provider seam:

```ts
export interface SpeechInputProviderCallbacks {
  onListening(): void;
  onInterim(text: string): void;
  onTranscribing(): void;
  onComplete(text: string): void;
  onError(error: SpeechInputProviderError): void;
}

export interface SpeechInputProviderError {
  code: "permission-denied" | "no-speech" | "microphone-unavailable" | "unsupported" | "recording-limit" | "network" | "provider";
  message: string;
}

export interface SpeechInputProviderRun {
  stop(): void;
  cancel(): void;
}

export interface SpeechInputProviderAdapter {
  readonly id: SpeechInputProviderId;
  availability(): SpeechInputAvailability;
  start(input: { language?: string; callbacks: SpeechInputProviderCallbacks }): SpeechInputProviderRun;
}
```

- Produces `SpeechRecognitionAdapter` with injected secure-context flag, standard/prefixed constructor lookup, and deadline scheduler using project-owned interfaces rather than experimental DOM typings.
- Browser final segments accumulate independently from the latest interim segment. Natural end or Stop completes only the current noncanceled run; Cancel calls `abort()` and emits no completion/error. Stop starts one injected 2,000 ms settlement watchdog: `end` settles normally before it; expiry aborts the recognition instance and completes accumulated final text or emits `no-speech`, ensuring user/time-limit Stop cannot hang indefinitely.

- [ ] **Step 1: Write failing fake-recognition tests**

Build a controllable fake recognition constructor exposing event callbacks, `start`, `stop`, and `abort` spies. Test:

- insecure context/missing constructor availability reasons;
- standard constructor preferred, prefixed constructor accepted;
- fresh instance per run, `continuous = true`, `interimResults = true`, language omitted for Auto and set for explicit language;
- `onstart` emits Listening;
- mixed result batches accumulate final text and replace interim text;
- natural end returns accumulated final text;
- Stop calls recognition stop and later end completes; synchronous stop throw settles `microphone-unavailable` exactly once; if end never arrives, an event-controlled 2,000 ms watchdog aborts and completes accumulated final text or emits `no-speech`;
- Cancel calls abort and suppresses late result/error/end;
- no-speech/no-match/permission/network errors map to exact normalized codes without raw vendor text;
- an end with no final speech maps to `no-speech` exactly once.

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- --run src/client/src/speechInput/speechRecognitionAdapter.test.ts
```

Expected: FAIL because the seam and adapter are missing.

- [ ] **Step 3: Implement one-run callback ownership**

Use a fresh internal state object per `start`. Make terminal settlement idempotent. Inject `scheduleDeadline` with a real-time default and clear its canceler on every terminal path; tests release callbacks explicitly and never sleep. Iterate results from `resultIndex`, concatenate finalized segments in recognition order, and publish only the latest nonfinal aggregate as interim. Do not call `onTranscribing` for Browser.

Catch synchronous constructor/start/stop failures as `unsupported` or `microphone-unavailable` without throwing through the click/timer handler. Cancel marks the run terminal before best-effort `abort()` and swallows an abort throw so cancellation remains silent.

- [ ] **Step 4: Run focused and static checks**

Run:

```bash
npm test -- --run src/client/src/speechInput/speechRecognitionAdapter.test.ts
npm run typecheck
npx eslint src/client/src/speechInput/speechInputProvider.ts src/client/src/speechInput/speechRecognitionAdapter.ts src/client/src/speechInput/speechRecognitionAdapter.test.ts
npx knip
```

Expected: tests and checks pass; no global experimental type augmentation is added.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/speechInput/speechInputProvider.ts src/client/src/speechInput/speechRecognitionAdapter.ts src/client/src/speechInput/speechRecognitionAdapter.test.ts
git commit -m "feat(speech-input): add browser recognition adapter"
```

## Task 7: Cloud MediaRecorder adapter

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/speechInput/mediaRecorderAdapter.ts`
- Test: `src/client/src/speechInput/mediaRecorderAdapter.test.ts`

**Interfaces:**

- Consumes: provider seam from Task 6, MIME choice from Task 5, audio limits from Task 4, and `speechInputApi.transcribe`.
- Produces `MediaRecorderAdapter implements SpeechInputProviderAdapter` with injected browser host:

```ts
export interface SpeechMediaTrack {
  stop(): void;
}

export interface SpeechMediaStream {
  getTracks(): readonly SpeechMediaTrack[];
}

export interface SpeechMediaRecorder {
  readonly mimeType: string;
  onStart(listener: () => void): () => void;
  onData(listener: (data: Blob) => void): () => void;
  onStop(listener: () => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  start(timesliceMs: number): void;
  stop(): void;
}

export interface SpeechMediaHost {
  secureContext: boolean;
  getUserMedia(): Promise<SpeechMediaStream>;
  isTypeSupported(type: string): boolean;
  createRecorder(stream: SpeechMediaStream, mimeType: SpeechInputAudioMimeType): SpeechMediaRecorder;
  transcribe(audio: Blob, mimeType: SpeechInputAudioMimeType, signal: AbortSignal): Promise<SpeechInputTranscribeResponse>;
}

export class MediaRecorderAdapter implements SpeechInputProviderAdapter {
  readonly id = "cloud" as const;
  constructor(host?: SpeechMediaHost);
  availability(): SpeechInputAvailability;
  start(input: { language?: string; callbacks: SpeechInputProviderCallbacks }): SpeechInputProviderRun;
}
```

The default host is a thin browser adapter around `navigator.mediaDevices.getUserMedia({ audio: true })` and `MediaRecorder`; the provider module and tests use only the structural interfaces above.

- Starts recording with a 1,000 ms timeslice. Stop emits `onTranscribing` synchronously exactly once before calling `recorder.stop()`, then waits for final data/stop to construct and upload; this lets the controller's 130-second watchdog cover recorder finalization too. Cancel aborts permission/recording/upload and never transcribes or emits terminal error. One idempotent terminal cleanup unsubscribes all recorder handlers, stops tracks, aborts upload when applicable, and clears chunks/Blob/stream/recorder/controller references on every terminal path.
- Chunks are retained only while total bytes remain `<= 20 MiB`; crossing discards the entire recording and emits `recording-limit`. On a chunk that brings retained bytes to exactly 20 MiB, the adapter calls recorder Stop once to finalize; a later nonempty final chunk that would cross still discards the entire recording. Encoded data is never sliced.

- [ ] **Step 1: Write failing permission/recording tests**

Use controllable promises and structural fake stream/track/recorder objects with no type assertions. Assert the default browser host requests exact `{ audio: true }`, MIME choice is passed exactly to `createRecorder`, and the adapter calls `start(1_000)`. The fake emits recorder Start and the adapter emits `onListening` only then. Assert the recorder's actual `mimeType` is normalized and revalidated after construction: an accepted actual type becomes the upload type/filename, while an unsupported actual type stops tracks and fails before recording.

Cover permission denial and Cancel during pending permission, including a `getUserMedia()` promise that resolves after Cancel: every track on that late stream is stopped exactly once, no recorder is constructed, and no callback fires. Also cover recorder construction/start/stop synchronous throws, Stop/cancel during active recording, recorder asynchronous error, final data ordering, zero-byte/no-speech result, a data chunk reaching exactly 20 MiB and triggering one clean Stop/upload, one-byte-over emitting `recording-limit` and discarding all chunks, every acquired track stopped exactly once, and no object URL/storage/file side effect. Every terminal case asserts each listener unsubscribe runs exactly once when registered (zero before recorder/listener creation), fake listener counts return to zero, late emitted events do nothing, and no post-terminal Blob/transcription is created.

- [ ] **Step 2: Write failing upload lifecycle tests**

Assert Stop emits `onTranscribing` synchronously before calling recorder Stop, then final stop/data causes one API call with final Blob/MIME/signal. Success emits exact transcript. Normalize `HttpRequestError` statuses `413/429/503/504`, generic network rejection including upload-timeout socket closure, malformed response, and an injected secret-bearing gateway message into stable provider errors without forwarding `error.message`; user/watchdog Cancel aborts the signal and suppresses late completion/error. Repeated Stop/Cancel is idempotent. Hold recorder finalization indefinitely and prove controller-owned cancellation unsubscribes handlers, stops tracks, clears retained audio/object references, aborts upload, and suppresses all later recorder events.

- [ ] **Step 3: Run the test and confirm RED**

Run:

```bash
npm test -- --run src/client/src/speechInput/mediaRecorderAdapter.test.ts
```

Expected: FAIL because the adapter is missing.

- [ ] **Step 4: Implement bounded capture cleanup**

Return a run handle immediately so pending permission can be canceled. Keep one terminal flag, one `stopRequested` flag, and one idempotent `finish` cleanup. `finish` marks terminal first, invokes every stored listener unsubscribe once, aborts upload when requested, best-effort stops recorder/tracks, empties chunks, and sets Blob/stream/recorder/controller references to undefined before any terminal callback. In the `getUserMedia()` continuation, if terminal is already true, stop every track on the newly resolved local stream immediately and return without assigning it or constructing a recorder; otherwise assign it and proceed. Catch permission rejection and construction/start/stop throws without reviving a terminal run, and settle one normalized error when still active. Parse `recorder.mimeType`; if unsupported, finish without starting. Retain chunks only after checking prospective total. If it crosses the bound, discard all chunks and finish with `recording-limit` without Blob. If it reaches exactly, enter Stop once. Normal Stop emits `onTranscribing` before `recorder.stop()`. On recorder `stop`, reject empty/over-limit captures before Blob; otherwise transcribe with the run AbortController. Success/error also finish and clear retained audio before invoking the provider callback.

Do not own the ten-minute timer here; Task 8's controller applies one provider-neutral capture deadline after `onListening`.

- [ ] **Step 5: Run focused and static checks**

Run:

```bash
npm test -- --run src/client/src/speechInput/mediaRecorderAdapter.test.ts
npm run typecheck
npx eslint src/client/src/speechInput/mediaRecorderAdapter.ts src/client/src/speechInput/mediaRecorderAdapter.test.ts
npx knip
```

Expected: all pass; no live browser/microphone is required.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/speechInput/mediaRecorderAdapter.ts src/client/src/speechInput/mediaRecorderAdapter.test.ts
git commit -m "feat(speech-input): add bounded cloud recorder"
```

## Task 8: Provider-neutral speech input controller

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/controllers/speechInputController.ts`
- Test: `src/client/src/controllers/speechInputController.test.ts`

**Interfaces:**

- Consumes: Browser/Cloud adapters from Tasks 6-7, provider selection/target from Task 5, and `SpeechInputSettingsResponse`.
- Produces:

```ts
export type SpeechInputControllerState =
  | { kind: "idle"; provider?: SpeechInputProviderId; unavailableReason?: string; error?: string }
  | { kind: "requesting-permission"; runId: string; provider: SpeechInputProviderId }
  | { kind: "listening"; runId: string; provider: SpeechInputProviderId; elapsedMs: number; interimText?: string }
  | { kind: "transcribing"; runId: string; provider: "cloud"; elapsedMs: number };

export interface SpeechInputControllerCallbacks {
  onStateChange(state: SpeechInputControllerState): void;
  onInterim(target: SpeechInputTargetSnapshot, text: string): void;
  onFinal(target: SpeechInputTargetSnapshot, text: string): "inserted" | "empty" | "changed" | "too-large";
  onClearInterim(): void;
}

export interface SpeechInputControllerOptions {
  browser: SpeechInputProviderAdapter;
  cloud: SpeechInputProviderAdapter;
  callbacks: SpeechInputControllerCallbacks;
  createRunId?: () => string;
  now?: () => number;
  scheduleInterval?: (callback: () => void, delayMs: number) => () => void;
  scheduleDeadline?: (callback: () => void, delayMs: number) => () => void;
}

export class SpeechInputController {
  constructor(options: SpeechInputControllerOptions);
  get state(): SpeechInputControllerState;
  configure(settings: SpeechInputSettingsResponse | undefined): void;
  start(target: SpeechInputTargetSnapshot): void;
  stop(): void;
  cancel(): boolean;
  dispose(): void;
}

export function createDefaultSpeechInputController(callbacks: SpeechInputControllerCallbacks): SpeechInputController;
```

- `configure` previews the fixed explicit/Auto provider using current adapter availability. Missing settings leave idle unavailable with stable `Speech settings are still loading.` copy; it never executes a command or starts capture. Arrival of the first snapshot recomputes availability without remounting. During an active run it stores the next snapshot without changing the selected provider, provider input, timers, or visible active state; terminal cleanup then recomputes idle preview from the latest snapshot.
- `start` resolves once, creates one generation/run ID, enters requesting permission, and never falls back after provider selection. Browser receives the captured language; Cloud uploads only audio/MIME and the gateway applies its current authoritative language/model/base URL at transcription time, so the controller must not send browser-snapshot overrides.
- Capture deadline starts only at `onListening`; elapsed time uses injected monotonic `now`. Browser deadline Stop finalizes. Cloud adapter Stop emits `onTranscribing` synchronously before awaiting recorder finalization; at that callback the controller clears the capture deadline and starts one 130,000 ms client deadline. Expiry first invalidates/settles the active generation to an idle timeout error, then calls adapter Cancel to abort recorder/gateway work. It must not wait for a provider callback. Any earlier Cloud terminal path clears this second deadline.
- Every callback checks generation/current run. Cancel clears interim, cancels adapter/timers, returns idle without error, and returns `false` only when already idle.

- [ ] **Step 1: Write failing transition tests with fake adapters**

Use adapters whose availability, `start` behavior, and callbacks are controlled explicitly. Cover configure preview; Auto/explicit start; a second `start` while active is ignored; no fallback after failure; requesting, listening, interim, natural completion, Stop, transcribing, success, no-speech/error, retry, and exact user-facing normalized errors. Force adapter `start()` to synchronously emit Listening, Complete, and Error in separate cases, and to throw; prove no stale handle is installed and cleanup/error publication occurs once. Pin primary-action semantics: a second tap during `requesting-permission` calls Cancel; during `listening` it calls Stop; during `transcribing` it calls Cancel. Repeated taps after terminal settlement are no-ops.

Prove the ten-minute timer is not scheduled before `onListening`, then at exactly 600,000 ms calls provider Stop once. Advance the fake monotonic clock to assert elapsed snapshots. Confirm Cloud may remain transcribing after capture Stop while Browser settles at end. On Cloud Transcribing, assert a fresh single 130,000 ms client watchdog exists, cancels the adapter/fetch and publishes timeout synchronously on expiry even when the adapter never emits a terminal callback; a later callback is ignored. Assert the watchdog is cleared on success/error/user cancel without timeout reset. Reconfigure while each provider is active and assert the current provider/language/state do not change; after completion, idle preview reflects the new snapshot.

- [ ] **Step 2: Write stale/cancel/dispose tests**

Prove Cancel during permission/listening/transcribing calls provider Cancel, clears timers/interim, and ignores late events. Start a second generation and fire callbacks from the first; assert no state or final callback changes. Prove dispose is idempotent and later configure/start/callbacks do nothing.

Test `onFinal` outcomes: inserted returns clean idle; empty/changed/too-large become exact recoverable idle errors without fallback or auto-retry.

- [ ] **Step 3: Run the test and confirm RED**

Run:

```bash
npm test -- --run src/client/src/controllers/speechInputController.test.ts
```

Expected: FAIL because the controller is missing.

- [ ] **Step 4: Implement serialized generation ownership**

Keep only one active record containing generation, target, adapter run (initially absent), provider, capture start, deadline canceler, and interval canceler. Install that record before calling adapter `start`; provider callbacks close over the generation. After `start` returns, attach the handle only if the generation is still current, otherwise best-effort Cancel the returned stale handle. Normalize a thrown `start`, `stop`, or `cancel` without letting it escape UI/timer handlers. Use one terminal cleanup method that invalidates generation before adapter cleanup, clears timers/interim before publishing idle, and never calls adapter Cancel after normal completion.

`createDefaultSpeechInputController` constructs `SpeechRecognitionAdapter` and `MediaRecorderAdapter`; it is the only production assembly function.

- [ ] **Step 5: Run focused and static checks**

Run:

```bash
npm test -- --run src/client/src/controllers/speechInputController.test.ts src/client/src/speechInput/speechRecognitionAdapter.test.ts src/client/src/speechInput/mediaRecorderAdapter.test.ts
npm run typecheck
npx eslint src/client/src/controllers/speechInputController.ts src/client/src/controllers/speechInputController.test.ts
npx knip
```

Expected: all lifecycle tests pass with no real timers/media/network.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/controllers/speechInputController.ts src/client/src/controllers/speechInputController.test.ts
git commit -m "feat(speech-input): orchestrate dictation providers"
```

## Task 9: PromptEditor dictation boundary and composer controls

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/components/promptSpeechDecoration.ts`
- Test: `src/client/src/components/promptSpeechDecoration.test.ts`
- Modify: `src/client/src/components/promptEditorIcons.ts:1-85`
- Modify: `src/client/src/components/PromptEditor.ts:1-220,413-475,637-748`
- Create: `src/client/src/components/PromptEditor.speechInput.test.ts`
- Modify: `src/client/src/components/shared.ts:918-990`
- Test: `src/client/src/components/shared.test.ts:1-70`
- Modify: `src/client/src/components/PiWebUiApp.ts:118-125,195-205,521-527`
- Create: `src/client/src/components/PiWebUiApp.speechInput.test.ts`

**Interfaces:**

- Consumes: controller/state/target from Task 8, insertion helper from Task 5, and existing CodeMirror disabled/update/draft paths.
- Produces `PromptEditor.cancelSpeechInput(): boolean` for app-shell `Escape` delegation.
- Adds property `.speechInputSettings?: SpeechInputSettingsResponse` and one private controller created through `createDefaultSpeechInputController` (tests may replace it through `Reflect.set`, matching existing component tests; no test-only production property).
- `promptSpeechDecoration.ts` produces a CodeMirror `StateEffect`/`StateField` extension and effects to show/clear a non-document interim widget. Nonempty selection uses `Decoration.replace({ widget })`; empty selection uses `Decoration.widget`; neither dispatch changes nor reaches `updateDraft`.
- Dictation read-only is composed as `this.disabled || speechInputState.kind !== "idle"` inside existing editable/read-only compartments; the external `disabled` property is never mutated.
- Final insertion verifies current identity and exact document text, calls `buildSpeechTranscriptInsertion`, and dispatches one CodeMirror changes/selection transaction so the existing `updateListener` persists the draft.

- [ ] **Step 1: Write failing decoration and editor-boundary tests**

In a jsdom CodeMirror test, install the decoration extension, show interim text at an empty caret and a selected range, and assert `state.doc.toString()` never changes. Clear it and assert no decoration remains.

In `PromptEditor.speechInput.test.ts`, mount a real `PromptEditor` or use its existing lifecycle seams to assert:

- target captures a structured discriminated identity: starter requires nonempty machine/project/workspace and no session ID; session requires all four nonempty values; exact field equality, not serialized-string comparison, decides staleness;
- selected text is replaced; caret insertion spacing/punctuation matches Task 5; cursor lands after insertion; draft storage updates only after final dispatch;
- interim events never update draft storage;
- changed document/identity rejects a late final;
- machine/project/workspace/session changes call Cancel before adopting the new draft;
- `disconnectedCallback` cancels/disposes and clears interim;
- active state locks editor and every interactive composer-mutating path, including keyboard Enter/Tab/completion insertion, programmatic `send()`, new attachment paste/drop/input/remove/delivery actions, Compact/Send/Steer, and starter/session model/thinking selectors, but not agent-work Stop; an attachment read explicitly started before dictation may finish into its already captured scope;
- completion/cancel restores editing while preserving an externally archived/disabled editor.

- [ ] **Step 2: Write failing composer rendering and Escape tests**

Render idle/requesting/listening/transcribing/error states. Assert microphone immediately precedes Send, exact labels/tooltips, provider/status copy, elapsed `mm:ss`, `aria-live` error, explicit disabled reason, and state-specific action behavior: pending permission and Transcribing cancel, Listening stops/finalizes. Assert status/error strings do not alter icon dimensions in CSS.

In `PiWebUiApp.speechInput.test.ts`, replace `promptEditor` with a fake `cancelSpeechInput`. Invoke the existing `onKeyDown` via `Reflect.apply` and assert active `Escape` delegates, prevents default, stops propagation, and never calls the shortcut dispatcher even when Settings/action palette/modal flags would otherwise trigger the early return; idle `Escape` follows the original early-return/shortcut path unchanged; non-Escape never delegates.

- [ ] **Step 3: Run tests and confirm RED**

Run:

```bash
npm test -- --run src/client/src/components/promptSpeechDecoration.test.ts src/client/src/components/PromptEditor.speechInput.test.ts src/client/src/components/PiWebUiApp.speechInput.test.ts src/client/src/components/shared.test.ts
```

Expected: FAIL because the decoration, property, controls, and delegation do not exist.

- [ ] **Step 4: Implement the editor seam and lifecycle**

Add the decoration extension during `createEditor`. Configure controller callbacks to publish Lit state, apply/clear interim effects, and verify/insert final text. Build the discriminated `SpeechInputComposerIdentity` from nonempty properties; when required identity or editor selection is unavailable, Start returns a stable unavailable error before invoking the controller.

Add one `speechInputActive()` predicate and enforce it at handlers as well as render attributes. While active, Enter is consumed without sending or inserting a newline; Tab/completion pick cannot dispatch; `send()` returns; compact/model/thinking callbacks do not fire; and new attachment paste/drop/input/remove/delivery actions are ignored. An attachment read already started before dictation retains the existing captured-scope behavior and may finish normally. Starting dictation increments `requestVersion`, clears completions/selection, and invalidates delayed completion requests before target capture; it does not mutate the document.

In `willUpdate`, detect all four identity properties and cancel before any outgoing draft work. After cancellation, return immediately for a project/workspace-only change; run the existing text/attachment draft save/adopt migration only when `sessionId` or `machineId` changed. In `updated`, reconfigure effective read-only state for either external disabled or controller activity and call `configure` when settings change.

`cancelSpeechInput()` delegates to the controller and returns its boolean. In `PiWebUiApp.onKeyDown`, place active `Escape` delegation before both the existing modal/palette early return and `keyboard.handle`; when it returns false, preserve the original early-return/shortcut behavior exactly. Thus an active run consumes the first Escape even behind a modal, while the next idle Escape reaches the modal/completion owner.

- [ ] **Step 5: Implement approved controls and responsive styling**

Add microphone and waveform/processing glyphs to `promptEditorIcons.ts` using the existing 24x24 stroke convention; reuse the existing filled Stop icon for listening Stop where appropriate.

Render the mic before Send. Use existing `.icon-button` dimensions, add state colors without decorative animation, reserve a min-width-zero status region, wrap error below the action/editor region, and include a `prefers-reduced-motion` rule if any processing transition is introduced. Add/remove `aria-readonly="true"` with the effective dictation lock while retaining external `aria-disabled` semantics for archived/disabled editors; tests assert the attribute transition on start/cancel/complete. At `max-width: 430px`, inherit the existing 34 px dimensions exactly.

- [ ] **Step 6: Run focused and static checks**

Run:

```bash
npm test -- --run src/client/src/components/promptSpeechDecoration.test.ts src/client/src/components/PromptEditor.speechInput.test.ts src/client/src/components/PromptEditor.draft.test.ts src/client/src/components/PromptEditor.attachmentScope.test.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts src/client/src/components/PiWebUiApp.speechInput.test.ts src/client/src/components/shared.test.ts
npm run typecheck
npx eslint src/client/src/components/promptSpeechDecoration.ts src/client/src/components/promptSpeechDecoration.test.ts src/client/src/components/promptEditorIcons.ts src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.speechInput.test.ts src/client/src/components/shared.ts src/client/src/components/shared.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.speechInput.test.ts
npx knip
```

Expected: all pass; existing draft/attachment/composer controls retain behavior.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/promptSpeechDecoration.ts src/client/src/components/promptSpeechDecoration.test.ts src/client/src/components/promptEditorIcons.ts src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.speechInput.test.ts src/client/src/components/shared.ts src/client/src/components/shared.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.speechInput.test.ts
git commit -m "feat(speech-input): add prompt dictation controls"
```

## Task 10: App-shell settings ownership and General Settings card

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/settings/settingsDataLoading.ts:1-38`
- Test: `src/client/src/components/settings/settingsDataLoading.test.ts:1-65`
- Modify: `src/client/src/components/settings/settingsConfigDraft.ts:1-115,134-146`
- Test: `src/client/src/components/settings/settingsConfigDraft.test.ts:1-130`
- Modify: `src/client/src/components/settings/SettingsGeneralPanel.ts:1-365`
- Test: `src/client/src/components/settings/SettingsGeneralPanel.test.ts:1-410`
- Modify: `src/client/src/components/SettingsDialog.ts:1-85,160-294,294-520`
- Test: `src/client/src/components/SettingsDialog.general.test.ts:1-280`
- Modify: `src/client/src/components/SettingsDialog.testSupport.ts`
- Create: `src/client/src/appShell/speechInputSettingsChannel.ts`
- Create: `src/client/src/appShell/speechInputSettingsChannel.test.ts`
- Modify: `src/client/src/components/PiWebUiApp.ts:190-240,353-360,660-860,2730-2745,4630-4650,4700-4715`
- Modify: `src/client/src/components/PiWebUiApp.speechInput.test.ts`

**Interfaces:**

- Consumes: strict `speechInputApi`, `SpeechInputSettingsResponse/Update`, and PromptEditor property from Tasks 3 and 9.
- Produces app-shell-owned latest redacted snapshot loaded at startup, refreshed through `refreshAfterBrowserResume`, adopted after any successful Settings-dialog gateway reload, passed identically to starter/active composers, and replaced after a Settings save. One app-owned request sequence orders all async sources. A structural `SpeechInputSettingsChannel` uses a `BroadcastChannel` name derived from `resolveAppUrl("")`; messages contain exactly `{ contractVersion: 1, revision }`. Successful local save/clear publishes its new revision. A different revision from another tab triggers a refetch; bursts before work starts coalesce, while any different revision received during an in-flight refetch records a trailing-edge invalidation and causes exactly one follow-up refetch after settlement. Same/invalid messages do nothing. Failed refresh retains the last successful snapshot but still services a pending trailing invalidation; disconnect closes the channel.
- Extends `loadGatewaySettingsData` with `loadSpeechInputSettings` and optional `speechInputSettings` result so Settings General reload fetches config/plugins/speech independently and reports labeled aggregate errors.
- Produces draft helpers:

```ts
export interface SpeechInputSettingsDraft {
  provider: "auto" | "browser" | "cloud";
  /** Empty string is the UI-only Auto sentinel and is omitted on the wire. */
  language: string;
  baseUrl: string;
  model: string;
}

export function speechInputDraftFromResponse(response: SpeechInputSettingsResponse): SpeechInputSettingsDraft;
export function speechInputUpdateFromDraft(
  draft: SpeechInputSettingsDraft,
  expectedRevision: string,
  credential: SpeechInputCredentialMutation,
): SpeechInputSettingsUpdate;
```

- The credential is deliberately absent from `SpeechInputSettingsDraft` and every reactive Lit field. `SettingsGeneralPanel` owns `@query(".speech-input-api-key") private speechInputApiKeyInput?: HTMLInputElement`; input events track only a boolean `credentialEntryDirty`, and submit reads `input.value` once into a method-local update. Ordinary failure/conflict leaves the DOM value for correction. Response adoption clears it only for explicit Reload, successful full Save, or successful credential Clear. The source exists only in the password element and in-flight request.
- `SettingsGeneralPanel` separately tracks boolean nonsecret-draft dirty, credential-entry dirty, and stale flags, never credential text. A new app/dialog response auto-adopts only when neither dirty flag is set. While either is dirty, a different revision preserves draft/password, marks stale, and disables Save/Clear. Explicit Reload force-adopts current response and clears all flags/password. Full Save success force-adopts and clears all. Clear success updates the saved response/revision and credential status, clears password/credential-dirty/stale, but preserves a dirty nonsecret draft rather than discarding it.
- Blank submit uses preserve; nonblank submit uses replace; clear is a separate confirmed action.
- The Speech input card is gateway-owned and shown regardless of selected coding machine; host TTS remains local-selection-only.

- [ ] **Step 1: Write failing loading/draft tests**

Extend `settingsDataLoading.test.ts` to prove three parallel loads, partial successes retained, and errors labeled `config`, `PI WEBUI plugins`, and `speech input`.

Extend draft tests for Auto/default fields with exact `language: ""`, explicit language/cloud fields, no credential field in the returned draft, blank preserve, nonblank exact replace when supplied as the separate mutation, `speechInputUpdateFromDraft` requiring the caller's current response revision as `expectedRevision` and omitting language only for the empty UI sentinel, canonical language handling delegated to server, and preserving unrelated gateway config in existing gateway/host-speech form helpers.

- [ ] **Step 2: Write failing Settings card tests**

Using the existing TemplateResult inspection support, assert the General panel renders Provider options Auto/Browser/Cloud, Language Auto placeholder, cloud URL/model, password API source, redacted status copy for every source/resolution state, Clear credential, and Save action. Assert concise privacy/security copy states that Browser recognition may use the browser vendor's speech service, Cloud sends audio to the configured endpoint through the gateway, and gateway access is administrative because PI WEBUI adds no authentication.

Assert:

- no component property/reactive state contains the API source; response adoption clears the queried password DOM input;
- save reads the current password DOM value exactly once and sends the currently adopted response revision: blank emits preserve, nonblank emits replace, and success force-adopts the response and clears password/all dirty flags;
- a `409` conflict leaves password and dirty flags/draft intact, marks the card stale with `Speech input settings changed in another tab. Reload before saving.`, disables Save/Clear, and never renders credential source;
- a `400` with exact preserved-credential endpoint message leaves all draft/password state intact and renders `Re-enter the API key source when changing the cloud base URL, or clear the saved credential first.`; other failures also retain state and use existing generic handling;
- Clear asks `confirm` and, on acceptance, sends current response revision plus `{ settings: currentSavedResponse.settings, credential: { action: "clear" } }`; success updates saved baseline/revision/status and clears only password/credential-dirty/stale while preserving unsaved nonsecret draft edits; server CAS and credential-only semantics prevent those edits from committing; conflict preserves everything and requires Reload; cancellation sends nothing;
- Cloud fields remain enabled in Auto;
- card remains present for a remote selected coding machine;
- no card is nested inside another card and long fields/status wrap without negative letter spacing or viewport-scaled font.

- [ ] **Step 3: Write failing SettingsDialog and app-shell tests**

Assert SettingsDialog/General panel detects conflict by `HttpRequestError.status === 409`, and detects the endpoint-binding validation case by status plus the exact safe server message rather than substring matching; all other failures retain existing handling. Add `.speechInputSettings` app-owned input plus load/save callbacks. Accepted dialog loads/saves notify app owner; request-sequence guards ignore stale loads. A clean panel adopts newer app response; a panel with either dirty boolean sees a different revision, keeps draft/password, and marks stale. Explicit Reload force-adopts. Full Save force-adopts. Credential Clear updates saved baseline/revision/status while retaining nonsecret dirty draft.

In `speechInputSettingsChannel.test.ts`, use a structural fake BroadcastChannel with no DOM casts. Assert channel names differ for root versus nested app bases; messages contain only contractVersion/revision; same/self/invalid revisions are ignored; duplicate bursts before callback dispatch coalesce without discarding the newest different revision; close detaches listeners and closes exactly once; unavailable BroadcastChannel degrades to no cross-tab notification without breaking Settings.

In app tests inject deferred `speechInputApi.settings` calls and the channel. Prove startup load, direct-load stale-sequence suppression, browser-resume refresh, successful dialog-load/save replacement invalidating an older pending GET, and save/clear publishing only the new revision. For channel scheduling, prove a burst before dispatch causes one GET; a second different revision arriving while that GET is pending causes exactly one trailing GET after success; multiple in-flight notifications still coalesce to that one trailing GET using the newest observed revision; failure retains the last good snapshot and still runs a pending trailing GET; same-current revision is a no-op. Also prove the exact same response object is passed to both starter and active `prompt-editor` templates alongside existing identity inputs. Assert switching selected remote machines does not hide or retarget gateway speech settings and disconnect closes the channel/suppresses pending work.

- [ ] **Step 4: Run tests and confirm RED**

Run:

```bash
npm test -- --run src/client/src/appShell/speechInputSettingsChannel.test.ts src/client/src/components/settings/settingsDataLoading.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/PiWebUiApp.speechInput.test.ts
```

Expected: FAIL because speech settings loading, drafts, card, and app snapshot are absent.

- [ ] **Step 5: Implement settings and app ownership**

Add an app-owned speech-settings request sequence plus channel invalidation scheduler. Every direct GET captures a sequence; accepted dialog load/save adoption increments it so older pending GETs cannot overwrite newer data. Call GET at startup and browser resume. For a different-revision channel message, record the newest pending invalidation before starting/referring to the current channel GET. Coalesce messages that arrive before dispatch; if any different revision arrives while a channel GET is pending, retain a trailing-dirty marker and start exactly one follow-up GET in `finally`, after either success or failure, unless disconnected. Clear that marker only when the corresponding trailing request starts; do not compare only with the pre-request snapshot or drop messages merely because a promise exists. Failed GET retains the last good snapshot. Pass the snapshot into both PromptEditor branches and SettingsDialog. Successful save/clear adoption increments request ownership, clears obsolete pending invalidations covered by the adopted revision, updates local state first, then publishes only `{ contractVersion: 1, revision }`. Stale SettingsDialog loads must not emit adoption callbacks; close the channel and invalidate scheduled/in-flight callbacks in app disconnect.

`SettingsDialog` receives the app-owned snapshot but does not blindly copy it into an open form. It passes response plus an adoption generation to `SettingsGeneralPanel`; normal external generations auto-adopt only when both dirty booleans are false. General Reload increments a force-adopt generation after accepted gateway load. Full Save likewise force-adopts. Credential Clear uses a credential-only adoption mode that updates saved baseline/revision/status and clears password/credential-dirty/stale without overwriting a dirty nonsecret draft. Conflict or external revision while dirty marks stale and retains draft/password. Keep this logic scoped to Speech input so existing Gateway/TTS/machine draft adoption remains unchanged.

Implement pure draft mapping with `language: ""` for absent response language; `speechInputUpdateFromDraft` takes the current canonical revision, sets `expectedRevision`, omits wire language only for that empty sentinel, and never uses literal `"auto"`. Keep credential entry only in the uncontrolled password DOM input; never copy it into a Lit property, draft object, app state, channel message, browser storage, or URL.

Add the card as a full-width sibling of Gateway server/Text to speech/Selected machine cards. Include concise provider-boundary copy: Browser recognition may be processed by the browser vendor; Cloud audio and the resolved credential go only to the configured HTTPS endpoint with redirects disabled; gateway clients are trusted administrators because PI WEBUI has no authentication. Keep all fields within existing responsive form constraints and preserve host-speech behavior.

- [ ] **Step 6: Run focused and static checks**

Run:

```bash
npm test -- --run src/client/src/appShell/speechInputSettingsChannel.test.ts src/client/src/components/settings/settingsDataLoading.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/PiWebUiApp.speechInput.test.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts
npm run typecheck
npx eslint src/client/src/appShell/speechInputSettingsChannel.ts src/client/src/appShell/speechInputSettingsChannel.test.ts src/client/src/components/settings/settingsDataLoading.ts src/client/src/components/settings/settingsDataLoading.test.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/SettingsDialog.testSupport.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.speechInput.test.ts
npx knip
```

Expected: all pass; TTS settings and machine targeting regressions remain green.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/appShell/speechInputSettingsChannel.ts src/client/src/appShell/speechInputSettingsChannel.test.ts src/client/src/components/settings/settingsDataLoading.ts src/client/src/components/settings/settingsDataLoading.test.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/SettingsDialog.testSupport.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.speechInput.test.ts
git commit -m "feat(speech-input): add gateway dictation settings"
```

## Task 11: Documentation, release note, Chromium geometry, and final verification

**Implementer tier:** Advanced

**Files:**

- Modify: `docs/config.md:1-335`
- Modify: `docs/config.html:1-820`
- Modify: `docs/faq.html`
- Create: `.changeset/spoken-prompt-input.md`

**Interfaces:**

- Consumes: complete behavior from Tasks 1-10 and every privacy/security/operational disclosure in the design spec.
- Produces synchronized configuration and troubleshooting guidance plus this exact Changeset:

```md
---
"@hyperdreamer/pi-webui": minor
---

Add browser and OpenAI-compatible cloud dictation to prompt composers, with gateway-scoped provider and language settings and redacted Pi-compatible credential sources.
```

- `docs/config.md` gains `speechInput` in the gateway example and Configuration matrix immediately beside `tts`. Scope is Global, project-local is unsupported, saved speech settings apply to the next run, and installing the shared persistence prerequisite requires one session-daemon restart. It documents the private non-user-editable `$PI_WEBUI_DATA_DIR/config-mutations/<config-path-hash>.sqlite` coordination database, that it contains no config/credential/audio/transcript data, the stop-services-before-manual-edit rule, and the ten-second config-busy failure.
- `docs/config.html` mirrors nav, example, matrix, details, and warnings. `docs/faq.html` owns troubleshooting rather than duplicating the complete config reference.
- README and CHANGELOG remain unchanged.

- [ ] **Step 1: Write synchronized user documentation and Changeset**

Document:

- Browser versus Cloud processing and privacy boundaries;
- Auto ordering and no fallback after capture begins, including that Browser uses the start-time language snapshot while Cloud uses gateway-authoritative settings at transcription time;
- secure-context rule: loopback HTTP exemption and HTTPS requirement for non-loopback deployments;
- Provider, Language, base URL, model, and API source GUI behavior;
- literal, `$ENV_VAR`, `${ENV_VAR}`, interpolation, `!command`, `$$`, and `$!` examples, including that plain `OPENAI_API_KEY` is literal and command sources must be trusted, short-lived, and non-daemonizing because detached descendants are outside portable cleanup;
- the client-owned 130-second Transcribing watchdog that bounds a lost gateway connection;
- command execution as gateway account, no read-time command execution, hard credential-resolution settlement, best-effort tracked-process cleanup, and write-only redaction;
- exact MIME, ten-minute capture, Browser's two-second stop-settlement watchdog, 20 MiB, two-concurrent-request, 130-second stalled-upload, ten-second command, 120-second provider, and Cloud's 130-second client Transcribing bounds;
- opaque revision/CAS conflicts, trailing-edge cross-tab refetch, dirty form/password preservation, explicit Reload recovery, and the requirement to re-enter a configured credential source when changing its cloud base URL;
- shared-config cross-process SQLite mutation coordination under `$PI_WEBUI_DATA_DIR/config-mutations`, private managed-state contents/mode, the fact that audio/transcription never use SQLite, target-gateway atomic selected-machine patching, config-busy troubleshooting, and stopping both services before manual config edits;
- native-service environment parity: a nonempty install-time `PI_WEBUI_DATA_DIR` is resolved into both generated process-owner services, and users changing that setting rerun `pi-webui install` before restarting;
- permission denial, unsupported browser/codec, unresolved credential, no speech, timeout, and provider rejection troubleshooting;
- no-auth administrative settings/spending/credential-destination/command-trigger risk and trusted-network/authenticated-proxy requirement;
- one required manual session-daemon restart because sessiond's existing config writes adopt the shared coordinator; speech/audio/provider ownership remains in web/API/client.

- [ ] **Step 2: Run the complete focused contract suite**

Run:

```bash
npm test -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/shared/speechInput.test.ts src/shared/speechInputAudio.test.ts src/server/configRoutes.test.ts src/server/app.machines.test.ts src/server/sessiond/configMutationWriters.test.ts src/server/speechInput/piCompatibleCredentialResolver.test.ts src/server/speechInput/speechInputSettingsService.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts src/server/speechInput/openAiCompatibleTranscriptionProvider.test.ts src/server/speechInput/speechTranscriptionService.test.ts src/server/speechInput/speechInputTranscriptionRoutes.test.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/speechInput/speechInputCore.test.ts src/client/src/speechInput/speechRecognitionAdapter.test.ts src/client/src/speechInput/mediaRecorderAdapter.test.ts src/client/src/controllers/speechInputController.test.ts src/client/src/components/promptSpeechDecoration.test.ts src/client/src/components/PromptEditor.speechInput.test.ts src/client/src/components/PiWebUiApp.speechInput.test.ts src/client/src/appShell/speechInputSettingsChannel.test.ts src/client/src/components/settings/settingsDataLoading.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts
```

Expected: all focused files pass with no failures.

- [ ] **Step 3: Run security, ownership, URL, and packaging scans**

Run:

```bash
if rg -n 'speechInput|speech-input|transcrib|MediaRecorder|SpeechRecognition|piCompatibleCredentialResolver' src/server/sessiond.ts src/server/sessiond/configMutationWriters.ts src/sessiond --glob '!*.test.ts'; then
  echo "Unexpected sessiond speech/audio/provider/credential ownership" >&2
  exit 1
fi
if rg -n 'speechInput|speech-input' src/shared/federatedRoutes.ts src/server/machines --glob '!*.test.ts'; then
  echo "Unexpected federated/machine speech-input production reference" >&2
  exit 1
fi
if rg -n 'api/machines/.*/speech-input|machines/local/speech-input|FEDERATED_.*speech-input' src --glob '!*.test.ts'; then
  echo "Unexpected remote speech-input production route" >&2
  exit 1
fi
if rg -n 'replacePiWebUiModelTiers|replacePiWebUiUtilityModels' src/server/sessiond.ts; then
  echo "Sessiond bypasses the shared config mutation coordinator" >&2
  exit 1
fi
if rg -n 'savePiWebUiConfig\(' src/server src/sessiond --glob '!*.test.ts' | rg -v 'src/configMutationCoordinator\.ts'; then
  echo "Production config writer bypasses the shared coordinator" >&2
  exit 1
fi
if git diff "$(git merge-base HEAD origin/main)"...HEAD -U0 -- src/client/src | rg '^\+.*fetch\('; then
  echo "Unexpected raw browser fetch added" >&2
  exit 1
fi
rg -n 'speechInput.*apiKey|apiKey.*speechInput' src/client/src
rg -n 'BroadcastChannel|expectedRevision|revision' src/client/src/appShell/speechInputSettingsChannel.ts src/client/src/components/settings | rg -v 'apiKey|credential'
rg -n 'config-mutations|DatabaseSync|BEGIN IMMEDIATE|speechInputRevision' src/configMutationCoordinator.ts src/server/sessiond/configMutationWriters.ts
rg -n 'writeFile|createWriteStream|localStorage|sessionStorage|indexedDB' src/client/src/speechInput src/server/speechInput
git diff --check
npm run pack:dry
```

Expected: guarded scans exit cleanly; sessiond references only shared config-mutation wiring and no speech/audio/provider code; coordinator managed-state code stores only revision/fingerprint state in a private data directory and no config/credential/audio/transcript bytes; credential-source matches are limited to shared types/tests with no browser response/state/channel projection; channel messages contain only revision; no audio persistence appears; package dry run succeeds and includes published `docs/config.md`.

- [ ] **Step 4: Run Chromium desktop and narrow geometry probes**

Follow the project `probe-narrow-lit-layout-with-chromium-cdp` procedure. Create temporary files only under `src/client` and `/tmp`, import the real PromptEditor and Settings components, inject fake SpeechRecognition/MediaRecorder/transcription boundaries, and exercise idle, Browser listening/interim, Cloud transcribing, error, and Settings states.

Use CDP `Emulation.setDeviceMetricsOverride` at 1280x800 and 390x844. Record/assert:

- `window.innerWidth` equals the requested width;
- document/composer action row `scrollWidth <= clientWidth`;
- microphone rectangle is exactly 36x36 at 1280 and 34x34 at 390, matching Send;
- microphone is immediately left of Send and neither overlaps status, Send, Steer, nor Stop;
- long provider/error/status text truncates or wraps without moving icon rectangles;
- editor/interim/error and Settings fields do not overlap or exceed their containers;
- touch Cancel remains rendered in Cloud transcribing state.

Stop temporary Chromium/Vite processes and remove fixtures, profiles, scripts, and logs. Confirm their port is no longer listening and `git status --short` has no temporary artifact.

- [ ] **Step 5: Run broad verification serially on an idle machine**

Run, with no subsession or concurrent full suite:

```bash
npm run verify:fast
npm run verify
```

Expected: typecheck, ESLint, Knip, fast Vitest, and serial Vitest all pass. Existing informational Knip configuration hints may print but do not change exit status.

- [ ] **Step 6: Perform optional real-browser smoke without live cloud dependency**

On a secure-context compatible browser, verify real microphone permission and Browser recognition if the host/browser service supports it. For Cloud, use a local injected/test OpenAI-compatible endpoint only if it can be configured without weakening the HTTPS rule; otherwise record Cloud manual smoke as not performed and rely on deterministic provider/route tests. Never use a personal production API key merely to satisfy this step.

Confirm dictation inserts editable text, never sends, Stop finalizes, Escape cancels, and session/workspace navigation discards pending output. If browser recognition is unavailable, record that fact rather than claiming a successful real-vendor check.

- [ ] **Step 7: Review final scope and service ownership**

Run:

```bash
git status --short
git diff --stat "$(git merge-base HEAD origin/main)"...HEAD
git diff --name-only "$(git merge-base HEAD origin/main)"...HEAD
```

Confirm no README, CHANGELOG, federation, remote-machine speech route, workspace-audio, or persisted-recording change exists. Confirm the only sessiond-loaded changes are shared config-mutation writer/coordinator use, not speech/audio/provider ownership. State in handoff that a manual `systemctl --user restart pi-webui-sessiond.service` is required when disruption is acceptable; do not run it. Web/API/UI also needs its normal reload/restart.

- [ ] **Step 8: Commit**

```bash
git add docs/config.md docs/config.html docs/faq.html .changeset/spoken-prompt-input.md
git commit -m "docs(speech-input): document prompt dictation"
```
