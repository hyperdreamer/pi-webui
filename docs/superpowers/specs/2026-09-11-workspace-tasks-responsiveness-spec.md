# Technical Specification: Workspace Tasks Panel Responsiveness While Sessions Run

**Date:** 2026-09-11
**Status:** Approved for implementation
**Related Design Document:** `docs/superpowers/specs/2026-09-11-workspace-tasks-responsiveness-design.md`
**Target Package:** `@hyperdreamer/pi-webui` (patch)
**Change Class:** bug fix / responsiveness regression
**Production File (only one):** `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`

---

## 1. Scope and Non-Goals

### 1.1 Scope

While a project session streams, the host (`PiWebUiApp`) re-renders up to once per
animation frame, and each host render re-commits the three non-primitive properties of
`pi-webui-workspace-tasks-panel`. Today every assignment makes the panel rewrite its
entire shadow DOM (`render()` replaces `root.innerHTML` and re-binds every listener), even
when nothing the panel displays changed. Instrumentation on the live app measured
`contextSets: 51, stateSets: 51 (1 distinct object), actionSets: 51 (1 distinct object),
renderCalls: 153` over 51 host renders.

This specification defines the exact, minimal change:

1. Add an identity guard to `set workspaceTasksState(value)` that returns immediately when
   `value === this.stateValue`, before any observation, move-recovery, reconciliation, or
   render work.
2. Add an identity guard to `set workspaceTasksActions(value)` that returns immediately when
   `value === this.actionsValue`, before assignment and render.
3. Change `set context(value)` so a defined, unchanged context key stores the newest
   context value but skips the render and the reset path. The `undefined -> undefined` case
   must keep rendering the "Select a workspace." placeholder exactly as today.

Everything the panel renders today must keep rendering: first mount, controller state
publishes, context-key changes, and every direct `render()` call from panel interactions
(filters, editor, delete/move confirmations, refresh, status changes).

### 1.2 Non-Goals

- Reducing app-wide render amplification while sessions stream (non-selected session
  status/activity updates still trigger full-app renders). Explicitly deferred in the
  design.
- Preserving panel scroll position across legitimate (state-driven) re-renders.
- Changing the other bundled panels, `WorkspacePanel`, `PiWebUiApp`, the plugin render
  template, `resolvedWorkspacePanelTabs()`, or any host/app-wide render path.
- Any session-daemon (`src/server/sessiond.ts`), server, API, or protocol change.
- Any new feature, configuration key, or UI behavior.

---

## 2. Exact Setter Contracts

All edits are inside `PiWebUiTasksPanel` in
`pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`. Field declarations, the
`contextKey()` helper, `get` accessors, and every other method stay unchanged.

### 2.1 `set context(value: WorkspacePanelContext | undefined)`

**Before (current code):**

```ts
set context(value: WorkspacePanelContext | undefined) {
  const previousKey = contextKey(this.contextValue);
  const nextKey = contextKey(value);
  this.contextValue = value;
  if (previousKey === nextKey) {
    this.render();
    return;
  }
  this.selectionGeneration += 1;
  this.terminalGeneration += 1;
  this.operation = undefined;
  this.pendingAction = undefined;
  this.editor = undefined;
  this.deleteState = undefined;
  this.pendingRefreshFocus = undefined;
  this.validationErrors = undefined;
  this.status = undefined;
  this.runningTaskKey = undefined;
  this.mode = "view";
  this.filter = "all";
  this.idManuallyEdited = false;
  this.moveRecoveryObserved = false;
  this.render();
}
```

**After (target code):**

```ts
set context(value: WorkspacePanelContext | undefined) {
  const previousKey = contextKey(this.contextValue);
  const nextKey = contextKey(value);
  this.contextValue = value;
  if (previousKey === nextKey && nextKey !== undefined) return;
  this.selectionGeneration += 1;
  this.terminalGeneration += 1;
  this.operation = undefined;
  this.pendingAction = undefined;
  this.editor = undefined;
  this.deleteState = undefined;
  this.pendingRefreshFocus = undefined;
  this.validationErrors = undefined;
  this.status = undefined;
  this.runningTaskKey = undefined;
  this.mode = "view";
  this.filter = "all";
  this.idManuallyEdited = false;
  this.moveRecoveryObserved = false;
  this.render();
}
```

