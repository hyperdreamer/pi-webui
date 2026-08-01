# Model Tier Registry Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the selected-machine **Model tiers** Settings section that lets users inspect and atomically save the complete six-tier model/thinking ladder against the session daemon's live authenticated model catalog.

**Architecture:** Keep the ladder in the existing global PI WEBUI config (`modelTiers`) and keep the live model catalog in the long-lived session daemon. Add one daemon-owned `model-tiers` route that composes the saved ladder, available model options, supported thinking levels, and per-row validation; expose it through the existing local/remote session proxy and federation paths. Keep UI draft/compatibility rules in a pure client module and keep the Lit panel as rendering and event-wiring glue. Do not put this feature in `ModelsConfigDialog` or `SettingsSessiondPanel`.

**Tech Stack:** TypeScript, Fastify, Lit, `@earendil-works/pi-ai`, existing machine federation/session-daemon proxy, Vitest, native DOM component tests where practical.

## Global Constraints

- The settings entry is a dedicated `modeltiers` section with selected-machine scope.
- The six canonical rows remain ordered: Economy, Fast, Standard, Advanced, Capable, Frontier.
- A saved ladder contains all six rows and each row contains `{ model: { provider, id }, thinkingLevel }`.
- Model options come only from the selected machine's current authenticated model-runtime snapshot.
- A thinking level unsupported by a selected model is invalid; never clamp it silently.
- A stale saved model remains visible as the current invalid value until the user selects an available replacement.
- Save is disabled unless every row is locally complete and valid; the server revalidates the complete ladder before writing it.
- Saving replaces only `modelTiers` and preserves unrelated PI WEBUI configuration keys.
- The browser uses application-relative paths and resolves each path exactly once through the existing API client boundary.
- Remote-machine support is additive and capability-gated; stale responses from another machine must not replace the current draft.
- Settings UI changes do not belong in `ModelsConfigDialog` or `SettingsSessiondPanel`.
- Do not implement Exact/Tiered composer controls, tier directives, session policy persistence, or the deterministic SDD skill in this plan; those are separate parts of the larger approved specification.
- Use TDD and the repository testing guide: pure validation first, route contracts next, then component boundaries and broader verification.
- The new route is loaded by `src/server/sessiond.ts`; after implementation the user must manually restart `pi-webui-sessiond.service` in the local split-service environment.
- Add or update the existing patch Changeset for this user-visible UI capability; never edit `CHANGELOG.md` manually.

## File Map

### Shared and daemon contracts

- Modify `src/shared/apiTypes.ts` with model-option, row-validation, settings-snapshot, and capability types.
- Create `src/server/sessions/modelTierSettingsService.ts` for catalog projection, ladder inspection, per-row validation, and validated replacement.
- Create `src/server/sessions/modelTierSettingsRoutes.ts` for the thin Fastify route adapter.
- Modify `src/server/sessiond.ts` to construct the service and register its routes.
- Modify `src/shared/federatedRoutes.ts` and `src/server/sessiond/sessionProxyRoutes.ts` to forward `GET/PUT /model-tiers` for local and remote selected machines.
- Modify `src/shared/capabilities.ts` and capability tests for the additive model-tier capability.

### Browser contracts and draft

- Modify `src/client/src/api/parsers.ts`, `src/client/src/api/clients.ts`, and `src/client/src/api.ts` for the new response parser and `modelTiersApi` client.
- Create `src/client/src/components/settings/modelTierLadderDraft.ts` for pure draft, compatibility, stale-row, and validation behavior.
- Create `src/client/src/components/settings/modelTierLadderDraft.test.ts`.

### Settings UI and integration

- Create `src/client/src/components/settings/SettingsModelTiersPanel.ts` and its focused component tests.
- Modify `src/client/src/settingsRoute.ts` for the `modeltiers` URL section.
- Modify `src/client/src/components/SettingsDialog.ts` for navigation, loading, saving, capability handling, stale-request guards, and panel routing.
- Modify `src/client/src/components/SettingsDialog.test.ts` and `src/client/src/settingsRoute.test.ts`.

