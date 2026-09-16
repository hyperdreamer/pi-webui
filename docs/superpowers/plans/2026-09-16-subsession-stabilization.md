# Subsessions Enabled by Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tracked subsessions on by default (`subsessions` resolves to `true`
when unset) and remove every Beta / off-by-default claim about them from code
comments, the Settings panel, and the configuration documentation, pinned by three
Vitest cases, one `minor` Changeset, and a rendered Settings panel check.

**Architecture:** One task, deliberately. Every edit belongs to a single contract —
the tracked-subsession default and its Beta framing — so no reviewer could
meaningfully accept one cluster while rejecting another: the default flip without
the copy removal would leave the UI and docs lying, the tests without the flip would
fail, and the docs without the tests would be unpinned. There is no second
deliverable that is independently testable, so the task is not split. All
replacement text is literal and byte-pinned below, so no implementer design decision
remains.

**Tech Stack:** TypeScript (strict, ES2022, Node >= 22.19), Lit settings component,
Vitest, jsdom (rendered-panel probe only), ESLint, knip, Changesets, npm, Git.

## Global Constraints

- Allowed files (and only these): modify `src/config.ts`, `src/shared/apiTypes.ts`, `src/server/sessions/piSessionService.ts`, `src/client/src/components/settings/SettingsSessiondPanel.ts`, `src/config.test.ts`, `docs/config.md`, `docs/config.html`, `docs/install.html`, `docs/optional-skills.md`; create `.changeset/subsessions-enabled-by-default.md`. Do not modify `README.md`, `CHANGELOG.md`, `src/server/sessiond.ts`, `src/server/configRoutes.ts`, `src/client/src/components/settings/settingsSessiondConfig.ts`, `src/client/src/api/parsers.ts`, `src/client/src/components/settings/SettingsSessiondPanel.test.ts`, `src/server/configRoutes.test.ts`, `src/client/src/components/SettingsDialog.sessiond.test.ts`, `src/client/src/components/settings/settingsSessiondConfig.test.ts`, `package.json`, the `tsconfig*.json` files, `eslint.config.js`, the `knip` config, or `vitest.config.ts`.
- The Settings help string is pinned and byte-exact: `<small>When enabled, agents can start child sessions they stay attached to (<code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>, <code>read_subsession</code>) and are notified when a child finishes. Requires "Allow agents to start sessions". On by default.</small>`; do not add `yield_to_subsessions` or `get_model_policy` to it.
- No template-scraping tests: do not add or alter any test that inspects Lit `TemplateResult` internals or asserts static labels/layout; `src/client/src/components/settings/SettingsSessiondPanel.test.ts` is not edited, and the badge removal and help copy are verified only by the rendered-panel probe and diff review.
- Create exactly one Changeset, `.changeset/subsessions-enabled-by-default.md`, with `"@hyperdreamer/pi-webui": minor` and the pinned single unwrapped paragraph; create no second changeset.
- `CHANGELOG.md` must not be edited; release notes are generated from Changesets at release time.
- `npm run verify:fast` is the completion gate and must exit 0.

## Task 1: Enable tracked subsessions by default and remove Beta framing

**Implementer tier:** Standard

**Files:**

- Modify: `src/config.ts:196-197`
- Modify: `src/config.ts:615-626`
- Modify: `src/server/sessions/piSessionService.ts:1154-1159`
- Modify: `src/server/sessions/piSessionService.ts:1371-1372`
- Modify: `src/shared/apiTypes.ts:472-477`
- Modify: `src/client/src/components/settings/SettingsSessiondPanel.ts:48-48`
- Modify: `src/client/src/components/settings/SettingsSessiondPanel.ts:130-142`
- Modify: `src/client/src/components/settings/SettingsSessiondPanel.ts:237-237`
- Test: `src/config.test.ts:338-341`
- Test: `src/config.test.ts:871-877`
- Modify: `docs/config.md:106-106`
- Modify: `docs/config.md:157-157`
- Modify: `docs/config.md:430-430`
- Modify: `docs/config.html:263-263`
- Modify: `docs/config.html:412-412`
- Modify: `docs/config.html:1063-1066`
- Modify: `docs/install.html:348-348`
- Modify: `docs/optional-skills.md:39-39`
- Create: `.changeset/subsessions-enabled-by-default.md`