Required ordering and conditions:

1. `previousKey` and `nextKey` **must be computed from the old stored value before
   `this.contextValue = value`**. Computing `previousKey` after the assignment would make
   it always equal `nextKey` and would permanently stop the reset path from running.
2. `this.contextValue = value` **must remain unconditional**, before the early return, so
   the newest terminal facade is stored even when the render is skipped.
3. The skip condition is exactly `previousKey === nextKey && nextKey !== undefined`. The
   `nextKey !== undefined` clause is load-bearing: `undefined -> undefined` must fall
   through to the reset block and `this.render()` so a context-less panel still renders the
   "Select a workspace." placeholder as it does today. A defined, unchanged key skips.
4. The reset block is copied verbatim; no line inside it changes.

`contextKey()` is unchanged and already covers `context.machine.id`,
`context.workspace.projectId`, `context.workspace.id`, and `context.workspace.path`. No new
context fields are added.

### 2.2 `set workspaceTasksState(value: WorkspaceTasksPanelState)`

**Before (current code):**

```ts
set workspaceTasksState(value: WorkspaceTasksPanelState) {
  const previous = this.stateValue;
  this.stateValue = value;
  this.recordPendingSourceObservations(value);
  if (value.move !== undefined) this.moveRecoveryObserved = true;
  this.rememberOpenGroups();
  this.pruneExpandedGroups();
  if (this.reconcilePendingAction()) return;
  if (previous.move !== undefined && value.move === undefined && this.moveRecoveryObserved && this.editor !== undefined) {
    if (this.isMoveComplete(this.editor, value)) {
      const target = this.editor.focusReturn;
      this.editor = undefined;
      this.mode = "view";
      this.validationErrors = undefined;
      this.moveRecoveryObserved = false;
      this.status = { kind: "success", message: "Task move completed." };
      this.render();
      this.focusTarget(target);
      return;
    }
    this.status = { kind: "info", message: "Move was not completed. Confirm the move again after reviewing the catalogs." };
  }
  this.render();
}
```

**After (target code):**

```ts
set workspaceTasksState(value: WorkspaceTasksPanelState) {
  if (value === this.stateValue) return;
  const previous = this.stateValue;
  this.stateValue = value;
  this.recordPendingSourceObservations(value);
  if (value.move !== undefined) this.moveRecoveryObserved = true;
  this.rememberOpenGroups();
  this.pruneExpandedGroups();
  if (this.reconcilePendingAction()) return;
  if (previous.move !== undefined && value.move === undefined && this.moveRecoveryObserved && this.editor !== undefined) {
    if (this.isMoveComplete(this.editor, value)) {
      const target = this.editor.focusReturn;
      this.editor = undefined;
      this.mode = "view";
      this.validationErrors = undefined;
      this.moveRecoveryObserved = false;
      this.status = { kind: "success", message: "Task move completed." };
      this.render();
      this.focusTarget(target);
      return;
    }
    this.status = { kind: "info", message: "Move was not completed. Confirm the move again after reviewing the catalogs." };
  }
  this.render();
}
```

Required conditions:

1. The guard `if (value === this.stateValue) return;` **must be the first statement** of the
   setter, before `const previous = this.stateValue;`, before the assignment, and before
   `recordPendingSourceObservations(value)`. It is an early return, not a condition wrapped
   around the body.
2. The stored state getter `get workspaceTasksState()` stays exactly as it is:
   `return this.stateValue;`.
3. No observation, move-recovery, reconciliation, focus, or render logic changes.

### 2.3 `set workspaceTasksActions(value: WorkspaceTasksPanelActions)`