### User-facing documentation and release metadata

- Modify `docs/config.md` and `docs/config.html` with the canonical `modelTiers` settings behavior.
- Modify `.changeset/model-tier-registry.md` to include the Settings UI in the existing feature note.

---

## Task 1: Define the model-tier settings snapshot and pure daemon service

**Files:**
- Modify: `src/shared/apiTypes.ts`
- Create: `src/server/sessions/modelTierSettingsService.ts`
- Create: `src/server/sessions/modelTierSettingsService.test.ts`

**Interfaces:**

The shared response contract is:

```ts
export interface ModelTierModelOption {
  model: TierModelRef;
  name?: string;
  thinkingLevels: string[];
}

export interface ModelTierRowValidation {
  valid: boolean;
  reason?: string;
}

export interface ModelTierSettingsResponse {
  contractVersion: 1;
  ladder?: ModelTierLadder;
  models: ModelTierModelOption[];
  rows: Record<ModelTier, ModelTierRowValidation>;
  valid: boolean;
  configError?: string;
}
```

The service exposes an injected, testable boundary:

```ts
export interface ModelTierSettingsService {
  inspect(): Promise<ModelTierSettingsResponse>;
  replace(ladder: ModelTierLadder): Promise<ModelTierSettingsResponse>;
}
```

- [ ] **Step 1: Add shared response and capability types**

Add the response types above to `src/shared/apiTypes.ts`. Add an additive capability such as `settings.modelTiers` to `PI_WEBUI_CAPABILITIES`; keep its wire value a string and keep the response `contractVersion` literal at `1`.

Do not reuse `SessionDefaultsResponse` for this contract. The tier response must preserve the complete configured ladder separately from the catalog and report a validation result for each canonical tier.

- [ ] **Step 2: Write service RED tests**

Cover these observable behaviors in `modelTierSettingsService.test.ts`:

1. `inspect()` refreshes the model runtime with `{ allowNetwork: false }`, projects every available model with its supported thinking levels, and returns the configured ladder.
2. A complete ladder whose models and thinking levels are currently available returns `valid: true` and six valid row results.
3. A syntactically valid ladder that names an unavailable model retains that ladder but marks only the affected row invalid with the exact provider/model in the reason.
4. A syntactically valid ladder that names an unsupported thinking level retains that ladder and marks the row invalid without clamping.
5. Missing configuration returns a response with no ladder and six invalid rows; it does not prevent the catalog from loading.
6. An externally malformed ladder returns `configError` and no misleading valid ladder.
7. `replace()` validates every row against one refreshed snapshot before calling the injected save function.
8. An invalid replacement rejects and never calls save.
9. A valid replacement calls save once with only the complete ladder patch and returns the confirmed post-save inspection.

Use small injected fakes for config load/save and model runtime; do not boot Fastify or the session daemon for these tests.

- [ ] **Step 3: Run service RED**

```bash
npm test -- --run src/server/sessions/modelTierSettingsService.test.ts
```

Expected: the new test file fails because the service and response contract do not exist.

- [ ] **Step 4: Implement the service**

Implement a focused `ModelTierSettingsService`/factory that:

1. refreshes the injected runtime without network discovery;
2. projects available runtime models to `ModelTierModelOption` using `getSupportedThinkingLevels`/the existing `runtimeThinkingLevels` seam;
3. reads `modelTiers` and `modelTiersError` through an injected config loader;
4. validates each canonical tier independently by reusing `resolveTier` from `modelTierRegistry.ts`, so stale rows are reported individually;
5. treats a missing or invalid ladder as an actionable configuration state rather than inventing defaults; and
6. validates a replacement completely before invoking `savePiWebUiConfig` through the injected saver.

The service must not delete stale rows, choose neighboring tiers, or clamp thinking levels. Keep file access and runtime refresh behind injected dependencies so unit tests remain pure at the decision boundary.

