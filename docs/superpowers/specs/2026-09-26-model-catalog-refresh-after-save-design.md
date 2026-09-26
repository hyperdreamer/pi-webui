# Model catalog refresh after a Models-dialog save — Design

- **Status:** Approved (design); design review clean (round 2, zero blockers; five minor corrections applied)
- **Date:** 2026-09-26
- **PM run:** `pm-run-20260926-203715-d28ec8b9`
- **Topic slug:** `model-catalog-refresh`
- **Delivery target:** `refs/heads/main` @ `13d4c52c7597160317fa7bdcc9504518f92006f0`
- **Related user request:** "After adding a new model, I have to refresh the current session before it becomes available, even though it is already selectable."

## Background

Adding a model through Settings → Models saves `models.json` and refreshes the session
daemon's shared `ModelRuntime` (`src/server/models/modelsConfigService.ts`,
`refreshAfterSave`), and the tier-catalog endpoint always returns a fresh runtime snapshot
(`src/server/sessions/modelTierSettingsService.ts`, `refreshedSnapshot`). The server side
is therefore current immediately after a save.

The browser, however, caches one `ModelTierSettingsResponse` per selected machine in
`PiWebUiApp` (`modelTierCatalog` + `modelTierCatalogMachineId`). That cache is populated
on first need and refreshed only by:

- a machine change (`resetModelTierCatalogForMachineChange`, `PiWebUiApp.ts:2121`), or
- a tier-ladder save (`handleModelTiersSaved`, `PiWebUiApp.ts:2139`).

A Models-dialog save has no invalidation path. `ModelsConfigDialog` already declares and
invokes an `onSaved` callback after a successful save (`ModelsConfigDialog.ts:77` and
`:564`), but `PiWebUiApp` renders the dialog without binding it (`PiWebUiApp.ts:4863`).

The two model projections then disagree for the rest of the browser session:

- the picker dialog lists live `listModels()` results (`openModelDialog`,
  `PiWebUiApp.ts:3818`), so the new model is visibly selectable; but
- the policy-aware apply paths require the model in the cached catalog (`pickModel`,
  `PiWebUiApp.ts:3846`; `pickStarterModel`), so selecting it fails closed: `pickModel`
  records `Model <provider>/<id> is unavailable in the model policy catalog` while
  `pickStarterModel` declines without a diagnostic, and tier rows, tier resolutions, and
  draft readiness (`isDraftReadyToApply`, `sessionModelPolicyDraft.ts:192`) are computed
  from the stale list.

Confirmed evidence (temporary component-boundary probe, deleted after running): with the
server already serving the fresh catalog and `listModels()` already returning
`openai/gpt-new`, the picker offered `openai/gpt-new`, `pickModel` refused it without
calling `saveModelPolicy`, and after one catalog reload the identical pick applied
`{ mode: "exact", exact: { model: { provider: "openai", id: "gpt-new" },
thinkingLevel: "medium" } }`.

## Goals

1. After a successful Models-dialog save for the selected machine, the app re-reads that
   machine's tier catalog and publishes it, so the current session's model picker, tier
   controls, and draft validation operate on the fresh list without a page refresh. The
   same refresh covers the policy-enabled starter composer, which also reads the catalog.
2. Revalidate the active session's model policy against the new catalog when a policy
   composer is showing, mirroring the existing tier-ladder-save behavior, so
   `ladderValid`/`blockedReason` and tier resolutions are not stale.
3. Keep the ladder-save and models-save invalidation semantics identical by sharing one
   publish/revalidate implementation.
4. Fail closed and visibly: a failed or superseded refresh must not publish a partial
   catalog, must not reject or roll back the already-successful save, and must leave the
   previous catalog plus the existing catalog error diagnostic in place. Policy
   revalidation runs only after a successful publish, so a failed refresh cannot mask the
   catalog diagnostic with a policy error.

## Non-goals

- **External `models.json` edits.** Changes made by an editor, another browser, or SSH are
  not detected. There is no background polling, watcher, or realtime push.
- **Auth-driven catalog changes.** Login/logout can change the available-model set
  (`ModelRuntime.getAvailableSnapshot()` filters to providers with configured auth), and
  the browser cache is not invalidated on that path. Recorded as a follow-up candidate
  below; it needs a new AuthController completion contract and is intentionally out of
  this fix.
