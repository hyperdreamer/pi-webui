# Technical Specification: Subsessions Enabled by Default (Beta Removal)

**Date:** 2026-09-16
**Status:** Approved for implementation (approved design; spec drafted in `pm-run-20260916-084204-555d6665`)
**Related design document:** `docs/superpowers/specs/2026-09-16-subsession-stabilization-design.md` (sha256 `600280edbcf8291840751eebae11f5c761a7bad3e6b41bb237aa98eea1e67a84`, committed at HEAD `9a32918`)
**Target package:** `@hyperdreamer/pi-webui`
**Change class:** user-visible minor (default-enabled capability; Beta framing removed)
**Operation class:** session-daemon-affecting. `src/config.ts` is loaded by both the web/API process and the session daemon; the daemon resolves the default once at startup (`src/server/sessiond.ts:58`) and passes the resolved boolean into the runtime (`src/server/sessiond.ts:138`). Per `AGENTS.md`, a **manual restart of `pi-webui-sessiond.service` is required on each machine** before the new default reaches a running session runtime.
**Delivery target:** `refs/heads/main` @ `7a5ccfbc2d20efbba146a29b3e14cb8518a51969`

Every `file:line` reference below was verified by reading the file at worktree HEAD `9a32918`. `git diff --stat 7a5ccfb..9a32918` shows that commit only adds the design document, so the cited lines are identical at the delivery target.

---

## 1. Scope

### 1.1 What changes

1. **Default resolution** — `src/config.ts:626`: `return config.subsessions ?? false;` becomes `return config.subsessions ?? true;`. This is the only production behavior change. `resolveEffectivePiWebUiConfig()` (`src/config.ts:177-201`) resolves the boolean at `src/config.ts:197`, so the runtime state, the Settings toggle, and the effective-config summary all read the same resolved value within one process.
2. **Beta framing** — comment and copy rewrites at the sites enumerated in section 3: `src/config.ts:196` and `:615-622`, `src/shared/apiTypes.ts:472-477`, `src/server/sessions/piSessionService.ts:1154-1159` and `:1371-1372`, `src/client/src/components/settings/SettingsSessiondPanel.ts:48`, `:130`, `:142`, `:237`.
3. **Documentation** — `docs/config.md`, `docs/config.html`, `docs/install.html`, `docs/optional-skills.md` (section 4). `README.md` is unchanged.
4. **Tests** — one renamed/rewritten resolver case, one added explicit opt-out case, one added effective-config assertion (section 5).
5. **Release artifact** — one `minor` Changeset for `@hyperdreamer/pi-webui` (section 6). `CHANGELOG.md` is not edited.

### 1.2 In scope (explicit)

- The default flip and its wiring, exactly as listed above.
- Removing the Beta pill and `.beta-badge` rule from the Settings panel and rewriting the help copy to the design's pinned final string.
- Comment rewrites only in `src/server/sessions/piSessionService.ts`; its gating logic (`:1373-1374`, tool assembly at `:996-1006`, paired `inspect` wiring at `:1405-1409`) is untouched.
- Documentation text consistent between the Markdown and HTML representations.

### 1.3 Out of scope (explicit non-goals)

- No decoupling of `subsessions` from `spawnSessions`.
- No removal of the `subsessions` config key, the `PI_WEBUI_SUBSESSIONS` environment variable, or the Settings toggle.
- No change to subsession tool behavior, transcript handling, notifications, joining, or the yield protocol.
- No `README.md` change: subsession behavior is detailed configuration material and belongs in `docs/config.*` per `AGENTS.md` and `.agents/skills/documentation-guide/SKILL.md`.
- No `CHANGELOG.md` edit: release notes are generated from Changesets at release time.
- No change to `src/server/sessiond.ts`, `src/server/configRoutes.ts`, the `subsessionsEnabled` precedence order, the `isEnvSet`/env-override semantics, or the failure messages listed in section 8.
- No pre-emptive test-fixture edits. Run the broad suite and let real failures surface; a failing fixture outside `src/config.test.ts` contradicts the design's verification claim (design `:224-229`) and must be surfaced, not silently adjusted.

