# Session Daemon Listener Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sessiond` config-file section (`host`, `port`, `url`) so the session daemon bind address and the web/API dial target are described by one validated artifact, reported with per-value provenance through the runtime protocol, and shown read-only in the Session daemon settings panel with a coherence warning and an activation verdict.

**Architecture:** Shared types and one exact file parser add the `sessiond` subtree to the global config; `resolveEffectivePiWebUiConfig` layers only the web/API-owned `sessiond.url`, while a new pure `src/sessiond/listenerConfig.ts` resolves the daemon listener with provenance from `(file subtree, environment)` and maps it to Fastify listen options. The same resolved descriptor feeds `app.listen`, the frozen runtime component, a strict shared runtime parser, the read-only config projection, and two pure client helpers that drive the read-only panel block.

**Tech Stack:** TypeScript (ES2022), Node 22, Fastify, Lit, Vitest, Pi coding-agent SDK repository conventions.

## Global Constraints

- Node.js 22.19.0 or newer; no new runtime dependencies.
- Exact shared type names and shapes: `PiWebUiSessiondConfig { host?: string; port?: number; url?: string }`; `sessiond?: PiWebUiSessiondConfig` on `PiWebUiConfigValues`; `sessiondUrl?: boolean` on `PiWebUiConfigEnvOverrides`; `PiWebUiSessiondListenerSource = "env" | "config" | "default"`; `PiWebUiSessiondPortSource = "env" | "config"`; `PiWebUiSessiondListenerDescriptor = { kind: "tcp"; host: string; port: number; hostSource: PiWebUiSessiondListenerSource; portSource: PiWebUiSessiondPortSource } | { kind: "socket" }`; `sessiondListener?: PiWebUiSessiondListenerDescriptor` on `PiWebUiRuntimeComponent`. The socket branch carries no `path`; no capability flag is added.
- Exact config error messages, all ending in `: ${path}` for a config path or `: ${source}` for a response label: `PI WEBUI config sessiond must be an object`; `PI WEBUI config sessiond contains unknown key "<key>"`; `PI WEBUI config sessiond.host must be a string`; `PI WEBUI config sessiond.url must be a string`; `PI WEBUI config sessiond.port must be an integer from 1 to 65535`; `PI WEBUI config PI_WEBUI_SESSIOND_PORT must be an integer from 1 to 65535: environment`; `PI WEBUI config sessiond.url must be an absolute http or https URL`; `PI WEBUI config sessiond.url must not contain credentials`; `PI WEBUI config sessiond.url must not contain a query string`; `PI WEBUI config sessiond.url must not contain a fragment`; `PI WEBUI config sessiond.url must not contain a path`; `PI WEBUI selected-machine config key is not allowed: sessiond`.
- Exact panel copy: `active` → `✓ daemon in sync`; `overridden` → `⚠ one or more listener values come from the environment, so the config file cannot take full effect until the environment changes`; `restart-required` → `⚠ restart required`; `unavailable` → no verdict text and no verdict glyph in the `Listener status` row. Coherence messages are exactly `sessiond.port is configured, but no sessiond.url is set and PI_WEBUI_SESSIOND_URL is not set on that machine, so the web/API will dial the session daemon socket while the daemon listens on TCP. Add sessiond.url or remove sessiond.port.` and `sessiond.url is configured, but no sessiond.port is set and PI_WEBUI_SESSIOND_PORT is not set on that machine, so the daemon will listen on the session daemon socket. Add sessiond.port or remove sessiond.url.`
- The loopback default is the literal `127.0.0.1`, never `localhost`. A session daemon port has no default: `DEFAULT_PORT = 8808` stays web/API-only, and an absent port means the unix socket.
- An empty or whitespace-only `sessiond.host` (or `PI_WEBUI_SESSIOND_HOST`) means absent and binds `127.0.0.1` instead of the wildcard address; an empty or whitespace-only `sessiond.url` (or `PI_WEBUI_SESSIOND_URL`) means absent; an empty or whitespace-only `PI_WEBUI_SESSIOND_PORT` means absent so a file port still applies. A blank or non-port `sessiond.port` in the config file is a parse error, never a silent socket fallback.
- Environment variables remain authoritative over the file for all three keys, but only `sessiond.url` is layered into the web/API effective config; `sessiond.host` and `sessiond.port` are never read from the web/API environment.
- `sessiond` is never reachable from a browser write path: `parseConfigRequest` stays unchanged and sessiond-free, `SELECTED_MACHINE_CONFIG_KEYS` excludes `sessiond`, and `savePiWebUiConfig` must not add `delete existing["sessiond"]`. The read projection that exposes `sessiond` is display-only.
- Binding non-goals stay binding: no GUI-writable listener settings, no URL derivation from host, no default daemon TCP port, no `sessiond.socket` config key (`PI_WEBUI_SESSIOND_SOCKET` stays env-only), no reverse-proxy path prefixes in `sessiond.url`, no live reconfiguration.
- The daemon resolves its listener exactly once and the same descriptor feeds both `runtimeComponent.sessiondListener` and `app.listen`; `sessiondListener` appears only on a `component === "sessiond"` payload; the session daemon never applies URL-form validation, so an invalid `sessiond.url` fails only the web/API.
- The inactivity-of-evidence rule is binding: the bind-half coherence warning is shown while no listener report exists and is suppressed only by daemon-reported `portSource === "env"`; `hostSource === "env"` never suppresses a half. Activation influence is scoped per differing value, so the crossed-provenance cases are `restart-required`.
- `README.md` is not edited. `docs/config.md` and `docs/config.html` must make identical user-visible claims; `docs/install.html` gains config-file listener guidance.
- Exactly one minor Changeset at `.changeset/sessiond-listener-config.md` for `@hyperdreamer/pi-webui`; do not edit `CHANGELOG.md`, do not bump versions, and do not run `npm publish` locally.
- Per `AGENTS.md`, `src/server/sessiond.ts` is a session-daemon-only path: deployment requires a manual `pi-webui-sessiond.service` restart plus a web/API restart, and the release handoff must state this.
- Run commands from the repository root. Per-change checks are `npm test -- --run <test-file>`, `npm run typecheck`, and `npx eslint <changed-file>`; cross-cutting completion is `npm run verify`.
- Every new exported symbol must be consumed by production code in this change; no Knip ignores.

## Task 1: Shared sessiond types and config-file parser

**Lane:** config-core

**Implementer tier:** Standard

**Files:**

- Modify: `src/shared/apiTypes.ts:455-477` (add `PiWebUiSessiondConfig`; add `sessiond` to `PiWebUiConfigValues`)
- Modify: `src/shared/apiTypes.ts:691-701` (add `sessiondUrl?` to `PiWebUiConfigEnvOverrides`)
- Modify: `src/shared/apiTypes.ts:1568-1580` (add listener descriptor types; add `sessiondListener?` to `PiWebUiRuntimeComponent`)
- Modify: `src/config.ts:7` (import `PiWebUiSessiondConfig`)
- Modify: `src/config.ts:422-440` (`piWebUiConfigRecord` gains the `sessiond` entry)
- Modify: `src/config.ts:442-487` (`parsePiWebUiConfig` gains the `sessiond` spread; add `SESSIOND_CONFIG_KEYS` and `parsePiWebUiSessiondConfig` after it)
- Modify: `src/config.ts:863-866` (export `parsePort`)
- Test: `src/config.test.ts:950` (append the new describe block at the end)

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: `PiWebUiSessiondConfig { host?: string; port?: number; url?: string }`; `PiWebUiConfigValues.sessiond?: PiWebUiSessiondConfig`; `PiWebUiConfigEnvOverrides.sessiondUrl?: boolean`; `PiWebUiSessiondListenerSource = "env" | "config" | "default"`; `PiWebUiSessiondPortSource = "env" | "config"`; `PiWebUiSessiondListenerDescriptor = { kind: "tcp"; host: string; port: number; hostSource: PiWebUiSessiondListenerSource; portSource: PiWebUiSessiondPortSource } | { kind: "socket" }`; `PiWebUiRuntimeComponent.sessiondListener?: PiWebUiSessiondListenerDescriptor`; `parsePiWebUiSessiondConfig(value: unknown, path: string): PiWebUiSessiondConfig`; `parsePort(value: unknown, key: string, path = "environment"): number` exported.

- [ ] **Step 1: Write the failing tests**

Append this block at the end of `src/config.test.ts`:

```ts
describe("PI WEBUI sessiond config", () => {
  it("accepts and normalizes the sessiond subtree", async () => {
    await writeFile(configPath, `${JSON.stringify({ sessiond: { host: "  0.0.0.0  ", port: "8810", url: "  http://127.0.0.1:8810  " } }, null, 2)}\n`, "utf8");

    expect(loadPiWebUiConfig(testOptions()).config.sessiond).toEqual({ host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" });
  });

  it("omits empty-after-trim sessiond strings", async () => {
    await writeFile(configPath, `${JSON.stringify({ sessiond: { host: "   ", url: "", port: 8810 } }, null, 2)}\n`, "utf8");
    const parsed = loadPiWebUiConfig(testOptions()).config.sessiond;

    await writeFile(configPath, `${JSON.stringify({ sessiond: { port: 8810 } }, null, 2)}\n`, "utf8");

    expect(parsed).toEqual({ port: 8810 });
    expect(parsed).toEqual(loadPiWebUiConfig(testOptions()).config.sessiond);
  });

  it("rejects malformed sessiond shapes with the pinned messages", async () => {
    const cases: readonly { value: unknown; message: string }[] = [
      { value: [], message: "PI WEBUI config sessiond must be an object" },
      { value: "x", message: "PI WEBUI config sessiond must be an object" },
      { value: { host: 1 }, message: "PI WEBUI config sessiond.host must be a string" },
      { value: { url: 1 }, message: "PI WEBUI config sessiond.url must be a string" },
      { value: { port: "abc" }, message: "PI WEBUI config sessiond.port must be an integer from 1 to 65535" },
      { value: { port: "" }, message: "PI WEBUI config sessiond.port must be an integer from 1 to 65535" },
      { value: { port: "   " }, message: "PI WEBUI config sessiond.port must be an integer from 1 to 65535" },
      { value: { port: 0 }, message: "PI WEBUI config sessiond.port must be an integer from 1 to 65535" },
      { value: { port: 65536 }, message: "PI WEBUI config sessiond.port must be an integer from 1 to 65535" },
      { value: { port: 8810.5 }, message: "PI WEBUI config sessiond.port must be an integer from 1 to 65535" },
      { value: { tls: true }, message: 'PI WEBUI config sessiond contains unknown key "tls"' },
    ];
    for (const testCase of cases) {
      await writeFile(configPath, `${JSON.stringify({ sessiond: testCase.value }, null, 2)}\n`, "utf8");
      expect(() => loadPiWebUiConfig(testOptions())).toThrow(`${testCase.message}: ${configPath}`);
    }
  });

  it("does not apply URL-form validation at load time", async () => {
    for (const url of ["127.0.0.1:8810", "ftp://host"]) {
      await writeFile(configPath, `${JSON.stringify({ sessiond: { url } }, null, 2)}\n`, "utf8");
      expect(loadPiWebUiConfig(testOptions()).config.sessiond).toEqual({ url });
    }
  });

  it("round-trips sessiond through savePiWebUiConfig", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    const saved = savePiWebUiConfig({ sessiond }, testOptions());

    expect(saved.config.sessiond).toEqual(sessiond);
    expect(JSON.parse(await readFile(configPath, "utf8")).sessiond).toEqual(sessiond);
  });

  it("preserves sessiond when an unrelated save runs", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    await writeFile(configPath, `${JSON.stringify({ future: true, sessiond }, null, 2)}\n`, "utf8");

    const saved = savePiWebUiConfig({ spawnSessions: true }, testOptions());

    expect(saved.config.sessiond).toEqual(sessiond);
    expect(JSON.parse(await readFile(configPath, "utf8")).sessiond).toEqual(sessiond);
    expect(saved.config.spawnSessions).toBe(true);
  });

  it("keeps an absent sessiond absent", async () => {
    await writeFile(configPath, `${JSON.stringify({ port: 8808 }, null, 2)}\n`, "utf8");

    expect(loadPiWebUiConfig(testOptions()).config.sessiond).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/config.test.ts`
Expected: FAIL, the new `PI WEBUI sessiond config` cases fail because `sessiond` is dropped or not validated (`expect(received).toEqual(expected)` and missing throws).

- [ ] **Step 3: Add the shared types**

In `src/shared/apiTypes.ts`, add this interface immediately above `export interface PiWebUiConfigValues`:

```ts
export interface PiWebUiSessiondConfig {
  host?: string;
  port?: number;
  url?: string;
}
```

Inside `export interface PiWebUiConfigValues`, add this member after the `speechInput` member:

```ts
  /** Session daemon listener configuration; environment variables remain authoritative. */
  sessiond?: PiWebUiSessiondConfig;
```

Inside `export interface PiWebUiConfigEnvOverrides`, add this member after `agentSessionDir: boolean;`:

```ts
  sessiondUrl?: boolean;
```

Immediately above `export interface PiWebUiRuntimeComponent`, add:

```ts
export type PiWebUiSessiondListenerSource = "env" | "config" | "default";
/** A port has no default, so its source is narrower than the host's. */
export type PiWebUiSessiondPortSource = "env" | "config";

export type PiWebUiSessiondListenerDescriptor =
  | { kind: "tcp"; host: string; port: number; hostSource: PiWebUiSessiondListenerSource; portSource: PiWebUiSessiondPortSource }
  | { kind: "socket" };
```

Inside `export interface PiWebUiRuntimeComponent`, add this member after `activeAgentProfile?: ActiveAgentProfileDescriptor;`:

```ts
  /** Present only for a session daemon that supports listener reporting. */
  sessiondListener?: PiWebUiSessiondListenerDescriptor;
```

- [ ] **Step 4: Add the parser, record entry, and exported shared port rule**

In `src/config.ts`, extend the existing `./shared/apiTypes.js` type import with `PiWebUiSessiondConfig`, so the import list contains at least:

