# Technical Specification: Session Daemon Listener Configuration

- **Date:** 2026-10-05
- **Status:** Approved for implementation; complete, with no section remaining gated on a design issue (G1 resolved; see §4.2, §8.6, and §12)
- **Related design document:** `docs/superpowers/specs/2026-10-05-sessiond-listener-config-design.md` (sha256 `5a7814fd1380aac08cb0060fc33e66b11a6a1ac8eb03e082c44eff2a6e2732d9`, committed at `52ebd771379b8e1ab65b1a49a2c83b1eda873e6a`)
- **Target package:** `@hyperdreamer/pi-webui`
- **Change class:** user-visible minor (new configuration surface `sessiond.*`; one fail-closed behavior change for empty hosts)
- **Operation class:** session-daemon-affecting **and** web/API-affecting. `src/server/sessiond.ts` changes a daemon-only startup path; `src/config.ts` and `src/sessiond/config.ts` are loaded by both processes. Per `AGENTS.md`, deployment requires a **manual `pi-webui-sessiond.service` restart** and a web/API restart before either process observes the new keys. See §9.7.
- **Delivery target and verified code revision:** `refs/heads/main` at `b40ecd9ffcfa2d4444685627baaa09932e729dbf` ("feat(deps): upgrade Pi core and coding agent to 1.0.4"), which is the current `main` and the delivery target for implementation. The design document pinned its delivery target at `89a06f86568645908d730f17767f191f626cd6db`; `main` has since advanced by that one dependency commit, whose diff touches only `package.json`, `package-lock.json`, `scripts/projectIdentity.test.mjs`, and one changeset, so every cited source `file:line` is identical at both revisions and delivery remains to `refs/heads/main`.
- **Design issue G1:** resolved; it concerned only the socket-path input of `sessiondListenOptions` and its test in §8.6 (see §12).