**Interfaces:**

- Consumes: nothing; this is the only task and it starts from the repository at HEAD `25dc841` (frozen specification `docs/superpowers/specs/2026-09-16-subsession-stabilization-spec.md`, sha256 `f8df33d86dc7b609c961b5869c50cf10de4f1ea4185189e1805c29b524907d1a`).
- Produces: `subsessionsEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebUiConfig = {}): boolean` resolving `config.subsessions ?? true` when `PI_WEBUI_SUBSESSIONS` is unset or empty; `resolveEffectivePiWebUiConfig(loaded: LoadedPiWebUiConfig, options: LoadOptions = {}): LoadedEffectivePiWebUiConfig` whose `config.subsessions: boolean` resolves through that function at line 197; the Vitest cases `is on by default when nothing is configured`, `honors an explicit config opt-out`, and `exposes the subsessions default in the effective config`; the pinned Settings `<small>` string and the removed `.beta-badge` consumer and CSS rule; and `.changeset/subsessions-enabled-by-default.md` declaring `"@hyperdreamer/pi-webui": minor`.

### Phase A — Red: write the failing pins

- [ ] **Step 1: Rewrite the default resolver test**

In `src/config.test.ts:871-873`, replace:

```ts
  it("is off by default while the capability is in beta", () => {
    expect(subsessionsEnabled({}, {})).toBe(false);
  });
```

with:

```ts
  it("is on by default when nothing is configured", () => {
    expect(subsessionsEnabled({}, {})).toBe(true);
  });
```

- [ ] **Step 2: Add the explicit opt-out test**

In `src/config.test.ts:875-877`, replace:

```ts
  it("honors an explicit config opt-in", () => {
    expect(subsessionsEnabled({}, { subsessions: true })).toBe(true);
  });
```

with:

```ts
  it("honors an explicit config opt-in", () => {
    expect(subsessionsEnabled({}, { subsessions: true })).toBe(true);
  });

  it("honors an explicit config opt-out", () => {
    expect(subsessionsEnabled({}, { subsessions: false })).toBe(false);
  });
```

- [ ] **Step 3: Add the effective-config test**

In `src/config.test.ts:338-340`, replace:

```ts
  it("exposes the default upload folder in the effective config", () => {
    expect(effectivePiWebUiConfig(testOptions()).config.uploads).toEqual({ defaultFolder: DEFAULT_UPLOADS_FOLDER });
  });
```

with the same test plus the new effective-config pin immediately after it:

```ts
  it("exposes the default upload folder in the effective config", () => {
    expect(effectivePiWebUiConfig(testOptions()).config.uploads).toEqual({ defaultFolder: DEFAULT_UPLOADS_FOLDER });
  });

  it("exposes the subsessions default in the effective config", () => {
    expect(effectivePiWebUiConfig(testOptions()).config.subsessions).toBe(true);
  });
```

- [ ] **Step 4: Run the focused suite and record the red phase**

Run:

```bash
npm test -- --run src/config.test.ts
```

Expected: FAIL, and the summary line reads `Tests  2 failed | 106 passed (108)`.

- `is on by default when nothing is configured` fails with `AssertionError: expected false to be true`.
- `exposes the subsessions default in the effective config` fails with `AssertionError: expected false to be true`.
- `honors an explicit config opt-out` passes, because `subsessionsEnabled({}, { subsessions: false })` ignores the default.
- `honors an explicit config opt-in` and `lets the env var override the config in both directions` pass.

Record the red output verbatim in the report. Do not proceed to Phase B until the failure names exactly those two tests and the messages are assertion failures, not import, syntax, fixture, or environment errors.

### Phase B — Green and artifacts

- [ ] **Step 5: Flip the default and rewrite both `src/config.ts` comments**

In `src/config.ts:196`, replace:

```ts
      // Beta capability, resolved off by default.
```

with this single line (`eslint.config.js` defines no `max-len` rule and the frozen specification states the line is intentionally 112 characters):

