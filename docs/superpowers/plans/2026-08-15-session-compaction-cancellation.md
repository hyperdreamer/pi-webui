# Session Compaction Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Stop action reliably cancel both manual and automatic Pi compaction without killing the shared session daemon or reporting intentional manual cancellation as an error.

**Architecture:** `SessionCommandService` records each manual `/compact` invocation by session ID so its eventual rejected promise can be recognized as a user-requested cancellation. `PiSessionService` owns the actual SDK side effect: it calls Pi's required `abortCompaction()` before its existing branch-summary and agent abort steps, then marks the manual command token after the SDK hook succeeds. The existing route and browser control remain unchanged.

**Tech Stack:** TypeScript, the Pi 0.84 session SDK, Vitest 4, and Changesets.

## Global Constraints

- Implement `docs/superpowers/specs/2026-08-15-session-compaction-cancellation-design.md`, including its audited direct-call ordering.
- PI WEBUI supports `@earendil-works/pi-coding-agent >=0.84.0 <0.85`; both 0.84.0 and 0.84.1 expose required `AgentSession.abortCompaction(): void`.
- Do not add runtime dependencies, routes, response types, browser controls, or a daemon/runtime restart fallback.
- Stop must call `session.abortCompaction()` directly before branch-summary and ordinary agent abort work. Mark a manual-compaction token only after that hook returns without throwing.
- Stop must clear existing prompt queues. Manual cancellation must publish `Compaction cancelled.` at `info` level, end with idle activity, and never publish `session.error`.
- Preserve all non-cancelled success and error behavior. A failing compaction abort hook must not prevent branch-summary or ordinary agent abort attempts.
- The session daemon owns this code path. A manual restart of `pi-webui-sessiond.service` is required after deployment; do not make UI/API restart assumptions.
- Follow red-green TDD with focused deterministic Vitest tests. Do not use sleeps, `git commit --no-verify`, or modify the pre-commit hook.
- Add one patch Changeset for `@hyperdreamer/pi-webui`. Do not edit `CHANGELOG.md` directly.

### Planned Files

- `src/server/sessions/sessionCommandService.ts`: manual compaction operation tracking and cancellation lifecycle outcome.
- `src/server/sessions/sessionCommandService.test.ts`: unit coverage for cancellation, cleanup, and already-settled success.
- `src/server/sessions/piSessionService.ts`: Pi SDK adapter, lifecycle projection, and ordered abort orchestration.
- `src/server/sessions/piSessionService.testSupport.ts`: fake required SDK abort hook and observability.
- `src/server/sessions/piSessionService.promptQueue.test.ts`: integration coverage for manual cancellation, auto-compaction, queue cleanup, and hook failure.
- `.changeset/session-compaction-cancellation.md`: patch release note.

## Task 1: Track And Classify Manual Compaction Cancellation

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/sessionCommandService.ts:50-158`
- Test: `src/server/sessions/sessionCommandService.test.ts:1-347`

**Interfaces:**

- Consumes: `CommandSession.compact(instructions?: string): Promise<{ summary: string; tokensBefore: number }>`.
- Produces: `SessionCommandService.cancelManualCompaction(sessionId: string): void`.
- Produces: `SessionCommandLifecycle.onCompactionEnd?(session, result: "success" | "error" | "cancelled", detail?: string): void`.
- Internal contract: every `/compact` invocation receives its own `{ cancelled: boolean }` token. Tokens are held in a `Map<string, Set<ManualCompaction>>`, so a Stop request marks all still-active manual compactions for that session and completion removes only its own token.

- [ ] **Step 1: Add the failing cancellation and cleanup tests**

In `sessionCommandService.test.ts`, replace the local `deferred` helper so it exposes both `resolve` and `reject`:

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
```

Add this test after the existing successful compaction test:

```ts
it("reports an explicitly cancelled manual compaction without a session error", async () => {
  const pending = deferred<{ summary: string; tokensBefore: number }>();
  const active = activeSession({ compact: vi.fn(() => pending.promise) });
  const events = eventPublisher();
  const onCompactionEnd = vi.fn();
  const service = new SessionCommandService(
    () => getActive(active),
    vi.fn(),
    events,
    { onCompactionEnd },
  );

  await expect(service.run("s1", "/compact")).resolves.toEqual({
    type: "done",
    message: "Compaction started…",
  });
  service.cancelManualCompaction("s1");
  pending.reject(new Error("Compaction cancelled"));

  await vi.waitFor(() => {
    expect(events.publish).toHaveBeenCalledWith("s1", {
      type: "command.output",
      level: "info",
      message: "Compaction cancelled.",
    });
    expect(onCompactionEnd).toHaveBeenCalledWith(
      active.runtime.session,
      "cancelled",
    );
  });
  expect(events.publish).not.toHaveBeenCalledWith(
    "s1",
    expect.objectContaining({ type: "session.error" }),
  );

  const laterFailure = deferred<{ summary: string; tokensBefore: number }>();
  vi.mocked(active.runtime.session.compact).mockReturnValueOnce(laterFailure.promise);
  await service.run("s1", "/compact");
  laterFailure.reject(new Error("provider failed"));
  await vi.waitFor(() => {
    expect(onCompactionEnd).toHaveBeenLastCalledWith(
      active.runtime.session,
      "error",
      "provider failed",
    );
  });
});
```

