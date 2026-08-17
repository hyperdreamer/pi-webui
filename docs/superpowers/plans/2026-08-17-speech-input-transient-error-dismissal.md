# Speech Input Transient Error Dismissal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically remove transient speech-input run errors from the composer after a scheduled five-second delay while preserving persistent availability and configuration reasons.

**Architecture:** Keep error expiry inside `SpeechInputController`, which already owns provider terminal transitions, idle state, and disposal. Reuse its injected `scheduleDeadline` seam to arm one error-clear callback guarded by a sequence token; `PromptEditor` remains unchanged and continues rendering controller state.

**Tech Stack:** TypeScript, Lit, Vitest, Changesets, Node.js.

## Global Constraints

- Use `ERROR_CLEAR_DELAY_MS = 5_000`; it is a scheduled delay, and the error clears when the callback runs.
- Reuse `SpeechInputControllerOptions.scheduleDeadline`; add no runtime dependency and no second scheduler option.
- Expire every controller-published idle error from a terminal run outcome, including provider errors, controller failures, timeouts, stop failures, and non-inserted final outcomes.
- Do not modify `PromptEditor`, provider adapters, availability resolution, or the separate `PromptEditor` composer-target preflight error.
- Preserve `unavailableReason` after transient-error expiry, using the latest settings and adapter availability snapshot.
- An accepted `start()` invalidates a pending error-clear callback before publishing `requesting-permission`; rejected/unavailable starts and idle `configure()` calls do not restart the countdown.
- Disposal must invalidate and best-effort cancel a pending error-clear callback even without an active run; scheduler and canceler exceptions must not escape lifecycle callbacks.
- Do not edit `CHANGELOG.md`; create a patch Changeset for `@hyperdreamer/pi-webui`.
- Do not stage, revert, or commit unrelated worktree changes.

## Task 1: Expire controller-owned speech-input errors

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/controllers/speechInputController.ts:20-510`
- Modify: `src/client/src/controllers/speechInputController.test.ts:89-788`
- Create: `.changeset/expire-speech-input-errors.md`

**Interfaces:**

- Consumes: `SpeechInputControllerOptions.scheduleDeadline(callback: () => void, delayMs: number): () => void`, the existing injected one-shot scheduler.
- Consumes: `SpeechInputControllerState`, whose idle variant is `{ kind: "idle"; provider?: SpeechInputProviderId; unavailableReason?: string; error?: string }`.
- Produces: unchanged public `SpeechInputController` methods and state shape; terminal idle errors are cleared by an internal `ERROR_CLEAR_DELAY_MS = 5_000` deadline only when its callback is current.
- Produces: `.changeset/expire-speech-input-errors.md` with a patch release note for `@hyperdreamer/pi-webui`.

- [ ] **Step 1: Extend the existing controller tests with failing error-clear cases**

In `FakeTimers`, continue using `deadlines` to observe both existing capture/transcription deadlines and the new `5_000` ms deadline. Add a file-local helper so tests identify the error deadline by delay instead of index:

```ts
function errorClearDeadline(timers: FakeTimers, index = 0): ScheduledCallback {
  const timer = timers.deadlines.filter((candidate) => candidate.delayMs === 5_000)[index];
  if (timer === undefined) throw new Error("Expected speech-input error-clear deadline");
  return timer;
}
```

Add these tests near the existing terminal-error tests. Each test must drive the real `SpeechInputController` through the existing `createHarness()`, `emitError()`, and `emitComplete()` helpers.

```ts
it("expires a provider error after the error-clear deadline while preserving latest availability", () => {
  const harness = createHarness();
  harness.controller.configure(settings({ provider: "browser" }));
  harness.controller.start(TARGET);
  emitError(harness.browser, { code: "microphone-unavailable", message: "Microphone is unavailable" });

  const deadline = errorClearDeadline(harness.timers);
  expect(deadline.delayMs).toBe(5_000);
  harness.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
  harness.controller.configure(settings({ provider: "browser" }));
  expect(errorClearDeadline(harness.timers)).toBe(deadline);

  deadline.callback();
  expect(harness.controller.state).toEqual({ kind: "idle", unavailableReason: "Browser speech is unavailable" });
});

it("keeps a newer terminal error when an earlier error-clear callback fires", () => {
  const harness = createHarness();
  harness.controller.configure(settings({ provider: "browser" }));
  harness.controller.start(TARGET);
  emitError(harness.browser, { code: "network", message: "First error" });
  const first = errorClearDeadline(harness.timers);

  harness.controller.start(TARGET);
  emitError(harness.browser, { code: "network", message: "Second error" });
  const second = errorClearDeadline(harness.timers, 1);

  expect(first.cancelled).toBe(true);
  first.callback();
  expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser", error: "Second error" });
  second.callback();
  expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser" });
});

