# Speech Input Transient Error Dismissal

- Date: 2026-08-17
- Status: Ready for user review

## Problem

A failed speech-input run, such as a browser `audio-capture` failure, is published as an idle state with an `error`. `PromptEditor` renders that error, but the current controller has no expiry or clear path after the run has settled. The warning therefore remains visible until the component or page is recreated.

The speech-input state also contains `unavailableReason`. That is a separate persistent capability or configuration condition, such as settings still loading, an insecure context, an unsupported browser API, an unusable recorder format, or unavailable cloud credentials. It must not be treated as a transient run error.

## Goals

- Automatically dismiss a transient speech-input run error after exactly five seconds.
- Keep persistent availability and configuration reasons visible and accurate.
- Keep timer ownership inside the speech-input lifecycle module.
- Make timer behavior deterministic and directly testable.
- Avoid adding prompt-submission hooks or a new application-level notification path.

## Non-goals

- Change provider selection or availability resolution.
- Change the wording or severity of provider errors.
- Automatically hide genuine `unavailableReason` values.
- Clear speech errors when an unrelated prompt is submitted.
- Add a user-configurable timeout.

## Architecture

`SpeechInputController` remains the owner of transient speech-input errors because it owns provider runs, terminal transitions, and disposal. The controller will add:

- a named `5_000` millisecond error-clear duration;
- an injected one-shot scheduler option with a default `setTimeout` adapter;
- cancellation state for the pending clear callback;
- a sequence guard so an old callback cannot clear a newer error or state.

The public state shape remains unchanged. `PromptEditor` continues to render the controller state and does not own timers or duplicate error state.

## Behavior

When a provider run settles with an error, the controller publishes the normal idle state with `error` and schedules a clear for five seconds later. If another error replaces it, the previous callback is canceled and only the newest error can expire.

When the timer fires, the controller rebuilds the current idle state without `error`. The current availability resolution is recalculated, so any `unavailableReason` remains present. A successful completion, cancellation, or a new dictation attempt clears any pending transient-error timer as part of the normal run lifecycle. Disposal cancels the timer and suppresses late callbacks.

The timeout is the only explicit dismissal rule for an idle transient warning. There is no hook from prompt submission into speech-input error state.

## Error Handling and Lifecycle

Timer scheduling is an injected side effect. The default scheduler is the native one-shot timer; a test scheduler must be deterministic and return a canceler. Timer callbacks must check disposal and the current error sequence before publishing. A stale callback must be a no-op.

Existing provider availability and settings behavior remains unchanged. The microphone control may still be disabled indefinitely when `unavailableReason` accurately describes a persistent unsupported or misconfigured environment.

## Testing

Extend the existing `SpeechInputController` harness with a fake error-clear scheduler and tracked cancellations. Add focused tests that prove:

1. A provider error publishes the warning, schedules exactly `5_000` milliseconds, and clears after the scheduled callback.
2. Clearing a transient error preserves a real `unavailableReason`.
3. A subsequent dictation attempt does not retain the previous idle error while entering its requesting state.
4. Disposal cancels the scheduled callback and prevents a late callback from publishing state.

The regression test must fail before the controller change because the current implementation leaves `Microphone is unavailable` in the idle state after the fake timeout callback.

## Verification

Run the focused controller test first, then `npm run typecheck`, lint for changed files if needed, and `npm run verify:fast`. Inspect `git diff --check` and confirm the unrelated existing worktree changes remain untouched.