**Before (current code):**

```ts
set workspaceTasksActions(value: WorkspaceTasksPanelActions) {
  this.actionsValue = value;
  this.render();
}
```

**After (target code):**

```ts
set workspaceTasksActions(value: WorkspaceTasksPanelActions) {
  if (value === this.actionsValue) return;
  this.actionsValue = value;
  this.render();
}
```

Required conditions:

1. The guard `if (value === this.actionsValue) return;` **must be the first statement**,
   before both the assignment and `this.render()`.
2. The stored actions getter `get workspaceTasksActions()` stays exactly as it is:
   `return this.actionsValue;`.
3. No other behavior changes; a genuinely new actions object still renders.

---

## 3. Observable Behavior Matrix

`render` below means `this.render()` was invoked and the shadow DOM was rewritten.
"Reset" means the context reset block (generations incremented; `operation`,
`pendingAction`, `editor`, `deleteState`, `pendingRefreshFocus`, `validationErrors`,
`status`, `runningTaskKey` cleared; `mode = "view"`; `filter = "all"`;
`idManuallyEdited = false`; `moveRecoveryObserved = false`).

| # | Assignment case | Expected render | Expected panel state reset |
| --- | --- | --- | --- |
| 1 | **First mount.** `context` undefined -> defined (new key); `workspaceTasksState` `emptyPanelState()` -> delivered state; `workspaceTasksActions` `noOpActions()` -> delivered actions | Yes. Each setter whose value differs renders; `connectedCallback()` may render the placeholder first. Observable result is the unchanged first render. | Context reset block runs on the first defined context (generations increment, fields were already at defaults). No observable loss. |
| 2 | **Same key + same identity state/actions** (host re-render): new context object with the same `contextKey`; the *same* state object; the *same* actions object | **No render** from any setter. The new context object is still stored. | No reset, no reconciliation, no observation, no `rememberOpenGroups`/`pruneExpandedGroups` re-run. |
| 3 | **Same key + new identity state:** new context object with the same key; a *new* state object; same actions object | Yes: exactly one render, from the state setter. Context setter stores and skips. | No reset. Panel mode/editor/filter/expansion are preserved. `recordPendingSourceObservations(value)` runs before the render, exactly as today. |
| 4 | **Same key + new identity actions:** new context object with the same key; same state object; a *new* actions object | Yes: exactly one render, from the actions setter. | No reset. |
| 5 | **Changed key:** `machine.id`, `workspace.projectId`, `workspace.id`, or `workspace.path` differs (context setter); state/actions may also be re-assigned | Yes. Context setter renders; a new state object, if delivered, renders after it. | **Yes: full reset.** Editor, delete/move confirmation, filter, status, operation, pending action, and expansion-relevant flags are discarded, matching today's behavior. |
| 6 | **Undefined context:** `undefined -> undefined` (detached/empty panel); re-assigning the same state/actions object, or assigning a *new* state or actions object | Yes for the context setter and for any *new* state/actions object: placeholder render (`Select a workspace.`). Re-assigning the same state or actions identity is a no-op under the guards. | The reset block executes, but no editor, operation, pending action, or running task can exist while `contextValue` is undefined, so the only observable outcome is the placeholder render. |

Additional invariant for case 2: because the context value is stored before the early
return, `Run` and `Open Terminal` use the newest `contextValue.terminal` facade even though
no render happened.

---

## 4. Invariant Rationale

### 4.1 The controller publishes a fresh frozen state object on every publish

`WorkspaceTasksController.publishCurrent()` (`src/client/src/controllers/workspaceTasksController.ts`)
constructs `this.currentState = immutableState({...})` and then calls
`this.onChange(this.currentState)`. `immutableState()` returns `Object.freeze({...})` and
freezes the nested catalogs, `sourceGenerations`, and optional `move` / `moveError` /
`mutationGate` values. Every call therefore produces a new object reference, whether or not
the content changed. `PiWebUiApp` subscribes with `onChange: () => { this.requestUpdate(); }`.