it("does not let an expired error callback overwrite a later requesting run", () => {
  const harness = createHarness();
  harness.controller.configure(settings({ provider: "browser" }));
  harness.controller.start(TARGET);
  emitError(harness.browser, { code: "network", message: "Retry me" });
  const deadline = errorClearDeadline(harness.timers);

  harness.controller.start(TARGET);
  deadline.callback();

  expect(deadline.cancelled).toBe(true);
  expect(harness.controller.state).toEqual({ kind: "requesting-permission", runId: "run-2", provider: "browser" });
});

it("cancels an idle error-clear deadline during disposal and suppresses its late callback", () => {
  const harness = createHarness();
  harness.controller.configure(settings({ provider: "browser" }));
  harness.controller.start(TARGET);
  emitError(harness.browser, { code: "network", message: "Dispose me" });
  const deadline = errorClearDeadline(harness.timers);
  const stateCount = harness.states.length;

  harness.controller.dispose();
  deadline.callback();

  expect(deadline.cancelled).toBe(true);
  expect(harness.states).toHaveLength(stateCount);
});

it("expires a controller-originated final insertion error", () => {
  const harness = createHarness();
  harness.controller.configure(settings({ provider: "browser" }));
  harness.setFinalOutcome("empty");
  harness.controller.start(TARGET);
  emitComplete(harness.browser, "final words");

  errorClearDeadline(harness.timers).callback();
  expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser" });
});
```

Also add these scheduler-boundary tests, using local `FakeAdapter` instances so the production controller is exercised without browser globals:

```ts
it("contains error-clear scheduler failures", () => {
  const browser = new FakeAdapter("browser");
  const controller = new SpeechInputController({
    browser,
    cloud: new FakeAdapter("cloud"),
    createRunId: () => "run-1",
    scheduleDeadline: (_callback, delayMs) => {
      if (delayMs === 5_000) throw new Error("error-clear scheduler failed");
      return () => undefined;
    },
    callbacks: {
      onStateChange: () => undefined,
      onInterim: () => undefined,
      onFinal: () => "inserted",
      onClearInterim: () => undefined,
    },
  });
  controller.configure(settings({ provider: "browser" }));

  expect(() => {
    controller.start(TARGET);
    emitError(browser, { code: "network", message: "Scheduler failure" });
  }).not.toThrow();
  expect(controller.state).toEqual({ kind: "idle", provider: "browser", error: "Scheduler failure" });
});

it("contains a throwing error-clear canceler during an accepted retry", () => {
  const browser = new FakeAdapter("browser");
  let staleCallback: (() => void) | undefined;
  const controller = new SpeechInputController({
    browser,
    cloud: new FakeAdapter("cloud"),
    createRunId: (() => {
      const ids = ["run-1", "run-2"];
      return () => ids.shift() ?? "run-extra";
    })(),
    scheduleDeadline: (callback, delayMs) => {
      if (delayMs !== 5_000) return () => undefined;
      staleCallback = callback;
      return () => { throw new Error("error-clear canceler failed"); };
    },
    callbacks: {
      onStateChange: () => undefined,
      onInterim: () => undefined,
      onFinal: () => "inserted",
      onClearInterim: () => undefined,
    },
  });
  controller.configure(settings({ provider: "browser" }));
  controller.start(TARGET);
  emitError(browser, { code: "network", message: "Retry failure" });

  expect(() => { controller.start(TARGET); }).not.toThrow();
  if (staleCallback === undefined) throw new Error("Expected stale error-clear callback");
  staleCallback();
  expect(controller.state).toEqual({ kind: "requesting-permission", runId: "run-2", provider: "browser" });
});

it("contains a throwing error-clear canceler during idle disposal", () => {
  const browser = new FakeAdapter("browser");
  let lateCallback: (() => void) | undefined;
  const states: SpeechInputControllerState[] = [];
  const controller = new SpeechInputController({
    browser,
    cloud: new FakeAdapter("cloud"),
    createRunId: () => "run-1",
    scheduleDeadline: (callback, delayMs) => {
      if (delayMs !== 5_000) return () => undefined;
      lateCallback = callback;
      return () => { throw new Error("error-clear canceler failed"); };
    },
    callbacks: {
      onStateChange: (state) => { states.push(state); },
      onInterim: () => undefined,
      onFinal: () => "inserted",
      onClearInterim: () => undefined,
    },
  });
  controller.configure(settings({ provider: "browser" }));
  controller.start(TARGET);
  emitError(browser, { code: "network", message: "Dispose failure" });
  const stateCount = states.length;

  expect(() => { controller.dispose(); }).not.toThrow();
  if (lateCallback === undefined) throw new Error("Expected late error-clear callback");
  lateCallback();
  expect(states).toHaveLength(stateCount);
});
```

- [ ] **Step 2: Run the focused test file and confirm the new regression fails for the expected reason**

Run: `npm test -- --run src/client/src/controllers/speechInputController.test.ts`

Expected: FAIL because `errorClearDeadline()` cannot find a `5_000` ms registration after a terminal error. Existing tests may continue to pass; do not proceed until at least one new assertion fails for the missing deadline rather than for a test setup error.

- [ ] **Step 3: Implement the contained controller lifecycle**

In `speechInputController.ts`, add the named duration beside the other controller timing constants and add private timer ownership fields:

```ts
const ERROR_CLEAR_DELAY_MS = 5_000;