```ts
      // On by default, like spawnSessions; resolved here so the effective config is the single source of truth.
```

In `src/config.ts:615-622`, replace:

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

with:

```ts
/**
 * On by default; whether LLMs may start tracked child sessions via the
 * `spawn_subsession` family. Disable with the env var `PI_WEBUI_SUBSESSIONS`
 * or the `subsessions` config key; the env var takes precedence. Subsessions
 * also require `spawnSessions` to be enabled.
 */
```

In `src/config.ts:626`, replace:

```ts
  return config.subsessions ?? false;
```

with:

```ts
  return config.subsessions ?? true;
```

Make no other edit in this file: `parseSubsessions` (`:610-613`), the persistence projection at `:435`, and the environment check at `:625` keep their exact text.

- [ ] **Step 6: Run the focused suite and record the green phase**

Run:

```bash
npm test -- --run src/config.test.ts
```

Expected: PASS, and the summary line reads `Tests  108 passed (108)` — the 106 pre-existing tests plus `honors an explicit config opt-out` and `exposes the subsessions default in the effective config`, with `is on by default when nothing is configured` now green. Record the count in the report.

- [ ] **Step 7: Rewrite the two `src/server/sessions/piSessionService.ts` comments**

In `src/server/sessions/piSessionService.ts:1154-1159`, replace:

```ts
  /**
   * Beta: when true (and `spawnTargets` is provided), the tracked-subsession
   * tools are available to sessions whose creation provenance permits
   * delegation. Off by default so the capability can ship in main without
   * being exposed in releases.
   */
```

with:

```ts
  /**
   * When true (and `spawnTargets` is provided), the tracked-subsession tools
   * and the paired `get_model_policy` tool are available to sessions whose
   * creation provenance permits delegation. Omit to keep the capability
   * disabled.
   */
```

In `src/server/sessions/piSessionService.ts:1371-1372`, replace:

```ts
    // Subsessions are a beta capability gated behind their own flag, and they
    // also require the spawn capability (they share its project-scope resolver).
```

with:

```ts
    // Subsessions have their own flag and also require the spawn capability
    // (they share its project-scope resolver).
```

Change no logic: the gate stays `const subsessionsActive = this.spawnTargets !== undefined && deps.subsessionsEnabled === true;` (`:1373-1374`), the tool batch at `:996-1006` is untouched, and the paired `inspect` wiring at `:1405-1409` is untouched.

- [ ] **Step 8: Rewrite the `src/shared/apiTypes.ts` comment**

In `src/shared/apiTypes.ts:472-477`, replace:

```ts
  /**
   * Beta: when true, LLMs can start tracked child sessions via the
   * spawn_subsession / list_subsessions / check_subsession / read_subsession
   * tools. Off by default
   * while the capability stabilizes. Requires spawnSessions to be enabled.
   */
```

with:

```ts
  /**
   * When true, LLMs can start tracked child sessions via the `spawn_subsession`
   * family of tools. On by default; requires `spawnSessions` to be enabled.
   */
```

Leave `subsessions?: boolean;` at `:478` and the `PiWebUiConfigEnvOverrides.subsessions: boolean` type unchanged.

- [ ] **Step 9: Rewrite the Settings panel field comment and remove the Beta badge**

In `src/client/src/components/settings/SettingsSessiondPanel.ts:48`, replace:

```ts
    // Beta, off by default; also requires spawn to be enabled.
```

with:

```ts
    // On by default; also requires spawn to be enabled.
```

Then, at `:129-131`, replace:

```ts
              <span>Allow agents to start tracked subsessions</span>
              <span class="beta-badge">beta</span>
              ${subsessionsOverridden ? html`<span class="override-badge">environment override</span>` : null}
```

with:

```ts
              <span>Allow agents to start tracked subsessions</span>
              ${subsessionsOverridden ? html`<span class="override-badge">environment override</span>` : null}
```

Leave `subsessionsOverridden` (`:47`), `effectiveSubsessions` (`:49`), the checkbox `?disabled` expression at `:137`, and the `Spawn sessions` / `Subsessions` summary rows unchanged.

