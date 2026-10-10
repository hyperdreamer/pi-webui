# Session daemon listener configuration — Design

- **Date:** 2026-10-05
- **Status:** APPROVED at design review attempt 6 (0 blockers); approved for specification
- **Topic slug:** `sessiond-listener-config`
- **PM run:** `pm-run-20261005-102112-3d1c044d`
- **Delivery target:** `refs/heads/main` at `89a06f86568645908d730f17767f191f626cd6db`

## Background

The session daemon's TCP bind address is only configurable through environment variables.
`PI_WEBUI_SESSIOND_HOST` (default `127.0.0.1`) and `PI_WEBUI_SESSIOND_PORT` (no default; an
unset port means the daemon listens on a unix socket) are read inside the `listen()` step in
`src/server/sessiond.ts` from an environment frozen at module load. Because there is no
config-file key for them, the only practical way to bind the daemon to a non-loopback address is
a systemd drop-in.

That produces a concrete, reproducible awkwardness. A two-hop deployment needs three env values
in two unit files:

```ini
# pi-webui-sessiond.service.d/override.conf
Environment=PI_WEBUI_SESSIOND_HOST=0.0.0.0
Environment=PI_WEBUI_SESSIOND_PORT=8810

# pi-webui.service.d/override.conf
Environment=PI_WEBUI_SESSIOND_URL=http://127.0.0.1:8810
```