```ts
import { MODEL_TIERS, type ModelTier, type ModelTierLadder, type PiWebUiAgentDirEnvSource, type PiWebUiConfigValues, type PiWebUiSessiondConfig, type PiWebUiSpeechInputCloudConfig, type PiWebUiSpeechInputConfig, type SpeechInputProviderPreference, type TierModelRef, type UtilityModelBinding, type UtilityModelSettings } from "./shared/apiTypes.js";
```

Add this entry inside the `piWebUiConfigRecord` return object, after the `speechInput` entry:

```ts
    ...(config.sessiond !== undefined ? { sessiond: config.sessiond } : {}),
```

Add this spread inside the `config: { ... }` object returned by `parsePiWebUiConfig`, after the `speechInput` spread:

```ts
      ...(value["sessiond"] !== undefined ? { sessiond: parsePiWebUiSessiondConfig(value["sessiond"], path) } : {}),
```

Immediately after the closing brace of `parsePiWebUiConfig`, before `function isModelTierConfigKey`, add:

```ts
const SESSIOND_CONFIG_KEYS = new Set(["host", "port", "url"]);

export function parsePiWebUiSessiondConfig(value: unknown, path: string): PiWebUiSessiondConfig {
  if (!isRecord(value)) throw new Error(`PI WEBUI config sessiond must be an object: ${path}`);
  for (const unknownKey of Object.keys(value)) {
    if (!SESSIOND_CONFIG_KEYS.has(unknownKey)) throw new Error(`PI WEBUI config sessiond contains unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  }
  const config: PiWebUiSessiondConfig = {};
  const host = value["host"];
  if (host !== undefined) {
    if (typeof host !== "string") throw new Error(`PI WEBUI config sessiond.host must be a string: ${path}`);
    const trimmed = host.trim();
    if (trimmed !== "") config.host = trimmed;
  }
  const url = value["url"];
  if (url !== undefined) {
    if (typeof url !== "string") throw new Error(`PI WEBUI config sessiond.url must be a string: ${path}`);
    const trimmed = url.trim();
    if (trimmed !== "") config.url = trimmed;
  }
  const port = value["port"];
  if (port !== undefined) config.port = parsePort(port, "sessiond.port", path);
  return config;
}
```

Change `function parsePort(value: unknown, key: string, path = "environment"): number {` to `export function parsePort(value: unknown, key: string, path = "environment"): number {`. The body is unchanged.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test -- --run src/config.test.ts`
Expected: PASS, including the pre-existing config persistence cases and the new `PI WEBUI sessiond config` describe block.

- [ ] **Step 6: Commit**

```bash
git add src/shared/apiTypes.ts src/config.ts src/config.test.ts
git commit -m "feat(config): parse and persist the sessiond listener subtree"
```

## Task 2: Effective sessiond.url resolution and trim-aware override flag

**Lane:** config-core

**Implementer tier:** Standard

**Files:**

- Modify: `src/config.ts:177-202` (`resolveEffectivePiWebUiConfig` layers only `sessiond.url`)
- Modify: `src/server/configRoutes.ts:356-374` (`piWebUiConfigEnvOverrides` gains `sessiondUrl`; add `isEnvSetAfterTrim`)
- Test: `src/config.test.ts:950` (append the new describe block at the end)
- Test: `src/server/configRoutes.test.ts:280` (append the new describe block after the `config routes` describe)

**Interfaces:**

- Consumes: `PiWebUiSessiondConfig { host?: string; port?: number; url?: string }` and `PiWebUiConfigValues.sessiond?: PiWebUiSessiondConfig` from Task 1; the existing `resolveEffectivePiWebUiConfig(loaded: LoadedPiWebUiConfig, options: LoadOptions): LoadedEffectivePiWebUiConfig` and `piWebUiConfigEnvOverrides(env: NodeJS.ProcessEnv, config: PiWebUiConfig): PiWebUiConfigEnvOverrides` in the two files this task edits.
- Produces: `resolveEffectivePiWebUiConfig(loaded, options)` layers a non-blank trimmed `options.env.PI_WEBUI_SESSIOND_URL` (defaulting to `process.env`) over `loaded.config.sessiond.url` and adds nothing when the environment value is absent or blank; `piWebUiConfigEnvOverrides(env, config)` returns `sessiondUrl: isEnvSetAfterTrim(env["PI_WEBUI_SESSIOND_URL"])`; module-private `isEnvSetAfterTrim(value: string | undefined): boolean` returns `value !== undefined && value.trim() !== ""`. The existing `isEnvSet` and every other flag keep their current behavior.

- [ ] **Step 1: Write the failing tests**

Append this block at the end of `src/config.test.ts`:

```ts
describe("PI WEBUI sessiond effective config", () => {
  it("layers only the url environment override over the file", async () => {
    await writeFile(configPath, `${JSON.stringify({ sessiond: { host: "0.0.0.0", port: 8810 } }, null, 2)}\n`, "utf8");
    const options = { env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: " http://127.0.0.1:8810 " } };

    expect(effectivePiWebUiConfig(options).config.sessiond).toEqual({ host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" });
  });

  it("treats a blank url environment value as absent", async () => {
    await writeFile(configPath, `${JSON.stringify({ sessiond: { host: "0.0.0.0", port: 8810 } }, null, 2)}\n`, "utf8");
    for (const value of ["   ", ""]) {
      expect(effectivePiWebUiConfig({ env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: value } }).config.sessiond).toEqual({ host: "0.0.0.0", port: 8810 });
    }
  });

  it("does not layer the bind environment into the effective config", async () => {
    await writeFile(configPath, `${JSON.stringify({ sessiond: { host: "0.0.0.0", port: 8810 } }, null, 2)}\n`, "utf8");
    const options = { env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_HOST: "1.2.3.4", PI_WEBUI_SESSIOND_PORT: "9999" } };

    expect(effectivePiWebUiConfig(options).config.sessiond).toEqual({ host: "0.0.0.0", port: 8810 });
  });
});
```

In `src/server/configRoutes.test.ts`, extend the `./configRoutes.js` import with `piWebUiConfigResponseFromSnapshot`, then append this block after the closing `});` of `describe("config routes", ...)` and before the next describe block:

```ts
describe("sessiond environment override projection", () => {
  it("uses a trim-aware sessiondUrl override flag", () => {
    const loaded = { path: "/tmp/pi-webui/config.json", exists: false, config: {} };
    const blank = piWebUiConfigResponseFromSnapshot({ loaded, speechInputRevision: "" }, { env: { PI_WEBUI_SESSIOND_URL: "   " } });
    const set = piWebUiConfigResponseFromSnapshot({ loaded, speechInputRevision: "" }, { env: { PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:8810" } });

    expect(blank.envOverrides.sessiondUrl).toBe(false);
    expect(set.envOverrides.sessiondUrl).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/config.test.ts src/server/configRoutes.test.ts`
Expected: FAIL, `config.test.ts` shows `sessiond.url` not layered and `configRoutes.test.ts` shows `envOverrides.sessiondUrl` `undefined` instead of `false`.

- [ ] **Step 3: Implement the two changes**

In `src/config.ts`, inside `resolveEffectivePiWebUiConfig`, add this constant next to the existing environment reads:

```ts
  const sessiondUrl = env["PI_WEBUI_SESSIOND_URL"]?.trim();
```

and add this spread inside the `config: { ... }` object, immediately after the `agent: { command: agent.command, dir: agent.dir },` line:

```ts
      ...(sessiondUrl !== undefined && sessiondUrl !== "" ? { sessiond: { ...loaded.config.sessiond, url: sessiondUrl } } : {}),
```

In `src/server/configRoutes.ts`, add this member to the object returned by `piWebUiConfigEnvOverrides`, after the `agentSessionDir` entry:

```ts
    sessiondUrl: isEnvSetAfterTrim(env["PI_WEBUI_SESSIOND_URL"]),
```

Immediately below the existing `isEnvSet` helper, add:

```ts
function isEnvSetAfterTrim(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/config.test.ts src/server/configRoutes.test.ts`
Expected: PASS, including the pre-existing effective-config and env-override cases.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/server/configRoutes.ts src/config.test.ts src/server/configRoutes.test.ts
git commit -m "feat(config): resolve sessiond.url and report a trim-aware override"
```

## Task 3: Read/write config projection split

**Lane:** config-core

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/configRoutes.ts:1-14` (import `parsePiWebUiSessiondConfig` and the `PiWebUiSessiondConfig` type)
- Modify: `src/server/configRoutes.ts:170-189` (display projection; response-body parser uses the read-side wrapper)
- Modify: `src/server/configRoutes.ts:234-249` (add `projectSelectedMachineConfigValues` beside `pickSelectedMachineConfig`)
- Modify: `src/server/configRoutes.ts:310-320` (`parsePiWebUiConfigEnvOverridesResponse` gains `sessiondUrl`)
- Test: `src/server/configRoutes.test.ts:1-7` (expand the node:fs and configRoutes imports) and `:282` (insert read-projection tests before the `config routes` describe closes) and `:290` (append a new describe block)
- Test: Create `src/server/machines/machineProxyRoutes.test.ts`

**Interfaces:**

- Consumes: `parsePiWebUiSessiondConfig(value: unknown, path: string): PiWebUiSessiondConfig` and `PiWebUiConfigValues.sessiond?: PiWebUiSessiondConfig` from Task 1; `PiWebUiConfigEnvOverrides.sessiondUrl?: boolean` from Task 1; `isEnvSetAfterTrim`/`piWebUiConfigEnvOverrides` behavior from Task 2.
- Produces: `selectedMachineConfigResponse(response: PiWebUiConfigResponse): PiWebUiConfigResponse` now projects `config` and `effectiveConfig` through `projectSelectedMachineConfigValues`, which returns `{ ...pickSelectedMachineConfig(config), ...(config.sessiond === undefined ? {} : { sessiond: config.sessiond }) }`; `parsePiWebUiConfigResponseBody(value: unknown, source = "PI WEBUI config response"): PiWebUiConfigResponse` preserves `sessiond` in `config`/`effectiveConfig` through module-private `parseReadOnlySessiondConfig(value: unknown, source: string): PiWebUiSessiondConfig` and `parsePiWebUiConfigResponseValues(value: unknown, agentPathHost: AgentPathHost, source: string): PiWebUiConfigValues`; `parsePiWebUiConfigEnvOverridesResponse` returns `sessiondUrl: optionalResponseBoolean(record, "sessiondUrl", source) ?? false`. `parseConfigRequest`, `parseSelectedMachineConfigRequest`, `mergeSelectedMachineConfig`, and `SELECTED_MACHINE_CONFIG_KEYS` are unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/server/configRoutes.test.ts`, change the node:fs import to:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

and add `piWebUiConfigResponseFromSnapshot` to the `./configRoutes.js` import so it contains:

```ts
import { createFilePiWebUiConfigService, parsePiWebUiConfigResponseBody, parseSelectedMachineConfigRequest, piWebUiConfigResponseFromSnapshot, redactSpeechInputConfigResponse, registerConfigRoutes, registerLocalMachineConfigRoutes, type PiWebUiConfigService } from "./configRoutes.js";
```

Immediately before the closing `});` of `describe("config routes", () => {`, after the "rejects invalid local selected-machine config values before writing" test, insert:

```ts
  it("carries the read-only sessiond subtree on selected-machine reads", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    savedConfig = { ...fullConfig(), sessiond };

    const response = await app.inject({ method: "GET", url: "/api/machines/local/config" });

    expect(response.statusCode).toBe(200);
    const body = response.json<PiWebUiConfigResponse>();
    expect(body.config.sessiond).toEqual(sessiond);
    expect(body.effectiveConfig.sessiond).toEqual(sessiond);
    expect(body.config).not.toHaveProperty("host");
    expect(body.config).not.toHaveProperty("port");
    expect(body.config).not.toHaveProperty("shortcuts");
    expect(body.config).not.toHaveProperty("tts");
  });

  it("rejects sessiond on the selected-machine write path", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: { sessiond: { host: "0.0.0.0" } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("PI WEBUI selected-machine config key is not allowed: sessiond");
    expect(service.update).not.toHaveBeenCalled();
    expect(() => parseSelectedMachineConfigRequest({ sessiond: { host: "0.0.0.0" } })).toThrow("PI WEBUI selected-machine config key is not allowed: sessiond");
  });
```

Then insert this complete describe block immediately after the closing `});` of `describe("config routes", ...)` and before `describe("config route speech redaction", ...)`:

```ts
describe("sessiond read projection and write-path closure", () => {
  it("preserves sessiond in federation response bodies and rejects malformed subtrees", () => {
    const sessiond = { host: "0.0.0.0", port: 8810 };
    const body = {
      path: "/tmp/pi-webui/config.json",
      exists: true,
      config: { sessiond },
      effectiveConfig: { sessiond },
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
    };

    const parsed = parsePiWebUiConfigResponseBody(body);

    expect(parsed.config.sessiond).toEqual(sessiond);
    expect(parsed.effectiveConfig.sessiond).toEqual(sessiond);
    expect(parsed.envOverrides.sessiondUrl).toBe(false);
    expect(() => parsePiWebUiConfigResponseBody({ ...body, config: { sessiond: { port: 0 } } }))
      .toThrow("PI WEBUI config sessiond.port must be an integer from 1 to 65535: PI WEBUI config response");
    expect(() => parsePiWebUiConfigResponseBody({ ...body, config: { sessiond: { tls: true } } }))
      .toThrow('PI WEBUI config sessiond contains unknown key "tls": PI WEBUI config response');
  });

  let writePathDir: string;
  let writePathConfigPath: string;
  let writePathDataDir: string;
  let writePathApp: FastifyInstance | undefined;

  beforeEach(() => {
    writePathDir = mkdtempSync(join(tmpdir(), "pi-webui-config-write-path-test-"));
    writePathConfigPath = join(writePathDir, "config.json");
    writePathDataDir = join(writePathDir, "data");
    mkdirSync(writePathDataDir, { recursive: true, mode: 0o700 });
    writeFileSync(writePathConfigPath, `${JSON.stringify({ spawnSessions: false }, null, 2)}\n`, "utf8");
  });

  afterEach(async () => {
    await writePathApp?.close();
    writePathApp = undefined;
    rmSync(writePathDir, { recursive: true, force: true });
  });

  it("ignores sessiond in a generic PUT /api/config body and preserves the file", async () => {
    const env = { PI_WEBUI_CONFIG: writePathConfigPath, PI_WEBUI_DATA_DIR: writePathDataDir };
    writePathApp = Fastify({ logger: false });
    registerConfigRoutes(writePathApp, createFilePiWebUiConfigService({ env }));

    const response = await writePathApp.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { sessiond: { host: "0.0.0.0" }, spawnSessions: true } },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(writePathConfigPath, "utf8"))).not.toHaveProperty("sessiond");
    expect(loadPiWebUiConfig({ env }).config.sessiond).toBeUndefined();
  });
});
```

Create `src/server/machines/machineProxyRoutes.test.ts` with:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebUiConfigResponse } from "../../shared/apiTypes.js";
import type { MachineClient } from "./machineClient.js";
import { registerMachineProxyRoutes } from "./machineProxyRoutes.js";
import { MachineService } from "./machineService.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("machine proxy selected-machine config route", () => {
  it("preserves sessiond and sessiondUrl across a remote config round-trip", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    const upstream: PiWebUiConfigResponse = {
      path: "/home/remote/.config/pi-webui/config.json",
      exists: true,
      config: { host: "127.0.0.1", port: 8808, shortcuts: { "core:view.chat": "mod+1" }, sessiond, agent: { command: "agent-lab", dir: "/srv/agent-lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8808, shortcuts: { "core:view.chat": "mod+1" }, sessiond, agent: { command: "agent-lab", dir: "/srv/agent-lab" } },
      envOverrides: {
        host: false,
        port: false,
        allowedHosts: false,
        spawnSessions: false,
        subsessions: false,
        agentCommand: false,
        agentDir: false,
        agentSessionDir: false,
        sessiondUrl: true,
      },
    };
    const machines = new MachineService();
    vi.spyOn(machines, "remoteClient").mockResolvedValue(fakeClient(upstream));
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerMachineProxyRoutes(app, machines);

    const response = await app.inject({ method: "GET", url: "/api/machines/remote-a/config" });

    expect(response.statusCode).toBe(200);
    const body = response.json<PiWebUiConfigResponse>();
    expect(body.config.sessiond).toEqual(sessiond);
    expect(body.effectiveConfig.sessiond).toEqual(sessiond);
    expect(body.envOverrides.sessiondUrl).toBe(true);
    expect(body.config).not.toHaveProperty("host");
    expect(body.config).not.toHaveProperty("port");
    expect(body.config).not.toHaveProperty("shortcuts");
  });
});

function fakeClient(body: PiWebUiConfigResponse): MachineClient {
  return {
    request: () => Promise.reject(new Error("raw request not configured for this test")),
    requestJson: () => Promise.resolve({ statusCode: 200, headers: {}, body }),
    connectWebSocket: () => { throw new Error("WebSocket not configured for this test"); },
  };
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/server/configRoutes.test.ts src/server/machines/machineProxyRoutes.test.ts`
Expected: FAIL, `sessiond` is dropped from selected-machine reads and federation response bodies, `sessiondUrl` is `undefined`, and the proxy round-trip loses the subtree and override flag.

