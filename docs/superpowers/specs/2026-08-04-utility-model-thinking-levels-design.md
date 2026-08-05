# Utility Model Thinking Levels Design

**Date:** 2026-08-04

## Goal

Allow each configured utility model to use a user-selected thinking level without changing the active session model, the session thinking level, or Pi's remembered defaults.

This design extends `2026-08-04-utility-model-settings-design.md`. Its lightweight/context task split and fallback chains remain authoritative except where this document adds thinking-level behavior.

## Approved behavior

Each Utility models row has one model selector and one thinking-level selector:

- **Lightweight** controls automatic titles and branch summaries.
- **Context** controls compaction and context-summary work.

The thinking selector offers lowercase `auto` plus every level Pi reports as supported by the selected model. This includes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` when the model supports them. Options come from Pi's live model metadata rather than a hardcoded per-provider table.

Selecting a different model resets that row's thinking level to `auto`. A saved explicit level that later becomes unsupported remains visible as unavailable and blocks saving until the user chooses `auto` or a currently supported level.

## Configuration model

Replace the exact-reference value in each optional utility slot with a backward-compatible binding:

```ts
interface UtilityModelBinding {
  provider: string;
  id: string;
  thinkingLevel?: ThinkingLevel;
}

interface UtilityModelSettings {
  lightweight?: UtilityModelBinding;
  context?: UtilityModelBinding;
}
```

The persisted form is:

```json
{
  "utilityModels": {
    "lightweight": {
      "provider": "anthropic",
      "id": "claude-haiku",
      "thinkingLevel": "low"
    },
    "context": {
      "provider": "anthropic",
      "id": "claude-sonnet"
    }
  }
}
```

`thinkingLevel` is optional. Omission means `auto`; no literal `"auto"` value is stored. Existing `{ "provider": "...", "id": "..." }` values therefore remain valid without migration and preserve the current automatic behavior.

The configuration parser accepts only Pi's known `ThinkingLevel` values. An unknown or malformed value is a non-blocking utility configuration error: ordinary sessions continue, and utility work follows its existing active-session fallback.

Full replacement and partial slot updates remain atomic and serialized. A model and its thinking level are one binding, so persistence cannot combine a new model with stale thinking intent.

## Settings API contract

The utility-model settings response advances to contract version 2. Each available model option includes the thinking levels currently reported by Pi for that exact model:

```ts
interface UtilityModelOption {
  model: TierModelRef;
  name?: string;
  thinkingLevels: ThinkingLevel[];
}
```

Version 2 settings use `UtilityModelBinding` values. Per-slot validation checks:

1. the configured provider/model is currently available and authenticated;
2. an explicit `thinkingLevel`, when present, is known; and
3. the exact model currently reports that level as supported.

The new browser parser remains strict for each known contract version and accepts both versions:

- Version 2 exposes dynamic explicit-level selection.
- Version 1 is normalized as model-only settings with no reported thinking levels. The panel remains usable for model selection, exposes only `auto`, and explains that the remote runtime must be upgraded before explicit thinking can be configured.

The existing machine capability remains `settings.utilityModels`; contract version determines whether explicit thinking is available. A new client sends the legacy model-only update shape to a version 1 remote. Version 2 updates may include optional `thinkingLevel`. An older client receiving a version 2 response fails visibly at its strict parser rather than misinterpreting the new contract.

The settings service derives `thinkingLevels` through an injected Pi-backed lookup, following the existing model-tier service pattern. It refreshes the authenticated model catalog before inspection and before each serialized update validation.

## Runtime resolution

The utility resolver reads current configuration and the live authenticated catalog at the start of every operation. A configured candidate carries:

- the resolved runtime model;
- the slot that supplied it; and
- its effective per-request thinking level.

`auto` resolves to `minimal` when the exact model reports `minimal` support; otherwise it resolves to `off`. Explicit levels are used exactly and never substituted with a neighbouring level.

A known but currently unsupported explicit level invalidates only that slot. The resolver skips it and advances through the normal candidate chain. Unknown/malformed configuration remains a configuration-level failure and yields no configured utility candidates.

Candidate deduplication includes provider, model id, and effective thinking level. Consequently:

- The same model with the same effective level is called only once.
- The same model configured in Context and Lightweight with different effective levels remains two meaningful compaction attempts.
- An active title fallback using the same model is retained when its existing title policy differs from the configured utility attempt.

## Per-operation routing

### Titles

Titles try the Lightweight binding with its effective thinking level, then the active session model with the title generator's existing fallback behavior. The title generator accepts a per-call thinking level for utility attempts. `off` does not force a reasoning option; other explicit levels are passed only in the stream request.

### Branch summaries

Branch summaries try the Lightweight binding with its effective thinking level. If unavailable, invalid, unauthenticated, aborted, or unsuccessful, the extension leaves the hook unhandled and Pi runs the active-session fallback with its existing behavior.

### Compaction and context summaries

Compaction tries:

1. Context model with the Context row's effective level;
2. Lightweight model with the Lightweight row's effective level; and
3. Pi's active-session fallback with its existing behavior.

If Context and Lightweight name the same model but use different effective levels, both configured attempts remain in this order.

### Isolation invariant

Thinking is request-local. Utility routing never calls `setModel`, `setThinkingLevel`, `setDefaultModelAndProvider`, or any equivalent persistence API. It does not mutate `session.model`, `session.thinkingLevel`, model policy, or Pi's remembered defaults.

## Settings UI

Each unframed Utility models row contains a model select and a thinking select. On desktop, row identity and description lead fixed `Model` and `Thinking` columns for dense scanning. On narrow screens, each row stacks its copy, a full-width labelled model select, and a full-width labelled thinking select; Save becomes full width.

- Without a selected model, the thinking select is disabled and displays `auto`.
- With a selected model, options are lowercase `auto` followed by that model's Pi-reported supported levels in canonical increasing order.
- Changing the model removes `thinkingLevel` from that draft binding.
- Selecting `auto` removes `thinkingLevel` from that binding.
- Selecting an explicit option stores it in the draft binding.
- A stale explicit level appears as `<level> (unavailable)` in a disabled selected option. The normal `auto` option stays enabled so the user can repair the row.
- Stale models, stale levels, loading, saving, and unsupported-machine states disable Save consistently.
- Saving emits complete decisions for both slots, with `null` for cleared slots and omission of `thinkingLevel` for `auto`.

Version 1 remotes retain model selection and clearing behavior. Their thinking controls remain `auto`-only, with a panel notice explaining the upgrade requirement for explicit levels.

## Error handling and fallback

- Malformed configuration never prevents session startup or ordinary prompts.
- A stale model or unsupported explicit level is reported per slot and blocks persisting an invalid UI draft.
- Runtime catalog drift skips only the affected configured slot and preserves the remaining fallback chain.
- Authentication lookup failure and utility-call failure advance to the next configured candidate or Pi's active-session behavior.
- Abort handling remains terminal for the utility hook and does not continue candidate iteration.
- Logs identify task, provider, model id, and effective thinking level without logging credentials.

## Documentation and release note

Update the canonical `docs/config.md` and `docs/config.html` examples and Utility models sections with the optional `thinkingLevel` field, `auto` omission semantics, dynamic supported-level behavior, and fallback isolation guarantees. Keep `README.md` and `CHANGELOG.md` unchanged.

Update the existing `.changeset/add-utility-model-settings.md` release fragment in place so the pending utility-model release note also covers per-model thinking levels. Do not create an overlapping feature fragment.

## Boundaries and non-goals

- Do not add per-operation thinking controls for title, branch summary, or compaction separately.
- Do not add a shared global utility thinking setting.
- Do not apply utility thinking intent to the active-session fallback.
- Do not change Model tiers, session model policy, or general model-selection UI.
- Do not silently coerce an unsupported explicit level to `auto` or to a nearby level.
- Do not add runtime dependencies or require a project-local migration file.

## Verification strategy

Use test-first changes across the existing boundaries:

- Config tests for legacy bindings, explicit levels, malformed values, persistence, and replacement.
- Service and route tests for dynamic levels, strict version 2 responses, version 1 compatibility, unsupported-level validation, and serialized updates.
- Browser parser/client tests for strict version 1/version 2 handling and machine-targeted saves.
- Resolver tests for `auto` resolution, explicit levels, per-slot invalidation, and model-plus-level deduplication.
- Title and extension tests proving every effective level is request-local, Context-to-Lightweight fallback keeps each row's level, and active-session fallbacks preserve existing behavior.
- Mounted Settings tests for dynamic options, model-change reset, omission-based `auto`, stale-level repair, disabled states, complete save payloads, and version 1 remote notices.
- Regression assertions that session model, session thinking level, model policy, and remembered defaults do not change.
- Synchronized documentation checks, exact single-Changeset checks, `git diff --check`, focused tests, typecheck, lint, Knip, and full `npm run verify`.
