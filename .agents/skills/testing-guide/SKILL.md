---
name: testing-guide
description: "Repository-specific testing guide. Use for any test work: planning coverage, writing/fixing/reviewing Vitest tests, test helpers/fakes, failure triage, choosing test layers, and Lit UI tests, including TemplateResult handler extraction rules."
---

# Testing guide

Use this skill for test-specific decisions in this repository. The goal is useful regression coverage without letting test helpers, mocks, or component harnesses become a second application that is harder to maintain than the code under test.

For production-code design and testability seams, also use the `code-quality-architecture` skill. This guide owns test strategy, test helper conventions, and UI test escape hatches.

## Core principles

- Test behavior and contracts that matter, not branches for their own sake.
- Prefer the smallest layer that proves the behavior: pure helper, service, controller, route/API contract, component boundary, then broader integration.
- Keep tests deterministic. Fake clocks, browser globals, filesystem/process/network boundaries, and hard-to-trigger errors when needed.
- Assert observable outcomes: return values, state transitions, emitted calls/events, HTTP responses, rendered user-facing state, or durable side effects.
- Avoid asserting incidental implementation details unless the selected gap is specifically about that implementation contract.
- Keep setup readable. A small explicit fixture is better than a magical factory that hides the scenario.
- Clean up global stubs, fake timers, DOM state, and pending promises so tests do not leak into one another.

## Choosing the test layer

Prefer this order unless the behavior requires a higher layer:

1. **Pure helper/service tests** for data shaping, validation, cache decisions, command construction, and conversion logic.
2. **Controller/runtime adapter tests** for state orchestration, endpoint selection, cancellation, timers, and injected collaborators.
3. **Route/API contract tests** for HTTP status mapping, path/query/body parsing, proxy allowlists, and compatibility contracts.
4. **Component-boundary tests** for UI event wiring and rendered state. Prefer real DOM/custom-element interaction when practical.
5. **Broad verification** (`npm run verify`) when a change is cross-cutting, changes shared helpers/types, or before final merge review.

Do not jump to a broad UI or integration test just because it feels more realistic if a lower layer proves the same behavior with less noise and less flake risk.

## Test helpers and fakes

- Keep helpers local until reuse is clear. If a pattern appears in multiple files, consolidate deliberately rather than copy-pasting variants.
- Type helpers and fakes strictly; avoid `any` unless the test is intentionally modeling an untyped external boundary.
- Fake only the boundary needed for the scenario. Do not mock the unit under test or so many collaborators that the assertion stops proving real behavior.
- Prefer controllable promises, fake timers, and explicit injected dependencies over sleeps or timing guesses.
- Name helpers after the domain behavior they support, not the mechanics of the fake.

## Lit component tests

Prefer testing Lit components through public/component boundaries:

- instantiate the component and set properties when that is the component contract;
- dispatch events against rendered DOM when a lightweight DOM harness is practical;
- assert user-visible rendered state or controller calls caused by user-like interactions.

### TemplateResult event-handler extraction rule

Lit `TemplateResult` event-handler extraction means calling `render()`, inspecting the returned template's `strings`/`values`, finding an event handler near a marker, and invoking that handler directly. It is an escape hatch, not the default.

Use TemplateResult handler extraction only when all of these are true:

1. The test is specifically verifying Lit template event wiring.
2. A DOM/custom-element render harness would add disproportionate setup, flakiness, or noise for the behavior being checked.
3. The assertion checks observable component/controller effects, not Lit internals.
4. The lookup is anchored to stable semantic markup, labels, or user-facing text rather than incidental handler order.
5. The test stays narrow; it is not trying to cover a full user flow, accessibility behavior, or visual/layout behavior.

Do not use TemplateResult handler extraction for:

- general content assertions;
- styling, layout, focus, keyboard navigation, or accessibility behavior;
- broad user flows where real DOM events are the point;
- scenarios with an existing public controller/service/helper seam;
- copying a new ad hoc helper variant into another file without reviewing whether a shared helper or DOM harness is now warranted.

When using this escape hatch:

- Add a short comment above the helper or test explaining why direct handler extraction is proportionate.
- Keep the helper small, type-guarded, and file-local unless reuse is already justified.
- Anchor searches to stable semantic markers such as accessible labels, button text, ids intentionally used by the component, or nearby form markup.
- Assert the behavior caused by the handler, such as state changes or calls to injected callbacks/controllers.
- Avoid assertions about the exact shape of Lit's private data beyond the minimum needed to find the handler; fail with clear errors if the template cannot be inspected.

## Checks to run

Run the narrowest meaningful check first:

- Changed test file: `npm test -- --run <test-file>`.
- Source or exported type changes: also run `npm run typecheck`.
- Non-trivial test helper, component, or lint-sensitive changes: run `npx eslint <changed-file>` or `npm run lint` when broader lint coverage is needed.
- Cross-cutting changes or final merge review: prefer `npm run verify`.

Record exact commands and results when working under relay/audit workflows or when handing work to another agent.

### Resource contention during local full-suite runs

The full suite is timing-sensitive. `vitest.config.ts` sets `maxWorkers: 1` to keep test files serial, but that only controls contention *inside* the Vitest process. Heavy work running alongside it on the same machine can still starve tests that wait on real subprocesses, ptys, or rendered DOM, and they fail with `Test timed out in 5000ms` even though nothing is wrong with the code.

So when triaging a timeout:

- Re-run the failing file alone on an otherwise idle machine before concluding anything. A test that passes alone and fails in a loaded full-suite run is evidence about the machine, not the test.
- Check whether the same test fails in CI. CI runs `npm run verify` on `ubuntu-latest` with the suite to itself, so a green CI history means the local failure is environmental.
- Do not run the full suite concurrently with other heavy jobs, including parallel agents or subsessions. Each run generates the contention that makes the others fail, so the results describe the load, not the code.

Raising a timeout is the wrong first response to this failure mode. Confirm the deadline is genuinely too tight for the work being awaited, rather than too tight for a starved CPU; otherwise the change only makes a real future hang slower to detect. Tests that already wait on events rather than sleeping have no faster path available when the event has genuinely not happened yet.