- [ ] **Step 3: Implement the read-side parser, wrapper, and projection**

In `src/server/configRoutes.ts`, extend the `../config.js` import with `parsePiWebUiSessiondConfig` and extend the `../shared/apiTypes.js` type import with `PiWebUiSessiondConfig`.

Change the body of `selectedMachineConfigResponse` to:

```ts
export function selectedMachineConfigResponse(response: PiWebUiConfigResponse): PiWebUiConfigResponse {
  return {
    ...response,
    config: projectSelectedMachineConfigValues(response.config),
    effectiveConfig: projectSelectedMachineConfigValues(response.effectiveConfig),
  };
}
```

Immediately after `pickSelectedMachineConfig`, add:

```ts
function projectSelectedMachineConfigValues(config: PiWebUiConfigValues): PiWebUiConfigValues {
  return { ...pickSelectedMachineConfig(config), ...(config.sessiond === undefined ? {} : { sessiond: config.sessiond }) };
}
```

In `parsePiWebUiConfigResponseBody`, change the two parser calls to:

```ts
    config: parsePiWebUiConfigResponseValues(record["config"], "portable", source),
    effectiveConfig: parsePiWebUiConfigResponseValues(record["effectiveConfig"], "portable", source),
```

Immediately after the closing brace of `parsePiWebUiConfigResponseBody`, add:

```ts
function parseReadOnlySessiondConfig(value: unknown, source: string): PiWebUiSessiondConfig {
  // Read-side only. Sharing the file parser guarantees identical shapes and messages.
  return parsePiWebUiSessiondConfig(value, source);
}

function parsePiWebUiConfigResponseValues(value: unknown, agentPathHost: AgentPathHost, source: string): PiWebUiConfigValues {
  const parsed = parseConfigRequest(value, agentPathHost);
  if (!isRecord(value) || value["sessiond"] === undefined) return parsed;
  return { ...parsed, sessiond: parseReadOnlySessiondConfig(value["sessiond"], source) };
}
```

In `parsePiWebUiConfigEnvOverridesResponse`, add this member after `agentSessionDir`:

```ts
    sessiondUrl: optionalResponseBoolean(record, "sessiondUrl", source) ?? false,
```

Do not change `parseConfigRequest`, `SELECTED_MACHINE_CONFIG_KEYS`, `parseSelectedMachineConfigRequest`, or `mergeSelectedMachineConfig`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/configRoutes.test.ts src/server/machines/machineProxyRoutes.test.ts`
Expected: PASS, including the pre-existing config route, redaction, and federation-response tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/configRoutes.ts src/server/configRoutes.test.ts src/server/machines/machineProxyRoutes.test.ts
git commit -m "feat(config): project sessiond read-only and keep write paths closed"
```

## Task 4: Session daemon listener resolution and startup wiring

**Lane:** daemon-bind

**Implementer tier:** Advanced

**Files:**

- Create: `src/sessiond/listenerConfig.ts`
- Modify: `src/server/sessiond.ts:35` (import the two helpers)
- Modify: `src/server/sessiond.ts:73-74` (resolve the listener once at the top of `createRuntime`)
- Modify: `src/server/sessiond.ts:183-187` (embed the descriptor in `runtimeComponent` and return it)
- Modify: `src/server/sessiond.ts:217-255` (`listen` dispatches on `sessiondListener.kind` through the mapper)
- Test: Create `src/sessiond/listenerConfig.test.ts`

**Interfaces:**

- Consumes: `parsePort(value: unknown, key: string, path = "environment"): number` and `PiWebUiSessiondConfig { host?: string; port?: number; url?: string }` from Task 1; `PiWebUiSessiondListenerDescriptor = { kind: "tcp"; host: string; port: number; hostSource: PiWebUiSessiondListenerSource; portSource: PiWebUiSessiondPortSource } | { kind: "socket" }` from Task 1; the existing `loadPiWebUiConfig(options)` and `sessiondSocketPath(): string`.
- Produces: `sessiondListenerConfig(subtree: PiWebUiSessiondConfig | undefined, env: NodeJS.ProcessEnv): PiWebUiSessiondListenerDescriptor` (pure; `{ kind: "socket" }` unless a file or non-blank environment port resolves; `127.0.0.1` default host; `"env" | "config" | "default"` host source; `"env" | "config"` port source; throws `PI WEBUI config PI_WEBUI_SESSIOND_PORT must be an integer from 1 to 65535: environment` for a non-blank unparseable environment port; never reads `url`); `sessiondListenOptions(listener: PiWebUiSessiondListenerDescriptor, socketPath: string): { port: number; host: string } | { path: string }` (pure; TCP branch returns `{ port, host }` and ignores `socketPath`, socket branch returns `{ path: socketPath }`); the daemon's `createRuntime` returns a frozen `runtimeComponent` whose `sessiondListener` is the same descriptor that reaches `app.listen`.

- [ ] **Step 1: Write the failing tests**

Create `src/sessiond/listenerConfig.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { sessiondListenerConfig, sessiondListenOptions } from "./listenerConfig.js";

describe("sessiondListenerConfig", () => {
  it("resolves env and file port and host with provenance", () => {
    expect(sessiondListenerConfig(undefined, { PI_WEBUI_SESSIOND_PORT: "8810" })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "env" });
    expect(sessiondListenerConfig({ host: "0.0.0.0", port: 8810 }, {})).toEqual({ kind: "tcp", host: "0.0.0.0", port: 8810, hostSource: "config", portSource: "config" });
    expect(sessiondListenerConfig({ host: "0.0.0.0", port: 8810 }, { PI_WEBUI_SESSIOND_HOST: "::1" })).toEqual({ kind: "tcp", host: "::1", port: 8810, hostSource: "env", portSource: "config" });
    expect(sessiondListenerConfig({ host: "0.0.0.0", port: 8810 }, { PI_WEBUI_SESSIOND_PORT: "9000" })).toEqual({ kind: "tcp", host: "0.0.0.0", port: 9000, hostSource: "config", portSource: "env" });
  });

  it("binds the socket when no port comes from the file or environment", () => {
    expect(sessiondListenerConfig(undefined, {})).toEqual({ kind: "socket" });
    expect(sessiondListenerConfig({ host: "0.0.0.0" }, {})).toEqual({ kind: "socket" });
  });

  it("treats a blank environment port as absent", () => {
    for (const value of ["", "   "]) {
      expect(sessiondListenerConfig({ port: 8810 }, { PI_WEBUI_SESSIOND_PORT: value })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
      expect(sessiondListenerConfig(undefined, { PI_WEBUI_SESSIOND_PORT: value })).toEqual({ kind: "socket" });
    }
  });

  it("treats a blank environment host as absent", () => {
    for (const value of ["", "   "]) {
      expect(sessiondListenerConfig({ host: "0.0.0.0", port: 8810 }, { PI_WEBUI_SESSIOND_HOST: value })).toEqual({ kind: "tcp", host: "0.0.0.0", port: 8810, hostSource: "config", portSource: "config" });
      expect(sessiondListenerConfig({ port: 8810 }, { PI_WEBUI_SESSIOND_HOST: value })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
    }
  });

  it("rejects an unparseable environment port", () => {
    for (const value of ["abc", "0", "65536", "8810.5"]) {
      expect(() => sessiondListenerConfig(undefined, { PI_WEBUI_SESSIOND_PORT: value }))
        .toThrow("PI WEBUI config PI_WEBUI_SESSIOND_PORT must be an integer from 1 to 65535: environment");
    }
  });

  it("ignores the url subtree entirely", () => {
    expect(sessiondListenerConfig({ url: "ftp://host", port: 8810 }, {})).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
  });
});

describe("sessiondListenOptions", () => {
  it("maps TCP listeners to port and host and ignores the socket path", () => {
    const listener = { kind: "tcp" as const, host: "0.0.0.0", port: 8810, hostSource: "config" as const, portSource: "config" as const };
    const first = sessiondListenOptions(listener, "/tmp/unused-a.sock");
    const second = sessiondListenOptions(listener, "/tmp/unused-b.sock");

    expect(first).toEqual({ port: 8810, host: "0.0.0.0" });
    expect(second).toEqual({ port: 8810, host: "0.0.0.0" });
    expect("path" in first).toBe(false);
  });

  it("maps a socket listener to the supplied path", () => {
    expect(sessiondListenOptions({ kind: "socket" }, "/run/user/1000/pi-webui/sessiond.sock")).toEqual({ path: "/run/user/1000/pi-webui/sessiond.sock" });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/sessiond/listenerConfig.test.ts`
Expected: FAIL, `Cannot find module './listenerConfig.js'`.

- [ ] **Step 3: Write the pure module**

Create `src/sessiond/listenerConfig.ts` with:

```ts
import { parsePort, type PiWebUiSessiondConfig } from "../config.js";
import type { PiWebUiSessiondListenerDescriptor } from "../shared/apiTypes.js";

/**
 * Resolve the session daemon listener from the raw loaded file subtree plus the
 * environment, so an identical value from either source stays distinguishable.
 * Pure: performs no I/O and never reads sessiond.url.
 */
export function sessiondListenerConfig(
  subtree: PiWebUiSessiondConfig | undefined,
  env: NodeJS.ProcessEnv,
): PiWebUiSessiondListenerDescriptor {
  const envPortText = env["PI_WEBUI_SESSIOND_PORT"]?.trim();
  const envPort = envPortText !== undefined && envPortText !== "" ? parsePort(envPortText, "PI_WEBUI_SESSIOND_PORT") : undefined;
  const port = envPort ?? subtree?.port;
  if (port === undefined) return { kind: "socket" };
  const portSource = envPort !== undefined ? "env" : "config";
  const envHost = env["PI_WEBUI_SESSIOND_HOST"]?.trim();
  const host = envHost !== undefined && envHost !== "" ? envHost : subtree?.host ?? "127.0.0.1";
  const hostSource = envHost !== undefined && envHost !== ""
    ? "env"
    : subtree?.host !== undefined ? "config" : "default";
  return { kind: "tcp", host, port, hostSource, portSource };
}

/**
 * Map a resolved listener to Fastify listen options. The wire descriptor's
 * socket branch is path-free, so the caller supplies the real socket path; the
 * TCP branch ignores it.
 */
export function sessiondListenOptions(
  listener: PiWebUiSessiondListenerDescriptor,
  socketPath: string,
): { port: number; host: string } | { path: string } {
  return listener.kind === "tcp" ? { port: listener.port, host: listener.host } : { path: socketPath };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/sessiond/listenerConfig.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Wire the daemon startup to the resolved listener**

In `src/server/sessiond.ts`, add this import next to the existing `sessiondSocketPath` import:

```ts
import { sessiondListenerConfig, sessiondListenOptions } from "../sessiond/listenerConfig.js";
```

At the top of `createRuntime`, immediately after `async createRuntime() {`, add:

```ts
    const sessiondListener = sessiondListenerConfig(loadPiWebUiConfig({ env: daemonEnvironment }).config.sessiond, daemonEnvironment);
```

Change the frozen runtime component to:

```ts
    const runtimeComponent = Object.freeze({
      ...getPiWebUiRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES),
      activeAgentProfile,
      sessiondListener,
    });
