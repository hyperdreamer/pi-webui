# Speech Input Transient Error Dismissal

- Date: 2026-08-17
- Status: Ready for user review

## Problem

A failed speech-input run, such as a browser `audio-capture` failure, is published as an idle state with an `error`. `PromptEditor` renders that error, but the current controller has no expiry or clear path after the run has settled. The warning therefore remains visible until the component or page is recreated.

The speech-input state also contains `unavailableReason`. That is a separate persistent capability or configuration condition, such as settings still loading, an insecure context, an unsupported browser API, an unusable recorder format, or unavailable cloud credentials. It must not be treated as a transient run error.

## Goals

- Automatically dismiss a transient speech-input run error after a fixed five-second delay.
- Keep persistent availability and configuration reasons visible and accurate.
- Keep timer ownership inside the speech-input lifecycle module.
- Make timer behavior deterministic and directly testable.
- Avoid adding prompt-submission hooks or a new application-level notification path.

## Non-goals

- Change provider selection or availability resolution.
- Change the wording or severity of provider errors.
- Automatically hide genuine `unavailableReason` values.
- Do not clear the separate `PromptEditor` composer-target preflight error; it is outside this provider-run lifecycle change.
- Add a user-configurable timeout.

## Architecture

`SpeechInputController` remains the owner of transient speech-input errors because it owns provider runs, terminal transitions, and disposal. The controller will add:

- a named `5_000` millisecond error-clear duration;
- reuse of the controller's existing one-shot `scheduleDeadline` dependency for the error clear;
- cancellation state for the pending clear callback;
- a sequence guard so an old callback cannot clear a newer error or state.

The public state shape remains unchanged. `PromptEditor` continues to render the controller state and does not own timers or duplicate error state.

## Behavior

Every `SpeechInputController`-published idle error from a terminal run outcome expires through this path. That includes provider callback failures, synchronous adapter-start failures, capture or transcription timeouts, controller callback failures, stop failures, and non-inserted final transcript outcomes. The separate `PromptEditor` preflight message for a missing composer target is not a provider-run outcome and remains outside this change.

When a provider run settles with an error, the controller publishes the normal idle state with `error` and registers a one-shot `5_000 ms` delay. Browser timer precision is not a user-visible contract: the warning clears when the registered callback runs. If another error replaces it, the previous callback is canceled and only the newest error can expire.

When the callback fires, the controller rebuilds the current idle state without `error`. The current availability resolution is recalculated, so any `unavailableReason` remains present. An accepted new dictation start invalidates the pending clear before publishing `requesting-permission`. A successful completion clears any pending clear as part of terminal cleanup. An idle `cancel()` remains a no-op and does not reset a pending countdown. An idle `configure()` preserves the existing countdown rather than registering a fresh one. Disposal invalidates and cancels the timer even when there is no active provider run and suppresses late callbacks.

The timeout is the only explicit dismissal rule for an idle transient warning. There is no hook from prompt submission into speech-input error state.

## Error Handling and Lifecycle

The existing `scheduleDeadline` dependency is reused for the error-clear delay, with a named `ERROR_CLEAR_DELAY_MS = 5_000` constant. The injected scheduler and canceler are best-effort side effects: if either throws, the controller keeps its already-published state, invalidates sequence state, and does not let the exception escape through a provider callback or disposal path. The production scheduler is the native one-shot timer.

Timer callbacks must check disposal and the current error sequence before publishing. A stale callback must be a no-op. An accepted start invalidates the pending clear before publishing an active state. Idle reconfiguration must leave the original countdown untouched, while expiry uses the latest settings and availability snapshot.

Existing provider availability and settings behavior remains unchanged. The microphone control may still be disabled indefinitely when `unavailableReason` accurately describes a persistent unsupported or misconfigured environment.

## Testing

Extend the existing `SpeechInputController` harness to track the controller's `scheduleDeadline` registrations and cancellations. Add focused tests that prove:

1. A provider error publishes the warning, registers exactly one `5_000 ms` clear delay, and clears after that callback is fired.
2. Clearing a transient error preserves a real `unavailableReason` from the latest availability snapshot.
3. A later provider error replaces the first timer: firing the first callback leaves the newer warning intact, and firing the second clears it.
4. An accepted new start invalidates the old timer; firing the stale callback cannot overwrite `requesting-permission` or a later terminal state.
5. Disposal from an idle error-pending state cancels the delay and a deliberately invoked late callback cannot publish state.
6. A controller-originated terminal error such as a rejected final insertion outcome follows the same expiry path as a provider error.

The red phase should assert that a provider error registers a `5_000 ms` clear delay. The current implementation registers no such delay, so the focused test fails before production code changes. After implementation, fire the captured callbacks to prove expiry and stale-callback suppression.

## Verification

Run the focused controller test first, then `npm run typecheck`, lint for changed files if needed, and `npm run verify:fast`. Inspect `git diff --check` and confirm the unrelated existing worktree changes remain untouched.