- [ ] **Step 10: Replace the Settings help copy and delete the `.beta-badge` CSS rule**

In `src/client/src/components/settings/SettingsSessiondPanel.ts:142`, replace the whole help line:

```ts
            <small>Beta: agents can start child sessions they stay attached to (<code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>, <code>read_subsession</code>) and are notified when a child finishes. Requires "Allow agents to start sessions". Off by default.</small>
```

with this exact single line (the pinned final string; the four `<code>` elements are preserved and no tool name is added):

```ts
            <small>When enabled, agents can start child sessions they stay attached to (<code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>, <code>read_subsession</code>) and are notified when a child finishes. Requires "Allow agents to start sessions". On by default.</small>
```

Then delete the `.beta-badge` rule at `:237` by replacing:

```ts
    .override-badge { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); background: var(--pi-warning-surface); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: none; }
    .beta-badge { border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); background: var(--pi-bg); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .effective-card { display: grid; gap: 10px; }
```

with:

```ts
    .override-badge { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); background: var(--pi-warning-surface); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: none; }
    .effective-card { display: grid; gap: 10px; }
```

The removed class has no other consumer in the repository.

- [ ] **Step 11: Update `docs/config.md`**

In `docs/config.md:106`, replace:

```json
  "subsessions": false,
```

with:

```json
  "subsessions": true,
```

In `docs/config.md:157`, replace:

```md
| Tracked subsessions (beta) | `subsessions` | `PI_WEBUI_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon on that machine |
```

with:

```md
| Tracked subsessions | `subsessions` | `PI_WEBUI_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon on that machine |
```

In `docs/config.md:430`, replace:

```md
`subsessions` is beta and controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, and `yield_to_subsessions`. It defaults to `false` and also requires `spawnSessions` to be enabled.
```

with:

```md
`subsessions` controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, `yield_to_subsessions`, and the paired read-only `get_model_policy` inspection tool. It defaults to `true` and also requires `spawnSessions` to be enabled.
```

Leave the join/yield/notice paragraphs at `:432-438` and the Settings pointer at `:440` unchanged.

- [ ] **Step 12: Update `docs/config.html`**

In `docs/config.html:263`, replace:

```
  "subsessions": false,
```

with:

```
  "subsessions": true,
```

In `docs/config.html:412`, replace:

```html
                      <td>Tracked subsessions (beta)</td>
```

with:

```html
                      <td>Tracked subsessions</td>
```

In `docs/config.html:1063-1066`, replace:

```html
                Boolean. Beta. Controls whether agents receive the tracked-subsession tools:
                <code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>,
                <code>read_subsession</code>, and <code>yield_to_subsessions</code>. Defaults to <code>false</code> and also
                requires <code>spawnSessions</code> to be enabled.
```

with:

```html
                Boolean. Controls whether agents receive the tracked-subsession tools:
                <code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>,
                <code>read_subsession</code>, <code>yield_to_subsessions</code>, and the paired read-only
                <code>get_model_policy</code> inspection tool. Defaults to <code>true</code> and also
                requires <code>spawnSessions</code> to be enabled.
```

Leave the `</p>` at `:1067` and the join/yield/notice paragraphs that follow unchanged.

- [ ] **Step 13: Update `docs/install.html` and `docs/optional-skills.md`**

In `docs/install.html:348`, replace:

```
  "subsessions": false
```

with this last-key form (no trailing comma, matching `"spawnSessions": true,` at `:347`):

```
  "subsessions": true
```

In `docs/optional-skills.md:39`, replace:

```md
- Pi with subagent support, and `subsessions` enabled in your PI WEBUI config.
```

with:

```md
- Pi with subagent support; tracked subsessions are enabled by default and require `spawnSessions`.
```

`README.md` is unchanged.

- [ ] **Step 14: Create the Changeset**

Create `.changeset/subsessions-enabled-by-default.md` with exactly this content, including the trailing newline:

