# Explicit Project Work Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the default-parameter fallback in `PiWebUiApp.recordProjectWork` so a caller that captured no work target records nothing instead of silently recording whatever project is selected when the async work settles.

**Architecture:** `recordProjectWork` keeps its `undefined` guard but loses its default argument, making the captured-target contract explicit at every call site. Callers that genuinely want the live selection call `selectedProjectWorkTarget()` themselves. No behavior changes for callers that already pass a defined target.

**Tech Stack:** TypeScript, Lit, Vitest, the existing `PiWebUiApp` recent-project work boundaries.

## Context

A post-merge audit of the Recent Projects branch found that `recordProjectWork(target = this.selectedProjectWorkTarget())` at `src/client/src/components/PiWebUiApp.ts:2865` defeats its own captured-target guarantee. JavaScript default parameters fire on an explicitly passed `undefined`, so `recordProjectWork(undefined)` does not no-op; it re-resolves the target from live state at fire time.

Three of the five call sites pass a value typed `ProjectWorkTarget | undefined`:

- `src/client/src/components/PiWebUiApp.ts:4387` captures `undefined` when the terminal modal renders with no selected workspace.
- `src/client/src/components/PiWebUiApp.ts:3853` captures the target before an awaited `sessions.send`.
- `src/client/src/components/PiWebUiApp.ts:3880` captures the target before an awaited session start.

The two prompt paths are the more consequential variant, because they capture before an `await` and then record in a `.then` continuation. If the captured target was `undefined` and a project becomes selected while the request is in flight, the fallback attributes that work to the newly selected project. That is precisely the "navigation while awaiting must never touch the wrong machine or project" invariant the branch's final review required.

No user-visible defect is currently reachable through the modal path: `TerminalPanel.startTerminal` returns early without a workspace and `send` requires an OPEN socket, so neither callback can fire from a render that captured `undefined`. The prompt paths depend on transient state invariants that the type system does not enforce. This task removes the whole class rather than arguing reachability case by case.

## Scope decisions

Two other audit observations are deliberately **not** tasks in this plan.

**Changeset clause (optional, user-gated).** The branch's final-fix commit added a `max-width: 360px` terminal-modal-header rule that fixed a measured 320px overflow. It is correct and CDP-verified, and rewriting that reviewed commit for provenance alone is not worthwhile. If the maintainer wants the narrow-viewport fix mentioned in release notes, append one clause to the existing `.changeset/recent-projects-workspace-tab.md`. Never hand-edit `CHANGELOG.md`.

**`task-brief` Global Constraints gap (deferred, outside this repository).** `scripts/task-brief` in the installed subagent-driven-development skill extracts only the `## Task N` block, so `## Global Constraints` never reaches a child brief even though the rendered implementer prompt states that it does. The workaround is to prepend the parsed constraints to the run-local brief before dispatch. Fixing the script affects every future run in every repository and needs separate maintainer approval; it is not in scope here.

## Global Constraints

- Change only the work-target contract; do not alter which boundaries record meaningful work, or when they record it.
- Preserve every verified recent-project behavior: accepted-only recording, captured machine/project targets, per-machine queue ordering, strict parsing, dialog ownership, and exact reopen paths.
- `recordProjectWork` must keep returning without recording when its target is `undefined`.
- Do not change `CHANGELOG.md`, `README.md`, the existing Changeset, public plugin types in `src/client/src/plugins/types.ts`, dependencies, or session-daemon protocol and lifecycle code.
- Add no runtime dependency and no new exported symbol.
- Use strict red-green TDD: prove the new test fails through a production boundary for the fallback reason before changing production code.
- This change is internal tightening with no user-visible behavior change, so it needs no Changeset of its own.