---

## 2. Behavior contract

| Configuration | Before | After |
| --- | --- | --- |
| Nothing set | disabled | **enabled** |
| `subsessions: false` | disabled | disabled |
| `subsessions: true` | enabled | enabled |
| `PI_WEBUI_SUBSESSIONS=0` with config `true` | disabled | disabled |
| `PI_WEBUI_SUBSESSIONS=1` with config `false` | enabled | enabled |
| `spawnSessions` disabled | subsessions unavailable | subsessions unavailable |
| Settings checkbox, nothing set | unchecked | checked |
| Settings help text | "Off by default." | "On by default." |
| Heading badge | `beta` pill | none |

Precedence is unchanged: a non-empty `PI_WEBUI_SUBSESSIONS` value wins over the config file; otherwise the config file value applies; otherwise the new default `true` applies (`src/config.ts:623-627`).

**Upgrade consequence:** an install that never set the key begins exposing the governed tool family — the five subsession tools (`spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, `yield_to_subsessions`) and the paired `get_model_policy` — to agents once its session daemon restarts. Explicit `false` in the config file or environment remains the escape hatch.

---

## 3. Exact implementation

### 3.1 `src/config.ts`

**(a) Line 196 — comment rewrite.** Before:

```ts
      // Beta capability, resolved off by default.
```

After (the design's literal replacement; `eslint.config.js` defines no `max-len` rule, so the 112-character line is intentional):

```ts
      // On by default, like spawnSessions; resolved here so the effective config is the single source of truth.
```

**(b) Lines 615-622 — JSDoc rewrite above `subsessionsEnabled`.** Before:

```ts
/**
 * Beta: whether LLMs may start tracked child sessions via the spawn_subsession
 * family of tools. Off by default while the capability stabilizes, so it can
 * ship in main without affecting releases; enable with the env var
 * `PI_WEBUI_SUBSESSIONS` or the `subsessions` config key. The env var takes
 * precedence over the config file. Subsessions also require spawnSessions to be
 * enabled (they share the same project-scope resolver).
 */
```

After (design wording, rewrapped to the file's ~78-column comment width):

```ts
/**
 * On by default; whether LLMs may start tracked child sessions via the
 * `spawn_subsession` family. Disable with the env var `PI_WEBUI_SUBSESSIONS`
 * or the `subsessions` config key; the env var takes precedence. Subsessions
 * also require `spawnSessions` to be enabled.
 */
```

No comment inside the function body is added; lines 623-627 otherwise keep their exact text.

**(c) Line 626 — the behavior change.** Before:

```ts
  return config.subsessions ?? false;
```

After:

```ts
  return config.subsessions ?? true;
```

No other edit in this file. `parseSubsessions` (`:610-613`), persistence projection (`:435`), and the env check at `:625` are unchanged.

### 3.2 `src/server/sessions/piSessionService.ts` — comments only, no logic change

**(a) Lines 1154-1159 — dependency JSDoc.** Before:

```ts
  /**
   * Beta: when true (and `spawnTargets` is provided), the tracked-subsession
   * tools are available to sessions whose creation provenance permits
   * delegation. Off by default so the capability can ship in main without
   * being exposed in releases.
   */
```

After:

```ts
  /**
   * When true (and `spawnTargets` is provided), the tracked-subsession tools
   * and the paired `get_model_policy` tool are available to sessions whose
   * creation provenance permits delegation. Omit to keep the capability
   * disabled.
   */
```

**(b) Lines 1371-1372 — runtime comment.** Before:

```ts
    // Subsessions are a beta capability gated behind their own flag, and they
    // also require the spawn capability (they share its project-scope resolver).
```

After:

```ts
    // Subsessions have their own flag and also require the spawn capability
    // (they share its project-scope resolver).
```

**No logic changes.** The gate stays exactly:

```ts
    const subsessionsActive =
      this.spawnTargets !== undefined && deps.subsessionsEnabled === true;
```

(`:1373-1374`), and the tool batch (`:996-1006`), the paired `inspect` wiring (`:1405-1409`), and `spawn_session` handling are untouched.

### 3.3 `src/shared/apiTypes.ts` — comment rewrite

Lines 472-477. Before:

```ts
  /**
   * Beta: when true, LLMs can start tracked child sessions via the
   * spawn_subsession / list_subsessions / check_subsession / read_subsession
   * tools. Off by default
   * while the capability stabilizes. Requires spawnSessions to be enabled.
   */
```

After:

```ts
  /**
   * When true, LLMs can start tracked child sessions via the `spawn_subsession`
   * family of tools. On by default; requires `spawnSessions` to be enabled.
   */
```

`subsessions?: boolean;` at `:478` and the `PiWebUiConfigEnvOverrides.subsessions: boolean` type at `:697` are unchanged.

### 3.4 `src/client/src/components/settings/SettingsSessiondPanel.ts`

**(a) Line 48 — field comment.** Before:

```ts
    // Beta, off by default; also requires spawn to be enabled.
```

After:

```ts
    // On by default; also requires spawn to be enabled.
```

**(b) Line 130 — delete the badge.** Remove this line entirely:

```ts
              <span class="beta-badge">beta</span>
```

The heading keeps `<span>Allow agents to start tracked subsessions</span>` and the optional `${subsessionsOverridden ...}` override badge, matching the adjacent "Allow agents to start sessions" field structure (Variant A).

**(c) Line 142 — replace the help copy.** Delete the current line:

```ts
            <small>Beta: agents can start child sessions they stay attached to (<code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>, <code>read_subsession</code>) and are notified when a child finishes. Requires "Allow agents to start sessions". Off by default.</small>
```

Insert exactly this line (single line, four `<code>` elements preserved; this is the design's pinned final string):

```ts
            <small>When enabled, agents can start child sessions they stay attached to (<code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>, <code>read_subsession</code>) and are notified when a child finishes. Requires "Allow agents to start sessions". On by default.</small>
```

Rendered result, exactly as the design pins it:

```text
ALLOW AGENTS TO START TRACKED SUBSESSIONS
[x] Enable the spawn_subsession tools
    When enabled, agents can start child sessions they stay attached to
    (spawn_subsession, list_subsessions, check_subsession, read_subsession) and are
    notified when a child finishes. Requires "Allow agents to start sessions".
    On by default.
```

The four-tool list is deliberate: `yield_to_subsessions` and `get_model_policy` are not named in this short Settings string, matching today's copy. Do not add tool names here.

**(d) Line 237 — delete the CSS rule.** Remove this line entirely (verified: after (b), `beta-badge` has no other consumer in the repository):

```ts
    .beta-badge { border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); background: var(--pi-bg); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
```

**No other change in this file.** `subsessionsOverridden` (`:47`), `effectiveSubsessions` (`:49`, which follows the resolved boolean and the `spawnSessions` coupling), the checkbox `?disabled` expression (`:137`), and the summary row (`Subsessions` / `Enabled` / `Disabled`) are unchanged.

### 3.5 Files that require no change

- `src/server/sessiond.ts` — **no change required.** `:58` is `const { config } = effectivePiWebUiConfig({ env: daemonEnvironment });` and `:138` is `subsessionsEnabled: spawnTargets !== undefined && config.subsessions,`. Both consume the already-resolved boolean, so the new default flows through untouched.
- `src/server/configRoutes.ts` — **no change required.** It projects `effective.config` (`:72` and `:78`), computes the env-override flag with `isEnvSet(env["PI_WEBUI_SUBSESSIONS"])` (`:364`), and validates booleans with unchanged messages (`:225-228`, `:336-340`). Nothing keys on the old default.
- `src/client/src/components/settings/settingsSessiondConfig.ts` — unchanged; `subsessionsConfigPatch` (`:10-11`) and `mergeSelectedMachineSessiondConfig` (`:43`) pass values through.
- `package.json`, `tsconfig*.json`, `eslint.config.js`, `knip` config, and `vitest.config.ts` — unchanged.

---

## 4. Documentation changes

Only `docs/config.md` among the edited doc surfaces ships in the npm package (`package.json` `files` includes `docs/config.md`); `docs/config.html`, `docs/install.html`, and `docs/optional-skills.md` are site-only and match no `files` entry. No separate changeset is needed for site-only files; the single Changeset in section 6 covers the capability and the shipped config reference. Keep the Markdown and HTML representations consistent.

### 4.1 `docs/config.md`

**(a) Line 106 — example config.** Before:

```json
  "subsessions": false,
```

After:

```json
  "subsessions": true,
```

**(b) Line 157 — configuration matrix row.** Before:

```md
| Tracked subsessions (beta) | `subsessions` | `PI_WEBUI_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon on that machine |
```

After (label only; scope, env var, and restart columns stay accurate):

```md
| Tracked subsessions | `subsessions` | `PI_WEBUI_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon on that machine |
```

**(c) Line 430 — "Session daemon tools" section text.** Before:

```md
`subsessions` is beta and controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, and `yield_to_subsessions`. It defaults to `false` and also requires `spawnSessions` to be enabled.
```

After (drops "is beta"; the enumeration ends "…`yield_to_subsessions`, and the paired read-only `get_model_policy` inspection tool" so `get_model_policy` is not misclassified as a subsession tool; "defaults to `false`" becomes "defaults to `true`"):

```md
`subsessions` controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, `yield_to_subsessions`, and the paired read-only `get_model_policy` inspection tool. It defaults to `true` and also requires `spawnSessions` to be enabled.
```

The join/yield/notice paragraphs at `:432-438` and the Settings pointer at `:440` are unchanged.

### 4.2 `docs/config.html` (site-only)

**(a) Line 263 — example card.** Before `  "subsessions": false,` → after `  "subsessions": true,`.

**(b) Line 412 — matrix row.** Before `<td>Tracked subsessions (beta)</td>` → after `<td>Tracked subsessions</td>`.

**(c) Lines 1063-1066 — `subsessions` section paragraph.** Before:

```html
                Boolean. Beta. Controls whether agents receive the tracked-subsession tools:
                <code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>,
                <code>read_subsession</code>, and <code>yield_to_subsessions</code>. Defaults to <code>false</code> and also
                requires <code>spawnSessions</code> to be enabled.
```

After (drops `Beta.`; changes the conjunction before `yield_to_subsessions` so the appended "and the paired read-only" reads correctly; adds the `get_model_policy` clause; flips the default):

```html
                Boolean. Controls whether agents receive the tracked-subsession tools:
                <code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>,
                <code>read_subsession</code>, <code>yield_to_subsessions</code>, and the paired read-only
                <code>get_model_policy</code> inspection tool. Defaults to <code>true</code> and also
                requires <code>spawnSessions</code> to be enabled.
```

The `</p>` at `:1067` and the join/yield/notice paragraphs that follow are unchanged.

### 4.3 `docs/install.html` (site-only)

Line 348, "Common config" example. Before `  "subsessions": false` → after `  "subsessions": true`, matching the adjacent `"spawnSessions": true` at `:347`. Keep the last-key form (no trailing comma).

### 4.4 `docs/optional-skills.md` (site-only)

Line 39. Before:

```md
- Pi with subagent support, and `subsessions` enabled in your PI WEBUI config.
```

After:

```md
- Pi with subagent support; tracked subsessions are enabled by default and require `spawnSessions`.
```

### 4.5 `README.md`

Unchanged, per the design and the documentation guide.

---

## 5. Test additions

### 5.1 `src/config.test.ts` — `describe("subsessionsEnabled")` (starts at `:870`)

Rewrite `:871-873`. Before:

```ts
  it("is off by default while the capability is in beta", () => {
    expect(subsessionsEnabled({}, {})).toBe(false);
  });
```

After:

```ts
  it("is on by default when nothing is configured", () => {
    expect(subsessionsEnabled({}, {})).toBe(true);
  });
```

Keep `:875-877` unchanged (`it("honors an explicit config opt-in")`). Insert a new opt-out case after it (design test-strategy bullet at `:217`), so the suite covers both explicit config directions plus the default:

```ts
  it("honors an explicit config opt-out", () => {
    expect(subsessionsEnabled({}, { subsessions: false })).toBe(false);
  });
```

Keep the env-override case `:879-882` unchanged.

### 5.2 `src/config.test.ts` — effective config

Insert a new test immediately after the closing `});` of `it("exposes the default upload folder in the effective config")` (`:338-340`), in the same `describe("PI WEBUI config persistence")` block:

```ts
  it("exposes the subsessions default in the effective config", () => {
    expect(effectivePiWebUiConfig(testOptions()).config.subsessions).toBe(true);
  });
