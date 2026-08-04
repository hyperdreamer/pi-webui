# Checked Pi model-default persistence

**Date:** 2026-08-05
**Status:** Approved design

## Summary

Complete model-policy initialization for a SESSIONS `+` root changes Pi's global
model, provider, and thinking defaults before the root becomes visible. If a
later policy, provenance, or transcript commit step fails, PI WEBUI must restore
the prior runtime tuple and the prior durable Pi defaults while discarding the
unpublished root.

Pi 0.83 does not reject `SettingsManager.flush()` when a queued settings write
fails. It catches the storage failure, resolves the write queue, and exposes the
failure only through `SettingsManager.drainErrors()`. A rollback that awaits only
`flush()` can therefore appear successful in memory while durable settings still
contain the rejected initializer's target tuple.

PI WEBUI will isolate this dependency behavior behind a checked persistence
boundary. It will settle and inspect prior writes before initialization, inspect
target writes before committing transcript records, and retry complete settings
restoration up to three times before reporting an explicit incomplete rollback.

This design continues and narrows the approved behavior in
`2026-08-03-plus-session-model-policy-preference-design.md`. That document is the
controlling feature design. The earlier
`2026-08-03-persisted-starter-model-policy-preference-design.md` remains
applicable only where the controlling design explicitly retains its storage,
scope, capability, and diagnostics boundaries.

## Problem

Final re-review of the complete plus-session model-policy feature found one
load-bearing residual. The current rollback does this:

1. Apply the requested runtime model and thinking level.
2. Let Pi enqueue new global-default writes as part of those setters.
3. If a later initialization stage fails, restore the old runtime tuple.
4. Call the three old-value settings setters.
5. Await `SettingsManager.flush()` and treat resolution as durable success.

In Pi 0.83, each setter snapshots the in-memory settings and queues a storage
operation. `enqueueWrite()` catches storage exceptions and records them in an
internal error list. `flush()` waits for that caught queue and resolves.
`drainErrors()` is the only public persistence-error channel.

A real `SettingsManager.fromStorage()` probe reproduced the failure:

- target writes persisted `new-provider`, `new-model`, and `high`;
- a later initialization stage failed;
- every restoration storage write failed;
- `flush()` resolved;
- `getGlobalSettings()` showed the restored old tuple;
- durable storage still held the rejected new tuple;
- `drainErrors()` returned the restoration failures.

The session was correctly rejected and its transcript removed, but the rejected
root still changed future Pi defaults. This violates atomic unseen-root cleanup.

## Goals

- Never treat `SettingsManager.flush()` resolution alone as durable success.
- Reject complete initialization before applying a target when earlier settings
  writes have not settled successfully.
- Detect target default-write failures before policy, provenance, or transcript
  records are committed.
- Restore the prior runtime tuple and durable Pi defaults after every post-apply
  initialization failure.
- Recover automatically when restoration storage failure is transient.
- Report every persistent restoration failure as an explicit incomplete
  rollback rather than claiming cleanup succeeded.
- Preserve unpublished transcript cleanup and pre-publication event isolation.
- Exercise the installed Pi `SettingsManager` error semantics in regression
  tests, including durable storage state.

## Non-goals

- Replacing Pi's settings file format, locking, migration, or storage ownership.
- Writing Pi settings files directly from PI WEBUI.
- Adding a second settings or preference store.
- Making persistent filesystem failure disappear or claiming durable restoration
  when all bounded attempts fail.
- Changing ordinary active-session model-policy mutation behavior.
- Changing preference writeback behavior, client contracts, capabilities, UI,
  configuration documentation, or release copy.
- Retrying provider or model-runtime operations.
- Adding a dependency or changing the pinned Pi version.

## Dependency contract

The checked boundary uses the narrow public behavior PI WEBUI needs:

```ts
export interface ModelPolicySettingsPersistence {
  getGlobalSettings(): {
    defaultProvider?: unknown;
    defaultModel?: unknown;
    defaultThinkingLevel?: unknown;
  };
  setDefaultProvider(provider: string | undefined): void;
  setDefaultModel(modelId: string | undefined): void;
  setDefaultThinkingLevel(level: ClientThinkingLevel | undefined): void;
  flush(): Promise<void>;
  drainErrors(): readonly {
    scope: string;
    error: Error;
  }[];
}
```

The interface remains structural so the installed Pi `SettingsManager` is the
production implementation and tests can use `SettingsManager.fromStorage()`.
Complete-policy initialization fails closed if the runtime's settings manager
does not expose this complete contract.

A focused `modelPolicySettingsPersistence.ts` module owns Pi-specific queue and
error-channel semantics. `PiSessionService` owns lifecycle ordering and cleanup,
but it does not interpret `drainErrors()` records itself.

## Checked operations

### Prepare

Before applying a complete initial policy:

1. Await `flush()` to settle all earlier writes on that settings manager.
2. Drain the error channel.
3. If any earlier error exists, reject the unseen root before changing its
   runtime tuple.
4. Capture the prior global provider, model, and thinking defaults.

Preparation does not discard earlier errors silently. Its thrown aggregate names
the operation phase, settings scope, and original error message.

### Commit target defaults

Applying the active Exact or resolved Tiered target changes the runtime and lets
Pi enqueue its normal default writes. Immediately after the runtime tuple is
verified:

1. Await `flush()`.
2. Drain the error channel.
3. Reject initialization if any target write failed.
4. Only after that check, append and verify the complete policy and source, then
   durably commit and reopen the initial JSONL.

This ordering leaves the existing browser-visible atomicity intact. The root is
still unpublished, and any failure enters the same rollback and transcript
cleanup scope. It also ensures rollback starts with no unclassified target-write
errors in the settings channel.