- **Any server, sessiond, or browser-API-contract change.** The fix is client-only, so the
  `pi-webui-ui-dev` autoreload path applies and no session-daemon restart is needed.
- **UI redesign.** No new dialog, retry button, toast, or visual change; the existing
  dialog saved message and the existing composer catalog-error diagnostic are reused.
- **Auto-substituting an unavailable model.** A removed model remains visibly selected
  until the user repairs it; the fix only makes that evaluation current.

## Confirmed product decisions

| Concern | Decision |
| --- | --- |
| Trigger scope | In-app Models-dialog saves only (no external-edit freshness, no auth trigger) |
| Refresh depth | Full revalidation: publish fresh catalog **and** re-read the active session policy when a policy composer is shown, mirroring a tier-ladder save |
| Auth (login/logout) trigger | Out of scope; explicit follow-up candidate |

## Design

### Components and seams (approach 1: wire the existing callback)

No new components. All work is in `src/client/src/components/PiWebUiApp.ts`:

1. **Bind the existing contract.** Render the dialog with
   `.onSaved=${() => { this.handleModelsConfigSaved(); }}` at `PiWebUiApp.ts:4863`.
   `ModelsConfigDialog` is unchanged; its `onSaved` is invoked only after a successful
   save and only while the saved machine is still the dialog's machine
   (`ModelsConfigDialog.ts:553-565`).

2. **Extract the shared publish tail.** Move the catalog-publish body of
   `handleModelTiersSaved` into
   `private publishMachineModelTierCatalog(machineId: string, catalog: ModelTierSettingsResponse): void`:
   selected-machine guard, set `modelTierCatalogMachineId`/`modelTierCatalog`, clear
   `modelTierCatalogError`, bump `modelTierCatalogSeq`, drop `modelTierCatalogLoad`, clear
   `modelTierCatalogLoading`, then `completeStarterModelPolicyFromActiveTier()`.
   Both `handleModelTiersSaved` and the success branch of `performModelTierCatalogLoad`
   (which publishes inline today, `PiWebUiApp.ts:2077-2081`) call it, so the publish logic
   exists once and both save paths reach the same end state. `handleModelTiersSaved` keeps
   its trailing policy re-read. The publish's `modelTierCatalogSeq` bump makes the load's
   own `finally` loading-flag check (`PiWebUiApp.ts:2086`) a no-op, which is equivalent to
   today's inline publish because the publish already cleared the flag.

3. **Extract the shared policy revalidation.** Move the trailing
   `if (activePolicyComposerScope(this.state) !== undefined) void this.sessions.loadModelPolicy();`
   into `private revalidateActiveModelPolicyAfterTierCatalogChange(): void` and call it
   from both `handleModelTiersSaved` and the new handler, in the latter only after a
   successful publish. This preserves today's behavior for ladder saves (including the
   comment explaining that server-computed `ladderValid` and `blockedReason` are stale
   after a tier-catalog change).

4. **New save handler.** `private handleModelsConfigSaved(): void` starts
   `private async refreshModelTierCatalogAfterModelsSave(): Promise<void>`, which:
   - reads `selectedMachineId(this.state)` (the dialog only calls `onSaved` for the
     still-selected machine), then
   - `const published = await this.loadModelTierCatalog(machineId, "machine")`, and then
   - `if (published) this.revalidateActiveModelPolicyAfterTierCatalogChange()`.

   The reload is unconditional (`loadModelTierCatalog`, not `ensureModelTierCatalog`)
   because refreshing an existing cache is the point of the change. The load path
   publishes through the same `publishMachineModelTierCatalog` used by ladder saves, so no
   publish logic is duplicated and the starter draft completion runs exactly once.

   **Guard seam.** `loadModelTierCatalog(machineId, guard: "machine" | "machine-workspace" = "machine-workspace")`
   passes the scope into `performModelTierCatalogLoad`, whose `isCurrent` predicate checks
   the workspace only for `"machine-workspace"`. Every existing caller keeps the default
   machine+workspace guard, and the scope is an explicit enum rather than
   `workspaceId === undefined` (an undefined selected workspace is legitimate), so the
   save variant cannot silently drop the workspace check from other paths. Both
   `loadModelTierCatalog` and the in-flight handle (`modelTierCatalogLoad`) carry a
   `Promise<boolean>`: `true` only when that request actually published, `false` on
   failure or when a newer request superseded it. The existing clear-on-settle logic still
   removes the handle, so a later `ensureModelTierCatalog` retries after a failure.