Add this second test immediately after the cancellation test. It pins the required rule that calling `cancelManualCompaction` after the compaction has already settled is a no-op:

```ts
it("ignores cancellation after the compaction has already settled", async () => {
  const active = activeSession();
  const events = eventPublisher();
  const onCompactionEnd = vi.fn();
  const service = new SessionCommandService(
    () => getActive(active),
    vi.fn(),
    events,
    { onCompactionEnd },
  );

  await service.run("s1", "/compact");
  await vi.waitFor(() => {
    expect(onCompactionEnd).toHaveBeenCalledWith(active.runtime.session, "success");
  });

  // Cancellation arrives after success has already settled the token.
  service.cancelManualCompaction("s1");

  // Let any pending microtasks flush.
  await Promise.resolve();

  const infoCalls = vi.mocked(events.publish).mock.calls.filter(
    ([, event]) => event.type === "command.output" && event.level === "info",
  );
  expect(infoCalls).toHaveLength(0);
  expect(onCompactionEnd).toHaveBeenCalledTimes(1);
  expect(onCompactionEnd).not.toHaveBeenCalledWith(
    active.runtime.session,
    "cancelled",
  );
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npm test -- --run src/server/sessions/sessionCommandService.test.ts
```

Expected: FAIL because `cancelManualCompaction` does not exist. Do not change production code until this failure is observed.

- [ ] **Step 3: Implement per-invocation token tracking and the cancelled outcome**

In `sessionCommandService.ts`, add these internal definitions near `PendingCommandSelect`:

```ts
interface ManualCompaction {
  cancelled: boolean;
}
```

Add this field and public method to `SessionCommandService`:

```ts
private readonly manualCompactions = new Map<string, Set<ManualCompaction>>();

cancelManualCompaction(sessionId: string): void {
  for (const compaction of this.manualCompactions.get(sessionId) ?? [])
    compaction.cancelled = true;
}
```

Add private helpers that create and remove exactly one token:

```ts
private beginManualCompaction(sessionId: string): ManualCompaction {
  const compaction = { cancelled: false };
  const active = this.manualCompactions.get(sessionId);
  if (active === undefined)
    this.manualCompactions.set(sessionId, new Set([compaction]));
  else active.add(compaction);
  return compaction;
}

private settleManualCompaction(
  sessionId: string,
  compaction: ManualCompaction,
): boolean {
  const active = this.manualCompactions.get(sessionId);
  active?.delete(compaction);
  if (active?.size === 0) this.manualCompactions.delete(sessionId);
  return compaction.cancelled;
}

private publishCompactionCancellation(session: TSession): void {
  this.events.publish(session.sessionId, {
    type: "command.output",
    level: "info",
    message: "Compaction cancelled.",
  });
  this.lifecycle.onCompactionEnd?.(session, "cancelled");
}
```

Expand the `onCompactionEnd` union to include `"cancelled"`. At the top of `compact`, create a token before calling `onCompactionStart`:

```ts
const compaction = this.beginManualCompaction(session.sessionId);
```

In both the existing `.then` and `.catch` handlers, call `settleManualCompaction(session.sessionId, compaction)` before publishing any terminal event. When it returns `true`, call `publishCompactionCancellation(session)` and return. Otherwise retain the exact existing success path or existing error output plus `session.error` path. Do not inspect error text to identify cancellation.

- [ ] **Step 4: Run focused and static checks**

Run:

```bash
npm test -- --run src/server/sessions/sessionCommandService.test.ts
npm run typecheck
npx eslint src/server/sessions/sessionCommandService.ts src/server/sessions/sessionCommandService.test.ts
```