```

`testOptions()` (`:896-898`) supplies `{ PI_WEBUI_CONFIG: configPath }` and the `beforeEach` (`:14-17`) creates an empty temp directory, so with no config file written this pins the assembled effective boolean the session daemon consumes — not only the resolver. `spawnSessions` gains no analogous assertion (design `:222-223`).

### 5.3 The panel suite must not gain a template-scraping test

Do **not** add a test to `src/client/src/components/settings/SettingsSessiondPanel.test.ts` for the badge removal or the help copy. The suite documents at `SettingsSessiondPanel.test.ts:5-12` that it asserts dynamic behavior through public seams (`sessiondPanelNotices`, `sessiondDescription`, save callbacks) and intentionally not static labels or layout, per `.agents/skills/testing-guide/SKILL.md` (no content assertions via scraping `TemplateResult` internals). The badge and the `<small>` copy are static template content with no behavioral seam; they are verified by the rendered panel check in section 7 step 7 and by diff review at audit time.

`src/client/src/components/settings/SettingsSessiondPanel.test.ts` and the other explicit-value fixtures (`src/server/configRoutes.test.ts`, `src/client/src/components/SettingsDialog.sessiond.test.ts`, `src/client/src/components/settings/settingsSessiondConfig.test.ts`) are not edited.

### 5.4 Falsifiability

Each new or changed pin must fail under exactly one single-file mutation. Run the focused suite after each mutation and revert the mutation before continuing.

| Pin | Single-file mutation | Required failure |
| --- | --- | --- |
| Renamed default test (`src/config.test.ts:871-873` rewrite) | `src/config.ts:626`: `?? true` → `?? false` | `is on by default when nothing is configured` fails (`expected false to be true`) |
| New effective-config test (section 5.2) | `src/config.ts:626`: `?? true` → `?? false` | `exposes the subsessions default in the effective config` fails (`expected false to be true`) |
| New effective-config test (section 5.2) | `src/config.ts:197`: `subsessionsEnabled(env, loaded.config)` → `false` | Effective-config test fails; the renamed default test still passes, which is why this pin exists — it binds the assembly wiring, not just the resolver |
| New opt-out test (section 5.1) | `src/config.ts:626`: `return config.subsessions ?? true;` → `return true;` | `honors an explicit config opt-out` fails (`expected true to be false`); the default test still passes |
| Unchanged opt-in test (`:875-877`) | `src/config.ts:626`: `return config.subsessions ?? true;` → `return config.subsessions === undefined;` | Opt-in test fails (`expected false to be true`); the default and opt-out tests still pass; this case is not a default pin (it passes under both `?? false` and `?? true`) |
| Unchanged env-override test (`:879-882`) | `src/config.ts:625`: `if (fromEnv !== undefined && fromEnv !== "")` → `if (false)` | Both direction assertions fail; the default and opt-out tests still pass |
| Beta-framing textual check (section 7 step 5) | Restore any removed Beta string, e.g. `// Beta capability, resolved off by default.` at `src/config.ts:196` | The scoped `rg -ni "beta|off by default"` command prints a match (exit 0) instead of no output (exit 1); this is a diff/audit check, not a Vitest pin |
| Panel badge and help copy | Re-add `<span class="beta-badge">beta</span>` or restore the old `<small>` text in `SettingsSessiondPanel.ts` | No Vitest failure by design (section 5.3); caught by the rendered panel check and diff review |