```md
---
"@hyperdreamer/pi-webui": minor
---

Enable the tracked-subsession tools (`spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, `yield_to_subsessions`) and the paired `get_model_policy` tool by default. The `subsessions` session-daemon setting now defaults to `true`; disable it with `subsessions: false` or `PI_WEBUI_SUBSESSIONS=0`. The new default applies after the session daemon on each machine restarts.
```

Keep the body as one unwrapped line, which is the specification's normative rule: `docs/superpowers/specs/2026-09-16-subsession-stabilization-spec.md:419` says "The body must be a single unwrapped paragraph on one line", and the example fragment it cites (`.changeset/speech-input-polishing.md`, added in commit `6ff3b4c`) stores its body on one line. The specification displays the body wrapped over six lines for readability; this plan joins those six displayed lines with single spaces and does not hard-wrap the result. Create no second changeset and do not edit `CHANGELOG.md`.

### Phase C — Pre-commit gates

- [ ] **Step 15: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit code 0 with no diagnostics. No type surface changed.

- [ ] **Step 16: Targeted lint and whitespace check**

Run:

```bash
npx eslint src/config.ts src/shared/apiTypes.ts src/server/sessions/piSessionService.ts src/client/src/components/settings/SettingsSessiondPanel.ts src/config.test.ts
git diff --check
```

Expected: both commands exit 0 with no output.

- [ ] **Step 17: Commit**

Run:

```bash
git add src/config.ts src/shared/apiTypes.ts src/server/sessions/piSessionService.ts src/client/src/components/settings/SettingsSessiondPanel.ts src/config.test.ts docs/config.md docs/config.html docs/install.html docs/optional-skills.md .changeset/subsessions-enabled-by-default.md
git commit -m "feat: enable tracked subsessions by default"
git show --stat --oneline HEAD
```

Expected: one commit whose subject is exactly `feat: enable tracked subsessions by default`, containing exactly the ten paths above. The repository's `.githooks/pre-commit` hook runs `npm run verify:staged` (cached typecheck, knip, scoped ESLint, and `vitest related` for the staged sources); let it run and require it to pass. It may take several minutes. If it fails, fix the cause and commit again rather than bypassing it. Record the commit sha.

### Phase D — Falsifiability (specification section 5.4)

These mutations run after the Step 17 commit on purpose: each revert is then an exact `git checkout -- <file>` of the committed, already-verified state, so no hand-reverse edit can corrupt the production change mid-cycle. The specification allows an in-place reverted mutation (`docs/superpowers/specs/2026-09-16-subsession-stabilization-spec.md:413`: "An in-place edit reverted before commit is acceptable for the implementer; if used, record the red output") and does not forbid reverting after the commit. No additional commit results from Phase D or E, and every mutation ends with `git status --porcelain` empty.

- [ ] **Step 18: Mutation 1 — `?? true` to `?? false`**

Edit `src/config.ts:626` from:

```ts
  return config.subsessions ?? true;
```

to:

```ts
  return config.subsessions ?? false;
```

Run:

```bash
npm test -- --run src/config.test.ts
```

Expected: FAIL, and the summary line reads `Tests  2 failed | 106 passed (108)`:

- `is on by default when nothing is configured` — `AssertionError: expected false to be true`
- `exposes the subsessions default in the effective config` — `AssertionError: expected false to be true`
- `honors an explicit config opt-out` still passes.

Record the red output, then revert and confirm the tree is clean:

```bash
git checkout -- src/config.ts
git status --porcelain
```

Expected: `git status --porcelain` prints no output.

- [ ] **Step 19: Mutation 2 — bypass the resolver in the effective config**

Edit `src/config.ts:197` from:

```ts
      subsessions: subsessionsEnabled(env, loaded.config),
```

to:

```ts
      subsessions: false,
```

Run:

```bash
npm test -- --run src/config.test.ts
```

Expected: FAIL, and the summary line reads `Tests  1 failed | 107 passed (108)`: `exposes the subsessions default in the effective config` fails with `AssertionError: expected false to be true`, while `is on by default when nothing is configured` still passes because it calls `subsessionsEnabled` directly. This pin binds the assembly wiring, not only the resolver. Record the output, then revert:

```bash
git checkout -- src/config.ts
git status --porcelain
```

Expected: no output.

- [ ] **Step 20: Mutation 3 — hard-code `true`**

Edit `src/config.ts:626` from:

```ts
  return config.subsessions ?? true;