Expected: all commands pass. The successful compaction test remains unchanged in behavior, the cancellation test emits only the informational output, and the later non-cancelled rejection remains an error.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/server/sessions/sessionCommandService.ts src/server/sessions/sessionCommandService.test.ts
git commit -m "fix(sessions): classify cancelled manual compaction"
```

## Task 2: Signal Pi Compaction From The Stop Path

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/piSessionService.ts:567-681,1429-1455,3834-3855,4206-4229`
- Modify: `src/server/sessions/piSessionService.testSupport.ts:40-55,179-269`
- Test: `src/server/sessions/piSessionService.promptQueue.test.ts:1-25,670-720`
- Create: `.changeset/session-compaction-cancellation.md`

**Interfaces:**

- Consumes: `cancelManualCompaction(sessionId: string): void` from Task 1. It only marks command-service tokens and must be called after `session.abortCompaction()` succeeds.
- Produces: required `PiAgentSession.abortCompaction(): void`.
- Produces: `onCompactionEnd(session, "cancelled")` that calls `endSessionEntryMutation(session)`, publishes `compaction cancelled` with idle phase, and publishes final status.
- Produces: `abortSessionOperations(session)` that always attempts, in order, Pi compaction cancellation, command-token marking after success, branch-summary cancellation, then `await session.abort()`; it rethrows one failure unchanged or aggregates multiple failures after all attempts.

- [ ] **Step 1: Add failing Pi session tests and fake observability**

In `piSessionService.testSupport.ts`, extend `TestSession` with:

```ts
abortCompaction: () => void;
```

Extend the fake `calls` object with `abortCompaction: 0` and add this default fake method:

```ts
abortCompaction: () => {
  calls.abortCompaction += 1;
  session.isCompacting = false;
},
```

