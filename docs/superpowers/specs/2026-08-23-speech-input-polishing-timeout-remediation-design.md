# Speech Input Polishing Timeout Remediation Design

**Date:** 2026-08-23

## Context

The terminal `speech-input-polishing-review-recovery-5-20260822` run recorded final finding `F-001`: `SpeechInputPolishingService` forwards the caller abort signal but does not pass an explicit provider timeout below the polishing route's 30-second deadline. A provider SDK can therefore continue network work after the route has released its request slot. The recovery-5 plan cannot be reopened or widened; its final reviewer correctly blocked it because the service path was outside that plan's correction allowlist.

This successor remediation carries `F-001` forward without editing the historical run, its state, or its reports. The existing intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` remains untouched.

## Goal

Bound each lightweight model request used for speech polishing to a named provider timeout that is strictly shorter than the route deadline, and preserve that invariant with focused regression coverage.

## Scope

The product correction is limited to:

- a new shared speech-polishing timeout constants module;
- the existing speech-polishing service and its test;
- the existing speech-polishing route's import/re-export of its deadline constant and its test's shared-constant assertion; and
- one patch Changeset describing the bounded request-lifecycle fix.

No browser controller, Settings UI, daemon route registration, transport, dependency, credential, persistence, logging, or unrelated configuration behavior changes.

## Design

`src/shared/speechInputPolishing.ts` owns the two related budgets:

- `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS = 30_000`;
- `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000`.

The five-second margin is intentional: it leaves time for abort propagation, response mapping, cleanup, and response writing after the provider deadline. The model budget is a literal named constant rather than a runtime subtraction so the provider call remains independently bounded and the margin is visible in code review.

`src/server/speechInput/speechInputPolishingRoutes.ts` imports and re-exports the route budget, preserving existing test/import consumers while making the shared module authoritative. `SpeechInputPolishingService` passes the model budget as `timeoutMs` alongside its existing `signal`, `maxRetries: 0`, `cacheRetention: "none"`, and bounded `maxTokens` options. No caller-signal behavior changes.

## Alternatives Considered

1. Import the route constant directly into the service. Rejected because the route already imports service errors, creating an avoidable module cycle.
2. Add a standalone `25_000` literal only in the service. Rejected because the relationship to the route deadline would be implicit and future edits could silently erase the margin.
3. Define both budgets in a shared speech-polishing module. Chosen because it gives both layers one source of truth, keeps framework glue thin, and makes the invariant directly testable.

## Verification

The successor run will use a fresh deterministic SDD root and review the exact range from the current branch head through the correction. The implementer must first add a failing assertion for `options.timeoutMs`, then add the shared budgets and service/route wiring, run focused service/route tests, typecheck, scoped lint, `verify:staged`, Changeset status, packaging dry run, and diff checks. A fresh task reviewer and mandatory Frontier final reviewer must confirm that `F-001` is resolved and that the historical recovery roots and dirty plan amendment remain unchanged.

Because the correction affects code loaded by the long-lived session daemon, the final handoff must tell the operator to manually restart `pi-webui-sessiond.service`.