- [ ] **Step 5: Run service GREEN and typecheck**

```bash
npm test -- --run src/server/sessions/modelTierSettingsService.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit Task 1**

```bash
git add src/shared/apiTypes.ts src/server/sessions/modelTierSettingsService.ts src/server/sessions/modelTierSettingsService.test.ts
git commit -m "feat: add model-tier settings snapshot service"
```

## Task 2: Add daemon routes, local/remote forwarding, and capability gating

**Files:**
- Create: `src/server/sessions/modelTierSettingsRoutes.ts`
- Create: `src/server/sessions/modelTierSettingsRoutes.test.ts`
- Modify: `src/server/sessiond.ts`
- Modify: `src/server/sessiond/sessionProxyRoutes.ts`
- Modify: `src/server/sessiond/sessionProxyRoutes.test.ts`
- Modify: `src/shared/federatedRoutes.ts`
- Modify: `src/shared/capabilities.ts`
- Modify: `src/shared/capabilities.test.ts`

**Interfaces:**

Expose these daemon endpoints:

```text
GET /model-tiers
PUT /model-tiers
```

The PUT body is:

```json
{
  "ladder": {
    "economy": { "model": { "provider": "...", "id": "..." }, "thinkingLevel": "low" },
    "fast": { "model": { "provider": "...", "id": "..." }, "thinkingLevel": "medium" },
    "standard": { "model": { "provider": "...", "id": "..." }, "thinkingLevel": "medium" },
    "advanced": { "model": { "provider": "...", "id": "..." }, "thinkingLevel": "high" },
    "capable": { "model": { "provider": "...", "id": "..." }, "thinkingLevel": "xhigh" },
    "frontier": { "model": { "provider": "...", "id": "..." }, "thinkingLevel": "max" }
  }
}
```

- [ ] **Step 1: Write route RED tests**

Add route tests that verify:

- GET returns the service snapshot unchanged with status 200;
- PUT accepts exactly one complete ladder, calls `replace`, and returns the confirmed snapshot;
- malformed, partial, unknown-tier, or unknown-field ladder input returns status 400 with an actionable error;
- runtime/config validation failure returns status 400 and does not report success;
- route failures are not converted into a 500 when they are user-correctable validation errors.

Extend proxy tests to verify `/api/machines/local/model-tiers` is forwarded to `/model-tiers` and remote federation permits both GET and PUT `/model-tiers` while still rejecting unlisted routes.

- [ ] **Step 2: Run route RED**

```bash
npm test -- --run src/server/sessions/modelTierSettingsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/shared/capabilities.test.ts
```

Expected: failures identify the missing route registration, proxy allowlist, and capability.

- [ ] **Step 3: Register the daemon route**

Construct the service in `sessiond.ts` with:

- `loadConfig` backed by `loadPiWebUiConfig()` while preserving `modelTiersError`;
- `saveConfig` backed by `savePiWebUiConfig({ modelTiers: ladder })`, which preserves unrelated config keys;
- the existing authenticated `auth.runtime` model catalog;
- the existing `runtimeThinkingLevels` projection.

Register `registerModelTierSettingsRoutes(app, modelTiers)` beside the existing models and session-defaults routes. Keep the route adapter thin: parse the request, call the service, and map errors to the existing `{ error }` response convention.

- [ ] **Step 4: Wire local and remote forwarding**

Add `/model-tiers` to `sessionProxyRoutes.ts` so `/api/machines/local/model-tiers` reaches the daemon. Add GET and PUT entries to `FEDERATED_HTTP_ROUTES` so `/api/machines/:machineId/model-tiers` reaches a remote machine's local daemon route. Preserve the existing encoded machine-id and safe-header behavior.

Add the capability to both web/sessiond runtime capability lists and require both components for the effective capability. Remote Settings must show unavailable/upgrade guidance when the capability is absent rather than issuing a route that the peer cannot support.

- [ ] **Step 5: Run route GREEN and focused lint**

```bash
npm test -- --run src/server/sessions/modelTierSettingsRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/shared/capabilities.test.ts
npx eslint src/server/sessions/modelTierSettingsRoutes.ts src/server/sessions/modelTierSettingsService.ts src/server/sessiond/sessionProxyRoutes.ts src/shared/capabilities.ts
```

- [ ] **Step 6: Commit Task 2**

```bash
git add src/server/sessions/modelTierSettingsRoutes.ts src/server/sessions/modelTierSettingsRoutes.test.ts src/server/sessiond.ts src/server/sessiond/sessionProxyRoutes.ts src/server/sessiond/sessionProxyRoutes.test.ts src/shared/federatedRoutes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts
git commit -m "feat: expose selected-machine model-tier settings routes"
```

## Task 3: Add the browser client contract and pure ladder draft

**Files:**
- Modify: `src/client/src/api/parsers.ts`
- Modify: `src/client/src/api/clients.ts`
- Modify: `src/client/src/api.ts`
- Create: `src/client/src/components/settings/modelTierLadderDraft.ts`
- Create: `src/client/src/components/settings/modelTierLadderDraft.test.ts`
- Modify: `src/client/src/api/parsers.test.ts`
- Modify: `src/client/src/api/clients.test.ts`

**Interfaces:**

Add an application-relative client API:

```ts
export const modelTiersApi = {
  settings: (machineId = "local") => request(modelTiersPath(machineId), parseModelTierSettingsResponse),
  save: (ladder: ModelTierLadder, machineId = "local") => request(
    modelTiersPath(machineId),
    parseModelTierSettingsResponse,
    { method: "PUT", body: JSON.stringify({ ladder }) },
  ),
};
```

`modelTiersPath(machineId)` must return an unresolved `Path` using `encodeURIComponent(machineId)`; `request()` remains the only HTTP URL resolution boundary.

The pure draft module exposes:

```ts
export interface ModelTierDraftRow {
  model?: TierModelRef;
  thinkingLevel: string;
}