Consequences:

- A newly delivered state object is the controller's own "something may have changed"
  signal, and the panel must process every new object.
- A repeated delivery of the *same* object carries no new information: that exact object was
  already processed by `recordPendingSourceObservations` and the rest of the setter the
  first time it was assigned.
- Reference equality (`===`), not deep equality, is the correct change signal. A
  deep-equality or rendered-content comparison would be wrong because
  `sourceGenerations` (and gate bookkeeping) can change without changing rendered output;

  `reconcilePendingAction()` depends on `recordPendingSourceObservations()` observing each
  *delivered* object's generations and catalog keys. A guard that swallowed a fresh object
  whose only difference was `sourceGenerations` would stall pending refresh/save/delete/move
  reconciliation.

### 4.2 Actions are frozen once

The `WorkspaceTasksController` constructor builds one `actions` object and stores it with
`this.actions = Object.freeze(actions);`. No code path replaces it afterward, and
`PiWebUiApp.createWorkspacePanelContext()` embeds `this.workspaceTasks.actions` in the
bridge on every host render. The same actions reference is therefore re-assigned only by
host re-renders; a same-reference guard fires only if the controller instance is genuinely
replaced.

### 4.3 lit-html re-commits non-primitive property bindings on every host render

The plugin contribution renders:

```ts
html`<pi-webui-workspace-tasks-panel
  .context=${context}
  .workspaceTasksState=${tasks.state}
  .workspaceTasksActions=${tasks.actions}
></pi-webui-workspace-tasks-panel>`
```

lit-html's property commit logic (`AttributePart._$setValue`) computes
`change = !isPrimitive(value) || ...`, so all three object bindings are re-assigned on every
host render regardless of reference identity. `resolvedWorkspacePanelTabs()` also builds a
new context object (with a new `terminal` facade) on every host render via
`createWorkspacePanelContext(workspace)`.

Therefore identity guards cannot live in the host template or in the app render path; they
must live in the receiving custom element's setters. The panel's rendered output depends
only on `stateValue` and internal panel fields, and the only context member read after mount
is `contextValue.terminal` (in `dispatchTask` and `openWorkspaceTerminal`), so storing the
newest context while skipping the render is behavior-preserving.

### 4.4 What the guard eliminates

`render()` assigns `this.root.innerHTML` (styles plus the full panel template) and re-binds
every listener. Before the fix, each host render produced three full shadow-DOM rewrites;
measured cost was ~7.3 ms per rewrite under 4x CPU throttle, and the rewrite replaced
`<details>`/button nodes mid-gesture. After the fix, host re-renders that deliver unchanged
inputs produce zero panel renders and zero node replacement, while every genuine state
publish still renders exactly once.

---

## 5. Test Plan

### 5.1 Harness and fixtures