```

to:

```ts
  return true;
```

Run:

```bash
npm test -- --run src/config.test.ts
```

Expected: FAIL, and the summary line reads `Tests  1 failed | 107 passed (108)`: `honors an explicit config opt-out` fails with `AssertionError: expected true to be false`, while `is on by default when nothing is configured` still passes. Record the output, then revert:

```bash
git checkout -- src/config.ts
git status --porcelain
```

Expected: no output.

- [ ] **Step 21: Mutation 4 — drop the config value**

Edit `src/config.ts:626` from:

```ts
  return config.subsessions ?? true;
```

to:

```ts
  return config.subsessions === undefined;
```

Run:

```bash
npm test -- --run src/config.test.ts
```

Expected: FAIL, and the summary line reads `Tests  1 failed | 107 passed (108)`: `honors an explicit config opt-in` fails with `AssertionError: expected false to be true`, while the default and opt-out tests still pass. This case is not a default pin; it passes under both `?? false` and `?? true`. Record the output, then revert:

```bash
git checkout -- src/config.ts
git status --porcelain
```

Expected: no output.

- [ ] **Step 22: Mutation 5 — bypass the environment override**

Edit `src/config.ts:625` from:

```ts
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv === "1" || fromEnv.toLowerCase() === "true";
```

to:

```ts
  if (false) return fromEnv === "1" || fromEnv.toLowerCase() === "true";
```

Run:

```bash
npm test -- --run src/config.test.ts
npx tsx -e 'import { subsessionsEnabled } from "./src/config.ts"; console.log(subsessionsEnabled({ PI_WEBUI_SUBSESSIONS: "1" }, { subsessions: false }), subsessionsEnabled({ PI_WEBUI_SUBSESSIONS: "0" }, { subsessions: true }));'
```

Expected: the suite reports `Tests  1 failed | 107 passed (108)`: `lets the env var override the config in both directions` fails on its first assertion with `AssertionError: expected false to be true` (a failed assertion aborts a Vitest test before its second assertion), while the default and opt-out tests still pass. The one-liner prints `false true`, which shows both override directions are broken; the correct unmutated value is `true false`. Record both outputs, then revert:

```bash
git checkout -- src/config.ts
git status --porcelain
```

Expected: no output.

- [ ] **Step 23: Beta-framing textual check and its mutation (section 7 step 4, section 5.4 row 7)**

Run the scoped check on the fixed tree:

```bash
rg -ni "beta|off by default" src/config.ts src/shared/apiTypes.ts src/server/sessions/piSessionService.ts src/client/src/components/settings/SettingsSessiondPanel.ts src/config.test.ts docs/config.md docs/config.html docs/install.html docs/optional-skills.md; echo "rg exit=$?"
```

Expected: no match lines; the only output is `rg exit=1`. Exit code 1 is the pass condition; an unrelated `beta` elsewhere in the repository is outside this check's scope.

Then mutate by re-inserting the comment line at `src/config.ts:196` so the resolution reads:

```ts
      // Beta capability, resolved off by default.
      subsessions: subsessionsEnabled(env, loaded.config),
```

and run the same check. Expected: a match line such as `src/config.ts:196:      // Beta capability, resolved off by default.` followed by `rg exit=0`. Then revert and re-run:

```bash
git checkout -- src/config.ts
git status --porcelain
rg -ni "beta|off by default" src/config.ts src/shared/apiTypes.ts src/server/sessions/piSessionService.ts src/client/src/components/settings/SettingsSessiondPanel.ts src/config.test.ts docs/config.md docs/config.html docs/install.html docs/optional-skills.md; echo "rg exit=$?"
```

Expected: `git status --porcelain` prints no output, and the `rg` check again prints only `rg exit=1`.

### Phase E — Verification gates

- [ ] **Step 24: Completion gate — `npm run verify:fast`**

Run:

```bash
npm run verify:fast
```

