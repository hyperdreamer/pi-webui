# Fast local test profile

**Status:** approved design, pending implementation plan
**Date:** 2026-08-08

## Context

The repository-wide Vitest run contains 391 test files. On the current development
machine, the checked-in single-worker configuration completed in 260.70 seconds,
while the same suite completed in 81.04 seconds with four workers. Both runs passed
all 391 files.

The single-worker policy was introduced after resource-contention timeouts in tests
that exercise subprocesses, PTYs, WebSockets, and rendered DOM. The faster local path
must therefore be opt-in and must not weaken the canonical verification gate.

## Design

Add two intention-revealing package scripts:

- `test:fast` runs Vitest with `--maxWorkers=4` for normal local iteration.
- `test:serial` runs Vitest with `--maxWorkers=1` for deterministic validation.

Keep `npm test` and `vitest.config.ts` unchanged so existing commands, direct Vitest
invocations, and staged-validation behavior remain serial by default. Change
`npm run verify` to invoke `npm run test:serial` explicitly, making its reliability
policy visible at the call site rather than relying only on the shared config.

Document `npm run test:fast` briefly in the README's existing Development section.
Keep `npm run verify` as the required final validation command.

## Contract coverage

Extend `scripts/projectIdentity.test.mjs`, which already validates package metadata,
to assert the exact `test`, `test:fast`, `test:serial`, and `verify` script contract.
The test should fail before the package scripts are added and pass afterward.

## Alternatives considered

Changing `vitest.config.ts` to four workers globally was rejected because it would
also affect CI, pre-commit validation, and direct Vitest invocations, reintroducing
the concurrency risk the serial policy addresses.

Making `npm test` parallel while keeping only `verify` serial was rejected because
existing contributor commands and documentation use `npm test` as a conservative
default. A separately named fast profile makes the tradeoff explicit.

Leaving the repository unchanged and requiring contributors to remember a CLI
override was rejected because it is hard to discover and easy to mistype.

## Verification

1. Add the package-script assertion and confirm it fails for the missing profiles.
2. Add the scripts and confirm the focused package-identity test passes.
3. Run `npm run test:fast` and confirm the full suite passes with four workers.
4. Run `npm run verify` and confirm typecheck, lint, Knip, and the explicit serial
   test profile pass.
5. Run `git diff --check` and inspect the README Development section for concise,
   non-duplicated guidance.

## Release tracking

Do not add a Changeset. This is source-repository developer tooling and does not
change the installed PI WEBUI runtime or package-consumer behavior.