## Task 1: Require an explicit work target when recording project work

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:2859-2869`
- Test: `src/client/src/components/PiWebUiApp.recordProjectWork.test.ts:95-99`
- Test: `src/client/src/components/PiWebUiApp.recordProjectWork.test.ts:316-336`

**Interfaces:**

- Consumes: `interface ProjectWorkTarget { machineId: string; projectId: string }` declared at `src/client/src/components/PiWebUiApp.ts:182`.
- Consumes: `private selectedProjectWorkTarget(machineId = selectedMachineId(this.state)): ProjectWorkTarget | undefined` at `src/client/src/components/PiWebUiApp.ts:2859`, unchanged by this task.
- Consumes existing test helpers in `PiWebUiApp.recordProjectWork.test.ts`: `createApp()`, `installRecorder(app)`, `setState(app, patch)`, `invokePrivate(app, name, ...args)`, `terminalModalCallbacks(app)`, and `sendTerminalInput(onInput, socket)`.
- Produces: `private recordProjectWork(target: ProjectWorkTarget | undefined): void` with no default argument. The public component API and all plugin contracts stay identical.

- [ ] **Step 1: Survey every call site before editing**

Run:

```bash
grep -n 'recordProjectWork\|selectedProjectWorkTarget' src/client/src/components/PiWebUiApp.ts
```

Expected: five call sites at lines 1145, 1542, 3855, 3905, and 4390, plus the definitions near 2859 and 2865. Confirm that 1145 and 1542 build a defined `ProjectWorkTarget`, and that 3855, 3905, and 4390 pass a variable typed `ProjectWorkTarget | undefined`. Record what you observed; if the survey disagrees with this list, stop and report rather than editing.

- [ ] **Step 2: Write the failing production-boundary test**

Add this test to the existing `describe("PiWebUiApp.recordProjectWork")` block in `src/client/src/components/PiWebUiApp.recordProjectWork.test.ts`, next to the other terminal-origin tests. It captures the modal callbacks while no workspace is selected, then selects a project before firing them.

```ts
it("records nothing when the modal captured no work target", () => {
  const app = createApp();
  const recorded = installRecorder(app);
  const callbacks = terminalModalCallbacks(app);
  setState(app, { selectedProject: project, selectedWorkspace: workspace });

  callbacks.onStarted();
  sendTerminalInput(callbacks.onInput, { readyState: WebSocket.OPEN, send: vi.fn() });

  expect(recorded).toEqual([]);
});
```

Do not add a test that calls the private helper with no arguments; that shape pins no production behavior and is the exact gap a previous review rejected.

- [ ] **Step 3: Run the test and confirm it fails for the fallback reason**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.recordProjectWork.test.ts`

Expected: the new test fails because `recorded` contains `[{ projectId: "p1", machineId: "local" }]` instead of `[]`. That is the default parameter re-resolving the target from live state. A harness error, a render throw, or an empty-vs-empty pass is not an acceptable red phase; fix the test until it fails for this reason.

- [ ] **Step 4: Retarget the private-helper test bridge**

`recordProjectWork(app)` at `src/client/src/components/PiWebUiApp.recordProjectWork.test.ts:95` calls the method with no arguments and therefore depends on the default being present. Two tests use it, at lines 205 and 214. Keep both tests and their assertions; make the helper resolve the target explicitly so it exercises the same composition the production callers use:

```ts
function recordProjectWork(app: PiWebUiApp): void {
  const record: unknown = Reflect.get(app, "recordProjectWork");
  if (typeof record !== "function") throw new Error("Expected recordProjectWork");
  record.call(app, invokePrivate(app, "selectedProjectWorkTarget"));
}
```

Do not delete those two tests: they are the only coverage of the `selectedProjectWorkTarget` selected-versus-unselected branches.

- [ ] **Step 5: Make the target parameter required**

Replace the definition at `src/client/src/components/PiWebUiApp.ts:2865` so the parameter is explicit and typed, keeping the guard and the existing doc comment above `selectedProjectWorkTarget` intact:

```ts
  private recordProjectWork(target: ProjectWorkTarget | undefined): void {
    if (target === undefined) return;
    this.recentProjects.recordWork(target.projectId, target.machineId);
  }
```

Change no call site. All five already pass an argument, so they compile unchanged, and the three that pass a possibly-`undefined` variable now correctly no-op instead of falling back.

- [ ] **Step 6: Confirm the focused suites pass**

Run:

```bash
npm test -- --run src/client/src/components/PiWebUiApp.recordProjectWork.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.terminalModal.test.ts src/client/src/components/TerminalPanel.start.test.ts src/client/src/components/TerminalPanel.onInput.test.ts
```

Expected: all pass, including the new test, the two retargeted helper tests, and the existing accepted-start, socket-input, prompt-acceptance, and terminal-command boundary tests.

- [ ] **Step 7: Mutation-check the new test**

Temporarily restore the default parameter (`private recordProjectWork(target = this.selectedProjectWorkTarget()): void`), rerun `npm test -- --run src/client/src/components/PiWebUiApp.recordProjectWork.test.ts`, and confirm the new test fails again. Then restore the required-parameter version with `git checkout -- src/client/src/components/PiWebUiApp.ts` or by reapplying Step 5, and rerun to green. Report both observations; a regression test that has never failed on the repaired tree proves nothing.

- [ ] **Step 8: Run branch verification**

Run, with no other heavy suite in parallel:

```bash
npm run typecheck
npm run lint
npm run verify
```

Expected: every command exits 0. `npm run verify` must report at least the current baseline of 411 test files and 4,340 passing tests plus the one new test, with 2 skipped and only the repository's existing 8 Knip configuration hints.

- [ ] **Step 9: Commit the change**

Run `git status --short`, `git diff --check`, and `git diff` and confirm only the two planned files changed. Then commit:

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.recordProjectWork.test.ts
git commit -m "fix(client): require an explicit recent-project work target"
```

Write the implementer report with the Step 1 survey, the observed red failure and its reason, the Step 7 mutation result, exact verification counts, the final commit SHA, and a clean `git status`.