File: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` (existing jsdom harness,
direct element property assignment). Reuse `mount()`, `state()`, `workspaceTask()`,
`button()`, `createContext()`, and `terminalHandle()` as they exist today.

Add one file-local helper, `clonePanelState`, which deep-copies a state object (top level,
both catalogs, each catalog's `config.tasks` and each task, and the optional
`sourceGenerations`, `move`, `moveError`, and `mutationGate` members) so a structurally
identical clone has a new reference:

```ts
function clonePanelState(source: TasksPanelElement["workspaceTasksState"]): TasksPanelElement["workspaceTasksState"] {
  const cloneCatalog = (catalog: CatalogState): CatalogState => ({
    ...catalog,
    ...(catalog.config === undefined ? {} : {
      config: { version: 1 as const, tasks: catalog.config.tasks.map((task) => ({ ...task })) },
    }),
  });
  return {
    workspace: cloneCatalog(source.workspace),
    global: cloneCatalog(source.global),
    ...(source.sourceGenerations === undefined ? {} : { sourceGenerations: { ...source.sourceGenerations } }),
    ...(source.move === undefined ? {} : { move: { ...source.move } }),
    ...(source.moveError === undefined ? {} : { moveError: { ...source.moveError } }),
    ...(source.mutationGate === undefined ? {} : { mutationGate: { ...source.mutationGate, scopes: [...source.mutationGate.scopes] } }),
  };
}
```

If the test-file `WorkspaceTasksWorkspaceState` interface — the local interface that
`TasksPanelElement.workspaceTasksState` references — does not yet declare
`sourceGenerations` and `moveError`, add those two optional members there so the helper
type-checks:

```ts
sourceGenerations?: Readonly<Record<WorkspaceTaskScope, number>>;
moveError?: { readonly kind: "validation" | "unavailable"; readonly message: string };
```

Node identity is the render signal: `render()` replaces `root.innerHTML`, so any render
replaces the previously captured DOM node. No instrumentation or private-member access is
needed.

### 5.2 New tests (all added to `tasksPanelElement.test.ts`)

1. **`"does not rewrite the shadow DOM when context, state, and actions are re-assigned unchanged"`**
   - Fixture: `mount(state([workspaceTask({ group: "Checks" })], []))`; click
     `[data-add-task]` so the editor is open; capture
     `const inputBefore = panel.shadowRoot?.querySelector("[data-editor-title]")` and
     `const refreshBefore = button(panel, "[data-refresh]")`; capture
     `const stateBefore = panel.workspaceTasksState` and
     `const actionsBefore = panel.workspaceTasksActions`.
   - Act: assign a brand-new context with the same key, then reassign the captured state and
     actions identities:
     `panel.context = createContext(); panel.workspaceTasksState = stateBefore; panel.workspaceTasksActions = actionsBefore;`.
   - Assert: `expect(inputBefore).not.toBeNull()`; then
     `panel.shadowRoot?.querySelector("[data-editor-title]")` **is** `inputBefore`
     (`toBe`); `button(panel, "[data-refresh]")` **is** `refreshBefore`; the editor is still
     open (`[data-task-editor]` is non-null). This pins "no innerHTML rewrite" for the
     exact host re-render payload.

2. **`"treats a structurally identical state clone as a change and rewrites the shadow DOM"`**
   - Fixture: `mount(state([workspaceTask({ group: "Checks" })], []))`; capture the refresh
     button node.
   - Act: `panel.workspaceTasksState = clonePanelState(panel.workspaceTasksState);`
   - Assert: the re-queried refresh button **is not** the captured node (`not.toBe`), and
     the rendered task title is still present. This pins reference equality as the change
     contract: a future deep-equality implementation would make the node identity unchanged
     and fail this test. It also protects pending-action reconciliation, which must observe
     every newly delivered object even when only `sourceGenerations` differ.

3. **`"renders updated task content for a state object with different tasks"`**
   - Fixture: `mount(state([workspaceTask({ id: "alpha", title: "Alpha" })], []))`.
   - Act: `panel.workspaceTasksState = state([workspaceTask({ id: "beta", title: "Beta" })], []);`
   - Assert: shadow text contains `"Beta"` and does not contain `"Alpha"`.

4. **`"resets panel state when the context key changes"`**
   - Fixture: `mount(state([workspaceTask()], []))`; click `[data-add-task]`; assert
     `[data-task-editor]` is present.
   - Act: build a same-shaped context with a different key:
     `const base = createContext(); panel.context = { ...base, workspace: { ...base.workspace, id: "ws-2", path: "/tmp/ws-2" } };`
   - Assert: `[data-task-editor]` is null; `[data-panel-mode="view"]` is non-null; the
     `[data-filter="all"]` button has `aria-pressed="true"` (editor and filter were reset).

5. **`"uses the newest context terminal facade after a skipped re-render"`**
   - Fixture: `const firstRun = vi.fn(() => Promise.resolve(terminalHandle())); const panel = mount(state([workspaceTask()], []), { runCommand: firstRun });`
     then create `const secondRun = vi.fn(() => Promise.resolve(terminalHandle()));`
     `const secondContext = createContext(secondRun); const secondOpen = vi.fn();` and
     assign `panel.context = { ...secondContext, terminal: { ...secondContext.terminal, open: secondOpen } };`
     (same key by construction, so the assignment skips the render).
   - Act/assert: click `[data-run-task='workspace:build']`; assert `secondRun` was called
     once and `firstRun` was not called. Then re-query `[data-open-terminal]` (the Run click
     re-renders the panel) and click it; assert `secondOpen` was called once. This proves
     the newest facade survived the skipped render and that the context value assignment is
     unconditional. `runWorkspaceTaskInTerminal()` calls `terminal.runCommand` synchronously,
     so no waiting is required for the Run assertion.

6. **`"leaves the DOM untouched for identical actions and rewrites it for a new actions object"`**
   - Fixture: `mount(state([workspaceTask()], []))`; capture the refresh button node and
     `const actionsBefore = panel.workspaceTasksActions`.
   - Act/assert: `panel.workspaceTasksActions = actionsBefore;` -> re-queried refresh button
     **is** the captured node. Then `panel.workspaceTasksActions = { ...actionsBefore };`
     (new object, same function references) -> re-queried refresh button **is not** the
     captured node.

### 5.3 Existing test that must change

In `tasksPanelElement.test.ts`, test
**`"renders native collapsed details groups with counts and preserves expansion by scoped group key"`**,
the statement

```ts
panel.workspaceTasksState = initial;
```

must become

```ts
panel.workspaceTasksState = clonePanelState(initial);
```

Rationale: under the new guard, assigning the *same* object is a full no-op. The following
`open` assertions would then pass only because the DOM was never rewritten, so they would no
longer prove that expansion state survives a real state-driven re-render. Assigning a
structurally identical clone restores the original intent and is the realization of design
test-strategy item 6 ("Expansion persists across a state-driven render with new identity").
Do **not** add a separate duplicate expansion test for the same scenario.

### 5.4 Test file that must remain unchanged

`pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts` must stay green without
modification. Its `createControllableBridge().publish()` already delivers a fresh deep clone
via `cloneBridgeState()`, mirroring `WorkspaceTasksController.publishCurrent()`, so every
published state crosses the identity guard. No test in that file re-assigns the same state
object to force a render.

---

## 6. Verification Commands and Expected Outcomes

### 6.1 Focused component tests

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts
```