export type ModelTierLadderDraft = Record<ModelTier, ModelTierDraftRow>;

export function emptyModelTierLadderDraft(): ModelTierLadderDraft;
export function modelTierLadderDraftFromResponse(response: ModelTierSettingsResponse): ModelTierLadderDraft;
export function updateTierModel(draft: ModelTierLadderDraft, tier: ModelTier, option: ModelTierModelOption): ModelTierLadderDraft;
export function updateTierThinkingLevel(draft: ModelTierLadderDraft, tier: ModelTier, thinkingLevel: string): ModelTierLadderDraft;
export function validateModelTierDraft(draft: ModelTierLadderDraft, models: readonly ModelTierModelOption[]): ModelTierLadderValidation;
export function modelTierLadderFromDraft(draft: ModelTierLadderDraft, models: readonly ModelTierModelOption[]): ModelTierLadder | undefined;
```

- [ ] **Step 1: Write parser/client RED tests**

Test parsing of:

- a valid contract-version-1 response with six rows, stale ladder values, and model options;
- optional `ladder` and `configError` when the external config is missing/malformed;
- rejection of malformed model references, thinking-level arrays, row maps, or contract versions;
- URL encoding of machine IDs and use of the PUT body `{ ladder }`.

- [ ] **Step 2: Write draft RED tests**

Cover these exact transitions:

1. An absent ladder creates six empty rows in canonical order.
2. A configured ladder maps to six draft rows without changing provider/model separation when an ID contains `/`.
3. Selecting a new model preserves the current thinking level only if the new model supports it.
4. Selecting a model that does not support the current thinking level clears that row's thinking field and marks the row incomplete; it never substitutes the first supported level.
5. Missing model, empty thinking, unavailable model, and unsupported thinking each produce a row-specific validation error.
6. A complete valid draft converts to a `ModelTierLadder`; an incomplete draft converts to `undefined`.
7. Duplicate exact tuples across tiers remain valid.
8. A stale configured model remains represented in the draft even though it is absent from the current option list.

- [ ] **Step 3: Run client RED**

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/components/settings/modelTierLadderDraft.test.ts
```