In `piSessionService.promptQueue.test.ts`, add this local `deferred` helper near the top of the file (the file has no existing helper of this kind):

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
```

Note: the existing `sessionCommandService.test.ts` has a `deferred` helper that only exposes `resolve`. This helper must also expose `reject` because the manual-compaction test drives Pi's rejection path. Do not copy the resolve-only version.

Add these cases near the existing abort-during-compaction coverage:

```ts
it("settles a stopped manual compaction as cancelled without a session error", async () => {
  const hub = new CapturingSessionEventHub();
  const fake = fakeRuntime("manual-compaction");
  const pending = deferred<{ summary: string; tokensBefore: number }>();
  fake.session.compact = vi.fn(() => {
    fake.session.isCompacting = true;
    return pending.promise;
  });
  fake.session.abortCompaction = vi.fn(() => {
    fake.session.isCompacting = false;
  });
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord("manual-compaction")]),
    heartbeatIntervalMs: 60_000,
  });

  await service.runCommand(sessionRef("manual-compaction"), "/compact");
  await service.abort(sessionRef("manual-compaction"));
  expect(fake.session.abortCompaction).toHaveBeenCalledOnce();
  pending.reject(new Error("Compaction cancelled"));

  await vi.waitFor(() => {
    expect(hub.sessionEvents).toContainEqual({
      sessionId: "manual-compaction",
      event: {
        type: "command.output",
        level: "info",
        message: "Compaction cancelled.",
      },
    });
  });
  expect(hub.sessionEvents.some(({ event }) => event.type === "session.error")).toBe(false);
  const activities = hub.sessionEvents.filter(({ event }) => event.type === "activity.update");
  expect(activities.at(-1)?.event).toMatchObject({
    activity: { label: "compaction cancelled", phase: "idle" },
  });
  await service.dispose();
});
```

Update the existing `clears prompts queued during compaction when aborting active work` test (line 687) to add one assertion after `expect(fake.calls.clearQueue).toBe(1)`:

```ts
expect(fake.calls.abortCompaction).toBe(1);
```

Note on observability: the manual-compaction test below overrides `fake.session.abortCompaction` with a `vi.fn()`, so it uses `expect(fake.session.abortCompaction).toHaveBeenCalledOnce()` (the Vitest mock API). The existing queue-clearing test and the auto-compaction test use the default fake's plain counter function, so they use `fake.calls.abortCompaction`. Do not use `vi.fn()` as the default implementation in `testSupport.ts` — keep it as a plain counter function.

Add this auto-compaction case. It deliberately does not start `/compact`, so no `SessionCommandService` token exists:

```ts
it("signals automatic compaction without a manual cancellation result", async () => {
  const hub = new CapturingSessionEventHub();
  const fake = fakeRuntime("auto-compaction", { isCompacting: true });
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord("auto-compaction")]),
    heartbeatIntervalMs: 60_000,
  });

  await service.status(sessionRef("auto-compaction"));
  await service.abort(sessionRef("auto-compaction"));

  expect(fake.calls.abortCompaction).toBe(1);
  expect(fake.calls.abort).toBe(1);
  const statuses = hub.sessionEvents.filter(({ event }) => event.type === "status.update");
  expect(statuses.at(-1)?.event).toMatchObject({
    status: { isCompacting: false },
  });
  expect(hub.sessionEvents.some(({ event }) => (
    event.type === "command.output" && event.message === "Compaction cancelled."
  ))).toBe(false);
  await service.dispose();
});
```

Add this hook-failure ordering case:

```ts
it("continues branch and agent abort after compaction cancellation fails", async () => {
  const failure = new Error("compaction abort failed");
  const order: string[] = [];
  const fake = fakeRuntime("compaction-abort-failure", {
    abortCompaction: () => {
      order.push("compaction");
      throw failure;
    },
    abortBranchSummary: () => {
      order.push("branch");
    },
    abort: () => {
      order.push("abort");
      return Promise.resolve();
    },
  });
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord("compaction-abort-failure")]),
    heartbeatIntervalMs: 60_000,
  });

  await service.status(sessionRef("compaction-abort-failure"));
  await expect(service.abort(sessionRef("compaction-abort-failure"))).rejects.toBe(failure);
  expect(order).toEqual(["compaction", "branch", "abort"]);
  await service.dispose();
});
```

- [ ] **Step 2: Run the focused Pi session test and confirm RED**

Run:

```bash
npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts
```

Expected: FAIL because the current stop path never invokes `abortCompaction`, manual cancellation still becomes `session.error`, and a throwing hook is not observed.

- [ ] **Step 3: Add the SDK hook, ordered abort orchestration, and cancelled lifecycle projection**

Note on single-failure propagation: when exactly one hook throws and the others succeed, `abortSessionOperations` rethrows that single error unwrapped (not wrapped in `AggregateError`). The hook-failure test's `.rejects.toBe(failure)` assertion relies on this — if `branch` and `abort` also threw, the error would be an `AggregateError` and `.toBe(failure)` would fail.

In `PiAgentSession`, declare the required SDK method next to the existing abort methods:

```ts
abortCompaction(): void;
abortBranchSummary?(): void;
abort(): Promise<void>;
```

Update the `onCompactionEnd` callback passed to `SessionCommandService` so it ends the session-entry mutation for all outcomes and projects all three states explicitly:

```ts
onCompactionEnd: (session, result, detail) => {
  this.endSessionEntryMutation(session);
  const activity = result === "success"
    ? { label: "compaction complete", phase: "idle" as const }
    : result === "cancelled"
      ? { label: "compaction cancelled", phase: "idle" as const }
      : { label: "compaction failed", phase: "error" as const };
  this.publishActivity(session, activity.label, activity.phase, detail);
  this.publishStatus(session);
},
```

Replace `abortSessionOperations` with a failure-collecting implementation that never short-circuits later abort attempts:

```ts
private async abortSessionOperations(session: PiAgentSession): Promise<void> {
  const failures: unknown[] = [];
  try {
    session.abortCompaction();
    this.commandService.cancelManualCompaction(session.sessionId);
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    session.abortBranchSummary?.();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await session.abort();
  } catch (error: unknown) {
    failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Failed to abort session operations",
      { cause: failures[failures.length - 1] },
    );
  }
}
```

Retain `PiSessionService.abort()` queue clearing, its existing `stopped` activity, and its final status publication. The late manual command callback is responsible for the final `compaction cancelled` activity after Pi's rejected promise settles.

- [ ] **Step 4: Add the release note and run complete verification**

Create `.changeset/session-compaction-cancellation.md` exactly as:

```md
---
"@hyperdreamer/pi-webui": patch
---

Allow Stop to cancel manual and automatic session compaction so a stuck compaction no longer blocks the session.
```

Run:

```bash
npm test -- --run src/server/sessions/sessionCommandService.test.ts src/server/sessions/piSessionService.promptQueue.test.ts
npm run typecheck
npx eslint src/server/sessions/sessionCommandService.ts src/server/sessions/sessionCommandService.test.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.testSupport.ts src/server/sessions/piSessionService.promptQueue.test.ts
npm run verify:fast
npm run changelog:status
git diff --check
```

Expected: all focused tests, typecheck, lint, fast verification, Changeset status, and whitespace checks pass. The only new release metadata is the patch Changeset; `CHANGELOG.md` remains untouched.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.testSupport.ts src/server/sessions/piSessionService.promptQueue.test.ts .changeset/session-compaction-cancellation.md
git commit -m "fix(sessions): cancel stuck compactions"
```

The normal pre-commit hook must pass. Inform the user that `pi-webui-sessiond.service` needs a manual restart to load this session-daemon change.