**Read-only probe (optional).** To prove the default pins without touching the active worktree, use the `read-only-regression-mutant-probe` procedure: `git archive HEAD` into a temp directory, symlink the active `node_modules`, apply the `?? false` mutation only in the archived `src/config.ts`, run `npm test -- --run src/config.test.ts` there, record the failures, then delete the temp directory and confirm the active worktree is unchanged (`git status --porcelain` empty, HEAD unmoved). An in-place edit reverted before commit is acceptable for the implementer; if used, record the red output.

---

## 6. Changeset

Create `.changeset/subsessions-enabled-by-default.md` (kebab-case; `.changeset/` currently contains only `config.json`, so the name is unique). Exact contents. The body must be a single unwrapped paragraph on one line, matching every
existing fragment in `.changeset/` (for example `.changeset/speech-input-polishing.md` and
the generated `CHANGELOG.md:260`); the generated changelog reproduces that line verbatim,
so hard wrapping it would change the release notes. End the file with a trailing newline:

```md
---
"@hyperdreamer/pi-webui": minor
---

Enable the tracked-subsession tools (`spawn_subsession`, `list_subsessions`,
`check_subsession`, `read_subsession`, `yield_to_subsessions`) and the paired
`get_model_policy` tool by default. The `subsessions` session-daemon setting now
defaults to `true`; disable it with `subsessions: false` or
`PI_WEBUI_SUBSESSIONS=0`. The new default applies after the session daemon on each
machine restarts.
```