- [ ] **Step 4: Implement parser, API, and draft module**

Add the response parser using the existing parser primitives. Keep wire thinking levels as strings so a newer daemon response can render safely; the draft only accepts a level advertised by the selected model. `updateTierModel` must receive the complete selected `ModelTierModelOption`, not only a `TierModelRef`, so compatibility is always checked: preserve the current thinking level only when the option advertises it, otherwise clear it. The option parameter is required; there is no permissive overload that can retain an unchecked level. Use immutable updates for draft rows and preserve the canonical `MODEL_TIERS` ordering.

When a configured model is stale, synthesize a display-only current option in the panel layer rather than mutating the server response or deleting the saved value.

- [ ] **Step 5: Run client GREEN and typecheck**

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/components/settings/modelTierLadderDraft.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit Task 3**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/clients.ts src/client/src/api.ts src/client/src/components/settings/modelTierLadderDraft.ts src/client/src/components/settings/modelTierLadderDraft.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts
git commit -m "feat: add model-tier settings client draft"
```

## Task 4: Build the accessible responsive Model tiers panel

**Files:**
- Create: `src/client/src/components/settings/SettingsModelTiersPanel.ts`
- Create: `src/client/src/components/settings/SettingsModelTiersPanel.test.ts`

**Interfaces:**

The panel follows the existing `SettingsPanelFrame` contract and receives confirmed response/draft state from `SettingsDialog`:

```ts
@property({ attribute: false }) response: ModelTierSettingsResponse | undefined;
@property({ type: Boolean }) loading = false;
@property({ type: Boolean }) saving = false;
@property() error = "";
@property() savedMessage = "";
@property() targetLabel = "selected machine";
@property({ attribute: false }) support: SelectedMachineSettingsSupport = { state: "supported" };
@property({ attribute: false }) onReload?: () => void | Promise<void>;
@property({ attribute: false }) onSave?: (ladder: ModelTierLadder) => void | Promise<void>;
```

- [ ] **Step 1: Write component RED tests**

Use real DOM/custom-element interaction where practical. Assert user-visible behavior, not Lit template internals:

1. The panel renders the six ordered rows with labels Economy through Frontier and an arrow/step column.
2. Each model selector contains available provider/model choices and each thinking selector contains only the selected model's supported levels.
3. An unavailable configured model remains visible as the selected stale value with an actionable invalid state.
4. Changing a model clears an incompatible thinking value and leaves Save disabled until the user explicitly selects a supported level.
5. Save is disabled for any invalid row and enabled only for a complete valid ladder.
6. Save emits exactly one complete ladder to `onSave`; it does not emit partial row patches.
7. Reload invokes the reload callback; server error and configuration error appear in an alert/notices region while the attempted draft remains visible.
8. Unsupported/unknown remote capability renders an upgrade/unavailable message and disables editing.
9. On narrow viewport styles, rows become cards while retaining their canonical DOM order and accessible labels.

- [ ] **Step 2: Run component RED**

```bash
npm test -- --run src/client/src/components/settings/SettingsModelTiersPanel.test.ts
```

- [ ] **Step 3: Implement the panel**

Render:

```text
Model tiers · <selected machine>
Configure the six exact model/thinking bindings used by tiered sessions.
[Refresh models]

     Tier       Available model                         Thinking
  1  Economy    [ provider / model                 ▾ ] [ level ▾ ]
  ↓  Fast       [ provider / model                 ▾ ] [ level ▾ ]
  ↓  Standard   [ provider / model                 ▾ ] [ level ▾ ]
  ↓  Advanced   [ provider / model                 ▾ ] [ level ▾ ]
  ↓  Capable    [ provider / model                 ▾ ] [ level ▾ ]
  6  Frontier   [ provider / model                 ▾ ] [ level ▾ ]

