# Session Compaction Cancellation Design

**Date:** 2026-08-15

## Goal

Allow the existing Stop action to terminate an in-progress Pi compaction without killing or recreating the shared session runtime. A cancelled compaction must leave the session usable, clear queued prompts as Stop does today, and avoid presenting the intentional cancellation as a session error.

## Root Cause

The UI already enables Stop while `isCompacting` is true and sends the existing `/abort` request. `PiSessionService.abortSessionOperations()` currently calls Pi's `abort()` method, but Pi 0.84.1 owns compaction under a separate abort controller exposed as `abortCompaction()`.

Pi's `abort()` cancels an active agent run and waits for agent idle state. It does not signal the compaction controller. Consequently, Stop can return while `compact()` remains active, and the session can remain stuck in compaction.

## Accepted Behavior

- The existing Stop button and `/abort` endpoint remain the user-facing cancellation path.
- Stop clears server-side queued prompts, including prompts queued during compaction.
- Stop signals `abortCompaction()` before the existing branch-summary and agent abort operations.
- Manual compaction cancellation is a normal terminal outcome, not a failure.
- A cancelled manual compaction publishes an informational `Compaction cancelled.` command result and ends its lifecycle with a `cancelled` outcome.
- Cancellation does not publish `session.error` and does not leave the activity in an error phase.
- The final session status reports `isCompacting: false` and idle activity.
- Pi writes no compaction entry when cancellation occurs before the summary is committed; existing session history remains intact.
- If Stop arrives after compaction has already settled, the existing success or failure outcome remains authoritative.
- Auto-compaction receives the same dedicated abort signal but has no manual command result to publish. Its existing event and status paths settle the session normally.
- The session daemon is not killed, restarted, or replaced. Other sessions owned by the daemon remain unaffected.

## Architecture

### Session adapter boundary

Add optional `abortCompaction(): void` to the local `PiAgentSession` interface. The optional declaration preserves compatibility with older runtime objects while allowing current Pi 0.84.1 sessions to use the dedicated cancellation hook. No Pi package source is modified.

### Command service

`SessionCommandService` owns the lifecycle of manual `/compact` invocations:

- register an operation token before calling `session.compact()`;
- keep the token associated with the exact session and invocation;
- expose a small cancellation method used by `PiSessionService.abortSessionOperations()`;
- mark an active manual operation as cancelled only when the optional compaction abort hook is available, then invoke `session.abortCompaction?.()`;
- on promise settlement, use the operation token to distinguish intentional cancellation from a genuine compaction failure;
- remove the token as part of terminal cleanup so a later compaction cannot consume stale cancellation state.

The first terminal state wins. A cancellation request that arrives after the operation has settled is a no-op. The command service continues to publish the existing success and failure messages for non-cancelled outcomes.

The command lifecycle result type expands from `success | error` to `success | error | cancelled`. The Pi session lifecycle maps `cancelled` to an idle `compaction cancelled` activity.

### Pi session abort orchestration

`PiSessionService.abortSessionOperations()` remains the single orchestration point for stopping session work. Its order is:

1. ask `SessionCommandService` to cancel any tracked manual compaction and signal the session's optional compaction abort hook;
2. invoke the existing optional branch-summary abort hook;
3. always attempt `session.abort()` for ordinary agent work;
4. preserve the existing error aggregation and propagation behavior when a synchronous abort hook or the normal abort operation fails.

All cancellation attempts are best effort with respect to one another: a failure in one hook must not prevent the remaining abort attempts.

## Data Flow

1. `PromptEditor` invokes its existing `onStop` callback.
2. `SessionController.stopActiveWork()` calls the existing `sessionsApi.abort()` method.
3. The existing route calls `PiSessionService.abort()`.
4. `PiSessionService` clears queued prompts and delegates cancellation to `abortSessionOperations()`.
5. Pi receives `abortCompaction()`, emits its aborted compaction event, and rejects the pending `compact()` promise with its cancellation error.
6. `SessionCommandService` consumes the operation token, publishes the informational cancellation output, and invokes `onCompactionEnd(session, "cancelled")`.
7. `PiSessionService` publishes idle activity and status. No new HTTP response shape or browser parser is required.

## Error Handling

- A rejection is treated as cancellation only when its operation token was explicitly marked by the Stop path. Unrelated provider, auth, preparation, or persistence errors remain failures.
- Cancellation does not become a generic `session.error` event.
- A throwing optional cancellation hook is recorded while branch-summary and ordinary abort attempts continue. The stop request reports failure according to the existing `abort()` contract rather than silently swallowing it.
- If an older runtime does not expose `abortCompaction()`, the adapter falls back to its existing abort behavior. This change does not add a hard runtime restart fallback.
- A provider that ignores the abort signal remains a residual upstream/runtime risk; handling that case by restarting the shared daemon is explicitly outside this change.

## Testing

### `SessionCommandService`

Add a deferred-compaction test that starts `/compact`, requests cancellation through the service boundary, rejects the deferred operation as Pi cancellation does, and verifies:

- `abortCompaction()` is called;
- an informational cancellation result is published;
- `onCompactionEnd` receives `cancelled`;
- no error command output or `session.error` event is published;
- the operation token is cleaned up.

Also cover a completion race so a settled compaction keeps its original result.

### `PiSessionService`

Extend the fake session surface to record `abortCompaction()` and add coverage that aborting while `isCompacting`:

- clears queued prompts;
- invokes compaction cancellation before the existing abort path;
- still invokes ordinary abort;
- publishes final idle status.

Add a hook-failure case proving that a throwing compaction abort hook does not prevent branch-summary or ordinary abort attempts.

No new route or client control test is required because the `/abort` contract and Stop-button wiring already exist and are unchanged.

## Scope And Non-Goals

In scope:

- `src/server/sessions/sessionCommandService.ts`;
- `src/server/sessions/piSessionService.ts`;
- focused server tests and test fakes for those services.

Out of scope:

- new HTTP endpoints or response types;
- new UI controls or component-level control changes;
- killing or restarting the session daemon;
- changing Pi package code or provider timeout policy;
- unrelated queue, activity, or session-runtime refactors.

## Verification

Run the focused command-service and Pi session tests first, then typecheck and lint the changed files. Finish with `npm run verify:fast` and `git diff --check`. The final change should include a patch Changeset because this repairs user-visible session behavior.