Every `file:line` claim below was re-verified by reading the file at code revision `b40ecd9ffcfa2d4444685627baaa09932e729dbf` (and remains correct at the design's pinned `89a06f86568645908d730f17767f191f626cd6db`). Where this specification names an interface, it names the file and symbol that owns it. No implementation bodies are given: signatures, types, exact expressions, and fixtures only.

---

## 1. Scope

### 1.1 What changes

1. **Config file surface (new).** One top-level `sessiond` object in the global config file with `host`, `port`, and `url`, parsed and round-tripped by `src/config.ts`.
2. **Connect resolution (new behavior).** The web/API resolves `sessiond.url` (environment first, then file) inside `src/sessiond/config.ts` and validates it there.
3. **Bind resolution (new behavior).** The session daemon resolves `(file subtree, environment)` once via `src/sessiond/listenerConfig.ts` `sessiondListenerConfig`, uses the result for `app.listen`, and reports the same value with per-value provenance on its runtime component.
4. **Runtime protocol (additive).** `PiWebUiRuntimeComponent.sessiondListener` carries the daemon's actual listener and per-value sources through the existing runtime transport.
5. **Read projection (new).** `src/server/configRoutes.ts` returns `sessiond` on read responses while every browser write path stays sessiond-free.
6. **Client (new).** Parsers carry `sessiond`, `sessiondUrl`, and `sessiondListener`; two pure helpers compute the coherence warning and the activation verdict; the Session daemon Settings panel renders a read-only listener block.
7. **Documentation and release.** `docs/config.md`, `docs/config.html`, `docs/install.html`, and one Changeset.

### 1.2 Out of scope (binding non-goals)

All design non-goals are binding and unchanged: no GUI-writable listener settings; no URL derivation from host; no default daemon TCP port (`DEFAULT_PORT = 8808` stays web/API-only); no `sessiond.socket` config key (`PI_WEBUI_SESSIOND_SOCKET` stays env-only); no reverse-proxy path prefixes in `sessiond.url`; no live reconfiguration; and no change to `SELECTED_MACHINE_CONFIG_KEYS`, `parseConfigRequest`, or any browser write path.

### 1.3 Binding design decisions restated

- Scope B: the config file carries `sessiond.host`, `sessiond.port`, and `sessiond.url`; environment variables remain authoritative.
- The Session daemon panel is read-only; no browser-writable listener keys.
- Verdicts are `active` / `overridden` / `restart-required` / `unavailable`, with daemon-reported per-value provenance.
- Empty or whitespace-only host means absent and binds `127.0.0.1`; this is a security tightening.
- No URL derivation; no default daemon TCP port.

---

## 2. Config types and validation tiers

### 2.1 Types — `src/shared/apiTypes.ts`

```ts
export interface PiWebUiSessiondConfig {
  host?: string;
  port?: number;
  url?: string;
}
```

- `PiWebUiConfigValues` gains `sessiond?: PiWebUiSessiondConfig;` (declaration site: the `export interface PiWebUiConfigValues` block, alongside `host`, `port`, `agent`, `tts`, and `speechInput`).
- `PiWebUiConfigEnvOverrides` gains exactly one optional member: `sessiondUrl?: boolean;` (declaration site: the `export interface PiWebUiConfigEnvOverrides` block). No bind-side flags are added.

### 2.2 File parser — `src/config.ts` `parsePiWebUiSessiondConfig`

Add one exported symbol:

```ts
export function parsePiWebUiSessiondConfig(value: unknown, path: string): PiWebUiSessiondConfig;
```

Rules, in evaluation order:

1. `value` must be a non-array object (`isRecord`, already defined in `src/config.ts`). Otherwise throw `PI WEBUI config sessiond must be an object: ${path}`.
2. Every own enumerable key must be one of `host`, `port`, `url`. Otherwise throw ``PI WEBUI config sessiond contains unknown key ${JSON.stringify(unknownKey)}: ${path}``.
3. `host`, when present, must be a string. Otherwise throw `PI WEBUI config sessiond.host must be a string: ${path}`. Assign the trimmed value only when the trimmed value is not `""`; omit the key when it is.
4. `url`, when present, must be a string. Otherwise throw `PI WEBUI config sessiond.url must be a string: ${path}`. Assign the trimmed value only when the trimmed value is not `""`; omit the key when it is.
5. `port`, when present, is passed unchanged to the existing `parsePort(value["port"], "sessiond.port", path)`. The value is not trimmed or normalized by the sessiond parser; `parsePort` supplies all checks and the message `PI WEBUI config sessiond.port must be an integer from 1 to 65535: ${path}`.
6. An object that produces no keys is returned as `{}` (it is not omitted from the parsed config).

`parsePiWebUiConfig` (same file) gains exactly one spread entry in its returned `config` object:

```ts
...(value["sessiond"] !== undefined ? { sessiond: parsePiWebUiSessiondConfig(value["sessiond"], path) } : {}),
```

The existing top-level `host`/`port` handling is unchanged.

### 2.3 Port rule reuse — `src/config.ts` `parsePort`

The existing `function parsePort(value: unknown, key: string, path = "environment"): number` gains the `export` keyword. Its body is unchanged. This is the single shared rule; `src/sessiond/listenerConfig.ts` must call it for the environment port rather than re-deriving the range.

### 2.4 Persistence round-trip — `src/config.ts` `piWebUiConfigRecord`

Add one entry:

```ts
...(config.sessiond !== undefined ? { sessiond: config.sessiond } : {}),
```

### 2.5 No delete-on-save — `src/config.ts` `savePiWebUiConfig`

The function's `delete existing[...]` block is unchanged. In particular, `delete existing["sessiond"]` must **not** be added: `PUT /api/config` calls `service.update` with a patch that does not spread the current config (`src/server/configRoutes.ts`, `registerConfigRoutes` PUT handler), so an unconditional delete would erase the operator's listener subtree on any unrelated save. `sessiond` survives because it is not deleted and `merged = { ...existing, ...piWebUiConfigRecord(normalized) }` preserves it when the patch omits it.

### 2.6 Effective resolution — `src/config.ts` `resolveEffectivePiWebUiConfig`

Inside the existing `config: { ...loaded.config, ... }` spread, add exactly one layering of the web/API-owned key:

- `const sessiondUrl = (options.env ?? process.env)["PI_WEBUI_SESSIOND_URL"]?.trim();`
- When `sessiondUrl !== undefined && sessiondUrl !== ""`: add `sessiond: { ...loaded.config.sessiond, url: sessiondUrl }`.
- Otherwise add nothing for `sessiond`.

`sessiond.host` and `sessiond.port` are never read from the environment here. The file values from `loaded.config.sessiond` flow through the leading spread untouched.

### 2.7 Validation tiers and process ownership

| Tier | Rules | Owner | Failure |
| --- | --- | --- | --- |
| Shape and type | `sessiond` is a non-array object; `host`/`url` strings; `port` number or numeric string; no unknown keys inside `sessiond` | `parsePiWebUiSessiondConfig` (shared, runs wherever the config file is loaded) | Fatal to the loading process |
| Structural primitive validity | `port` integer in `1..65535`; `""`, whitespace, non-numeric, fractional, `0`, and `> 65535` are errors | `parsePort` via `parsePiWebUiSessiondConfig` | Fatal to the loading process |
| Runtime semantics (URL form) | Absolute `http:`/`https:` URL, non-empty host, optional port, path empty or `/`, no credentials/query/hash | `src/sessiond/config.ts` `sessiondHttpUrl`, reached only from `SessionDaemonClient` construction | Fatal to the web/API only; the session daemon never evaluates it |

Port validity is enforced in exactly two call sites by one rule: the file parser calls `parsePort`, and `sessiondListenerConfig` calls `parsePort` on a non-blank `PI_WEBUI_SESSIOND_PORT`.

### 2.8 Trim-aware emptiness test — `src/server/configRoutes.ts` `piWebUiConfigEnvOverrides`

Add one member to the returned `PiWebUiConfigEnvOverrides`:

```ts
sessiondUrl: isEnvSetAfterTrim(env["PI_WEBUI_SESSIOND_URL"]),
```

with a new module-private helper:

```ts
function isEnvSetAfterTrim(value: string | undefined): boolean;
```

whose result is exactly `value !== undefined && value.trim() !== ""`.

The existing `isEnvSet` helper (`value !== undefined && value !== ""`) and the existing `host`, `port`, `allowedHosts`, `spawnSessions`, `subsessions`, `agent*` flags keep their current behavior. `sessiondUrl` must use the new trim-aware helper so a whitespace-only `PI_WEBUI_SESSIOND_URL` cannot claim an override that `resolveEffectivePiWebUiConfig` ignores.

---

## 3. Connect resolution (web/API only)

### 3.1 `src/sessiond/config.ts` `sessiondHttpUrl`

Current signature (`export function sessiondHttpUrl(): string | undefined`) becomes:

```ts
export function sessiondHttpUrl(options: LoadOptions = {}): string | undefined;
```

Behavior:

1. Load once: `const loaded = loadPiWebUiConfig(options);` then resolve the value with the same shared path the read projection uses: `resolveEffectivePiWebUiConfig(loaded, options).config.sessiond?.url`. The config path for error messages is `loaded.path`.
2. When the resolved value is `undefined`, return `undefined`.
3. Otherwise validate it with the rules in §3.2 and return the validated string unchanged (the value is already trimmed by the parser or the effective resolver).

`sessiondSocketPath()` is unchanged and still reads `process.env["PI_WEBUI_SESSIOND_SOCKET"]` and `piWebUiDataDir()`.

### 3.2 URL-form validation

New module-private symbol in `src/sessiond/config.ts`; its rules:

| Check | Accepted | Message on failure |
| --- | --- | --- |
| Parses as a URL | `new URL(value)` succeeds | `PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}` |
| Scheme | `http:` or `https:` | same message as above |
| Host | `url.hostname !== ""` | same message as above |
| Credentials | `url.username === "" && url.password === ""` | `PI WEBUI config sessiond.url must not contain credentials: ${configPath}` |
| Query | `url.search === ""` | `PI WEBUI config sessiond.url must not contain a query string: ${configPath}` |
| Fragment | `url.hash === ""` | `PI WEBUI config sessiond.url must not contain a fragment: ${configPath}` |
| Path | `url.pathname === "/"` (covers empty and root) | `PI WEBUI config sessiond.url must not contain a path: ${configPath}` |

Accepted examples: `http://127.0.0.1:8810`, `https://host`, `http://127.0.0.1:8810/`. Rejected examples: `127.0.0.1:8810` (relative), `ftp://host`, `http://user:pass@host`, `http://host/?a=1`, `http://host/#x`, `http://host/prefix`.

This rule is deliberately stricter than `machineService.validateBaseUrl` (`src/server/machines/machineService.ts`), which tolerates path components; `SessionDaemonClient` discards any path via `new URL(path, this.baseUrl)` with root-absolute paths, so accepting a prefix would acknowledge an unsupported configuration.

### 3.3 `src/sessiond/sessionDaemonClient.ts` `SessionDaemonClient`

The two field initializers become constructor assignments; the class gains one constructor parameter:

```ts
constructor(options: LoadOptions = {});
```

Contract:

- `this.baseUrl = sessiondHttpUrl(options);`
- `this.socketPath = sessiondSocketPath();`
- Both fields remain `private readonly`; the resolved transport is fixed for the instance lifetime.
- `request` and `connectWebSocket` bodies are unchanged: a defined, non-empty `baseUrl` selects HTTP/WebSocket over TCP; otherwise the unix socket is used.
- The parameter type is imported from `src/config.ts` (`LoadOptions`).
- Default `{}` preserves every existing `new SessionDaemonClient()` call site (`src/server/app.ts:328`, `src/server/piWebUiStatus.ts` default parameters, `src/server/sessiond/sessionProxyRoutes.ts`, `src/server/terminalProxyRoutes.ts`, `src/server/workspaces/workspaceDeletionRoutes.ts`, `src/piWebUiVersionReport.ts:139`).
- The constructor body evaluates `sessiondHttpUrl` exactly once; a later `process.env` mutation cannot change `baseUrl`.

Because `sessiondHttpUrl` loads the config file, a malformed URL form throws from `SessionDaemonClient` construction. In `buildApp` (`src/server/app.ts`) that rejects web/API startup. Nothing in `src/sessiond/config.ts` executes validation at module scope, so the session daemon's transitive import of this module (`src/server/sessiond.ts` → `src/server/piWebUiStatus.ts` → `src/sessiond/sessionDaemonClient.ts` → `src/sessiond/config.ts`) remains side-effect-free.

---

## 4. Session daemon listener resolution and reporting

### 4.1 `src/sessiond/listenerConfig.ts` `sessiondListenerConfig`

New pure module `src/sessiond/listenerConfig.ts` containing:

```ts
export function sessiondListenerConfig(
  subtree: PiWebUiSessiondConfig | undefined,
  env: NodeJS.ProcessEnv,
): PiWebUiSessiondListenerDescriptor;
```

Inputs are the raw loaded file subtree and the environment, never the merged effective config; taking both inputs keeps `0.0.0.0` from either source distinguishable. The function performs no I/O.

Resolution rules, in evaluation order:

1. `const envPortText = env["PI_WEBUI_SESSIOND_PORT"]?.trim();`
2. When `envPortText !== undefined && envPortText !== ""`: `envPort = parsePort(envPortText, "PI_WEBUI_SESSIOND_PORT")`, imported from `src/config.ts`. Any failure throws; an empty or whitespace-only value counts as absent and never throws.
3. `port = envPort ?? subtree?.port`.
4. When `port === undefined`: return `{ kind: "socket" }`.
5. `portSource = envPort !== undefined ? "env" : "config"`.
6. `const envHost = env["PI_WEBUI_SESSIOND_HOST"]?.trim();`
7. Host and source: non-empty `envHost` → `(envHost, "env")`; else `subtree?.host` (already trimmed by the parser) → `(subtree.host, "config")`; else `("127.0.0.1", "default")`.
8. Return `{ kind: "tcp", host, port, hostSource, portSource }`.

The literal default is `127.0.0.1`, never `localhost`. A non-empty host is used as-is; no DNS or interface validation is added. A host with no port returns `{ kind: "socket" }` (rule 4 precedes host resolution), so `sessiond.host` alone binds nothing.

The function never reads `subtree.url` or `PI_WEBUI_SESSIOND_URL`, so an invalid URL form cannot stop the daemon.

### 4.2 `src/sessiond/listenerConfig.ts` `sessiondListenOptions`

The module's second pure export maps a resolved listener plus an explicitly supplied socket path to Fastify listen options:

```ts
export function sessiondListenOptions(
  listener: PiWebUiSessiondListenerDescriptor,
  socketPath: string,
): { port: number; host: string } | { path: string };
```

- `listener` is the resolved descriptor returned by `sessiondListenerConfig` (§4.1), not the raw config subtree.
- `socketPath` is the socket path for this daemon startup. The wire descriptor's socket branch is deliberately path-free (design: reporting a socket path would ship a home-directory path across federation), so the mapper cannot derive the path without becoming impure; the caller supplies it instead. The daemon's `listen()` step resolves it with `sessiondSocketPath()` in `src/sessiond/config.ts` on the socket branch only — the branch that already calls it today — so passing it in adds no new resolution work, and the TCP branch never resolves it (see §4.3).

Output contract, per branch:

- `{ kind: "tcp", host, port, ... }` → `{ port, host }`. The socket-path argument is ignored on this branch.
- `{ kind: "socket" }` → `{ path: socketPath }`, holding the supplied argument verbatim.

The mapper is pure: it performs no I/O and does not call `sessiondSocketPath()` itself. The wire descriptor stays path-free; only the local resolution passes the path into this function.

### 4.3 Startup wiring — `src/server/sessiond.ts`

`createRuntime()` (inside the `runSessionDaemonStartup` call):

1. Resolve the listener exactly once at the top of the function:
   `const sessiondListener = sessiondListenerConfig(loadPiWebUiConfig({ env: daemonEnvironment }).config.sessiond, daemonEnvironment);`
   (`loadPiWebUiConfig` is already imported in this file; `daemonEnvironment` is the module-load frozen environment.)
2. Attach it to the frozen runtime component:
   `const runtimeComponent = Object.freeze({ ...getPiWebUiRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES), activeAgentProfile, sessiondListener });`
3. Include `sessiondListener` in the object returned by `createRuntime` (next to `runtimeComponent`).

`listen(runtime)` destructures `sessiondListener` from its runtime argument instead of reading `PI_WEBUI_SESSIOND_PORT`/`PI_WEBUI_SESSIOND_HOST`:

1. Both inline environment reads (`const portValue = ...`; `const host = ...`) are deleted.
2. The listener is dispatched by `sessiondListener.kind`, never by port presence.
3. Both branches feed `app.listen` through the mapper, and no branch builds an inline `{ port, host }`/`{ path }` options object at the call site:
   - TCP: `await app.listen(sessiondListenOptions(sessiondListener, ""))`; the socket-path argument is a documented-ignored sentinel value on this branch, so the TCP branch performs no socket-path resolution while using the same mapper call shape as the socket branch.
   - Socket: resolve `const path = sessiondSocketPath();` (the same source as today), perform the existing side effects on that value (`mkdir(dirname(path), { recursive: true })`, `rm(path, { force: true })`), then `await app.listen(sessiondListenOptions(sessiondListener, path))`; register the existing `process.on("exit", () => void rm(path, { force: true }))` cleanup. The mapper's socket-branch `{ path }` and the side effects therefore come from the same `sessiondSocketPath()` call, preserving today's behavior byte-for-byte for the non-options part.
4. `sessiondSocketPath()` is resolved only for the socket branch, which is the only branch that calls it today. §8.6 still pins that the mapper's TCP branch ignores its socket-path argument under multiple values. The design's "no new resolution work" claim is therefore exact.
5. The descriptor embedded in `runtimeComponent` and the value feeding `app.listen` are the same resolved object, so the report cannot drift from the bound socket.

### 4.4 Runtime descriptor types — `src/shared/apiTypes.ts`

```ts
export type PiWebUiSessiondListenerSource = "env" | "config" | "default";
/** A port has no default, so its source is narrower than the host's. */
export type PiWebUiSessiondPortSource = "env" | "config";

export type PiWebUiSessiondListenerDescriptor =
  | { kind: "tcp"; host: string; port: number;
      hostSource: PiWebUiSessiondListenerSource; portSource: PiWebUiSessiondPortSource }
  | { kind: "socket" };
```

`PiWebUiRuntimeComponent` gains `sessiondListener?: PiWebUiSessiondListenerDescriptor;` with a doc comment equivalent to `activeAgentProfile`'s ("Present only for a session daemon that supports listener reporting"). The socket branch carries no `path` field. No capability flag is added; field presence is the discriminator.

### 4.5 Strict runtime parser — `src/shared/piWebUiStatusParsing.ts`

New exported symbol:

```ts
export function parsePiWebUiSessiondListenerDescriptor(value: unknown): PiWebUiSessiondListenerDescriptor | undefined;
```

Rules:

- Non-array object required.
- `kind` must be `"tcp"` or `"socket"`.
- Unknown keys anywhere in the descriptor are rejected.
- Socket branch: the only allowed key set is `{ kind }`.
- TCP branch: allowed key set is `{ kind, host, port, hostSource, portSource }`; `host` a non-empty string; `port` an integer in `1..65535`; `hostSource` one of `"env" | "config" | "default"`; `portSource` one of `"env" | "config"`.
- Any violation returns `undefined`.
- The returned descriptor is frozen (`Object.freeze`), mirroring `parseActiveAgentProfileDescriptor` (specification-level choice; not design-mandated).

`parsePiWebUiRuntimeComponent` (same file) adds the sessiond-gated field:

```ts
const sessiondListenerValue = value["sessiondListener"];
const sessiondListener = sessiondListenerValue === undefined
  ? undefined
  : parsePiWebUiSessiondListenerDescriptor(sessiondListenerValue);
if (sessiondListenerValue !== undefined && (component !== "sessiond" || sessiondListener === undefined)) return undefined;
```

and includes `...(sessiondListener === undefined ? {} : { sessiondListener })` in the returned component. Malformed inputs rejected by this parser (whole `parsePiWebUiRuntimeResponse` returns `undefined`): wrong `kind`, missing/blank `host`, non-integer/out-of-range `port`, unknown source string, unknown key inside the descriptor, and a descriptor attached to `component === "web"`.

### 4.6 Transport chain (unchanged)

No route is added. The daemon's `GET /runtime` (`src/server/sessiond.ts`) is proxied by the gateway's `GET /api/pi-webui/runtime` (`src/server/app.ts`), consumed by `MachineService.runtime` (`localRuntime` and `remoteRuntime`, `src/server/machines/machineService.ts`), and read by the browser through `GET /api/machines/:machineId/runtime` (`src/server/machines/machineRoutes.ts`). `MachineRuntime.components` is typed as `PiWebUiRuntimeResponse["components"]`, so the new field flows without a shape change. `/pi-webui/status` is not part of this chain.

---

## 5. Read/write projection split — `src/server/configRoutes.ts`

### 5.1 Read-only sessiond parser

Add a module-private read-side parser that is never wired into a request-body handler:

```ts
function parseReadOnlySessiondConfig(value: unknown, source: string): PiWebUiSessiondConfig;
```

- `value` must be a non-array object; otherwise throw `PI WEBUI config sessiond must be an object: ${source}`.
- Allowed keys are exactly `host`, `port`, `url`; unknown keys throw the same message shape as §2.2.
- Types are validated exactly as in §2.2 (`host`/`url` strings, trimmed and omitted when blank; `port` a number in `1..65535`). URL form is not validated here.
- The read parser must accept exactly the same shapes and produce exactly the same messages as the shared `parsePiWebUiSessiondConfig`; sharing that implementation (calling `parsePiWebUiSessiondConfig` with the response-source label) is the recommended way to guarantee it. Requiring delegation is a specification-level choice; not design-mandated — the design requires only that response parsing preserve `sessiond` and remain read-only.

Add a response-values wrapper:

```ts
function parsePiWebUiConfigResponseValues(value: unknown, agentPathHost: AgentPathHost, source: string): PiWebUiConfigValues;
```

- Calls the existing `parseConfigRequest(value, agentPathHost)` unchanged for every non-sessiond key.
- When `record["sessiond"] !== undefined`, overlays `{ sessiond: parseReadOnlySessiondConfig(record["sessiond"], source) }`; otherwise returns the parsed value untouched. The `source` label is the same label `parsePiWebUiConfigResponseBody` already passes to `requireResponseRecord` (for example `"Remote machine config response"`), so nested sessiond errors are attributable.

`parsePiWebUiConfigResponseBody` (exported, unchanged signature) switches its `config` and `effectiveConfig` fields from `parseConfigRequest(record[...], "portable")` to `parsePiWebUiConfigResponseValues(record[...], "portable", source)`.

`parseConfigRequest` itself stays exactly as it is: it reads only `host`, `port`, `allowedHosts`, `shortcuts`, `plugins`, `pathAccess`, `uploads`, `maxUploadBytes`, `modelTiers`, `spawnSessions`, `subsessions`, `agent`, and `tts`, and it never learns `sessiond`.

**Remote env-override projection (blocker fix).** `parsePiWebUiConfigEnvOverridesResponse` in the same file (`src/server/configRoutes.ts`) also gains exactly one member, using the `optionalResponseBoolean` helper already defined in that file:

```ts
sessiondUrl: optionalResponseBoolean(record, "sessiondUrl", source) ?? false,
```

The remote read path depends on it: `sendSelectedMachineConfigResponse` in `src/server/machines/machineProxyRoutes.ts` parses the upstream body with `parsePiWebUiConfigResponseBody`, so without this member the upstream `envOverrides.sessiondUrl` is silently discarded and a remote machine whose gateway has `PI_WEBUI_SESSIOND_URL` set always reports `sessiondUrl: false` locally. That would produce a false coherence warning and no override badge, defeating the per-half suppression the design requires. This member is the read-side counterpart of the `piWebUiConfigEnvOverrides` producer (§2.8) and follows the design's "Environment override projection" clause: optional, parsed as `optionalResponseBoolean(...) ?? false`, so an older remote gateway that omits it cannot fail `parsePiWebUiConfigResponseBody`. This keeps the remote read path's override flag intact, and §8.8's route-level remote round-trip test is the regression guard.

### 5.2 Display projection

`selectedMachineConfigResponse` (exported, unchanged signature) changes to:

```ts
config: projectSelectedMachineConfigValues(response.config),
effectiveConfig: projectSelectedMachineConfigValues(response.effectiveConfig),
```

with a new module-private helper:

```ts
function projectSelectedMachineConfigValues(config: PiWebUiConfigValues): PiWebUiConfigValues;
```

Its result is exactly `{ ...pickSelectedMachineConfig(config), ...(config.sessiond === undefined ? {} : { sessiond: config.sessiond }) }`. `pickSelectedMachineConfig` and `SELECTED_MACHINE_CONFIG_KEYS` are unchanged and still exclude `sessiond`.

This projection is used by the local read route (`registerLocalMachineConfigRoutes` GET), the local PUT response, and the remote proxy response (`sendSelectedMachineConfigResponse` in `src/server/machines/machineProxyRoutes.ts`), so all four paths gain `sessiond` and remain display-only.

### 5.3 Unchanged write paths

- `parseConfigRequest` stays sessiond-free (§5.1). The generic `PUT /api/config` route therefore ignores a body `sessiond` key and cannot create one.
- `parseSelectedMachineConfigRequest` and `mergeSelectedMachineConfig` are unchanged; `sessiond` is not a selected-machine key, so `PUT /api/machines/local/config` and its remote proxy reject a body containing it with `PI WEBUI selected-machine config key is not allowed: sessiond`.
- `savePiWebUiConfig` never deletes `sessiond` (§2.5), so unrelated saves preserve disk state.

### 5.4 Generic gateway response

`GET /api/config` (`piWebUiConfigResponseFromSnapshot`) passes `loaded.config` through unchanged, so it begins carrying `sessiond` in `config` and `effectiveConfig` once the type and parser gain the key. This is deliberate; it is read-only, scoped to the local gateway, and exposes only the operator's own file value. No redaction is added.

---

## 6. Client contract

### 6.1 Barrel — `src/client/src/api.ts`

The file re-exports shared types one by one from `../../shared/apiTypes`. Add `PiWebUiSessiondConfig` and `PiWebUiSessiondListenerDescriptor` (and optionally `PiWebUiSessiondListenerSource` / `PiWebUiSessiondPortSource`) to that `export type { ... }` list, because the helpers and the panel import types from `../../api`.

### 6.2 `src/client/src/api/parsers.ts`

| Symbol | Change |
| --- | --- |
| `parsePiWebUiConfigValues` | Parse optional `sessiond` with a local `optionalSessiond(value)` helper: non-array object; allowed keys exactly `host`, `port`, `url`; `host`/`url` strings (trim before storing; a blank-after-trim string is omitted rather than throwing, matching the server parser, and an all-blank subtree is kept as `{}`); `port` an integer in `1..65535`. Unknown keys, wrong types, and out-of-range ports throw. URL form is not validated. |
| `parsePiWebUiConfigEnvOverrides` | Add `sessiondUrl: optionalBoolean(record, "sessiondUrl") ?? false`. |
| `parsePiWebUiRuntimeComponent` | Parse optional `sessiondListener` with a local strict helper mirroring §4.5's accepted shapes (tcp key set `{kind,host,port,hostSource,portSource}`; socket key set `{kind}`; same value domains). A descriptor present on `component === "web"` or a malformed descriptor throws `Invalid session daemon listener descriptor` (the function's existing failure style). A missing descriptor stays `undefined`. |