6 of 6 tiers valid                         [Save complete ladder]
```

Use native `<select>` elements, visible labels, `aria-invalid` for invalid rows, and an `aria-live` status/alert for save errors. Include provider and model ID in accessible text/title when visual text is truncated. Keep stale selections as a selected disabled/current option with an explicit unavailable label, while offering current catalog replacements.

Use `SettingsPanelFrame` for the heading, description, reload action, and notice stack. Keep all row changes in the pure draft module; the component only delegates updates and derives display state. Do not clamp thinking levels when model selection changes.

Add narrow-screen CSS that changes the table rows to compact cards without reordering or hiding a tier. Do not require a new dependency.

- [ ] **Step 4: Run component GREEN and lint**

```bash
npm test -- --run src/client/src/components/settings/SettingsModelTiersPanel.test.ts
npx eslint src/client/src/components/settings/SettingsModelTiersPanel.ts src/client/src/components/settings/modelTierLadderDraft.ts
```

- [ ] **Step 5: Commit Task 4**

```bash
git add src/client/src/components/settings/SettingsModelTiersPanel.ts src/client/src/components/settings/SettingsModelTiersPanel.test.ts
git commit -m "feat: add model tiers settings panel"
```

## Task 5: Integrate the panel into Settings with machine guards and stale-response protection

**Files:**
- Modify: `src/client/src/settingsRoute.ts`
- Modify: `src/client/src/settingsRoute.test.ts`
- Modify: `src/client/src/components/SettingsDialog.ts`
- Modify: `src/client/src/components/SettingsDialog.test.ts`
- Modify: `src/client/src/components/PiWebUiApp.ts` only if compilation requires a public settings-section wiring update
- Modify: relevant Settings test support fixtures as needed, without changing production behavior outside this section

**Interfaces:**

Add `modeltiers` to `SettingsSection` and parse it from `?settings=modeltiers`. Add `settings-model-tiers-panel` to the `SettingsPanelTag` union and its `activeSettingsPanelTag` switch.

The Settings nav entry is:

```text
Model tiers
Selected machine
```

- [ ] **Step 1: Write routing/integration RED tests**

Add tests for:

1. `parseSettingsSection("modeltiers")` returns the new section and unknown values remain rejected.
2. `activeSettingsPanelTag("modeltiers")` returns `settings-model-tiers-panel`.
3. The Settings dialog renders the new nav entry and panel when selected.
4. Opening or changing the selected machine loads `/model-tiers` for that machine.
5. A late response from the previous machine cannot replace the current response or draft.
6. Save sends the complete ladder to the current machine and updates the confirmed state only after the API resolves.
7. Failed save keeps the attempted draft and displays the error.
8. Unknown/unsupported remote capability makes the panel inspectable but non-editable with the existing selected-machine support message.
9. Changing machine resets the old draft and loading/error state.

- [ ] **Step 2: Run integration RED**

```bash
npm test -- --run src/client/src/settingsRoute.test.ts src/client/src/components/SettingsDialog.test.ts
```

- [ ] **Step 3: Add Settings section and state ownership**

Import `SettingsModelTiersPanel`, add the nav button, route branch, and panel tag. Give `SettingsDialog` a dedicated response/loading/error/request-sequence state for model tiers rather than coupling it to the Session daemon or General panel state.

Use `modelTiersApi.settings(target.id)` and `modelTiersApi.save(ladder, target.id)`. On machine changes, increment the model-tier request sequence, clear the old response/draft, and ignore any response whose sequence or target ID is stale. On save, replace the panel's confirmed response only after the server returns the parsed snapshot.

Use `selectedMachineSettingsSupport` plus the new model-tier capability to distinguish supported, unknown, and unsupported remote targets. The local target remains supported. The panel must not issue a model-tier request to an unsupported remote peer.

Keep the Settings dialog's existing close/navigation/history behavior unchanged. The new section should work when opened directly through `?settings=modeltiers` and when navigated from the Settings nav.

- [ ] **Step 4: Run integration GREEN and focused lint**

```bash
npm test -- --run src/client/src/settingsRoute.test.ts src/client/src/components/SettingsDialog.test.ts
npx eslint src/client/src/settingsRoute.ts src/client/src/components/SettingsDialog.ts
npm run typecheck
```

- [ ] **Step 5: Commit Task 5**

```bash
git add src/client/src/settingsRoute.ts src/client/src/settingsRoute.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.test.ts src/client/src/components/PiWebUiApp.ts
git commit -m "feat: wire model tiers into selected-machine settings"
```

## Task 6: Document the setting, update release metadata, and perform full verification

**Files:**
- Modify: `docs/config.md`
- Modify: `docs/config.html`
- Modify: `.changeset/model-tier-registry.md`
- Add focused documentation tests only if an existing docs test requires them; do not add duplicate documentation surfaces.

- [ ] **Step 1: Update canonical configuration documentation**

Document in both synchronized config surfaces:

- `modelTiers` is a machine-global setting in `$PI_WEBUI_CONFIG` or `~/.config/pi-webui/config.json`;
- the Settings → Model tiers page edits one complete six-rung ladder;
- each row selects an available authenticated model and supported thinking level;
- duplicate tuples are valid;
- stale models remain visible and must be repaired explicitly;
- save validates all six rows atomically and never silently clamps/falls back;
- a malformed/missing ladder leaves Exact-mode functionality usable but makes tiered routing unavailable; and
- remote machines require a peer with the additive model-tier capability.

Do not add this detailed configuration behavior to `README.md`.

- [ ] **Step 2: Update the existing Changeset**

Keep `.changeset/model-tier-registry.md` as the single patch fragment for this feature and revise its user-facing text to mention both typed tier binding and the new Settings → Model tiers ladder editor. Do not create a second redundant fragment unless the existing fragment has already been consumed by release preparation.

- [ ] **Step 3: Run focused verification**

```bash
npm test -- --run \
  src/server/sessions/modelTierSettingsService.test.ts \
  src/server/sessions/modelTierSettingsRoutes.test.ts \
  src/server/sessiond/sessionProxyRoutes.test.ts \
  src/shared/capabilities.test.ts \
  src/client/src/components/settings/modelTierLadderDraft.test.ts \
  src/client/src/components/settings/SettingsModelTiersPanel.test.ts \
  src/client/src/components/SettingsDialog.test.ts \
  src/client/src/settingsRoute.test.ts