Expected: exit code 0 (`typecheck`, `lint`, `knip`, and the 4-worker test profile all pass). This is the completion gate; record the result. Do not run it concurrently with another full suite or other heavy job, per `.agents/skills/testing-guide/SKILL.md`. If it fails, surface the exact failure in the report: a failing fixture outside `src/config.test.ts` contradicts the design's verification claim and must be reported, not silently adjusted.

- [ ] **Step 25: CI-equivalent gate — `npm run verify`**

Run on an otherwise idle machine:

```bash
npm run verify
```

Expected: exit code 0 (the serial test profile). Record the result.

- [ ] **Step 26: Rendered Settings panel probe**

This probe renders the real Lit panel with jsdom against `effectivePiWebUiConfig` — the same resolver the web/API process uses — with no `subsessions` config key and no `PI_WEBUI_SUBSESSIONS` in the probe environment. It needs no session-daemon restart and no browser. Run from the repository root:

```bash
npx tsx - <<'PROBE'
import { JSDOM } from "jsdom";
import { effectivePiWebUiConfig } from "./src/config.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const w = dom.window as unknown as Record<string, unknown>;
(globalThis as Record<string, unknown>)["window"] = w;
for (const key of ["Document", "DocumentFragment", "Element", "SVGElement", "Text", "Comment", "Node", "HTMLElement", "HTMLInputElement", "HTMLDivElement", "HTMLTemplateElement", "ShadowRoot", "CustomElementRegistry", "CSSStyleSheet", "MutationObserver", "Event", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "NodeFilter"] as const) {
  (globalThis as Record<string, unknown>)[key] = (w as any)[key];
}
(globalThis as Record<string, unknown>)["document"] = dom.window.document;
(globalThis as Record<string, unknown>)["customElements"] = dom.window.customElements;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const { SettingsSessiondPanel } = await import("./src/client/src/components/settings/SettingsSessiondPanel.ts");

const CONFIG_PATH = "/tmp/pi-webui-subsessions-render-check/config.json";

async function render(env: NodeJS.ProcessEnv) {
  const effective = effectivePiWebUiConfig({ env });
  const panel = new SettingsSessiondPanel();
  (panel as any).configResponse = {
    path: effective.path,
    exists: effective.exists,
    config: {},
    effectiveConfig: effective.config,
    envOverrides: {
      host: false, port: false, allowedHosts: false,
      spawnSessions: env["PI_WEBUI_SPAWN_SESSIONS"] !== undefined,
      subsessions: env["PI_WEBUI_SUBSESSIONS"] !== undefined,
      agentCommand: false, agentDir: false, agentSessionDir: false,
    },
  };
  document.body.appendChild(panel);
  await (panel as any).updateComplete;
  const sr = panel.shadowRoot!;
  const subToggle = [...sr.querySelectorAll("label.toggle")].find((label) => label.textContent?.includes("spawn_subsession"));
  const input = subToggle?.querySelector('input[type="checkbox"]') as HTMLInputElement;
  const copy = [...sr.querySelectorAll("small")].find((s) => s.textContent?.includes("child sessions they stay attached to"))?.textContent?.trim() ?? "";
  const summary = [...sr.querySelectorAll("dt")].find((dt) => dt.textContent === "Subsessions")?.nextElementSibling?.textContent?.trim() ?? "";
  return { subsessions: effective.config.subsessions === true, checked: input.checked, disabled: input.disabled, badges: sr.querySelectorAll(".beta-badge").length, copyOnByDefault: copy.endsWith("On by default."), summary };
}

const baseEnv = { PI_WEBUI_CONFIG: CONFIG_PATH };
const none = await render(baseEnv);
const spawnOff = await render({ ...baseEnv, PI_WEBUI_SPAWN_SESSIONS: "0" });
const envOverride = await render({ ...baseEnv, PI_WEBUI_SUBSESSIONS: "1" });

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`render check failed: ${label}`);
}

check(none.subsessions && none.checked && !none.disabled && none.badges === 0 && none.copyOnByDefault && none.summary === "Enabled", "default: subsessions enabled with no Beta framing");
check(!spawnOff.checked && spawnOff.disabled && spawnOff.summary === "Disabled", "spawn-off: checkbox disabled and summary Disabled");
check(envOverride.checked && envOverride.disabled && envOverride.summary === "Enabled", "env-override: checkbox disabled");

console.log(`default: subsessions=${none.subsessions} checked=${none.checked} disabled=${none.disabled} badges=${none.badges} copyOnByDefault=${none.copyOnByDefault} summary=${none.summary}`);
console.log(`spawn-off: checked=${spawnOff.checked} disabled=${spawnOff.disabled} summary=${spawnOff.summary}`);
console.log(`env-override: checked=${envOverride.checked} disabled=${envOverride.disabled} summary=${envOverride.summary}`);
console.log("RENDER CHECK PASS");
PROBE
```