The bind half is read by the session daemon; the connect half (`PI_WEBUI_SESSIOND_URL`) is read
by the web/API process through `sessiondHttpUrl()` in `src/sessiond/config.ts`. Nothing validates
that the two halves agree. Changing the port in one file and forgetting the other leaves a
healthy-looking daemon that the web/API can never reach. The existing documentation already has
to carry a manual reminder for this (`docs/config.md`: "set `PI_WEBUI_SESSIOND_URL` for web/API
too").

The prompting symptom was the edit cost of the drop-ins. The load-bearing defect is the
unvalidatable split identity.

## Goals

1. Make the session daemon's TCP bind address configurable in the global config file
   (`$PI_WEBUI_CONFIG`, default `~/.config/pi-webui/config.json`), so that a normal deployment
   never needs a systemd drop-in for it.
2. Make the web/API's connect address configurable in the same file, so the bind host, bind port,
   and connect address are described by one artifact that can be validated as a whole.
3. Preserve existing behavior: environment variables remain authoritative over the config file,
   and an unset bind port still means the unix socket.
4. Report a non-blocking coherence warning when the config file describes a listener pair that
   cannot work together.
5. Show the effective listener in the Session daemon settings panel, including whether the
   running session daemon agrees with the configured value and, when it does not, why.

## Non-goals

- **GUI-writable listener settings.** The Session daemon panel displays listener state
  read-only.
- **Auto-deriving `sessiond.url` from `sessiond.host`.** Bind and connect addresses legitimately
  diverge, and deriving one from the other would silently rewrite the intentional `0.0.0.0` bind
  plus loopback dial pairing.
- **A default TCP port for the session daemon.** The daemon is socket-first; adding a
  `DEFAULT_SESSIOND_PORT` would silently move every existing default deployment onto TCP.
  `DEFAULT_PORT = 8808` remains the web/API default only.
- **A config-file key for `PI_WEBUI_SESSIOND_SOCKET`.** The socket path stays env-only. The
  activation comparison deliberately does not compare socket paths for this reason.
- **Reverse-proxy path prefixes in `sessiond.url`.** `SessionDaemonClient` calls
  `new URL(path, this.baseUrl)` with root-absolute paths (`/runtime`, `/sessions/events`), so any
  path component in the URL is discarded. Path prefixes are **not** supported today and this
  design does not add support.
- **Live reconfiguration.** Both processes still resolve transport at startup, so an applied
  change still requires a manual restart. This design changes *where the value is written* and
  *whether the pair and its application can be observed*, not *when it takes effect*.
- **GUI-editable `sessiond.host`/`sessiond.port`/`sessiond.url`.** See "Rejected alternative".

## Behavior contract

### Config shape

One new top-level object in the global config file, alongside `pathAccess`, `agent`, `tts`, and
`speechInput`:

```json
{
  "sessiond": {
    "host": "0.0.0.0",
    "port": 8810,
    "url": "http://127.0.0.1:8810"
  }
}
```

| Key | Type | Consumed by | Meaning |
| --- | --- | --- | --- |
| `sessiond.host` | string | session daemon | Interface to bind. Default `127.0.0.1` when a port is set. Inert without a port. |
| `sessiond.port` | positive integer | session daemon | TCP port to bind. Absent ⇒ unix socket, as today. |
| `sessiond.url` | string | web/API | Absolute `http`/`https` URL the web/API uses to reach the daemon. Absent ⇒ unix socket. |

### Per-process ownership and resolution

Environment overrides the config file. The two halves belong to **different processes**, and each
process resolves its own half from its own inputs, and applies **runtime-semantic** validation only
to the key it consumes:

| Config key | Environment variable | Owned by | Runtime-semantic validation owner |
| --- | --- | --- | --- |
| `sessiond.host` | `PI_WEBUI_SESSIOND_HOST` | session daemon | session daemon |
| `sessiond.port` | `PI_WEBUI_SESSIOND_PORT` | session daemon | session daemon |
| `sessiond.url` | `PI_WEBUI_SESSIOND_URL` | web/API | web/API |

`resolveEffectivePiWebUiConfig` in `src/config.ts` is shared by both processes, so it layers
**only `sessiond.url`** (the web/API-owned key) over the file value. It deliberately does **not**
layer or validate `sessiond.host` or `sessiond.port`. Consequences:

- The web/API's effective config never carries a bind host or port derived from the web/API's own
  environment, so no consumer can mistake it for the daemon's state.
- The daemon resolves host and port from `(file subtree, environment)` in its own helper, which
  yields exact per-value provenance for free (see "Daemon listener reporting").
- A syntactically invalid `sessiond.url` cannot stop the session daemon, whether it comes from
  the file or from the environment, because the daemon never applies URL-form validation to it.

`PI_WEBUI_SESSIOND_URL` validation happens at the connect-resolution seam in
`src/sessiond/config.ts`, which is called only by `SessionDaemonClient` construction. Nothing
validates at module scope: `src/server/sessiond.ts` transitively imports that module
(`sessiond.ts` → `src/server/piWebUiStatus.ts` → `src/sessiond/sessionDaemonClient.ts` →
`src/sessiond/config.ts`), and `sessiondSocketPath()` from the same module is called by the daemon,
so module-level validation would break the daemon.

#### Validation tiers

The guarantee above covers **runtime semantics**, not shape. Three tiers apply, and only the third
is per-process:

| Tier | Examples | Where | Fatal to |
| --- | --- | --- | --- |
| Shape and type | `sessiond` is an object; `host`/`url` are strings; `port` is a number or numeric string; no unknown keys | shared `parsePiWebUiConfig` | any process that loads the config |
| Structural primitive validity | `port` is an integer in `1..65535` (`parsePort`) | shared `parsePiWebUiConfig` | any process that loads the config |
| Runtime semantics | `url` is an absolute `http`/`https` URL with an empty or root path | the consuming process only | the consuming process only |

So `{ "sessiond": { "url": 123 } }` stops any process that loads the config, exactly as a
wrong-typed top-level key does — the type must be representable before any consumer can use it.
`{ "sessiond": { "url": "127.0.0.1:8810" } }` (valid string, invalid URL) stops only the
web/API. Stating this precisely matters because the two read very differently to an operator
debugging a failed start.

### Empty, absent, and default values

String values (`host`, `url`) are trimmed, and a string that is empty or whitespace-only after
trimming is **absent**.

`port` is handled differently on the two paths, and the difference is deliberate:

- **Config file:** the value is not trimmed or normalized. A numeric string is accepted and coerced
  by `parsePort`, the parsed result is always a number, and a blank, whitespace-only, or
  non-numeric value is a config parse error rather than an absent key. JSON can omit a key, so a
  blank is a mistake worth reporting.
- **Environment:** the raw value is trimmed first, and an empty or whitespace-only
  `PI_WEBUI_SESSIOND_PORT` counts as **absent** — not as an override — so a `sessiond.port` in the
  file still applies. Any other value is parsed by the same `parsePort` helper.

| `sessiond.host` (or `PI_WEBUI_SESSIOND_HOST`) | `sessiond.port` (or `PI_WEBUI_SESSIOND_PORT`) | Listener |
| --- | --- | --- |
| absent, `""`, or whitespace | `8810` | `127.0.0.1:8810` |
| `0.0.0.0` | `8810` | `0.0.0.0:8810` |
| absent, `""`, or whitespace | absent | unix socket; no host decision is made |
| `0.0.0.0` | absent | unix socket; the host is inert, and a coherence warning appears only if `sessiond.url` is set |

The same normalization applies in three places and must stay identical in all of them, or a
trivially equivalent file can produce a spurious `restart-required`:

1. the shared file parser, which omits empty-after-trim strings so `config.sessiond` carries the
   same shape the daemon resolves;
2. the env-resolution seam, which treats an empty-after-trim value as unset; and
3. the `PiWebUiConfigEnvOverrides.sessiondUrl` flag, which must use the same trim-aware emptiness
   test. The existing `isEnvSet` helper (`value !== undefined && value !== ""`) is **not**
   trim-aware, so a whitespace-only `PI_WEBUI_SESSIOND_URL` would otherwise be reported as an
   active override while resolution ignores it, suppressing a real warning and showing a
   misleading badge. `sessiondUrl` uses a trim-aware test; the pre-existing `host`, `port`, and
   `allowedHosts` flags keep their current `isEnvSet` behavior, which is out of scope here.

The loopback default is the literal address `127.0.0.1` (IPv4 loopback), not the name
`localhost`. A `sessiond.url` of `http://localhost:<port>` can resolve to `::1`, where nothing is
listening; documentation pairs the default with `http://127.0.0.1:<port>`.

**Behavior change (security tightening).** Today `PI_WEBUI_SESSIOND_HOST=""` is not treated as
absent: `env[...] ?? "127.0.0.1"` passes the empty string to `app.listen`, and this repository's
Fastify binds the unspecified address (`::`, all interfaces) for an empty host. After this change
an empty or whitespace-only host means absent, so the daemon binds loopback instead of every
interface. This fails closed and must be called out in the changeset and the release handoff,
because a deployment relying on `""` for a wildcard bind must switch to `0.0.0.0`.

Non-empty `sessiond.host` values are used as-is; no DNS or interface validation is added.

### Listener semantics

The session daemon resolves its listener as:

1. `sessiond.port` present ⇒ listen on TCP at `sessiond.host ?? "127.0.0.1"`.
2. `sessiond.port` absent ⇒ listen on the unix socket at `sessiondSocketPath()`.

Rule 2 is byte-for-byte today's behavior. `sessiond.host` alone binds nothing.

`sessiond.port` is validated in the shared file parser with the existing `parsePort` helper
(`src/config.ts`), exactly like the top-level `port` key: an integer from `1` to `65535`, a
numeric string such as `"8810"` accepted and coerced, and a blank string, non-numeric string, or
`0` rejected as a config parse error.

The daemon still validates its **environment** port itself, because the shared file parser never
sees it: `PI_WEBUI_SESSIOND_PORT` is trimmed, and an empty or whitespace-only result counts as
absent; any other value is parsed by the same helper (`parsePort` needs exporting from
`src/config.ts`, or an equivalent daemon-side call), and an unparseable or out-of-range value is a
structural error naming the key. So port validity is enforced in two places by one shared rule, not
by two rules.

**`0` is rejected** rather than treated as an ephemeral bind, because the listener descriptor is
resolved before `app.listen` runs (see "Daemon listener reporting") and therefore could not report
the OS-assigned port; an ephemeral bind would also be unreachable by any configured
`sessiond.url`. `parsePort`'s existing `1..65535` range already excludes it.

A blank `sessiond.port` in the config file is therefore an error, not "absent": JSON can omit a
key, so a blank string there is a mistake, and silently flipping the transport from TCP to a unix
socket is precisely the class of silent transport change this design exists to remove. In the
**environment**, by contrast, `PI_WEBUI_SESSIOND_PORT=""` means absent and yields the unix socket,
preserving the current `portValue !== ""` guard; an empty env var is a conventional way to express
"unset".

### Connect semantics

The web/API resolves its connect target as:

1. `sessiond.url` present and non-empty ⇒ HTTP requests and WebSockets over TCP against that URL.
2. otherwise ⇒ HTTP requests and WebSockets over the unix socket at `sessiondSocketPath()`.

`sessiond.url` is validated as: absolute `http:` or `https:` scheme, non-empty host, optional
port, path empty or `/`, and no credentials, query, or hash. This is deliberately stricter than
the machine base-URL rule in `machineService.validateBaseUrl`, which tolerates path components:
`SessionDaemonClient` discards any path by calling `new URL(path, baseUrl)` with root-absolute
paths, so accepting a prefix here would acknowledge a configuration the transport cannot honor.
The new rule rejects exactly the forms this transport cannot express rather than silently
discarding them.

This preserves both branches of `SessionDaemonClient.request` and
`SessionDaemonClient.connectWebSocket`. `baseUrl` and `socketPath` remain construction-time
`readonly` fields, so the resolved transport is stable for the process lifetime, which is what
makes the activation verdict meaningful rather than transient.

### Listener coherence warning

`sessiond.url` and `sessiond.port` describe the two ends of one connection, so the **config file**
is incoherent when exactly one of them is present. The rule is bidirectional and reads
config-file presence only:

| `sessiond.port` in file | `sessiond.url` in file | Warning |
| --- | --- | --- |
| absent | absent | none (unix socket; the healthy default) |
| present | present | none |
| present | absent | a TCP listener cannot be reached over the socket |
| absent | present | the daemon will listen on a socket while the web/API dials TCP |

The warning is computed **client-side** by a pure helper that receives:

- the file `sessiond` subtree (from the read projection),
- `PiWebUiConfigEnvOverrides.sessiondUrl` (the web/API's own override flag),
- the daemon listener descriptor, when the daemon reports one.

There is deliberately **no `sessiondError` field on `PiWebUiConfigResponse`**. The suppression
signal for the bind half is daemon-reported provenance, which travels on
`PiWebUiRuntimeComponent.sessiondListener` — a different contract from the config response. A
response-level string could not express which half was suppressed and where the signal came from.

Suppression is per half, using the signal owned by the process that holds that half:

| Half | Suppressed when |
| --- | --- |
| url half (`port` set, `url` absent) | the trim-aware `envOverrides.sessiondUrl` flag is true — the web/API owns the URL |
| host/port half (`url` set, `port` absent) | the daemon reports `portSource === "env"` — only a port override can keep a TCP listener alive when the file names no port; a `hostSource` override is irrelevant, because a host never creates a listener |

The two halves resolve on different schedules, and the behavior while the daemon report is still
unknown is specified rather than left implicit:

- The warning is computed from the file as soon as the config response is available, because it
describes the file, not the daemon.
- The bind half is **not** suppressed while no listener report is available. Suppression is a
  claim that an override resolves the incoherence, and that claim must not be asserted on
  absent evidence.
- Consequence: on first load there can be one status-poll interval during which the bind half is
  shown before the report arrives and suppresses it. Accepted, and it is the only direction the
  transient can go — the row never claims "resolved" before it can prove it.
- For a daemon that never reports a listener (an older daemon), the bind half is never suppressed
  and the warning persists. This is a transitional false positive, recorded in the rolling
  compatibility table.

A file whose incoherence is genuinely resolved by an override therefore has that half suppressed
and badged as an override rather than reported as a failure. The file is never described as
"still incoherent" once the owning process reports an override that resolves it.

The web/API's own `PI_WEBUI_SESSIOND_HOST`/`_PORT` values are never used as a suppression signal,
because they describe the responding process rather than the daemon and would produce a false
verdict in exactly the split-unit deployment this feature exists to serve.

A file-level incoherence that an environment override legitimately resolves is suppressed for
that half, as the table above states. The panel explains that an override is in effect and badges
the overriding value rather than asserting a failure, and it never reports a configuration as
correct that it has not verified.

### Activation state

The panel compares a **desired** listener derived from the displayed machine's config file against
the daemon's **actual** reported listener. The file is used for the desired side because it is the
artifact the user edits and the only one both processes share; the daemon report is used for the
actual side and is never overwritten by web/API-local environment state.

Desired (file-only, no environment), using the **same normalization as the daemon** so that a
trivially equivalent file value cannot produce a spurious `restart-required`. The parser already
omits empty-after-trim strings, so the desired side is:

- `sessiond.port` absent ⇒ `{ kind: "socket" }`
- `sessiond.port` present ⇒ `{ kind: "tcp", host: sessiond.host ?? "127.0.0.1", port }`

Because the parse step omits an empty or whitespace-only `host`, the `?? "127.0.0.1"` default
covers both "key absent" and "key blank", and the client never has to re-apply trimming. A
defensive `?.trim() || undefined` in the client helper is still specified as a belt-and-braces
guard against a remote gateway that predates the normalization.

Actual: the daemon descriptor.

**Environment influence is row-aware, not a single global predicate.** A host override cannot
produce or preserve a TCP listener on its own (invariant 3), so the two matrix families must test
different things:

- **Same-kind TCP difference**: influence is evaluated **per differing value only** —
  `(desired.host !== actual.host && actual.hostSource === "env") ||`
  `(desired.port !== actual.port && actual.portSource === "env")`. An env-sourced value that the
  file already agrees with cannot explain a disagreement elsewhere in the pair.
- **Desired socket versus actual TCP**: influence is `portSource === "env"` **only**. A host
  environment override cannot explain why the daemon is still on TCP, because the daemon has a
  port at all only because a port came from somewhere.
- **Desired TCP versus actual socket**: never `overridden`. If the daemon bound a socket it
  resolved no port, including no port from the environment, so the only explanation for disagreeing
  with a file that now names a port is that the daemon has not restarted.

The mixed case is reachable and motivates the distinction: a daemon started with `sessiond.port`
in the file and `PI_WEBUI_SESSIOND_HOST` in its unit environment reports
`{ kind: "tcp", portSource: "config", hostSource: "env" }`. Removing `sessiond.port` from the file
then yields desired-socket versus actual-TCP, and restarting with the current file *would* move the
daemon to the socket — so reporting `overridden` ("changing the config file has no effect") would
be actively wrong. The correct verdict is `restart-required`.

The per-differing-value scoping matters in the reverse direction too. A daemon started with
`PI_WEBUI_SESSIOND_PORT=8810` and no `sessiond` object reports
`{ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "env" }`. Adding
`"sessiond": { "host": "0.0.0.0", "port": 8810 }` without restarting gives desired
`0.0.0.0:8810` against actual `127.0.0.1:8810`. Only the host differs, and its source is `default`,
not `env`, so a restart *would* apply the change and the verdict is `restart-required`. A coarse
"any env source" rule would have called this `overridden` and told the operator that changing the
config file has no effect, which is false.

Full verdict matrix, including cross-kind cases:

| Desired | Actual | Environment influence | State |
| --- | --- | --- | --- |
| tcp, equal | tcp, equal | any | `active` |
| tcp | tcp, host differs, port equal | `actual.hostSource === "env"` | `overridden` |
| tcp | tcp, port differs, host equal | `actual.portSource === "env"` | `overridden` |
| tcp | tcp, both differ | either differing value's source is `env` | `overridden` |
| tcp | tcp, different | no differing value has an `env` source | `restart-required` |
| tcp | socket | never applies — the daemon resolved no port | `restart-required` |
| socket | socket | path is not compared | `active` |
| socket | tcp | `portSource === "env"` | `overridden` |
| socket | tcp | `portSource !== "env"` (including `hostSource === "env"`) | `restart-required` |
| any | not reported | — | `unavailable` |

Both cross-kind rows are **reachable, and both are the ordinary result of editing the file without
restarting the daemon**: the daemon reads its config once at startup (see the "Live
reconfiguration" non-goal), so adding `sessiond.port` to the file while the daemon still listens
on the socket produces desired-TCP versus actual-socket, and removing it while the daemon still
listens on TCP produces the reverse. They are the primary reason `restart-required` exists.

- **`active`** — `✓ daemon in sync`
- **`overridden`** — `⚠ one or more listener values come from the environment, so the config file
  cannot take full effect until the environment changes`. Chosen over `restart-required` because a
  restart genuinely will not apply the shadowed value, and instructing an operator to restart and
  then watching nothing change is the failure mode this design exists to remove. The message is
  deliberately phrased about *values* rather than "no effect", because in a both-differ case where
  only the port is env-sourced a restart would still apply the host change.
- **`restart-required`** — `⚠ restart required`
- **`unavailable`** — no verdict rendered; configured values and the coherence warning still
  render.

Socket-versus-socket counts as equal without comparing paths, because the socket path is env-only
and out of scope. `unavailable` is distinct from the panel's existing
`renderUnavailableConfigState`, which fires only when the whole `configResponse` is undefined; an
omitted listener report is narrower and keeps the configured values on screen.

## Architecture

### Config schema and persistence

- `src/shared/apiTypes.ts`: add `PiWebUiSessiondConfig { host?: string; port?: number; url?: string }`
  and `sessiond?: PiWebUiSessiondConfig` on `PiWebUiConfigValues`.
- `src/config.ts` `parsePiWebUiConfig`: parse the `sessiond` subtree in two of the three tiers
  from "Validation tiers" above — shape and type (`sessiond` is an object; `host` and `url` are
  strings; `port` is a number or numeric string; unknown keys rejected), plus structural primitive
  validity for `port` via the existing `parsePort` helper. Strings are trimmed and empty-after-trim strings are
  omitted from the parsed subtree. The third tier, URL form, is **not** applied here; it belongs
  to the web/API connect seam. The existing top-level `host`/`port` keys keep their current
  parse-time behavior; this change does not reorganize them.
- `src/config.ts` `piWebUiConfigRecord`: include `sessiond` when present, so every round-trip
  preserves it. This is the single rule; there is no separate "strip on write" behavior.
- `src/config.ts` `resolveEffectivePiWebUiConfig`: layer **only `PI_WEBUI_SESSIOND_URL`** over
  `sessiond.url`, with the trim/empty-as-absent rule.
- `src/config.ts` `savePiWebUiConfig`: **no delete of `existing["sessiond"]`.** `sessiond` survives
  every unrelated save because it is never deleted and never omitted from a merged record that
  already contains it.

Why the delete must not be added: `PUT /api/config` builds
`{ ...parseConfigRequest(body), ...preservedSpeechInput }` and does **not** spread the current
config. An unconditional `delete existing["sessiond"]` would therefore erase an operator's
listener configuration on any unrelated save — saving the agent profile, toggling a plugin, or any
other settings write.

### Config response projections

Two projections must be separated. They currently share one parser, and only one of them is a
write path:

- **Generic write path (must stay sessiond-free).** `PUT /api/config` is gated by
  `parseConfigRequest`, **not** by `SELECTED_MACHINE_CONFIG_KEYS`. `parseConfigRequest` accepts
  `host`, `port`, `allowedHosts`, `shortcuts`, `plugins`, `pathAccess`, `uploads`,
  `maxUploadBytes`, `modelTiers`, `spawnSessions`, `subsessions`, `agent`, and `tts`. It must
  **not** learn `sessiond`, or sessiond transport becomes browser-writable through the gateway
  config route.
- **Selected-machine write path (unchanged).** `SELECTED_MACHINE_CONFIG_KEYS` continues to drive
  `parseSelectedMachineConfigRequest` and `mergeSelectedMachineConfig`, and continues to exclude
  `sessiond`.
- **Read projection (new, read-only).** `selectedMachineConfigResponse` currently runs
  `pickSelectedMachineConfig` over both `config` and `effectiveConfig`, stripping `sessiond`
  before any panel can see it — locally (`GET /api/machines/local/config`) and remotely
  (`proxySelectedMachineConfigRequest` / `sendSelectedMachineConfigResponse` in
  `src/server/machines/machineProxyRoutes.ts`). A display-only projection adds the `sessiond`
  subtree to `config` and to `effectiveConfig` while leaving every write path untouched.

The remote read path needs a distinct parser: `sendSelectedMachineConfigResponse` parses the
upstream response with `parsePiWebUiConfigResponseBody`, whose `parseConfigRequest` call would drop
`sessiond` before the projection could add it back. A separate read-only sessiond parser is
therefore used by `parsePiWebUiConfigResponseBody` and by the display projection, and
`parseConfigRequest` stays sessiond-free. That parser is reachable only from response parsing and
is never wired into a request body handler.

The generic gateway response (`GET /api/config`, served by `piWebUiConfigResponseFromSnapshot`)
will also begin carrying `sessiond`, because it passes the loaded config through unchanged and
`PiWebUiConfigValues` gains the key. This is deliberate and needs no redaction: it is read-only,
scoped to the local gateway, and exposes only the value the operator wrote in their own config
file. It is called out here so the change is a decision rather than a surprise diff in the
response shape.

### Environment override projection

`PiWebUiConfigEnvOverrides` gains exactly one optional member, `sessiondUrl?: boolean`.

Bind-side flags are deliberately not added. `piWebUiConfigEnvOverrides(env, ...)` computes from the
responding process's environment, which is the web/API, while bind overrides normally live on the
session daemon's unit. Bind provenance comes from the daemon's own report instead.

The member is optional and parsed with `optionalBoolean(...) ?? false`, mirroring `agentCommand`,
so an older remote gateway that omits it cannot fail `parsePiWebUiConfigResponseBody`.

### Session daemon listener resolution

`src/server/sessiond.ts` replaces its inline environment reads with one value resolved from the
**raw loaded config plus the environmental inputs**:

```ts
// pure; (file subtree, env) -> listener + provenance
const listener = sessiondListenerConfig(loadedConfig.sessiond, daemonEnvironment);
// { kind: "tcp", host, port, hostSource, portSource } | { kind: "socket" }
```

The seam takes the loaded file subtree and the environment separately rather than the merged
effective config, because `resolveEffectivePiWebUiConfig` overwrites file values with environment
values and would make an identical `0.0.0.0` from either source indistinguishable. Taking both
inputs is what makes attribution possible, and it keeps the function pure and directly testable.

The raw subtree comes from `loadPiWebUiConfig({ env: daemonEnvironment })`, already imported by
`src/server/sessiond.ts`; the daemon's existing `effectivePiWebUiConfig` read stays for the other
config values it consumes.

Both listener helpers live in a new **importable pure module**, `src/sessiond/listenerConfig.ts`:
`sessiondListenerConfig(subtree, env)` resolves the listener with provenance, and
`sessiondListenOptions(listener, socketPath)` maps it to Fastify listen options (`{ port, host }`
for TCP, `{ path }` for the socket).

The mapper takes the socket path as an explicit second argument because the wire descriptor's
socket branch is deliberately path-free (see "Daemon listener reporting"): that path comes from
`sessiondSocketPath()` in `src/sessiond/config.ts`, which reads the environment and the data
directory and is therefore **not** a pure function of the descriptor. Passing it in keeps the
mapper pure and testable while the reported descriptor stays free of a home-directory path. This
adds no extra resolution work: the daemon's `listen()` step already calls `sessiondSocketPath()` in
its socket branch today. The socket-path argument is ignored on the TCP branch.

They must not live in `src/server/sessiond.ts`, which cannot be imported by a test:
that module runs at top level — it constructs the config-mutation coordinator, builds the Fastify
app, registers plugins, and awaits `runSessionDaemonStartup`, which binds a socket. A pure export
placed there is untestable, and `src/server/sessiond/sessionDaemonStartup.test.ts` only exercises
a fake `listen` callback, so it is not a substitute seam. Keeping the mapping out of the daemon
module also keeps the fastify-shaped options out of the shared descriptor types.

### Daemon listener reporting

The daemon reports what it actually bound **and where each value came from**, so the client can
distinguish "you wrote this" from "the daemon is doing this".

```ts
export type PiWebUiSessiondListenerSource = "env" | "config" | "default";
/** A port has no default, so its source is narrower than the host's. */
export type PiWebUiSessiondPortSource = "env" | "config";

export type PiWebUiSessiondListenerDescriptor =
  | { kind: "tcp"; host: string; port: number;
      hostSource: PiWebUiSessiondListenerSource; portSource: PiWebUiSessiondPortSource }
  | { kind: "socket" };
```

Optional `sessiondListener?: PiWebUiSessiondListenerDescriptor` on `PiWebUiRuntimeComponent`.

The socket branch deliberately carries **no `path`**. The activation comparison does not compare
socket paths, and reporting one would ship a home-directory path across federation to remote
browsers for no benefit. Accepted limitation: the panel therefore cannot detect a daemon bound to
a non-default socket path via `PI_WEBUI_SESSIOND_SOCKET`. That path is env-only and outside this
change's surface, so the row reports the socket form without asserting which path is in use.

**Single resolution, two consumers.** Startup order matters: `createRuntime` builds
`runtimeComponent` with `Object.freeze` and `registerRoutes` exposes
`app.get("/runtime", () => runtimeComponent)` **before** the `listen()` step calls `app.listen`,
so the descriptor cannot be read back from the bound server. Instead, `sessiondListenerConfig` is
resolved once in `createRuntime`, the result is embedded in `runtimeComponent.sessiondListener`,
and the same value is carried on the runtime object into the `listen()` step and converted to
`app.listen` options by a pure mapper. Source attribution is recorded during that single
resolution, so the report cannot disagree with the listener.

The structural precedent is the active-agent-profile descriptor: built by the daemon
(`src/sessiond/activeAgentProfile.ts`), attached to `PiWebUiRuntimeComponent`, and parsed
strictly. `src/shared/piWebUiStatusParsing.ts` gains a sibling parser that rejects the field when
`component !== "sessiond"`, exactly as `activeAgentProfile` does today.

**No capability flag is added.** Field presence is the discriminator, mirroring
`activeAgentProfile`, whose doc comment already states "Present only for a session daemon that
supports active-profile reporting."

No new route is added. The value rides existing transport only: the session daemon's `GET /runtime`
(`src/server/sessiond.ts`) is proxied by the gateway's `GET /api/pi-webui/runtime`
(`src/server/app.ts`), which `MachineService.runtime` consumes — `localRuntime` for the local
machine, and `remoteRuntime` for a remote machine, which fetches *that machine's* own
`GET /api/pi-webui/runtime` (`src/server/machines/machineService.ts`). The browser reads it through
`GET /api/machines/:machineId/runtime` (`src/server/machines/machineRoutes.ts`). `/pi-webui/status` is **not** part of
this chain: it returns `PiWebUiStatusResponse`, whose `components` are `PiWebUiComponentStatus`
values carrying no runtime descriptor.

### Client panel

`src/client/src/components/settings/SettingsSessiondPanel.ts` gains a read-only listener block
beneath the existing `CONFIG FILE` row: bind address, bind port, the web/API dial target, a source
badge per value, and the activation verdict. It reuses the panel's existing `override-badge`
pattern and the desired-vs-active comparison shape of `agentProfileActivationState`. The block is
display-only: no input, no draft state, no entry in any patch builder.

### Files and seams

| File | Change |
| --- | --- |
| `src/shared/apiTypes.ts` | `PiWebUiSessiondConfig`; `sessiond` on `PiWebUiConfigValues`; optional `sessiondUrl` on `PiWebUiConfigEnvOverrides`; listener descriptor types and `sessiondListener` on `PiWebUiRuntimeComponent` |
| `src/config.ts` | shape and primitive parse, trim, empty-string omission, and round-trip of `sessiond`; effective resolution of `sessiond.url` only; **no** delete in `savePiWebUiConfig` |
| `src/sessiond/listenerConfig.ts` | new pure module: `sessiondListenerConfig(subtree, env)` (listener + provenance) and `sessiondListenOptions(listener)` |
| `src/server/sessiond.ts` | resolve the listener once in `createRuntime`; embed the descriptor; carry it into `listen()`; stop reading the host/port env keys inline |
| `src/shared/piWebUiStatusParsing.ts` | strict parser for `sessiondListener`, gated to `component === "sessiond"` |
| `src/server/configRoutes.ts` | read-only sessiond parser; display projection adding `sessiond` to `config`/`effectiveConfig`; `sessiondUrl` in the env-override projection; `parseConfigRequest` unchanged and sessiond-free |
| `src/server/machines/machineProxyRoutes.ts` | remote responses inherit the read projection; no write-path change |
| `src/sessiond/config.ts` | config-aware `sessiondHttpUrl(loadOptions)` with connect-time validation for the web/API only, taking injected `LoadOptions` so tests never read the developer's real config and the resolved dial target matches the displayed one; `SessionDaemonClient` takes those options as a constructor parameter, defaulting to the pinned web/API environment |
| `src/client/src/api/parsers.ts` | `parsePiWebUiConfigValues` (`sessiond`), `parsePiWebUiConfigEnvOverrides` (optional `sessiondUrl`), `parsePiWebUiRuntimeComponent` (`sessiondListener`) |
| `src/client/src/components/settings/settingsSessiondConfig.ts` | carry `sessiond`/`sessiondUrl` through `mergeSelectedMachineSessiondConfig`; add the pure coherence-warning and activation-state helpers |
| `src/client/src/components/settings/SettingsSessiondPanel.ts` | read-only listener block |
| `src/client/src/components/SettingsDialog.ts` | one property binding added (`sessiondListener`, taken from the already-loaded `machineRuntime` refreshed by `reloadSessiondState`) alongside the existing `activeAgentProfile` binding; no logic change |

## Data flow

```
~/.config/pi-webui/config.json  (per machine)
  sessiond.host / sessiond.port ─┐
  PI_WEBUI_SESSIOND_HOST/PORT ───┴─> sessiondListenerConfig(subtree, env)   [pure, src/sessiond/listenerConfig.ts]
                                        ├─> sessiondListenOptions ─> app.listen(TCP)
                                        └─> runtimeComponent.sessiondListener {kind, host, port, sources}
  sessiond.url ─┐
  PI_WEBUI_SESSIOND_URL ─┴─> web/API effective config ─> validate ─> SessionDaemonClient.baseUrl
  (port absent) ───────────> unix socket at sessiondSocketPath()
  (port and url both absent) > unix socket on both sides

daemon GET /runtime
  -> gateway GET /api/pi-webui/runtime
  -> MachineService.runtime: localRuntime (local) | remoteRuntime -> remote gateway /api/pi-webui/runtime (remote)
  -> browser GET /api/machines/:machineId/runtime
  -> PiWebUiRuntimeComponent.sessiondListener
  -> read projection: sessiond {host, port, url} + envOverrides.sessiondUrl
  -> settingsSessiondConfig.ts pure helpers (rendered by SettingsSessiondPanel):
       coherenceWarning(fileSessiond, sessiondUrlOverridden, listener)
       activationState(fileSessiond, listener)
     -> active | overridden | restart-required | unavailable
```

## Rolling compatibility

| Producer | Consumer | Behavior |
| --- | --- | --- |
| Old daemon (no `sessiondListener`) | New panel | Verdict `unavailable`; configured values and the coherence warning still render. Transitional false positive: with no provenance signal, a `url`-in-file plus daemon-only `PI_WEBUI_SESSIOND_PORT` configuration shows the bind-half warning until the daemon is upgraded. |
| New daemon | Old web/API | `parsePiWebUiRuntimeComponent` reconstructs an object from known fields, so the unknown `sessiondListener` is **dropped**, not passed through. Harmless: an older UI cannot render it. |
| Old web/API | New daemon | The field is not projected onward; the local panel sees `unavailable` |
| Older remote gateway without `sessiondUrl` | New client | Optional boolean defaults to `false`; parsing cannot fail |
| Older remote gateway that omits `sessiond` | New client | Subtree absent; desired side is the socket default and the verdict resolves against the daemon report |
| Existing config file with no `sessiond` object | Any version | Behavior unchanged |
| Env-only deployment | New version | Behavior unchanged except the empty-host tightening described below |

## Invariants

1. Environment variables remain authoritative over the config file for all three keys.
2. An absent `sessiond.port`, or a `PI_WEBUI_SESSIOND_PORT` that is unset, empty, or
   whitespace-only, does not by itself mean the unix socket: an empty environment value is **not**
   an override, so a `sessiond.port` present in the config file still applies. Only when neither
   the file nor the environment supplies a port does the daemon bind the unix socket. No code path
   introduces a default TCP port. A blank or non-port `sessiond.port` in the file is a config
   error, never a silent fallback to the socket. The same fallback shaping applies to
   `sessiond.host` and to `sessiond.url`.
3. `sessiond.host` never causes a listener on its own.
4. The daemon resolves its listener exactly once, and the same value feeds both the reported
   descriptor and `app.listen`, so the report cannot drift from the real socket.
5. `sessiondListener` appears only on a `component === "sessiond"` runtime payload.
6. No process applies **runtime-semantic** validation to a key it does not consume. Shape, type,
   and `port`-range validation are shared and fatal to any process that loads the config —
   including the session daemon for a wrong-typed `sessiond.url` — and that is the existing
   behavior for every top-level key. The per-process guarantee is specifically that the
   session daemon never applies URL-form validation, so a syntactically invalid
   `sessiond.url` or `PI_WEBUI_SESSIOND_URL` cannot stop it.
7. `sessiond` is never reachable from a browser write path: `parseConfigRequest` does not know it,
   `SELECTED_MACHINE_CONFIG_KEYS` does not include it, and the read projection that exposes it is
   display-only. No save path removes it from disk.
8. The panel performs no listener mutation; there is no write path from the browser to these keys.
9. A coherence problem is reported, never fatal, and never prevents either process from starting.

## Error handling

| Condition | Behavior |
| --- | --- |
| `sessiond` not an object, or unknown key inside the subtree | Config parse error |
| `sessiond.host` or `sessiond.url` not a string; `sessiond.port` neither a number nor a numeric string | Config parse error |
| `sessiond.port` blank, non-numeric, non-integer, out of range, or `0` | Config parse error via `parsePort`, fatal to any process that loads the config |
| `sessiond.url` in file not an absolute `http`/`https` URL | Structural error in the web/API connect resolution only; the session daemon still starts. A wrong-typed `sessiond.url` is a shared parse error instead, per the validation tiers. |
| `PI_WEBUI_SESSIOND_URL` malformed | Structural error in the web/API connect resolution only; the session daemon still starts |
| `PI_WEBUI_SESSIOND_PORT` empty or whitespace-only | Treated as absent, and **not** as an override, so a `sessiond.port` in the file still applies |
| `PI_WEBUI_SESSIOND_PORT` unparseable or out of range | Structural error naming the key |
| `port` set, `url` absent in file, no env url | Panel coherence warning |
| `url` set, `port` absent in file, no env port | Panel coherence warning |
| Either half supplied by the owning process's environment | That half's warning suppressed; an environment-override badge is shown |
| Daemon reports no listener | Verdict `unavailable`; configured values still render |
| Daemon unreachable | Existing unavailable-config path |
| Daemon reports a different listener with environment influence, per the row-aware matrix above | Verdict `overridden` |
| Daemon reports a different listener with no environment influence, per the row-aware matrix above | Verdict `restart-required` |
| Bind fails (address in use, unusable host) | `app.listen` rejects and the daemon fails to start, unchanged |

## Testing strategy

Layered per the repository testing guide, with red tests written before implementation.

- **Config parsing (`src/config.ts`, node layer):** accept a valid `sessiond` object; reject a
  non-object; reject an unknown key inside the subtree; reject wrong primitive types; trim strings
  and omit an empty or whitespace-only `host`/`url` from the parsed subtree; accept a numeric-string
  `port` and coerce it; reject a blank, non-numeric, out-of-range, or zero `port` via `parsePort`;
  round-trip through `piWebUiConfigRecord`; confirm an absent `sessiond` object leaves existing
  behavior unchanged; confirm the parser does **not** apply URL-form validation, so a relative or
  non-HTTP `url` string is accepted at load and rejected only by the consuming web/API seam.
- **Empty/absent normalization parity:** assert that a file `"host": "  "` and an absent `host`
  produce an identical parsed subtree, so the panel's desired side cannot diverge from the
  daemon's resolution. Assert the same for `"url": ""` and an absent `url`.
- **Persistence regression (pins the attempt-1 defect):** seed a config file containing
  `sessiond`, run an unrelated `savePiWebUiConfig` shaped like `PUT /api/config`
  (`{ spawnSessions: true }`), and assert the parsed `sessiond` subtree is deep-equal to the
  original. Assert on parsed structure, not file bytes: `savePiWebUiConfig` reserializes the whole
  document with `JSON.stringify(merged, null, 2)`.
- **Write-path closure (negative):** through the route-level, file-backed config-service harness,
  send `PUT /api/config` with a body containing `sessiond` and assert the persisted file contains
  no `sessiond` key afterwards. The test must go through the route, because `parseConfigRequest` is
  module-private and cannot be unit-tested directly. This is the test that keeps the new read
  parser from becoming a write surface.
- **Effective resolution:** `sessiond.url` from env overrides file; empty and whitespace env values
  are absent; a whitespace-only `PI_WEBUI_SESSIOND_URL` reports `sessiondUrl: false` in the override
  projection, so it cannot suppress a real warning; `sessiond.host`/`sessiond.port` are **not**
  layered into the web/API's effective config from the web/API's environment.
- **Per-process validation:** a malformed `PI_WEBUI_SESSIOND_URL` fails the web/API connect
  resolution and does **not** fail a daemon-style resolution; a malformed `sessiond.url` in the
  file likewise fails only the web/API.
- **Connect URL validation:** accept `http://127.0.0.1:8810`, `https://host`, and a trailing `/`;
  reject a relative URL, a non-HTTP scheme, credentials, a query, a hash, and a non-root path.
- **Listener resolution (`sessiondListenerConfig`, pure):** TCP when a port is present with the
  `127.0.0.1` default for an absent, empty, or whitespace host; socket otherwise; `host` alone
  yields the socket; `hostSource` attribution for env, config, and default; `portSource`
  attribution for env and config only, since a port has no default; rejection of a non-integer,
  out-of-range, or zero env port; and an empty or whitespace-only env port counting as absent so it
  falls back to the file value.
- **Listen options mapper (`sessiondListenOptions`, pure, in `src/sessiond/listenerConfig.ts`):**
  maps a resolved TCP listener to `{ port, host }` and a socket listener to `{ path }` taken from
  its second argument; assert the socket-path argument is ignored on the TCP branch. This
  replaces an assertion about observing `app.listen` itself, which has no seam:
  `src/server/sessiond/sessionDaemonStartup.test.ts` exercises a fake `listen` callback, and
  `src/server/sessiond.ts` cannot be imported by a test because it binds a socket at module load.
  The mapper test is only writable because the helper was moved out of that module.
- **Coherence warning (pure client helper):** all four file-presence combinations; independent
  suppression per half; the host/port half suppressed by `portSource === "env"` daemon provenance —
  and **not** by `hostSource === "env"` and **not** by web/API-local env; no warning for an
  env-only deployment with no `sessiond` object; and the load-order case — with the listener report
  absent, the bind half is shown rather than suppressed, then suppressed once provenance arrives.
- **Strict runtime parser (`src/shared/piWebUiStatusParsing`):** valid descriptor for `sessiond`;
  legacy omission; malformed descriptor rejected; descriptor on `component === "web"` rejected;
  unknown key inside the descriptor rejected. Session websocket payloads stay additive, so
  strictness is confined to the new nested object.
- **Client parsers (`src/client/src/api/parsers.ts`):** `sessiond` survives
  `parsePiWebUiConfigValues`; a missing `sessiondUrl` override parses as `false`;
  `sessiondListener` survives runtime parsing for both TCP and socket forms.
- **Read projection (`src/server/configRoutes.ts`):** `selectedMachineConfigResponse` carries
  `sessiond`; `parseSelectedMachineConfigRequest` still drops it on the selected-machine write
  path.
- **Remote path:** a remote config response differing from the local one drives the remote desired
  state; the proxy round-trip preserves `sessiond`; a remote `sessiondListener` reaches the panel.
- **Activation state (pure client helper):** every row of the verdict matrix, including
  desired-TCP versus actual-socket, socket versus socket, and the cases that motivate the
  three-state design — a daemon-only **port** override must yield `overridden` for desired-socket
  versus actual-TCP; the mixed case `hostSource: "env"` with `portSource: "config"` must yield
  `restart-required`; and the **crossed** cases must be pinned explicitly with the counter-source
  stated: host differs with port equal while `portSource === "env"` **and `hostSource` is
  `config`/`default`** gives `restart-required`; port differs with host equal while
  `hostSource === "env"` **and `portSource` is `config`** gives `restart-required`. In both, the
  env-sourced value is not the value that differs, which is the whole point of scoping influence
  per differing value.
- **Panel (`SettingsSessiondPanel.test.ts`, Lit):** the row renders bind host, bind port, and dial
  target; each verdict renders; source badges render per value; the coherence warning renders and
  is suppressed per half. Assert rendered output and extract template handlers rather than
  reaching into internals.

Verification: focused Vitest runs, `npm run typecheck`, targeted ESLint, `git diff --check`, then
`npm run verify`.

## Documentation and release

- `docs/config.md`: move the three session daemon rows out of the "Runtime-only environment
  variables" block into the config-file keys block, and add a "Session daemon listener" section
  under "Key details" covering the shape, per-process ownership, precedence, the socket default,
  the empty-host tightening, the coherence rule, and the restart requirement.
- `docs/config.html`: this file mirrors the `docs/config.md` tables by hand and must be updated in
  the same change.
- `docs/install.html`: **add** config-file listener guidance. (No systemd drop-in guidance exists
  in `docs/install.html`, `docs/config.md`, or `README.md` to replace; the only related material is
  the `0.0.0.0` exposure callout and an SSH tunnel example.)
- Port selection note: `vite.config.ts` binds the dev client to `8809` with `strictPort: true`, so
  `8809` is unavailable to a session daemon on a machine that also runs the dev client. Document
  `8810` as a safe choice for `sessiond.port`.
- `README.md`: no change; the README stays a landing page and links to `docs/config.md`.
- A changeset is required: user-visible configuration surface addition **plus** the empty-host
  behavior change, which must be stated explicitly.
- Per `AGENTS.md`, the `/runtime` payload change touches a session-daemon-only code path, so a
  manual session daemon restart is required on deployment. State this in the release handoff.

## Rejected alternative: browser-writable listener settings

Making `sessiond.host`/`sessiond.port`/`sessiond.url` editable in Settings was considered and
rejected.

It is **not** accurate to argue that this would be the first transport-identity setting to be
browser-writable. The web/API's own bind address already is: `SettingsGeneralPanel` saves a
gateway draft (`host`, `port`, `allowedHosts`) through `configApi.saveConfig` to `PUT /api/config`,
and `parseConfigRequest` accepts those keys. The decisive difference is not the allowlist but the
number of processes and their restart schedules:

1. **A single-process bind is safe to edit from the browser; a split bind is not.** Changing the
   web/API's own host/port takes effect on exactly one restart, that process serves the settings
   UI, and a mistake is usually self-evident because the connection the operator is using either
   moves or dies.
2. **Session daemon transport spans two processes on different schedules.** The daemon freezes its
   environment at module load and calls `app.listen` once; `SessionDaemonClient` captures
   `baseUrl`/`socketPath` as construction-time readonly fields. Per `AGENTS.md` the daemon runs
   non-autoreload/non-auto-restart while the UI/API service runs `dev:web` under `tsx watch`.
3. **A GUI write would therefore be half-applied automatically.** Saving a new `sessiond.url` and
   later touching any file under `src/` restarts the web/API, which then constructs a client
   pointed at the new URL while the daemon still listens on the old address. The operator performs
   no restart and cannot correlate the breakage with the setting.
4. **The failure is silent and unrepairable in-UI.** Settings keeps rendering from the web/API, so
   the panel reports success while session operations fail, and recovery needs a shell — including
   for remote machines, where the browser offers no shell.
5. **The panel has no restart control**, so it could neither apply nor verify such a change.

Revisit only if the UI/API runs non-autoreload **and** a supervised restart control can restart
both processes. The daemon listener reporting added here is a prerequisite for *observing* state,
not a licence to make the control writable.

## Risks and residual behavior

| Risk | Assessment |
| --- | --- |
| Users bind `0.0.0.0` more easily, exposing the daemon | Real but bounded. The daemon already has an auth surface, and the change removes a speed bump rather than a control. The panel row and `docs/config.md` must state plainly that a non-loopback bind needs a firewall, VPN, or authenticated reverse proxy, matching the existing callout in `docs/install.html`. |
| The empty-host tightening silently moves a wildcard bind to loopback | The intended fail-closed direction, but it is a behavior change: it must be in the changeset, `docs/config.md`, and the release handoff. |
| Read projection widens what the browser can see | Low. It exposes the machine's own bind address to that machine's own UI and grants no write path. |
| Read parser becomes a write parser by accident | Mitigated by the explicit negative write-path test, which is the reason that test is mandatory rather than optional. |
| Two-source confusion (file plus env) | Mitigated by the split provenance model: each badge is sourced from the process that owns the value. |
| Diagnostic noise on legitimate env-only deployments | Mitigated by the file-presence rule plus per-half suppression. |
| Panel shows a verdict for a stale daemon report | Accepted: the report is per-request from the daemon's `/runtime` and refreshes through existing status polling. |

## Acceptance criteria

1. Setting `sessiond.host` and `sessiond.port` in the global config file binds the session daemon
   to that address with no `PI_WEBUI_SESSIOND_*` environment variables set.
2. Setting `sessiond.url` in the same file makes the web/API reach that daemon over both HTTP and
   WebSockets.
3. With no `sessiond` object and no relevant env vars, the daemon still listens on the unix socket
   and the web/API still connects over it.
4. Each of `PI_WEBUI_SESSIOND_HOST`, `PI_WEBUI_SESSIOND_PORT`, and `PI_WEBUI_SESSIOND_URL`
   overrides its config-file counterpart, and an empty or whitespace-only environment value is
   treated as absent for all three.
5. An empty or whitespace-only host, from either the file or the environment, binds `127.0.0.1`
   when a port is set, and binds the unix socket when no port is set.
6. A blank, non-numeric, out-of-range, or zero `sessiond.port` in the file is a config parse
   error, never a silent fallback to the unix socket; a numeric string such as `"8810"` is
   accepted and coerced, matching the top-level `port` key.
7. An unrelated config save preserves the `sessiond` object, and no browser write path can create,
   change, or remove it.
8. A config file with `sessiond.port` but no `sessiond.url`, and no env `PI_WEBUI_SESSIOND_URL`,
   produces a non-blocking coherence warning in the panel.
9. The panel shows the effective listener read-only, with `active`, `overridden`,
   `restart-required`, or `unavailable` as specified, including `overridden` for a daemon-only
   **port** environment override and `restart-required` for desired-TCP/actual-socket even when the
   host came from the environment.
10. A syntactically invalid `sessiond.url` — a valid string that is not an absolute `http`/`https`
    URL — whether from the file or the environment, never prevents the session daemon from
    starting. A wrong-typed `sessiond` value is a shared config parse error that stops any process
    loading the config, exactly as a wrong-typed top-level key does.
11. A session daemon that omits `sessiondListener` degrades to a row without a verdict and breaks
    nothing else.
12. `npm run verify` passes, and the new tests fail before the implementation exists.

## Design review history

- 2026-10-05 — collaborative design review. Decisions: scope B (config file for bind host, bind
  port, and connect URL); UI option A (read-only panel row); UI option 2 (verified display with
  daemon listener reporting). Non-goals confirmed: no browser-writable listener settings, no URL
  derivation, no default daemon port, no live reconfiguration.
- 2026-10-05 — review attempt 1 (`CHANGES_REQUIRED`): 6 blockers, 6 false claims, all reproduced
  against source. Folded in: no delete-on-save (B1); read projection split (B2); every parser
  enumerated (B3); provenance-aware verdict (B4); per-process resolution (B5); single resolution
  (B6); transport chain, docs task, empty-string guard location, module-load wording,
  unknown-field dropping, and the response-error precedent all corrected (F1–F6).
- 2026-10-05 — operator chose the three-state (`active` / `overridden` / `restart-required`)
  verdict over a two-state comparison.
- 2026-10-05 — review attempt 2 (`CHANGES_REQUIRED`): 5 blockers, 3 false claims; B1/B6 confirmed
  fully repaired and F1–F6 confirmed corrected. Folded in: coherence warning moved to a pure
  client-side helper with the response-level `sessiondError` dropped entirely (B1); a read-only
  sessiond parser for response bodies with `parseConfigRequest` kept sessiond-free and a mandatory
  negative write test (B2); the full cross-kind verdict matrix including desired-TCP versus
  actual-socket (B3); the provenance seam taking `(file subtree, env)` instead of the merged
  effective config (B4); consumer-owned validation with the shared resolver layering only
  `sessiond.url` (B5). Also: `sessiond.host`/`sessiond.port` removed from the shared resolver to
  stop the web/API effective config carrying misleading bind values; the descriptor's socket branch
  reduced to `{ kind: "socket" }` to stop shipping a socket path to remote browsers; `0` rejected
  as a port; the URL validation rules specified; the `app.listen` observation claim replaced with a
  pure mapper plus pure-function tests; the persistence assertion changed to deep equality; and the
  rejected-alternative section rewritten after the design's own claim that transport keys are not
  browser-writable was falsified against `SettingsGeneralPanel` → `PUT /api/config`.
- 2026-10-05 — operator chose Option A for empty-host handling: empty or whitespace-only is absent
  and binds `127.0.0.1`, documented as a security tightening because an empty host currently binds
  the unspecified address.
- 2026-10-05 — operator asked what a blank `sessiond.port` does, which exposed that revision 3
  stated both "values are trimmed; empty after trimming is absent" and "shape only: `port` is a
  number", which cannot both hold for a number. Resolved by adopting the existing `parsePort`
  house rule in the shared file parser (blank, non-numeric, out-of-range, and `0` are parse errors;
  a numeric string is coerced), keeping blank-as-absent for the environment only, and introducing
  the three validation tiers (shape/type, structural primitive, runtime semantics).
- 2026-10-05 — review attempt 3 (`CHANGES_REQUIRED`): 3 blockers, 3 false claims; B1/B2/B4 and all
  folded non-blocking items confirmed resolved, B3/B5 and F1 confirmed partial. Folded in: the
  listener helpers moved out of `src/server/sessiond.ts` into the importable
  `src/sessiond/listenerConfig.ts`, because the daemon module binds a socket at load and cannot be
  imported by a test, making its named mapper test unwritable (B1); trim-aware emptiness specified
  for the `sessiondUrl` override flag and empty-after-trim omission specified at parse time, so a
  whitespace environment value cannot suppress a real warning and a blank file host cannot produce
  a spurious `restart-required` (B2); invariant 6, acceptance 9, and the ownership guarantee
  rescoped to runtime-semantic validation with the three validation tiers made explicit, since
  wrong-typed values are shared parse errors (B3, F1); the cross-kind matrix annotations corrected
  and the rows identified as the ordinary consequence of editing the file without restarting the
  daemon (F2); the generic `GET /api/config` exposure recorded as a decision (F3). Also: the
  listener-absent behavior of the coherence helper, including its one-interval transient and the
  older-daemon false positive, specified; `sessiondHttpUrl` pinned to injected `LoadOptions`; the
  negative write test moved to the route-level file-backed harness because `parseConfigRequest` is
  module-private; `shortcuts` added to the `parseConfigRequest` key enumeration; and the base-URL
  comparison reworded to note it is deliberately stricter than `machineService.validateBaseUrl`.
- 2026-10-05 — review attempt 4 (`CHANGES_REQUIRED`): 1 blocker, 2 false claims; B1, B2, B3/F1, F2,
  F3 and the blank-port handling all confirmed resolved. The blocker was a real logic error:
  "environment influence" was defined as one global predicate
  (`hostSource === "env" || portSource === "env"`) and then applied to every matrix row, which
  contradicted the desired-socket/actual-TCP row and over-broadened bind-half suppression. A host
  override cannot create or preserve a TCP listener (invariant 3), so a daemon started with
  `portSource: "config", hostSource: "env"` whose file port is then removed would have been
  reported as `overridden` ("changing the config file has no effect") when the correct verdict is
  `restart-required` — restarting would in fact apply the change. Folded in: influence is now
  row-aware (same-kind TCP differences test the source of the *differing* value; desired-socket/actual-TCP admits
  `portSource === "env"` only; desired-TCP/actual-socket is never `overridden`); bind-half
  suppression is `portSource === "env"` only; the matrix gained the mixed-provenance row and its
  explicit test. Also: invariant 2 rewritten to state that an empty or whitespace-only environment
  value is *not* an override and a file value therefore still applies, closing a shadowing
  misreading; "number" corrected to "number or numeric string" in the tier table and the error
  table; `portSource` attribution narrowed to env/config since a port has no default; the "PID env
  keys" typo corrected; the `sessiondHttpUrl(loadOptions)` / `SessionDaemonClient` injection seam
  named; the ownership sentence reworded so it no longer contradicts the shared `sessiond.url`
  layer; the data-flow attribution moved to `settingsSessiondConfig.ts`; and the remote runtime
  route direction corrected — `remoteRuntime` fetches the remote gateway's
  `GET /api/pi-webui/runtime`, it is not reached *through* `/api/machines/:machineId/runtime`, which
  is the browser-facing route that calls `MachineService.runtime`.
- 2026-10-05 — review attempt 5 (`CHANGES_REQUIRED`): 1 blocker, no false claims; all 12 attempt-4
  items and the whole-document consistency pass confirmed resolved. The blocker was the last
  refinement of the influence rule: scoping same-kind influence to `hostSource`/`portSource`
  without regard to *which* value differs is still over-broad. With
  `PI_WEBUI_SESSIOND_PORT=8810` in the daemon's environment and no `sessiond` object in the file,
  the daemon reports `{ host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "env" }`;
  adding `{ "host": "0.0.0.0", "port": 8810 }` without restarting differs only in the host, whose
  source is `default`, so a restart *would* apply the change and `overridden` would have been
  false. Folded in: same-kind influence is now `(desired.host !== actual.host &&
  actual.hostSource === "env") || (desired.port !== actual.port && actual.portSource === "env")`,
  with the crossed cases added to both the matrix and the tests. Also, from the same review: the two
  remaining "`port` is a number" sentences corrected; the daemon-side environment-port validation
  made explicit (`parsePort` reused, so one shared rule in two call sites rather than two rules);
  the status header updated to attempts 1 through 5; and `portSource` narrowed to the new
  `PiWebUiSessiondPortSource = "env" | "config"` type so the no-default-port invariant is
  type-enforced rather than documented.
- 2026-10-05 — review attempt 6 (`APPROVED`): zero blockers, zero false claims, and every matrix row
  re-derived from the per-differing-value predicate. Six non-blocking items folded in after the
  verdict: the file-versus-environment port blank handling reconciled explicitly (file blank is an
  error, environment blank is absent and not an override), the error-handling rows qualified as
  row-aware, the crossed-case tests pinned with their counter-sources, the `overridden` message
  rephrased away from "no effect" because a both-differ case can still apply the host change, the
  stale "attempts 1 through 4" history sentence corrected, and the `SettingsDialog` row corrected
  to name the single property binding it actually adds.
- 2026-10-05 — specification drafting surfaced design gap G1, now resolved: the wire descriptor's
  socket branch is path-free by design (to keep a home-directory path out of remote browsers), so a
  pure one-argument `sessiondListenOptions(listener)` could not produce `{ path }`. The resolver
  path for it, `sessiondSocketPath()`, reads the environment and the data directory and is not a
  function of the descriptor. Resolution: the mapper takes the socket path as an explicit second
  argument, keeping the mapper pure and the descriptor path-free while adding no new resolution
  work, since the daemon's `listen()` step already resolves that path in its socket branch.
