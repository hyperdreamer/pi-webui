# Utility Model Settings Design

**Date:** 2026-08-04

## Goal

Allow PI WEBUI to use explicitly configured models for internal utility work without changing the model selected for the user session or Pi's remembered default model.

## Approved behavior

Utility model selection is split into two independent task classes:

- Title and branch-summary work uses the configured lightweight utility model, then the active session model as fallback.
- Compaction and other context-summary work uses the configured context utility model, then the lightweight utility model, then the active session model as fallback.

When a utility model is unset or unavailable, the next fallback is used. Existing behavior is preserved when both settings are unset.

## Settings placement

Add a separate selected-machine Settings category named **Utility models**. It is intentionally separate from **Model tiers**: model tiers describe user-session capability, while utility models describe internal summarization work.

The panel contains two independent model selectors:

- **Lightweight utility model**: automatic session titles and branch summaries.
- **Context utility model**: compaction and context-rewriting summaries.

An empty selector means that task class is not configured and should use its fallback chain. The panel uses the selected machine's existing model catalog and settings capability boundary.

## Configuration and API

Persist the settings in the machine's existing PI WEBUI core configuration as an optional `utilityModels` object:

```json
{
  "utilityModels": {
    "lightweight": { "provider": "...", "id": "..." },
    "context": { "provider": "...", "id": "..." }
  }
}
```

Each field is optional. Values are exact provider/model references, matching the existing model-tier reference format. The configuration parser rejects malformed non-object values and malformed model references as a configuration error, while a valid but currently unavailable model remains visible as stale configuration and is handled by runtime fallback.

Add a machine-targeted `GET`/`PUT` utility-model settings contract. The response includes:

- the current optional settings,
- the current available model options,
- per-slot validation information for configured references, and
- any configuration-load error.

`PUT` accepts only optional exact model references or explicit `null`/empty values and rejects references that are not in the selected machine's available catalog. Clearing a slot removes it from the persisted object. Saving one slot preserves the other slot.

## Runtime routing

Create a small utility-model resolver owned by the session runtime boundary. It reads the current configuration and model snapshot when a utility operation begins, so settings changes do not require replacing existing sessions. It resolves only models that are currently available and authenticated; an unavailable or unusable configured model is skipped.

### Titles

Update automatic title generation to resolve the lightweight slot before calling the existing short-name generator. The generator receives the resolved model and the active session stream function. With no usable lightweight model, it receives the active session model exactly as it does today.

### Branch summaries and compaction

Install a hidden inline Pi extension for each session through `resourceLoaderOptions.extensionFactories`:

- `session_before_tree` handles requested branch summaries with Pi's exported `generateBranchSummary` helper.
- `session_before_compact` handles compaction with Pi's exported `compact` helper.

The extension uses the utility resolver and the current session's stream function, together with the daemon model runtime's authentication lookup. It returns the helper result to Pi and never calls `setModel`, changes the session model, or writes a new default model. The stream-function reference is assigned after session creation so provider request behavior remains the same as normal session calls.

Branch summaries use the lightweight slot, then leave the event unhandled so Pi performs the normal active-session-model operation. Compaction tries context, then lightweight; when neither is usable, it leaves the event unhandled so Pi performs normal compaction with the active session model. If a configured utility request fails, the handler retries the next configured candidate before falling back to Pi's normal operation.

Utility summarization uses a minimal supported thinking level when the selected model supports reasoning; title generation keeps its existing minimal request settings. Existing Pi retry settings and abort signals are passed through.

## Boundaries and non-goals

- Do not change Pi's remembered default model or the session's selected model.
- Do not fold utility controls into Model Tiers.
- Do not add a third all-purpose utility-model setting that prevents independent lightweight/context choices.
- Do not make utility settings project-local in this change; they follow the existing selected-machine model settings scope.
- Do not change Pi's general model-selection UI or model catalog behavior.

## Verification strategy

Add tests first for configuration parsing and persistence, API validation and slot-preserving updates, settings routing and panel behavior, title fallback, and extension-based branch/compaction fallback. Verify that successful utility calls leave the active session model and default-model persistence unchanged. Run focused tests, typecheck, lint, and the relevant broader test suites before completion.