`minor` is correct: this is a backward-compatible capability enabled by default, not a removal or a breaking narrowing (`subsessions: false` and `PI_WEBUI_SUBSESSIONS=0` remain working opt-outs), which matches `.agents/skills/changeset-changelog/SKILL.md`. Do not edit `CHANGELOG.md`.

---

## 7. Verification commands

Run in order from the repository root. Record exact output.

1. **Focused tests during development** — `npm test -- --run src/config.test.ts`. Expected green: the renamed default test, the new opt-out test, the new effective-config test, and the unchanged cases. If the tests are written before the production change (red phase), the renamed default test and the effective-config test fail while the opt-out test passes; record that red output, apply section 3.1, and re-run to green. No panel suite file changes, so no panel test run is required for this change.
2. **Typecheck** — `npm run typecheck`. Expected exit code 0; no type surface changes.
3. **Targeted lint** — `npx eslint src/config.ts src/shared/apiTypes.ts src/server/sessions/piSessionService.ts src/client/src/components/settings/SettingsSessiondPanel.ts src/config.test.ts`. Expected exit code 0.
4. **Beta-framing textual check** — `rg -ni "beta|off by default" src/config.ts src/shared/apiTypes.ts src/server/sessions/piSessionService.ts src/client/src/components/settings/SettingsSessiondPanel.ts src/config.test.ts docs/config.md docs/config.html docs/install.html docs/optional-skills.md`. Expected: no output (exit code 1 is the pass condition; an unrelated `beta` elsewhere in the repository is out of this check's scope).
5. **Completion gate** — `npm run verify:fast` (typecheck, lint, `knip`, 4-worker test profile; `package.json` scripts). Expected exit code 0.
6. **CI-equivalent gate** — `npm run verify` (serial test profile). Expected exit code 0 before the frontier audit.
7. **Rendered Settings → Session daemon panel check** — with no `subsessions` key in the config file and no `PI_WEBUI_SUBSESSIONS` env var: the "Allow agents to start tracked subsessions" checkbox is checked, no Beta pill is rendered, the help copy ends "On by default.", and the summary shows `Subsessions: Enabled`. Confirm the checkbox is still disabled when `spawnSessions` is off or when `PI_WEBUI_SUBSESSIONS` is set. This renders from the web/API process's resolution and can pass before the daemon restart (section 9).
8. **Session-daemon restart handoff** — per `AGENTS.md`, tell the user to restart `pi-webui-sessiond.service` on each affected machine; the new default is not live for agents until that restart. Record the handoff.
9. **Frontier implementation audit** — after all implementation work is integrated, the PM
   runs the frontier audit against this specification and the approved design document.
   This is a PM process step, not implementer work, so it is listed for traceability with
   the design's verification section rather than as a command the implementer runs.

---

## 8. Error handling

No new error paths. The existing behavior is preserved:

- **Non-boolean `subsessions` value** — rejected by the config parser with `PI WEBUI config subsessions must be a boolean: ${path}` (`src/config.ts:610-613`), by the config routes with `PI WEBUI config subsessions must be a boolean` (`src/server/configRoutes.ts:225-228`), and by the strict browser parsers: the optional config value via `optionalBoolean` (`Invalid PI WEBUI subsessions field`, `src/client/src/api/parsers.ts:1919`, helper at `:2501-2506`) and the env-override field via `requireBoolean` (`Expected boolean field: subsessions`, `:2015`, helper at `:47-51`). None of these messages or paths change.
- **Unrecognized `PI_WEBUI_SUBSESSIONS` value** — still resolves to `false`: `fromEnv === "1" || fromEnv.toLowerCase() === "true"` (`src/config.ts:625`, unchanged). `"TRUE"` resolves to `true`; `"yes"`, `"on"`, `"0"`, and any other value resolve to disabled. An empty value is treated as unset and falls through to the config file, then the default.
- **No spawn targets** — the governed tool family stays unavailable regardless of the setting: `src/server/sessiond.ts:137-138` passes `subsessionsEnabled: spawnTargets !== undefined && config.subsessions`, and `src/server/sessions/piSessionService.ts:1373-1374` requires `this.spawnTargets !== undefined && deps.subsessionsEnabled === true`. `spawn_session` is unaffected.
- **Settings toggle** — remains disabled while `spawnSessions` is off or when `PI_WEBUI_SUBSESSIONS` overrides the value (`SettingsSessiondPanel.ts:137`), unchanged.

---

## 9. Rollout

The default is read when a process resolves the configuration, and the web/API process and the session daemon resolve it independently (`src/server/configRoutes.ts:72-80` for the API response, `src/server/sessiond.ts:58` and `:138` for the live runtime). Two consequences:

1. The setting takes effect for agents only after that machine's session daemon restarts. Until then the live daemon keeps the previous value while the API and Settings panel already report the new default — Settings can show the checkbox checked and `Subsessions: Enabled` while the running daemon still withholds the tools.
2. An install that upgrades and restarts only the web/API therefore sees a checked toggle with no capability change until the daemon follows. The configuration matrix row already states "Restart session daemon on that machine"; its scope and behavior columns stay accurate after the label change in section 4.

---

## 10. Open questions

1. **Opt-out versus opt-in test naming.** The design's test-strategy bullet (`docs/superpowers/specs/2026-09-16-subsession-stabilization-design.md:217`) lists an "explicit config opt-out (`{ subsessions: false }` → `false`)" case, but the suite's existing second case is an explicit opt-**in** (`src/config.test.ts:875-877`, `expect(subsessionsEnabled({}, { subsessions: true })).toBe(true)`), and the design marks only the env-override cases as unchanged (design `:218`). This spec keeps the opt-in case and adds the opt-out case so both explicit directions and the default stay covered. If the design intended the opt-out case to replace the opt-in case instead, confirm before removing the existing coverage; no implementation ambiguity remains either way.
2. **Effective-config test name/placement.** The design pins the assertion expression but not the enclosing test (`docs/superpowers/specs/2026-09-16-subsession-stabilization-design.md:219-223`: "add … next to the existing effective-default assertions (uploads, tts)"). This spec places it in a new `it("exposes the subsessions default in the effective config")` after `src/config.test.ts:340`, next to `it("exposes the default upload folder in the effective config")` (`:338-340`). Confirm the test name is acceptable, or fold the assertion into the adjacent test.
3. **Doc enumeration conjunction.** The design says to "append" the `get_model_policy` clause to the enumeration (`docs/superpowers/specs/2026-09-16-subsession-stabilization-design.md:202-203`) while its quoted final form reads "…`yield_to_subsessions`, and the paired read-only `get_model_policy` inspection tool" (design `:202`). A literal append would produce a double conjunction before `yield_to_subsessions`. This spec follows the quoted final form and drops the existing "and" before `yield_to_subsessions` in both `docs/config.md:430` and `docs/config.html:1065`. No implementation blocker; flag for the documentation audit if a different rendering is preferred.