**Workspace-scope decision.** The tier catalog is machine-global: its model list, rows,
and ladder come from the machine's config and runtime and do not vary by workspace. The
save-triggered refresh is therefore guarded by machine and request sequence only. A
workspace switch that races the save must not discard the refresh the save requested: a
workspace switch does not clear the published catalog (`resetStarterModelPolicyForScopeChange`,
`PiWebUiApp.ts:2107-2114`), and `ensureModelTierCatalog` no-ops on a still-published
catalog (`PiWebUiApp.ts:2090-2097`), so no later request is guaranteed to fill the gap.
Publishing across a workspace switch is safe: after a switch the starter defaults are
reset, so `completeStarterModelPolicyFromActiveTier()` no-ops and the new workspace's
defaults load completes its own draft later. Existing load paths (starter defaults,
policy preload) keep their machine+workspace guard unchanged; only the save-triggered
variant is machine-scoped.

### Data flow

1. User saves in the Models dialog → server persists `models.json`, refreshes the shared
   runtime, returns success (unchanged) → dialog invokes `onSaved()`.
2. App handler fetches the selected machine's catalog through the existing
   `modelTiersApi.settings(machineId)` request.
3. On success the fresh catalog is published: model options, tier rows, ladder
   resolutions, and `modelTierCatalogError` are updated; the starter draft is completed
   from the active tier as today.
4. When a policy composer is showing, the app re-reads the session policy so the
   server-computed `ladderValid`/`blockedReason` and the composer's resolution reflect the
   new catalog.
5. `pickModel`/`pickStarterModel`, `session-tier-menu`, and `isDraftReadyToApply` now
   evaluate against the fresh list; the newly added model can be selected and applied
   immediately.

### Error handling

| Situation | Behavior |
| --- | --- |
| Models save fails | `onSaved` is not called; the dialog's existing failure handling is unchanged |
| Catalog GET fails after a successful save | Save remains successful and reported; previous catalog remains published; `modelTierCatalogError` carries the existing diagnostic; no partial publish; policy revalidation is skipped so the catalog diagnostic cannot be masked; the handler never rejects into the dialog |
| Machine switches mid-flight | The machine/sequence guard drops the response; the switch's own reset and load win |
| Workspace switches mid-flight | The save-triggered refresh is machine-scoped and still publishes; the workspace switch neither discards the refresh the save requested nor lets another machine's response publish |
| Overlapping catalog loads | `modelTierCatalogSeq` keeps the newest; a save-triggered load cannot republish after a newer load or a ladder save |
| Model removed by the save | Fresh catalog makes the draft fail `isDraftReadyToApply` and the picker refuse; no silent substitution, no automatic repair |

### Behavior contract

- A successful Models-dialog save is immediately reflected in the current session's model
  picker, tier rows, and draft validation, and in the policy-enabled starter composer,
  with no page refresh, session switch, or machine switch.
- Ladder-save behavior is unchanged; both save paths share one publish/revalidate pair.
- The save-triggered refresh survives a workspace switch; only a machine change or a
  newer load supersedes it.
- No tier-catalog change is published from a superseded or out-of-scope response.
- Tier-catalog refresh failure never changes the save's success report, never clears the
  previous catalog, and never triggers a policy re-read, and it releases the in-flight
  handle so a later `ensureModelTierCatalog` retries.
- Peers without the starter-selection capability keep today's legacy starter behavior:
  their default-model picker lists cached `starterSessionDefaults.models` and refreshes
  on the next start-screen entry or workspace/machine switch (follow-up candidate 3).

## Files affected

| File | Change |
| --- | --- |
| `src/client/src/components/PiWebUiApp.ts` | Bind `.onSaved`; extract `publishMachineModelTierCatalog` and `revalidateActiveModelPolicyAfterTierCatalogChange`; parameterize `loadModelTierCatalog`/`performModelTierCatalogLoad` with the guard scope and boolean result; add `handleModelsConfigSaved`/`refreshModelTierCatalogAfterModelsSave` |
| `src/client/src/components/PiWebUiApp.modelsConfig.test.ts` | Assert the dialog receives an `onSaved` callback (template wiring) |
| `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts` | Save-triggered refresh, revalidation gating, failure and retry, machine and workspace stale guards, starter path, interleaving, removal, and regression coverage |
| `docs/superpowers/specs/2026-09-26-model-catalog-refresh-after-save-design.md` | This document |