```

Change the `createRuntime` return object to include the descriptor next to `runtimeComponent`:

```ts
    return { eventHub, workspaceActivity, auth, models, rateLimits, skills, sessions, projectUsage, defaults, modelTiers, utilityModels, terminals, unreadStore, activeAgentProfile, runtimeComponent, sessiondListener, speechInputPolishing };
```

In the `listen` step, change the destructuring to `async listen({ auth, sessions, rateLimits, terminals, unreadStore, sessiondListener }) {`, delete the two inline reads

```ts
    const portValue = daemonEnvironment["PI_WEBUI_SESSIOND_PORT"];
    const port = portValue !== undefined && portValue !== "" ? Number(portValue) : undefined;
    const host = daemonEnvironment["PI_WEBUI_SESSIOND_HOST"] ?? "127.0.0.1";
```

and replace the branch with:

```ts
    if (sessiondListener.kind === "tcp") {
      await app.listen(sessiondListenOptions(sessiondListener, ""));
    } else {
      const path = sessiondSocketPath();
      await mkdir(dirname(path), { recursive: true });
      await rm(path, { force: true });
      await app.listen(sessiondListenOptions(sessiondListener, path));
      process.on("exit", () => void rm(path, { force: true }));
    }
```

No branch builds an inline `{ port, host }`/`{ path }` object at the `app.listen` call site, and the TCP branch performs no socket-path resolution.

- [ ] **Step 6: Verify the wiring typechecks and lints**

Run: `npm run typecheck && npx eslint src/sessiond/listenerConfig.ts src/server/sessiond.ts`
Expected: PASS, no type errors, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/sessiond/listenerConfig.ts src/sessiond/listenerConfig.test.ts src/server/sessiond.ts
git commit -m "feat(sessiond): resolve and report the listener from config and env"
```

## Task 5: Connect resolution and config-aware client

**Lane:** connect

**Implementer tier:** Advanced

**Files:**

- Modify: `src/sessiond/config.ts:1-10` (`sessiondHttpUrl(options)` resolves and validates the effective URL)
- Modify: `src/sessiond/sessionDaemonClient.ts:1-20` (constructor takes `LoadOptions`; fields assigned once)
- Test: Create `src/sessiond/config.test.ts`
- Modify: `src/sessiond/sessionDaemonClient.test.ts:1-231` (every construction injects a test config path)
- Modify: `src/server/piWebUiStatus.test.ts:370-390` (both daemon helpers inject a test config path)
- Modify: `src/server/app.testSupport.ts` (export the existing `fakeSessionDaemon` helper)
- Modify: `src/server/app.piWebUiStatus.test.ts:10` (the `buildApp` call injects the fake session daemon)
- Modify: `src/server/app.removedBrowserRoutes.test.ts:21` (the `buildApp` call injects the fake session daemon)
- Modify: `src/server/app.agentConfig.test.ts:75,97` (both direct `buildApp` calls inject the fake session daemon)
- Modify: `src/server/app.speechInput.test.ts:179` (the second `buildApp` call injects the fake session daemon)
- Modify: `src/server/app.activeAgentProfile.test.ts:37,72` (both `buildApp` calls inject the fake session daemon)
- Modify: `src/server/app.projects.test.ts:182` (the `buildApp` call injects the fake session daemon)

**Interfaces:**

- Consumes: `LoadOptions { env?: NodeJS.ProcessEnv; cwd?: string }` and `resolveEffectivePiWebUiConfig(loaded: LoadedPiWebUiConfig, options: LoadOptions): LoadedEffectivePiWebUiConfig` from `src/config.ts`; `sessiond.url` layering from Task 2; `sessiondListenerConfig(subtree: PiWebUiSessiondConfig | undefined, env: NodeJS.ProcessEnv): PiWebUiSessiondListenerDescriptor` from Task 4 (the tests prove the daemon side never sees URL-form validation).
- Produces: `sessiondHttpUrl(options: LoadOptions = {}): string | undefined` loads the config once with `loadPiWebUiConfig(options)`, resolves `resolveEffectivePiWebUiConfig(loaded, options).config.sessiond?.url`, returns `undefined` when absent, and otherwise validates the form and returns the string unchanged. Module-private `validateSessiondHttpUrl(value: string, configPath: string): string` throws the exact `sessiond.url` messages. `SessionDaemonClient` gains `constructor(options: LoadOptions = {})`, assigns `private readonly baseUrl: string | undefined` from `sessiondHttpUrl(options)` and `private readonly socketPath: string` from `sessiondSocketPath()` exactly once, and leaves `request`/`connectWebSocket` bodies unchanged.

- [ ] **Step 1: Write the failing tests**

Create `src/sessiond/config.test.ts` with:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPiWebUiConfig } from "../config.js";
import { sessiondHttpUrl } from "./config.js";
import { sessiondListenerConfig } from "./listenerConfig.js";
import { SessionDaemonClient } from "./sessionDaemonClient.js";

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-sessiond-config-test-"));
  configPath = join(tempDir, "config.json");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

async function writeConfig(value: unknown): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("sessiondHttpUrl", () => {
  it("resolves the file url", async () => {
    await writeConfig({ sessiond: { url: "http://127.0.0.1:8810" } });

    expect(sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath } })).toBe("http://127.0.0.1:8810");
  });

  it("prefers and trims the environment url", async () => {
    await writeConfig({ sessiond: { url: "http://file:1" } });

    expect(sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: "  http://env:2  " } })).toBe("http://env:2");
  });

  it("falls back to the file url for a blank environment value", async () => {
    await writeConfig({ sessiond: { url: "http://file:1" } });

    for (const value of ["   ", ""]) {
      expect(sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: value } })).toBe("http://file:1");
    }
  });

  it("accepts valid url forms", async () => {
    for (const value of ["https://host", "http://127.0.0.1:8810/"]) {
      await writeConfig({ sessiond: { url: value } });
      expect(sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath } })).toBe(value);
    }
  });

  it("rejects invalid url forms with the pinned messages", async () => {
    const cases: readonly { value: string; message: string }[] = [
      { value: "127.0.0.1:8810", message: "must be an absolute http or https URL" },
      { value: "ftp://host", message: "must be an absolute http or https URL" },
      { value: "http://user:pass@host", message: "must not contain credentials" },
      { value: "http://host/?a=1", message: "must not contain a query string" },
      { value: "http://host/#x", message: "must not contain a fragment" },
      { value: "http://host/prefix", message: "must not contain a path" },
    ];
    for (const testCase of cases) {
      await writeConfig({ sessiond: { url: testCase.value } });
      expect(() => sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath } })).toThrow(`PI WEBUI config sessiond.url ${testCase.message}: ${configPath}`);
    }
  });

  it("fails the web/API connect resolution only for a malformed environment value", async () => {
    await writeConfig({ sessiond: { port: 8810 } });
    const options = { env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: "ftp://host" } };

    expect(() => sessiondHttpUrl(options)).toThrow(`PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}`);
    expect(sessiondListenerConfig(loadPiWebUiConfig(options).config.sessiond, { PI_WEBUI_SESSIOND_URL: "ftp://host" })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
  });

  it("fails the web/API connect resolution only for a malformed file value", async () => {
    await writeConfig({ sessiond: { url: "ftp://host", port: 8810 } });
    const options = { env: { PI_WEBUI_CONFIG: configPath } };

    expect(() => sessiondHttpUrl(options)).toThrow(`PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}`);
    expect(sessiondListenerConfig(loadPiWebUiConfig(options).config.sessiond, {})).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
  });

  it("pins the resolved transport for the client lifetime", async () => {
    await writeConfig({ sessiond: { url: "http://127.0.0.1:43123" } });
    const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:43123" } });
    vi.stubEnv("PI_WEBUI_SESSIOND_URL", "http://127.0.0.1:65530");
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await client.request("GET", "/runtime");

    expect(fetchMock).toHaveBeenCalledWith(new URL("/runtime", "http://127.0.0.1:43123"), expect.objectContaining({ method: "GET" }));
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/sessiond/config.test.ts`
Expected: FAIL, `sessiondHttpUrl` ignores the file/env resolution and does not throw for malformed forms; the client-pinning case targets the old behavior.

- [ ] **Step 3: Implement resolution, validation, and the client constructor**

Replace the body of `src/sessiond/config.ts` with:

```ts
import { join } from "node:path";
import { loadPiWebUiConfig, piWebUiDataDir, resolveEffectivePiWebUiConfig, type LoadOptions } from "../config.js";

export function sessiondSocketPath(): string {
  return process.env["PI_WEBUI_SESSIOND_SOCKET"] ?? join(piWebUiDataDir(), "sessiond.sock");
}

/**
 * Resolve the web/API dial target from the effective config. This is the only
 * place URL-form validation runs, so an invalid value stops the web/API and
 * never the session daemon.
 */
export function sessiondHttpUrl(options: LoadOptions = {}): string | undefined {
  const loaded = loadPiWebUiConfig(options);
  const value = resolveEffectivePiWebUiConfig(loaded, options).config.sessiond?.url;
  return value === undefined ? undefined : validateSessiondHttpUrl(value, loaded.path);
}

function validateSessiondHttpUrl(value: string, configPath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw new Error(`PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}`);
  }
  if (url.username !== "" || url.password !== "") throw new Error(`PI WEBUI config sessiond.url must not contain credentials: ${configPath}`);
  if (url.search !== "") throw new Error(`PI WEBUI config sessiond.url must not contain a query string: ${configPath}`);
  if (url.hash !== "") throw new Error(`PI WEBUI config sessiond.url must not contain a fragment: ${configPath}`);
  if (url.pathname !== "/") throw new Error(`PI WEBUI config sessiond.url must not contain a path: ${configPath}`);
  return value;
}
```

In `src/sessiond/sessionDaemonClient.ts`, extend the `../config.js` import with `type LoadOptions`, then replace the two field initializers with:

```ts
  private readonly baseUrl: string | undefined;
  private readonly socketPath: string;

  constructor(options: LoadOptions = {}) {
    this.baseUrl = sessiondHttpUrl(options);
    this.socketPath = sessiondSocketPath();
  }
```

Leave `request`, `requestUrl`, `requestSocket`, `connectWebSocket`, and `getActiveAgentProfile` unchanged.

- [ ] **Step 4: Update every existing direct client construction to inject a test config path**

In `src/sessiond/sessionDaemonClient.test.ts`, add `import { tmpdir } from "node:os";` and `import { join } from "node:path";` at the top and add this constant below the imports:

```ts
const testConfigPath = join(tmpdir(), `pi-webui-sessiond-client-config-${String(process.pid)}-${String(Date.now())}.json`);
```

Replace every `new SessionDaemonClient()` that exercises profile or socket transport with:

```ts
new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } })
```

and replace the two TCP constructions in `"passes an abort signal to TCP requests and rejects promptly when it is aborted"` and `"rejects promptly when TCP response body reading is still pending at abort"` with:

```ts
new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath, PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:43123" } })
```

The injected env replaces `process.env` for config resolution, so each TCP construction must carry the URL; `sessiondSocketPath()` still reads the stubbed `process.env` and the socket tests stay unaffected. Keep the existing `vi.stubEnv` calls.

In `src/server/piWebUiStatus.test.ts`, add this constant below the existing originals:

```ts
const statusTestConfigPath = join(tmpdir(), `pi-webui-status-test-config-${String(process.pid)}.json`);
```

and change both helpers to construct with it:

```ts
function daemonWithComponent(component: PiWebUiComponentStatus): SessionDaemonClient {
  const daemon = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: statusTestConfigPath } });
```

```ts
function daemonWithRuntime(component: PiWebUiRuntimeComponent): SessionDaemonClient {
  const daemon = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: statusTestConfigPath } });