Expected: all tests pass — 5 existing tests plus the 6 new tests = 11 passing tests, 0
failures (the existing expansion test is updated, not added).

Red/green guidance while implementing: only test 1 and the first assertion of test 6 are
expected to be RED before the guards are added; both assert node identity is preserved
across an unchanged-input re-assignment, which the current unconditional renders break.
Tests 2, 3, 4, and 5, plus the second assertion of test 6, already pass before the fix and
are post-fix regression guards, not red-before-fix evidence. Test 2 (a structurally
identical state clone must still render) specifically guards against a future deep-equality
implementation; test 5 passes pre-fix because the current `set context` already assigns
`this.contextValue = value` before rendering, so the newest facade was already used.

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
```

Expected: unchanged pass, proving the guard did not break the controller-like publish flow.

### 6.2 Repository verification

```bash
npm run verify
```

Expected: typecheck, lint, knip, and the serial test suite all pass with no new
suppressions, unused exports, or warnings introduced by the change.

### 6.3 CDP responsiveness probe

Serve a production build containing the fix on the same app and port used for the
diagnosis, launch headless Chromium with CDP on port `9333`, and re-run the archived probe
from `/data/home/guest/Development/pi-webui`:

```bash
node /home/henry/.local/state/pi/project-manager/runs/4074842dc9aaf003446194e3e1d1201d34aca2f4bd236012ec3be919dd6e7164/pm-run-20260911-114113-f9cf2acd/reports/probe/tasks-responsiveness-probe.mjs \
  --port 9333 \
  --url "http://127.0.0.1:8808/?machine=local&project=<id>&workspace=<id>&tool=workspace-tasks%3Aworkspace.tasks" \
  --out <result.json>