The client parser for `sessiond` rejects unknown keys (matching `optionalTts`'s `assertOnlyFields` style). Rejecting unknown keys is a specification-level choice; not design-mandated — the design requires only that the client carries `sessiond` and stays rolling-compatible with producers that omit it. Rolling compatibility is guaranteed by the producer because an omitted `sessiond`/`sessiondListener`/`sessiondUrl` parses cleanly.

### 6.3 Pure helpers — `src/client/src/components/settings/settingsSessiondConfig.ts`

Add these exported types and signatures:

```ts
export type SessiondActivationState = "active" | "overridden" | "restart-required" | "unavailable";
export type SessiondCoherenceIssue = "missing-dial-target" | "missing-bind-port";

export function activationState(
  fileSessiond: PiWebUiSessiondConfig | undefined,
  listener: PiWebUiSessiondListenerDescriptor | undefined,
): SessiondActivationState;

export function coherenceWarning(
  fileSessiond: PiWebUiSessiondConfig | undefined,
  sessiondUrlOverridden: boolean,
  listener: PiWebUiSessiondListenerDescriptor | undefined,
): SessiondCoherenceIssue | undefined;

export function coherenceWarningMessage(issue: SessiondCoherenceIssue): string;
```

`activationState` desired side (file only, one normalization):

- `fileSessiond?.port === undefined` → desired `{ kind: "socket" }`.
- otherwise → desired `{ kind: "tcp", host: fileSessiond?.host?.trim() || "127.0.0.1", port: fileSessiond.port }`. The trim-and-default guard protects against a remote gateway that predates the parser normalization.

`activationState` verdict rules, evaluated in this order, and exactly this environment-influence predicate:

1. `listener === undefined` → `"unavailable"`.
2. Desired socket and listener socket → `"active"` (paths are not compared; the socket path is env-only and out of scope).
3. Desired socket and listener TCP → `listener.portSource === "env" ? "overridden" : "restart-required"`. A host environment override cannot explain TCP, because a TCP listener requires a port from somewhere.
4. Desired TCP and listener socket → `"restart-required"` unconditionally. A bound socket means no port was resolved, including no environment port.
5. Desired TCP equals listener TCP (`host` and `port` both equal) → `"active"`.
6. Otherwise, with `desired` = the desired TCP object and `listener` = the actual TCP descriptor, environment influence is the explicit boolean expression

```ts
(desired.host !== listener.host && listener.hostSource === "env")
  || (desired.port !== listener.port && listener.portSource === "env")
```

which yields `"overridden"` when true and `"restart-required"` when false. Influence is scoped per differing value: an env-sourced value the file already agrees with cannot explain a disagreement elsewhere in the pair.

`coherenceWarning` rules (reads config-file presence only):

- `hasPort = fileSessiond?.port !== undefined`; `hasUrl = fileSessiond?.url !== undefined`.
- `hasPort && !hasUrl` → `sessiondUrlOverridden ? undefined : "missing-dial-target"`.
- `!hasPort && hasUrl` → `(listener?.kind === "tcp" && listener.portSource === "env") ? undefined : "missing-bind-port"`.
- otherwise → `undefined`. In particular `hasPort && hasUrl` and `!hasPort && !hasUrl` never warn, and an env-only deployment with no `sessiond` object never warns. While `listener === undefined` the bind half is never suppressed; `hostSource === "env"` never suppresses a half.

`coherenceWarningMessage` returns these exact strings:

- `"missing-dial-target"`: `"sessiond.port is configured, but no sessiond.url is set and PI_WEBUI_SESSIOND_URL is not set on that machine, so the web/API will dial the session daemon socket while the daemon listens on TCP. Add sessiond.url or remove sessiond.port."`
- `"missing-bind-port"`: `"sessiond.url is configured, but no sessiond.port is set and PI_WEBUI_SESSIOND_PORT is not set on that machine, so the daemon will listen on the session daemon socket. Add sessiond.port or remove sessiond.url."`

### 6.4 `mergeSelectedMachineSessiondConfig`

The function keeps its signature and its `config`/`effectiveConfig` spread merge (`sessiond` therefore flows through automatically). In the explicitly reconstructed `envOverrides` object it adds:

```ts
sessiondUrl: selectedMachine.envOverrides.sessiondUrl ?? false,
```

`agentDirSource` handling and every existing override field stay unchanged.

### 6.5 Panel — `src/client/src/components/settings/SettingsSessiondPanel.ts`

New property declaration next to `activeAgentProfile`:

```ts
@property({ attribute: false }) sessiondListener: PiWebUiSessiondListenerDescriptor | undefined;
```

Display contract (read-only; no input, no draft state, no patch builder):

- The block renders inside the `config !== undefined` branch, immediately after the existing `.config-path-card` div and before the agent-profile `<form>`.
- The block is a `<section class="listener-card" aria-label="Session daemon listener summary">` containing an `<h3>Listener</h3>` and a `<dl>` with exactly these six rows:
  1. `Desired bind address` — `config.config.sessiond?.port === undefined ? "Unix socket" : (config.config.sessiond.host ?? "127.0.0.1")`.
  2. `Desired bind port` — `config.config.sessiond?.port === undefined ? "Unix socket" : String(config.config.sessiond.port)`.
  3. `Running bind address` — `listener === undefined ? "Unavailable" : listener.kind === "socket" ? "Unix socket" : listener.host`.
  4. `Running bind port` — `listener === undefined ? "Unavailable" : listener.kind === "socket" ? "Unix socket" : String(listener.port)`.
  5. `Web/API dial target` — `config.effectiveConfig.sessiond?.url ?? "Unix socket"`.
  6. `Listener status` — the verdict label below.
- Source badges (`<span class="override-badge">environment override</span>`), rendered only when a value's effective source is the environment:
  - Running bind address: when `listener.kind === "tcp" && listener.hostSource === "env"`.
  - Running bind port: when `listener.kind === "tcp" && listener.portSource === "env"`.
  - Web/API dial target: when `config.envOverrides.sessiondUrl === true`.
  - Desired rows carry no badge; a file value never comes from the environment.
- Verdict labels (`activationState(config.config.sessiond, listener)`):
  - `active` → `✓ daemon in sync`.
  - `overridden` → `⚠ one or more listener values come from the environment, so the config file cannot take full effect until the environment changes`.
  - `restart-required` → `⚠ restart required`.
  - `unavailable` → no verdict text and no verdict glyph in the `Listener status` row. The muted `Unavailable` row values belong to the two running-listener rows (rows 3 and 4), whose row values are the actual socket/TCP form when `listener` is known and muted `Unavailable` when it is not; the `Listener status` row itself stays empty in this state. This is the single-valued reading of the design's "no verdict rendered".
- Coherence warning: when `coherenceWarning(config.config.sessiond, config.envOverrides.sessiondUrl === true, listener)` is defined, the block renders `<p class="listener-warning">${coherenceWarningMessage(issue)}</p>` immediately after the `<dl>`. It is recomputed on every render, so the bind half is visible while `sessiondListener` is still absent and disappears once the daemon report supplies `portSource === "env"`.
- The block performs no mutation and holds no state.

### 6.6 `src/client/src/components/SettingsDialog.ts`

Inside `renderActiveSection`, the existing `settings-sessiond-panel` binding list gains exactly one property, immediately after the `activeAgentProfile` binding:

```ts
.sessiondListener=${this.machineRuntime?.components?.sessiond.sessiondListener}
```

No logic change. `reloadSessiondState` already refreshes both the config response and `machineRuntime` (`onRefreshMachineRuntime`), so config and descriptor arrive on the same refresh.

---

## 7. Error behavior

One row per failure mode. "Fatal" means the named process fails to start (or the request fails, for route-level errors).

| # | Condition | Process that fails | Message (exact; `${path}` is the resolved config path, `${source}` a response label) | Fatal |
| --- | --- | --- | --- | --- |
| 1 | `sessiond` present but not a non-array object | any config loader | `PI WEBUI config sessiond must be an object: ${path}` | yes, to that process |
| 2 | unknown key inside `sessiond` | any config loader | `PI WEBUI config sessiond contains unknown key "x": ${path}` | yes, to that process |
| 3 | `sessiond.host` not a string | any config loader | `PI WEBUI config sessiond.host must be a string: ${path}` | yes, to that process |
| 4 | `sessiond.url` not a string | any config loader | `PI WEBUI config sessiond.url must be a string: ${path}` | yes, to that process |
| 5 | `sessiond.port` blank, non-numeric, fractional, `0`, or `> 65535` | any config loader | `PI WEBUI config sessiond.port must be an integer from 1 to 65535: ${path}` | yes, to that process |
| 6 | `PI_WEBUI_SESSIOND_PORT` unparseable or out of range | session daemon only | `PI WEBUI config PI_WEBUI_SESSIOND_PORT must be an integer from 1 to 65535: environment` | yes, to the daemon |
| 7 | `PI_WEBUI_SESSIOND_PORT` empty or whitespace-only | none | — | no; treated as absent and not as an override, so the file port still applies |
| 8 | `sessiond.url` (file or env) is a string but not an absolute `http`/`https` URL | web/API only | `PI WEBUI config sessiond.url must be an absolute http or https URL: ${path}` | yes, to the web/API |
| 9 | `sessiond.url` has credentials | web/API only | `PI WEBUI config sessiond.url must not contain credentials: ${path}` | yes, to the web/API |
| 10 | `sessiond.url` has a query | web/API only | `PI WEBUI config sessiond.url must not contain a query string: ${path}` | yes, to the web/API |
| 11 | `sessiond.url` has a fragment | web/API only | `PI WEBUI config sessiond.url must not contain a fragment: ${path}` | yes, to the web/API |
| 12 | `sessiond.url` has a non-root path | web/API only | `PI WEBUI config sessiond.url must not contain a path: ${path}` | yes, to the web/API |
| 13 | malformed `sessiond` on a remote config response | web/API proxy read | a message from #1–#5 with `${source}` used as the label | request fails (HTTP error), no write |
| 14 | `sessiond` key in a selected-machine write body | web/API route | `PI WEBUI selected-machine config key is not allowed: sessiond` | request fails with 400; nothing is written |
| 15 | `sessiond` key in a generic `PUT /api/config` body | none | — (ignored by `parseConfigRequest`) | no; the persisted `sessiond` is unchanged and no new one is created |
| 16 | `port` set, `url` absent in file, no env url | none | panel coherence warning `missing-dial-target` | no |
| 17 | `url` set, `port` absent in file, no env port reported | none | panel coherence warning `missing-bind-port` | no |
| 18 | the incoherent half is resolved by the owning process's environment | none | that half's warning is suppressed and its value is badged `environment override` | no |
| 19 | daemon reports no listener (older daemon) | none | verdict `unavailable`; configured values and the coherence warning still render | no |
| 20 | daemon reports a different listener with per-differing-value env influence (§6.3) | none | verdict `overridden` | no |
| 21 | daemon reports a different listener with no env influence | none | verdict `restart-required` | no |
| 22 | bind fails (address in use, unusable host) | session daemon | `app.listen` rejection propagates | yes, to the daemon (unchanged) |
| 23 | daemon unreachable | none | existing unavailable-config path (unchanged); no sessiond listener verdict is rendered or asserted while the daemon cannot report | no |

---

## 8. Test fixtures and assertions

Layered per `.agents/skills/testing-guide/SKILL.md`. Red tests are written before implementation. Every listed test must exist and be falsifiable; fixture shapes below are the contract.

### 8.1 Config parsing and persistence — `src/config.test.ts`

Harness: the existing temp `configPath` via `testOptions()`, which returns `{ env: { PI_WEBUI_CONFIG: configPath } }` (there is no `cwd`; both `tempDir` and `configPath` are allocated in the suite's `beforeEach`).

| Test | Fixture | Assertion |
| --- | --- | --- |
| accepts and normalizes `sessiond` | file `{"sessiond":{"host":"  0.0.0.0  ","port":"8810","url":"  http://127.0.0.1:8810  "}}` | `loadPiWebUiConfig(testOptions()).config.sessiond` deep-equals `{host:"0.0.0.0",port:8810,url:"http://127.0.0.1:8810"}` |
| omits empty-after-trim strings | file `{"sessiond":{"host":"   ","url":"","port":8810}}` | parsed subtree `{port:8810}`; deep-equals the subtree from file `{"sessiond":{"port":8810}}` |
| rejects malformed shapes | each of `[]`, `"x"`, `{host:1}`, `{url:1}`, `{port:"abc"}`, `{port:""}`, `{port:"   "}`, `{port:0}`, `{port:65536}`, `{port:8810.5}`, `{tls:true}` wrapped as `{"sessiond": <value>}` | `loadPiWebUiConfig` throws with the matching message from §7 #1–#5 |
| no URL-form validation at load | files `{"sessiond":{"url":"127.0.0.1:8810"}}` and `{"sessiond":{"url":"ftp://host"}}` | `loadPiWebUiConfig` does not throw |
| round-trips through `piWebUiConfigRecord` | `savePiWebUiConfig({ sessiond: { host:"0.0.0.0", port:8810, url:"http://127.0.0.1:8810" } }, testOptions())` | returned `saved.config.sessiond` deep-equals the input; `JSON.parse(readFile(configPath)).sessiond` deep-equals it |
| persistence regression (mandatory) | seed file `{"future":true,"sessiond":{"host":"0.0.0.0","port":8810,"url":"http://127.0.0.1:8810"}}`; `savePiWebUiConfig({ spawnSessions: true }, testOptions())` | returned `saved.config.sessiond` deep-equals the original subtree; file `sessiond` unchanged; `spawnSessions: true` present |
| effective resolution layers only `url` | file `{"sessiond":{"host":"0.0.0.0","port":8810}}`; env `{PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL:" http://127.0.0.1:8810 "}` | `effectivePiWebUiConfig(opts).config.sessiond` deep-equals `{host:"0.0.0.0",port:8810,url:"http://127.0.0.1:8810"}` |
| blank env url is absent | same file; env url `"   "` then `""` | `effectivePiWebUiConfig(opts).config.sessiond` deep-equals `{host:"0.0.0.0",port:8810}` |
| bind env is not layered | same file; env `{PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_HOST:"1.2.3.4", PI_WEBUI_SESSIOND_PORT:"9999"}` | `effectivePiWebUiConfig(opts).config.sessiond` deep-equals `{host:"0.0.0.0",port:8810}` |
| absent `sessiond` unchanged | file `{"port":8808}` | parsed `config.sessiond` is `undefined` and all existing assertions on the file still hold |

### 8.2 Connect resolution — new `src/sessiond/config.test.ts`

Harness: temp config file; `sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath, ... } })`; never rely on the developer's real config (always inject `PI_WEBUI_CONFIG`).

| Test | Fixture | Assertion |
| --- | --- | --- |
| resolves the file url | file `{"sessiond":{"url":"http://127.0.0.1:8810"}}`, env without `PI_WEBUI_SESSIOND_URL` | returns `"http://127.0.0.1:8810"` |
| env overrides and trims | file url `http://file:1`; env `"  http://env:2  "` | returns `"http://env:2"` |
| blank env url falls back | file url `http://file:1`; env `"   "` then `""` | returns `"http://file:1"` |
| accepts valid forms | `https://host`, `http://127.0.0.1:8810/` | returned unchanged |
| rejects invalid forms | `127.0.0.1:8810`, `ftp://host`, `http://user:pass@host`, `http://host/?a=1`, `http://host/#x`, `http://host/prefix` | throws with §7 #8–#12 messages |
| malformed env value fails the web/API connect resolution only | env `{ PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: "ftp://host" }` with file `{"sessiond":{"port":8810}}` | `sessiondHttpUrl(opts)` throws §7 #8; `sessiondListenerConfig(loadPiWebUiConfig(opts).config.sessiond, { PI_WEBUI_SESSIOND_URL: "ftp://host" })` returns a TCP descriptor without throwing |
| malformed file value does not stop a daemon-style resolution | file `{"sessiond":{"url":"ftp://host","port":8810}}`; `sessiondListenerConfig(loadPiWebUiConfig(opts).config.sessiond, {})` | `sessiondHttpUrl` throws; `sessiondListenerConfig` returns a TCP descriptor |
| client pins the resolved transport | construct `new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:43123" } })`; then mutate `process.env.PI_WEBUI_SESSIOND_URL` to another value | request still targets `http://127.0.0.1:43123` |

Isolation requirement (construction now loads the config): every test construction of `SessionDaemonClient` must inject a test config path, so no test reads the developer's real config. The existing constructions in `src/sessiond/sessionDaemonClient.test.ts` pass `{ env: { PI_WEBUI_CONFIG: <nonexistent path under the test temp dir> } }`. The two TCP tests whose transport relies on `vi.stubEnv("PI_WEBUI_SESSIOND_URL", "http://127.0.0.1:43123")` (`src/sessiond/sessionDaemonClient.test.ts:72` and `:97`) must also include that URL in the injected env — for example `{ env: { PI_WEBUI_CONFIG: <nonexistent path under the test temp dir>, PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:43123" } }` — because `loadPiWebUiConfig` (`src/config.ts:150`) and `resolveEffectivePiWebUiConfig` (`src/config.ts:178`) use `options.env ?? process.env`: an injected env replaces `process.env`, so the stubbed value would no longer be visible, `baseUrl` would become `undefined`, and the HTTP assertions would fail. The socket-path tests are unaffected because `sessiondSocketPath()` still reads `process.env`. The `daemonWithComponent` and `daemonWithRuntime` helpers in `src/server/piWebUiStatus.test.ts` are updated the same way (or via `vi.stubEnv("PI_WEBUI_CONFIG", ...)`) before constructing the client. They are not the only other test constructions: the `buildApp` calls that omit `deps.sessionDaemon` in `src/server/app.piWebUiStatus.test.ts:10`, `src/server/app.removedBrowserRoutes.test.ts:21`, `src/server/app.agentConfig.test.ts:75` and `:97`, `src/server/app.speechInput.test.ts:179`, `src/server/app.activeAgentProfile.test.ts:37` and `:72`, and `src/server/app.projects.test.ts:182` construct the client through the fallback at `src/server/app.ts:328`, so each of those suites injects the shared `fakeSessionDaemon` helper (or stubs a nonexistent `PI_WEBUI_CONFIG`) before calling `buildApp`.

### 8.3 Listener resolution — new `src/sessiond/listenerConfig.test.ts`

Harness: pure calls; no file I/O. Fixture subtrees are the parsed `PiWebUiSessiondConfig` shape.

| Test | Subtree | Environment | Expected |
| --- | --- | --- | --- |
| env port makes TCP with default host | `undefined` | `{PI_WEBUI_SESSIOND_PORT:"8810"}` | `{kind:"tcp",host:"127.0.0.1",port:8810,hostSource:"default",portSource:"env"}` |
| file host + file port | `{host:"0.0.0.0",port:8810}` | `{}` | `{kind:"tcp",host:"0.0.0.0",port:8810,hostSource:"config",portSource:"config"}` |
| env host overrides file host | `{host:"0.0.0.0",port:8810}` | `{PI_WEBUI_SESSIOND_HOST:"::1"}` | `{kind:"tcp",host:"::1",port:8810,hostSource:"env",portSource:"config"}` |
| blank env host falls back to the file host | `{host:"0.0.0.0",port:8810}` | `{PI_WEBUI_SESSIOND_HOST:""}` and `"   "` | `{kind:"tcp",host:"0.0.0.0",port:8810,hostSource:"config",portSource:"config"}` |
| blank env host with no file host binds loopback | `{port:8810}` | `{PI_WEBUI_SESSIOND_HOST:""}` and `"   "` | `{kind:"tcp",host:"127.0.0.1",port:8810,hostSource:"default",portSource:"config"}` |
| env port overrides file port | `{host:"0.0.0.0",port:8810}` | `{PI_WEBUI_SESSIOND_PORT:"9000"}` | `{kind:"tcp",host:"0.0.0.0",port:9000,hostSource:"config",portSource:"env"}` |
| blank/absent gives the socket | `undefined` | `{}` | `{kind:"socket"}` |
| host alone binds nothing | `{host:"0.0.0.0"}` | `{}` | `{kind:"socket"}` |
| blank env port is absent | `{port:8810}` | `{PI_WEBUI_SESSIOND_PORT:""}` and `"   "` | `{kind:"tcp",...,port:8810,portSource:"config"}`; with no file port, `{kind:"socket"}` |
| invalid env port throws | `undefined` | `"abc"`, `"0"`, `"65536"`, `"8810.5"` | throws `PI WEBUI config PI_WEBUI_SESSIOND_PORT must be an integer from 1 to 65535: environment` |
| url form never affects resolution | `{url:"ftp://host",port:8810}` | `{}` | TCP descriptor, no throw |

The two blank-host rows are the regression pin for the empty-host tightening described in §1 and in the release Changeset (§9.5): after trimming, an absent environment host falls through to the parsed file host when present, and otherwise resolves to the literal `127.0.0.1` with `hostSource: "default"` rather than the wildcard address.

### 8.4 Strict runtime parser — `src/shared/piWebUiStatusParsing.test.ts`

Response fixture shape: `{packageName, generatedAt, components:{web, sessiond}, capabilities:[]}`.

| Test | Fixture | Assertion |
| --- | --- | --- |
| parses both descriptor forms for `sessiond` | sessiond `sessiondListener` = `{kind:"tcp",host:"0.0.0.0",port:8810,hostSource:"config",portSource:"config"}` and a second response with `{kind:"socket"}` | parsed values deep-equal the inputs; `Object.isFrozen(tcpDescriptor)` is `true` |
| drops a legacy omission | sessiond without `sessiondListener` | `parsePiWebUiRuntimeResponse(...).components.sessiond.sessiondListener` is `undefined`; `activeAgentProfile` parsing is unaffected |
| rejects malformed descriptors | extra key `{...tcp, tls:true}`; `hostSource:"future"`; `portSource:"default"`; `kind:"future"`; `host:""`; `port:0`; `port:65536` | whole `parsePiWebUiRuntimeResponse` returns `undefined` |
| rejects web ownership | descriptor on `components.web` | whole `parsePiWebUiRuntimeResponse` returns `undefined` |

### 8.5 Client parsers — `src/client/src/api/parsers.test.ts`

| Test | Fixture | Assertion |
| --- | --- | --- |
| carries `sessiond` and defaults `sessiondUrl` | `parsePiWebUiConfigResponse` body with `config.sessiond`/`effectiveConfig.sessiond` and `envOverrides` without `sessiondUrl` | both subtrees preserved; `envOverrides.sessiondUrl === false` |
| trims `sessiond` strings and omits blank ones | `config.sessiond = {host:"  0.0.0.0  ", url:"   ", port:8810}` | parsed subtree deep-equals `{host:"0.0.0.0",port:8810}`; the blank `url` is omitted rather than throwing |
| keeps an all-blank `sessiond` object as `{}` | `config.sessiond = {host:"", url:"   "}` | parsed subtree deep-equals `{}` (not `undefined`, no throw) |
| rejects malformed `sessiond` values | `sessiond: []`, `{host:1}`, `{port:0}`, `{tls:true}` | `parsePiWebUiConfigResponse` throws |
| carries `sessiondListener` in runtime responses | `parsePiWebUiRuntimeResponse` with both tcp and socket forms | values preserved |
| rejects malformed or web-owned `sessiondListener` | tcp descriptor with unknown key; descriptor on web component | `parsePiWebUiRuntimeResponse` throws |
| machine runtime snapshots retain the descriptor | `parseMachineRuntime` with `components.sessiond.sessiondListener` | `parsed.components?.sessiond.sessiondListener` deep-equals the input |

### 8.6 Listen options mapper — `src/sessiond/listenerConfig.test.ts`

Same pure harness as §8.3: no file I/O, direct `sessiondListenOptions(listener, socketPath)` calls with a resolved descriptor and an explicit socket-path argument.

| Test | Listener | `socketPath` argument | Expected |
| --- | --- | --- | --- |
| maps a TCP listener to `{ port, host }` and ignores the socket path | `{kind:"tcp",host:"0.0.0.0",port:8810,hostSource:"config",portSource:"config"}` | `"/tmp/unused-a.sock"` then `"/tmp/unused-b.sock"` | both calls return a value deep-equal to `{port:8810,host:"0.0.0.0"}`; neither result carries a `path` key |
| maps the socket listener to `{ path }` from the argument | `{kind:"socket"}` | `"/run/user/1000/pi-webui/sessiond.sock"` | result deep-equals `{path:"/run/user/1000/pi-webui/sessiond.sock"}` with no other key |

### 8.7 Coherence warning and activation state — `src/client/src/components/settings/settingsSessiondConfig.test.ts`

Coherence fixtures and assertions (call `coherenceWarning(fileSessiond, sessiondUrlOverridden, listener)`):

| File `sessiond` | `sessiondUrlOverridden` | Listener | Expected |
| --- | --- | --- | --- |
| `{port:8810}` | `false` | `undefined` | `"missing-dial-target"` (bind half shown before the report arrives) |
| `{port:8810}` | `true` | `undefined` | `undefined` (`url` half suppressed once the override is known) |
| `{url:"http://127.0.0.1:8810"}` | `false` | `undefined` | `"missing-bind-port"` (older daemon; loopback of the transient false positive) |
| `{url:"..."}` | `false` | `{kind:"tcp",hostSource:"config",portSource:"env",...}` | `undefined` |
| `{url:"..."}` | `false` | `{kind:"tcp",hostSource:"env",portSource:"config",...}` | `"missing-bind-port"` (host override never suppresses) |
| `{url:"..."}` | `false` | `{kind:"tcp",hostSource:"env",portSource:"config",...}` first, then the portSource-`env` descriptor | warning, then suppressed (load-order case) |
| `{url:"..."}` | `false` | `{kind:"socket"}` | `"missing-bind-port"` |
| `{port:8810,url:"..."}` | either | any | `undefined` |
| `undefined` / nothing | `true` | any | `undefined` (env-only deployment never warns) |
| `{port:8810}` | `false` | `{kind:"tcp",...portSource:"config"}` | `"missing-dial-target"` (only an env URL suppresses) |

Activation fixtures (call `activationState(fileSessiond, listener)`), with the crossed cases stated explicitly:

| # | File `sessiond` | Listener | Expected |
| --- | --- | --- | --- |
| 1 | `{host:"0.0.0.0",port:8810}` | `{kind:"tcp",host:"0.0.0.0",port:8810,hostSource:"env",portSource:"env"}` | `"active"` |
| 2 | `{host:"0.0.0.0",port:8810}` | `{kind:"tcp",host:"127.0.0.1",port:8810,hostSource:"env",portSource:"config"}` | `"overridden"` |
| 3 | `{host:"0.0.0.0",port:8810}` | `{kind:"tcp",host:"0.0.0.0",port:9000,hostSource:"config",portSource:"env"}` | `"overridden"` |
| 4 | `{host:"0.0.0.0",port:8810}` | both differ; only `portSource:"env"` (or only `hostSource:"env"`) | `"overridden"` |
| 5 | `{host:"0.0.0.0",port:8810}` | `{kind:"tcp",host:"127.0.0.1",port:9000,hostSource:"config",portSource:"config"}` | `"restart-required"` |
| 6 | `{host:"0.0.0.0",port:8810}` | `{kind:"socket"}` | `"restart-required"` |
| 7 | `{}` (no port) | `{kind:"socket"}` | `"active"` |
| 8 | `{}` | `{kind:"tcp",host:"127.0.0.1",port:8810,hostSource:"default",portSource:"env"}` | `"overridden"` |
| 9 | `{}` | `{kind:"tcp",host:"0.0.0.0",port:8810,hostSource:"env",portSource:"config"}` | `"restart-required"` (cross-kind ignores host influence) |
| 10 | `{port:8810}` | `{kind:"tcp",host:"127.0.0.1",port:8810,hostSource:"default",portSource:"config"}` | `"active"` — desired host defaults to `127.0.0.1` |
| 11 | any | `undefined` | `"unavailable"` |
| 12 | crossed same-kind: `{host:"0.0.0.0",port:8810}` | `{host:"127.0.0.1",port:8810,hostSource:"default",portSource:"env"}` | `"restart-required"` — host differs but `hostSource` is not `env`; the env-sourced value (`port`) does not differ |
| 13 | crossed same-kind: `{host:"0.0.0.0",port:8810}` | `{host:"0.0.0.0",port:9000,hostSource:"env",portSource:"config"}` | `"restart-required"` — port differs but `portSource` is not `env`; the env-sourced value (`host`) does not differ |
| 14 | `{}` (file port removed, so desired is the socket) | `{kind:"tcp",host:"127.0.0.1",port:8810,hostSource:"env",portSource:"config"}` | `"restart-required"` (desired socket vs actual TCP with `portSource:"config"`), never `"overridden"` |

Patch-builder assertion (replaces the unmeasurable "read-only block stays out of save drafts" panel claim; the concrete builders are asserted here instead): in the same suite, `spawnSessionsConfigPatch(false)` deep-equals `{ spawnSessions: false }`, `subsessionsConfigPatch(true)` deep-equals `{ subsessions: true }`, and `agentProfileConfigPatchFromDraft({ command: "pi", dir: "/srv/pi" })` deep-equals `{ agent: { command: "pi", dir: "/srv/pi" } }`; none of the three outputs carries a `sessiond` or `sessiondListener` key.

### 8.8 Read projection and routes — `src/server/configRoutes.test.ts`

| Test | Fixture | Assertion |
| --- | --- | --- |
| selected-machine read carries `sessiond` | `savedConfig = fullConfig()` extended with `sessiond:{host:"0.0.0.0",port:8810,url:"http://127.0.0.1:8810"}`; `GET /api/machines/local/config` | response `config` and `effectiveConfig` contain `sessiond` and still contain exactly the selected-machine keys (no `host`/`port`/`shortcuts`/`tts`) |
| response-body parser preserves `sessiond` | direct `parsePiWebUiConfigResponseBody({path,exists,config:{sessiond:{...}},effectiveConfig:{sessiond:{...}},envOverrides:{...}})` | `config.sessiond` and `effectiveConfig.sessiond` survive; malformed nested shapes throw §7 #13 |
| selected-machine write rejects `sessiond` | `PUT /api/machines/local/config` body `{config:{sessiond:{host:"0.0.0.0"}}}` | 400 with `PI WEBUI selected-machine config key is not allowed: sessiond`; `service.update` not called; and `parseSelectedMachineConfigRequest({sessiond:{...}})` throws the same |
| negative write-path test (mandatory) | seed a temp file with `{"spawnSessions":false}` (no `sessiond`) through `createFilePiWebUiConfigService({env:{PI_WEBUI_CONFIG: configPath, PI_WEBUI_DATA_DIR: dataDir}})` + `registerConfigRoutes`; send `PUT /api/config` body `{config:{sessiond:{host:"0.0.0.0"}, spawnSessions:true}}` | 200; read the persisted file with `JSON.parse(readFile(configPath))`; assert `!("sessiond" in persisted)`; assert `loadPiWebUiConfig` shows no `sessiond` |
| env override projection is trim-aware | `piWebUiConfigResponseFromSnapshot({loaded: loadPiWebUiConfig(opts), speechInputRevision: ""}, {env:{PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL:"   "}})` then the same call with `"http://127.0.0.1:8810"` | first `envOverrides.sessiondUrl === false`; second `true`; the differing host/port flags keep their existing `isEnvSet` semantics |
| older remote response defaults `sessiondUrl` | `parsePiWebUiConfigResponseBody` with `envOverrides` lacking `sessiondUrl` and `sessiond` | parses; `envOverrides.sessiondUrl === false` (satisfiable because §5.1 adds `optionalResponseBoolean(record, "sessiondUrl", source) ?? false` to `parsePiWebUiConfigEnvOverridesResponse`) |
| remote proxy round-trip preserves `sessiond` and `sessiondUrl` | new `src/server/machines/machineProxyRoutes.test.ts`: `Fastify({ logger: false })` with `fastifyWebsocket` registered, `registerMachineProxyRoutes(app, machines)` where `machines.remoteClient` is stubbed to return a fake `MachineClient` whose `requestJson("GET", "/api/machines/local/config")` resolves `{ statusCode: 200, headers: {}, body }` and `body` carries `config.sessiond`/`effectiveConfig.sessiond` plus `envOverrides.sessiondUrl: true`; inject `GET /api/machines/remote-a/config` | 200; response `config.sessiond` and `effectiveConfig.sessiond` deep-equal the upstream subtree; `envOverrides.sessiondUrl === true`; no non-selected keys (`host`/`port`/`shortcuts`/`tts`) leak. This drives `proxySelectedMachineConfigRequest`/`sendSelectedMachineConfigResponse` and fails before the §5.1 env-override member (the flag would be dropped) and before the §5.2 display projection (the subtree would be dropped) |

### 8.9 Remote propagation — `src/server/machines/machineService.test.ts`, `src/client/src/components/settings/settingsSessiondConfig.test.ts`

| Test | Fixture | Assertion |
| --- | --- | --- |
| remote runtime reaches the browser shape | `MachineService.runtime("remote")` with fake `requestJson` returning a runtime body whose sessiond component carries `sessiondListener` | `runtime.components.sessiond.sessiondListener` deep-equals the input |
| merge carries `sessiond` and `sessiondUrl` | `mergeSelectedMachineSessiondConfig(gateway, selectedMachine)` where `selectedMachine` has a different `sessiond` subtree and `sessiondUrl:true` | merged `config`/`effectiveConfig` carry the selected machine's subtree; merged `envOverrides.sessiondUrl === true`; gateway-only keys survive |

The existing full-object `mergeSelectedMachineSessiondConfig(gateway, selectedMachine)` `toEqual` expectation in `settingsSessiondConfig.test.ts` must be updated in the same change to include `envOverrides.sessiondUrl: false`: §6.4 adds that member to every merge result, and the existing fixture's `selectedMachine.envOverrides` omits `sessiondUrl`, so the `?? false` default applies and the literal would otherwise fail.

The first row, combined with §8.11's binding assertion, is the design's "a remote `sessiondListener` reaches the panel" chain: `MachineService.runtime` preserves the descriptor for a remote machine, and the dialog passes `machineRuntime.components.sessiond.sessiondListener` into the panel property.

### 8.10 Panel — `src/client/src/components/settings/SettingsSessiondPanel.test.ts`

The file gains `// @vitest-environment jsdom` and a mount helper (append the element to `document.body`, set properties, `await element.updateComplete`, query `shadowRoot`; `document.body.replaceChildren()` after each test). Assertions are rendered text and badge presence, not `TemplateResult` internals. The existing comment block at the top of the same file (`SettingsSessiondPanel.test.ts:5-12`) states that static labels and layout are intentionally not asserted because there is no DOM harness; because this change adds jsdom and rendered-label assertions to that file, that comment must be updated or removed in the same change.

| Test | Fixture | Assertion |
| --- | --- | --- |
| renders the read-only listener rows | `configResponse` with `config.sessiond = {host:"0.0.0.0",port:8810,url:"http://127.0.0.1:8810"}`, `effectiveConfig.sessiond` same, `sessiondListener = {kind:"tcp",host:"0.0.0.0",port:8810,hostSource:"config",portSource:"config"}` | shadow text contains `0.0.0.0`, `http://127.0.0.1:8810`, and `✓ daemon in sync`; the `Running bind port` row value (the `<dd>` under the `<dt>` whose text is `Running bind port`) is exactly `8810`, so that assertion cannot be satisfied by the URL substring |
| renders each verdict | listener variants for overridden (host differs + `hostSource:"env"`), restart-required (no env), and `undefined` | text contains the pinned `overridden`/`restart-required` strings; `undefined` shows muted `Unavailable` only in the running-listener rows and no verdict glyph or verdict text in the `Listener status` row |
| renders source badges per value | env-sourced host, env-sourced port, `envOverrides.sessiondUrl:true` | each corresponding row contains `environment override`; config-sourced rows do not |
| renders and suppresses the coherence warning | config `{sessiond:{port:8810}}`, `envOverrides.sessiondUrl:false`, listener `undefined` → then `envOverrides.sessiondUrl:true` | first render contains the `missing-dial-target` message; second does not |
| suppresses the bind half once the daemon reports an env port | config `{sessiond:{url:"http://127.0.0.1:8810"}}`, `envOverrides.sessiondUrl:false`, listener `undefined` → then listener `{kind:"tcp",host:"127.0.0.1",port:8810,hostSource:"config",portSource:"env"}` | first render contains the `missing-bind-port` message; second does not |
| listener block has no inputs | render with listener present | `shadowRoot.querySelectorAll(".listener-card input, .listener-card button")` is empty; patch-builder sessiond-freedom is asserted separately in §8.7 |

### 8.11 SettingsDialog binding — `src/client/src/components/SettingsDialog.sessiond.test.ts`

Add one test: set `machineRuntime` to a runtime whose sessiond component carries a `sessiondListener`, call `renderActiveSection` via a local inline sync helper — `Reflect.get(dialog, "renderActiveSection")`, callable check, then `Reflect.apply(method, dialog, [])` — mirroring the existing helper at `src/client/src/components/SettingsDialog.general.test.ts` (`SettingsDialog.testSupport.ts` exports `getDialogProperty`, `setDialogProperty`, `callDialogPromise`, and `callDialogUpdated` — those four method helpers; it has no synchronous private-method caller there), and assert the returned `settings-sessiond-panel` template binding `.sessiondListener` deep-equals that descriptor. No logic-change test is required beyond this.

---

## 9. Documentation and release

### 9.1 `docs/config.md`

1. **Configuration matrix, config-file keys block.** Insert three rows after the `Tracked subsessions` row and before `Model tier routing ladder`:

   | Config | JSON key | Env var | Scope | Project-local behavior | Applies / restart |
   | --- | --- | --- | --- | --- | --- |
   | Session daemon bind host | `sessiond.host` | `PI_WEBUI_SESSIOND_HOST` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
   | Session daemon bind port | `sessiond.port` | `PI_WEBUI_SESSIOND_PORT` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
   | Web/API to session daemon URL | `sessiond.url` | `PI_WEBUI_SESSIOND_URL` | Global/web/API | Not supported locally | Restart web/API |

2. **Runtime-only environment variables block.** Delete the `Session daemon TCP port`, `Session daemon TCP host`, and `Web-to-daemon URL` rows. Keep the `Session daemon socket` row unchanged.

3. **Key details.** Add a `### Session daemon listener` section immediately after the `### Pi-compatible agent profile and companion CLI` section. It must cover: the `sessiond` JSON shape with an example (`0.0.0.0:8810` bind plus `http://127.0.0.1:8810` dial); per-process ownership (`sessiond.host`/`sessiond.port` by the daemon, `sessiond.url` by the web/API); environment precedence and empty-as-absent for all three; the unix-socket default when no port is present; the coherence rule (exactly one of `port`/`url` present is a warning); the restart requirement for both processes; and the empty-host tightening (configured `""`/whitespace binds `127.0.0.1`, not the wildcard; set `0.0.0.0` explicitly for a wildcard bind). State plainly that a non-loopback bind needs a firewall, VPN, or authenticated reverse proxy, matching the existing `docs/install.html` callout.

4. **Port selection note.** In the same section, document `8810` as a safe `sessiond.port` choice and explain that `vite.config.ts` reserves `8809` with `strictPort: true` for the dev client, so a machine running the dev client cannot use `8809` for the daemon.

### 9.2 `docs/config.html`

Mirror §9.1 by hand in the same change: move the same three `<tr>` rows from the `Runtime-only environment variables` table into the config-file table (JSON-key cell becomes `sessiond.port` / `sessiond.host` / `sessiond.url`; scope and restart cells as above), keep the socket row, and add the equivalent `Session daemon listener` subsection with the same claims. The two files must not diverge on user-visible claims.

### 9.3 `docs/install.html`

Add config-file listener guidance to the `Remote access` section: show the `sessiond` JSON block (bind `0.0.0.0:8810`, dial `http://127.0.0.1:8810`), state that the session daemon and web/API must both be restarted, and repeat the port-selection note (`8810`; `8809` is taken by the dev client). Do not remove the existing SSH-tunnel example or the `0.0.0.0` exposure callout.

### 9.4 `README.md`

No change. It stays a landing page and links to `docs/config.md`.

### 9.5 Changeset

Create `.changeset/sessiond-listener-config.md` with package name `@hyperdreamer/pi-webui` from `package.json` and patch type `minor`:

```md
---
"@hyperdreamer/pi-webui": minor
---

Add a `sessiond` config-file section for the session daemon listener. `sessiond.host` and `sessiond.port` configure the daemon bind address and `sessiond.url` configures the web/API dial target; `PI_WEBUI_SESSIOND_HOST`, `PI_WEBUI_SESSIOND_PORT`, and `PI_WEBUI_SESSIOND_URL` still take precedence, and an absent port still means the unix socket. Settings shows the effective listener and whether the running daemon matches it.

Behavior change: an empty or whitespace-only session daemon host now means "absent" and binds `127.0.0.1` instead of the wildcard address. Set `sessiond.host` (or `PI_WEBUI_SESSIOND_HOST`) to `0.0.0.0` explicitly for a wildcard bind.
```

The empty-host tightening is stated explicitly as required by the design. `CHANGELOG.md` is not edited.

### 9.6 Release handoff

The release handoff records: the empty-host tightening; that a syntactically invalid `sessiond.url` fails only the web/API, while a wrong-typed `sessiond` value fails every config-loading process; and that the `sessiondListener` runtime field is additive.

### 9.7 Deployment note

Both processes resolve transport at startup and this change touches a **session-daemon-only code path** (`src/server/sessiond.ts` and the new `src/sessiond/listenerConfig.ts`). Deployment therefore requires a **manual restart of `pi-webui-sessiond.service`** (for example `systemctl --user restart pi-webui-sessiond.service`) plus a web/API restart, as required by `AGENTS.md`. Until both restart, the daemon reports no `sessiondListener` (verdict `unavailable`) and a changed `sessiond.url` is not observed.

---

## 10. Verification

Run the narrowest checks first, then the design's full list:

1. Focused Vitest on each changed/created test file (`npm test -- --run <file>`).
2. `npm run typecheck`.
3. `npx eslint <changed files>` (the new `src/sessiond/listenerConfig.ts` included).
4. `git diff --check`.
5. `npm run verify` before merge/release.
6. Confirm every new feature test fails before the corresponding implementation exists (red phase), especially the crossed-provenance activation cases. Guard and negative tests are exempt, without weakening the requirement for feature tests: the mandatory negative write-path test passes on the pre-change tree by design (a `PUT /api/config` body containing `sessiond` is already ignored and the persisted file already preserves the subtree), so it is a regression guard, as the design's risk table describes.

---

## 11. Risks an implementer could still get wrong

1. **Adding `delete existing["sessiond"]` to `savePiWebUiConfig`.** This is the exact defect the design review caught; it erases operator listener configuration on any unrelated save.
2. **Wiring the read parser into `parseConfigRequest` or `SELECTED_MACHINE_CONFIG_KEYS`.** That would make sessiond transport browser-writable. The mandatory negative test is the guard.
3. **Re-reading `PI_WEBUI_SESSIOND_HOST`/`_PORT` inside `listen()` or resolving the listener twice.** The descriptor and `app.listen` must come from one resolution.
4. **Applying URL-form validation in the shared parser or in `sessiondListenerConfig`.** That stops the daemon for a web/API-only mistake.
5. **Forgetting the trim-aware `sessiondUrl` test** and reusing `isEnvSet`, which lets a whitespace env value suppress a real warning.
6. **Using `effectiveConfig.sessiond` for the activation desired side.** The desired side is the file subtree (`config.config.sessiond`); the effective subtree is only for the displayed dial target.
7. **Applying a global `hostSource || portSource === "env"` influence predicate.** Influence is per differing value; the crossed cases must return `restart-required`.
8. **Suppressing the bind half before a listener report arrives.** Absent evidence must not claim resolution.
9. **Passing `effectiveConfig` (with an env-layered `sessiond.url`) into `savePiWebUiConfig`.** No production path does this today; keep it that way so an environment URL is never persisted into the file.
10. **Forgetting `src/client/src/api.ts`.** The panel and helpers import from `../../api`; the new type names must be re-exported there.
11. **Panel copy drift.** The verdict strings are design-pinned; the row labels, badge text, and coherence messages are pinned here because the design left layout/copy open.
12. **Inherited effective-config validation.** `sessiondHttpUrl` delegates to `resolveEffectivePiWebUiConfig`, which also resolves agent config (`effectiveAgentConfig`). A pre-existing agent-config error can therefore surface during `SessionDaemonClient` construction (web/API startup). This matches the design's choice to keep one resolution path, but the implementer must expect it rather than treating it as a new sessiond-specific failure.

---

## 12. Resolved design issue G1

### G1 — `sessiondListenOptions` could not be a pure one-argument mapper over a path-free socket descriptor (resolved)

- **Previous design text (verbatim):** "Both listener helpers live in a new **importable pure module**, `src/sessiond/listenerConfig.ts`: `sessiondListenerConfig(subtree, env)` resolves the listener with provenance, and `sessiondListenOptions(listener)` maps it to Fastify listen options (`{ port, host }` or `{ path }`)." and "maps a resolved TCP listener to `{ port, host }` and a socket listener to `{ path }`. This replaces an assertion about observing `app.listen` itself, which has no seam ... The mapper test is only writable because the helper was moved out of that module."
- **Source evidence:** The descriptor type mandated by the design (`src/shared/apiTypes.ts`, new `PiWebUiSessiondListenerDescriptor`) is `{ kind: "tcp"; host; port; hostSource; portSource } | { kind: "socket" }` and the socket branch "deliberately carries **no `path`**". The only source of the socket path in the daemon is `sessiondSocketPath()` in `src/sessiond/config.ts`, which reads `process.env["PI_WEBUI_SESSIOND_SOCKET"]` and `piWebUiDataDir()` (`src/config.ts`), so it is impure. A one-argument function over the descriptor cannot produce the real socket path, and calling `sessiondSocketPath()` inside the mapper contradicts the design's own "pure" requirement (the stated reason the helper was moved out of `src/server/sessiond.ts`).
- **Resolution (design review history, 2026-10-05):** the mapper takes the socket path as an explicit second argument: `sessiondListenOptions(listener, socketPath)`. The TCP branch returns `{ port, host }` and ignores the argument; the socket branch returns `{ path: socketPath }`. The mapper stays pure and the wire descriptor stays path-free; the caller (the daemon's `listen()` step) supplies `sessiondSocketPath()` on the socket branch — the only branch that resolves it, exactly as today — so no new resolution work is introduced and the TCP branch is never asked to resolve a path. §4.2 specifies the contract, §4.3 the startup wiring, and §8.6 its test.