Expected: exit code 0 and exactly:

```text
default: subsessions=true checked=true disabled=false badges=0 copyOnByDefault=true summary=Enabled
spawn-off: checked=false disabled=true summary=Disabled
env-override: checked=true disabled=true summary=Enabled
RENDER CHECK PASS
```

The probe fails with `render check failed: default: subsessions enabled with no Beta framing` if the checkbox is unchecked, a Beta pill is rendered, the help copy does not end "On by default.", or the summary row is not `Enabled`; it fails with `render check failed: spawn-off: ...` when `PI_WEBUI_SPAWN_SESSIONS=0` leaves the checkbox enabled; and it fails with `render check failed: env-override: ...` when `PI_WEBUI_SUBSESSIONS=1` leaves it enabled. Record the output.

- [ ] **Step 27: Panel pin falsifiability — confirm there is no Vitest pin by design**

Run the panel suite on the fixed tree:

```bash
npm test -- --run src/client/src/components/settings/SettingsSessiondPanel.test.ts
```

Expected: PASS, and the summary line reads `Tests  6 passed (6)`.

Now mutate the template: at `SettingsSessiondPanel.ts:129-131`, restore the badge line, and at `:142` restore the old help line:

```ts
              <span>Allow agents to start tracked subsessions</span>
              <span class="beta-badge">beta</span>
              ${subsessionsOverridden ? html`<span class="override-badge">environment override</span>` : null}
```

```ts
            <small>Beta: agents can start child sessions they stay attached to (<code>spawn_subsession</code>, <code>list_subsessions</code>, <code>check_subsession</code>, <code>read_subsession</code>) and are notified when a child finishes. Requires "Allow agents to start sessions". Off by default.</small>
```

Run the panel suite again:

```bash
npm test -- --run src/client/src/components/settings/SettingsSessiondPanel.test.ts
```

Expected: still `Tests  6 passed (6)`. There is deliberately no Vitest pin for static template content (specification section 5.3), so the suite must not catch this mutation. Leave the mutation in place for Step 28.

- [ ] **Step 28: Confirm the rendered probe is the catch, then revert**

With the Step 27 mutation still in place, run the Step 26 probe command again. Expected: exit code non-zero with `Error: render check failed: default: subsessions enabled with no Beta framing`, which is the rendered check the specification assigns to this static content.

Revert and confirm:

```bash
git checkout -- src/client/src/components/settings/SettingsSessiondPanel.ts
git status --porcelain
```

Expected: `git status --porcelain` prints no output. Run the Step 26 probe once more. Expected: exit code 0 with the four expected lines ending `RENDER CHECK PASS`. Record all three outputs.

- [ ] **Step 29: Session-daemon restart handoff**

The new default is not live in a running session-daemon process until it restarts. Record this handoff sentence verbatim in the report and in the final message to the user:

"Restart `pi-webui-sessiond.service` on each affected machine before expecting agents to receive the tracked-subsession tools: the new `subsessions` default reaches the live session runtime only when the daemon restarts."

The web/API process and the Settings panel can show the new default before that restart, so a checked toggle with unchanged agent capability is expected until the daemon restarts. No `src/server/sessiond.ts` change is needed: it resolves the default through `effectivePiWebUiConfig` (`:58`) and consumes the resolved boolean (`:138`).

Steps 18 through 28 produced no commit: every mutation was reverted, and `git status --porcelain` is empty.