```

The probe counts `PiWebUiTasksPanel.render` calls and app renders after its counters are
reset, while its synthetic load drives host re-renders (the `render-load-60hz` phase) and
its group toggles do not re-render the panel (the `toggle` listener only mutates
`expandedGroupKeys`; see `tasksPanelElement.ts:509-514`). The counter window also includes
each phase's no-op group toggles, and its counters are read before the phase-ending Add Task
click. It therefore contains only unchanged-input host re-renders as long as no genuine new
state object is published inside the window (a background refresh or other
`publishCurrent()` would legitimately render).

Expected after the fix:

- Every phase (`idle`, `render-load-60hz`, `idle-after`) reports `panelRenders: 0` and
  `panelMsTotal: 0`, provided no genuine new state object is published inside that phase's
  counter window; the archived workload satisfies this, so it observes `panelRenders: 0` in
  all three phases.
- `render-load-60hz.appRenders` is greater than 0, proving the load actually drove host
  re-renders.
- The pre-fix archived baseline (`before-fix.json`) reported `panelRenders` 72, 99, and 18
  (3 per app render), so the change removes 3 shadow-DOM rewrites per unchanged host
  re-render.
- Toggle/Add Task `latencyMs` values are recorded as a before/after measurement only; no
  equality threshold is asserted, because the app-wide host render path is unchanged and
  out of scope.
- `scrollProbe` is informational; the before-fix run had no scrollable viewer, so it is not
  a gate.

The repository intentionally keeps no one-off probe script. The probe script, its
`before-fix.json` baseline, and the post-fix result live under the PM run's `reports/probe/`
directory; the instrumentation numbers quoted in Section 1 come from
`reports/diagnosis-workspace-tasks-responsiveness.md`.

---

## 7. Changeset

Create `.changeset/workspace-tasks-panel-responsiveness.md` with exactly:

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Keep the Workspace Tasks panel responsive while sessions stream.
```

Patch is the correct bump: this is a backward-compatible bug fix with no new public
capability. The bundled plugin ships through `dist/pi-webui-plugins` (built by
`npm run build:plugins`), so the user-visible fix belongs in the release notes.

---

## 8. Implementation Checklist

Single production file: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`.

1. Add `if (value === this.stateValue) return;` as the first statement of
   `set workspaceTasksState`.
2. Add `if (value === this.actionsValue) return;` as the first statement of
   `set workspaceTasksActions`.
3. Change the context skip branch to `if (previousKey === nextKey && nextKey !== undefined) return;`
   without moving or reordering the `previousKey` / `nextKey` / assignment statements.
4. Leave every other line of the three setters, every other method, and both getters
   unchanged.
5. Update `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`: add `clonePanelState`
   plus any missing optional members on the local state interface, add the 6 tests from
   Section 5.2, and update the existing expansion test per Section 5.3.
6. Add the `.changeset/workspace-tasks-panel-responsiveness.md` file from Section 7.
7. Run the focused tests, then `npm run verify`, then the CDP probe per Section 6.

---

## 9. Operational and Deployment Note

The change lives entirely in a bundled plugin asset
(`pi-webui-plugins/workspace-tasks/tasksPanelElement.ts` -> `dist/pi-webui-plugins`), not in
`src/server/sessiond.ts`, the session-daemon protocol, or any server-owned runtime code.

- **No session-daemon restart is required.** Do not restart
  `pi-webui-sessiond.service`; long-lived Pi sessions are unaffected.
- Only the web/UI side needs to pick up the change: rebuild the plugin bundle (or let
  `pi-webui-ui-dev.service` / `npm run dev:web` rebuild it) and reload the browser tab.
- Delivery target is `main`; the integration branch stays under PM control until the
  delivery decision.