### Restore prior defaults

Rollback continues to restore the runtime tuple first. Runtime setters may queue
settings writes, so each durable restoration attempt then reapplies all three
captured default fields before checking persistence.

Each attempt:

1. Set captured provider, model, and thinking defaults, including restoring an
   absent field as `undefined`.
2. Await `flush()`.
3. Drain the error channel.
4. Succeed only when `flush()` resolves and the drained error list is empty.

Restoration makes at most three complete attempts with no delay. Pi's file
storage already owns lock retry timing; this bound is for transient queued write
failures, not a competing lock algorithm. Every retry reapplies all fields so a
partially durable prior attempt converges to one complete snapshot.

If a later attempt succeeds, rollback is complete and earlier transient errors
have been handled by the retry. If all attempts fail, the helper throws one
`AggregateError` containing the flush rejection, drained Pi errors, or both from
every attempt. The outer initialization failure remains primary and includes the
restoration aggregate as an incomplete-rollback cause.

## Lifecycle and cleanup

The complete initialization scope becomes:

1. Settle prior settings writes and capture the prior defaults.
2. Resolve and apply the active runtime target.
3. Check target settings persistence.
4. Append and verify complete session policy.
5. Append and verify bound plus provenance.
6. Materialize and independently reopen the initial transcript.
7. Bind runtime events and publish the initialized root.

Any failure after target application performs all cleanup steps even if one
fails:

- restore and verify the prior runtime tuple;
- restore durable settings through the bounded checked helper;
- discard any transcript file owned by initial-entry commit;
- abort and dispose the unpublished runtime;
- return the original initialization error, aggregating cleanup failures.

Runtime event subscription remains detached until successful completion. No
failed-root model, thinking, status, or creation event becomes visible.

## Error behavior

A prior or target settings write failure rejects root creation with a phase-
specific settings-persistence error. The unseen root is not published or
remembered.

A transient restoration failure is handled by bounded retry. The user receives
the original creation failure after durable defaults return to the prior
snapshot.

A persistent restoration failure rejects root creation with an aggregate stating
that complete session initialization failed and rollback was incomplete. The
aggregate retains each settings scope and original error message. PI WEBUI still
removes the unpublished transcript and disposes the runtime; it does not claim
that durable defaults were restored.

Preference-write failures remain separate and non-blocking because they occur
after a root or mutation is already confirmed. This design does not route them
through settings rollback.

## Testing strategy

### Checked persistence module

Use the installed `SettingsManager.fromStorage()` with a custom in-memory storage
implementation that records the serialized durable global settings and can fail
specific writes.

Cover:

- preparation waits for queued writes and rejects recorded prior errors;
- target checking rejects a write captured only by `drainErrors()`;
- successful restoration returns durable storage to the exact prior snapshot;
- one failed restoration attempt followed by success restores durable state;
- three failed attempts throw an aggregate containing every recorded storage
  error;
- absent provider, model, or thinking fields are restored as absent;
- removing the `drainErrors()` check makes the production-semantic regressions
  fail.

Assertions compare `getGlobalSettings()` and independently parsed durable JSON.
An in-memory assertion or a `flush()` call-count assertion alone is insufficient.

### Session lifecycle

Use the model-policy lifecycle harness with a real custom-storage
`SettingsManager`. Cover target persistence failure and a later source or durable
commit failure followed by both transient and persistent restoration failure.

Assert separately:

- start rejects with the expected primary and aggregate errors;
- successful retry restores runtime and durable settings;
- persistent failure is reported as incomplete rollback;
- the initial transcript is absent;
- the session is not active;
- no status or `session.created` event escaped;
- no preference writeback was attempted.

Run focused tests first, then typecheck, lint, Knip, and the complete repository
verification gate.

## Compatibility and release scope

This correction changes only session-daemon-loaded server behavior and tests. It
adds no shared, HTTP, federation, browser, or persisted-file contract. Older peers
remain gated by existing capabilities and are byte-compatible.

The existing patch Changeset for complete plus-session policy restoration already
describes the unreleased user-visible outcome. This correction makes that outcome
true and does not add a second Changeset. `README.md`, `CHANGELOG.md`, package
versions, lockfile versions, `docs/config.md`, and `docs/config.html` remain
unchanged.

The terminal v5 controller state and its artifacts remain immutable audit
evidence. A new continuation plan starts from credited clean commit
`701b637ec5d937dfe90a815124998fae10c48cec` and names this design plus the
controlling plus-session design. It does not edit or resume the terminal v5 run.

Because the corrected code is loaded by the session daemon, final handoff must
still require a manual restart of `pi-webui-sessiond.service` after all review
gates pass.

## Acceptance criteria

1. Complete initialization cannot begin while the settings manager has an
   unreported prior persistence error.
2. Target default persistence is checked through `drainErrors()` before policy,
   provenance, or transcript commit.
3. A failed post-apply initialization restores the prior runtime tuple.
4. A transient restoration storage failure is retried and durable settings
   return to the exact prior snapshot.
5. Persistent restoration failure is reported as an explicit aggregate
   incomplete rollback with every Pi settings error retained.
6. Failed creation leaves no transcript, active session, creation event, status
   event, or preference writeback.
7. Real `SettingsManager.fromStorage()` regressions prove durable behavior and
   fail if error-channel inspection or retry is removed.
8. All previously resolved final-review findings remain resolved.
9. Existing client, protocol, capability, preference, and documentation
   contracts remain unchanged.
10. Focused tests, typecheck, lint, Knip, and `npm run verify` pass.
11. The existing patch Changeset remains the only release note for the feature.
12. Final handoff calls out the required manual session-daemon restart.