```

- [ ] **Step 5: Isolate every `buildApp` fallback construction with the shared fake daemon**

`buildApp` constructs `SessionDaemonClient` whenever `deps.sessionDaemon` is absent (`src/server/app.ts:328`), so each app-suite `buildApp` call below that omits the dependency must inject the existing fake daemon instead of letting the fallback read the developer's real config. In `src/server/app.testSupport.ts`, change `function fakeSessionDaemon(): SessionProxyDaemon {` to `export function fakeSessionDaemon(): SessionProxyDaemon {`.

Then add `sessionDaemon: fakeSessionDaemon(),` to each `buildApp` dependency object and import `fakeSessionDaemon` from `./app.testSupport.js` where it is not already imported; change nothing else in those dependency objects or assertions:

- `src/server/app.piWebUiStatus.test.ts:10` — add the import and the dependency.
- `src/server/app.removedBrowserRoutes.test.ts:21` — add the import and the dependency.
- `src/server/app.agentConfig.test.ts:75` and `:97` — add `fakeSessionDaemon` to the existing `./app.testSupport.js` import and the dependency to both calls.
- `src/server/app.speechInput.test.ts:179` — add `fakeSessionDaemon` to the existing `./app.testSupport.js` import and the dependency to that call.
- `src/server/app.activeAgentProfile.test.ts:37` and `:72` — add `fakeSessionDaemon` to the existing `./app.testSupport.js` import and the dependency to both calls.
- `src/server/app.projects.test.ts:182` — add `fakeSessionDaemon` to the existing `./app.testSupport.js` import and the dependency to that call.

- [ ] **Step 6: Run the focused tests and confirm they pass**

Run: `npm test -- --run src/sessiond/config.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/piWebUiStatus.test.ts src/server/app.piWebUiStatus.test.ts src/server/app.removedBrowserRoutes.test.ts src/server/app.agentConfig.test.ts src/server/app.speechInput.test.ts src/server/app.activeAgentProfile.test.ts src/server/app.projects.test.ts`
Expected: PASS, the new resolution cases plus every pre-existing direct-client and app-suite case.

- [ ] **Step 7: Typecheck and lint the changed source**

Run: `npm run typecheck && npx eslint src/sessiond/config.ts src/sessiond/sessionDaemonClient.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/sessiond/config.ts src/sessiond/config.test.ts src/sessiond/sessionDaemonClient.ts src/sessiond/sessionDaemonClient.test.ts src/server/piWebUiStatus.test.ts src/server/app.testSupport.ts src/server/app.piWebUiStatus.test.ts src/server/app.removedBrowserRoutes.test.ts src/server/app.agentConfig.test.ts src/server/app.speechInput.test.ts src/server/app.activeAgentProfile.test.ts src/server/app.projects.test.ts
git commit -m "feat(sessiond): validate the configured dial target at connect resolution"
```

## Task 6: Strict runtime descriptor parser and machine runtime propagation

**Lane:** runtime-protocol

**Implementer tier:** Standard

**Files:**

- Modify: `src/shared/piWebUiStatusParsing.ts:30-52` (add `parsePiWebUiSessiondListenerDescriptor`; wire it into `parsePiWebUiRuntimeComponent`)
- Test: `src/shared/piWebUiStatusParsing.test.ts:126` (append the new describe block and helper at the end)
- Modify: `src/server/machines/machineService.test.ts:253-283` (fixture carries `sessiondListener`) and `:198` (add the retention test before the caching-error test)

**Interfaces:**

- Consumes: `PiWebUiSessiondListenerDescriptor = { kind: "tcp"; host: string; port: number; hostSource: PiWebUiSessiondListenerSource; portSource: PiWebUiSessiondPortSource } | { kind: "socket" }` from Task 1, with `PiWebUiSessiondListenerSource = "env" | "config" | "default"` and `PiWebUiSessiondPortSource = "env" | "config"`.
- Produces: `parsePiWebUiSessiondListenerDescriptor(value: unknown): PiWebUiSessiondListenerDescriptor | undefined` accepts only `{ kind: "socket" }` or `{ kind: "tcp"; host: string; port: integer 1..65535; hostSource: "env" | "config" | "default"; portSource: "env" | "config" }` with no unknown keys, returns a frozen descriptor, and returns `undefined` for any violation; `parsePiWebUiRuntimeComponent` includes `sessiondListener` only when present and rejects the whole component (`undefined`) when the value is malformed or attached to `component !== "sessiond"`; `parsePiWebUiRuntimeResponse` therefore returns `undefined` for those cases and `MachineService.runtime` preserves the descriptor.

- [ ] **Step 1: Write the failing tests**

In `src/server/machines/machineService.test.ts`, add this `sessiondListener` member to the `sessiond` object inside `remoteRuntimeBody()`:

```ts
        sessiondListener: { kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "config", portSource: "config" },
```

Then insert this test immediately before `it("caches remote runtime errors and clears them after remote updates", ...)`:

```ts
  it("retains the daemon listener descriptor for remote runtime snapshots", async () => {
    const body = remoteRuntimeBody();
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({ statusCode: 200, headers: {}, body }));
    const remoteService = new MachineService(new MachineStore(storePath), {
      remoteClientFactory: () => fakeRemoteClient({ requestJson }),
      now: () => new Date("2026-05-25T00:00:00.000Z"),
    });
    const machine = await remoteService.add({ name: "Remote", baseUrl: "https://remote.example.test" });

    const runtime = await remoteService.runtime(machine.id);

    expect(runtime?.components?.sessiond.sessiondListener).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "config", portSource: "config" });
  });