npm run typecheck
npx eslint src/server/sessions/modelTierSettingsService.ts src/server/sessions/modelTierSettingsRoutes.ts src/client/src/components/settings/modelTierLadderDraft.ts src/client/src/components/settings/SettingsModelTiersPanel.ts src/client/src/components/SettingsDialog.ts src/client/src/settingsRoute.ts
git diff --check
```

- [ ] **Step 4: Run the repository verification suite**

```bash
npm run verify
```

Expected: the full suite passes with no new skips or failures. If the route is loaded only by the long-lived daemon, record the required manual `pi-webui-sessiond.service` restart in the handoff; do not claim the running daemon has loaded the route until it is restarted.

- [ ] **Step 5: Review the final diff and commit documentation**

```bash
git status --short
git diff --stat HEAD~5..HEAD
git diff --check
git add docs/config.md docs/config.html .changeset/model-tier-registry.md
git commit -m "docs: document model-tier settings"
```

## Spec coverage and deliberate boundary

This plan covers the approved Settings placement and ordered ladder editor, selected-machine ownership, live model/thinking catalog, stale-value handling, atomic validation/save, responsive/accessibility behavior, remote capability gating, and documentation/release metadata.

It deliberately does **not** implement the separate Exact/Tiered session mode control, starter/active composer policy UI, `/tier-*` command processing, session model-policy routes, policy persistence, or deterministic SDD replacement. Those require the remaining session-policy portion of `2026-07-31-tiered-session-model-policy-and-deterministic-sdd-design.md` and should be planned independently rather than hidden inside this settings-panel change.
