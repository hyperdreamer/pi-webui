# Anthropic model discovery endpoint — Approved Brainstorming Brief

**Status:** Approved by Product Owner on 2026-07-26 in this workflow conversation.

## Goal

Allow an `anthropic-messages` custom provider to use one root-style Base URL for both **Fetch models** and **Test connection**.

For either trailing-slash form:

```text
https://www.rightapi.ai/claude-aws
https://www.rightapi.ai/claude-aws/
```

model discovery must request:

```text
https://www.rightapi.ai/claude-aws/v1/models
```

while the existing Pi/Anthropic runtime continues to test and run models through:

```text
https://www.rightapi.ai/claude-aws/v1/messages
```

## Problem and product context

PI WEBUI currently derives every non-Google model-catalog endpoint by appending `models` to the configured provider Base URL. That convention is correct for providers whose Base URL includes their API version, including the existing OpenAI-compatible configuration path.

The Pi runtime's `anthropic-messages` implementation instead delegates requests to the Anthropic SDK, which appends `/v1/messages` itself. A root-style Base URL therefore makes connection testing correct, but current model discovery requests an incorrect unversioned `/models` path. Adding `/v1` to the configured URL reverses the failure: discovery works but the runtime requests `/v1/v1/messages`.

## Chosen approach

Add a contained, server-side API-format rule to model discovery:

```text
api === "anthropic-messages"  →  <root base URL>/v1/models
all other formats             →  retain their current discovery paths
```

The configured Base URL for `anthropic-messages` is defined as the API root and must not include `/v1`. Both root URL forms, with and without a trailing slash, are valid.

The change must preserve the existing Anthropic discovery authentication behavior:

- resolved credential in `x-api-key`;
- default `anthropic-version: 2023-06-01` header;
- user-configured header additions, overrides, and suppressions.

## Alternatives considered

1. **Recommended: format-specific `/v1/models` derivation.**
   Aligns discovery with the Anthropic SDK's existing root-URL convention, changes no persisted configuration, and preserves all other provider behavior.
2. **Add a user-configurable model-catalog path.**
   Could support unusual proxies, but adds UI, configuration, validation, and documentation complexity for one known protocol convention. It is out of scope.
3. **Retry or infer both `/models` and `/v1/models`.**
   Creates hidden network behavior and ambiguous failures, can mask provider configuration mistakes, and leaves the Base URL contract unclear. It is out of scope.

## Scope boundaries

Included:

- server-side discovery URL construction for `anthropic-messages`;
- focused service regression coverage for both trailing-slash forms;
- regression confirmation that OpenAI-compatible and Google discovery URLs do not change;
- a patch Changeset for the user-visible fix.

Excluded:

- changes to the Pi/Anthropic runtime, model connection-test behavior, API-key handling, or provider UI;
- fallback/retry discovery paths or automatic conversion of Base URLs ending in `/v1`;
- new provider configuration fields, migrations, dependencies, UI redesign, or unrelated model-protocol support;
- manual edits to `CHANGELOG.md`.

## Acceptance criteria

1. For `api: "anthropic-messages"`, both `https://host/prefix` and `https://host/prefix/` discover models from exactly `https://host/prefix/v1/models`.
2. The same root-style Base URL remains compatible with the existing connection-test/runtime request convention of `https://host/prefix/v1/messages`, without a duplicated `/v1`.
3. Anthropic discovery continues to send its expected default authentication/version headers and respects configured header overrides/suppressions.
4. OpenAI-compatible and Google discovery URL and credential behavior remain unchanged.
5. A focused behavior test demonstrates the pre-change failure (RED) before the production edit, then passes after the minimum implementation (GREEN), with relevant regression, typecheck, lint, and aggregate verification evidence.
6. The release includes a patch Changeset with user-facing wording; `CHANGELOG.md` is generated only during release preparation.

## Constraints, dependencies, and operational considerations

- The implementation must remain a small, testable change in the server-side model-discovery boundary.
- No new dependencies, secrets, network access in tests, persistence changes, migration, or external API contract change is allowed.
- The HTTP/HTTPS validation and discovery timeout remain in force.
- The affected service is owned by the long-lived session daemon. After the change is integrated in a running local environment, `pi-webui-sessiond.service` requires a manual restart; UI/API autoreload alone is insufficient.
- Security impact is limited to a path derivation change on the already configured provider origin; authentication behavior must not broaden.

## Milestones and approval boundaries

1. **Completed:** PM discovery and design approval.
2. **Next:** Architect creates a review-ready implementation plan and obtains Team Leader feasibility approval.
3. **Then:** Team Leader coordinates isolated TDD implementation, independent review, integration, and candidate freeze.
4. **Then:** Security and QA independently validate the same frozen candidate SHA.
5. **Then:** PM product acceptance, documentation/release readiness, and any explicit release approval occur only if requested and all gates pass.

## Workflow record

- **Active phase:** Architecture and implementation planning
- **Active owner:** Architect / Staff Engineer
- **Next permitted action:** Create a review-ready implementation plan, then submit it to the Team Leader for feasibility review.
- **Failure routes:** technical or feasibility defect → Architect; product/acceptance defect → PM discovery; cross-cutting defect → Architect + PM.