private errorClearCancel: (() => void) | undefined;
private errorClearSequence = 0;
```

Keep `publishIdle(error)` as the state-shaping helper. Add three private helpers adjacent to it:

```ts
private clearErrorClear(): void {
  const cancel = this.errorClearCancel;
  this.errorClearCancel = undefined;
  this.errorClearSequence += 1;
  try {
    cancel?.();
  } catch {
    // A timer canceler is best effort; sequence invalidation still blocks it.
  }
}

private armErrorClear(): void {
  const sequence = ++this.errorClearSequence;
  let cancel: (() => void) | undefined;
  try {
    cancel = this.scheduleDeadline(() => {
      if (
        this.disposed
        || sequence !== this.errorClearSequence
        || this.active !== undefined
        || this.stateValue.kind !== "idle"
        || this.stateValue.error === undefined
      ) return;
      this.errorClearCancel = undefined;
      this.errorClearSequence += 1;
      this.publishIdle(undefined);
    }, ERROR_CLEAR_DELAY_MS);
  } catch {
    return;
  }
  if (
    this.disposed
    || sequence !== this.errorClearSequence
    || this.active !== undefined
    || this.stateValue.kind !== "idle"
    || this.stateValue.error === undefined
  ) {
    try {
      cancel?.();
    } catch {
      // The callback is already invalidated by the sequence guard.
    }
    return;
  }
  this.errorClearCancel = cancel;
}

private publishTerminalIdle(error: string | undefined): void {
  this.clearErrorClear();
  this.publishIdle(error);
  if (
    error !== undefined
    && this.active === undefined
    && this.stateValue.kind === "idle"
    && this.stateValue.error === error
  ) this.armErrorClear();
}
```

Make these lifecycle substitutions:

```ts
// In start(), after availability resolution succeeds and before active is assigned:
this.clearErrorClear();

// In dispose(), immediately after setting disposed, before the active-run early return:
this.clearErrorClear();

// In settleTerminal(), replace the normal publish branch:
if (options.publish !== false && !this.disposed && !this.hasActiveRun()) {
  this.publishTerminalIdle(error);
}
```

Do not call `clearErrorClear()` from `configure()` or from the unavailable/start-rejected branches. Those paths republish the current idle state but must retain the original pending deadline. Do not schedule an error clear in the `publish === false` disposal branch. Preserve all existing active capture and transcription timer behavior.

- [ ] **Step 4: Run the focused test file and confirm all controller behavior passes**

Run: `npm test -- --run src/client/src/controllers/speechInputController.test.ts`

Expected: PASS. Confirm the new cases prove the `5_000` ms registration, latest-snapshot availability preservation, stale-callback suppression, error replacement, scheduler/canceler exception containment, and idle disposal behavior without breaking capture or transcription deadline tests.

- [ ] **Step 5: Add the release fragment**

Create `.changeset/expire-speech-input-errors.md` exactly as follows:

```md
---
"@hyperdreamer/pi-webui": patch
---

Automatically dismiss transient speech-input errors after five seconds.
```

Do not run `changeset version` and do not edit `CHANGELOG.md`.

- [ ] **Step 6: Run type, lint, and broad fast verification**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

Run: `npx eslint src/client/src/controllers/speechInputController.ts src/client/src/controllers/speechInputController.test.ts`

Expected: PASS with no lint errors.

Run: `npm run verify:fast`

Expected: PASS. Run this only after focused tests finish and without another heavy test job running.

- [ ] **Step 7: Inspect the scoped diff and commit only task files**

Run: `git diff --check`

Expected: no output.

Verify the diff contains only the controller, its test, and `.changeset/expire-speech-input-errors.md` for this task. Stage and commit only those paths:

```bash
git add src/client/src/controllers/speechInputController.ts \
  src/client/src/controllers/speechInputController.test.ts \
  .changeset/expire-speech-input-errors.md
git commit -m "fix(speech-input): expire transient input errors"
```
