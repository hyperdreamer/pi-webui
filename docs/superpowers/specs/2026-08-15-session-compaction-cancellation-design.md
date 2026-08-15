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

Add required `abortCompaction(): void` to the local `PiAgentSession` interface. PI WEBUI supports `@earendil-works/pi-coding-agent >=0.84.0 <0.85`, and both 0.84.0 and 0.84.1 expose this SDK method. `CommandSession` in `SessionCommandService` does not need this addition - the call site is `PiSessionService`, which holds `PiAgentSession` directly. No Pi package source is modified.

### Command service

`SessionCommandService` owns the lifecycle of manual `/compact` invocations:

- register an operation token keyed by `sessionId` before calling `session.compact()`;
- expose a cancellation method `cancelManualCompaction(sessionId: string): void` used by `PiSessionService.abortSessionOperations()`;
- that method marks the token as cancelled only after `PiSessionService` has successfully called `session.abortCompaction()`; it does not call the SDK hook itself;
- on promise settlement, use the token cancellation flag to distinguish intentional cancellation from a genuine compaction failure;
- remove the token as part of terminal cleanup so a later compaction cannot consume stale cancellation state.

The first terminal state wins. A cancellation request that arrives after the operation has settled is a no-op. The command service continues to publish the existing success and failure messages for non-cancelled outcomes.

The command lifecycle result type expands from `success | error` to `success | error | cancelled`. The Pi session lifecycle maps `cancelled` to an idle activity and calls `endSessionEntryMutation` — matching the existing behavior for `success` and `error`.

### Pi session abort orchestration

`PiSessionService.abortSessionOperations()` remains the single orchestration point for stopping session work. Its order is:

1. call `session.abortCompaction()` directly - this covers both manual and auto-compaction with one call and does not require the command service to hold the session object;
2. after that call succeeds, call `commandService.cancelManualCompaction(session.sessionId)` to mark any in-flight manual invocation as cancelled;
3. invoke the existing optional branch-summary abort hook;
4. always attempt `session.abort()` for ordinary agent work;
5. preserve the existing error aggregation and propagation behavior when a synchronous abort hook or the normal abort operation fails.

All cancellation attempts are best effort with respect to one another: a failure in any hook must not prevent the remaining abort attempts.

## Data Flow

1. `PromptEditor` invokes its existing `onStop` callback.
2. `SessionController.stopActiveWork()` calls the existing `sessionsApi.abort()` method.
3. The existing route calls `PiSessionService.abort()`.
4. `PiSessionService` clears queued prompts and calls `abortSessionOperations()`.
5. `abortSessionOperations()` calls `session.abortCompaction()` directly, then marks any tracked manual compaction token as cancelled. This single SDK call covers both manual and auto-compaction.
6. `abortSessionOperations()` calls the branch-summary hook and awaits `session.abort()` as before.
7. `abort()` publishes "stopped / idle" activity and status while the compaction promise is still settling.
8. Asynchronously: Pi detects the aborted signal inside `compact()`, emits `compaction_end { aborted: true }`, and rejects the pending promise.
9. For **manual compaction**: `SessionCommandService`'s `.catch()` sees the cancelled token, publishes an informational `Compaction cancelled.` command output, and calls `onCompactionEnd(session, "cancelled")`. The lifecycle handler calls `endSessionEntryMutation`, publishes "compaction cancelled / idle" activity, and publishes status. This is the final observable state.
10. For **auto-compaction**: Pi emits `compaction_end { aborted: true }`. `PiSessionService`'s subscription handler forwards the event and publishes status. No command output or lifecycle callback is involved. No new HTTP response shape or browser parser is required.

The "stopped / idle" activity published in step 7 is superseded by the async lifecycle updates in steps 9–10. The intermediate state is visible to the client for one event cycle but resolves correctly.

## Error Handling

- A manual compaction rejection is treated as cancellation only when its session token was explicitly marked after `abortCompaction()` completed without throwing. Unrelated provider, auth, preparation, or persistence errors remain failures.
- Cancellation does not become a generic `session.error` event.
- A throwing `abortCompaction` hook is recorded; its manual token remains unmarked, and branch-summary and ordinary abort attempts still run. The stop request reports failure according to the existing `abort()` contract rather than silently swallowing it.
- A provider that ignores the abort signal remains a residual upstream/runtime risk; handling that case is explicitly outside this change.

## Testing

### `sessionCommandService.test.ts`

Add a deferred-compaction test that starts `/compact`, calls `cancelManualCompaction(sessionId)` to mark the token cancelled, then rejects the deferred `compact()` promise as Pi cancellation does, and verifies:

- an informational `Compaction cancelled.` output is published at `info` level;
- `onCompactionEnd` receives `cancelled`;
- no error command output or `session.error` event is published;
- the operation token is cleaned up.

Also cover a completion race: if `compact()` resolves before `cancelManualCompaction` is called, the success result is kept and no cancellation output is published.

### `piSessionService.promptQueue.test.ts` and `piSessionService.testSupport.ts`

Extend the fake session surface in `piSessionService.testSupport.ts` to record calls to `abortCompaction()`. Then add coverage in the prompt-queue (or a new lifecycle) test file that aborting while `isCompacting`:

- clears queued prompts;
- calls `abortCompaction()` before the existing abort path;
- still invokes ordinary `abort()`;
- publishes final idle status.

Add a second case for abort while auto-compaction is active (no command service token): verifies `abortCompaction()` is called and the session reaches idle without any cancellation command output.

Add a hook-failure case: a throwing `abortCompaction` hook must not prevent branch-summary or ordinary abort attempts.

No new route or client control test is required because the `/abort` contract and Stop-button wiring already exist and are unchanged.

## Scope And Non-Goals

In scope:

- `src/server/sessions/sessionCommandService.ts`;
- `src/server/sessions/sessionCommandService.test.ts`;
- `src/server/sessions/piSessionService.ts`;
- `src/server/sessions/piSessionService.testSupport.ts`;
- `src/server/sessions/piSessionService.promptQueue.test.ts` (or a new lifecycle test file).

Out of scope:

- new HTTP endpoints or response types;
- new UI controls or component-level control changes;
- killing or restarting the session daemon;
- changing Pi package code or provider timeout policy;
- unrelated queue, activity, or session-runtime refactors.

## Verification

Run the focused command-service and Pi session tests first, then typecheck and lint the changed files. Finish with `npm run verify:fast` and `git diff --check`. The final change should include a patch Changeset because this repairs user-visible session behavior.