```

Append this block and helper at the end of `src/shared/piWebUiStatusParsing.test.ts`:

```ts
describe("session daemon listener descriptors", () => {
  it("parses and freezes both descriptor forms for the sessiond component", () => {
    const tcp = { kind: "tcp", host: "0.0.0.0", port: 8810, hostSource: "config", portSource: "config" };
    const parsedTcp = parsePiWebUiRuntimeResponse(runtimeWithListener(tcp));

    expect(parsedTcp?.components.sessiond.sessiondListener).toEqual(tcp);
    expect(Object.isFrozen(parsedTcp?.components.sessiond.sessiondListener)).toBe(true);
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener({ kind: "socket" }))?.components.sessiond.sessiondListener).toEqual({ kind: "socket" });
  });

  it("drops a legacy omission", () => {
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener(undefined))?.components.sessiond.sessiondListener).toBeUndefined();
  });

  it("rejects malformed descriptors and web ownership", () => {
    const tcp = { kind: "tcp", host: "0.0.0.0", port: 8810, hostSource: "config", portSource: "config" };
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener({ ...tcp, tls: true }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener({ ...tcp, hostSource: "future" }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener({ ...tcp, portSource: "default" }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener({ ...tcp, kind: "future" }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener({ ...tcp, host: "" }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener({ ...tcp, port: 0 }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener({ ...tcp, port: 65536 }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(runtimeWithListener(tcp, "web"))).toBeUndefined();
  });
});

function runtimeWithListener(listener: unknown, owner: "web" | "sessiond" = "sessiond") {
  const web = { component: "web" as const, label: "Web/UI", available: true, capabilities: [] as string[] };
  const sessiond = { component: "sessiond" as const, label: "Session daemon", available: true, capabilities: [] as string[] };
  return {
    packageName: "@hyperdreamer/pi-webui",
    generatedAt: "now",
    components: {
      web: owner === "web" ? { ...web, sessiondListener: listener } : web,
      sessiond: owner === "sessiond" && listener !== undefined ? { ...sessiond, sessiondListener: listener } : sessiond,
    },
    capabilities: [],
  };
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/shared/piWebUiStatusParsing.test.ts src/server/machines/machineService.test.ts`
Expected: FAIL, the listener field is dropped by the parser so both the new descriptor cases and the updated `remoteRuntimeBody` expectations fail.

- [ ] **Step 3: Implement the strict parser**

In `src/shared/piWebUiStatusParsing.ts`, extend the `./apiTypes.js` type import with `PiWebUiSessiondListenerDescriptor` and add this function immediately after `parsePiWebUiRuntimeResponse`:

```ts
export function parsePiWebUiSessiondListenerDescriptor(value: unknown): PiWebUiSessiondListenerDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  if (kind === "socket") {
    if (Object.keys(value).some((key) => key !== "kind")) return undefined;
    return Object.freeze({ kind: "socket" });
  }
  if (kind !== "tcp") return undefined;
  if (Object.keys(value).some((key) => key !== "kind" && key !== "host" && key !== "port" && key !== "hostSource" && key !== "portSource")) return undefined;
  const host = value["host"];
  const port = value["port"];
  const hostSource = value["hostSource"];
  const portSource = value["portSource"];
  if (typeof host !== "string" || host === "") return undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (hostSource !== "env" && hostSource !== "config" && hostSource !== "default") return undefined;
  if (portSource !== "env" && portSource !== "config") return undefined;
  return Object.freeze({ kind: "tcp", host, port, hostSource, portSource });
}
```

In `parsePiWebUiRuntimeComponent`, add this read next to the `activeAgentProfile` read:

```ts
  const sessiondListenerValue = value["sessiondListener"];
  const sessiondListener = sessiondListenerValue === undefined ? undefined : parsePiWebUiSessiondListenerDescriptor(sessiondListenerValue);
```

change the gated rejection to also cover the listener:

```ts
  if (activeAgentProfileValue !== undefined && (component !== "sessiond" || activeAgentProfile === undefined)) return undefined;
  if (sessiondListenerValue !== undefined && (component !== "sessiond" || sessiondListener === undefined)) return undefined;
```

and add this member to the returned component after the `activeAgentProfile` spread:

```ts
    ...(sessiondListener === undefined ? {} : { sessiondListener }),
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/shared/piWebUiStatusParsing.test.ts src/server/machines/machineService.test.ts`
Expected: PASS, including the pre-existing active-profile, capability, and runtime-caching cases.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/piWebUiStatusParsing.ts src/shared/piWebUiStatusParsing.test.ts src/server/machines/machineService.test.ts
git commit -m "feat(runtime): parse and propagate the session daemon listener descriptor"
```

## Task 7: Client config and runtime parsers

**Lane:** client-parse

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/api/parsers.ts:1905-1931` (`parsePiWebUiConfigValues` parses `sessiond`; add `optionalSessiond`)
- Modify: `src/client/src/api/parsers.ts:2008-2019` (`parsePiWebUiConfigEnvOverrides` gains `sessiondUrl`)
- Modify: `src/client/src/api/parsers.ts:2206-2225` (`parsePiWebUiRuntimeComponent` parses `sessiondListener`; add `optionalSessiondListener`)
- Test: `src/client/src/api/parsers.test.ts:296-313` (update the existing config-response expectation) and `:430` (append the new describe block and helpers)

**Interfaces:**

- Consumes: `PiWebUiConfigValues.sessiond?: PiWebUiSessiondConfig` with `PiWebUiSessiondConfig { host?: string; port?: number; url?: string }`, `PiWebUiConfigEnvOverrides.sessiondUrl?: boolean`, and `PiWebUiRuntimeComponent.sessiondListener?: PiWebUiSessiondListenerDescriptor` from Task 1.
- Produces: `parsePiWebUiConfigValues` keeps an optional `sessiond` subtree (`{host?, port?, url?}`; strings trimmed; blank-after-trim strings omitted; an all-blank object kept as `{}`; unknown keys, wrong types, and ports outside `1..65535` throw; URL form is not validated); `parsePiWebUiConfigEnvOverrides` returns `sessiondUrl: optionalBoolean(record, "sessiondUrl") ?? false`; `parsePiWebUiRuntimeComponent` throws `Invalid session daemon listener descriptor` for a malformed descriptor or one attached to `component !== "sessiond"`, and omits the field when absent.

- [ ] **Step 1: Write the failing tests**

In `src/client/src/api/parsers.test.ts`, inside `it("parses PI WEBUI config responses", ...)`, add `sessiondUrl: false` to the expected `envOverrides` object so the expectation ends:

```ts
      envOverrides: { host: true, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: true, agentDirSource: "pi-compatibility", agentSessionDir: false, sessiondUrl: false },
```

Append this block and the two helpers at the end of `src/client/src/api/parsers.test.ts`:

```ts
describe("sessiond client parsers", () => {
  it("carries the sessiond subtree and defaults the override flag", () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    const parsed = parsePiWebUiConfigResponse({
      path: "/tmp/pi-webui/config.json",
      exists: true,
      config: { sessiond },
      effectiveConfig: { sessiond },
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
    });

    expect(parsed.config.sessiond).toEqual(sessiond);
    expect(parsed.effectiveConfig.sessiond).toEqual(sessiond);
    expect(parsed.envOverrides.sessiondUrl).toBe(false);
  });

  it("trims sessiond strings and omits blank ones", () => {
    const parsed = parsePiWebUiConfigResponse(configResponseWithSessiond({ host: "  0.0.0.0  ", url: "   ", port: 8810 }));

    expect(parsed.config.sessiond).toEqual({ host: "0.0.0.0", port: 8810 });
  });

  it("keeps an all-blank sessiond object as an empty object", () => {
    const parsed = parsePiWebUiConfigResponse(configResponseWithSessiond({ host: "", url: "   " }));

    expect(parsed.config.sessiond).toEqual({});
  });

  it("rejects malformed sessiond values", () => {
    for (const sessiond of [[], { host: 1 }, { port: 0 }, { tls: true }]) {
      expect(() => parsePiWebUiConfigResponse(configResponseWithSessiond(sessiond))).toThrow();
    }
  });

  it("carries and validates sessiondListener in runtime responses", () => {
    const tcp = { kind: "tcp", host: "0.0.0.0", port: 8810, hostSource: "config", portSource: "config" };
    const parsed = parsePiWebUiRuntimeResponse(runtimeResponseWithListener(tcp));

    expect(parsed.components.sessiond.sessiondListener).toEqual(tcp);
    expect(parsePiWebUiRuntimeResponse(runtimeResponseWithListener({ kind: "socket" })).components.sessiond.sessiondListener).toEqual({ kind: "socket" });
    expect(() => parsePiWebUiRuntimeResponse(runtimeResponseWithListener({ ...tcp, tls: true }))).toThrow("Invalid session daemon listener descriptor");
    expect(() => parsePiWebUiRuntimeResponse(runtimeResponseWithListener({ ...tcp, host: "" }))).toThrow("Invalid session daemon listener descriptor");
    expect(() => parsePiWebUiRuntimeResponse(runtimeResponseWithListener({ ...tcp, port: 0 }))).toThrow("Invalid session daemon listener descriptor");
    expect(() => parsePiWebUiRuntimeResponse(runtimeResponseWithListener(tcp, "web"))).toThrow("Invalid session daemon listener descriptor");
  });

  it("retains sessiondListener in machine runtime snapshots", () => {
    const tcp = { kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "env" };
    const components = {
      web: { component: "web", label: "Web/UI", available: true, capabilities: [] },
      sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [], sessiondListener: tcp },
    };

    const parsed = parseMachineRuntime({ machineId: "remote-a", ok: true, checkedAt: "now", components, capabilities: [] });

    expect(parsed.components?.sessiond.sessiondListener).toEqual(tcp);
  });
});

function configResponseWithSessiond(sessiond: unknown) {
  return {
    path: "/tmp/pi-webui/config.json",
    exists: true,
    config: { sessiond },
    effectiveConfig: { sessiond },
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
  };
}

function runtimeResponseWithListener(listener: unknown, owner: "web" | "sessiond" = "sessiond") {
  const web = { component: "web", label: "Web/UI", available: true, capabilities: [] };
  const sessiond = { component: "sessiond", label: "Session daemon", available: true, capabilities: [] };
  return {
    packageName: "@hyperdreamer/pi-webui",
    generatedAt: "now",
    components: {
      web: owner === "web" ? { ...web, sessiondListener: listener } : web,
      sessiond: owner === "sessiond" ? { ...sessiond, sessiondListener: listener } : sessiond,
    },
    capabilities: [],
  };
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/api/parsers.test.ts`
Expected: FAIL, `sessiond` is dropped and `envOverrides.sessiondUrl` is `undefined`, and the listener cases fail the `toEqual`/`toThrow` assertions.

- [ ] **Step 3: Implement the client parsers**

In `src/client/src/api/parsers.ts`, inside `parsePiWebUiConfigValues`, add this spread after the `tts` entry:

```ts
    ...optionalField("sessiond", optionalSessiond(record["sessiond"])),
```

Immediately after the `optionalTts` function, add:

```ts
function optionalSessiond(value: unknown): PiWebUiConfigValues["sessiond"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEBUI sessiond field");
  assertOnlyFields(value, ["host", "port", "url"], "PI WEBUI sessiond");
  const host = optionalString(value, "host")?.trim();
  const url = optionalString(value, "url")?.trim();
  const port = optionalNumber(value, "port");
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid PI WEBUI sessiond port field");
  return {
    ...(host === undefined || host === "" ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(url === undefined || url === "" ? {} : { url }),
  };
}
```

In `parsePiWebUiConfigEnvOverrides`, add this member after `agentSessionDir`:

```ts
    sessiondUrl: optionalBoolean(record, "sessiondUrl") ?? false,
```

In `parsePiWebUiRuntimeComponent`, add these reads beside the `activeAgentProfile` reads:

```ts
  const sessiondListenerValue = record["sessiondListener"];
  const sessiondListener = optionalSessiondListener(sessiondListenerValue);
```

add this rejection beside the active-profile rejection:

```ts
  if (sessiondListenerValue !== undefined && (component !== "sessiond" || sessiondListener === undefined)) throw new Error("Invalid session daemon listener descriptor");
```

and add this spread to the returned component after `...optionalField("activeAgentProfile", activeAgentProfile),`:

```ts
    ...optionalField("sessiondListener", sessiondListener),
```

Immediately after `parsePiWebUiRuntimeComponent`, add:

```ts
function optionalSessiondListener(value: unknown): PiWebUiRuntimeComponent["sessiondListener"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid session daemon listener descriptor");
  const kind = value["kind"];
  if (kind === "socket") {
    assertOnlyFields(value, ["kind"], "session daemon listener descriptor");
    return { kind: "socket" };
  }
  if (kind !== "tcp") throw new Error("Invalid session daemon listener descriptor");
  assertOnlyFields(value, ["kind", "host", "port", "hostSource", "portSource"], "session daemon listener descriptor");
  const host = value["host"];
  const port = value["port"];
  const hostSource = value["hostSource"];
  const portSource = value["portSource"];
  if (typeof host !== "string" || host === "") throw new Error("Invalid session daemon listener descriptor");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid session daemon listener descriptor");
  if (hostSource !== "env" && hostSource !== "config" && hostSource !== "default") throw new Error("Invalid session daemon listener descriptor");
  if (portSource !== "env" && portSource !== "config") throw new Error("Invalid session daemon listener descriptor");
  return { kind: "tcp", host, port, hostSource, portSource };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/api/parsers.test.ts`
Expected: PASS, including every pre-existing parser case.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/client/src/api/parsers.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts
git commit -m "feat(client): parse sessiond config, overrides, and listener descriptors"
```

## Task 8: Client listener helpers and barrel exports

**Lane:** client-helpers

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/api.ts:10-13` (re-export the sessiond config and listener descriptor types)
- Modify: `src/client/src/components/settings/settingsSessiondConfig.ts:1-61` (add coherence/activation helpers; carry `sessiondUrl`)
- Test: `src/client/src/components/settings/settingsSessiondConfig.test.ts:1-130` (imports, updated merge expectation, new describe blocks)

**Interfaces:**

- Consumes: `PiWebUiSessiondConfig { host?: string; port?: number; url?: string }` and `PiWebUiSessiondListenerDescriptor = { kind: "tcp"; host: string; port: number; hostSource: "env" | "config" | "default"; portSource: "env" | "config" } | { kind: "socket" }` from Task 1; they are imported from `../../api`, so this task also adds them to the barrel.
- Produces: `SessiondActivationState = "active" | "overridden" | "restart-required" | "unavailable"`; `SessiondCoherenceIssue = "missing-dial-target" | "missing-bind-port"`; `activationState(fileSessiond: PiWebUiSessiondConfig | undefined, listener: PiWebUiSessiondListenerDescriptor | undefined): SessiondActivationState`; `coherenceWarning(fileSessiond: PiWebUiSessiondConfig | undefined, sessiondUrlOverridden: boolean, listener: PiWebUiSessiondListenerDescriptor | undefined): SessiondCoherenceIssue | undefined`; `coherenceWarningMessage(issue: SessiondCoherenceIssue): string`; `mergeSelectedMachineSessiondConfig` adds `sessiondUrl: selectedMachine.envOverrides.sessiondUrl ?? false` while keeping its signature and its `config`/`effectiveConfig` spread merge.

- [ ] **Step 1: Write the failing tests**

In `src/client/src/components/settings/settingsSessiondConfig.test.ts`, extend the imports to:

```ts
import { describe, expect, it } from "vitest";
import type { ActiveAgentProfileDescriptor, PiWebUiConfigResponse, PiWebUiConfigValues, PiWebUiSessiondListenerDescriptor } from "../../api";
import { agentProfileConfigPatchFromDraft } from "./settingsConfigDraft";
import { activationState, agentDirFieldOverridden, agentProfileActivationState, coherenceWarning, coherenceWarningMessage, mergeSelectedMachineSessiondConfig, spawnSessionsConfigPatch, subsessionsConfigPatch } from "./settingsSessiondConfig";
```

In the existing `it("merges local selected-machine daemon config into gateway config without dropping gateway-only values", ...)` test, add `sessiondUrl: false` to the expected `envOverrides` object so it reads:

```ts
      envOverrides: {
        host: false,
        port: false,
        allowedHosts: false,
        spawnSessions: true,
        subsessions: false,
        agentCommand: true,
        agentDir: false,
        agentDirSource: "pi-compatibility",
        agentSessionDir: true,
        sessiondUrl: false,
      },
```

Insert this test after that merge test and before the closing `});` of `describe("session daemon settings config helpers", ...)`:

```ts
  it("merges the selected machine listener subtree and override flag", () => {
    const gateway = configResponse({ spawnSessions: false }, { host: true });
    const selectedMachine = configResponse(
      { sessiond: { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" } },
      { sessiondUrl: true },
      { sessiond: { host: "0.0.0.0", port: 8810 } },
    );

    const merged = mergeSelectedMachineSessiondConfig(gateway, selectedMachine);

    expect(merged.config.sessiond).toEqual({ host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" });
    expect(merged.effectiveConfig.sessiond).toEqual({ host: "0.0.0.0", port: 8810 });
    expect(merged.envOverrides.sessiondUrl).toBe(true);
    expect(merged.envOverrides.host).toBe(true);
  });
```

Then append these describe blocks at the end of the file:

```ts
describe("session daemon coherence warning", () => {
  function tcp(hostSource: "env" | "config" | "default", portSource: "env" | "config"): PiWebUiSessiondListenerDescriptor {
    return { kind: "tcp", host: "127.0.0.1", port: 8810, hostSource, portSource };
  }

  it("warns about exactly one configured half of the listener pair", () => {
    expect(coherenceWarning({ port: 8810 }, false, undefined)).toBe("missing-dial-target");
    expect(coherenceWarning({ port: 8810 }, true, undefined)).toBeUndefined();
    expect(coherenceWarning({ url: "http://127.0.0.1:8810" }, false, undefined)).toBe("missing-bind-port");
    expect(coherenceWarning({ url: "http://127.0.0.1:8810" }, false, tcp("config", "env"))).toBeUndefined();
    expect(coherenceWarning({ url: "http://127.0.0.1:8810" }, false, tcp("env", "config"))).toBe("missing-bind-port");
    expect(coherenceWarning({ url: "http://127.0.0.1:8810" }, false, { kind: "socket" })).toBe("missing-bind-port");
    expect(coherenceWarning({ port: 8810, url: "http://127.0.0.1:8810" }, false, undefined)).toBeUndefined();
    expect(coherenceWarning({ port: 8810, url: "http://127.0.0.1:8810" }, true, undefined)).toBeUndefined();
    expect(coherenceWarning(undefined, true, undefined)).toBeUndefined();
    expect(coherenceWarning({ port: 8810 }, false, tcp("config", "config"))).toBe("missing-dial-target");
  });

  it("shows the bind half until the daemon reports an environment port", () => {
    const fileSessiond = { url: "http://127.0.0.1:8810" };

    expect(coherenceWarning(fileSessiond, false, tcp("env", "config"))).toBe("missing-bind-port");
    expect(coherenceWarning(fileSessiond, false, tcp("env", "env"))).toBeUndefined();
  });

  it("returns the pinned coherence messages", () => {
    expect(coherenceWarningMessage("missing-dial-target")).toBe("sessiond.port is configured, but no sessiond.url is set and PI_WEBUI_SESSIOND_URL is not set on that machine, so the web/API will dial the session daemon socket while the daemon listens on TCP. Add sessiond.url or remove sessiond.port.");
    expect(coherenceWarningMessage("missing-bind-port")).toBe("sessiond.url is configured, but no sessiond.port is set and PI_WEBUI_SESSIOND_PORT is not set on that machine, so the daemon will listen on the session daemon socket. Add sessiond.port or remove sessiond.url.");
  });
});

describe("session daemon activation state", () => {
  function tcp(host: string, port: number, hostSource: "env" | "config" | "default", portSource: "env" | "config"): PiWebUiSessiondListenerDescriptor {
    return { kind: "tcp", host, port, hostSource, portSource };
  }

  it("resolves every verdict pairing", () => {
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("0.0.0.0", 8810, "env", "env"))).toBe("active");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 8810, "env", "config"))).toBe("overridden");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("0.0.0.0", 9000, "config", "env"))).toBe("overridden");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 9000, "env", "config"))).toBe("overridden");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 9000, "config", "env"))).toBe("overridden");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 9000, "config", "config"))).toBe("restart-required");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, { kind: "socket" })).toBe("restart-required");
    expect(activationState({}, { kind: "socket" })).toBe("active");
    expect(activationState({}, tcp("127.0.0.1", 8810, "default", "env"))).toBe("overridden");
    expect(activationState({}, tcp("0.0.0.0", 8810, "env", "config"))).toBe("restart-required");
    expect(activationState({ port: 8810 }, tcp("127.0.0.1", 8810, "default", "config"))).toBe("active");
    expect(activationState(undefined, undefined)).toBe("unavailable");
  });

  it("scopes environment influence to the differing value only", () => {
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 8810, "default", "env"))).toBe("restart-required");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("0.0.0.0", 9000, "env", "config"))).toBe("restart-required");
    expect(activationState({}, tcp("127.0.0.1", 8810, "env", "config"))).toBe("restart-required");
  });

  it("keeps the listener block out of every save draft builder", () => {
    expect(spawnSessionsConfigPatch(false)).toEqual({ spawnSessions: false });
    expect(subsessionsConfigPatch(true)).toEqual({ subsessions: true });
    expect(agentProfileConfigPatchFromDraft({ command: "pi", dir: "/srv/pi" })).toEqual({ agent: { command: "pi", dir: "/srv/pi" } });
    for (const patch of [spawnSessionsConfigPatch(false), subsessionsConfigPatch(true), agentProfileConfigPatchFromDraft({ command: "pi", dir: "/srv/pi" })]) {
      expect(patch).not.toHaveProperty("sessiond");
      expect(patch).not.toHaveProperty("sessiondListener");
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/settings/settingsSessiondConfig.test.ts`
Expected: FAIL, the new imports (`coherenceWarning`, `activationState`) do not exist and the merge result lacks `sessiondUrl`.

- [ ] **Step 3: Implement the helpers and barrel exports**

In `src/client/src/api.ts`, add `PiWebUiSessiondConfig` and `PiWebUiSessiondListenerDescriptor` to the large `export type { ... } from "../../shared/apiTypes";` list, immediately after `PiWebUiRuntimeResponse`. (Do not add the two source aliases: nothing imports them through the barrel, and Knip must stay clean.)

In `src/client/src/components/settings/settingsSessiondConfig.ts`, extend the `../../api` type import with `PiWebUiSessiondConfig` and `PiWebUiSessiondListenerDescriptor`, then add these exports below the existing types:

```ts
export type SessiondActivationState = "active" | "overridden" | "restart-required" | "unavailable";
export type SessiondCoherenceIssue = "missing-dial-target" | "missing-bind-port";

export function coherenceWarning(
  fileSessiond: PiWebUiSessiondConfig | undefined,
  sessiondUrlOverridden: boolean,
  listener: PiWebUiSessiondListenerDescriptor | undefined,
): SessiondCoherenceIssue | undefined {
  const hasPort = fileSessiond?.port !== undefined;
  const hasUrl = fileSessiond?.url !== undefined;
  if (hasPort && !hasUrl) return sessiondUrlOverridden ? undefined : "missing-dial-target";
  if (!hasPort && hasUrl) return listener?.kind === "tcp" && listener.portSource === "env" ? undefined : "missing-bind-port";
  return undefined;
}

export function coherenceWarningMessage(issue: SessiondCoherenceIssue): string {
  if (issue === "missing-dial-target") {
    return "sessiond.port is configured, but no sessiond.url is set and PI_WEBUI_SESSIOND_URL is not set on that machine, so the web/API will dial the session daemon socket while the daemon listens on TCP. Add sessiond.url or remove sessiond.port.";
  }
  return "sessiond.url is configured, but no sessiond.port is set and PI_WEBUI_SESSIOND_PORT is not set on that machine, so the daemon will listen on the session daemon socket. Add sessiond.port or remove sessiond.url.";
}

export function activationState(
  fileSessiond: PiWebUiSessiondConfig | undefined,
  listener: PiWebUiSessiondListenerDescriptor | undefined,
): SessiondActivationState {
  if (listener === undefined) return "unavailable";
  if (fileSessiond?.port === undefined) {
    if (listener.kind === "socket") return "active";
    return listener.portSource === "env" ? "overridden" : "restart-required";
  }
  const desiredHost = fileSessiond.host?.trim() || "127.0.0.1";
  if (listener.kind === "socket") return "restart-required";
  if (desiredHost === listener.host && fileSessiond.port === listener.port) return "active";
  const influenced =
    (desiredHost !== listener.host && listener.hostSource === "env")
    || (fileSessiond.port !== listener.port && listener.portSource === "env");
  return influenced ? "overridden" : "restart-required";
}
```

Inside `mergeSelectedMachineSessiondConfig`, add this member to the reconstructed `envOverrides` object after `agentSessionDir`:

```ts
    sessiondUrl: selectedMachine.envOverrides.sessiondUrl ?? false,
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/components/settings/settingsSessiondConfig.test.ts`
Expected: PASS, including the updated full-object merge expectation and the pre-existing agent-profile cases.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/client/src/api.ts src/client/src/components/settings/settingsSessiondConfig.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/api.ts src/client/src/components/settings/settingsSessiondConfig.ts src/client/src/components/settings/settingsSessiondConfig.test.ts
git commit -m "feat(client): add listener coherence and activation helpers"
```

## Task 9: Session daemon panel listener block

**Lane:** client-panel

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/settings/SettingsSessiondPanel.ts:1-18` (imports and the `sessiondListener` property)
- Modify: `src/client/src/components/settings/SettingsSessiondPanel.ts:39-55` (compute listener state in `render`)
- Modify: `src/client/src/components/settings/SettingsSessiondPanel.ts:58-72` (insert the listener block after `.config-path-card`)
- Modify: `src/client/src/components/settings/SettingsSessiondPanel.ts:210-240` (styles) and `:290-302` (verdict label helper)
- Test: `src/client/src/components/settings/SettingsSessiondPanel.test.ts:1-13` (jsdom pragma and comment), `:147-158` (config response helper gains overrides/effective parameters), and append the new describe block

**Interfaces:**

- Consumes: `PiWebUiSessiondListenerDescriptor` from Task 1 via `../../api`; from Task 8: `activationState(fileSessiond: PiWebUiSessiondConfig | undefined, listener: PiWebUiSessiondListenerDescriptor | undefined): SessiondActivationState`, `coherenceWarning(fileSessiond: PiWebUiSessiondConfig | undefined, sessiondUrlOverridden: boolean, listener: PiWebUiSessiondListenerDescriptor | undefined): SessiondCoherenceIssue | undefined`, `coherenceWarningMessage(issue: SessiondCoherenceIssue): string`, and `type SessiondActivationState = "active" | "overridden" | "restart-required" | "unavailable"`.
- Produces: `SettingsSessiondPanel.sessiondListener: PiWebUiSessiondListenerDescriptor | undefined` (`@property({ attribute: false })`); a read-only `<section class="listener-card" aria-label="Session daemon listener summary">` inside the `config !== undefined` branch with the six pinned rows, per-value `environment override` badges, the verdict label, and the recomputed coherence warning; no input, no draft state, and no mutation.

- [ ] **Step 1: Update the failing panel tests**

In `src/client/src/components/settings/SettingsSessiondPanel.test.ts`, add the jsdom pragma as the first line:

```ts
// @vitest-environment jsdom
```

replace the existing explanatory comment block with:

```ts
// Notice composition and description strings are asserted through the exported
// pure seams; the listener block is asserted with a real jsdom shadow-DOM
// harness because it is rendered, user-visible state. Static layout and styling
// remain unasserted.
```

extend the vitest import with `afterEach`, extend the type import with `PiWebUiSessiondListenerDescriptor`, and change the local `configResponse` helper to:

```ts
function configResponse(
  config: PiWebUiConfigValues,
  overrides: Partial<PiWebUiConfigResponse["envOverrides"]> = {},
  effectiveConfig: PiWebUiConfigValues = config,
): PiWebUiConfigResponse {
  return {
    path: "/tmp/pi-webui/config.json",
    exists: true,
    config,
    effectiveConfig,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, ...overrides },
  };
}
```

Then append this block at the end of the file:

```ts
describe("session daemon panel listener block", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function tcp(host: string, port: number, hostSource: "env" | "config" | "default", portSource: "env" | "config"): PiWebUiSessiondListenerDescriptor {
    return { kind: "tcp", host, port, hostSource, portSource };
  }

  async function mountListenerPanel(config: PiWebUiConfigResponse, listener?: PiWebUiSessiondListenerDescriptor): Promise<SettingsSessiondPanel> {
    const panel = new SettingsSessiondPanel();
    panel.configResponse = config;
    if (listener !== undefined) panel.sessiondListener = listener;
    document.body.append(panel);
    await panel.updateComplete;
    return panel;
  }

  function listenerRoot(panel: SettingsSessiondPanel): ShadowRoot {
    const root = panel.shadowRoot;
    if (root === null) throw new Error("Expected an open shadow root");
    return root;
  }

  function listenerRows(panel: SettingsSessiondPanel): Element[] {
    return [...listenerRoot(panel).querySelectorAll(".listener-card dl > div")];
  }

  function rowValue(panel: SettingsSessiondPanel, label: string): string | undefined {
    for (const row of listenerRows(panel)) {
      if (row.querySelector("dt")?.textContent === label) return row.querySelector("dd")?.textContent?.trim();
    }
    return undefined;
  }

  function rowBadges(panel: SettingsSessiondPanel, label: string): string[] {
    for (const row of listenerRows(panel)) {
      if (row.querySelector("dt")?.textContent === label) {
        return [...row.querySelectorAll(".override-badge")].map((badge) => badge.textContent ?? "");
      }
    }
    return [];
  }

  it("renders the read-only listener rows", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    const panel = await mountListenerPanel(configResponse({ sessiond }, {}, { sessiond }), tcp("0.0.0.0", 8810, "config", "config"));
    const text = listenerRoot(panel).textContent ?? "";

    expect(text).toContain("Desired bind address");
    expect(text).toContain("Running bind address");
    expect(text).toContain("Web/API dial target");
    expect(text).toContain("0.0.0.0");
    expect(text).toContain("http://127.0.0.1:8810");
    expect(text).toContain("✓ daemon in sync");
    expect(rowValue(panel, "Running bind port")).toBe("8810");
    expect(listenerRoot(panel).querySelectorAll(".listener-card input, .listener-card button")).toHaveLength(0);
  });

  it("renders each verdict and the unavailable state", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810 };
    const overridden = await mountListenerPanel(configResponse({ sessiond }), tcp("127.0.0.1", 8810, "env", "config"));
    expect(listenerRoot(overridden).textContent).toContain("one or more listener values come from the environment");

    document.body.replaceChildren();
    const restart = await mountListenerPanel(configResponse({ sessiond }), tcp("127.0.0.1", 9000, "config", "config"));
    expect(listenerRoot(restart).textContent).toContain("⚠ restart required");

    document.body.replaceChildren();
    const unavailable = await mountListenerPanel(configResponse({ sessiond }));
    expect(rowValue(unavailable, "Running bind address")).toBe("Unavailable");
    expect(rowValue(unavailable, "Running bind port")).toBe("Unavailable");
    expect(rowValue(unavailable, "Listener status")).toBe("");
    expect(listenerRoot(unavailable).textContent).not.toContain("✓");
  });

  it("badges environment-sourced values only", async () => {
    const sessiond = { url: "http://127.0.0.1:8810" };
    const panel = await mountListenerPanel(
      configResponse({ sessiond }, { sessiondUrl: true }, { sessiond }),
      tcp("0.0.0.0", 8810, "env", "env"),
    );

    expect(rowBadges(panel, "Running bind address")).toEqual(["environment override"]);
    expect(rowBadges(panel, "Running bind port")).toEqual(["environment override"]);
    expect(rowBadges(panel, "Web/API dial target")).toEqual(["environment override"]);
    expect(rowBadges(panel, "Desired bind address")).toEqual([]);
    expect(rowBadges(panel, "Desired bind port")).toEqual([]);
  });

  it("renders and suppresses the dial-target coherence warning", async () => {
    const panel = await mountListenerPanel(configResponse({ sessiond: { port: 8810 } }));
    expect(listenerRoot(panel).textContent).toContain("Add sessiond.url or remove sessiond.port.");

    panel.configResponse = configResponse({ sessiond: { port: 8810 } }, { sessiondUrl: true });
    await panel.updateComplete;

    expect(listenerRoot(panel).textContent).not.toContain("Add sessiond.url or remove sessiond.port.");
  });

  it("suppresses the bind half once the daemon reports an environment port", async () => {
    const panel = await mountListenerPanel(configResponse({ sessiond: { url: "http://127.0.0.1:8810" } }));
    expect(listenerRoot(panel).textContent).toContain("Add sessiond.port or remove sessiond.url.");

    panel.sessiondListener = tcp("127.0.0.1", 8810, "config", "env");
    await panel.updateComplete;

    expect(listenerRoot(panel).textContent).not.toContain("Add sessiond.port or remove sessiond.url.");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/settings/SettingsSessiondPanel.test.ts`
Expected: FAIL, `sessiondListener` is not a property and the listener card is absent (marker assertions fail).

- [ ] **Step 3: Implement the panel block**

In `src/client/src/components/settings/SettingsSessiondPanel.ts`, extend the `../../api` type import with `PiWebUiSessiondListenerDescriptor` and change the `./settingsSessiondConfig` import to:

```ts
import { activationState, agentDirFieldOverridden, agentProfileActivationState, coherenceWarning, coherenceWarningMessage, spawnSessionsConfigPatch, subsessionsConfigPatch, type SessiondActivationState } from "./settingsSessiondConfig";
```

Add this property immediately after `activeAgentProfile`:

```ts
  @property({ attribute: false }) sessiondListener: PiWebUiSessiondListenerDescriptor | undefined;
```

In `render()`, immediately after the `const profileActivation = ...` line, add:

```ts
    const fileSessiond = config?.config.sessiond;
    const listener = this.sessiondListener;
    const listenerActivation = activationState(fileSessiond, listener);
    const coherenceIssue = coherenceWarning(fileSessiond, config?.envOverrides.sessiondUrl === true, listener);
```

Inside the `config !== undefined` template branch, insert this section immediately after the closing `</div>` of `.config-path-card` and before the `<form class="profile-form" ...>` element:

```html
          <section class="listener-card" aria-label="Session daemon listener summary">
            <h3>Listener</h3>
            <dl>
              <div>
                <dt>Desired bind address</dt>
                <dd>${fileSessiond?.port === undefined ? "Unix socket" : (fileSessiond.host ?? "127.0.0.1")}</dd>
              </div>
              <div>
                <dt>Desired bind port</dt>
                <dd>${fileSessiond?.port === undefined ? "Unix socket" : String(fileSessiond.port)}</dd>
              </div>
              <div>
                <dt>Running bind address</dt>
                <dd>
                  ${listener === undefined ? html`<span class="muted">Unavailable</span>` : listener.kind === "socket" ? "Unix socket" : listener.host}
                  ${listener !== undefined && listener.kind === "tcp" && listener.hostSource === "env" ? html`<span class="override-badge">environment override</span>` : null}
                </dd>
              </div>
              <div>
                <dt>Running bind port</dt>
                <dd>
                  ${listener === undefined ? html`<span class="muted">Unavailable</span>` : listener.kind === "socket" ? "Unix socket" : String(listener.port)}
                  ${listener !== undefined && listener.kind === "tcp" && listener.portSource === "env" ? html`<span class="override-badge">environment override</span>` : null}
                </dd>
              </div>
              <div>
                <dt>Web/API dial target</dt>
                <dd>
                  ${config.effectiveConfig.sessiond?.url ?? "Unix socket"}
                  ${config.envOverrides.sessiondUrl === true ? html`<span class="override-badge">environment override</span>` : null}
                </dd>
              </div>
              <div>
                <dt>Listener status</dt>
                <dd>${listenerActivationLabel(listenerActivation)}</dd>
              </div>
            </dl>
            ${coherenceIssue === undefined ? null : html`<p class="listener-warning">${coherenceWarningMessage(coherenceIssue)}</p>`}
          </section>
```

In `static override styles`, add `.listener-card` to the shared card selector so it reads:

```css
    .loading-card, .config-path-card, .effective-card, .listener-card, .profile-support-message { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
```

then add:

```css
    .listener-card { display: grid; gap: 10px; }
    .listener-card dl { display: grid; gap: 8px; margin: 0; }
    .listener-card dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; align-items: baseline; }
    .listener-warning { margin: 0; color: var(--pi-warning); line-height: 1.45; }
```

and change the narrow-viewport rule to cover both cards:

```css
    @media (max-width: 760px) {
      .effective-card dl > div, .listener-card dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
    }
```

Immediately above `function profileActivationLabel`, add:

```ts
function listenerActivationLabel(state: SessiondActivationState): string | undefined {
  if (state === "active") return "✓ daemon in sync";
  if (state === "overridden") return "⚠ one or more listener values come from the environment, so the config file cannot take full effect until the environment changes";
  if (state === "restart-required") return "⚠ restart required";
  return undefined;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/components/settings/SettingsSessiondPanel.test.ts`
Expected: PASS, including the pre-existing notice and save-behavior cases.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/client/src/components/settings/SettingsSessiondPanel.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/settings/SettingsSessiondPanel.ts src/client/src/components/settings/SettingsSessiondPanel.test.ts
git commit -m "feat(settings): render the read-only session daemon listener block"
```

## Task 10: SettingsDialog listener binding

**Lane:** client-panel

**Implementer tier:** Fast

**Files:**

- Modify: `src/client/src/components/SettingsDialog.ts:195-206` (add `.sessiondListener` immediately after `.activeAgentProfile`)
- Test: `src/client/src/components/SettingsDialog.sessiond.test.ts:1-6` (add the `TemplateResult` type import) and append the new test and helpers

**Interfaces:**

- Consumes: `SettingsSessiondPanel.sessiondListener: PiWebUiSessiondListenerDescriptor | undefined` (`@property({ attribute: false })`) from Task 9; the already-loaded `machineRuntime` refreshed by `reloadSessiondState`.
- Produces: in `renderActiveSection`, the `settings-sessiond-panel` binding list gains exactly `.sessiondListener=${this.machineRuntime?.components?.sessiond.sessiondListener}` immediately after `.activeAgentProfile=${...}`; no logic change.

- [ ] **Step 1: Write the failing test**

In `src/client/src/components/SettingsDialog.sessiond.test.ts`, add this import next to the existing imports:

```ts
import type { TemplateResult } from "lit";
```

Insert this test immediately before the closing `});` of the last `describe(...)` block in the file:

```ts
  it("binds the daemon listener descriptor into the session daemon panel", () => {
    const listener = { kind: "tcp" as const, host: "0.0.0.0", port: 8810, hostSource: "config" as const, portSource: "config" as const };
    const dialog = new SettingsDialog();
    dialog.section = "sessiond";
    dialog.machineRuntime = {
      machineId: "local",
      ok: true,
      checkedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", available: true, capabilities: [] },
        sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [], sessiondListener: listener },
      },
      capabilities: [],
    };

    expect(templateValueAfterMarker(renderActiveSection(dialog), ".sessiondListener=")).toEqual(listener);
  });
```

Append these helpers at the end of the file:

```ts
function renderActiveSection(dialog: SettingsDialog): TemplateResult {
  const render: unknown = Reflect.get(dialog, "renderActiveSection");
  if (typeof render !== "function") throw new Error("SettingsDialog.renderActiveSection is not callable");
  const result: unknown = Reflect.apply(render, dialog, []);
  if (!isTemplateResult(result)) throw new Error("SettingsDialog.renderActiveSection did not return a template");
  return result;
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

function templateValueAfterMarker(template: TemplateResult, marker: string): unknown {
  const index = template.strings.findIndex((text) => text.includes(marker));
  if (index === -1) throw new Error(`Template marker not found: ${marker}`);
  return template.values[index];
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/SettingsDialog.sessiond.test.ts`
Expected: FAIL, `Template marker not found: .sessiondListener=`.

- [ ] **Step 3: Add the binding**

In `src/client/src/components/SettingsDialog.ts` inside `renderActiveSection`, add this line immediately after `.activeAgentProfile=${this.machineRuntime?.components?.sessiond.activeAgentProfile}`:

```ts
          .sessiondListener=${this.machineRuntime?.components?.sessiond.sessiondListener}
```

No other line changes.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/components/SettingsDialog.sessiond.test.ts`
Expected: PASS, including every pre-existing session-daemon targeting, loading, and saving case.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.sessiond.test.ts
git commit -m "feat(settings): feed the daemon listener report into the panel"
```

## Task 11: Documentation and changeset

**Lane:** docs-release

**Implementer tier:** Standard

**Files:**

- Modify: `docs/config.md:157-171` (move the three listener rows into the config-file table and delete them from the runtime-only table)
- Modify: `docs/config.md:255` (insert `### Session daemon listener` after the agent-profile section, before `### Models and skills`)
- Modify: `docs/config.html:410-524` (mirror the row moves)
- Modify: `docs/config.html:681-684` (insert the equivalent section before the `Models and skills` section)
- Modify: `docs/install.html:215-224` (add config-file listener guidance to `Remote access`)
- Create: `.changeset/sessiond-listener-config.md`

**Interfaces:**

- Consumes: the config surface from Tasks 1-3; the listener/provenance behavior and restart requirement from Tasks 4-6; the verdict labels, row labels, and coherence messages from Tasks 8-10.
- Produces: synchronized `docs/config.md` and `docs/config.html` claims, `docs/install.html` listener guidance, and one minor Changeset. `README.md` and `CHANGELOG.md` are not edited.

- [ ] **Step 1: Confirm the docs do not carry the listener keys yet**

Run: `grep -c "sessiond.host" docs/config.md docs/config.html docs/install.html`
Expected: no output for `docs/config.md`, `docs/config.html`, and `docs/install.html`; the command exits nonzero because there are no matches. That is the red state for this task.

- [ ] **Step 2: Update `docs/config.md`**

In the configuration matrix, insert these three rows after the `Tracked subsessions` row and before the `Model tier routing ladder` row:

```markdown
| Session daemon bind host | `sessiond.host` | `PI_WEBUI_SESSIOND_HOST` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Session daemon bind port | `sessiond.port` | `PI_WEBUI_SESSIOND_PORT` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Web/API to session daemon URL | `sessiond.url` | `PI_WEBUI_SESSIOND_URL` | Global/web/API | Not supported locally | Restart web/API |
```

Delete the three rows `Session daemon TCP port`, `Session daemon TCP host`, and `Web-to-daemon URL` from the runtime-only environment variables table. Keep the `Session daemon socket` row unchanged.

Insert this section immediately after the agent-profile section (after the paragraph ending `...establish the next active profile.`) and before `### Models and skills`:

~~~~markdown
### Session daemon listener

`sessiond` describes the two ends of one connection in the global config file. `sessiond.host` and `sessiond.port` configure the session daemon bind address; `sessiond.url` configures the web/API dial target. `sessiond.host` is inert without a port, and an absent `sessiond.port` still means the unix socket.

```json
{
  "sessiond": {
    "host": "0.0.0.0",
    "port": 8810,
    "url": "http://127.0.0.1:8810"
  }
}
```

`sessiond.host` and `sessiond.port` are read by the session daemon; `sessiond.url` is read by the web/API. Environment variables remain authoritative over the file for all three: `PI_WEBUI_SESSIOND_HOST`, `PI_WEBUI_SESSIOND_PORT`, and `PI_WEBUI_SESSIOND_URL`. An empty or whitespace-only string means absent on all three, so a file value still applies when its environment variable is blank. The daemon resolves its listener from the file subtree plus its own environment and reports the effective values with per-value provenance.

**Settings → Session daemon** shows the desired bind address and port, the running listener, the web/API dial target, an `environment override` badge on each value the environment supplies, and the listener status: `✓ daemon in sync` when the running listener matches the file, an environment-override explanation when a differing value comes from the environment, `⚠ restart required` when a restart would apply the file, or no verdict while the daemon cannot report a listener. Exactly one of `sessiond.port`/`sessiond.url` present is a warning rather than an error: the panel names the missing half, and it suppresses a half that the owning process's environment actually resolves.

A configured `sessiond.host` of `""` or whitespace now means absent, so the daemon binds `127.0.0.1` instead of the wildcard address. Set `sessiond.host` (or `PI_WEBUI_SESSIOND_HOST`) to `0.0.0.0` explicitly for a wildcard bind. A non-loopback bind needs a firewall, VPN, or authenticated reverse proxy that strictly controls the port.

Both processes resolve transport at startup, so apply changes with a restart: `pi-webui-sessiond.service` on that machine for `sessiond.host`/`sessiond.port`, and the web/API for `sessiond.url`. Use `8810` as a safe `sessiond.port` choice; `vite.config.ts` reserves `8809` with `strictPort: true` for the dev client, so a machine running the dev client cannot use `8809` for the daemon.
~~~~

- [ ] **Step 3: Update `docs/config.html`**

In the config-file table, insert these three rows after the `Tracked subsessions` row and before the `Model tier routing ladder` row:

```html
                    <tr>
                      <td>Session daemon bind host</td>
                      <td><code>sessiond.host</code></td>
                      <td><code>PI_WEBUI_SESSIOND_HOST</code></td>
                      <td>Global/session daemon</td>
                      <td>Not supported locally</td>
                      <td>Restart session daemon on that machine</td>
                    </tr>
                    <tr>
                      <td>Session daemon bind port</td>
                      <td><code>sessiond.port</code></td>
                      <td><code>PI_WEBUI_SESSIOND_PORT</code></td>
                      <td>Global/session daemon</td>
                      <td>Not supported locally</td>
                      <td>Restart session daemon on that machine</td>
                    </tr>
                    <tr>
                      <td>Web/API to session daemon URL</td>
                      <td><code>sessiond.url</code></td>
                      <td><code>PI_WEBUI_SESSIOND_URL</code></td>
                      <td>Global/web/API</td>
                      <td>Not supported locally</td>
                      <td>Restart web/API</td>
                    </tr>
```

Delete the three `<tr>` blocks for `Session daemon TCP port`, `Session daemon TCP host`, and `Web-to-daemon URL` from the runtime-only environment variables table. Keep the `Session daemon socket` row unchanged.

Insert this section immediately before the `<section>` element that contains `<h2>Models and skills</h2>`:

```html
            <section id="session-daemon-listener">
              <h2>Session daemon listener</h2>
              <p>
                <code>sessiond</code> describes the two ends of one connection in the global config file.
                <code>sessiond.host</code> and <code>sessiond.port</code> configure the session daemon bind address;
                <code>sessiond.url</code> configures the web/API dial target. <code>sessiond.host</code> is inert without a
                port, and an absent <code>sessiond.port</code> still means the unix socket.
              </p>
              <div class="code-card">
                <div class="copy-row">
                  <strong>Session daemon listener</strong>
                  <button class="copy-button" data-copy="#sessiond-listener">Copy</button>
                </div>
                <pre id="sessiond-listener"><code>{
  "sessiond": {
    "host": "0.0.0.0",
    "port": 8810,
    "url": "http://127.0.0.1:8810"
  }
}</code></pre>
              </div>
              <p>
                <code>sessiond.host</code> and <code>sessiond.port</code> are read by the session daemon;
                <code>sessiond.url</code> is read by the web/API. Environment variables remain authoritative over the file
                for all three: <code>PI_WEBUI_SESSIOND_HOST</code>, <code>PI_WEBUI_SESSIOND_PORT</code>, and
                <code>PI_WEBUI_SESSIOND_URL</code>. An empty or whitespace-only string means absent on all three, so a file
                value still applies when its environment variable is blank. The daemon resolves its listener from the file
                subtree plus its own environment and reports the effective values with per-value provenance.
              </p>
              <p>
                <strong>Settings → Session daemon</strong> shows the desired bind address and port, the running listener,
                the web/API dial target, an <code>environment override</code> badge on each value the environment supplies,
                and the listener status: <code>✓ daemon in sync</code> when the running listener matches the file, an
                environment-override explanation when a differing value comes from the environment,
                <code>⚠ restart required</code> when a restart would apply the file, or no verdict while the daemon cannot
                report a listener. Exactly one of <code>sessiond.port</code>/<code>sessiond.url</code> present is a warning
                rather than an error: the panel names the missing half, and it suppresses a half that the owning process's
                environment actually resolves.
              </p>
              <p>
                A configured <code>sessiond.host</code> of <code>""</code> or whitespace now means absent, so the daemon
                binds <code>127.0.0.1</code> instead of the wildcard address. Set <code>sessiond.host</code> (or
                <code>PI_WEBUI_SESSIOND_HOST</code>) to <code>0.0.0.0</code> explicitly for a wildcard bind. A
                non-loopback bind needs a firewall, VPN, or authenticated reverse proxy that strictly controls the port.
              </p>
              <p>
                Both processes resolve transport at startup, so apply changes with a restart:
                <code>pi-webui-sessiond.service</code> on that machine for <code>sessiond.host</code>/<code>sessiond.port</code>,
                and the web/API for <code>sessiond.url</code>. Use <code>8810</code> as a safe <code>sessiond.port</code>
                choice; <code>vite.config.ts</code> reserves <code>8809</code> with <code>strictPort: true</code> for the dev
                client, so a machine running the dev client cannot use <code>8809</code> for the daemon.
              </p>
            </section>
```

The user-visible claims in the two files must not diverge.

- [ ] **Step 4: Update `docs/install.html`**

In the `Remote access` section, insert this guidance after the existing `0.0.0.0` exposure callout `</div>` and before the section's closing `</section>`:

```html
              <p>
                To serve the session daemon over TCP on a remote machine, configure both ends in the machine's
                <code>$PI_WEBUI_CONFIG</code> file so they cannot drift apart:
              </p>
              <div class="code-card">
                <div class="copy-row">
                  <strong>Session daemon listener</strong>
                  <button class="copy-button" data-copy="#sessiond-listener">Copy</button>
                </div>
                <pre id="sessiond-listener"><code>{
  "sessiond": {
    "host": "0.0.0.0",
    "port": 8810,
    "url": "http://127.0.0.1:8810"
  }
}</code></pre>
              </div>
              <p>
                Restart the session daemon and the web/API on that machine to apply the change. Use <code>8810</code>:
                the dev client reserves <code>8809</code> with <code>strictPort: true</code>. See
                <a href="config#session-daemon-listener">Session daemon listener</a> for ownership, precedence, and the
                coherence rule.
              </p>
```

Keep the existing SSH-tunnel example and the `0.0.0.0` exposure callout unchanged.

- [ ] **Step 5: Create the changeset**

Create `.changeset/sessiond-listener-config.md` with exactly:

```md
---
"@hyperdreamer/pi-webui": minor
---

Add a `sessiond` config-file section for the session daemon listener. `sessiond.host` and `sessiond.port` configure the daemon bind address and `sessiond.url` configures the web/API dial target; `PI_WEBUI_SESSIOND_HOST`, `PI_WEBUI_SESSIOND_PORT`, and `PI_WEBUI_SESSIOND_URL` still take precedence, and an absent port still means the unix socket. Settings shows the effective listener and whether the running daemon matches it.

Behavior change: an empty or whitespace-only session daemon host now means "absent" and binds `127.0.0.1` instead of the wildcard address. Set `sessiond.host` (or `PI_WEBUI_SESSIOND_HOST`) to `0.0.0.0` explicitly for a wildcard bind.
```

Do not edit `README.md` or `CHANGELOG.md`, do not bump versions, and do not run `npm publish`.

- [ ] **Step 6: Verify the docs and changeset**

Run: `npx changeset status`
Expected: exit 0, the changeset is listed as a minor release for `@hyperdreamer/pi-webui`.

Run: `grep -c "sessiond.host\|sessiond.port\|sessiond.url\|session-daemon-listener" docs/config.md docs/config.html docs/install.html && git diff --check`
Expected: `docs/config.md` and `docs/config.html` each report several matches, `docs/install.html` reports at least two, and `git diff --check` prints nothing and exits 0.

Run: `grep -c "Session daemon TCP port\|Session daemon TCP host\|Web-to-daemon URL" docs/config.md docs/config.html`
Expected: no matches (nonzero exit), because those runtime-only rows were removed.

- [ ] **Step 7: Commit**

```bash
git add docs/config.md docs/config.html docs/install.html .changeset/sessiond-listener-config.md
git commit -m "docs(config): document the sessiond listener and add the release changeset"
```
