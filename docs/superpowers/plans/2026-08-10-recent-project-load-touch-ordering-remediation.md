# Recent Project Load/Touch Ordering Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close residual finding `F-2` by ensuring meaningful work accepted after a recent-project reload is issued cannot be skipped by a stale newest-project optimization marker.

**Architecture:** Keep the final-fix commit's independent per-machine queues and shared ordering for loads, touches, and removals. Invalidate the selected machine's newest-project belief as soon as a load is issued, before a later synchronous `recordWork` guard can consult it, while retaining in-queue invalidation so an earlier queued operation cannot revive stale belief before the load executes.

**Tech Stack:** TypeScript, Vitest, the existing `RecentProjectController`, npm verification scripts.

## Global Constraints

- Fix only carried residual `F-2`; preserve the verified fixes for `F-1`, `F-3`, `F-4`, `F-5`, and `F-6`.
- The authoritative design requires client mutations to serialize per machine and prevents an older full-list response from overwriting a newer client mutation.
- `recordWork` must keep its cheap synchronous no-request path when the per-machine newest belief is valid, because terminal input invokes it per keystroke.
- Issuing a state-producing load invalidates the pre-load newest belief immediately; meaningful work accepted after that issue point must join the same machine queue and run after the load.
- Keep independent machine queues, stale selected-machine suppression, authoritative server order, retry after touch failure, and nonblocking background touch errors.
- Do not change HTTP, persistence, dialog/focus, session acceptance, plugin public API, session-daemon protocol/lifecycle, Changeset, README, or CHANGELOG behavior.
- Add no runtime dependency.
- Use strict red-green TDD and prove the new regression fails for the expected skipped-touch reason before changing production code.
- Leave the branch's existing minor Changeset unchanged.

## Task 1: Invalidate stale newest belief when a reload is issued

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/controllers/recentProjectController.ts:35-90`
- Test: `src/client/src/controllers/recentProjectController.test.ts:30-190`

**Interfaces:**

- Consumes: `RecentProjectController.load(): Promise<void>` and `RecentProjectController.recordWork(projectId: string, machineId?: string): void`.
- Consumes: the existing per-machine `queuesByMachine: Map<string, Promise<void>>` and `newestProjectIdByMachine: Map<string, string>` state introduced by commit `17d78608731953fee1289ea3f29341809d1e213f`.
- Produces: the same public controller API; no new exported type or callback.
- Preserves: `recordWork` short-circuits synchronously only while no intervening load has invalidated that machine's newest belief.

- [ ] **Step 1: Add the exact failing regression**

Extend the `RecentProjectController recording work` suite with a test that first establishes `project-alpha` as the controller's newest successful touch, then issues a deferred reload, accepts later work on `project-alpha`, and resolves the older reload as beta-first. Use this behavior shape (adapt only local helper spelling if needed):

```ts
it("records later work when an earlier reload invalidates the newest belief", async () => {
  const reload = deferred<RecentProjectEntry[]>();
  const recordRecentProject = vi.fn()
    .mockResolvedValueOnce([entry("/work/alpha"), entry("/work/beta")])
    .mockResolvedValueOnce([entry("/work/alpha"), entry("/work/beta")]);
  const recentProjects = vi.fn()
    .mockResolvedValueOnce([entry("/work/alpha"), entry("/work/beta")])
    .mockReturnValueOnce(reload.promise);
  const { controller } = harness({ recentProjects, recordRecentProject });

  await controller.load();
  controller.recordWork("project-alpha");
  await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(1); });

  const loading = controller.load();
  controller.recordWork("project-alpha");
  await Promise.resolve();

  expect(recordRecentProject).toHaveBeenCalledTimes(1);
  reload.resolve([entry("/work/beta"), entry("/work/alpha")]);
  await loading;
  await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(2); });

  expect(recordRecentProject).toHaveBeenLastCalledWith("project-alpha", "local");
  expect(controller.state).toEqual({
    kind: "ready",
    entries: [entry("/work/alpha"), entry("/work/beta")],
  });
});
```

The important causal assertions are that the second touch does not start before the queued reload settles, does start after the reload publishes beta-first, and restores alpha-first authoritative state.

- [ ] **Step 2: Run the focused test and confirm RED for the residual**

Run:

```bash
npm test -- --run src/client/src/controllers/recentProjectController.test.ts
```

Expected: the new test fails because `recordRecentProject` remains at one call and final state is beta-first. Confirm this is the synchronous `isAlreadyNewest` return before editing production code; a timeout or fixture error is not an acceptable red phase.

- [ ] **Step 3: Invalidate belief at both the issue and ordered execution boundaries**

In `load()`, clear `newestProjectIdByMachine` for the captured `machineId` synchronously before publishing `loading` or awaiting `enqueue`. This prevents a later accepted `recordWork` call from being discarded before it can join the queue.

Retain or move the in-queue invalidation so it occurs when the queued load operation begins, before the GET attempt. This second invalidation is required because an operation queued before the load may complete after load issuance and set a marker again. The intended shape is:

```ts
async load(): Promise<void> {
  const machineId = this.deps.machineId();
  const generation = ++this.generation;
  this.newestProjectIdByMachine.delete(machineId);
  this.publish({ kind: "loading" });
  await this.enqueue(machineId, async () => {
    this.newestProjectIdByMachine.delete(machineId);
    try {
      const entries = await this.api.recentProjects(machineId);
      if (this.isStale(generation, machineId)) return;
      this.publish({ kind: "ready", entries });
    } catch (error) {
      if (this.isStale(generation, machineId)) return;
      this.publish({ kind: "failed", message: errorMessage(error) });
    }
  });
}
```

Do not remove either the call-time or queued `recordWork` newest checks. The queued check still coalesces bursts after the load establishes current order; the new invalidation only prevents a pre-load belief from suppressing post-issue work.

- [ ] **Step 4: Verify focused behavior and adjacent queue invariants**

Run:

```bash
npm test -- --run src/client/src/controllers/recentProjectController.test.ts
```

Expected: all controller tests pass, including the exact residual, same-machine load/touch and load/remove ordering, cross-machine nonblocking behavior, redundant-touch coalescing, stale suppression, retry, and `409` reconciliation.

- [ ] **Step 5: Run branch verification**

Run, without another heavy suite in parallel:

```bash
npm run typecheck
npm run lint
npm run verify:fast
npm run verify
```

Expected: every command exits 0. `npm run verify` must retain at least the final-fix baseline of 410 test files and 4,299 passing tests plus the new regression, with only the repository's existing skips/hints.

- [ ] **Step 6: Commit the remediation**

Run:

```bash
git diff --check
git status --short
git diff -- src/client/src/controllers/recentProjectController.ts src/client/src/controllers/recentProjectController.test.ts
```

Expected: only the plan-allowed controller/test changes are uncommitted and no whitespace error is reported. Then commit:

```bash
git add src/client/src/controllers/recentProjectController.ts src/client/src/controllers/recentProjectController.test.ts
git commit -m "fix(client): preserve work queued after recent-project reloads"
```

Write the implementer report with the observed red failure, focused and full verification counts, clean status, and commit SHA.