The implementation change (not this design document) adds one patch Changeset for
`@hyperdreamer/pi-webui` describing the user-visible fix, per
`.agents/skills/changeset-changelog/SKILL.md`. `CHANGELOG.md` is not edited directly.

## Testing strategy

App-boundary tests following the existing `PiWebUiApp.sessionModelPolicy.test.ts` harness
(Reflect-set state, spied `modelTiersApi.settings`, spied `SessionController` methods,
template-value inspection for the dialog binding):

1. **Wiring:** `PiWebUiApp.modelsConfig.test.ts` — the rendered dialog template carries an
   `onSaved` callback; invoking it starts a catalog fetch for the selected machine.
2. **Regression (reported bug):** with a cached catalog missing `gpt-new` and
   `modelTiersApi.settings` returning a catalog that includes it, invoking the dialog's
   save callback refreshes the catalog, and a subsequent `pickModel("openai/gpt-new")`
   applies it via `saveModelPolicy`.
3. **Revalidation:** after a successful save with a policy composer showing,
   `loadModelPolicy` is called once; with no active policy composer, it is not called;
   when the refresh fails or is superseded, it is not called (the catalog diagnostic must
   not be masked by `modelPolicyError`).
4. **Failure and retry:** a rejected `modelTiersApi.settings` leaves the previous catalog
   in place, sets `modelTierCatalogError`, does not reject the save handler, and releases
   the in-flight handle so a later `ensureModelTierCatalog` issues a fresh request.
5. **Machine-switch stale guard:** a save-triggered load resolving after a machine switch
   does not publish; the new machine's own load wins.
6. **Workspace-switch guard:** a save-triggered load issued in workspace A and resolving
   after a switch to workspace B still publishes the machine-global tier catalog; the
   refreshed model is selectable in B's session, and once B's starter defaults load, B's
   starter draft completes from the refreshed catalog (publish-time completion no-ops
   because `starterSessionDefaults` is reset).
7. **Starter path:** after a save, a model present only in the fresh catalog can be picked
   through `pickStarterModel` on a policy-enabled peer (the fixture must include the
   draft's thinking level, because `updateDraftExactModel` blanks an unsupported level).
8. **Interleaving:** a ladder save that publishes mid-flight wins over an older
   save-triggered load; the older response does not republish (`modelTierCatalogSeq`).
9. **Removal:** a save whose catalog no longer contains the draft's model makes
   `pickModel` refuse and leaves `isDraftReadyToApply` false — no silent substitution.
10. **Shared path:** a ladder save still publishes and revalidates exactly as before
    (existing tests must stay green).

Narrow checks first (`npm test -- --run <files>`, `npm run typecheck`), then
`npm run verify:fast` per the testing guide.

## Operational notes

- Client-only change: served by the autoreloading `pi-webui-ui-dev.service`; no sessiond
  restart, protocol change, or migration.
- The stale cache existed for the tier-catalog path only. Legacy peers without the
  `sessions.modelPolicy` capability keep live `listModels()` + `setModel()` for the active
  session, but their legacy starter default-model picker (`starterSessionDefaults.models`)
  is outside this fix and refreshes on the next start-screen entry or machine/workspace
  switch (follow-up candidate 3).

## Follow-up candidates (explicitly out of scope)

1. **Auth login/logout trigger:** call the same publish/revalidate pair when an auth flow
   completes a credential mutation, which requires a dedicated successful-completion
   callback in `AuthController` (its three success paths currently share only
   `closeDialog() + refreshStatus()`, and `closeDialog()` also runs on cancel).
2. **External `models.json` freshness:** revalidate on picker open or when an apply is
   attempted, if external edits become a supported workflow.
3. **Legacy starter defaults:** reload `starterSessionDefaults` after a Models save while
   the start screen is showing, so peers without the starter-selection capability also see
   the new model in their default-model picker without a machine/workspace switch. Needs
   its own handling for unowned starter exact-branch relinking.
